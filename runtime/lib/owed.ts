/**
 * What a run owes, and the facts the session did not write (build-spec §1.9). The gate
 * (`shipGate.ts`) calls `owedFacts`; the merge check (`checkMergeEligibility.ts`) calls
 * `markerChecksOf`, which `owedFacts` returns as its `markerChecks`, so the two cannot drift; the
 * stage plan (`stagePlan.ts`) prints `planStage`, the same function `owedFacts` runs per read, so
 * what the session is told to spawn is what the gate later demands.
 *
 * The session writes the ledger; this module reads it plus the run dir (`table.json`, the fix,
 * stage, and hand-test files) and git, and computes the rest itself: the brief's class and claims at
 * its first commit and at HEAD, the owed fixer model, the `build:` line's `parts=` against the brief's
 * parts (`buildPartsFailures`), which rounds owe a fix line, which reads and
 * readers are owed and at which head, whether every hand-test claim's last run passed, whether `table.json`
 * still re-builds from the run dir (`tableReplay.ts`), and main's drift: the build's one drift group,
 * then the `drift-merge:` lines that clear each later move of main. A signals
 * arm that could not answer throws `ArmEnvError` rather than silently answering with the fallback.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isUncounted, measure } from "../size.ts";
import { loadThresholds } from "../thresholds.ts";
import { BriefPartError, type BriefModel, type Claim, type ClaimNeed, gradedContent, type Part, summariseBrief } from "./brief.ts";
import type { MarkerCheckName } from "./gateMarkers.ts";
import { type ExecFn, gitOk, gitOut } from "./gitOps.ts";
import {
  type DriftGroup,
  type FixLine,
  type FixModel,
  type Ledger,
  READ_MOVE_FOLDER,
  type ReadLine,
  type ReadMove,
  readMoveFolder,
  runBranchError,
} from "./ledger.ts";
import { briefLocation } from "./repoId.ts";
import { type RiskClass, RISK_CLASS_READERS, type StageReaderName } from "./riskClass.ts";
import { missingHandTestOutputs, readerFiles } from "./runDir.ts";
import {
  driftGroupOf,
  driftRound,
  FIXED_ROUND_IDS,
  type FinalRound,
  type FixFile,
  type FixRound,
  type HandTestLine,
  isFixedAt,
  parseFixFile,
  parseHandTestFile,
  parseTableJson,
  parseVerdict,
  type Round,
  type RoundId,
  type TableJson,
} from "./runFiles.ts";
import {
  armEnvFailure,
  type ArmDeps,
  type FixSecurityResult,
  fixSecurity,
  prCode,
  type PrCodeResult,
} from "./signalsArms.ts";
import { heldIds, type MergeLimits } from "./table.ts";
import { rebuildCommand, staleRounds, unreadFiles } from "./tableReplay.ts";

// ── Names ────────────────────────────────────────────────────────────────────────────────────

/** The stages `stagePlan.ts --stage` takes: every read after the wave. */
export const PLAN_STAGES = ["confirm-1", "confirm-2", "last", "escalate", "drift", "drift-confirm", "unbank"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

/** The ledger move that records each stage's read. */
export const READ_MOVE_OF_STAGE: Readonly<Record<PlanStage, ReadMove>> = {
  "confirm-1": "confirm-1",
  "confirm-2": "confirm-2",
  last: "last-read",
  escalate: "escalate-read",
  drift: "drift-read",
  "drift-confirm": "drift-confirm",
  unbank: "unbank-read",
};

/** The stages whose read is not a drift group's, and the fix round each reads. */
const STAGE_FIX_ROUND = { "confirm-1": "1", "confirm-2": "2", last: "3", escalate: "escalate" } as const;
type PlainStage = keyof typeof STAGE_FIX_ROUND;
type PlainRound = (typeof FIXED_ROUND_IDS)[number];

/** Each round that is not a drift group's: its ledger move and its fix file. */
const PLAIN_FIX: Readonly<Record<PlainRound, { move: "fix-1" | "fix-2" | "fix-3" | "escalate"; file: string }>> = {
  "1": { move: "fix-1", file: "fix-1.txt" },
  "2": { move: "fix-2", file: "fix-2.txt" },
  "3": { move: "fix-3", file: "fix-3.txt" },
  escalate: { move: "escalate", file: "fix-escalate.txt" },
};

/** Each round that is not a drift group's: the ledger move of the read after it. */
const READ_OF_ROUND: Readonly<Record<PlainRound, ReadMove>> = {
  "1": "confirm-1",
  "2": "confirm-2",
  "3": "last-read",
  escalate: "escalate-read",
};

/** A fix round's ledger move as a failure line names it, its fix file, and its fix line if any. */
export function fixOfRound(ledger: Ledger, r: FixRound): { move: string; file: string; line: FixLine | null } {
  const group = driftGroupOf(r);
  if (group !== null) {
    return { move: `drift-fix (group ${group})`, file: `fix-${r}.txt`, line: ledger.driftGroups[group - 1]?.fix ?? null };
  }
  const { move, file } = PLAIN_FIX[r as PlainRound];
  return { move, file, line: ledger.fixes.get(move) ?? null };
}

const CODEX = "review-cursory-codex";
const HUNTER = "gate-silent-failure-hunter";
const SECURITY = "security-review";
const VERIFIER = "build-verifier";
const CURSORY = "review-cursory";
const HUNTER_WORDS = /\b(?:catch|await|Promise)\b/;
const AMEND_BRIEF = "amend brief:";
const ONE_DRIFT_GROUP_PLAN = "one drift group per build — merge main, write `drift-merge:`; SHIP's pre-push checks cover it";
const DRIFT_MERGE_FORM = "`drift-merge: | from=<the head before that merge> | sha=<the head after it>`";
const OPERATOR_AMEND = "amend brief: operator change:";

// ── Errors and deps ──────────────────────────────────────────────────────────────────────────

/** A signals arm could not answer here; its answer is unknown. */
export class ArmEnvError extends Error {
  constructor(line: string) {
    super(line);
    this.name = "ArmEnvError";
  }
}

export interface OwedDeps {
  /** git, run with cwd = repo. Default: the real git. */
  git?: ExecFn;
  /** The signals step and its runner (`signalsArms.ts`); `git` above is passed through. */
  arms?: Omit<ArmDeps, "git">;
  /** `WAVE_HUNTER_MIN_LINES`. Default: the repo's thresholds (`thresholds.ts`). */
  hunterMinLines?: number;
  /** `TABLE_MERGE_NEAR_LINES` / `TABLE_MERGE_EXACT_ABOVE_LINES`. Default: the repo's thresholds. */
  merge?: MergeLimits;
}

// ── The run context ──────────────────────────────────────────────────────────────────────────

export interface BriefFacts {
  /** The brief, or on `--from-branch` the hand-test file; null when the ledger names neither. A path
   *  in the repo that holds it (`briefLocation`): the code repo, or the store dir when `store`. */
  path: string | null;
  /** The ledger names it `store:<path>`: it lives in the store, read through `briefGit`. */
  store: boolean;
  /** The class line's class at HEAD; null when unreadable or absent. */
  cls: RiskClass | null;
  /** Claims at HEAD. */
  claims: Claim[];
  /** Claims at the file's first commit; a brief from before the parts counts 0 (R.11). */
  claimsAtFirst: number | null;
  firstCommit: string | null;
  /** The brief's `## Target files` at HEAD; every path on `--from-branch`. */
  targets: string[] | "all";
  /** The brief's `model:` at HEAD; null on `--from-branch` or when unreadable. */
  model: BriefModel | null;
  /** The brief's parts at HEAD (the implicit P1 when it has no `## Parts`); `[]` on `--from-branch`
   *  or when unreadable. */
  parts: Part[];
  /** The brief has a `## Parts` section: only then does `build:` owe `parts=`. */
  partsDeclared: boolean;
}

/** Everything a plan or the owed set reads, gathered once. Build it with `runContext`. */
export interface RunContext {
  ledger: Ledger;
  runDir: string;
  repo: string;
  base: string;
  head: string;
  brief: BriefFacts;
  /** Brief problems (item 1), already phrased as gate failures. */
  briefFailures: string[];
  /** `table.json`, or null when absent or unreadable (`tableError` says which). */
  table: TableJson | null;
  tableError: string | null;
  hunterMinLines: number;
  merge: MergeLimits;
  git: (args: string[]) => string;
  gitOk: (args: string[]) => boolean;
  /** git in the repo that holds the brief: the store dir for a `store:` brief, else `repo`. */
  briefGit: (args: string[]) => string;
  briefOk: (args: string[]) => boolean;
  /** The git seam, for the round replay's own reads. */
  exec: ExecFn | undefined;
  arms: ArmDeps;
  /** Every signals note seen, for the caller to print. */
  notes: Set<string>;
  prCodeCache: Map<string, PrCodeResult>;
}

/** The run's base: a `--base` flag overrides the ledger's `freshen: … | base=` (R.4). */
export function runBase(ledger: Ledger, flag: string | undefined): string | null {
  return flag ?? ledger.base;
}

/** `runBranchError` over the branch of the tree at `repo`; reads git only when the ledger names a
 *  `branch=`. The table build, the stage plan, and the gate each call it before reading HEAD. */
export function treeBranchError(ledger: Ledger, runDir: string, repo: string, exec?: ExecFn): string | null {
  if (ledger.branch === null) return null;
  const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, ...(exec ? { exec } : {}) }).trim();
  return runBranchError(ledger, branch, runDir);
}

/** Two shas name one commit: equal, or one a ≥7-char prefix of the other. */
export function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** A git pair bound to one repo. */
export interface GitPair {
  git: (args: string[]) => string;
  ok: (args: string[]) => boolean;
}

