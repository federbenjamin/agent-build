/**
 * reviewTable — the one writer of `<run-dir>/table.json`, `table-<round>.md`, and the leftovers list,
 * and the one checker of every file a reader, the fixer, the hand tester, or the session writes into
 * the run dir. It gathers files and hands them to `./lib/table.ts` and `./lib/runFiles.ts`, which
 * decide everything.
 *
 *   node ~/.agent-build/runtime/reviewTable.ts build --run-dir <d> --round <1|2|3|escalate|drift-<n>|final> [--head <sha>]
 *   node ~/.agent-build/runtime/reviewTable.ts check --file <path> --stage <stage> [--run-dir <d>]
 *   node ~/.agent-build/runtime/reviewTable.ts dispatch --run-dir <d> --stage <stage> --reader <name> --out <file>
 *   node ~/.agent-build/runtime/reviewTable.ts leftovers --run-dir <d> --run-id <id>
 *
 * Drift group `n` has its own round, `drift-<n>`, and its own stage folders, `stage-drift-<n>/` and
 * `stage-drift-confirm-<n>/`: `dispatch` takes `--stage drift-<n>` or `drift-confirm-<n>`.
 *
 * `check` validates one file against its grammar: `--stage wave` a wave reader file, a stage name a
 * stage file (`drift` or `drift-<n>`, `drift-confirm` or `drift-confirm-<n>`), `session`
 * `session.md`, `fix-<round>` a fix file, `hand-test` a hand-test file. With `--run-dir` it also
 * checks the file against the run: a stage file answers exactly the rows `dispatch` gave its reader, a
 * fix file has one line per row of its round, a hand-test file's output files exist. Prints `ok: <n>
 * findings` or `ok: <n> rows`, else one line per problem. Exit 0 valid · 1 invalid · 2 usage or
 * unreadable input.
 *
 * `dispatch` creates `<run-dir>/stage-<stage>/` and writes to `--out` the rows one reader must answer
 * at that stage, each with its texts and the fixer's line, and how to answer them. Exit 0 · 2 usage
 * or unreadable input.
 *
 * `build` writes that round's key of `table.json` (others kept) and, except for `final`,
 * `table-<round>.md`; prints `round <r> · head <sha> · rows <n> (<kind> <k>, …) · leftovers <n> ·
 * banked <n>`, one `refused: <file> — <error>` line per refused file, and for `final` the `open:` line.
 * Exit 0 written, nothing refused · 1 written with refusals · 2 usage, a prior round missing, or bad input.
 *
 * `leftovers` prints `final.leftovers`, one line each, for the standing ticket. Exit 0 · 2 usage or no
 * final round.
 *
 * Run from the run's tree: the brief is read from it, and on a `--from-branch` run every file
 * changed since the ledger's base is a target. `build` exits 2 with `run <runid> is on <b>; this tree
 * is on <c> — enter the run's tree first` when the ledger's `freshen: … | branch=` is not the tree's
 * branch (`runBranchError`); `check` and `dispatch` read no git state and skip it. `--head` defaults to the head `table.json` already
 * holds for the round (a re-build keeps its range), else the tree's HEAD (a new round, and `final`).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { type ExecFn, gitOut } from "./lib/gitOps.ts";
import { isMain } from "./lib/isMain.ts";
import { type Ledger, parseLedger } from "./lib/ledger.ts";
import { treeBranchError } from "./lib/owed.ts";
import { STAGE_READER_NAMES } from "./lib/riskClass.ts";
import { gatherRound, missingHandTestOutputs, readerFiles, resolveTargets } from "./lib/runDir.ts";
import {
  FIX_ROUNDS,
  type FixFile,
  type FixRound,
  type GivenRow,
  isFixRound,
  isRoundId,
  isStage,
  parseFixFile,
  parseHandTestFile,
  parseReaderFile,
  parseSessionFile,
  parseStageFile,
  parseStageKey,
  parseTableJson,
  READER_ID_PREFIX,
  readerIdPrefix,
  type Round,
  type RoundId,
  RunFileError,
  serialiseTableJson,
  type Stage,
  type StageKey,
  STAGES,
  stageIdRange,
  type TableJson,
} from "./lib/runFiles.ts";
import {
  buildRound,
  type Carry,
  formatLocator,
  givenRows,
  leftoverLines,
  type MergeLimits,
  renderRoundTable,
  stageCarry,
  summaryLines,
} from "./lib/table.ts";
import { loadThresholds } from "./thresholds.ts";

/** Usage or unreadable input: exit 2. */
export class UsageError extends Error {}

