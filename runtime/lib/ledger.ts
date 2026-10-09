/**
 * The ship ledger (`<run-dir>/ship.md`) — its grammar, and the one parser every reader of it
 * imports (the gate, the table script, the stage plan, telemetry, the merge check). The session
 * writes it; nothing else re-parses it. Pure: no fs, no git — callers pass the text.
 *
 * One `<move>: <segments>` line per move, split on `|`. A `key=value` segment is a field; any other
 * segment is free text. `class:` is the first line and `flow: 2` the second. After the class line,
 * a line that is not shaped like a move is prose and is skipped; a line shaped like a move is a
 * claim, so an unknown move, a malformed field, or a repeated move throws — a claim nobody can read
 * must never pass. A build has at most one drift group (`drift-read:`, then `drift-fix:`, then
 * `drift-confirm:`, in that order); a later move of main is a `drift-merge: | from= | sha=` line,
 * written only after the group's lines and never followed by one, which may repeat since main can
 * move again during the checks. `leftovers:` (the last count stands), `verifier:` (the last line
 * stands), `banked:` (the ids add up), and `answered:` (one decision row the session answered itself,
 * and the `SESSION` block that carries the answer into the next round) may repeat too. A banked run
 * the operator answered resumes
 * with one `unbank:` line (the banked ids its fix answers) and one `unbank-read:` line (the one
 * cursory read of that fix). Past the first two lines, inside the drift
 * group, and around its `drift-merge:` lines, order carries no meaning: every reader reads a move by
 * name, so a `banked:`, `verifier:`, or `hand-test-<n>:` line written after `ship:` reads the same as
 * one before it.
 */

import { basename } from "node:path";

import {
  parseClassLine,
  parseWaveLine,
  retiredClassReason,
  type RiskClass,
  STAGE_READER_NAMES,
  type StageReaderName,
} from "./riskClass.ts";
import { isFindingId } from "./runFiles.ts";

/** The refusal for a ledger the old flow wrote (no `flow: 2`). Telemetry refuses an old run dir
 *  with the same words. */
export const FLOW_CHANGED =
  "the build flow changed; re-read ~/.agent-build/skills/build/CLOSE.md and restart the review from the wave";

/** Every legal move name. `hand-test-<n>` stands for `hand-test-1`, `hand-test-2`, … */
export const LEDGER_MOVES = [
  "class",
  "flow",
  "brief",
  "from-branch",
  "hand-test-block",
  "steps",
  "build",
  "freshen",
  "wave",
  "verifier",
  "fix-1",
  "fix-2",
  "fix-3",
  "confirm-1",
  "confirm-2",
  "last-read",
  "escalate",
  "escalate-read",
  "drift-read",
  "drift-fix",
  "drift-confirm",
  "drift-merge",
  "hand-test-<n>",
  "leftovers",
  "banked",
  "answered",
  "unbank",
  "unbank-read",
  "ship",
] as const;

export type LedgerMove = (typeof LEDGER_MOVES)[number];

/** The moves that record a fix round: `<fixed>/<rows> | model= | agent= | from= | sha=`. */
export const FIX_MOVES = ["fix-1", "fix-2", "fix-3", "escalate", "drift-fix"] as const;
export type FixMove = (typeof FIX_MOVES)[number];

/** The moves that record a stage read, and the stage folder each one's reader files live in. A drift
 *  group's reads live in `stage-drift-<n>/` and `stage-drift-confirm-<n>/` (`readMoveFolder`). */
export const READ_MOVE_FOLDER = {
  "confirm-1": "stage-confirm-1",
  "confirm-2": "stage-confirm-2",
  "last-read": "stage-last",
  "escalate-read": "stage-escalate",
  "drift-read": "stage-drift-<n>",
  "drift-confirm": "stage-drift-confirm-<n>",
  "unbank-read": "unbank",
} as const;
export type ReadMove = keyof typeof READ_MOVE_FOLDER;

/** A read move's folder; a drift move's needs its group. */
export function readMoveFolder(move: ReadMove, group: number | null = null): string {
  const folder: string = READ_MOVE_FOLDER[move];
  if (!folder.endsWith("<n>")) return folder;
  if (group === null) throw new Error(`${move}: its folder needs the drift group`);
  return folder.replace("<n>", String(group));
}

