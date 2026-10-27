/**
 * D-build-fix-table and D-final-table: the close loop's table, built by today's table library (`buildRound`) over a
 * mirror of the run dir it reads (`<run dir>/close/`). Each call copies in the files the graph handed
 * it that the mirror does not hold yet, under the names the library reads (`review.md`,
 * `fix-1.txt`, `stage-confirm-1/completeness.md`, `hand-test-2.txt`, `session.md`), picks the round
 * to build, and writes `table.json`, the round's `table-<round>.md` and `state.json`, which carries
 * what the next call and D-merge-fix need (the round, its rows, the session blocks, the claims' runs).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { matchesTarget, parseTargetFiles, summariseBrief } from "../../../runtime/lib/brief.ts";
import { gatherRound, readerFiles } from "../../../runtime/lib/runDir.ts";
import {
  driftGroupOf,
  driftRound,
  FIXED_ROUND_IDS,
  type FinalRound,
  type FixRound,
  type Kind,
  parseHandTestFile,
  parseStageFile,
  parseTableJson,
  type RoundId,
  serialiseTableJson,
  type Stage,
  stageKey,
  type StageKey,
  type StatusWord,
  type TableJson,
} from "../../../runtime/lib/runFiles.ts";
import { blockedFixFile, type FixFile } from "../../../runtime/lib/fixFile.ts";
import {
  buildRound,
  driftRoundsIn,
  givenRows,
  leftoverLines,
  renderRoundTable,
  roundIntake,
  type RoundIntake,
  stageCarry,
  summaryLines,
} from "../../../runtime/lib/table.ts";
import type { Thresholds } from "../../../runtime/thresholds.ts";
import type { Answer, CheckValue, DataValue, DataValues, FilesValue, RunHistory } from "../../contracts.ts";
import type { OpContext, OpResult } from "../../adapters/types.ts";
import { headSha } from "../../worktree.ts";
import { type BriefMark, briefMark, briefTextAt } from "./briefs.ts";
import { check, fileNamed, filesOf, readJsonFile, readText, repoConfigOf, writeOut } from "./common.ts";
import { type ClaimHistory, FIX_ROUND_IDS, roundModel } from "./decide.ts";
import { DRAFT_FILE, type DraftFile, draftSlices } from "./slices.ts";

/** A finding the session adds to the table (`session.md`): a builder's candidate, a red test or
 *  check, an answered decision the brief now allows. */
export interface SessionRow {
  title: string;
  locator: string;
  kind: Kind;
  finding: string;
  after: string;
}

interface SessionBlock extends SessionRow {
  id: string;
  stage: Stage;
}

/** What one table call hands the next, and D-merge-fix (`state.json`). */
export interface TableState {
  /** The round built last; null before round 1. */
  round: RoundId | null;
  /** That round's rows, as its fixer got them. */
  rows: { id: string; kind: Kind }[];
  /** The rounds a fixer ran on. */
  fixed: string[];
  driftGroups: number;
  session: SessionBlock[];
  claims: ClaimHistory;
  /** Rows left that no fixer round will take (the cap). */
  stranded: string[];
  /** Banked decisions that were answered: they came back as session rows, so the final round does
   *  not list them as banked. */
  answered: string[];
  /** The drift rounds a later fixed round carried (`graphIntake`): the final round does not carry
   *  them again. */
  carriedDrift: string[];
  /** The input files already mirrored. */
  seen: string[];
  /** The brief as the last round was built over (`briefMark`): D-merge-fix grades an amend in the
   *  fix's range against it. */
  brief?: BriefMark;
}

const EMPTY_TABLE: TableJson = { schema: 2, rounds: {} };
const INITIAL: TableState = { round: null, rows: [], fixed: [], driftGroups: 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [] };

/** The wave's reader items, mirrored into the run dir's root. */
const WAVE_FINDINGS = ["findings-review", "findings-silent-failures", "findings-review-codex", "findings-completeness", "findings-simplifier", "findings-security", "findings-repo-review"];
/** The re-reads after a fix, mirrored into the fixed round's confirm stage folder. */
const FIX_READS = ["findings-review-fix", "findings-completeness-fix", "findings-security-fix"];
/** Red test and check rows: each becomes a session block of the round that reads them. */
const RED_ROWS = ["test-rows", "test-rows-fix", "test-rows-drift", "pre-push-rows"];
/** The answered questions a fixer's decisions raised. */
const ANSWERS = ["fix-answers"];