export interface Io {
  /** The session tree. */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Test seam for git. */
  exec?: ExecFn;
}

// ── Run-dir reads (shared with `check` and `dispatch`) ──────────────────────────────────────

/** The run's ledger. A ledger the old flow wrote throws the `flow: 2` message. */
export function readLedger(runDir: string): Ledger {
  const path = join(runDir, "ship.md");
  if (!existsSync(path)) throw new UsageError(`${path} does not exist`);
  try {
    return parseLedger(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`ship.md: ${(e as Error).message}`);
  }
}

/** `table.json`, or an empty table before round 1. */
export function readTable(runDir: string): TableJson {
  const path = join(runDir, "table.json");
  if (!existsSync(path)) return { schema: 2, rounds: {} };
  try {
    return parseTableJson(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`table.json: ${(e as Error).message}`);
  }
}

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** What a read after a round answers: that round's rows and the fix file that says what the fixer did
 *  to each. */
interface StageRows {
  carry: Carry;
  round: Round;
  fix: FixFile;
  /** The fix file's text, so a dispatch can quote the fixer's own line. */
  fixText: string;
}

/**
 * The rows the readers of stage folder `stage` answer, or null when no row is given there: a
 * `drift-<n>` read (no round before it), or a round with no rows (no fixer ran). `dispatch` gives each
 * reader `givenRows` over this, and `check --run-dir` holds the reader's stage file to the same rows,
 * so the two can never disagree. Throws `UsageError` when the round is not built or its fix file is
 * missing or malformed.
 */
function stageRows(runDir: string, stage: StageKey): StageRows | null {
  const carry = stageCarry(stage);
  if (carry === null) return null;
  const round = readTable(runDir).rounds[carry.from];
  if (!round) {
    throw new UsageError(`stage ${stage.key} answers round ${carry.from}, and table.json has no round ${carry.from}: run \`build --round ${carry.from}\` first`);
  }
  if (round.rows.length === 0) return null;
  const name = `fix-${carry.fix}.txt`;
  const path = join(runDir, name);
  if (!existsSync(path)) throw new UsageError(`${name} is missing: round ${carry.from} has ${round.rows.length} rows`);
  const fixText = readFileSync(path, "utf8");
  try {
    return { carry, round, fix: parseFixFile(fixText, { rows: round.rows.map((r) => r.id), round: carry.fix }), fixText };
  } catch (e) {
    throw new UsageError(`${name}: ${(e as Error).message}`);
  }
}

/** The reader (and slice) a run-dir file belongs to, by the one reader-file rule (`readerFiles`);
 *  null when the name is not a reader file's. */
function readerFileOf(path: string): { reader: string; slice: number | null } | null {
  return readerFiles(dirname(path)).find((f) => f.name === basename(path)) ?? null;
}

// ── Subcommands ──────────────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[], flags: readonly string[]): Record<string, string | undefined> {
  let rest = argv;
  const out: Record<string, string | undefined> = {};
  for (const flag of flags) {
    const r = takeValue(rest, flag);
    out[flag] = r.value;
    rest = r.rest;
  }
  assertKnownFlags(rest, []);
  if (rest.length > 0) throw new UsageError(`unexpected argument(s): ${rest.join(" ")}`);
  return out;
}

function required(flags: Record<string, string | undefined>, flag: string): string {
  const v = flags[flag];
  if (v === undefined) throw new UsageError(`${flag} is required`);
  return v;
}

/**
 * The head a re-build of a round `table.json` already holds keeps: its stored head, so a round
 * re-built after the session moved on still reads its own range and its fix line's commits stay in
 * it. `final` is the exception: SHIP re-builds it after a later commit, at the new head. Null when
 * the round is new, or `final`.
 */
function keptHead(roundId: RoundId, table: TableJson, io: Io): string | null {
  const stored = table.rounds[roundId];
  if (roundId === "final" || stored === undefined) return null;
  io.err(`note: table.json holds round ${roundId} — re-built at its head ${stored.head}; pass --head <sha> to build it elsewhere`);
  return stored.head;
}