export const LEDGER_KEYS = [
  "sha",
  "from",
  "model",
  "agent",
  "rows",
  "files",
  "by",
  "measured-at",
  "base",
  "parts",
  "branch",
  "started",
  "scope",
] as const;
export type LedgerKey = (typeof LEDGER_KEYS)[number];

/** One move line: its free-text segments and its fields, in the order written. */
export interface LedgerLine {
  text: string[];
  fields: Partial<Record<LedgerKey, string>>;
}

export type FixModel = "opus" | "sonnet";

export interface FixLine {
  fixed: number;
  rows: number;
  model: FixModel;
  /** Agent tool ids; two when the watch stopped the first fixer and a second finished the round. */
  agents: string[];
  /** Session HEAD before the fixer's branch merged. */
  from: string;
  /** Session HEAD after. */
  sha: string;
}

/** A read line's reader token. `review-cursory (codex failed: <why>)` is the Sonnet read that
 *  stood in for a failed Codex run: `reader` is `review-cursory`, `codexFailed` is `<why>`. */
export interface ReadToken {
  reader: StageReaderName;
  codexFailed: string | null;
}

export interface ReadLine {
  readers: ReadToken[];
  sha: string;
  /** `drift-read:` only: the head before main was merged (the merge-side patch starts here). */
  from: string | null;
  /** `drift-read:` only: the files main changed under the branch. */
  files: number | null;
}

export type HandTestLine =
  | { n: number; skipped: false; pass: number; ran: number; sha: string }
  | { n: 1; skipped: true };

/** One drift group: a drift read, then the fix of its round and that fix's confirm when owed. */
export interface DriftGroup {
  read: ReadLine;
  fix: FixLine | null;
  confirm: ReadLine | null;
}

/** The moves of a drift group, in the order a group writes them. */
export const DRIFT_MOVES = ["drift-read", "drift-fix", "drift-confirm"] as const;
type DriftMove = (typeof DRIFT_MOVES)[number];

/** A merge of main after the drift group: the head before the merge and the head after it. */
export interface DriftMerge {
  from: string;
  sha: string;
}

const ONE_DRIFT_GROUP = "one drift group per build — a later move of main is `drift-merge: | from=<head before the merge> | sha=<head after it>`";

/** `unbank: <ids> | from= | sha= [| model= | agent=]`: the banked ids the operator answered, the head
 *  the run banked at, and the head after their fix; `model` and `agents` when a fixer made it. */
export interface UnbankLine {
  ids: string[];
  from: string;
  sha: string;
  model: FixModel | null;
  agents: string[];
}

export type VerifierLine =
  | { verdict: "CLEAN"; sha: string }
  | { verdict: "CLEARED"; handTest: number; claim: string; sha: string }
  | { verdict: "N/A" };

/** One entry of `build: … | parts=`: a part, the model it ran on, and its builder's agent ids
 *  (`[]` for `none`, which a `session` part writes). */
export interface BuildPart {
  part: string;
  model: FixModel | "session";
  agents: string[];
}