/** `<rev>:<path>` for a path in the repo that holds the brief. A store dir is a folder of the store
 *  repo, and a bare `<rev>:<path>` names a path from the repo's top, so a store path is `./`-relative. */
function blobOf(facts: Pick<BriefFacts, "store">, rev: string, path: string): string {
  return `${rev}:${facts.store ? "./" : ""}${path}`;
}

/** The oldest commit that adds `path`, in the repo `git` runs in; null when none does. */
export function firstAddingCommit(git: (args: string[]) => string, path: string): string | null {
  return git(["log", "--diff-filter=A", "--format=%H", "--", path]).split("\n").filter(Boolean).at(-1) ?? null;
}

/** The subject of the empty commit that records a store file: the ledger's line for it, then
 *  ` @ <store commit>` (`brief: store:<path> @ <sha>`, `hand-test-block: store:<path> @ <sha>`). */
const RECORD = /^(brief|hand-test-block): store:(\S+) @ ([0-9a-f]{40})$/;

/**
 * The brief-first proof. `failure` is a line, or null when the brief came before the code it grades;
 * `first` is the commit that holds this run's first version of the file.
 *
 * The branch's first commit is the root, by parentage and never by date, of the commits HEAD holds
 * beyond `base` and beyond `also`; an empty range proves nothing and fails nothing.
 *
 * A brief in the code repo was first added BY that commit. A brief in the store sits in another
 * repo, so the branch's first commit RECORDS it: an empty commit whose subject is
 * `brief: store:<path> @ <store commit>`, where that store commit commits the brief. A commit can
 * only name one that already exists, so the record proves the order with no clock, and it picks this
 * run's version out of a path an earlier run used. Every later store commit on the file is an
 * `amend brief:` one: a brief committed again after the record was written after the work began.
 *
 * A `--from-branch` run's hand-test file (`kind: "hand-test-block"`) has no order to prove, and is
 * read here only when it is in the store: its record is the run's own first commit, anywhere on the
 * branch, and only picks the run's version. `name` opens the line (`brief: <path>`, `the brief`).
 */
export function briefOrder(o: {
  name: string;
  kind: "brief" | "hand-test-block";
  base: string;
  /** The ledger's own base when a `--base` flag overrode it. A stacked unit at SHIP is read against
   *  `origin/main` while its branch still holds its parent's commits, which the parent's squash left
   *  unreachable from main: without this the parent's first commit would be taken for the unit's. */
  also?: string | null;
  /** git in the code repo. */
  code: (args: string[]) => string;
  /** The file's path in the repo that holds it (in the store: under the store dir). */
  path: string;
  /** The file's oldest adding commit, in the repo that holds it (`firstAddingCommit`). */
  firstCommit: string;
  /** git in the store dir, for a file there; null for a brief in the code repo. */
  store: GitPair | null;
}): { failure: string | null; first: string } {
  const beyond = o.also ? [o.base, o.also] : [o.base];
  const commits = o.code(["log", "--topo-order", "--format=%H %s", "HEAD", "--not", ...beyond]).split("\n").filter(Boolean);
  const branchFirst = commits.at(-1)?.slice(0, 40);
  if (branchFirst === undefined) return { failure: null, first: o.firstCommit };
  if (o.store === null) {
    return {
      first: o.firstCommit,
      failure: sameSha(o.firstCommit, branchFirst)
        ? null
        : `${o.name} was first committed at ${o.firstCommit}, not as the branch's first commit ${branchFirst}, so it post-dates the work it grades`,
    };
  }
  const anywhere = o.kind === "hand-test-block";
  const want = `${o.kind}: store:${o.path} @ `;
  const end = anywhere ? "so its first version cannot be told from an earlier run's" : "so nothing proves it came before the work it grades";
  const fail = (why: string) => ({ first: o.firstCommit, failure: `${o.name} ${why}, ${end}` });
  // Oldest first: a brief's record is the branch's first commit, a hand-test file's the first that names it.
  const held = anywhere ? commits.toReversed().find((l) => l.slice(41).startsWith(want)) : commits.at(-1)!;
  const m = held === undefined ? null : RECORD.exec(held.slice(41));
  if (held === undefined || m === null || m[1] !== o.kind || m[2] !== o.path) {
    return fail(
      anywhere
        ? `is not recorded on the branch — the run's first commit is an empty one whose subject is \`${want}<store commit>\` (FROM-BRANCH)`
        : `is not recorded by the branch's first commit ${branchFirst} — that commit is an empty one whose subject is \`${want}<store commit>\` (BRIEF step 6)`
    );
  }
  const at = m[3]!;
  const recorded = `is recorded at ${at} by ${anywhere ? "commit" : "the branch's first commit"} ${held.slice(0, 40)}`;
  if (!o.store.ok(["cat-file", "-e", `${at}^{commit}`])) return fail(`${recorded}, and the store holds no such commit`);
  if (o.store.git(["log", "-1", "--format=%H", at, "--", o.path]).trim() !== at) return fail(`${recorded}, a store commit that does not change it`);
  if (!o.store.ok(["merge-base", "--is-ancestor", at, "HEAD"])) return fail(`${recorded}, a commit the store's HEAD does not hold`);
  const again = o.store
    .git(["log", "--format=%H %s", `${at}..HEAD`, "--", o.path])
    .split("\n")
    .filter(Boolean)
    .find((l) => !l.slice(41).startsWith(AMEND_BRIEF));
  if (again !== undefined) {
    return fail(`${recorded}, and store commit ${again.slice(0, 40)} changes it later with no \`${AMEND_BRIEF}\` subject`);
  }
  return { failure: null, first: at };
}

function readBrief(
  ledger: Ledger,
  base: string,
  code: GitPair,
  brief: GitPair,
  loc: { cwd: string; path: string; store: boolean } | null
): { facts: BriefFacts; failures: string[] } {
  const fromBranch = ledger.fromBranch !== null;
  const failures: string[] = [];
  const facts: BriefFacts = {
    path: loc?.path ?? null,
    store: loc?.store ?? false,
    cls: null,
    claims: [],
    claimsAtFirst: null,
    firstCommit: null,
    targets: fromBranch ? "all" : [],
    model: null,
    parts: [],
    partsDeclared: false,
  };
  const line: "hand-test-block" | "brief" = fromBranch ? "hand-test-block" : "brief";
  if (fromBranch && ledger.brief !== null) {
    failures.push("brief: a `--from-branch` run has no brief — the ledger names both `brief:` and `from-branch:`");
  }
  const path = facts.path;
  if (path === null) return { facts, failures };
  // Messages name the ledger's own value, so a store brief reads `store:<path>`.
  const shown = (fromBranch ? ledger.handTestBlock : ledger.brief) ?? path;
  const { git, ok } = brief;
  if (facts.store && !existsSync(loc!.cwd)) {
    failures.push(`${line}: ${shown} — no store dir at ${loc!.cwd}; clone the store there or set AGENT_BUILD_STORE`);
    return { facts, failures };
  }
  if (!ok(["ls-files", "--error-unmatch", "--", path])) {
    failures.push(`${line}: ${shown} is not tracked at HEAD${facts.store ? " of the store" : ""} — commit it (git ls-files --error-unmatch)`);
    return { facts, failures };
  }
  const want = fromBranch ? "hand-test-block" : "brief";
  try {
    const head = summariseBrief(git(["show", blobOf(facts, "HEAD", path)]));
    if (head.kind !== want) {
      failures.push(
        fromBranch
          ? `hand-test-block: ${shown} is a full brief — the --from-branch file holds its class line and \`## Hand test\` only`
          : `brief: ${shown} holds only a \`## Hand test\` section — a brief also carries \`model:\` and \`## Target files\``
      );
    }
    facts.cls = head.cls;
    facts.claims = head.claims;
    facts.model = head.model;
    facts.parts = head.parts;
    facts.partsDeclared = head.partsDeclared;
    if (!fromBranch) facts.targets = head.targets ?? [];
  } catch (err) {
    if (!(err instanceof BriefPartError)) throw err;
    failures.push(`${line}: ${shown} at HEAD — ${err.message} (node ~/.agent-build/runtime/briefCheck.ts ${facts.store ? join(loc!.cwd, path) : path})`);
    return { facts, failures };
  }
  // The class the operator pinned into the brief is the run's class; the ledger only repeats it.
  if (facts.cls === null) {
    failures.push(`${line}: ${shown} has no class line — the class moment pins \`class: ${ledger.cls} — <who>, <date>\` into it`);
  } else if (facts.cls !== ledger.cls) {
    failures.push(`class: ${ledger.cls} — the ${line} ${shown} pins ${facts.cls}; the ledger's class line repeats the pinned class`);
  }
  let first = firstAddingCommit(git, path);
  if (first === null) {
    failures.push(`${line}: ${shown} has no commit that adds it`);
    return { facts, failures };
  }
  // A `--from-branch` run proves no order; its hand-test file is read here only for a store record.
  if (!fromBranch || facts.store) {
    const own = ledger.base !== null && ledger.base !== base && code.ok(["rev-parse", "--verify", "--quiet", `${ledger.base}^{commit}`]);
    const order = briefOrder({
      name: `${line}: ${shown}`,
      kind: line,
      base,
      also: own ? ledger.base : null,
      code: code.git,
      path,
      firstCommit: first,
      store: facts.store ? brief : null,
    });
    // A store file's first commit is the one the branch records, not the path's oldest.
    first = order.first;
    if (order.failure !== null) {
      failures.push(order.failure);
      // With no valid record, which store commit is this run's first is unknown: count no claims from a guess.
      if (facts.store) {
        facts.firstCommit = first;
        return { facts, failures };
      }
    }
  }
  facts.firstCommit = first;
  try {
    facts.claimsAtFirst = summariseBrief(git(["show", blobOf(facts, first, path)]), { legacyOk: true }).claims.length;
  } catch (err) {
    if (!(err instanceof BriefPartError)) throw err;
    failures.push(`${line}: ${shown} at its first commit ${first.slice(0, 9)} — ${err.message}`);
    return { facts, failures };
  }
  if (facts.claims.length < facts.claimsAtFirst) {
    const subjects = git(["log", "--format=%s", `${first}..HEAD`, "--", path]).split("\n");
    if (!subjects.some((s) => s.startsWith(OPERATOR_AMEND))) {
      failures.push(
        `${line}: ${shown} held ${facts.claimsAtFirst} hand-test claims at its first commit and ${facts.claims.length} at HEAD — a claim may leave only by an \`${OPERATOR_AMEND}\` commit${facts.store ? " in the store" : ""}`
      );
    }
  }
  return { facts, failures };
}

