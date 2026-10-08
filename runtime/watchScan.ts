/**
 * watchScan — reads a watched agent's transcript for `agent-watchdog.sh`: whether it has finished,
 * and (the `--flags` watch) the six flags over its live segment.
 *
 *   node ~/.agent-build/runtime/watchScan.ts state <transcript>
 *     prints `finished`, `running`, or `missing`; exit 0
 *   node ~/.agent-build/runtime/watchScan.ts last <path> [--calls <n>]
 *     prints what an agent is doing now, in at most n + 3 short lines: `AGENT` (name, state, record
 *     count, age of the last write), `LAST` and its last n tool calls (default 8, 1 to 30), and `SAID`
 *     (its last assistant text, cut to 200 characters); <path> is a task `.output` path or the
 *     `agent-*.jsonl` it points to; exit 0 (a missing transcript prints `missing`) · 2 usage
 *   node ~/.agent-build/runtime/watchScan.ts scan [--repo <dir>] [--armed-at <epoch s>]
 *        [--ack <agent>:<flag>:<count>]… [--agent <name>=<transcript>]… [--codex <name>=<log>]…
 *        [--part-files <name>=<file>]…
 *     prints one block per flagged agent (`FLAG …` lines, `LAST <agent>` and its last 8 tool calls,
 *     one `ack: --ack …` line per flag); exit 0 quiet · 3 a flag · 2 usage or unreadable input
 *     `--part-files` gives an `--agent` its part's entries (`briefCheck.ts --files <P<k>|W<k>>`'s
 *     output, one per line); only such an agent gets the `off-part` flag: the distinct paths it
 *     edited inside its transcript's cwd, outside `.claude/run-state/`, that match no entry.
 *
 * A live segment starts at the first prompt, at a message from the coordinator or a peer, at any
 * user message that is not harness-injected, and at any user record that arrives after the agent
 * ended its turn (a resume); a turn ends on an `end_turn` or on a delivered `SubagentHandback`. A
 * harness record inside a turn — an image a Read returned, a skill's text, a task notification —
 * continues the segment. Every counter is per segment. Limits come from
 * `thresholds.ts` (`WATCH_*`), read from `--repo` (default: cwd).
 */

import { closeSync, existsSync, openSync, readFileSync, readlinkSync, readSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { matchesTarget } from "./lib/brief.ts";
import { assertKnownFlags } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { isMain } from "./lib/isMain.ts";
import { loadThresholds, type Thresholds } from "./thresholds.ts";

// ---------------------------------------------------------------------------------------------
// Transcript records

type Json = Record<string, unknown>;

export interface ToolCall {
  id: string;
  tool: string;
  input: Json;
  atMs: number;
}

export type Finished = "finished" | "running" | "missing";

/** A turn is over when its last assistant record stopped for one of these. */
const TERMINAL_STOPS = new Set(["end_turn", "stop_sequence"]);
/** A helper's run also ends on this tool's result: the call hands its report to the caller, and the
 *  transcript stops there with no `end_turn` after it (Claude Code, from 2026-09-30). */
const HANDBACK_TOOL = "SubagentHandback";
/** Tools that change a file; a Bash `git commit` counts too. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const GIT_COMMIT = /\bgit\s+(?:-[cC]\s+\S+\s+)*commit\b/;
/** A tool_result error that is a refusal (a hook, the worktree guard, a permission or harness
 *  block), as opposed to a command that ran and failed. */
const REFUSAL =
  /^(?:<tool_use_error>)?\s*(?:PreToolUse:\S+ hook error|This (?:session|agent) is isolated in the worktree|Permission (?:to use|for this)|The server-side auto mode classifier|Blocked:)/;
/** Injected user records that are a resume even inside a turn: a message from the coordinator or
 *  another session. */
const RESUME_ORIGINS = new Set(["coordinator", "peer"]);
const LAST_CALLS = 8;
/** `last --calls` takes a whole number up to this. */
const MAX_LAST_CALLS = 30;
const TARGET_CHARS = 60;
const SAID_CHARS = 200;

export function parseLines(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const rec = JSON.parse(line) as unknown;
      if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) out.push(rec as Json);
    } catch {
      // a torn last line or a stray non-JSON line: skip it
    }
  }
  return out;
}