export interface Ledger {
  cls: RiskClass;
  /** False for the form the agent pins, `class: R<n> — agent (unconfirmed), <date>`; true once the operator set it. */
  pinned: boolean;
  /** The head at the end of freshen — the commit the size line was measured at. */
  measuredAt: string | null;
  /** The value as written: a repo-relative path, or `store:<path>` in the store dir. Only
   *  `briefLocation` (`repoId.ts`) reads the prefix. */
  brief: string | null;
  fromBranch: string | null;
  /** As `brief`. */
  handTestBlock: string | null;
  /** `parts` is set only when the line has `parts=`; the gate checks it against the brief's parts. */
  build: { model: FixModel | "session"; agents: string[]; sha: string; parts?: BuildPart[] } | null;
  /** The run's base, from `freshen:`'s `base=`. A script's `--base` flag only overrides it. */
  base: string | null;
  /** The run's branch, from `freshen:`'s `branch=`; null on a ledger written without it. */
  branch: string | null;
  /** The reader names before the `wave:` line's first `|`. `[]` when absent. */
  waveReaders: string[];
  /** The repo readers its `repo:` segment names (`parseWaveLine`). `[]` when absent. */
  waveRepoReaders: string[];
  verifier: VerifierLine | null;
  /** Each fix move's line, except `drift-fix`: a drift group's lines are in `driftGroups` only. */
  fixes: Map<Exclude<FixMove, "drift-fix">, FixLine>;
  /** Each read move's line, except `drift-read` and `drift-confirm` (in `driftGroups`). */
  reads: Map<Exclude<ReadMove, "drift-read" | "drift-confirm" | "unbank-read">, ReadLine>;
  /** The drift group, when one ran: at most one entry (group `n` is `driftGroups[n - 1]`, so `n` is
   *  always 1). The gate judges it. */
  driftGroups: DriftGroup[];
  /** Every `drift-merge:` line after the drift group, in the order written. */
  driftMerges: DriftMerge[];
  /** Ascending by `n`. */
  handTests: HandTestLine[];
  /** The last `leftovers:` line: a drift group's re-built final writes a new count after the first.
   *  `scope` is the plan or session whose standing ticket it is; CLOSE step 13 looks the ticket up by it.
   *  It is null on a line written before `scope=` existed: ledgerLine.ts writes no new line without it. */
  leftovers: { to: string; rows: number; scope: string | null } | null;
  /** Finding ids from every `banked:` line, in order — present means the run ended banked. A
   *  parenthetical (`(awaiting operator)`) is not an id. */
  banked: string[];
  /** Every `answered:` line: a fixer's decision row the session answered itself, and the `SESSION`
   *  block that carries the answer into the next fix round. */
  answered: { id: string; by: string }[];
  /** The one `unbank:` line, when the operator answered the banked run. */
  unbank: UnbankLine | null;
  /** The one cursory read of the unbank fix. */
  unbankRead: ReadLine | null;
  /** Every move line after the class line, by move name (`hand-test-2`, not `hand-test-<n>`); for a
   *  move that may repeat (`drift-merge`, `leftovers`, `banked`, `answered`, `verifier`) the last line written. */
  lines: Map<string, LedgerLine>;
}

const SHA = /^[0-9a-f]{7,40}$/i;
const MOVE_LINE = /^([a-z][a-z0-9-]*):\s*(.*)$/;
const FIELD = /^([a-z][a-z-]*)=(.*)$/;
const HAND_TEST_MOVE = /^hand-test-([1-9]\d*)$/;
const RETIRED_STEP_LINE = /^step\s+\d+\s*:/i;
const PINNED_CLASS_FIELDS = /^—\s+\S.*,\s*\d{4}-\d{2}-\d{2}/;
// The second arm reads a ledger pinned before the one dated form (lib/brief.ts PINNED_CLASS_LINE_RE).
const UNCONFIRMED_CLASS_FIELDS = /^—\s+agent \(unconfirmed\),|\(agent, unconfirmed\)/;
const COUNT_PAIR = /^(\d+)\/(\d+)$/;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
const CODEX_FAILED = /^review-cursory \(codex failed: ([^,|]*\S[^,|]*)\)$/;
const VERIFIER_BY = /^hand-test-([1-9]\d*):(H[1-9]\d*)$/;
const LEFTOVERS_TO = /^([A-Z][A-Z0-9]*-\d+|pr-body)$/;
const LEFTOVERS_SCOPE = /^(session-[0-9a-f]{8}|plan-[A-Za-z0-9._-]+)$/;
const HAND_TEST_SKIPPED = /^skipped\s+[—-]+\s+no claims$/;
const FROM_BRANCH_VERIFIER = "N/A (from-branch, no brief)";
const BUILD_PART = /^(P[1-9]\d*):(opus|sonnet|session):(none|[A-Za-z0-9_-]+(?:\+[A-Za-z0-9_-]+)*)$/;

/** The move a line name is, or null. `hand-test-3` is `hand-test-<n>`. */
export function ledgerMoveOf(name: string): LedgerMove | null {
  if (HAND_TEST_MOVE.test(name)) return "hand-test-<n>";
  return (LEDGER_MOVES as readonly string[]).includes(name) && name !== "hand-test-<n>"
    ? (name as LedgerMove)
    : null;
}