/** Gather what a plan or the owed set reads. Throws only on a git failure it cannot phrase. */
export async function runContext(
  ledger: Ledger,
  runDir: string,
  repo: string,
  base: string,
  deps: OwedDeps = {}
): Promise<RunContext> {
  const seam = deps.git ? { exec: deps.git } : {};
  const execOpts = { cwd: repo, ...seam };
  const git = (args: string[]) => gitOut(args, execOpts);
  const ok = (args: string[]) => gitOk(args, execOpts);
  // The second pair reads the brief where it lives: the same repo, or the store dir for `store:`.
  const raw = ledger.fromBranch !== null ? ledger.handTestBlock : ledger.brief;
  const loc = raw === null ? null : briefLocation(raw, repo, seam);
  const briefOpts = { cwd: loc?.cwd ?? repo, ...seam };
  const briefGit = (args: string[]) => gitOut(args, briefOpts);
  const briefOk = (args: string[]) => gitOk(args, briefOpts);
  const { facts, failures } = readBrief(ledger, base, { git, ok }, { git: briefGit, ok: briefOk }, loc);
  let table: TableJson | null = null;
  let tableError: string | null = null;
  const tablePath = join(runDir, "table.json");
  if (!existsSync(tablePath)) tableError = "no table.json — run `reviewTable.ts build` for each round";
  else {
    try {
      table = parseTableJson(readFileSync(tablePath, "utf8"));
    } catch (err) {
      tableError = `table.json: ${(err as Error).message}`;
    }
  }
  const t = deps.hunterMinLines === undefined || deps.merge === undefined ? (await loadThresholds(repo)).values : null;
  return {
    ledger,
    runDir,
    repo,
    base,
    head: git(["rev-parse", "HEAD"]).trim(),
    brief: facts,
    briefFailures: failures,
    table,
    tableError,
    hunterMinLines: deps.hunterMinLines ?? t!.WAVE_HUNTER_MIN_LINES,
    merge: deps.merge ?? { near: t!.TABLE_MERGE_NEAR_LINES, exactAbove: t!.TABLE_MERGE_EXACT_ABOVE_LINES },
    git,
    gitOk: ok,
    briefGit,
    briefOk,
    exec: deps.git,
    arms: { ...(deps.arms ?? {}), ...(deps.git ? { git: deps.git } : {}) },
    notes: new Set(),
    prCodeCache: new Map(),
  };
}

// ── Signals, checked ─────────────────────────────────────────────────────────────────────────

function checked<T extends { source: "repo" | "fallback"; note: string; failure: string | null }>(ctx: RunContext, r: T): T {
  const env = armEnvFailure(r);
  if (env !== null) throw new ArmEnvError(env);
  if (r.source === "fallback") ctx.notes.add(r.note);
  return r;
}

/** The PR's code a range changed (§1.9 item 4), cached per range. */
export function prCodeOf(ctx: RunContext, from: string, to: string): PrCodeResult {
  const key = `${from}..${to}`;
  const hit = ctx.prCodeCache.get(key);
  if (hit) return hit;
  const r = checked(ctx, prCode(ctx.repo, from, to, ctx.base, ctx.brief.targets, ctx.brief.store ? null : ctx.brief.path, ctx.arms));
  ctx.prCodeCache.set(key, r);
  return r;
}

function fixSecurityOf(ctx: RunContext, diff: string): FixSecurityResult {
  return checked(ctx, fixSecurity(ctx.repo, diff, ctx.arms));
}

// ── Run-dir reads ────────────────────────────────────────────────────────────────────────────

/** A fix file, parsed; `rows` checks it covers exactly the round's rows. */
function readFixFile(ctx: RunContext, file: string, opts: { rows?: string[]; round?: FixRound } = {}): FixFile {
  const path = join(ctx.runDir, file);
  if (!existsSync(path)) throw new Error(`${file} is missing — the fixer writes it`);
  try {
    return parseFixFile(readFileSync(path, "utf8"), opts);
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message.split("\n").join("; ")}`);
  }
}

/** Every `hand-test-<n>.txt`, ascending by `n`. A file that fails its grammar throws. */
export function handTestFiles(runDir: string): { n: number; lines: HandTestLine[] }[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .flatMap((name) => {
      const m = /^hand-test-([1-9]\d*)\.txt$/.exec(name);
      return m ? [{ n: Number(m[1]), name }] : [];
    })
    .sort((a, b) => a.n - b.n)
    .map(({ n, name }) => {
      try {
        return { n, lines: parseHandTestFile(readFileSync(join(runDir, name), "utf8")) };
      } catch (err) {
        throw new Error(`${name}: ${(err as Error).message.split("\n").join("; ")}`);
      }
    });
}

export interface ClaimState {
  id: string;
  needs: ClaimNeed[];
  /** Its latest run passed. A later change to the PR's code never re-owes it. */
  passed: boolean;
  why: string;
}

/** Each claim's latest run across the hand-test files, and whether it passed. */
export function claimStates(ctx: RunContext, files = handTestFiles(ctx.runDir)): ClaimState[] {
  return ctx.brief.claims.map((c) => {
    let latest: { n: number; line: HandTestLine } | null = null;
    for (const f of files) {
      const line = f.lines.find((l) => l.claim === c.id);
      if (line) latest = { n: f.n, line };
    }
    const base = { id: c.id, needs: c.needs };
    if (latest === null) return { ...base, passed: false, why: `${c.id} never ran` };
    const { n, line } = latest;
    if (line.result === "fail") {
      return { ...base, passed: false, why: `${c.id}'s last run (hand-test-${n}) failed (${line.cause})` };
    }
    return { ...base, passed: true, why: `${c.id} passed at ${line.sha} (hand-test-${n})` };
  });
}

function shown(paths: readonly string[]): string {
  return paths.length <= 3 ? paths.join(", ") : `${paths.slice(0, 3).join(", ")}, +${paths.length - 3}`;
}

// ── Main's drift ─────────────────────────────────────────────────────────────────────────────

/** The branch's files `base` changed after `since` (a commit the branch holds): main's advance
 *  since `since`'s merge-base, intersected with what the branch edits. Null when unreadable. */
export function mainDriftFiles(ctx: RunContext, since: string): string[] | null {
  try {
    const sinceBase = ctx.git(["merge-base", since, ctx.base]).trim();
    const headBase = ctx.git(["merge-base", "HEAD", ctx.base]).trim();
    const mainAdvance = ctx.git(["diff", "--name-only", sinceBase, ctx.base]).split("\n").filter(Boolean);
    const branch = new Set(ctx.git(["diff", "--name-only", headBase, "HEAD"]).split("\n").filter(Boolean));
    return mainAdvance.filter((p) => branch.has(p)).sort();
  } catch {
    return null;
  }
}

/** The first merge on the branch's first-parent line after `from`: where main came in. */
export function firstMergeAfter(ctx: RunContext, from: string): string | null {
  const merges = ctx.git(["rev-list", "--merges", "--first-parent", "--reverse", `${from}..HEAD`]);
  return merges.split("\n").find(Boolean) ?? null;
}

// ── One stage's plan ─────────────────────────────────────────────────────────────────────────

export type ReaderVerdict = "owed" | "sits out" | "not owed";

export interface ReaderPlan {
  reader: StageReaderName;
  verdict: ReaderVerdict;
  why: string;
  /** What the session does instead, when the reader is not owed. */
  instead?: string;
}

export interface StagePlan {
  stage: PlanStage;
  /** The stage folder's key (`StageKey`): the stage, or `drift-<n>` / `drift-confirm-<n>`. */
  key: string;
  /** The drift group a drift stage plans; null for every other stage. */
  group: number | null;
  move: ReadMove;
  owed: boolean;
  /** Why the read is owed or not (§1.9 item 5). */
  why: string;
  /** The range the readers read; null when the stage's fix line is absent. Its `to` is the head the
   *  read line's `sha=` must name. */
  range: { from: string; to: string; files?: string[] } | null;
  prCode: PrCodeResult | null;
  /** Null below R2: the security read of a fix is R2 only. */
  fixSecurity: FixSecurityResult | null;
  readers: ReaderPlan[];
}

function diffOf(ctx: RunContext, from: string, to: string, files?: string[]): string {
  return ctx.git(["diff", "--no-color", "--no-ext-diff", from, to, ...(files ? ["--", ...files] : [])]);
}

function changedFiles(ctx: RunContext, from: string, to: string): string[] {
  return ctx.git(["diff", "--name-only", from, to]).split("\n").filter(Boolean);
}

function droppedOrRelabelled(fix: FixFile): number {
  return fix.lines.filter((l) => l.action === "dropped" || l.action === "relabel").length;
}

/** The first `catch`, `await`, or `Promise` on a changed line of a counted file (`isUncounted`: not a
 *  test, a prose doc, or a lockfile), so a fixer's async test alone never owes the hunter. */