async function runBuild(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, ["--run-dir", "--round", "--head"]);
  const runDir = resolve(io.cwd, required(flags, "--run-dir"));
  const roundId = required(flags, "--round");
  if (!isRoundId(roundId)) {
    throw new UsageError(`--round must be one of 1 | 2 | 3 | escalate | drift-<n> | final, got ${roundId}`);
  }
  if (!isDir(runDir)) throw new UsageError(`--run-dir ${runDir} is not a directory`);
  const git = io.exec ? { exec: io.exec } : {};
  const repo = gitOut(["rev-parse", "--show-toplevel"], { cwd: io.cwd, ...git }).trim();
  const ledger = readLedger(runDir);
  const wrongTree = treeBranchError(ledger, runDir, repo, io.exec);
  if (wrongTree !== null) throw new UsageError(wrongTree);
  const table = readTable(runDir);
  const head = flags["--head"] ?? keptHead(roundId, table, io) ?? gitOut(["rev-parse", "HEAD"], { cwd: repo, ...git }).trim();
  const isTarget = resolveTargets(ledger, repo, head, { ...git, note: io.err });
  const t = (await loadThresholds(repo)).values;
  const merge: MergeLimits = { near: t.TABLE_MERGE_NEAR_LINES, exactAbove: t.TABLE_MERGE_EXACT_ABOVE_LINES };

  // A `TableInputError` (a prior round or a fix file missing) propagates to main's exit 2.
  const result = buildRound({ round: roundId, head, table, isTarget, merge, ...gatherRound(runDir, roundId, ledger, table) });
  writeFileSync(join(runDir, "table.json"), serialiseTableJson(result.table));
  if (roundId !== "final") writeFileSync(join(runDir, `table-${roundId}.md`), renderRoundTable(roundId, result.round));
  for (const line of summaryLines(roundId, result.round)) io.out(line);
  return result.round.refused.length > 0 ? 1 : 0;
}

function runLeftovers(argv: string[], io: Io): number {
  const flags = parseFlags(argv, ["--run-dir", "--run-id"]);
  const runDir = resolve(io.cwd, required(flags, "--run-dir"));
  const runId = required(flags, "--run-id");
  const final = readTable(runDir).rounds.final;
  if (!final || !("open" in final)) throw new UsageError("table.json has no final round: run `build --round final` first");
  for (const line of leftoverLines(final, runId)) io.out(line);
  return 0;
}

/** `check --stage` values: each read's stage (`wave` is a wave reader file), then the files that are
 *  not reader files. A drift group's own keys (`KEYED_CHECK_STAGES`) are accepted too; with
 *  `--run-dir` a drift stage needs one, since the rows it answers are its group's. */
export const CHECK_STAGES: readonly string[] = [...STAGES, "session", ...FIX_ROUNDS.map((r) => `fix-${r}`), "hand-test"];
const KEYED_CHECK_STAGES = ["drift-<n>", "drift-confirm-<n>", "fix-drift-<n>"];

type AfterStage = Exclude<Stage, "wave">;

function isCheckStage(stage: string): boolean {
  if (["session", "hand-test", ...STAGES].includes(stage) || parseStageKey(stage) !== null) return true;
  return stage.startsWith("fix-") && (isFixRound(stage.slice(4)) || stage === "fix-drift");
}

/** The stage folder a stage file answers at: the `--stage` key, else the folder it sits in. Null when
 *  neither names one (a bare `drift` outside a `stage-drift-<n>/` folder). */
function stageKeyOf(file: string, stage: AfterStage | StageKey): StageKey | null {
  const folder = basename(dirname(file));
  const inFolder = folder.startsWith("stage-") ? parseStageKey(folder.slice("stage-".length)) : null;
  const want = typeof stage === "string" ? stage : stage.stage;
  if (/^stage-/.test(folder)) {
    const ok = inFolder !== null && (typeof stage === "string" ? inFolder.stage === stage : inFolder.key === stage.key);
    if (!ok) throw new UsageError(`${file} is in ${folder}, not stage-${typeof stage === "string" ? stage : stage.key}`);
  }
  if (typeof stage !== "string") return stage;
  return inFolder !== null && inFolder.stage === want ? inFolder : parseStageKey(want);
}

/** One file against its grammar and, with a run dir, against the run. Throws `RunFileError` when the
 *  file is invalid, `UsageError` when the run's own files cannot be read. */
