/**
 * `shipGate.ts` — SHIP's enforcement half (`/build` §SHIP). Turns the run's ship ledger into an
 * exit code by checking its move lines against facts the run does not author: the brief's claims
 * and model at its first commit and at HEAD, `table.json` and the fix, stage, and hand-test files,
 * what each fix range changed, main's drift, and HEAD. What the run owes and every fact already
 * failing come from `owedFacts` (`lib/owed.ts`), the same function the merge check and the stage
 * plan read; this file adds the wave's reader checks and prints. It cannot know whether a reader's
 * judgment was sound — only that every owed move reported and the branch matches what they imply.
 *
 *   node ~/.agent-build/runtime/shipGate.ts --ledger <run-dir>/ship.md [--base <ref>] [--json]
 *   node ~/.agent-build/runtime/shipGate.ts --ledger <run-dir>/ship.md --print-checks
 *
 * The repo is the cwd (the run's tree); the run dir is the ledger's folder; the base is the
 * ledger's `freshen: … | base=`, which `--base` overrides. A tree on another branch than the
 * ledger's `freshen: … | branch=` exits 2 (`runBranchError`): its HEAD is another run's code. `--print-checks` prints, on a pass, the
 * one line of `--check <name>=PASS|N/A` flags the marker owes (`emitMarker.ts gate-clean`).
 *
 * Exit 0 = every check passed. Exit 1 = at least one failed; the run banks instead of merging.
 * Exit 2 = the ledger could not be read or parsed, a usage error, or a fact the gate could not
 * compute here (a signals arm that could not run in the sandbox: re-run outside it). Exit 2 is
 * never a verdict.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { MARKER_CHECK_NAMES, type MarkerCheckName } from "./lib/gateMarkers.ts";
import { isMain } from "./lib/isMain.ts";
import { type Ledger, parseLedger } from "./lib/ledger.ts";
import { ArmEnvError, type OwedDeps, type OwedFacts, owedFacts, runBase, treeBranchError } from "./lib/owed.ts";
import { RISK_CLASS_READERS, type ReaderName } from "./lib/riskClass.ts";

/** The class readers a small diff lets sit out (`WAVE_HUNTER_MIN_LINES`); every other class reader
 * the wave owes by name. */
const SITS_OUT_BY_SIZE: readonly ReaderName[] = ["gate-silent-failure-hunter"];

export interface GateResult {
  ok: boolean;
  failures: string[];
  notes: string[];
  /** The checks the marker owes as PASS; every other check is N/A. */
  markerChecks: MarkerCheckName[];
}

/** The `wave:` line's `skipped: …` segment, when it has one. */
function waveSkipped(ledger: Ledger): string | undefined {
  return ledger.lines.get("wave")?.text.find((s) => s.startsWith("skipped:"));
}

/**
 * The wave's readers: the class's reader set, by name, where only the hunter may sit out and only
 * through `skipped:`; and on a briefed run the verifier, at every class. `owedFacts` checks the
 * reads after the wave; the wave is this file's.
 */
export function waveFailures(ledger: Ledger): string[] {
  if (!ledger.lines.has("wave")) return [];
  const failures: string[] = [];
  const briefed = ledger.fromBranch === null;
  if (briefed && !ledger.waveReaders.includes("build-verifier")) {
    failures.push(
      "wave: no build-verifier — the verifier reads every run that has a brief, at every class; only `--from-branch` is exempt (/build §CLOSE)"
    );
  }
  const skipped = waveSkipped(ledger);
  for (const reader of RISK_CLASS_READERS[ledger.cls]) {
    if (reader === "build-verifier" || ledger.waveReaders.includes(reader)) continue;
    const sitsOut = SITS_OUT_BY_SIZE.includes(reader);
    if (sitsOut && skipped?.includes(reader) === true) continue;
    failures.push(
      sitsOut
        ? `wave: no ${reader} — ${ledger.cls} owes it; name it in the reader list or in \`skipped: ${reader} — <threshold>\` (/build §CLOSE)`
        : `wave: no ${reader} — ${ledger.cls} owes it and it never sits out (/build §CLOSE)`
    );
  }
  return failures;
}

/**
 * The whole gate policy over facts already gathered, pure. A failure list rather than a first
 * failure: an unattended run banks ONE report, and one problem per round trip wastes the round
 * trip the report exists to avoid.
 */
export function gate(ledger: Ledger, owed: OwedFacts): GateResult {
  const failures = [...owed.failures, ...waveFailures(ledger)];
  const notes: string[] = [];
  if (!ledger.pinned) {
    notes.push("class unconfirmed (agent) — the agent picked it; the ship notification says so");
  }
  if (ledger.fromBranch !== null) {
    notes.push(`from-branch: ${ledger.fromBranch}`);
    notes.push("completeness unchecked — a from-branch run has no brief, so no verifier ran");
  }
  const skipped = waveSkipped(ledger);
  if (skipped !== undefined) notes.push(skipped);
  notes.push(...owed.notes);
  return { ok: failures.length === 0, failures, notes, markerChecks: owed.markerChecks };
}