function hunterWord(diff: string): string | undefined {
  let counted = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = / b\/(.+)$/.exec(line)?.[1];
      counted = path !== undefined && !isUncounted(path);
      continue;
    }
    if (!counted || !/^[+-]/.test(line) || /^(?:\+\+\+|---) /.test(line)) continue;
    const word = HUNTER_WORDS.exec(line)?.[0];
    if (word !== undefined) return word;
  }
  return undefined;
}

function hunterPlan(ctx: RunContext, diff: string): ReaderPlan {
  if (!RISK_CLASS_READERS[ctx.ledger.cls].includes(HUNTER)) {
    return { reader: HUNTER, verdict: "not owed", why: `${ctx.ledger.cls}'s reader set has no hunter` };
  }
  const counted = measure(diff).counted;
  const word = hunterWord(diff);
  const min = ctx.hunterMinLines;
  if (counted < min && word === undefined) {
    return { reader: HUNTER, verdict: "sits out", why: `${counted} counted lines < ${min}, no catch/await/Promise` };
  }
  return {
    reader: HUNTER,
    verdict: "owed",
    why: word !== undefined ? `a changed line holds \`${word}\`` : `${counted} counted lines ≥ ${min}`,
  };
}

/** The stages whose read may owe security-review (at R2, when the fix trigger fires). After fix round
 *  2 — the last read, the escalate read, and the drift group — it never reads a fix. */
export const SECURITY_STAGES: ReadonlySet<PlanStage> = new Set(["confirm-1", "confirm-2"]);
const SECURITY_NOT_HERE: ReaderPlan = { reader: SECURITY, verdict: "not owed", why: "the security read of a fix is confirm-1 and confirm-2 only" };

function securityPlan(ctx: RunContext, fs: FixSecurityResult | null): ReaderPlan {
  if (fs === null) {
    return { reader: SECURITY, verdict: "not owed", why: `${ctx.ledger.cls}; the security read of a fix is R2 only` };
  }
  return fs.fires
    ? { reader: SECURITY, verdict: "owed", why: "R2; fix-security fires" }
    : { reader: SECURITY, verdict: "not owed", why: "R2; fix-security quiet" };
}

const RUN_MANIFEST = "run <manifest> --brief-file <brief> --no-exercise yourself";

/** Does this `amend brief:` commit change what the verifier grades (`gradedContent`)? A brief it
 *  cannot read on both sides, or cannot parse, counts as a change. */
function amendChangesGraded(ctx: RunContext, commit: string): boolean {
  const path = ctx.brief.path;
  if (path === null) return true;
  const at = (rev: string) => {
    const blob = blobOf(ctx.brief, rev, path);
    return ctx.briefOk(["cat-file", "-e", blob]) ? ctx.briefGit(["show", blob]) : null;
  };
  const before = at(`${commit}^`);
  const after = at(commit);
  if (before === null || after === null) return before !== after;
  try {
    return gradedContent(before) !== gradedContent(after);
  } catch (err) {
    if (err instanceof BriefPartError) return true;
    throw err;
  }
}

/**
 * The `amend brief:` commits a read over `from..to` holds. A brief in the code repo: the commits of
 * that range. A brief in the store: the store's commits on the brief since the run's record
 * (`briefOrder`) whose committer time is after `from`'s and no later than `to`'s, since a store
 * commit is in no code range and only its time places it among the reads. When `to` is HEAD there
 * is no upper bound: an amendment after the last code commit moves no code commit, so the read that
 * ends at HEAD is the only one that can hold it.
 */
function amendCommits(ctx: RunContext, from: string, to: string): string[] {
  const path = ctx.brief.path;
  if (!ctx.brief.store || path === null) {
    return ctx
      .git(["log", "--format=%H %s", `${from}..${to}`])
      .split("\n")
      .flatMap((l) => {
        const at = l.indexOf(" ");
        return at > 0 && l.slice(at + 1).startsWith(AMEND_BRIEF) ? [l.slice(0, at)] : [];
      });
  }
  const ct = (rev: string) => Number(ctx.git(["show", "-s", "--format=%ct", rev]).trim());
  const after = ct(from);
  const upTo = sameSha(to, ctx.head) ? Infinity : ct(to);
  return ctx
    .briefGit(["log", "--format=%H %ct %s", ...(ctx.brief.firstCommit === null ? [] : [`${ctx.brief.firstCommit}..HEAD`]), "--", path])
    .split("\n")
    .flatMap((l) => {
      const m = /^(\S+) (\d+) (.*)$/.exec(l);
      if (m === null || !m[3]!.startsWith(AMEND_BRIEF)) return [];
      const t = Number(m[2]);
      return t > after && t <= upTo ? [m[1]!] : [];
    });
}

/** The verifier at a read after a fix: owed at any read whose range holds an `amend brief:` commit (a
 *  fixer's or the session's own) that changes the deliverables or an assertion (`gradedContent`);
 *  at `confirm-1` also on a renamed path. An `amend brief:` that changes neither owes nothing, and
 *  the session runs the manifest itself, as at a `confirm-1` with no amend and no rename; a
 *  non-zero exit owes the verifier (CLOSE §The readers). */
function verifierPlan(ctx: RunContext, stage: Exclude<PlanStage, "drift">, from: string, to: string): ReaderPlan {
  if (ctx.ledger.fromBranch !== null) {
    return { reader: VERIFIER, verdict: "not owed", why: "--from-branch: no brief, no verifier" };
  }
  const amends = amendCommits(ctx, from, to);
  const graded = amends.some((c) => amendChangesGraded(ctx, c));
  const renamed =
    stage === "confirm-1" && ctx.git(["diff", "-M", "--diff-filter=R", "--name-only", from, to]).split("\n").some(Boolean);
  const inRange = stage === "confirm-1" ? "" : " in the range";
  if (graded || renamed) {
    const why = [graded ? `an \`amend brief:\` commit${inRange} changes the deliverables or assertions` : "", renamed ? "a renamed path" : ""];
    return { reader: VERIFIER, verdict: "owed", why: why.filter(Boolean).join(", ") };
  }
  if (amends.length > 0) {
    const one = amends.length === 1;
    return {
      reader: VERIFIER,
      verdict: "not owed",
      why: `the \`amend brief:\` commit${one ? "" : "s"}${inRange} change${one ? "s" : ""} no deliverable or assertion${stage === "confirm-1" ? ", no rename" : ""}`,
      instead: RUN_MANIFEST,
    };
  }
  return stage === "confirm-1"
    ? { reader: VERIFIER, verdict: "not owed", why: "no amend brief:, no rename", instead: RUN_MANIFEST }
    : { reader: VERIFIER, verdict: "not owed", why: "no `amend brief:` commit in the range" };
}

function notOwed(
  stage: PlanStage,
  key: string,
  group: number | null,
  why: string,
  range: StagePlan["range"] = null,
  pr: PrCodeResult | null = null
): StagePlan {
  return { stage, key, group, move: READ_MOVE_OF_STAGE[stage], owed: false, why, range, prCode: pr, fixSecurity: null, readers: [] };
}

/**
 * One stage's plan: whether its read is owed, the range, and each reader's verdict (§1.9 items 5
 * and 6). A drift stage plans the build's one drift group: `group` picks the recorded one; else
 * `drift` takes `from`, the head before main was merged (R.3) — the recorded group when `from` is its
 * start, a new group when none is recorded, and a refusal otherwise (a later move of main is a
 * `drift-merge:`) — and `drift-confirm` the recorded group.
 */