/** Which keys each move takes: `need` must be present, `may` may be. Any other key throws. */
const KEYS: Record<Exclude<LedgerMove, "class" | "banked">, { need: LedgerKey[]; may?: LedgerKey[] }> =
  {
    flow: { need: [] },
    brief: { need: [] },
    "from-branch": { need: [] },
    "hand-test-block": { need: [] },
    steps: { need: [] },
    // `started=` is read by nothing: kept so an older ledger that carries it still parses.
    build: { need: ["model", "agent", "sha"], may: ["parts", "started"] },
    freshen: { need: ["base", "sha"], may: ["branch"] },
    wave: { need: ["sha"] },
    verifier: { need: [], may: ["by", "sha"] },
    "fix-1": { need: ["model", "agent", "from", "sha"] },
    "fix-2": { need: ["model", "agent", "from", "sha"] },
    "fix-3": { need: ["model", "agent", "from", "sha"] },
    escalate: { need: ["model", "agent", "from", "sha"] },
    "drift-fix": { need: ["model", "agent", "from", "sha"] },
    "confirm-1": { need: ["sha"] },
    "confirm-2": { need: ["sha"] },
    "last-read": { need: ["sha"] },
    "escalate-read": { need: ["sha"] },
    "drift-read": { need: ["from", "files", "sha"] },
    "drift-confirm": { need: ["sha"] },
    "drift-merge": { need: ["from", "sha"] },
    answered: { need: ["by"] },
    unbank: { need: ["from", "sha"], may: ["model", "agent"] },
    "unbank-read": { need: ["sha"] },
    "hand-test-<n>": { need: [], may: ["sha"] },
    leftovers: { need: ["rows"], may: ["scope"] },
    ship: { need: ["sha"] },
  };

function fail(move: string, what: string): never {
  throw new Error(`\`${move}:\` ${what}`);
}

/** Splits a move's body into text and fields, and checks each field's key and value shape. */
function splitLine(move: string, kind: Exclude<LedgerMove, "class" | "banked">, body: string): LedgerLine {
  const text: string[] = [];
  const fields: Partial<Record<LedgerKey, string>> = {};
  for (const segment of body.split("|").map((s) => s.trim())) {
    const m = FIELD.exec(segment);
    if (!m) {
      if (segment.length > 0) text.push(segment);
      continue;
    }
    const key = m[1]!;
    const value = m[2]!;
    const { need, may = [] } = KEYS[kind];
    if (![...need, ...may].includes(key as LedgerKey)) {
      fail(move, `takes no \`${key}=\` field — it takes ${[...need, ...may].map((k) => `${k}=`).join(", ") || "no fields"}`);
    }
    if (Object.hasOwn(fields, key)) fail(move, `has two \`${key}=\` fields`);
    if (value.length === 0) fail(move, `\`${key}=\` is empty`);
    if (/\s/.test(value)) fail(move, `\`${key}=${value}\` holds a space`);
    if ((key === "sha" || key === "from" || key === "measured-at") && !SHA.test(value)) {
      fail(move, `${key}=${value} is not a git sha`);
    }
    if ((key === "rows" || key === "files") && !/^\d+$/.test(value)) {
      fail(move, `${key}=${value} is not a count`);
    }
    fields[key as LedgerKey] = value;
  }
  for (const key of KEYS[kind].need) {
    if (!Object.hasOwn(fields, key)) fail(move, `needs a \`${key}=\` field`);
  }
  return { text, fields };
}

function oneText(move: string, line: LedgerLine, form: string): string {
  if (line.text.length !== 1) fail(move, `takes one value — write \`${move}: ${form}\``);
  return line.text[0]!;
}

function agentsOf(move: string, value: string, allowNone: boolean): string[] {
  if (value === "none") {
    if (!allowNone) fail(move, "agent=none is legal only on `build:` — a floor check, or a branch built before this run");
    return [];
  }
  const ids = value.split(",");
  if (!ids.every((id) => AGENT_ID.test(id))) fail(move, `agent=${value} is not \`<id>[,<id>]\``);
  return ids;
}

/** `parts=P1:sonnet:<id>,P2:opus:<id>+<id>,P3:session:none`, the grammar only. Whether it matches
 *  the brief's parts and `agent=` is a gate fact (`owed.ts`), so each mismatch is one gate line. */