export const mirrorDir = (runDir: string): string => join(runDir, "close");

/** A fix round's fix file in the mirror. */
export const fixFileName = (round: RoundId): string => `fix-${round}.txt`;

/** The data id D-build-fix-table writes its table and state under. */
const TABLE = "table";
const STATE_FILE = "state.json";

/** The run's last `table.json`: D-final-table's `final` output, else the last D-build-fix-table's `table`. */
export const runTableFile = (data: DataValues): string | undefined => fileNamed(data.final, "table.json") ?? fileNamed(data[TABLE], "table.json");

/** The round the table handed its fixer at each close-loop iteration (`TableState.round`), by
 *  iteration: read from the `table` output of each finished run of the node that writes it, found
 *  below `outDir(node, iteration)`. An iteration whose state is not on disk is left out. */
export function fixerRounds(history: Pick<RunHistory, "graph" | "nodes">, outDir: (node: string, iteration: number) => string): Map<number, RoundId> {
  const writers = new Set(history.graph.nodes.filter((n) => n.kind === "data" && n.outputs.includes(TABLE)).map((n) => n.id));
  const out = new Map<number, RoundId>();
  for (const n of history.nodes) {
    if (n.iteration === 0 || n.status !== "done" || !writers.has(n.node)) continue;
    const file = join(outDir(n.node, n.iteration), TABLE, STATE_FILE);
    if (!existsSync(file)) continue;
    const round = readJsonFile<TableState>(file).round;
    if (round !== null) out.set(n.iteration, round);
  }
  return out;
}

/** One status line a fix read gave a row of the fix round it answers. */
export interface FixReadStatus {
  reader: string;
  row: string;
  status: StatusWord;
}

/** Each fix round's status lines, by round: from the reader files in the mirror's stage folder that
 *  answers the round (`confirmStage`) and that some round of `table` took in, parsed as the table
 *  parsed them, against the rows the fixer's file gave each reader. A round with no fix file is left
 *  out. Throws on a file the table took in and that does not parse now. */
export function fixReadStatuses(mirror: string, table: TableJson, fixes: ReadonlyMap<FixRound, FixFile>): Map<FixRound, FixReadStatus[]> {
  const taken = new Set(Object.values(table.rounds).flatMap((r) => r?.consumed ?? []));
  const out = new Map<FixRound, FixReadStatus[]>();
  for (const [round, fix] of fixes) {
    const rows = table.rounds[round]?.rows;
    const stage = confirmStage(round);
    const folder = join(mirror, stage.folder);
    if (rows === undefined || !existsSync(folder)) continue;
    const statuses: FixReadStatus[] = [];
    for (const f of readerFiles(folder)) {
      if (f.reader === "session" || !taken.has(`${stage.folder}/${f.name}`)) continue;
      const parsed = parseStageFile(readText(f.path), { stage: stage.stage as Exclude<Stage, "wave">, given: givenRows(rows, fix, f.reader), reader: f.reader });
      for (const s of parsed.status) statuses.push({ reader: f.reader, row: s.row, status: s.status });
    }
    out.set(round, statuses);
  }
  return out;
}

/** The stage folder whose reads answer round `round`'s fix (`stageCarry`, inverted). */
export function confirmStage(round: RoundId): StageKey {
  const g = driftGroupOf(round);
  if (g !== null) return stageKey("drift-confirm", g);
  switch (round) {
    case "1":
      return stageKey("confirm-1");
    case "2":
      return stageKey("confirm-2");
    case "3":
      return stageKey("last");
    case "escalate":
      return stageKey("escalate");
  }
  throw new Error(`round ${round} has no fixer`);
}

/** The fixed round after `round` (1 → 2 → 3 → escalate), or null after escalate. */
export function nextFixedRound(round: RoundId): RoundId | null {
  const i = (FIXED_ROUND_IDS as readonly string[]).indexOf(round);
  return i < 0 || i === FIXED_ROUND_IDS.length - 1 ? null : FIXED_ROUND_IDS[i + 1]!;
}

/** Which round this call builds: round 1 first; a drift round when a drift read came in; else, when
 *  anything new came in, the fixed round after the last one a fixer took (a fixed round built with no
 *  rows is not spent: it is built again with what came since). Null: nothing to build. */