export function planStage(ctx: RunContext, stage: PlanStage, opts: { from?: string; group?: number } = {}): StagePlan {
  const move = READ_MOVE_OF_STAGE[stage];
  const r2 = ctx.ledger.cls === "R2";
  const groups = ctx.ledger.driftGroups;
  if (stage === "unbank") {
    const u = ctx.ledger.unbank;
    if (u === null) throw new Error("no `unbank:` line — write it once the banked rows' fix is in (UNBANK.md)");
    return {
      stage,
      key: "unbank",
      group: null,
      move,
      owed: true,
      why: `the operator answered ${u.ids.join(", ")}`,
      range: { from: u.from, to: u.sha },
      prCode: null,
      fixSecurity: null,
      readers: [{ reader: CURSORY, verdict: "owed", why: "the unbank read" }, SECURITY_NOT_HERE],
    };
  }
  if (stage === "drift") {
    let group: number;
    let from: string;
    if (opts.group !== undefined) {
      const g = groups[opts.group - 1];
      if (g === undefined) throw new Error(`no drift group ${opts.group} — the ledger holds ${groups.length}`);
      group = opts.group;
      from = g.read.from!;
    } else {
      const latest = groups.at(-1);
      const f = opts.from ?? latest?.read.from ?? null;
      if (f === null) throw new Error("--stage drift needs --from <the head before main was merged> (R.3)");
      if (latest !== undefined && !sameSha(f, latest.read.from!)) throw new Error(ONE_DRIFT_GROUP_PLAN);
      group = latest === undefined ? 1 : groups.length;
      from = f;
    }
    const key = `drift-${group}`;
    const prior = groups.slice(0, group - 1);
    const since = driftCheckpoint(ctx, prior);
    const sinceWhat = prior.length === 0 ? "the wave" : `drift group ${prior.length}`;
    const files = since === null ? null : mainDriftFiles(ctx, since);
    if (files === null) {
      throw new Error(`main's drift is unreadable — ${sinceWhat} has no sha= or the merge-base is unreadable`);
    }
    const merge = firstMergeAfter(ctx, from);
    if (files.length === 0 || merge === null) {
      return notOwed(
        stage,
        key,
        group,
        files.length === 0 ? `main changed none of the branch's files after ${sinceWhat}` : `no merge after ${from.slice(0, 9)} — merge origin/main first`
      );
    }
    return {
      stage,
      key,
      group,
      move,
      owed: true,
      why: `main changed ${files.length} of the branch's files after ${sinceWhat}`,
      range: { from, to: merge, files },
      prCode: null,
      fixSecurity: null,
      readers: [{ reader: CURSORY, verdict: "owed", why: "the drift read" }, SECURITY_NOT_HERE],
    };
  }

  let fix: FixLine | null;
  let fixMove: string;
  let group: number | null = null;
  let key: string = stage;
  let fixFile: string;
  if (stage === "drift-confirm") {
    group = opts.group ?? groups.length;
    key = `drift-confirm-${group}`;
    if (group === 0) return notOwed(stage, key, null, "no `drift-read:` line — no drift group ran");
    const g = groups[group - 1];
    if (g === undefined) throw new Error(`no drift group ${group} — the ledger holds ${groups.length}`);
    fix = g.fix;
    fixMove = `drift-fix (group ${group})`;
    fixFile = `fix-${driftRound(group)}.txt`;
  } else {
    const r = STAGE_FIX_ROUND[stage as PlainStage];
    fix = ctx.ledger.fixes.get(PLAIN_FIX[r].move) ?? null;
    fixMove = PLAIN_FIX[r].move;
    fixFile = PLAIN_FIX[r].file;
  }
  let from: string;
  let to: string;
  let pr: PrCodeResult;
  let owed: boolean;
  let why: string;
  if (fix === null) {
    // No fixer ran. A session commit the round's table saw (an `amend brief:` after a fix, a fix for
    // a red check) still owes this read over it: the next round reads from here, not before.
    const noFix = `no \`${fixMove.replace(/ \(.*\)$/, "")}:\` line — the round had no rows`;
    const r = group === null ? STAGE_FIX_ROUND[stage as PlainStage] : null;
    const round = r === null ? undefined : ctx.table?.rounds[r];
    const upTo = r === null ? null : readUpTo(ctx, r);
    if (round === undefined || upTo === null) return notOwed(stage, key, group, noFix);
    pr = prCodeOf(ctx, upTo.sha, round.head);
    if (pr.paths.length === 0) return notOwed(stage, key, group, noFix);
    from = upTo.sha;
    to = round.head;
    owed = true;
    why = `no fixer ran, and the PR's code changed after ${upTo.what} ${from.slice(0, 9)} (${shown(pr.paths)}) — the read covers the session's commit`;
  } else {
    ({ from, sha: to } = fix);
    pr = prCodeOf(ctx, from, to);
    ({ owed, why } = fixedStageOwed(ctx, stage, fix, fixMove, fixFile, pr));
  }
  if (!owed) return notOwed(stage, key, group, why, { from, to }, pr);
  const diff = diffOf(ctx, from, to);
  const securityStage = SECURITY_STAGES.has(stage);
  const fs = r2 && securityStage ? fixSecurityOf(ctx, diff) : null;
  const readers: ReaderPlan[] = [{ reader: CODEX, verdict: "owed", why: "every read after a fix" }];
  readers.push(
    stage === "confirm-1"
      ? hunterPlan(ctx, diff)
      : { reader: HUNTER, verdict: "not owed", why: "confirm-1 only" }
  );
  readers.push(securityStage ? securityPlan(ctx, fs) : SECURITY_NOT_HERE);
  readers.push(verifierPlan(ctx, stage, from, to));
  return { stage, key, group, move, owed, why, range: { from, to }, prCode: pr, fixSecurity: fs, readers };
}

/** Whether a read after a fix line is owed, and why (§1.9 item 5). */
function fixedStageOwed(
  ctx: RunContext,
  stage: Exclude<PlanStage, "drift">,
  fix: FixLine,
  fixMove: string,
  fixFile: string,
  pr: PrCodeResult
): { owed: boolean; why: string } {
  const { from, sha: to } = fix;
  let owed: boolean;
  let why: string;
  switch (stage) {
    case "confirm-1":
      owed = true;
      why = "fix-1 exists";
      break;
    case "confirm-2":
    case "last": {
      const drops = droppedOrRelabelled(readFixFile(ctx, fixFile));
      const changed = stage === "confirm-2" ? changedFiles(ctx, from, to).length > 0 : pr.paths.length > 0;
      owed = changed || drops > 0;
      const what = stage === "confirm-2" ? "changed no file" : "changed none of the PR's code";
      why = owed
        ? [changed ? (stage === "confirm-2" ? "the round changed a file" : "the round changed the PR's code") : "", drops > 0 ? `${drops} row(s) dropped or re-labelled` : ""]
            .filter(Boolean)
            .join("; ")
        : `${fixMove} ${what} and dropped no row`;
      break;
    }
    case "escalate":
      owed = true;
      why = "escalate exists";
      break;
    default:
      owed = changedFiles(ctx, from, to).length > 0;
      why = owed ? "drift-fix changed a file" : "drift-fix changed no file";
      break;
  }
  return { owed, why };
}

function waveDrift(ctx: RunContext): string[] | null {
  const waveSha = ctx.ledger.lines.get("wave")?.fields.sha ?? null;
  return waveSha === null ? null : mainDriftFiles(ctx, waveSha);
}

/** The sha a drift group ended at: its confirm's, else its fix's, else its read's. */
function groupEnd(group: DriftGroup): string {
  return (group.confirm ?? group.fix ?? group.read).sha;
}

/**
 * Checks each `drift-merge:` in order and returns where main's drift is measured from after the drift
 * group: the last good merge line's `sha=`, else the group's end. A merge line counts when its `from=`
 * is at or after the previous checkpoint, its `sha=` is in HEAD's history, and its range holds a
 * merge on the branch's first-parent line; each one that does not is a failure and moves nothing.
 */
function driftMergeCheckpoint(ctx: RunContext, groupEndSha: string, failures: string[]): { sha: string; what: string } {
  let at = { sha: groupEndSha, what: "the drift group" };
  ctx.ledger.driftMerges.forEach((m, i) => {
    const label = `drift-merge (${i + 1})`;
    if (!ctx.gitOk(["merge-base", "--is-ancestor", at.sha, m.from])) {
      failures.push(`${label}: from=${m.from} is not after ${at.what}'s sha=${at.sha} — a drift-merge starts at the head the last one ended at, or later`);
      return;
    }
    if (!ctx.gitOk(["merge-base", "--is-ancestor", m.sha, "HEAD"])) {
      failures.push(`${label}: sha=${m.sha} is not in this branch's history`);
      return;
    }
    const merges = ctx.git(["rev-list", "--merges", "--first-parent", `${m.from}..${m.sha}`]).split("\n").filter(Boolean);
    if (merges.length === 0) {
      failures.push(`${label}: ${m.from.slice(0, 9)}..${m.sha} holds no merge — merge origin/main and write ${DRIFT_MERGE_FORM}`);
      return;
    }
    at = { sha: m.sha, what: `drift-merge ${i + 1}` };
  });
  return at;
}

/** Where main's drift is measured from after these groups: the last one's end, or the wave's sha. */
function driftCheckpoint(ctx: RunContext, groups: readonly DriftGroup[]): string | null {
  const last = groups.at(-1);
  return last !== undefined ? groupEnd(last) : (ctx.ledger.lines.get("wave")?.fields.sha ?? null);
}

// ── The owed set ─────────────────────────────────────────────────────────────────────────────

export interface OwedReader {
  reader: StageReaderName;
  why: string;
}

export interface OwedFacts {
  fromBranch: boolean;
  /** The brief, or on `--from-branch` the hand-test file. */
  briefPath: string | null;
  /** Claim ids at HEAD. */
  claims: string[];
  claimsAtFirst: number | null;
  targets: string[] | "all";
  /** The fixer model every `fix-<r>` and `drift-fix` line owes; `escalate` is always opus. */
  model: FixModel | null;
  /** Every ledger move the run owes (`hand-test-1`, not `hand-test-<n>`). */
  lines: string[];
  /** Per owed read, keyed by its stage folder's key (`confirm-1`, `last`, `drift-2`), the readers it owes. */
  readers: Record<string, OwedReader[]>;
  markerChecks: MarkerCheckName[];
  /** Facts that already fail, one line each. */
  failures: string[];
  /** Said, not failed: signals fallbacks, a drift read main did not need. */
  notes: string[];
}

/** The fixer model a run owes (§1.9 item 2): the brief's, or opus at R2 and sonnet below for a
 *  floor-check (`model: session`) or `--from-branch` run. */
export function owedModel(ledger: Ledger, briefModel: BriefModel | null): FixModel | null {
  if (briefModel === "opus" || briefModel === "sonnet") return briefModel;
  if (briefModel === "session" || ledger.fromBranch !== null) return ledger.cls === "R2" ? "opus" : "sonnet";
  return null;
}

/**
 * The `build:` line's `parts=` against the brief's parts (build-spec-2 §1.4). Owed only when the
 * brief has a `## Parts` section and `agent=` is not `none`; with `agent=none` (a floor check, or a
 * run entered at CLOSE on a branch built before it) `parts=` must be absent. A present `parts=` is
 * checked whether owed or not: each brief part once, at its brief model, `session` with `none` and
 * only with it, and its ids adding up to `agent=`. Empty `briefParts` (an unreadable brief, already
 * a failure) checks nothing against the brief.
 */