function buildPartsOf(value: string): BuildPart[] {
  const parts: BuildPart[] = [];
  for (const entry of value.split(",")) {
    const m = BUILD_PART.exec(entry);
    if (!m) {
      fail("build", `parts= entry \`${entry}\` is not \`<part>:<opus|sonnet|session>:<agent ids joined by +, or none>\``);
    }
    if (parts.some((p) => p.part === m[1])) fail("build", `parts= names ${m[1]} twice`);
    parts.push({ part: m[1]!, model: m[2] as BuildPart["model"], agents: m[3] === "none" ? [] : m[3]!.split("+") });
  }
  return parts;
}

/**
 * The branch check (§1.4): the run's scripts read HEAD from the cwd, so a tree on another branch
 * reads another run's code. Null when the tree is on the run's branch, or when the ledger names no
 * `branch=` (a run in flight at the cutover goes unchecked). `headBranch` is
 * `git rev-parse --abbrev-ref HEAD` from the cwd (`HEAD` when detached); the run id is the run
 * dir's name after `build-`.
 */
export function runBranchError(ledger: Ledger, headBranch: string, runDir: string): string | null {
  if (ledger.branch === null || ledger.branch === headBranch) return null;
  const runId = basename(runDir).replace(/^build-/, "");
  return `run ${runId} is on ${ledger.branch}; this tree is on ${headBranch} — enter the run's tree first`;
}

function fixLineOf(move: FixMove, line: LedgerLine): FixLine {
  const counts = COUNT_PAIR.exec(oneText(move, line, "<fixed>/<rows> | model= | agent= | from= | sha="));
  if (!counts) fail(move, `\`${line.text[0]}\` is not \`<fixed>/<rows>\``);
  const fixed = Number(counts[1]);
  const rows = Number(counts[2]);
  if (fixed > rows) fail(move, `fixed ${fixed} is more than its ${rows} rows`);
  const model = line.fields.model!;
  if (model !== "opus" && model !== "sonnet") fail(move, `model=${model} — a fixer runs on opus or sonnet`);
  return {
    fixed,
    rows,
    model,
    agents: agentsOf(move, line.fields.agent!, false),
    from: line.fields.from!,
    sha: line.fields.sha!,
  };
}

/** A read line's reader list: split on `,` only, since the Codex stand-in token holds spaces. */
function readersOf(move: ReadMove, list: string): ReadToken[] {
  const tokens: ReadToken[] = [];
  for (const raw of list.split(",").map((s) => s.trim())) {
    const failed = CODEX_FAILED.exec(raw);
    if (failed) {
      tokens.push({ reader: "review-cursory", codexFailed: failed[1]!.trim() });
      continue;
    }
    if (!(STAGE_READER_NAMES as readonly string[]).includes(raw)) {
      fail(
        move,
        `\`${raw}\` is not a reader — write one of ${STAGE_READER_NAMES.join(", ")}, or \`review-cursory (codex failed: <why>)\` with no \`,\` or \`|\` in <why> (write \`;\`)`
      );
    }
    tokens.push({ reader: raw as StageReaderName, codexFailed: null });
  }
  const names = tokens.map((t) => (t.codexFailed === null ? t.reader : `${t.reader} (codex failed)`));
  if (new Set(names).size !== names.length) fail(move, "names one reader twice");
  // The drift read and the unbank read are one cursory read each: security-review reads a fix at
  // `confirm-1` and `confirm-2` only.
  if ((move === "drift-read" || move === "unbank-read") && (tokens.length !== 1 || tokens[0]!.reader !== "review-cursory")) {
    fail(move, "reads with `review-cursory` only");
  }
  return tokens;
}

function readLineOf(move: ReadMove, line: LedgerLine): ReadLine {
  const list = oneText(move, line, "<reader>[, <reader>…] | sha=<head>");
  return {
    readers: readersOf(move, list),
    sha: line.fields.sha!,
    from: line.fields.from ?? null,
    files: line.fields.files === undefined ? null : Number(line.fields.files),
  };
}