function checkFile(file: string, text: string, stage: string, runDir: string | null): { ok: string; warnings: string[] } {
  if (stage === "wave") {
    const f = readerFileOf(file);
    const parsed = parseReaderFile(text, { stage: "wave", prefix: f === null ? null : readerIdPrefix(f.reader, f.slice) });
    return { ok: `ok: ${parsed.findings.length} findings`, warnings: [] };
  }
  if (stage === "session") return { ok: `ok: ${parseSessionFile(text).length} findings`, warnings: [] };
  const keyed = parseStageKey(stage);
  if (keyed !== null || (isStage(stage) && stage !== "wave")) {
    const key = stageKeyOf(file, keyed ?? (stage as AfterStage));
    const name = (keyed?.stage ?? stage) as AfterStage;
    const reader = readerFileOf(file)?.reader ?? null;
    let given: GivenRow[] | undefined;
    if (runDir !== null) {
      if (reader === null) throw new UsageError(`${basename(file)} is not a reader's file name (<reader>.md), so the rows it answers are unknown`);
      if (key === null) throw new UsageError(`--stage ${stage} with --run-dir needs its drift group: ${stage}-<n>`);
      const rows = stageRows(runDir, key);
      given = rows === null ? [] : givenRows(rows.round.rows, rows.fix, reader);
    }
    const parsed = parseStageFile(text, { stage: name, ...(given ? { given } : {}), ...(reader ? { reader } : {}) });
    return { ok: `ok: ${parsed.findings.length} findings`, warnings: parsed.warnings };
  }
  if (stage === "hand-test") {
    const lines = parseHandTestFile(text);
    if (runDir !== null) {
      const missing = missingHandTestOutputs(runDir, lines);
      if (missing.length > 0) {
        throw new RunFileError(missing.map((l) => ({ line: l.line, message: `${l.claim}: output file ${l.output} is not in the run dir` })));
      }
    }
    return { ok: `ok: ${lines.length} rows`, warnings: [] };
  }
  const round = stage.slice("fix-".length);
  if (round === "drift") {
    if (runDir !== null) throw new UsageError("--stage fix-drift with --run-dir needs its drift group: fix-drift-<n>");
    return { ok: `ok: ${parseFixFile(text, {}).lines.length} rows`, warnings: [] };
  }
  const fixRound = round as FixRound;
  let rows: string[] | undefined;
  if (runDir !== null) {
    const r = readTable(runDir).rounds[fixRound];
    if (!r) throw new UsageError(`table.json has no round ${fixRound}: run \`build --round ${fixRound}\` first`);
    rows = r.rows.map((x) => x.id);
  }
  return { ok: `ok: ${parseFixFile(text, { round: fixRound, ...(rows ? { rows } : {}) }).lines.length} rows`, warnings: [] };
}

function runCheck(argv: string[], io: Io): number {
  const flags = parseFlags(argv, ["--file", "--stage", "--run-dir"]);
  const file = resolve(io.cwd, required(flags, "--file"));
  const stage = required(flags, "--stage");
  if (!isCheckStage(stage)) {
    throw new UsageError(`--stage must be one of ${CHECK_STAGES.join(" | ")} | ${KEYED_CHECK_STAGES.join(" | ")}, got ${stage}`);
  }
  const runDir = flags["--run-dir"] === undefined ? null : resolve(io.cwd, flags["--run-dir"]);
  if (runDir !== null && !isDir(runDir)) throw new UsageError(`--run-dir ${runDir} is not a directory`);
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`--file ${file} is not a file`);
  let result: { ok: string; warnings: string[] };
  try {
    result = checkFile(file, readFileSync(file, "utf8"), stage, runDir);
  } catch (e) {
    if (!(e instanceof RunFileError)) throw e;
    for (const line of e.message.split("\n")) io.out(line);
    return 1;
  }
  for (const w of result.warnings) io.err(`warning: ${w}`);
  io.out(result.ok);
  return 0;
}