export function buildPartsFailures(
  build: NonNullable<Ledger["build"]>,
  briefParts: readonly Part[],
  partsDeclared: boolean
): string[] {
  const out: string[] = [];
  const got = build.parts ?? null;
  if (build.agents.length === 0) {
    if (got !== null) {
      out.push("build: parts= with agent=none — a floor check or a branch built before this run spawned no builder; drop parts=");
    }
    return out;
  }
  if (got === null) {
    if (partsDeclared && briefParts.length > 0) {
      const form = briefParts.map((p) => `${p.id}:${p.model}:${p.model === "session" ? "none" : "<id>"}`).join(",");
      out.push(`build: no parts= — the brief has a \`## Parts\` section; write parts=${form}`);
    }
    return out;
  }
  const token = (e: { part: string; model: string; agents: string[] }) =>
    `${e.part}:${e.model}:${e.agents.length === 0 ? "none" : e.agents.join("+")}`;
  if (briefParts.length > 0) {
    for (const e of got) {
      const p = briefParts.find((b) => b.id === e.part);
      if (p === undefined) out.push(`build: parts=${token(e)} — the brief has no part ${e.part}`);
      else if (e.model !== p.model) out.push(`build: parts=${e.part}:${e.model} — the brief says ${e.part} is ${p.model}`);
    }
    for (const p of briefParts) {
      if (!got.some((e) => e.part === p.id)) out.push(`build: parts= has no ${p.id} — every brief part appears once (${p.id} is ${p.model})`);
    }
  }
  for (const e of got) {
    if (e.model === "session" && e.agents.length > 0) {
      out.push(`build: parts=${token(e)} — the session wrote ${e.part}, so no agent built it; write ${e.part}:session:none`);
    } else if (e.model !== "session" && e.agents.length === 0) {
      out.push(`build: parts=${token(e)} — ${e.part} ran on ${e.model}, so it names its builder's agent id; only a session part is none`);
    }
  }
  const named = got.flatMap((e) => e.agents);
  for (const id of named.filter((id) => !build.agents.includes(id))) {
    out.push(`build: parts= names agent ${id} — not in agent=${build.agents.join(",")}`);
  }
  for (const id of build.agents.filter((id) => !named.includes(id))) {
    out.push(`build: agent=${id} is in no part of parts=`);
  }
  return out;
}

/** The fix rounds this run's rounds and ledger name, in build order. */
function fixRoundsOf(ctx: RunContext): FixRound[] {
  const drifts = new Set<number>(ctx.ledger.driftGroups.map((_, i) => i + 1));
  for (const id of Object.keys(ctx.table?.rounds ?? {})) {
    const g = driftGroupOf(id);
    if (g !== null) drifts.add(g);
  }
  return [...FIXED_ROUND_IDS, ...[...drifts].sort((a, b) => a - b).map(driftRound)];
}

/**
 * What the run owes and which of its facts already fail (§1.9 items 1–12). Pure over its inputs
 * except for git, the run dir, and the signals arms, all injectable. The gate adds its own checks on
 * top (the wave's readers) and prints every failure.
 */
export async function owedFacts(
  ledger: Ledger,
  runDir: string,
  repo: string,
  base: string,
  deps: OwedDeps = {}
): Promise<OwedFacts> {
  const ctx = await runContext(ledger, runDir, repo, base, deps);
  return owedFactsFrom(ctx);
}

/**
 * The marker's owed checks (§1.10): `freshen` and `wave` always; `fix` and `confirm` when any round
 * has rows; `hand-test` when the brief (or the `--from-branch` block) has claims, at any class;
 * `verifier` on a briefed run. It reads no signals arm, so the merge check can ask it without one.
 */
export function markerChecksOf(ctx: RunContext): MarkerCheckName[] {
  const table = ctx.table;
  const anyRows =
    table !== null
      ? fixRoundsOf(ctx).some((r) => (table.rounds[r]?.rows.length ?? 0) > 0)
      : ctx.ledger.fixes.size > 0 || ctx.ledger.driftGroups.some((g) => g.fix !== null);
  const checks: MarkerCheckName[] = ["freshen", "wave"];
  if (anyRows) checks.push("fix", "confirm");
  if (ctx.brief.claims.length > 0) checks.push("hand-test");
  if (ctx.ledger.fromBranch === null) checks.push("verifier");
  return checks;
}

/** The start of the range a round's head must not have moved past unread: the prior round's fix
 *  line's `sha`, else the prior round's head; the wave's `sha` before round 1; the drift read's head
 *  for a drift group's round. Null for `final` (commits after it are item 10's) and when unknown.
 *  It is also where the round's own fix line's `from=` may start: a session commit between the two
 *  joins the read after the round. */
function readUpTo(ctx: RunContext, r: FixRound): { sha: string; what: string } | null {
  const group = driftGroupOf(r);
  if (group !== null) {
    const read = ctx.ledger.driftGroups[group - 1]?.read;
    return read ? { sha: read.sha, what: `drift group ${group}'s read` } : null;
  }
  if (r === "1") {
    const sha = ctx.ledger.lines.get("wave")?.fields.sha;
    return sha === undefined ? null : { sha, what: "the wave" };
  }
  const prior = r === "2" ? "1" : r === "3" ? "2" : "3";
  const fix = fixOfRound(ctx.ledger, prior);
  if (fix.line !== null) return { sha: fix.line.sha, what: `${fix.move}'s sha` };
  const round = ctx.table?.rounds[prior];
  return round ? { sha: round.head, what: `round ${prior}'s head` } : null;
}

/** Owed readers named on one read line, its `sha`, and its stage folder's files. */
function checkRead(
  ctx: RunContext,
  failures: string[],
  label: string,
  plan: StagePlan,
  read: ReadLine,
  folder: string
): void {
  for (const o of plan.readers.filter((p) => p.verdict === "owed")) {
    const named = read.readers.some(
      (t) => t.reader === o.reader || (o.reader === CODEX && t.reader === CURSORY && t.codexFailed !== null)
    );
    if (!named) {
      failures.push(
        `${label}: names no ${o.reader} — owed (${o.why})${o.reader === CODEX ? "; a failed Codex run is `review-cursory (codex failed: <why>)`" : ""}`
      );
    }
  }
  if (plan.range !== null && !sameSha(read.sha, plan.range.to)) {
    failures.push(
      `${label}: sha=${read.sha} — the read covers ${plan.range.from.slice(0, 9)}..${plan.range.to}, so it names ${plan.range.to}; a read at another head read other code — run it again over that range`
    );
  }
  let present: Set<string>;
  try {
    present = new Set(readerFiles(join(ctx.runDir, folder)).map((f) => f.reader));
  } catch {
    failures.push(`${label}: no ${folder}/ folder in the run dir`);
    return;
  }
  if (!SECURITY_STAGES.has(plan.stage) && read.readers.some((t) => t.reader === SECURITY)) {
    failures.push(`${label}: names ${SECURITY} — it reads a fix at confirm-1 and confirm-2 only`);
  }
  for (const t of read.readers) {
    if (!present.has(t.reader)) {
      failures.push(`${label}: names ${t.codexFailed === null ? t.reader : `${t.reader} (codex failed)`} — no ${folder}/${t.reader}.md`);
    }
  }
}