/** Gathers the owed facts and judges them. Throws `ArmEnvError` when a signals arm cannot run. */
export async function runGate(
  ledger: Ledger,
  runDir: string,
  repo: string,
  base: string,
  deps: OwedDeps = {}
): Promise<GateResult> {
  return gate(ledger, await owedFacts(ledger, runDir, repo, base, deps));
}

/** The marker's `--check` flags: PASS for each owed check, N/A for the rest, in marker order. */
export function checkFlags(owed: readonly MarkerCheckName[]): string {
  return MARKER_CHECK_NAMES.map((c) => `--check ${c}=${owed.includes(c) ? "PASS" : "N/A"}`).join(" ");
}

export interface GateOpts {
  ledger: string;
  base: string | undefined;
  json: boolean;
  printChecks: boolean;
}

export function parseArgs(argv: string[]): GateOpts {
  assertKnownFlags(argv, ["--ledger", "--base", "--json", "--print-checks"]);
  const ledger = takeValue(argv, "--ledger");
  const base = takeValue(ledger.rest, "--base");
  const rest = base.rest.filter((a) => a !== "--json" && a !== "--print-checks");
  if (rest.length > 0) throw new Error(`unexpected argument(s): ${rest.join(" ")}`);
  if (!ledger.value) throw new Error("ship:gate needs --ledger <path to the run's ship.md>");
  const json = argv.includes("--json");
  const printChecks = argv.includes("--print-checks");
  if (json && printChecks) throw new Error("--json and --print-checks are two outputs — pick one");
  return { ledger: ledger.value, base: base.value, json, printChecks };
}

export interface MainOpts {
  /** The repo (session tree). Default: the process cwd. */
  cwd?: string;
  deps?: OwedDeps;
}

export async function main(
  argv: string[],
  exit: (code: number) => void = exitWhenFlushed,
  opts: MainOpts = {}
): Promise<void> {
  const repo = opts.cwd ?? process.cwd();
  let args: GateOpts;
  try {
    args = parseArgs(argv);
  } catch (err) {
    // Exit 1 is reserved for "the gate failed, bank these"; a usage error is not a verdict.
    console.error(`ship:gate: ${(err as Error).message}`);
    exit(2);
    return;
  }
  const ledgerPath = resolve(repo, args.ledger);
  let ledger: Ledger;
  try {
    ledger = parseLedger(readFileSync(ledgerPath, "utf8"));
  } catch (err) {
    console.error(`ship:gate: ${args.ledger}: ${(err as Error).message}`);
    exit(2);
    return;
  }
  let wrongTree: string | null;
  try {
    wrongTree = treeBranchError(ledger, dirname(ledgerPath), repo, opts.deps?.git);
  } catch (err) {
    wrongTree = `could not read this tree's branch — ${(err as Error).message.trim()}`;
  }
  if (wrongTree !== null) {
    console.error(`ship:gate: ${wrongTree}`);
    exit(2);
    return;
  }
  const base = runBase(ledger, args.base);
  if (base === null) {
    console.error("ship:gate: no base — the ledger's `freshen:` line has no base=, and no --base was given");
    exit(2);
    return;
  }
  let result: GateResult;
  try {
    result = await runGate(ledger, dirname(ledgerPath), repo, base, opts.deps);
  } catch (err) {
    const why = err instanceof ArmEnvError ? err.message : `could not compute the owed facts — ${(err as Error).message.trim()}`;
    console.error(`ship:gate: ${why}`);
    exit(2);
    return;
  }
  if (args.json) {
    console.log(JSON.stringify({ ...result, class: ledger.cls }, null, 2));
  } else if (args.printChecks) {
    for (const note of result.notes) console.error(`note: ${note}`);
    if (result.ok) console.log(checkFlags(result.markerChecks));
  } else {
    for (const note of result.notes) console.log(`note: ${note}`);
    if (result.ok) {
      console.log(
        `ship:gate PASS — class ${ledger.cls}${ledger.pinned ? "" : " (unconfirmed)"}, ${[...ledger.lines.keys()].join(", ")} reported; the marker owes ${result.markerChecks.join(", ")}`
      );
    }
  }
  if (!result.ok && !args.json) {
    console.error("ship:gate FAIL — do not post the marker or arm the merge; bank these:");
    for (const f of result.failures) console.error(`  - ${f}`);
  }
  exit(result.ok ? 0 : 1);
}

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2));
}
