/**
 * sessionLogPrune — moves settled lines out of the session log into `<session-id>.archive.md`
 * beside it. Nothing is ever deleted: a moved line sits under the same heading in the archive.
 *
 *   node ~/.agent-build/runtime/sessionLogPrune.ts [<log>] --branch <b> --pr <n> --sha <merge sha>
 *   node ~/.agent-build/runtime/sessionLogPrune.ts <log> --compact
 *
 * At a merge (`--branch`): moves a Work-log line tagged `[<b>]`; a `[x]` Todo line tagged `[<b>]`;
 * a Decisions line that a LATER Decisions line names with `replaces: "<quote>"`; then appends that
 * build's one merged line to the Work log. Without `<log>`, every log under `$SESSION_LOGS_DIR`
 * (no default: unset, the run exits 2) that carries a `[<b>]` line is pruned — usually one, two
 * after a handoff — so a merge watcher needs no session id.
 * The batch branch's open Todo line (`- [ ] [<batch branch>] batch: …`) follows the same rules: it
 * moves once flipped `[x]` and its own branch merges.
 *
 * At a compaction (`--compact`, run by the SessionStart hook): appends the marker
 * `- HH:MMZ [session] compacted` to the Work log, then moves every `[session]` Work-log line above
 * the PREVIOUS marker (so a line lives in the log across exactly one compaction, the one whose
 * summary might drop it) and every `[x] [session]` Todo line. Work outside any branch has no merge
 * to settle it; this is its settle event.
 *
 * Never moves: a `[ ]` line (so an open banked question stays; a `[x]` one is answered and moves
 * with its branch or compaction); a Work-log or Decisions line holding `question:`; the last
 * `tunable:` line per key; a merged line; a Decisions line nothing replaces (`[user]` and `[agent]`
 * alike).
 * A `replaces:` quote that matches more than one earlier Decisions line, or none (and no archived
 * one), moves nothing and prints a warning: a decision still in force is never pruned on a guess.
 *
 * The archive is written before the log, so a crash between the two leaves a line in both places,
 * never in neither. Prints `pruned <k> lines → <archive>` per pruned log, then any `warning:` lines,
 * all on stdout.
 * Exit 0 · 1 the log lacks one of the three sections · 2 usage, or no log carries the branch.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { isMain } from "./lib/isMain.ts";

export const SECTIONS = ["Work log", "Todo", "Decisions"] as const;
export type Section = (typeof SECTIONS)[number];

export interface PruneOptions {
  branch: string;
  pr: number;
  sha: string;
  sessionId: string;
  now: Date;
}

export type PruneResult =
  | { ok: true; log: string; archive: string | null; moved: number; warnings: string[] }
  | { ok: false; missing: Section[] };

const HEADING_RE = /^#{1,2} /;
const SECTION_HEADING_RE = /^## (Work log|Todo|Decisions)\s*$/;
// `- 14:02Z [fix/x] fact` — the time is optional so a hand-kept line without one still prunes.
const WORK_RE = /^- (?:\d{2}:\d{2}Z )?\[([^\]\s]+)\](?: (.*))?$/;
// `- [x] [fix/x] task` — the checkbox, then the branch tag.
const TODO_RE = /^- \[([ xX])\](?: \[([^\]\s]+)\])?(?: (.*))?$/;
const MERGED_RE = /^merged #\d+ \([0-9a-f]+\)$/i;
const TUNABLE_RE = /\btunable:\s*([A-Za-z_][\w-]*)\s*=/;
const QUOTED_REPLACES_RE = /replaces:\s*(?:"([^"]+)"|“([^”]+)”)/g;

interface Line {
  text: string;
  section: Section | null;
}

function sectionLines(log: string): Line[] {
  let section: Section | null = null;
  return log.split("\n").map((text) => {
    const heading = SECTION_HEADING_RE.exec(text);
    if (heading) {
      section = heading[1] as Section;
      return { text, section: null };
    }
    if (HEADING_RE.test(text)) section = null;
    return { text, section };
  });
}

function missingSections(lines: Line[]): Section[] {
  const seen = new Set(lines.map((l) => SECTION_HEADING_RE.exec(l.text)?.[1]).filter(Boolean));
  return SECTIONS.filter((s) => !seen.has(s));
}

/** The entry's own words: past the time, checkbox, and tag. `null` when the line is no entry. */
function entryText(line: Line): string | null {
  if (!line.text.startsWith("- ")) return null;
  if (line.section === "Work log") return WORK_RE.exec(line.text)?.[2] ?? line.text.slice(2);
  if (line.section === "Todo") return TODO_RE.exec(line.text)?.[3] ?? line.text.slice(2);
  return line.text.slice(2);
}