/** `owedFacts` over a context already gathered. */
export function owedFactsFrom(ctx: RunContext): OwedFacts {
  const { ledger } = ctx;
  const fromBranch = ledger.fromBranch !== null;
  const failures: string[] = [...ctx.briefFailures];
  const notes: string[] = [];
  const lines = new Set<string>(["flow", "steps", "freshen", "wave", "verifier", "hand-test-1", "ship"]);
  if (fromBranch) {
    lines.add("from-branch");
    lines.add("hand-test-block");
  } else {
    lines.add("brief");
    lines.add("build");
  }
  const groups = ledger.driftGroups;
  // The banked ids the operator answered (UNBANK.md): their table row, open row, and `banked:` id no longer fail.
  const answered = new Set(ledger.unbank?.ids ?? []);

  // 2. The owed model.
  const model = owedModel(ledger, ctx.brief.model);
  if (model !== null) {
    const fixLines: [string, FixLine][] = [
      ...[...ledger.fixes].map(([m, f]) => [m, f] as [string, FixLine]),
      ...groups.flatMap((g, i) => (g.fix ? [[`drift-fix (group ${i + 1})`, g.fix] as [string, FixLine]] : [])),
    ];
    for (const [move, fix] of fixLines) {
      const want = move === "escalate" ? "opus" : model;
      if (fix.model !== want) {
        failures.push(
          move === "escalate"
            ? `escalate: model=${fix.model} — the escalate round runs on opus`
            : `${move}: model=${fix.model} — this run owes ${want} (${ctx.brief.model === "opus" || ctx.brief.model === "sonnet" ? "the brief's model: line" : `${ledger.cls}, ${fromBranch ? "--from-branch" : "floor check"}`})`
        );
      }
    }
  }
  if (!fromBranch && ledger.build !== null && ctx.brief.model !== null && ledger.build.model !== ctx.brief.model) {
    failures.push(`build: model=${ledger.build.model} — the brief says model: ${ctx.brief.model}`);
  }
  if (!fromBranch && ledger.build !== null) {
    failures.push(...buildPartsFailures(ledger.build, ctx.brief.parts, ctx.brief.partsDeclared));
  }

  // 3. Rounds.
  const table = ctx.table;
  if (table === null) failures.push(ctx.tableError ?? "no table.json");
  const roundOf = (r: RoundId): Round | FinalRound | undefined => table?.rounds[r];
  const fixRounds = fixRoundsOf(ctx);
  if (table !== null) {
    const owedRounds: RoundId[] = [...FIXED_ROUND_IDS, "final", ...groups.map((_, i) => driftRound(i + 1))];
    for (const r of owedRounds) {
      if (roundOf(r) === undefined) {
        failures.push(`table.json has no round \`${r}\` — run \`reviewTable.ts build --run-dir <d> --round ${r}\``);
      }
    }
    for (const r of fixRounds) {
      const g = driftGroupOf(r);
      if (g !== null && g > groups.length && roundOf(r) !== undefined) {
        failures.push(`table.json round ${r}: the ledger records ${groups.length} drift group(s) — a drift round needs its group's \`drift-read:\` line`);
      }
    }
    // A decision row the session answered itself (CLOSE 4a) no longer fails once a round took the
    // `SESSION` block that carries its answer to a fixer.
    const settled = new Set(answered);
    const rounds = Object.values(table.rounds).filter((r): r is Round => r !== undefined);
    const held = new Set(rounds.flatMap((r) => heldIds(r)));
    const decisionRows = new Set(rounds.flatMap((r) => r.banked.map((b) => b.id)));
    for (const a of ledger.answered) {
      if (!decisionRows.has(a.id)) failures.push(`answered: ${a.id} — no round banked it; name a row a fixer's \`decision\` line holds`);
      else if (!held.has(a.by)) {
        failures.push(
          `answered: ${a.id} | by=${a.by} — no round of table.json holds ${a.by}; write the answer as a SESSION block at the next read's stage and build that round`
        );
      } else settled.add(a.id);
    }
    // `final` gathers every round's banked rows, so a row is named once, by the first round holding it.
    const bankedSeen = new Set<string>();
    for (const [id, round] of Object.entries(table.rounds)) {
      if (round && round.refused.length > 0) {
        failures.push(
          `table.json round ${id} refused ${round.refused.map((f) => f.file).join(", ")} — re-spawn that reader once, rename a refused Codex file \`<name>.refused.txt\`, re-build the round`
        );
      }
      const banked = (round?.banked ?? []).map((b) => b.id).filter((b) => !bankedSeen.has(b) && !settled.has(b));
      for (const b of banked) bankedSeen.add(b);
      if (banked.length > 0) {
        failures.push(`table.json round ${id} banked ${banked.join(", ")} — a fixer's decision row does not ship; answer the question first`);
      }
    }
    const replay = { runDir: ctx.runDir, repo: ctx.repo, ledger, table, merge: ctx.merge, ...(ctx.exec ? { exec: ctx.exec } : {}) };
    failures.push(...staleRounds(replay), ...unreadFiles(replay));
  }
  for (const r of fixRounds) {
    const { move, file, line } = fixOfRound(ledger, r);
    const round = roundOf(r);
    if (round === undefined) {
      if (line !== null && table !== null) failures.push(`${move}: its round \`${r}\` is not in table.json`);
      continue;
    }
    const unfixed = round.rows.filter((row) => !isFixedAt(row.kind, r));
    if (unfixed.length > 0) {
      failures.push(
        `table.json round ${r} holds ${unfixed.map((row) => `${row.id} (${row.kind})`).join(", ")} — round ${r} does not fix that kind; re-build it with \`reviewTable.ts build --round ${r}\``
      );
    }
    // A session commit between rounds joins the read after this round: the fix line's `from=` starts
    // at `upTo`, so its confirm reads the commit with the fixer's; with no fixer, `planStage` owes
    // that read over `upTo..head` itself, and the read's own checks below hold it.
    const upTo = readUpTo(ctx, r);
    const readMove = driftGroupOf(r) === null ? READ_OF_ROUND[r as PlainRound] : "drift-confirm";
    if (upTo !== null) {
      const unread = prCodeOf(ctx, upTo.sha, round.head).paths;
      const covered = line !== null ? sameSha(line.from, upTo.sha) : driftGroupOf(r) === null;
      if (unread.length > 0 && !covered) {
        const how =
          line !== null
            ? `write \`${move.replace(/ \(.*\)$/, "")}: … | from=${upTo.sha}\` so ${readMove} reads it with the fixer's commits`
            : "a drift round with no rows has no read after it";
        failures.push(
          `table.json round ${r} was built at ${round.head}, and the PR's code changed after ${upTo.what} ${upTo.sha} with no read (${shown(unread)}) — a session commit between rounds joins the next read: ${how}; or revert it`
        );
      }
    }
    if (round.rows.length > 0 && driftGroupOf(r) === null) lines.add(move);
    if (round.rows.length > 0 && line === null && driftGroupOf(r) !== null) {
      failures.push(`missing line: drift-fix: — drift group ${driftGroupOf(r)}'s round has ${round.rows.length} rows`);
    }
    if (line === null) continue;
    if (round.rows.length === 0) {
      failures.push(`${move}: round ${r} had no rows, so no fixer ran — the line must not exist`);
      continue;
    }
    if (line.rows !== round.rows.length) {
      failures.push(`${move}: ${line.fixed}/${line.rows} — round ${r} holds ${round.rows.length} rows`);
    }
    try {
      const fix = readFixFile(ctx, file, { rows: round.rows.map((row) => row.id), round: r });
      const fixed = fix.lines.filter((l) => l.action === "fixed");
      if (line.fixed !== fixed.length) failures.push(`${move}: ${line.fixed} fixed — ${file} has ${fixed.length} \`fixed\` lines`);
      // A `fixed` line names a commit of the fixer's: after the round's head (where the fixer
      // started, past any session commit `from=` also covers), at or before `sha`.
      for (const l of fixed) {
        if (l.action !== "fixed") continue;
        const inRange =
          !sameSha(l.sha, round.head) &&
          ctx.gitOk(["merge-base", "--is-ancestor", round.head, l.sha]) &&
          ctx.gitOk(["merge-base", "--is-ancestor", l.sha, line.sha]);
        if (!inRange) {
          failures.push(
            `${move}: ${l.row} · fixed · ${l.sha} — not a commit in this round's range ${round.head}..${line.sha}; a row the round did not change is \`dropped\`, which owes the read`
          );
        }
      }
    } catch (err) {
      failures.push(`${move}: ${(err as Error).message}`);
    }
    const fromUpTo = upTo !== null && sameSha(line.from, upTo.sha) && ctx.gitOk(["merge-base", "--is-ancestor", upTo.sha, round.head]);
    if (!sameSha(line.from, round.head) && !fromUpTo) {
      failures.push(
        `${move}: from=${line.from} — round ${r} was built at ${round.head}; from= is the round's head${upTo === null || sameSha(upTo.sha, round.head) ? "" : `, or ${upTo.what} ${upTo.sha} when the session committed after it`}`
      );
    }
    if (!ctx.gitOk(["merge-base", "--is-ancestor", line.from, line.sha])) {
      failures.push(`${move}: from=${line.from} is not an ancestor of sha=${line.sha}`);
    }
    if (!ctx.gitOk(["merge-base", "--is-ancestor", line.sha, "HEAD"])) {
      failures.push(`${move}: sha=${line.sha} is not an ancestor of HEAD ${ctx.head}`);
    }
  }

  // 5 and 6. Reads owed, the readers each owes, and the head each read.
  const readers: Record<string, OwedReader[]> = {};
  const plan = (stage: PlanStage, opts: { group?: number } = {}): StagePlan | null => {
    try {
      return planStage(ctx, stage, opts);
    } catch (err) {
      if (err instanceof ArmEnvError) throw err;
      failures.push(`${READ_MOVE_OF_STAGE[stage]}${opts.group ? ` (group ${opts.group})` : ""}: ${(err as Error).message}`);
      return null;
    }
  };
  const owedOf = (p: StagePlan) => p.readers.filter((r) => r.verdict === "owed").map((r) => ({ reader: r.reader, why: r.why }));
  for (const stage of Object.keys(STAGE_FIX_ROUND) as PlainStage[]) {
    const p = plan(stage);
    if (p === null || !p.owed) continue;
    const move = READ_MOVE_OF_STAGE[stage] as Exclude<ReadMove, "drift-read" | "drift-confirm" | "unbank-read">;
    lines.add(move);
    readers[p.key] = owedOf(p);
    const read = ledger.reads.get(move);
    if (read !== undefined) checkRead(ctx, failures, move, p, read, READ_MOVE_FOLDER[move]);
  }
  for (const [move, read] of ledger.reads) {
    const stage = (Object.keys(STAGE_FIX_ROUND) as PlainStage[]).find((s) => READ_MOVE_OF_STAGE[s] === move)!;
    if (readers[stage] !== undefined) continue;
    // A read no plan owed: its folder still holds what it names.
    const folder = READ_MOVE_FOLDER[move];
    try {
      const present = new Set(readerFiles(join(ctx.runDir, folder)).map((f) => f.reader));
      for (const t of read.readers) if (!present.has(t.reader)) failures.push(`${move}: names ${t.reader} — no ${folder}/${t.reader}.md`);
    } catch {
      failures.push(`${move}: no ${folder}/ folder in the run dir`);
    }
  }
  groups.forEach((g, i) => {
    const group = i + 1;
    const read = plan("drift", { group });
    if (read !== null) {
      if (read.owed) readers[read.key] = owedOf(read);
      checkRead(ctx, failures, `drift-read (group ${group})`, read.owed ? read : { ...read, readers: [] }, g.read, readMoveFolder("drift-read", group));
      if (!read.owed) notes.push(`drift-read (group ${group}): recorded, though ${read.why}`);
    }
    const confirm = plan("drift-confirm", { group });
    if (confirm === null) return;
    if (confirm.owed) {
      readers[confirm.key] = owedOf(confirm);
      if (g.confirm === null) failures.push(`missing line: drift-confirm: — drift group ${group}'s fix changed a file`);
    }
    if (g.confirm !== null) {
      checkRead(ctx, failures, `drift-confirm (group ${group})`, confirm.owed ? confirm : { ...confirm, readers: [] }, g.confirm, readMoveFolder("drift-confirm", group));
    }
  });

  // 7. The hand test.
  const claims = ctx.brief.claims.map((c) => c.id);
  let files: ReturnType<typeof handTestFiles> = [];
  try {
    files = handTestFiles(ctx.runDir);
  } catch (err) {
    failures.push(`hand test: ${(err as Error).message}`);
  }
  for (const f of files) {
    for (const l of missingHandTestOutputs(ctx.runDir, f.lines)) {
      failures.push(`hand-test-${f.n}.txt: ${l.claim}'s output ${l.output} is not in the run dir — the hand tester writes the real output there`);
    }
  }
  if (ctx.brief.path !== null && ctx.briefFailures.length === 0) {
    if (claims.length === 0) {
      const only = ledger.handTests.length === 1 && ledger.handTests[0]!.skipped;
      if (ledger.handTests.length > 0 && !only) {
        failures.push("hand-test: the brief has no claims — `hand-test-1: skipped — no claims` is the only hand-test line");
      }
    } else {
      if (ledger.handTests.some((h) => h.skipped)) {
        failures.push(`hand-test-1: skipped — the brief has ${claims.length} claims (${claims.join(", ")}); run them`);
      }
      for (const h of ledger.handTests) {
        if (h.skipped) continue;
        const f = files.find((x) => x.n === h.n);
        if (f === undefined) {
          failures.push(`hand-test-${h.n}: no hand-test-${h.n}.txt in the run dir`);
          continue;
        }
        const pass = f.lines.filter((l) => l.result === "pass").length;
        if (pass !== h.pass || f.lines.length !== h.ran) {
          failures.push(`hand-test-${h.n}: ${h.pass}/${h.ran} — hand-test-${h.n}.txt shows ${pass}/${f.lines.length}`);
        }
      }
      for (const f of files) {
        if (!ledger.handTests.some((h) => h.n === f.n)) {
          failures.push(`hand-test-${f.n}.txt has no \`hand-test-${f.n}:\` ledger line`);
        }
      }
      for (const s of claimStates(ctx, files)) if (!s.passed) failures.push(`hand test: ${s.why} — re-run it`);
    }
  }

  // 8. The verifier.
  const v = ledger.verifier;
  if (fromBranch) {
    if (v !== null && v.verdict !== "N/A") {
      failures.push("verifier: a --from-branch run has no brief — write `verifier: N/A (from-branch, no brief)`");
    }
  } else if (v !== null) {
    if (v.verdict === "N/A") {
      failures.push("verifier: N/A (from-branch, no brief) with no `from-branch:` line — only the line proves no brief exists (QRK-596)");
    } else if (v.verdict === "CLEAN") {
      // The verifier's last read wins: the wave's, or the latest read after a fix that owed it.
      const reads = [
        "build-verifier.md",
        ...["confirm-1", "confirm-2", "last", "escalate"].map((s) => `stage-${s}/build-verifier.md`),
        ...groups.map((_, i) => `${readMoveFolder("drift-confirm", i + 1)}/build-verifier.md`),
      ];
      const rel = reads.filter((f) => existsSync(join(ctx.runDir, f))).at(-1) ?? "build-verifier.md";
      const file = join(ctx.runDir, rel);
      if (!existsSync(file)) failures.push(`verifier: CLEAN — no ${rel} in the run dir`);
      else {
        try {
          const verdict = parseVerdict(readFileSync(file, "utf8"));
          if (verdict?.verdict !== "CLEAN") {
            failures.push(
              `verifier: CLEAN — ${rel} ends ${verdict === null ? "with no VERDICT: line" : `VERDICT: INCOMPLETE — ${verdict.check}`}; clear it by a hand-test claim (\`CLEARED | by=hand-test-<n>:H<k>\`) or re-run the check`
            );
          }
        } catch (err) {
          failures.push(`verifier: ${rel}: ${(err as Error).message}`);
        }
      }
    } else {
      const f = files.find((x) => x.n === v.handTest);
      const line = f?.lines.find((l) => l.claim === v.claim);
      if (line?.result !== "pass") {
        failures.push(
          `verifier: CLEARED by hand-test-${v.handTest}:${v.claim} — ${f === undefined ? `no hand-test-${v.handTest}.txt` : line === undefined ? `${v.claim} did not run there` : `${v.claim} failed there`}`
        );
      }
    }
  }

  // 9 and 10. The open set and the leftovers.
  const final = roundOf("final") as FinalRound | undefined;
  if (final !== undefined) {
    const open = final.open.filter((o) => !answered.has(o.id));
    if (open.length > 0) {
      failures.push(`final: open ${open.map((o) => `${o.id} ${o.kind}`).join(", ")} — the PR stays draft; the operator decides`);
    }
    if (final.leftovers.length > 0) lines.add("leftovers");
    if (ledger.leftovers !== null && ledger.leftovers.rows !== final.leftovers.length) {
      failures.push(`leftovers: rows=${ledger.leftovers.rows} — final holds ${final.leftovers.length} leftovers`);
    }
  }

  // 11. Main's drift. The build's one drift group is judged; after it, each `drift-merge:` must hold
  // a merge of main after the group's end (or the last `drift-merge:`), and main's drift is measured
  // from the last of those (the wave's sha when no group ran).
  groups.forEach((g, i) => {
    const merge = firstMergeAfter(ctx, g.read.from!);
    if (merge === null) {
      failures.push(`drift-read (group ${i + 1}): from=${g.read.from} — no merge of main after it`);
      return;
    }
    const r = driftRound(i + 1);
    const driftRoundHere = roundOf(r);
    if (driftRoundHere !== undefined && !ctx.gitOk(["merge-base", "--is-ancestor", merge, driftRoundHere.head])) {
      failures.push(
        `table.json round ${r} was built at ${driftRoundHere.head}, before drift group ${i + 1}'s merge ${merge} — re-build it after the merge: \`${rebuildCommand(ctx.runDir, r, merge)}\``
      );
    }
  });
  const driftFiles = waveDrift(ctx);
  const latest = groups.at(-1);
  const since = latest === undefined ? null : driftMergeCheckpoint(ctx, groupEnd(latest), failures);
  if (driftFiles === null) {
    failures.push("main drift unreadable — the wave line has no sha= or the merge-base is unreadable");
  } else if (driftFiles.length > 0) {
    lines.add("drift-read");
    if (since === null) {
      failures.push(
        `origin/main advanced on ${driftFiles.length} of this branch's files after the wave (${shown(driftFiles)}) — merge it and run the drift read (build-spec §2.3 Drift at SHIP)`
      );
    } else {
      const again = mainDriftFiles(ctx, since.sha);
      if (again === null) failures.push(`main drift unreadable after ${since.what} (sha=${since.sha})`);
      else if (again.length > 0) {
        failures.push(
          `origin/main advanced again on ${shown(again)} after ${since.what} (sha=${since.sha}) — merge origin/main and write ${DRIFT_MERGE_FORM}`
        );
      }
    }
  }

  // 12. The ship line; and a banked run.
  const shipSha = ledger.lines.get("ship")?.fields.sha;
  if (shipSha !== undefined && !sameSha(shipSha, ctx.head)) {
    failures.push(`ship: sha=${shipSha} is not HEAD ${ctx.head} — commits landed after the ship line; re-run SHIP`);
  }
  const stillBanked = ledger.banked.filter((id) => !answered.has(id));
  if (stillBanked.length > 0) {
    failures.push(`banked: ${stillBanked.join(", ")} — a banked run does not ship; answer the questions first`);
  }

  // 13. The unbank: the banked rows' fix, and its one cursory read.
  const u = ledger.unbank;
  if (u === null) {
    if (ledger.unbankRead !== null) failures.push("unbank-read: no `unbank:` line — the read follows the banked rows' fix");
  } else {
    lines.add("unbank-read");
    for (const id of u.ids.filter((i) => !ledger.banked.includes(i))) {
      failures.push(`unbank: ${id} was never banked — name only ids a \`banked:\` line holds`);
    }
    if (u.model !== null && model !== null && u.model !== model) failures.push(`unbank: model=${u.model} — this run owes ${model}`);
    if (!ctx.gitOk(["merge-base", "--is-ancestor", u.from, u.sha])) failures.push(`unbank: from=${u.from} is not an ancestor of sha=${u.sha}`);
    if (!ctx.gitOk(["merge-base", "--is-ancestor", u.sha, "HEAD"])) failures.push(`unbank: sha=${u.sha} is not an ancestor of HEAD ${ctx.head}`);
    // `from=` is the head the run banked at: the escalate round's end, or a later head with no PR code between.
    const esc = fixOfRound(ledger, "escalate").line?.sha ?? table?.rounds.escalate?.head ?? null;
    if (esc !== null) {
      const unread = ctx.gitOk(["merge-base", "--is-ancestor", esc, u.from]) ? prCodeOf(ctx, esc, u.from).paths : null;
      if (unread === null || unread.length > 0) {
        failures.push(
          `unbank: from=${u.from} — the run banked at the escalate round's end ${esc}${unread === null ? ", which is not its ancestor" : `, and the PR's code changed after it with no read (${shown(unread)})`}; from= is the head the run banked at`
        );
      }
    }
    const p = plan("unbank");
    if (p !== null) {
      readers[p.key] = owedOf(p);
      if (ledger.unbankRead !== null) checkRead(ctx, failures, "unbank-read", p, ledger.unbankRead, READ_MOVE_FOLDER["unbank-read"]);
    }
  }

  // Every owed line is present (item 11 already said what a missing drift read owes; each drift
  // group's own lines are judged above).
  for (const move of lines) {
    if (!ledger.lines.has(move) && move !== "drift-read") failures.push(`missing line: ${move}:`);
  }

  const markerChecks = markerChecksOf(ctx);

  return {
    fromBranch,
    briefPath: ctx.brief.path,
    claims,
    claimsAtFirst: ctx.brief.claimsAtFirst,
    targets: ctx.brief.targets,
    model,
    lines: [...lines],
    readers,
    markerChecks,
    failures,
    notes: [...notes, ...ctx.notes],
  };
}