/** The dispatch file: how to answer, then each given row with its texts and the fixer's own line. */
function renderDispatch(stage: StageKey, reader: string, rows: StageRows | null, given: readonly GivenRow[]): string {
  const { min, max } = stageIdRange(stage.stage);
  const prefix = READER_ID_PREFIX[reader]!;
  const out = [`# Rows to answer — stage ${stage.key} · ${reader}`, "", `Your answer is \`${stage.folder}/${reader}.md\`: two sections, in this order.`, ""];
  if (rows === null || given.length === 0) {
    out.push("- `## Status`: the one line `- none`. No row is given to you at this stage.");
  } else {
    out.push(
      `- \`## Status\`: exactly one line per row below (${given.length}), under the row's id. A \`fixed\` row: \`- <ID> · resolved\`, or \`- <ID> · unresolved — <reason>\`. A \`dropped\` or \`relabel\` row: \`- <ID> · agree\`, or \`- <ID> · disagree — <reason>\`.`
    );
  }
  out.push(`- \`## New\`: one finding block per new finding, ids \`${prefix}.${min}\` to \`${prefix}.${max}\`, or a line starting \`NO FINDINGS\`.`);
  if (reader === "build-verifier") out.push("- Last line: `VERDICT: CLEAN` or `VERDICT: INCOMPLETE — <check>`.");
  if (rows === null || given.length === 0) return `${out.join("\n")}\n`;
  out.push("", `The rows are round ${rows.carry.from}'s, built at ${rows.round.head}; the fixer's lines are fix-${rows.carry.fix}.txt's.`);
  const fixLines = rows.fixText.split("\n");
  for (const g of given) {
    const row = rows.round.rows.find((r) => r.id === g.id)!;
    const line = rows.fix.lines.find((l) => l.row === g.id)!;
    out.push("", `## ${row.id} · ${row.kind} · ${line.action} — answer ${line.action === "fixed" ? "resolved | unresolved" : "agree | disagree"}`, "");
    out.push(`- fixer: ${fixLines[line.line - 1]!.trim()}`);
    if (row.also.length > 0) out.push(`- also: ${row.also.join(", ")}`);
    out.push(`- locators: ${row.locators.length === 0 ? "none" : row.locators.map(formatLocator).join(", ")}`);
    for (const t of row.texts) {
      out.push(`- ${t.id}: ${t.finding}`, `  - after: ${t.after}`);
      if (t.invariant !== undefined) out.push(`  - invariant: ${t.invariant}`);
      if (t.vacuity !== undefined) out.push(`  - vacuity: ${t.vacuity}`);
    }
    for (const h of row.history) out.push(`- history: ${h}`);
  }
  return `${out.join("\n")}\n`;
}

function runDispatch(argv: string[], io: Io): number {
  const flags = parseFlags(argv, ["--run-dir", "--stage", "--reader", "--out"]);
  const runDir = resolve(io.cwd, required(flags, "--run-dir"));
  const stageArg = required(flags, "--stage");
  const stage = parseStageKey(stageArg);
  if (stage === null) {
    throw new UsageError(`--stage must be one of confirm-1 | confirm-2 | last | escalate | drift-<n> | drift-confirm-<n>, got ${stageArg}`);
  }
  const reader = required(flags, "--reader");
  if (!(STAGE_READER_NAMES as readonly string[]).includes(reader)) {
    throw new UsageError(`--reader must be one of ${STAGE_READER_NAMES.join(" | ")}, got ${reader}`);
  }
  const out = resolve(io.cwd, required(flags, "--out"));
  if (!isDir(runDir)) throw new UsageError(`--run-dir ${runDir} is not a directory`);
  if (!isDir(dirname(out))) throw new UsageError(`--out directory ${dirname(out)} does not exist`);
  const rows = stageRows(runDir, stage);
  const given = rows === null ? [] : givenRows(rows.round.rows, rows.fix, reader);
  // R.6: the reader's output folder exists before any reader runs; the Codex runner refuses an
  // `--out` in a missing folder.
  mkdirSync(join(runDir, stage.folder), { recursive: true });
  writeFileSync(out, renderDispatch(stage, reader, rows, given));
  const ids = given.length === 0 ? "" : ` (${given.map((g) => g.id).join(", ")})`;
  io.out(`stage ${stage.key} · reader ${reader} · rows ${given.length}${ids} · wrote ${out}`);
  return 0;
}

const SUBCOMMANDS: Record<string, (argv: string[], io: Io) => number | Promise<number>> = {
  build: runBuild,
  check: runCheck,
  dispatch: runDispatch,
  leftovers: runLeftovers,
};

const USAGE = `usage: reviewTable.ts <${Object.keys(SUBCOMMANDS).join(" | ")}> …`;

export async function main(
  argv: string[],
  io: Io = { cwd: process.cwd(), out: (l) => console.log(l), err: (l) => console.error(l) },
  exit: (code: number) => void = exitWhenFlushed
): Promise<void> {
  const [sub, ...rest] = argv;
  const run = sub === undefined ? undefined : SUBCOMMANDS[sub];
  if (!run) {
    io.err(USAGE);
    exit(2);
    return;
  }
  try {
    exit(await run(rest, io));
  } catch (e) {
    // Exit 1 means "written with refusals", so anything that stopped the write is a 2.
    io.err(`reviewTable ${sub}: ${(e as Error).message}`);
    exit(2);
  }
}

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2));
}