export function pickRound(s: TableState, table: TableJson, news: { drift: boolean; any: boolean }): RoundId | null {
  if (s.round === null) return "1";
  if (news.drift) return driftRound(s.driftGroups + 1);
  if (!news.any) return null;
  const lastFixed = (FIXED_ROUND_IDS as readonly RoundId[]).filter((r) => table.rounds[r] !== undefined).at(-1) ?? null;
  if (lastFixed === null) return "1";
  const spent = s.fixed.includes(lastFixed) || (table.rounds[lastFixed]?.rows.length ?? 0) > 0;
  return spent ? nextFixedRound(lastFixed) : lastFixed;
}

/**
 * The build graph's intake for a round: today's (`roundIntake`), with two changes the graph needs and
 * today's /build does not get. Round 1 reads the wave's hand test (the graph runs it beside the first
 * read, so a `fail (code)` is a round-1 row). A fixed round built after a drift round's fixer ran
 * carries that drift round (`drift`: only D-build-fix-table asks for it), so a drift row the re-read did not
 * resolve reaches a fixer again; the final round then carries only the drift rounds no fixed round did.
 */
export function graphIntake(round: RoundId, table: TableJson, s: Pick<TableState, "fixed" | "carriedDrift">, opts: { drift: boolean }): RoundIntake {
  const base = roundIntake(round, table);
  if (round === "1") return { ...base, handTests: true };
  if (round === "final") {
    const taken = (key: string) => s.carriedDrift.some((d) => stageKey("drift-confirm", driftGroupOf(d)!).key === key);
    return { ...base, carry: base.carry.filter((c) => !s.carriedDrift.includes(c.from)), newStages: base.newStages.filter((st) => !taken(st.key)) };
  }
  if (!opts.drift || driftGroupOf(round) !== null) return base;
  const pending = driftRoundsIn(table).filter((d) => s.fixed.includes(d) && !s.carriedDrift.includes(d));
  const carries = pending.map((d) => stageCarry(stageKey("drift-confirm", driftGroupOf(d)!))!);
  return { ...base, carry: [...base.carry, ...carries], newStages: [...base.newStages, ...carries.map((c) => c.stage)] };
}

/** A fixer takes the round's rows: rounds 1-3 and drift rounds (map §8 point 2: three fixer rounds,
 *  the third on Opus, urgent kinds only). The library's `escalate` round has no fixer here. */
export const hasFixer = (round: RoundId): boolean => (FIX_ROUND_IDS as readonly string[]).includes(round) || driftGroupOf(round) !== null;

/** The session stage the final round reads: rows that come in when no fixed round is left to take
 *  them go there, so the final round lists them (an urgent one open, the rest leftovers). */
const finalStage = (table: TableJson, s: Pick<TableState, "fixed" | "carriedDrift">): Stage => graphIntake("final", table, s, { drift: false }).sessionStages[0]!;

function sessionText(blocks: readonly SessionBlock[]): string {
  return blocks
    .map((b) => [`### ${b.id} — ${b.title}`, `- locator: ${b.locator}`, `- kind: ${b.kind}`, `- stage: ${b.stage}`, `- finding: ${b.finding}`, `- after: ${b.after}`].join("\n"))
    .join("\n\n");
}

/** Add rows to the session for `stage`; a row the stage already holds (a red check that stays red
 *  while no round is left to fix it) is not added again. */
function addSession(s: TableState, rows: readonly SessionRow[], stage: Stage): void {
  const same = (a: SessionRow, b: SessionRow) => a.title === b.title && a.locator === b.locator && a.finding === b.finding;
  for (const r of rows) {
    if (s.session.some((b) => b.stage === stage && same(b, r))) continue;
    s.session.push({ ...r, id: `SESSION.${s.session.length + 1}`, stage });
  }
}