function message(rec: Json): Json {
  const m = rec.message;
  return m !== null && typeof m === "object" ? (m as Json) : {};
}

function contentItems(rec: Json): Json[] {
  const c = message(rec).content;
  return Array.isArray(c) ? c.filter((x): x is Json => x !== null && typeof x === "object") : [];
}

function timeOf(rec: Json): number | null {
  const t = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  return Number.isNaN(t) ? null : t;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((x) => (x !== null && typeof x === "object" ? String((x as Json).text ?? "") : ""))
      .join(" ");
  return "";
}

function hasToolResult(rec: Json): boolean {
  return contentItems(rec).some((x) => x.type === "tool_result");
}

function originKind(rec: Json): string | null {
  const o = rec.origin;
  if (o !== null && typeof o === "object") return typeof (o as Json).kind === "string" ? ((o as Json).kind as string) : null;
  return typeof o === "string" ? o : null;
}

/** A record of the conversation itself. Claude Code writes `attachment` (and `system`) records after
 *  a final `end_turn` too, so the finished state skips them. */
function isTurnRecord(rec: Json): boolean {
  return rec.type === "assistant" || rec.type === "user";
}

/** The `tool_use` ids of every `SubagentHandback` call in an assistant record. */
function handbackIds(rec: Json): string[] {
  return contentItems(rec)
    .filter((x) => x.type === "tool_use" && x.name === HANDBACK_TOOL && typeof x.id === "string")
    .map((x) => x.id as string);
}

/** A user record that delivers the result of one of `ids` without an error: the report reached
 *  the caller. */
function deliversHandback(rec: Json, ids: ReadonlySet<string>): boolean {
  return contentItems(rec).some((x) => x.type === "tool_result" && ids.has(String(x.tool_use_id)) && x.is_error !== true);
}

/**
 * Finished when the last assistant-or-user record is an assistant turn that stopped, or when the
 * transcript ends on tool results after its last assistant record and one of them is a delivered
 * `SubagentHandback`. A prompt or a resume after either is a new turn: running.
 */
export function finishedState(recs: readonly Json[]): Exclude<Finished, "missing"> {
  return turnEnd(recs) === "finished" ? "finished" : "running";
}

/** `finishedState`, plus `cut` when the answer may lie before `recs[0]`: no turn record, or the
 *  calls the closing tool results answer start before it. A tail window that reads `cut` widens. */
function turnEnd(recs: readonly Json[]): "finished" | "running" | "cut" {
  const results: Json[] = [];
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i]!;
    if (!isTurnRecord(rec)) continue;
    if (rec.type === "user") {
      if (!hasToolResult(rec)) return "running";
      results.push(rec);
      continue;
    }
    if (results.length === 0) {
      const stop = message(rec).stop_reason;
      return typeof stop === "string" && TERMINAL_STOPS.has(stop) ? "finished" : "running";
    }
    // Parallel calls are one assistant record each: the handback may sit in any record of the run
    // that ends here.
    const ids = new Set<string>();
    let j = i;
    for (; j >= 0; j--) {
      const call = recs[j]!;
      if (!isTurnRecord(call)) continue;
      if (call.type !== "assistant") break;
      for (const id of handbackIds(call)) ids.add(id);
    }
    if (results.some((r) => deliversHandback(r, ids))) return "finished";
    return j < 0 ? "cut" : "running";
  }
  return "cut";
}

/** The finished state without loading the whole file: parse the tail, and widen the window while
 *  the answer may lie before it (real lines pass 1 MB). A line the window cuts is skipped. */
