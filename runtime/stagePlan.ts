/**
 * stagePlan — what one read after a fix owes: whether the read is owed, its range, each reader's
 * verdict, and which hand-test claims to run. It prints `planStage` (`lib/owed.ts`), the function
 * the gate's `owedFacts` runs per read, so the session spawns what the gate later demands.
 *
 *   node ~/.agent-build/runtime/stagePlan.ts --run-dir <d> --stage <stage> [--base <ref>] [--from <sha>]
 *
 *   stage confirm-1 · range 4f1c2a9..8e2d0b1 · pr-code: changed (3 paths) (source repo) · fix-security: fires (path x) (source repo)
 *   reader: review-cursory-codex — owed (every read after a fix)
 *   reader: gate-silent-failure-hunter — sits out (12 counted lines < 20, no catch/await/Promise)
 *   reader: security-review — owed (R2; fix-security fires)
 *   reader: build-verifier — not owed (no amend brief:, no rename); run <manifest> --brief-file <brief> --no-exercise yourself
 *   hand-test: all claims (H1 H2 H3) · needs: stack
 *
 * `<stage>` is confirm-1, confirm-2, last, escalate, drift, drift-confirm, or unbank (the one
 * cursory read of a banked run's fix, over the `unbank:` line's `from..sha`). The ledger is
 * `<d>/ship.md`; the repo is the cwd (the run's tree), and a tree on another branch than the
 * ledger's `freshen: … | branch=` exits 2 (`runBranchError`). `--base` overrides the ledger's `base=`.
 * `--from` is the head before main was merged, required for `drift` until `drift-read:` is written.
 * A drift stage plans one drift group and prints its folder key, `stage drift-<n>` or
 * `stage drift-confirm-<n>`: `drift` the group `--from` starts (the latest recorded one, or a new
 * one), `drift-confirm` the latest group.
 * Exit 0 · 1 a signals arm could not run here (re-run outside the sandbox) · 2 bad input.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { isMain } from "./lib/isMain.ts";
import { parseLedger } from "./lib/ledger.ts";
import {
  ArmEnvError,
  claimStates,
  type ClaimState,
  type OwedDeps,
  PLAN_STAGES,
  type PlanStage,
  planStage,
  runBase,
  runContext,
  SECURITY_STAGES,
  type StagePlan,
  treeBranchError,
} from "./lib/owed.ts";

const USAGE = `usage: stagePlan.ts --run-dir <d> --stage <${PLAN_STAGES.join("|")}> [--base <ref>] [--from <sha>]`;

const short = (sha: string) => sha.slice(0, 9);

function signalsPart(label: string, r: { source: string }, body: string): string {
  return `${label}: ${body} (source ${r.source})`;
}

/** The stage's lines, without the hand-test line. */
export function formatPlan(plan: StagePlan, cls: string): string[] {
  if (!plan.owed) return [`stage ${plan.key}: not owed — ${plan.why}`];
  const head: string[] = [`stage ${plan.key}`];
  if (plan.range) {
    head.push(
      `range ${short(plan.range.from)}..${short(plan.range.to)}${plan.range.files ? ` (main's side, ${plan.range.files.length} files)` : ""}`
    );
  }
  if (plan.prCode) {
    const n = plan.prCode.paths.length;
    head.push(signalsPart("pr-code", plan.prCode, n > 0 ? `changed (${n} path${n === 1 ? "" : "s"})` : "unchanged"));
  }
  if (plan.fixSecurity) {
    const fs = plan.fixSecurity;
    head.push(signalsPart("fix-security", fs, fs.fires ? `fires (${fs.reasons.join("; ")})` : "quiet"));
  } else if (SECURITY_STAGES.has(plan.stage)) {
    head.push(`fix-security: not asked (${cls})`);
  } else if (plan.stage !== "drift-confirm") {
    head.push("fix-security: not asked (confirm-1 and confirm-2 only)");
  }
  return [
    head.join(" · "),
    ...plan.readers.map(
      (r) => `reader: ${r.reader} — ${r.verdict} (${r.why})${r.instead ? `; ${r.instead}` : ""}`
    ),
  ];
}

/** `hand-test: all claims (…)` (before the first run), `claims H2 H4` (never run or failed only),
 *  or `none`, with the `needs:` of the claims to run (R.17). */
export function formatHandTest(states: readonly ClaimState[]): string {
  if (states.length === 0) return "hand-test: none (no claims)";
  const owed = states.filter((s) => !s.passed);
  if (owed.length === 0) return "hand-test: none";
  const ids = owed.map((s) => s.id).join(" ");
  const needs = (["stack", "sim"] as const).filter((n) => owed.some((s) => s.needs.includes(n)));
  const list = owed.length === states.length ? `all claims (${ids})` : `claims ${ids}`;
  return `hand-test: ${list}${needs.length > 0 ? ` · needs: ${needs.join(", ")}` : ""}`;
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
  let runDir: string;
  let stage: PlanStage;
  let baseFlag: string | undefined;
  let from: string | undefined;
  try {
    assertKnownFlags(argv, ["--run-dir", "--stage", "--base", "--from"]);
    const d = takeValue(argv, "--run-dir");
    const s = takeValue(d.rest, "--stage");
    const b = takeValue(s.rest, "--base");
    const f = takeValue(b.rest, "--from");
    if (f.rest.length > 0) throw new Error(`unexpected argument(s): ${f.rest.join(" ")}`);
    if (d.value === undefined) throw new Error("--run-dir is required");
    if (s.value === undefined || !(PLAN_STAGES as readonly string[]).includes(s.value)) {
      throw new Error(`--stage must be one of ${PLAN_STAGES.join(", ")}, got ${s.value ?? "(missing)"}`);
    }
    runDir = resolve(repo, d.value);
    stage = s.value as PlanStage;
    baseFlag = b.value;
    from = f.value;
  } catch (err) {
    console.error(`stagePlan: ${(err as Error).message}\n${USAGE}`);
    exit(2);
    return;
  }
  try {
    const ledgerPath = join(runDir, "ship.md");
    if (!existsSync(ledgerPath)) throw new Error(`no ship.md in ${runDir}`);
    const ledger = parseLedger(readFileSync(ledgerPath, "utf8"));
    const wrongTree = treeBranchError(ledger, runDir, repo, opts.deps?.git);
    if (wrongTree !== null) throw new Error(wrongTree);
    const base = runBase(ledger, baseFlag);
    if (base === null) throw new Error("no base — the ledger's `freshen:` line has no base=, and no --base was given");
    if (stage === "drift" && from === undefined && ledger.driftGroups.length === 0) {
      throw new Error("--stage drift needs --from <the head before main was merged> (R.3)");
    }
    const ctx = await runContext(ledger, runDir, repo, base, opts.deps);
    if (ctx.briefFailures.length > 0) throw new Error(ctx.briefFailures.join("; "));
    const plan = planStage(ctx, stage, from === undefined ? {} : { from });
    const lines = [...formatPlan(plan, ledger.cls), formatHandTest(claimStates(ctx))];
    for (const note of ctx.notes) lines.push(`signals: ${note}`);
    console.log(lines.join("\n"));
  } catch (err) {
    if (err instanceof ArmEnvError) {
      console.error(`stagePlan: ${err.message}`);
      exit(1);
      return;
    }
    console.error(`stagePlan: ${(err as Error).message.trim()}`);
    exit(2);
    return;
  }
  exit(0);
}

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2));
}