function handTestOf(move: string, n: number, line: LedgerLine): HandTestLine {
  const value = oneText(move, line, "<pass>/<ran> | sha=<head tested>");
  if (HAND_TEST_SKIPPED.test(value)) {
    if (n !== 1) fail(move, "only `hand-test-1` may say `skipped — no claims`");
    if (line.fields.sha !== undefined) fail(move, "a skipped hand test tested no head — drop `sha=`");
    return { n: 1, skipped: true };
  }
  const counts = COUNT_PAIR.exec(value);
  if (!counts) fail(move, `\`${value}\` is neither \`<pass>/<ran>\` nor \`skipped — no claims\``);
  const pass = Number(counts[1]);
  const ran = Number(counts[2]);
  if (pass > ran) fail(move, `pass ${pass} is more than the ${ran} it ran`);
  if (line.fields.sha === undefined) fail(move, "needs a `sha=` field — the head it tested");
  return { n, skipped: false, pass, ran, sha: line.fields.sha };
}

function verifierOf(line: LedgerLine): VerifierLine {
  const value = oneText("verifier", line, "CLEAN | sha=<head>");
  const { by, sha } = line.fields;
  if (value === FROM_BRANCH_VERIFIER) {
    if (by !== undefined || sha !== undefined) fail("verifier", `\`${FROM_BRANCH_VERIFIER}\` takes no fields`);
    return { verdict: "N/A" };
  }
  if (sha === undefined) fail("verifier", "needs a `sha=` field");
  if (value === "CLEAN") {
    if (by !== undefined) fail("verifier", "`CLEAN` takes no `by=` — only `CLEARED` does");
    return { verdict: "CLEAN", sha };
  }
  if (value === "CLEARED") {
    const m = VERIFIER_BY.exec(by ?? "");
    if (!m) fail("verifier", "`CLEARED` needs `by=hand-test-<n>:H<k>`");
    return { verdict: "CLEARED", handTest: Number(m[1]), claim: m[2]!, sha };
  }
  return fail(
    "verifier",
    `\`${value}\` is not a verdict — write \`CLEAN | sha=\`, \`CLEARED | by=hand-test-<n>:H<k> | sha=\`, or \`${FROM_BRANCH_VERIFIER}\``
  );
}

function unbankOf(line: LedgerLine): UnbankLine {
  const ids = oneText("unbank", line, "<id>[, <id>…] | from=<head it banked at> | sha=<head after the fix>")
    .split(",")
    .map((s) => s.trim());
  const bad = ids.find((id) => !isFindingId(id));
  if (bad !== undefined) fail("unbank", `\`${bad}\` is not a finding id — name the banked ids, \`CURSORY.3, HAND.2\``);
  const { model, agent } = line.fields;
  if ((model === undefined) !== (agent === undefined)) {
    fail("unbank", "names its fixer by both `model=` and `agent=`, or by neither when the session made the fix");
  }
  if (model !== undefined && model !== "opus" && model !== "sonnet") fail("unbank", `model=${model} — a fixer runs on opus or sonnet`);
  return {
    ids,
    from: line.fields.from!,
    sha: line.fields.sha!,
    model: model === undefined ? null : (model as FixModel),
    agents: agent === undefined ? [] : agentsOf("unbank", agent, false),
  };
}

function rowsOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s+/, ""))
    .filter((l) => l.length > 0);
}

function isDriftMove(name: string): name is DriftMove {
  return (DRIFT_MOVES as readonly string[]).includes(name);
}

/** Moves a run may write again: a drift group's re-built final writes a new `leftovers:` count, a
 *  later bank adds its ids (`banked:` collects every line's), a later read that owed the verifier
 *  writes its `verifier:` line again (the last one counts), and main may move again during the
 *  checks after each `drift-merge:` (every line is kept). */
const REPEATABLE = new Set(["leftovers", "banked", "answered", "verifier", "drift-merge"]);

/**
 * Checks a drift move's place: one group per build, read then fix then confirm, all before any
 * `drift-merge:`. Whether the fix and confirm were owed is a gate fact (`owed.ts`), which reports a
 * missing one.
 */
function driftOrder(ledger: Ledger, move: DriftMove): void {
  const group = ledger.driftGroups.at(-1);
  if (group !== undefined && ledger.driftMerges.length > 0) {
    fail(move, `follows a \`drift-merge:\` — ${ONE_DRIFT_GROUP}, written after the drift group completes`);
  }
  if (move === "drift-read") {
    if (group !== undefined) fail(move, `a second drift read — ${ONE_DRIFT_GROUP}`);
    return;
  }
  if (group === undefined) fail(move, "comes before any `drift-read:` — a drift group starts with its read");
  if (group.confirm !== null) {
    fail(move, `follows its group's \`drift-confirm:\` — a drift group is read, fix, confirm, once per build`);
  }
  if (move === "drift-fix" && group.fix !== null) {
    fail(move, "two `drift-fix:` lines in the drift group — it has one fix round");
  }
  if (move === "drift-confirm" && group.fix === null) {
    fail(move, "has no `drift-fix:` in its group — the confirm reads the drift fix");
  }
}