/** A builder's `candidates.md` blocks, as session rows. */
function candidateRows(file: string): SessionRow[] {
  const text = readText(file);
  const out: SessionRow[] = [];
  for (const block of text.split(/^(?=#{2,4} )/m)) {
    const head = /^#{2,4} \S+ — (.+)$/m.exec(block);
    const field = (k: string) => new RegExp(`^- ${k}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
    const [locator, kind, finding, after] = [field("locator"), field("kind"), field("finding"), field("after") ?? field("fix")];
    if (head && locator && kind && finding && after) out.push({ title: head[1]!.trim(), locator, kind: kind as Kind, finding, after });
  }
  return out;
}

/** Copy one files value into `dest`, each file at its path below the output folder it was written to. */
function mirrorFiles(v: DataValue | undefined, dest: string, s: TableState): string[] {
  const out: string[] = [];
  for (const f of filesOf(v)) {
    if (s.seen.includes(f)) continue;
    const to = join(dest, relative(outputFolder(f), f));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(f, to);
    s.seen.push(f);
    out.push(to);
  }
  return out;
}

const OUTPUT_FOLDER_RE = /^(.*\/nodes\/[^/]+\/\d+(?:\/(?!out\/)[^/]+)?\/out\/[^/]+)\//;
const ITERATION_RE = /\/nodes\/[^/]+\/(\d+)\//;
const HAND_TEST_RE = /^hand-test-(\d+)(\.txt$|\/)/;

/**
 * Copy a hand tester's output into the mirror as hand test number `iteration + 1` (the number its
 * agent file tells it to use): `hand-test-<k>.txt` becomes `hand-test-<n>.txt`, the output folder
 * `hand-test-<k>/` becomes `hand-test-<n>/`, and the file's output paths with it. The table reads a
 * hand-test file name once, so a later file under an earlier name would be skipped.
 */
export function mirrorHandTests(v: DataValue | undefined, mirror: string, s: TableState): string[] {
  const out: string[] = [];
  for (const f of filesOf(v)) {
    if (s.seen.includes(f)) continue;
    const rel = relative(outputFolder(f), f);
    const m = HAND_TEST_RE.exec(rel);
    const n = Number(ITERATION_RE.exec(f)?.[1] ?? "0") + 1;
    const to = join(mirror, m === null ? rel : rel.replace(HAND_TEST_RE, `hand-test-${n}$2`));
    mkdirSync(dirname(to), { recursive: true });
    if (m !== null && m[2] === ".txt") writeFileSync(to, readText(f).replaceAll(`hand-test-${m[1]}/`, `hand-test-${n}/`));
    else cpSync(f, to);
    s.seen.push(f);
    out.push(to);
  }
  return out;
}

/** `<run dir>/nodes/<node>/<iteration>[/<item>]/out/<id>`: the folder a node wrote one output into. */
export function outputFolder(file: string): string {
  return OUTPUT_FOLDER_RE.exec(file)?.[1] ?? dirname(file);
}

function redRows(v: DataValue | undefined, s: TableState): SessionRow[] {
  const f = fileNamed(v, "rows.json");
  if (f === undefined || s.seen.includes(f)) return [];
  s.seen.push(f);
  return readJsonFile<SessionRow[]>(f);
}

/** An answered decision's row kind: an urgent row stays urgent, so a fix of it is read again. A
 *  behavior or security row keeps its kind; a missing one becomes behavior, because the table's
 *  grammar allows `missing` only on a VERIFIER id (`runFiles.ts`) and the answer comes back as a
 *  SESSION row. Any other becomes `structure`, the change the answer asks for. */
export function answeredKind(kind: Kind | undefined): Kind {
  if (kind === "behavior" || kind === "security") return kind;
  return kind === "missing" ? "behavior" : "structure";
}

/** Every answered decision is a row of the next round: whoever gave the answer, it now asks for the
 *  change, and the PR body lists where it came from. */
function answeredRows(v: DataValue | undefined, s: TableState, table: TableJson): SessionRow[] {
  const out: SessionRow[] = [];
  for (const f of filesOf(v)) {
    if (s.seen.includes(f)) continue;
    s.seen.push(f);
    for (const a of readJsonFile<Answer[]>(f)) {
      s.answered.push(a.question_id);
      const row = Object.values(table.rounds)
        .flatMap((r) => r?.rows ?? [])
        .find((r) => r.id === a.question_id);
      const loc = row?.locators[0];
      out.push({
        title: `${a.question_id} answered: ${a.answer.split("\n")[0]!.slice(0, 80)}`,
        locator: loc === undefined ? "(none)" : loc.start === 0 ? loc.path : `${loc.path}:${loc.start}-${loc.end}`,
        kind: answeredKind(row?.kind),
        finding: `${a.question_id} asked; answer: ${a.answer} (${a.by === "operator" ? "the operator's answer" : `the resolver's, source: ${a.source}`}${a.brief_change === undefined ? "" : `; brief change: ${a.brief_change}`})`,
        after: a.answer,
      });
    }
  }
  return out;
}

function readState(inputs: DataValues): { state: TableState; table: TableJson } {
  const st = fileNamed(inputs[TABLE], STATE_FILE);
  const tj = fileNamed(inputs[TABLE], "table.json");
  if (st === undefined || tj === undefined) return { state: structuredClone(INITIAL), table: EMPTY_TABLE };
  return { state: { ...structuredClone(INITIAL), ...readJsonFile<TableState>(st) }, table: parseTableJson(readText(tj)) };
}

function targetsOf(inputs: DataValues): (p: string) => boolean {
  const brief = filesOf(inputs.brief).find((f) => f.endsWith(".md"));
  if (brief === undefined) return () => false;
  const targets = parseTargetFiles(readText(brief));
  return (p) => matchesTarget(p.replace(/^\.\//, ""), targets);
}

/** Mirror every input the table has not seen; returns what came in. */
function mirrorInputs(ctx: OpContext, s: TableState, table: TableJson, mirror: string): { drift: boolean; any: boolean; red: SessionRow[]; answered: SessionRow[] } {
  const inputs = ctx.inputs;
  let any = false;
  if (s.round === null) {
    for (const id of WAVE_FINDINGS) mirrorFiles(inputs[id], mirror, s);
    mirrorHandTests(inputs["hand-results"], mirror, s);
    for (const f of filesOf(inputs["builder-report"]).filter((f) => basename(f) === "candidates.md")) addSession(s, candidateRows(f), "wave");
  }
  const fixFile = filesOf(inputs["fix-file"]).find((f) => f.endsWith(".txt") && !s.seen.includes(f));
  if (fixFile !== undefined && s.round !== null) {
    cpSync(fixFile, join(mirror, fixFileName(s.round)));
    s.seen.push(fixFile);
    if (!s.fixed.includes(s.round)) s.fixed.push(s.round);
    any = true;
  }
  if (s.round !== null && hasFixer(s.round) && s.fixed.includes(s.round)) {
    const folder = join(mirror, confirmStage(s.round).folder);
    for (const id of FIX_READS) if (mirrorFiles(inputs[id], folder, s).length > 0) any = true;
  }
  const hand = mirrorHandTests(inputs["hand-results-fix"], mirror, s);
  if (hand.length > 0) any = true;
  for (const f of hand.filter((f) => /hand-test-\d+\.txt$/.test(f))) {
    for (const line of parseHandTestFile(readText(f))) (s.claims[line.claim] ??= []).push(line.result);
  }
  if (s.round === null) {
    for (const f of filesOf(inputs["hand-results"])) {
      if (!/hand-test-\d+\.txt$/.test(f)) continue;
      for (const line of parseHandTestFile(readText(f))) (s.claims[line.claim] ??= []).push(line.result);
    }
  }
  let drift = false;
  if (filesOf(inputs["findings-review-drift"]).some((f) => !s.seen.includes(f))) {
    mirrorFiles(inputs["findings-review-drift"], join(mirror, stageKey("drift", s.driftGroups + 1).folder), s);
    drift = true;
  }
  const red = RED_ROWS.flatMap((id) => redRows(inputs[id], s));
  const answered = ANSWERS.flatMap((id) => answeredRows(inputs[id], s, table));
  if (red.length > 0 || answered.length > 0) any = true;
  return { drift, any, red, answered };
}

function writeTable(ctx: OpContext, table: TableJson, state: TableState, round: RoundId | null): FilesValue {
  const files: Record<string, string | object> = { "table.json": serialiseTableJson(table), [STATE_FILE]: state };
  if (round !== null && round !== "final") files[`table-${round}.md`] = renderRoundTable(round, table.rounds[round]!);
  return writeOut(ctx.outDir, TABLE, files);
}

/** D-build-fix-table. */
export async function fixTable(ctx: OpContext): Promise<OpResult> {
  const { state, table } = readState(ctx.inputs);
  const mirror = mirrorDir(ctx.place.runDir);
  mkdirSync(mirror, { recursive: true });
  const news = mirrorInputs(ctx, state, table, mirror);
  const round = pickRound(state, table, news);
  const intake = round === null ? null : graphIntake(round, table, state, { drift: true });
  addSession(state, [...news.red, ...news.answered], intake?.sessionStages[0] ?? finalStage(table, state));
  writeFileSync(join(mirror, "session.md"), sessionText(state.session));

  if (round === null) {
    const table2 = writeTable(ctx, table, state, null);
    const nothingOpen = state.stranded.length === 0;
    return done(ctx, table2, check("fail", `no round to build: nothing new since round ${state.round}`), check(nothingOpen ? "pass" : "fail", nothingOpen ? "nothing left open" : `left open: ${state.stranded.join(", ")}`), { round: String(state.round), slices: [] }, "sonnet");
  }

  const repoReaders = filesOf(ctx.inputs["findings-repo-review"]).map((f) => basename(f).replace(/(?:-\d+)?\.md$/, ""));
  const gathered = gatherRound(mirror, round, { waveRepoReaders: repoReaders }, table, intake!);
  const head = headSha(ctx.place.worktree);
  const built = buildRound({ round, head, table, isTarget: targetsOf(ctx.inputs), ...gathered, merge: mergeLimits(ctx.inputs), intake: intake! });
  const briefNow = briefTextAt(ctx.inputs, ctx.place.worktree, head);
  const rows = built.round.rows;
  const fixer = hasFixer(round) && rows.length > 0;
  const next: TableState = {
    ...state,
    carriedDrift: [...state.carriedDrift, ...intake!.carry.map((c) => c.from).filter((r) => driftGroupOf(r) !== null && round !== "final")],
    round,
    rows: rows.map((r) => ({ id: r.id, kind: r.kind })),
    driftGroups: driftGroupOf(round) ?? state.driftGroups,
    stranded: rows.length > 0 && !fixer ? rows.map((r) => r.id) : [],
    ...(briefNow === null ? {} : { brief: briefMark(briefNow) }),
  };
  const out = writeTable(ctx, built.table, next, round);
  const summary = summaryLines(round, built.round).join("; ");
  const briefModel = briefModelOf(ctx.inputs);
  const model = FIX_ROUND_IDS.includes(round as never) ? roundModel(round as (typeof FIX_ROUND_IDS)[number], rows.map((r) => r.kind), briefModel) : "sonnet";
  const owed = fixer
    ? check("pass", `${summary}; fixer model ${model}`)
    : check("fail", rows.length > 0 ? `${summary}; no fixer round is left for these rows` : summary);
  const nothingOpen = next.stranded.length === 0 ? check("pass", "no row is left without a fixer") : check("fail", `rows left with no fixer round: ${next.stranded.join(", ")}`);
  return done(ctx, out, owed, nothingOpen, { round, slices: fixer ? draftSlices(rows) : [] }, model);
}

/** The table's merge limits, from the repo's thresholds (`runtime/thresholds.ts`, defaults filled in). */
function mergeLimits(inputs: DataValues): { near: number; exactAbove: number } {
  const t = repoConfigOf(inputs).thresholds as Thresholds;
  return { near: t.TABLE_MERGE_NEAR_LINES, exactAbove: t.TABLE_MERGE_EXACT_ABOVE_LINES };
}

/** The most fixers a round runs at once: the repo's `SUBAGENT_MAX` (Claude subagents live at once). */
export const fixerCap = (inputs: DataValues): number => (repoConfigOf(inputs).thresholds as Thresholds).SUBAGENT_MAX;

/**
 * Each carry of `intake` whose round had rows and no fix file in the mirror: no fixer ran on it (the
 * graph has none after round 3, and the loop's cap can end it before one). Write its rows as
 * `blocked`, so the round routes them as unfixed (urgent rows open, the rest leftovers) instead of
 * failing on a fix file nobody was going to write.
 */
function blockUnfixed(intake: RoundIntake, table: TableJson, mirror: string): void {
  for (const c of intake.carry) {
    const rows = table.rounds[c.from]?.rows ?? [];
    const file = join(mirror, fixFileName(c.fix));
    if (rows.length === 0 || existsSync(file)) continue;
    const reason = `no fixer ran on round ${c.from}: the run's fixer rounds are spent`;
    writeFileSync(file, blockedFixFile(rows.map((r) => r.id), reason, "no fixer ran"));
  }
}

function briefModelOf(inputs: DataValues): string | null {
  const brief = filesOf(inputs.brief).find((f) => f.endsWith(".md"));
  if (brief === undefined) return null;
  try {
    return summariseBrief(readText(brief)).model;
  } catch {
    return null;
  }
}

/** D-build-fix-table's outputs: with the table and its checks, the round's draft slices (none when no fixer
 *  takes it), whether the round can split (A-link-slices waits on it: two draft slices or more, and a
 *  fixer cap above one), and the model the round's fixers run on. */
function done(ctx: OpContext, table: FilesValue, fixOwed: CheckValue, nothingOpen: CheckValue, draft: DraftFile, fixerModel: string): OpResult {
  const cap = fixerCap(ctx.inputs);
  const n = draft.slices.length;
  const canSplit = check(n > 1 && cap > 1 ? "pass" : "fail", `${n} draft slice${n === 1 ? "" : "s"}; the round runs at most ${cap} fixer${cap === 1 ? "" : "s"}`);
  return { status: "done", outputs: { [TABLE]: table, "fix-owed": fixOwed, "nothing-open": nothingOpen, "draft-slices": writeOut(ctx.outDir, "draft-slices", { [DRAFT_FILE]: draft }), "can-split": canSplit, "fixer-model": { schema: "text", text: fixerModel } } };
}

/**
 * D-final-table: mirror what the loop's last iteration left, build any fixed round the run never reached
 * (empty: the final round reads all four), then the `final` round. `has-leftovers` passes when it
 * holds leftovers or banked rows (D-file-leftovers files them); `final-clean` passes when no urgent row is
 * open and no banked decision waits unanswered (the PR is not a draft, and the gate and merge may run).
 */
export async function finalTable(ctx: OpContext): Promise<OpResult> {
  const { state, table: start } = readState(ctx.inputs);
  const mirror = mirrorDir(ctx.place.runDir);
  mkdirSync(mirror, { recursive: true });
  const news = mirrorInputs(ctx, state, start, mirror);
  addSession(state, [...news.red, ...news.answered], finalStage(start, state));
  writeFileSync(join(mirror, "session.md"), sessionText(state.session));
  const merge = mergeLimits(ctx.inputs);
  const isTarget = targetsOf(ctx.inputs);
  const head = headSha(ctx.place.worktree);
  let table = start;
  for (const round of [...(FIXED_ROUND_IDS as readonly RoundId[]), "final" as const]) {
    if (round !== "final" && table.rounds[round] !== undefined) continue;
    const intake = graphIntake(round, table, state, { drift: false });
    blockUnfixed(intake, table, mirror);
    table = buildRound({ round, head, table, isTarget, ...gatherRound(mirror, round, { waveRepoReaders: [] }, table, intake), merge, intake }).table;
  }
  const final = table.rounds.final as FinalRound;
  const banked = final.banked.filter((b) => !state.answered.includes(b.id));
  const leftovers = [...leftoverLines(final, ctx.runId), ...banked.map((b) => `- ${ctx.runId} · ${b.id} · banked — ${b.question}`)];
  const out = writeOut(ctx.outDir, "final", {
    "table.json": serialiseTableJson(table),
    "final.md": `# Final round\n\n${summaryLines("final", final).join("\n")}\nanswered, back as session rows: ${state.answered.join(", ") || "none"}\n\n## Leftovers\n\n${leftovers.length === 0 ? "none" : leftovers.join("\n")}\n`,
  });
  const has = leftovers.length > 0;
  const clean = final.open.length === 0 && banked.length === 0;
  const notClean = [...final.open.map((o) => `${o.id} ${o.kind}`), ...banked.map((b) => `${b.id} banked, unanswered`)];
  return {
    status: "done",
    outputs: {
      final: out,
      "has-leftovers": check(has ? "pass" : "fail", has ? `${leftovers.length} leftovers and banked rows` : "no leftovers"),
      "final-clean": check(clean ? "pass" : "fail", clean ? "no urgent row is open and no banked decision waits" : `open: ${notClean.join(", ")}`),
    },
  };
}

/** The table state D-build-fix-table wrote, from its `table` output. */
export function tableStateOf(v: DataValue | undefined): TableState {
  const f = fileNamed(v, STATE_FILE);
  if (f === undefined) throw new Error("the table holds no state.json");
  return readJsonFile<TableState>(f);
}

export const tableJsonOf = (v: DataValue | undefined): TableJson => {
  const f = fileNamed(v, "table.json");
  if (f === undefined) throw new Error("the table holds no table.json");
  return parseTableJson(readFileSync(f, "utf8"));
};