export function readFinished(path: string): Finished {
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");
  } catch {
    return "missing";
  }
  try {
    let win = 262_144;
    for (;;) {
      const start = Math.max(0, size - win);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const recs = parseLines(buf.toString("utf8"));
      if (start === 0 || turnEnd(recs) !== "cut") return finishedState(recs);
      win *= 2;
    }
  } catch {
    return "missing";
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------------
// Segments

/** Index of the record that starts the last live segment (0 when there is none). */
export function lastSegmentStart(recs: readonly Json[]): number {
  let start = 0;
  let turnOpen = false; // the last assistant record asked for a tool
  let handbacks = new Set<string>(); // the open turn's SubagentHandback calls
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    if (rec.type === "assistant") {
      turnOpen = contentItems(rec).some((x) => x.type === "tool_use");
      handbacks = turnOpen ? new Set([...handbacks, ...handbackIds(rec)]) : new Set();
      continue;
    }
    // A delivered handback ends the turn, as an `end_turn` does.
    if (rec.type === "user" && deliversHandback(rec, handbacks)) {
      turnOpen = false;
      handbacks = new Set();
      continue;
    }
    if (rec.type !== "user" || rec.isCompactSummary === true || hasToolResult(rec)) continue;
    const injected = rec.isMeta === true && !RESUME_ORIGINS.has(originKind(rec) ?? "");
    if (!turnOpen || !injected) {
      start = i;
      turnOpen = false;
    }
  }
  return start;
}

export interface SegmentStats {
  startMs: number | null;
  lastEditMs: number | null;
  /** `<path>@<offset>:<limit>` → Read calls in the segment. */
  reads: Map<string, number>;
  /** `<tool> <command or path>` → refused calls in the segment. */
  refusals: Map<string, number>;
  compactions: number;
  /** Each path an `Edit`, `Write`, `MultiEdit`, or `NotebookEdit` call targeted in the segment →
   *  the cwd of the record that made the call (null when the record carries none). */
  edited: Map<string, string | null>;
}

function callKey(tool: string, input: Json): string {
  const v = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern;
  return `${tool} ${typeof v === "string" ? v : JSON.stringify(input)}`;
}

function toolCalls(recs: readonly Json[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const rec of recs) {
    if (rec.type !== "assistant") continue;
    const at = timeOf(rec) ?? 0;
    for (const x of contentItems(rec))
      if (x.type === "tool_use")
        calls.push({
          id: String(x.id ?? ""),
          tool: String(x.name ?? "?"),
          input: x.input !== null && typeof x.input === "object" ? (x.input as Json) : {},
          atMs: at,
        });
  }
  return calls;
}