function withoutReplacesClause(text: string): string {
  const i = text.indexOf("replaces:");
  return i === -1 ? text : text.slice(0, i);
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The quotes a Decisions line names with `replaces:` — quoted forms, else the rest of the line. */
export function replacesQuotes(text: string): string[] {
  const quoted = [...text.matchAll(QUOTED_REPLACES_RE)].map((m) => (m[1] ?? m[2])!);
  if (quoted.length > 0) return quoted;
  const i = text.indexOf("replaces:");
  const rest = i === -1 ? "" : text.slice(i + "replaces:".length).trim();
  return rest ? [rest] : [];
}

function neverMoves(line: Line, index: number, lastTunable: Map<string, number>): boolean {
  const text = entryText(line);
  if (text === null) return true;
  if (line.section === "Todo" && TODO_RE.exec(line.text)?.[1] === " ") return true;
  // A banked question stays while it is open; once flipped [x] its answer lives in Decisions.
  if (line.section !== "Todo" && line.text.includes("question:")) return true;
  const tunable = TUNABLE_RE.exec(line.text);
  if (tunable && lastTunable.get(tunable[1]!) === index) return true;
  return line.section === "Work log" && MERGED_RE.test(text);
}

function isBranchLine(line: Line, branch: string): boolean {
  if (line.section === "Work log") return WORK_RE.exec(line.text)?.[1] === branch;
  if (line.section === "Todo") return TODO_RE.exec(line.text)?.[2] === branch;
  return false;
}

const quotes = (text: string, want: string): boolean => squash(withoutReplacesClause(text)).includes(want);

/** Indexes of Decisions lines some later Decisions line replaces, plus a warning per unusable quote.
 * A quote whose line an earlier prune already archived is settled, not unusable. */
function replacedDecisions(lines: Line[], archived: Line[]): { replaced: Set<number>; warnings: string[] } {
  const replaced = new Set<number>();
  const warnings: string[] = [];
  const decisions = lines.flatMap((l, i) => (l.section === "Decisions" && l.text.startsWith("- ") ? [i] : []));
  const archivedDecisions = archived.filter((l) => l.section === "Decisions" && l.text.startsWith("- "));
  decisions.forEach((at, k) => {
    for (const quote of replacesQuotes(lines[at]!.text)) {
      const want = squash(quote);
      const hits = decisions.slice(0, k).filter((i) => quotes(lines[i]!.text, want));
      if (hits.length === 1) replaced.add(hits[0]!);
      else if (hits.length === 0 && archivedDecisions.some((l) => quotes(l.text, want))) continue;
      else
        warnings.push(
          `replaces: "${quote}" matches ${hits.length === 0 ? "no earlier Decisions line" : `${hits.length} earlier Decisions lines`} — none moved`
        );
    }
  });
  return { replaced, warnings };
}

/** Drops blank lines that follow another blank line inside the three sections. */
function collapseBlanks(lines: Line[]): Line[] {
  return lines.filter((l, i) => !(l.section !== null && l.text === "" && i > 0 && lines[i - 1]!.text === ""));
}

function lastLineOf(lines: Line[], section: Section): number {
  let last = -1;
  lines.forEach((l, i) => {
    if ((l.section === section && l.text.trim() !== "") || SECTION_HEADING_RE.exec(l.text)?.[1] === section) last = i;
  });
  return last;
}

function emptyArchive(sessionId: string): string {
  return [
    `# Session log archive — ${sessionId}`,
    "",
    `Lines the prune script moved out of ${sessionId}.md at a merge or a compaction, under their section headings.`,
    "",
    ...SECTIONS.flatMap((s) => [`## ${s}`, ""]),
  ].join("\n");
}

/** Appends each section's moved lines at the end of that section of the archive text. */
function appendToArchive(archive: string, moved: Map<Section, string[]>): string {
  let lines = sectionLines(archive);
  for (const section of SECTIONS) {
    const add = moved.get(section) ?? [];
    if (add.length === 0) continue;
    if (lastLineOf(lines, section) === -1) {
      if (lines.length > 0 && lines[lines.length - 1]!.text !== "") lines.push({ text: "", section: null });
      lines.push({ text: `## ${section}`, section: null }, { text: "", section });
    }
    const at = lastLineOf(lines, section);
    const isHeading = SECTION_HEADING_RE.test(lines[at]!.text);
    const block = [...(isHeading ? [""] : []), ...add].map((text) => ({ text, section }));
    lines = [...lines.slice(0, at + 1), ...block, ...lines.slice(at + 1)];
  }
  const text = lines.map((l) => l.text).join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

const hhmm = (d: Date): string =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;

/** Splits the log into the lines that stay and the lines that move, by section. A line the
 *  never-moves rules protect stays whatever `settles` says; everything else moves when `settles`
 *  says so. Both prune modes are this partition with their own `settles`. */
function partition(
  lines: Line[],
  settles: (line: Line, index: number) => boolean
): { kept: Line[]; movedBySection: Map<Section, string[]> } {
  const lastTunable = new Map<string, number>();
  lines.forEach((l, i) => {
    const key = TUNABLE_RE.exec(l.text)?.[1];
    if (key) lastTunable.set(key, i);
  });
  const movedBySection = new Map<Section, string[]>();
  const kept: Line[] = [];
  lines.forEach((line, i) => {
    if (line.section === null || neverMoves(line, i, lastTunable) || !settles(line, i)) {
      kept.push(line);
      return;
    }
    movedBySection.set(line.section, [...(movedBySection.get(line.section) ?? []), line.text]);
  });
  return { kept, movedBySection };
}

export function pruneSessionLog(log: string, archive: string | null, opts: PruneOptions): PruneResult {
  const lines = sectionLines(log);
  const missing = missingSections(lines);
  if (missing.length > 0) return { ok: false, missing };

  const { replaced, warnings } = replacedDecisions(lines, archive === null ? [] : sectionLines(archive));
  const { kept, movedBySection } = partition(
    lines,
    (line, i) => isBranchLine(line, opts.branch) || (line.section === "Decisions" && replaced.has(i))
  );

  const merged = `[${opts.branch}] merged #${opts.pr} (${opts.sha})`;
  const alreadyMerged = kept.some((l) => l.section === "Work log" && l.text.endsWith(` ${merged}`));
  let out = collapseBlanks(kept);
  if (!alreadyMerged) out = appendWorkLine(out, `- ${hhmm(opts.now)} ${merged}`);
  return finish(out, movedBySection, archive, opts.sessionId, warnings);
}

/** The compaction marker's own words; the hook's `--compact` run writes one per compaction. */
const COMPACTED = "compacted";

const isMarker = (line: Line): boolean =>
  line.section === "Work log" && WORK_RE.exec(line.text)?.[1] === "session" && entryText(line) === COMPACTED;

export interface CompactOptions {
  sessionId: string;
  now: Date;
}

export function compactSessionLog(log: string, archive: string | null, opts: CompactOptions): PruneResult {
  const lines = sectionLines(log);
  const missing = missingSections(lines);
  if (missing.length > 0) return { ok: false, missing };

  const previousMarker = lines.reduce((at, l, i) => (isMarker(l) ? i : at), -1);
  // A superseded decision settles here too: a session that never merges must still retire it.
  const { replaced, warnings } = replacedDecisions(lines, archive === null ? [] : sectionLines(archive));
  const { kept, movedBySection } = partition(
    lines,
    (line, i) =>
      (line.section === "Work log" && isBranchLine(line, "session") && i < previousMarker) ||
      (line.section === "Todo" && isBranchLine(line, "session")) ||
      (line.section === "Decisions" && replaced.has(i))
  );

  const out = appendWorkLine(collapseBlanks(kept), `- ${hhmm(opts.now)} [session] ${COMPACTED}`);
  return finish(out, movedBySection, archive, opts.sessionId, [...warnings, ...unprincipledAgentLines(kept)]);
}

const AGENT_LINE_RE = /^- (?:\S+ )?\[agent\] /;
const NAMES_RULE_RE = /\b(principle|rule)s? \d+/i;

/** An `[agent]` Decisions line names the principle or rule that decided it.
 *  One without a number is a pick with no stated reason — flagged, never moved. */
export function unprincipledAgentLines(lines: Line[]): string[] {
  return lines
    .filter((l) => l.section === "Decisions" && AGENT_LINE_RE.test(l.text) && !NAMES_RULE_RE.test(l.text))
    .map((l) => `[agent] line names no principle or rule: ${l.text.slice(0, 80)}`);
}

function appendWorkLine(lines: Line[], text: string): Line[] {
  const at = lastLineOf(lines, "Work log");
  const isHeading = SECTION_HEADING_RE.test(lines[at]!.text);
  const block = [...(isHeading ? [""] : []), text].map((t) => ({ text: t, section: "Work log" as Section }));
  return [...lines.slice(0, at + 1), ...block, ...lines.slice(at + 1)];
}

function finish(
  out: Line[],
  movedBySection: Map<Section, string[]>,
  archive: string | null,
  sessionId: string,
  warnings: string[]
): PruneResult {
  const moved = [...movedBySection.values()].reduce((n, l) => n + l.length, 0);
  return {
    ok: true,
    log: out.map((l) => l.text).join("\n"),
    archive: moved === 0 ? archive : appendToArchive(archive ?? emptyArchive(sessionId), movedBySection),
    moved,
    warnings,
  };
}

/** Every log under `dir` that carries a `[<branch>]` Work-log or Todo line, oldest first. A branch
 *  usually has one, but a handoff splits it across two sessions, so each one prunes. */
export function findLogsByBranch(dir: string, branch: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    // Only `<session-id>.md`: the dir also holds archives and dated snapshots (`<sid>.full.md`,
    // `<sid>.raw-<date>.md`), which must never be pruned or given a merged line.
    .filter((f) => /^[^.]+\.md$/.test(f) && f !== "TEMPLATE.md")
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .filter((path) => sectionLines(readFileSync(path, "utf8")).some((l) => isBranchLine(l, branch)));
}

const USAGE =
  "usage: sessionLogPrune.ts [<log>] --branch <b> --pr <n> --sha <merge sha>\n" +
  "       sessionLogPrune.ts <log> --compact";

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.prune-tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

type Args =
  | { mode: "merge"; log: string | null; branch: string; pr: number; sha: string }
  | { mode: "compact"; log: string };

export function parseArgs(argv: string[]): Args {
  let rest = argv;
  const take = (flag: string): string | undefined => {
    const r = takeValue(rest, flag);
    rest = r.rest;
    return r.value;
  };
  const compact = rest.includes("--compact");
  if (compact) rest = rest.filter((a) => a !== "--compact");
  const branch = take("--branch");
  const pr = take("--pr");
  const sha = take("--sha");
  assertKnownFlags(rest, []);
  if (rest.length > 1) throw new Error(`expected at most one <log> path, got ${rest.length}`);
  const log = rest[0] ?? null;
  if (compact) {
    if (branch || pr || sha) throw new Error("--compact takes no --branch/--pr/--sha");
    if (log === null) throw new Error("--compact needs the <log> path");
    return { mode: "compact", log };
  }
  if (!branch || /[\s\]]/.test(branch)) throw new Error("--branch <b> is required (no spaces, no `]`)");
  if (!pr || !/^[1-9]\d*$/.test(pr)) throw new Error("--pr <n> must be a PR number");
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("--sha <merge sha> must be 7-40 hex digits");
  return { mode: "merge", log, branch, pr: Number(pr), sha };
}

/** One log's prune: `pruned <k> lines → <archive>` on success, else the missing sections. */
function pruneOne(
  args: Args,
  logPath: string
): { ok: true; line: string; warnings: string[] } | { ok: false; line: string } {
  const sessionId = basename(logPath).replace(/\.md$/, "");
  const archivePath = join(dirname(logPath), `${sessionId}.archive.md`);
  const log = readFileSync(logPath, "utf8");
  const archive = existsSync(archivePath) ? readFileSync(archivePath, "utf8") : null;
  const result =
    args.mode === "compact"
      ? compactSessionLog(log, archive, { sessionId, now: new Date() })
      : pruneSessionLog(log, archive, { branch: args.branch, pr: args.pr, sha: args.sha, sessionId, now: new Date() });
  if (!result.ok) {
    return { ok: false, line: `${logPath} has no ${result.missing.map((s) => `## ${s}`).join(", ")} section` };
  }
  if (result.archive !== null && result.moved > 0) writeAtomic(archivePath, result.archive);
  writeAtomic(logPath, result.log);
  return { ok: true, line: `pruned ${result.moved} lines → ${archivePath}`, warnings: result.warnings };
}

function main(argv: string[], exit: (code: number) => void = exitWhenFlushed): void {
  let args: Args;
  let logPaths: string[];
  try {
    args = parseArgs(argv);
    const givenLog = (path: string): string[] => {
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no log file at ${path}`);
      return [resolve(path)];
    };
    const byBranch = (branch: string): string[] => {
      const dir = process.env.SESSION_LOGS_DIR;
      if (!dir) throw new Error("no session-logs dir: set SESSION_LOGS_DIR or pass <log>");
      const found = findLogsByBranch(dir, branch);
      if (found.length === 0) throw new Error(`no session log under ${dir} carries a [${branch}] line`);
      return found;
    };
    logPaths =
      args.mode === "compact" ? givenLog(args.log) : args.log !== null ? givenLog(args.log) : byBranch(args.branch);
  } catch (err) {
    console.error(`sessionLogPrune: ${(err as Error).message}\n${USAGE}`);
    exit(2);
    return;
  }
  let failed = false;
  for (const logPath of logPaths) {
    const r = pruneOne(args, logPath);
    if (r.ok) {
      // Result first, then its warnings — on stdout, because the merge watcher relays only stdout
      // on exit 0 and a dropped `replaces:` warning is a decision left standing by mistake.
      console.log(r.line);
      for (const w of r.warnings) console.log(`warning: ${w}`);
    } else {
      console.error(`sessionLogPrune: ${r.line}`);
      failed = true;
    }
  }
  exit(failed ? 1 : 0);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