/** Parses a ledger. Throws with the line's fix on anything it cannot read. */
export function parseLedger(text: string): Ledger {
  const rows = rowsOf(text);
  if (rows.length === 0) {
    throw new Error(
      "ledger is empty — the first line is `class: R<n> — <who>, <date> | measured-at=<sha>`, the second `flow: 2`"
    );
  }
  for (const row of rows) {
    if (RETIRED_STEP_LINE.test(row)) {
      throw new Error(
        `\`${row}\` is the retired /close-out grammar — the ship ledger is one \`<move>: <fields> | sha=<sha>\` line per move (/build §SHIP)`
      );
    }
  }
  const head = parseClassLine(rows[0]!);
  if (!head) {
    const retired = retiredClassReason(rows[0]!);
    if (retired !== null) throw new Error(retired);
    throw new Error(`first line must be \`class: R<n> — <who>, <date>\`, got \`${rows[0]}\``);
  }
  const [classFields = "", ...classKv] = head.rest.split("|").map((s) => s.trim());
  const pinned = !UNCONFIRMED_CLASS_FIELDS.test(classFields);
  if (pinned && !PINNED_CLASS_FIELDS.test(classFields)) {
    throw new Error(
      `class line is not pinned — write \`class: ${head.cls} — <who>, <YYYY-MM-DD>\` (\`— agent (unconfirmed), <YYYY-MM-DD>\` when the agent picked it)`
    );
  }
  const measuredAt =
    classKv.find((s) => s.startsWith("measured-at="))?.slice("measured-at=".length) ?? null;
  if (measuredAt !== null && !SHA.test(measuredAt)) {
    throw new Error(`class: measured-at=${measuredAt} is not a git sha`);
  }
  if (!/^flow:\s*2$/.test(rows[1] ?? "")) {
    if (rows.some((r) => /^flow:\s*2$/.test(r))) throw new Error("`flow: 2` must be the ledger's second line");
    throw new Error(FLOW_CHANGED);
  }

  const ledger: Ledger = {
    cls: head.cls,
    pinned,
    measuredAt,
    brief: null,
    fromBranch: null,
    handTestBlock: null,
    build: null,
    base: null,
    branch: null,
    waveReaders: [],
    waveRepoReaders: [],
    verifier: null,
    fixes: new Map(),
    reads: new Map(),
    driftGroups: [],
    driftMerges: [],
    handTests: [],
    leftovers: null,
    banked: [],
    answered: [],
    unbank: null,
    unbankRead: null,
    lines: new Map(),
  };

  for (const row of rows.slice(1)) {
    const m = MOVE_LINE.exec(row);
    if (!m) continue;
    const name = m[1]!;
    const body = m[2]!;
    const move = ledgerMoveOf(name);
    if (move === null) {
      throw new Error(`\`${name}:\` is not a ledger move — the moves are ${LEDGER_MOVES.join(", ")}`);
    }
    if (move === "class") {
      throw new Error("a second `class:` line — the class is declared once and never re-asked");
    }
    if (!isDriftMove(name) && !REPEATABLE.has(name) && ledger.lines.has(name)) {
      throw new Error(`two \`${name}:\` lines — one line per move`);
    }
    if (move === "banked") {
      for (const id of body.replace(/\([^)]*\)/g, "").split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!ledger.banked.includes(id)) ledger.banked.push(id);
      }
      ledger.lines.set(name, { text: [body.trim()], fields: {} });
      continue;
    }
    const line = splitLine(name, move, body);
    ledger.lines.set(name, line);
    switch (move) {
      case "flow":
        break;
      case "brief":
        ledger.brief = oneText(name, line, "<repo-relative path, or store:briefs/<branch-slug>.md>");
        break;
      case "from-branch":
        ledger.fromBranch = oneText(name, line, "<branch>");
        break;
      case "hand-test-block":
        ledger.handTestBlock = oneText(name, line, "<repo-relative path, or store:<path in the store dir>>");
        break;
      case "steps":
        break;
      case "build": {
        const model = line.fields.model!;
        if (model !== "opus" && model !== "sonnet" && model !== "session") {
          fail(name, `model=${model} — write opus, sonnet, or session`);
        }
        // `agent=none` with a builder model: the run entered at CLOSE on a branch built before it.
        const agents = agentsOf(name, line.fields.agent!, true);
        if (model === "session" && agents.length > 0) {
          fail(name, "model=session had no builder agent — write agent=none");
        }
        ledger.build = { model, agents, sha: line.fields.sha! };
        if (line.fields.parts !== undefined) ledger.build.parts = buildPartsOf(line.fields.parts);
        break;
      }
      case "freshen":
        ledger.base = line.fields.base!;
        ledger.branch = line.fields.branch ?? null;
        break;
      case "wave": {
        const wave = parseWaveLine(line.text.join(" | "));
        ledger.waveReaders = wave.readers;
        ledger.waveRepoReaders = wave.repoReaders;
        break;
      }
      case "verifier":
        ledger.verifier = verifierOf(line);
        break;
      case "fix-1":
      case "fix-2":
      case "fix-3":
      case "escalate":
        ledger.fixes.set(move, fixLineOf(move, line));
        break;
      case "drift-fix": {
        const fix = fixLineOf(move, line);
        driftOrder(ledger, move);
        ledger.driftGroups.at(-1)!.fix = fix;
        break;
      }
      case "confirm-1":
      case "confirm-2":
      case "last-read":
      case "escalate-read":
        ledger.reads.set(move, readLineOf(move, line));
        break;
      case "drift-read": {
        const read = readLineOf(move, line);
        driftOrder(ledger, move);
        ledger.driftGroups.push({ read, fix: null, confirm: null });
        break;
      }
      case "drift-merge":
        if (line.text.length > 0) {
          fail(name, "names no reader and no agent — write `drift-merge: | from=<head before the merge> | sha=<head after it>`");
        }
        if (ledger.driftGroups.length === 0) {
          fail(name, "comes before any `drift-read:` — main's first move after the wave is the drift group; `drift-merge:` follows it");
        }
        ledger.driftMerges.push({ from: line.fields.from!, sha: line.fields.sha! });
        break;
      case "drift-confirm": {
        const read = readLineOf(move, line);
        driftOrder(ledger, move);
        ledger.driftGroups.at(-1)!.confirm = read;
        break;
      }
      case "hand-test-<n>":
        ledger.handTests.push(handTestOf(name, Number(HAND_TEST_MOVE.exec(name)![1]), line));
        break;
      case "leftovers": {
        const to = oneText(name, line, "<ticket id | pr-body> | rows=<n> | scope=<scope>");
        if (!LEFTOVERS_TO.test(to)) fail(name, `\`${to}\` is neither a ticket id (\`QRK-12\`) nor \`pr-body\``);
        const scope = line.fields.scope ?? null;
        if (scope !== null && !LEFTOVERS_SCOPE.test(scope)) {
          fail(name, `scope=${scope} is neither \`plan-<the plan's epic id>\` nor \`session-<first 8 characters of the session id>\``);
        }
        ledger.leftovers = { to, rows: Number(line.fields.rows), scope };
        break;
      }
      case "answered": {
        const id = oneText(name, line, "<id> | by=SESSION.<n>");
        if (!isFindingId(id)) fail(name, `\`${id}\` is not a finding id — one line per answered row, \`CURSORY.3 | by=SESSION.2\``);
        const by = line.fields.by!;
        if (!/^SESSION\.\d+$/.test(by)) fail(name, `by=${by} — the answer is a \`SESSION.<n>\` block in session.md`);
        ledger.answered.push({ id, by });
        break;
      }
      case "unbank":
        ledger.unbank = unbankOf(line);
        break;
      case "unbank-read":
        ledger.unbankRead = readLineOf(move, line);
        break;
      case "ship":
        oneText(name, line, "<pr-url> | sha=<head>");
        break;
    }
  }
  ledger.handTests.sort((a, b) => a.n - b.n);
  return ledger;
}