/** The counters over the last live segment of a transcript. */
export function segmentStats(recs: readonly Json[]): SegmentStats {
  const seg = recs.slice(lastSegmentStart(recs));
  const stats: SegmentStats = {
    startMs: seg.length > 0 ? timeOf(seg[0]!) : null,
    lastEditMs: null,
    reads: new Map(),
    refusals: new Map(),
    compactions: 0,
    edited: new Map(),
  };
  const byId = new Map<string, ToolCall>();
  for (const c of toolCalls(recs)) byId.set(c.id, c);
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  for (const rec of seg) {
    if (rec.type === "system" && rec.subtype === "compact_boundary") stats.compactions++;
    for (const x of contentItems(rec)) {
      if (rec.type === "assistant" && x.type === "tool_use") {
        const tool = String(x.name ?? "");
        const input = (x.input ?? {}) as Json;
        if (tool === "Read") bump(stats.reads, `${String(input.file_path ?? "")}@${String(input.offset ?? "")}:${String(input.limit ?? "")}`);
        const isEdit = EDIT_TOOLS.has(tool) || (tool === "Bash" && GIT_COMMIT.test(String(input.command ?? "")));
        const target = input.file_path ?? input.notebook_path;
        if (EDIT_TOOLS.has(tool) && typeof target === "string" && isAbsolute(target))
          stats.edited.set(resolve(target), typeof rec.cwd === "string" ? rec.cwd : null);
        const at = timeOf(rec);
        if (isEdit && at !== null) stats.lastEditMs = Math.max(stats.lastEditMs ?? at, at);
      } else if (rec.type === "user" && x.type === "tool_result" && x.is_error === true) {
        const call = byId.get(String(x.tool_use_id ?? ""));
        if (call !== undefined && REFUSAL.test(textOf(x.content))) bump(stats.refusals, callKey(call.tool, call.input));
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------
// Flags

export type FlagName = "silent" | "no-edit" | "same-slice" | "same-refusal" | "compactions" | "off-part";
export type WatchLimitKey =
  | "WATCH_SILENT_MIN"
  | "WATCH_NO_EDIT_MIN"
  | "WATCH_SAME_SLICE_READS"
  | "WATCH_SAME_REFUSAL"
  | "WATCH_COMPACTIONS"
  | "WATCH_OFF_PART_FILES";

/** Agent types the `no-edit` flag watches (the part after a plugin prefix `x:`). */
export const EDIT_BEARING = new Set(["builder", "fixer", "test-author"]);

/** Edits under this cwd-relative folder are run state, never a part's code. */
const RUN_STATE_DIR = ".claude/run-state/";

export interface WatchedAgent {
  name: string;
  /** From `agent-<id>.meta.json`; null when absent (then `no-edit` does not apply). */
  agentType: string | null;
  /** Transcript records; null for a Codex run (only `silent` applies). */
  recs: Json[] | null;
  /** mtime of the transcript, or of the Codex log. */
  lastWriteMs: number;
  /** The part's `files:` and `test files:` entries (`--part-files`); absent, `off-part` does not apply. */
  partFiles?: readonly string[];
}

export interface ScanContext {
  nowMs: number;
  /** When this watch was armed: an acked time flag counts its limit from here or from the last
   *  activity, whichever is later. */
  armedAtMs: number;
  limits: Pick<Thresholds, WatchLimitKey>;
  /** `<agent>:<flag>` → the count the session acknowledged. */
  acks: Map<string, number>;
}

interface FlagRule {
  flag: FlagName;
  limit: WatchLimitKey;
  /** true for a clock flag: count is whole minutes since `since`. */
  clock: boolean;
  applies(a: WatchedAgent): boolean;
  /** Clock flags: the time the quiet period started. Count flags: the count. */
  measure(a: WatchedAgent, s: SegmentStats | null): number | null;
}

const maxOf = (m: Map<string, number>): number => Math.max(0, ...m.values());
const bareType = (t: string | null): string | null => (t === null ? null : t.slice(t.lastIndexOf(":") + 1));

/** Distinct edited paths inside their record's cwd, outside run state, that match no part entry. */
export function offPartCount(edited: ReadonlyMap<string, string | null>, partFiles: readonly string[]): number {
  let n = 0;
  for (const [path, cwd] of edited) {
    if (cwd === null) continue;
    const rel = relative(resolve(cwd), path);
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
    if (rel.startsWith(RUN_STATE_DIR)) continue;
    if (!matchesTarget(rel, partFiles)) n++;
  }
  return n;
}

/** The one flag table (§1.17; `off-part`, landing 2 §1.7). */
export const FLAG_RULES: readonly FlagRule[] = [
  { flag: "silent", limit: "WATCH_SILENT_MIN", clock: true, applies: () => true, measure: (a) => a.lastWriteMs },
  {
    flag: "no-edit",
    limit: "WATCH_NO_EDIT_MIN",
    clock: true,
    applies: (a) => a.recs !== null && EDIT_BEARING.has(bareType(a.agentType) ?? ""),
    measure: (_a, s) => (s === null || s.startMs === null ? null : Math.max(s.startMs, s.lastEditMs ?? s.startMs)),
  },
  { flag: "same-slice", limit: "WATCH_SAME_SLICE_READS", clock: false, applies: (a) => a.recs !== null, measure: (_a, s) => (s === null ? null : maxOf(s.reads)) },
  { flag: "same-refusal", limit: "WATCH_SAME_REFUSAL", clock: false, applies: (a) => a.recs !== null, measure: (_a, s) => (s === null ? null : maxOf(s.refusals)) },
  { flag: "compactions", limit: "WATCH_COMPACTIONS", clock: false, applies: (a) => a.recs !== null, measure: (_a, s) => (s === null ? null : s.compactions) },
  {
    flag: "off-part",
    limit: "WATCH_OFF_PART_FILES",
    clock: false,
    applies: (a) => a.recs !== null && a.partFiles !== undefined,
    measure: (a, s) => (s === null || a.partFiles === undefined ? null : offPartCount(s.edited, a.partFiles)),
  },
];

export const FLAG_NAMES: readonly FlagName[] = FLAG_RULES.map((r) => r.flag);

export interface Flag {
  agent: string;
  flag: FlagName;
  count: number;
  limit: number;
}

/** The flags one agent trips now. A count flag acked at `n` fires again at `n + limit`; an acked
 *  clock flag fires again a full limit after the later of the ack (the arming) and the last
 *  activity. */
export function evaluate(a: WatchedAgent, ctx: ScanContext): Flag[] {
  if (a.recs !== null && finishedState(a.recs) === "finished") return [];
  const stats = a.recs === null ? null : segmentStats(a.recs);
  const out: Flag[] = [];
  for (const rule of FLAG_RULES) {
    if (!rule.applies(a)) continue;
    const m = rule.measure(a, stats);
    if (m === null) continue;
    const limit = ctx.limits[rule.limit];
    const acked = ctx.acks.get(`${a.name}:${rule.flag}`);
    let count: number;
    let fires: boolean;
    if (rule.clock) {
      count = Math.floor((ctx.nowMs - m) / 60_000);
      const from = acked === undefined ? m : Math.max(m, ctx.armedAtMs);
      fires = ctx.nowMs - from >= limit * 60_000;
    } else {
      count = m;
      fires = count >= (acked ?? 0) + limit;
    }
    if (fires) out.push({ agent: a.name, flag: rule.flag, count, limit });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The look

function clip(s: string, tail: boolean, max = TARGET_CHARS): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return tail ? `…${one.slice(one.length - max + 1)}` : `${one.slice(0, max - 1)}…`;
}

/** A leading `cd <dir> &&` (or `;`) says nothing in 60 characters; the look shows what follows. */
const LEADING_CD = /^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/;

/** `<tool> <target>`: a command from its head (past a leading `cd`), a path from its tail. */
export function describeCall(c: Pick<ToolCall, "tool" | "input">): string {
  const i = c.input;
  const path = i.file_path ?? i.notebook_path;
  if (typeof path === "string") {
    const slice = c.tool === "Read" && (i.offset !== undefined || i.limit !== undefined) ? `@${String(i.offset ?? "")}:${String(i.limit ?? "")}` : "";
    return `${c.tool} ${clip(path + slice, true)}`;
  }
  if (typeof i.command === "string") return `${c.tool} ${clip(i.command.replace(LEADING_CD, "") || i.command, false)}`;
  const v = i.pattern ?? i.description ?? i.skill ?? i.url ?? i.query ?? i.prompt;
  return `${c.tool} ${clip(typeof v === "string" ? v : JSON.stringify(i), false)}`;
}

/** The last `n` tool calls of the whole transcript, oldest first, one indented line each. */
function lastCallLines(recs: readonly Json[], n: number): string[] {
  return toolCalls(recs).slice(-n).map((c) => `  ${describeCall(c)}`);
}

/** The lines the session reads instead of the transcript: each flag, the last 8 calls, the ack. */
export function formatFlags(a: WatchedAgent, flags: readonly Flag[], codexLogTail: readonly string[] = []): string[] {
  const lines = flags.map((f) => `FLAG ${f.agent} ${f.flag} count=${f.count} limit=${f.limit}`);
  lines.push(`LAST ${a.name}`);
  if (a.recs === null) for (const l of codexLogTail) lines.push(`  log ${clip(l, false)}`);
  else lines.push(...lastCallLines(a.recs, LAST_CALLS));
  for (const f of flags) lines.push(`ack: --ack ${f.agent}:${f.flag}:${f.count}`);
  return lines;
}

/** `<agent>:<flag>:<count>`; the agent may itself hold a colon. */
export function parseAck(s: string): { key: string; count: number } {
  const m = /^(.+):([a-z-]+):(\d+)$/.exec(s);
  if (m === null || !(FLAG_NAMES as readonly string[]).includes(m[2]!))
    throw new Error(`--ack wants <agent>:<flag>:<count> with a flag of ${FLAG_NAMES.join(", ")}; got ${s}`);
  return { key: `${m[1]}:${m[2]}`, count: Number(m[3]) };
}

// ---------------------------------------------------------------------------------------------
// CLI

function agentTypeBeside(transcript: string): string | null {
  const meta = join(dirname(transcript), `${basename(transcript).replace(/\.jsonl$/, "")}.meta.json`);
  if (!existsSync(meta)) return null;
  try {
    const t = (JSON.parse(readFileSync(meta, "utf8")) as Json).agentType;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

function mtimeMs(path: string, fallback: number): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return fallback;
  }
}

function logTail(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").slice(-LAST_CALLS);
  } catch {
    return ["(no log yet)"];
  }
}

function takeAll(argv: string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) {
      rest.push(argv[i]!);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.push(v);
    i++;
  }
  return { values, rest };
}

function namedPath(s: string, flag: string): { name: string; path: string } {
  const at = s.indexOf("=");
  if (at <= 0 || at === s.length - 1) throw new Error(`${flag} wants <name>=<path>; got ${s}`);
  return { name: s.slice(0, at), path: s.slice(at + 1) };
}

/** A `--part-files` file: one entry per line, blank lines skipped. */
function readPartFiles(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

async function scan(argv: string[], out: (l: string) => void): Promise<number> {
  assertKnownFlags(argv, ["--repo", "--armed-at", "--ack", "--agent", "--codex", "--part-files"]);
  const acks = takeAll(argv, "--ack");
  const agents = takeAll(acks.rest, "--agent");
  const codex = takeAll(agents.rest, "--codex");
  const parts = takeAll(codex.rest, "--part-files");
  const repo = takeAll(parts.rest, "--repo");
  const armed = takeAll(repo.rest, "--armed-at");
  if (armed.rest.length > 0) throw new Error(`unexpected argument(s): ${armed.rest.join(" ")}`);
  const armedAt = armed.values.length > 0 ? Number(armed.values.at(-1)) : NaN;
  const nowMs = Date.now();
  const ctx: ScanContext = {
    nowMs,
    armedAtMs: Number.isFinite(armedAt) ? armedAt * 1000 : nowMs,
    limits: (await loadThresholds(resolve(repo.values.at(-1) ?? "."))).values,
    acks: new Map(acks.values.map((s) => parseAck(s)).map((a) => [a.key, a.count])),
  };
  const partFiles = new Map<string, string[]>();
  for (const spec of parts.values) {
    const { name, path } = namedPath(spec, "--part-files");
    partFiles.set(name, readPartFiles(path));
  }
  const agentNames = new Set(agents.values.map((spec) => namedPath(spec, "--agent").name));
  for (const name of partFiles.keys()) if (!agentNames.has(name)) throw new Error(`--part-files names no --agent: ${name}`);
  let flagged = false;
  for (const spec of agents.values) {
    const { name, path } = namedPath(spec, "--agent");
    const own = partFiles.get(name);
    const a: WatchedAgent = {
      name,
      agentType: agentTypeBeside(path),
      recs: parseLines(readFileSync(path, "utf8")),
      lastWriteMs: mtimeMs(path, ctx.armedAtMs),
      ...(own === undefined ? {} : { partFiles: own }),
    };
    const flags = evaluate(a, ctx);
    if (flags.length > 0) {
      flagged = true;
      for (const l of formatFlags(a, flags)) out(l);
    }
  }
  for (const spec of codex.values) {
    const { name, path } = namedPath(spec, "--codex");
    // A log not written yet counts from the arming, so a run that never starts still goes silent.
    const a: WatchedAgent = { name, agentType: null, recs: null, lastWriteMs: mtimeMs(path, ctx.armedAtMs) };
    const flags = evaluate(a, ctx);
    if (flags.length > 0) {
      flagged = true;
      for (const l of formatFlags(a, flags, logTail(path))) out(l);
    }
  }
  return flagged ? 3 : 0;
}

/** A task `.output` path is a symlink to the transcript; a transcript path resolves to itself
 *  (`agent-watchdog.sh` reads the link the same way). */
function resolveTranscript(path: string): string {
  try {
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return path;
  }
}

/** `42s`, `7m`, or `3h`. */
function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** The last assistant record that holds text, as one clipped line; null when none does. */
function lastSaid(recs: readonly Json[]): string | null {
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i]!;
    if (rec.type !== "assistant") continue;
    const said = clip(textOf(message(rec).content), false, SAID_CHARS);
    if (said !== "") return said;
  }
  return null;
}

/** `last <path> [--calls <n>]`: what the agent is doing now, in at most n + 3 short lines. */
function last(argv: string[], out: (l: string) => void): number {
  assertKnownFlags(argv, ["--calls"]);
  const calls = takeAll(argv, "--calls");
  if (calls.values.length > 1 || calls.rest.length !== 1) throw new Error("last wants <path> [--calls <n>]");
  const raw = calls.values[0];
  const n = raw === undefined ? LAST_CALLS : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= MAX_LAST_CALLS)) throw new Error(`--calls wants a whole number from 1 to ${MAX_LAST_CALLS}; got ${raw}`);
  const path = resolveTranscript(calls.rest[0]!);
  const name = basename(path).replace(/^agent-/, "").replace(/\.jsonl$/, "");
  const state = readFinished(path);
  let recs: Json[] | null = null;
  try {
    if (state !== "missing") recs = parseLines(readFileSync(path, "utf8"));
  } catch {
    // the file went away between the two reads: report it missing
  }
  if (recs === null) {
    out(`AGENT ${name} missing`);
    return 0;
  }
  out(`AGENT ${name} ${state} · ${recs.length} records · last write ${formatAge(Date.now() - mtimeMs(path, Date.now()))} ago`);
  out("LAST");
  const lines = lastCallLines(recs, n);
  for (const l of lines.length > 0 ? lines : ["  (no tool calls yet)"]) out(l);
  const said = lastSaid(recs);
  if (said !== null) out(`SAID ${said}`);
  return 0;
}

const USAGE =
  "usage: watchScan.ts state <transcript> | last <path> [--calls <n>] | scan [--repo <dir>] [--armed-at <s>] [--ack <a>:<flag>:<n>]… [--agent <name>=<path>]… [--codex <name>=<log>]… [--part-files <name>=<file>]…";

export async function main(argv: string[], exit: (code: number) => void = exitWhenFlushed): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "state" && rest.length === 1) {
      console.log(readFinished(rest[0]!));
      exit(0);
      return;
    }
    if (cmd === "last") {
      exit(last(rest, (l) => console.log(l)));
      return;
    }
    if (cmd === "scan") {
      exit(await scan(rest, (l) => console.log(l)));
      return;
    }
    console.error(USAGE);
  } catch (e) {
    console.error(`watchScan: ${(e as Error).message}`);
  }
  exit(2);
}

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2));
}
