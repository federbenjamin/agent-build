/**
 * The build pipeline's deterministic checks, by role. Each reads its inputs, runs the repo's step or
 * the runtime's own reader, and answers pass or fail with the outputs it declares. A step the repo
 * maps to no command passes and says so in its detail, as today's /build says it in the ledger.
 */

import { join } from "node:path";

import { gitOut, gitTry } from "../../../runtime/lib/gitOps.ts";
import { BriefPartError, summariseBrief } from "../../../runtime/lib/brief.ts";
import { measure } from "../../../runtime/size.ts";
import { resolveSteps, STEPS_FILE } from "../../../runtime/steps.ts";
import { bucketFor, loadThresholds, type SizeBucket } from "../../../runtime/thresholds.ts";
import { noteSections, repoReaders } from "../../adapters/baseSteps.ts";
import { runProcess } from "../../adapters/process.ts";
import { parseDiff } from "../../adapters/diffShape.ts";
import type { DataValue, ItemsValue } from "../../contracts.ts";
import type { CheckRequest, CheckResult } from "../../adapters/types.ts";
import { headSha, withRunTree } from "../../worktree.ts";
import { resolveBase } from "./base.ts";
import {
  check,
  checkOf,
  exists,
  fileNamed,
  filesOf,
  readText,
  type RepoConfig,
  repoConfigOf,
  runLines,
  startOf,
  tail,
  writeOut,
  yes,
} from "./common.ts";
import { closeDecision } from "./decide.ts";
import { schemaCheck } from "./schema.ts";
import type { SessionRow } from "./table.ts";

type Check = (req: CheckRequest) => Promise<CheckResult>;

const text = (t: string): DataValue => ({ schema: "text", text: t });
const items = (list: { id: string; after: string[] }[]): ItemsValue => ({ schema: "items", items: list });

/** K-load-config: the start's options, the repo's steps, notes and thresholds, read in the run tree. */
const loadConfig: Check = async (req) => {
  const start = startOf(req.inputs);
  const tree = req.worktree;
  const resolved = resolveSteps(tree);
  const steps = Object.fromEntries(resolved.steps.map((s) => [s.step, s.command]));
  const notesPath = steps.notes ?? null;
  const notesFile = notesPath === null ? null : notesPath.startsWith("/") ? notesPath : join(tree, notesPath);
  const notes = notesFile !== null && exists(notesFile) ? noteSections(readText(notesFile)) : {};
  const build = notes.build ?? "";
  const config: RepoConfig = {
    tree,
    stepsFile: resolved.file,
    steps,
    notes,
    briefsDir: /^briefs:\s*(\S+)/m.exec(build)?.[1] ?? null,
    baseRef: /^base:\s*(\S+)/m.exec(build)?.[1] ?? "main",
    thresholds: (await loadThresholds(tree)).values,
  };
  const missing = notesFile !== null && !exists(notesFile);
  return {
    answer: missing ? "fail" : "pass",
    detail: `${resolved.found ? "steps from the repo" : "no steps file: every step on its fallback"}; notes ${notesFile === null ? "(none)" : missing ? `${notesPath} is named and missing` : notesPath}`,
    outputs: {
      "repo-config": writeOut(req.outDir, "repo-config", { "repo-config.json": config }),
      "ticket-named": yes(start.ticket !== undefined, start.ticket === undefined ? "no ticket named" : `ticket ${start.ticket}`),
      "ticket-id": text(start.ticket ?? ""),
    },
  };
};

/** K-parse-brief: the brief's parts, test slices and hand-test claims (`summariseBrief`). */
const parseBrief: Check = async (req) => {
  const file = filesOf(req.inputs.brief).find((f) => f.endsWith(".md"));
  const fail = (detail: string): CheckResult => ({
    answer: "fail",
    detail,
    outputs: {
      "brief-parts": items([]),
      "brief-slices": items([]),
      "brief-claims": writeOut(req.outDir, "brief-claims", { "claims.json": [] }),
      "has-claims": check("fail", "the brief did not parse"),
      "needs-stack": check("fail", "the brief did not parse"),
    },
  });
  if (file === undefined) return fail("the brief output holds no .md file");
  let s;
  try {
    s = summariseBrief(readText(file));
  } catch (e) {
    if (e instanceof BriefPartError) return fail(`${e.message}`);
    throw e;
  }
  if (s.model === null || s.targets === null) return fail("the brief has no model line or no `## Target files`");
  const cfg = repoConfigOf(req.inputs);
  const stack = runLines(cfg.notes.stack).length > 0;
  const needsEnv = stack && (s.claims.some((c) => c.needs.includes("stack")) || s.slices.some((sl) => sl.lane === "db"));
  return {
    answer: "pass",
    detail: `class ${s.cls ?? "?"} · model ${s.model} · ${s.parts.length} parts · ${s.slices.length} test slices · ${s.claims.length} claims`,
    outputs: {
      "brief-parts": items(s.parts.map((p) => ({ id: p.id, after: p.after }))),
      "brief-slices": items(s.slices.map((sl) => ({ id: sl.id, after: [] }))),
      "brief-claims": writeOut(req.outDir, "brief-claims", { "claims.json": s.claims }),
      "has-claims": yes(s.claims.length > 0, `${s.claims.length} claims`),
      "needs-stack": yes(needsEnv, needsEnv ? "a claim or slice needs the stack" : "no claim or slice needs the stack, or the repo names no stack"),
    },
  };
};

/** Run each command in the run tree, in order, holding its lock; stops at the first that fails. */
async function runAll(req: CheckRequest, commands: readonly string[]): Promise<{ ok: boolean; log: string }> {
  return withRunTree(req.place.worktree, async () => {
    let log = "";
    for (const c of commands) {
      const r = await runProcess("sh", ["-c", c], { cwd: req.place.worktree, signal: req.signal });
      log += `$ ${c}\n${r.output}\n(${r.code === null ? "ended on a signal" : `exit ${r.code}`})\n`;
      if (r.code !== 0) return { ok: false, log };
    }
    return { ok: true, log };
  });
}

/** K-bring-up-stack: the repo's stack (`## stack` run lines in its notes), brought up in the run tree. */
const bringUpStack: Check = async (req) => {
  const cfg = repoConfigOf(req.inputs);
  const commands = runLines(cfg.notes.stack);
  const r = await runAll(req, commands);
  return {
    answer: r.ok ? "pass" : "fail",
    detail: r.ok ? `${commands.length} stack commands ran` : tail(r.log),
    outputs: { "stack-bindings": writeOut(req.outDir, "stack-bindings", { "env.json": { commands, ok: r.ok }, "env.log": r.log }) },
  };
};

/** The step each tests node (role `tests`) runs, first mapped wins. */
export const TEST_STEPS: Record<string, readonly string[]> = {
  "K-tests": ["exit_checks", "tests"],
  "K-tests-fix": ["fix_checks", "tests"],
  "K-tests-drift": ["exit_checks", "tests"],
};

/** Run the first mapped step of `steps`. `rows`: the output a red run writes one session row into,
 *  for the next table, beside the `also` rows whatever the step says; `report`: the output that takes
 *  the step's log. */
async function stepCheck(req: CheckRequest, steps: readonly string[], out: { rows?: string; also?: SessionRow[]; report?: string }): Promise<CheckResult> {
  const cfg = repoConfigOf(req.inputs);
  const step = steps.find((s) => cfg.steps[s] != null);
  const outputs = (rows: SessionRow[], log: string) => ({
    ...(out.rows === undefined ? {} : { [out.rows]: writeOut(req.outDir, out.rows, { "rows.json": [...rows, ...(out.also ?? [])] }) }),
    ...(out.report === undefined ? {} : { [out.report]: writeOut(req.outDir, out.report, { "report.txt": log }) }),
  });
  if (step === undefined) return { answer: "pass", detail: `no ${steps.join(" or ")} step: skipped`, outputs: outputs([], "skipped: no step\n") };
  const command = cfg.steps[step]!;
  const r = await runAll(req, [command]);
  const row: SessionRow = {
    title: `the ${step} step is red`,
    locator: cfg.stepsFile.startsWith(`${cfg.tree}/`) ? cfg.stepsFile.slice(cfg.tree.length + 1) : STEPS_FILE,
    kind: "behavior",
    finding: `\`${command}\` exits non-zero at ${gitOut(["rev-parse", "--short", "HEAD"], { cwd: req.place.worktree }).trim()}: ${tail(r.log, 600)}`,
    after: `\`${command}\` exits 0`,
  };
  return { answer: r.ok ? "pass" : "fail", detail: `${step}: ${r.ok ? "green" : "red"} — ${tail(r.log, 300)}`, outputs: outputs(r.ok ? [] : [row], r.log) };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A `-U0` hunk's old and new line numbers, its removed and added lines. */
function hunkLines(head: string, lines: readonly string[]): { oldAt: number; oldN: number; newAt: number; newN: number; removed: { at: number; text: string }[]; added: { at: number; text: string }[] } {
  const [, a, b, c, d] = HUNK_RE.exec(head) ?? [];
  const [oldAt, oldN, newAt, newN] = [Number(a ?? 0), Number(b ?? 1), Number(c ?? 0), Number(d ?? 1)];
  const removed = lines.filter((l) => l.startsWith("-")).map((l, i) => ({ at: oldAt + i, text: l.slice(1).trim() }));
  const added = lines.filter((l) => l.startsWith("+")).map((l, i) => ({ at: newAt + i, text: l.slice(1).trim() }));
  return { oldAt, oldN, newAt, newN, removed, added };
}

/**
 * The verify phase's edits to the tests the author phase wrote: each hunk of the verify range (the
 * integrated head to the run tree's head once every slice's verify commit merged) that removes or
 * changes a line the authors added since the brief commit, in a new file or one that was there, is a
 * red row. A verify run reports a red test as the contradiction it found and never bends the test to
 * the code (write-tests.md §Verify), so the fixer judges each edit.
 */
export function editedAssertionRows(tree: string, refs: { brief: string; integration: string; verify: string }): SessionRow[] {
  const authored = new Map<string, Set<number>>();
  for (const f of parseDiff(gitOut(["diff", "-U0", `${refs.brief}..${refs.integration}`], { cwd: tree }))) {
    const at = new Set(f.hunks.flatMap((h) => hunkLines(h.head, h.lines).added.map((l) => l.at)));
    if (at.size > 0) authored.set(f.path, at);
  }
  if (authored.size === 0) return [];
  const short = gitOut(["rev-parse", "--short", refs.verify], { cwd: tree }).trim();
  const span = (start: number, n: number) => (n <= 1 ? String(start) : `${start}-${start + n - 1}`);
  const quote = (lines: { text: string }[]) => lines.map((l) => l.text).join(" / ").slice(0, 200);
  const rows: SessionRow[] = [];
  for (const f of parseDiff(gitOut(["diff", "-U0", `${refs.integration}..${refs.verify}`, "--", ...authored.keys()], { cwd: tree }))) {
    const mine = authored.get(f.path);
    for (const h of f.hunks) {
      const { oldAt, oldN, newAt, newN, removed, added } = hunkLines(h.head, h.lines);
      const edited = removed.filter((l) => mine?.has(l.at) === true);
      if (edited.length === 0) continue;
      rows.push({
        title: `the verify phase edited an authored test in ${f.path}`,
        locator: `${f.path}:${span(newAt, newN === 0 ? 1 : newN)}`,
        kind: "test-app",
        finding: `verify head ${short} changes ${edited.length} line(s) the test writer authored (${f.path}:${span(oldAt, oldN)} at the integrated head): was \`${quote(removed)}\`, now \`${quote(added)}\``,
        after: "the authored assertion holds against the code as written, or the edit is shown not to weaken what the test pins",
      });
    }
  }
  return rows;
}

/** The edited-assertion rows a check position reads, when its inputs hold the verify phase's range:
 *  it ends at the run tree's head, which holds every slice's verify merge whatever order they finished
 *  in (`proofs-head` is only the last item's). */
function verifyEdits(req: CheckRequest): SessionRow[] {
  const ref = (id: string): string | undefined => {
    const v = req.inputs[id];
    return v?.schema === "ref" ? v.id : undefined;
  };
  const [brief, integration] = [ref("brief-commit"), ref("install-head")];
  if (brief === undefined || integration === undefined || ref("proofs-head") === undefined) return [];
  return editedAssertionRows(req.place.worktree, { brief, integration, verify: headSha(req.place.worktree) });
}

const tests: Check = async (req) => {
  const steps = TEST_STEPS[req.nodeId];
  if (steps === undefined) throw new Error(`no test step is set for ${req.nodeId}`);
  return stepCheck(req, steps, { rows: req.outputs[0]!, also: verifyEdits(req) });
};

/** K-pre-push: the repo's pre-push `checks` step; a red run's row goes to the next table. */
const prePush: Check = async (req) => stepCheck(req, ["checks"], { rows: req.outputs[0]! });

/** K-pre-push-ship: the pre-push `checks` step once more after a close loop that hit its cap, whose
 *  last iteration may not have run it. Red is its answer: the PR opens as a draft and the run waits on
 *  the operator at D-merge-pr. */
const prePushShip: Check = async (req) => stepCheck(req, ["checks"], {});

/** K-manifest-fix: the repo's `manifest` step, after an amend that changed no graded content. */
const manifestFix: Check = async (req) => stepCheck(req, ["manifest"], { report: "manifest-report" });

/** K-measure-diff: the diff's counted lines and bucket, and the repo readers the notes name. */
const measureDiff: Check = async (req) => {
  const patch = fileNamed(req.inputs.diff, "diff.patch");
  if (patch === undefined) throw new Error("the diff input holds no diff.patch");
  const cfg = repoConfigOf(req.inputs);
  const s = measure(readText(patch));
  const bucket = bucketFor(s.counted, cfg.thresholds.PR_SIZE_BUCKETS as SizeBucket[]);
  const readers = repoReaders(cfg.notes);
  return {
    answer: "pass",
    detail: `[${bucket}] ${s.counted} counted lines; repo readers: ${readers.join(", ") || "none"}`,
    outputs: {
      "size-report": writeOut(req.outDir, "size-report", { "size.json": { ...s, bucket } }),
      "repo-readers": items(readers.map((id) => ({ id, after: [] }))),
    },
  };
};

const names = (out: string): string[] => out.split("\n").map((l) => l.trim()).filter(Boolean);

/** K-main-moved: has the base branch moved since the run tree last merged it? Fail: a merge is owed. */
const mainMoved: Check = async (req) => {
  const cfg = repoConfigOf(req.inputs);
  const tree = req.place.worktree;
  const base = resolveBase(tree, cfg.baseRef);
  const main = base.sha;
  const report = (o: object) => writeOut(req.outDir, "drift-report", { "drift.json": { ...o, base: { ref: base.ref, note: base.note } } });
  if (gitTry(["merge-base", "--is-ancestor", main, "HEAD"], { cwd: tree }) !== null) {
    return { answer: "pass", detail: `${base.ref} (${main.slice(0, 9)}) is in the branch; ${base.note}`, outputs: { "drift-report": report({ main, moved: false }) } };
  }
  const mergeBase = gitOut(["merge-base", "HEAD", main], { cwd: tree }).trim();
  const mainFiles = names(gitOut(["diff", "--name-only", `${mergeBase}..${main}`], { cwd: tree }));
  const branchFiles = new Set(names(gitOut(["diff", "--name-only", `${mergeBase}..HEAD`], { cwd: tree })));
  const overlap = mainFiles.filter((f) => branchFiles.has(f));
  return {
    answer: "fail",
    detail: `${base.ref} moved to ${main.slice(0, 9)}: ${mainFiles.length} files, ${overlap.length} of them the branch's; ${base.note}`,
    outputs: { "drift-report": report({ main, moved: true, mergeBase, mainFiles, overlap }) },
  };
};

/** K-ship-gate: the ship gate as a completeness check over the run record: no node failed, every node
 *  that started finished, every skip has its recorded reason (a gate's answer, such as a classifier's,
 *  or a missing input), and the PR is open. */
const shipGate: Check = async (req) => {
  const record = req.record;
  if (record === undefined) throw new Error("K-ship-gate reads the run record and got none");
  const at = (n: (typeof record.nodes)[number]) => `${n.node}#${n.iteration}${n.instance ? `@${n.instance}` : ""}`;
  const failed = record.nodes.filter((n) => n.status === "failed").map(at);
  const stuck = record.nodes.filter((n) => (n.status === "running" || n.status === "waiting") && n.node !== req.nodeId).map((n) => n.node);
  const unexplained = record.nodes.filter((n) => n.status === "skipped" && (n.reason ?? "").trim() === "").map(at);
  const pr = req.inputs.pr?.schema === "ref" ? req.inputs.pr.id : null;
  const problems = [
    ...(failed.length > 0 ? [`failed: ${failed.join(", ")}`] : []),
    ...(stuck.length > 0 ? [`unfinished: ${stuck.join(", ")}`] : []),
    ...(unexplained.length > 0 ? [`skipped with no recorded reason: ${unexplained.join(", ")}`] : []),
    ...(pr === null ? ["no PR"] : []),
  ];
  return problems.length > 0 ? { answer: "fail", detail: problems.join("; ") } : { answer: "pass", detail: `PR ${pr}: every node that ran finished, every skip has its reason` };
};

/** K-loop-done: does the close loop go again (`closeDecision`)? Pass ends it. */
const loopDone: Check = async (req) => {
  const d = closeDecision({
    fixOwed: checkOf(req.inputs["fix-owed"])?.answer === "pass",
    fixMerged: req.inputs["fix-head"] !== undefined,
    nothingOpen: checkOf(req.inputs["nothing-open"])?.answer === "pass",
    mainMoved: checkOf(req.inputs["main-moved"])?.answer ?? null,
    driftMerged: req.inputs["drift-head"] !== undefined,
    prePush: checkOf(req.inputs["pre-push"])?.answer ?? null,
  });
  return { answer: d.done ? "pass" : "fail", detail: d.why };
};

const routeQuestion: Check = async () => {
  throw new Error("K-route-question is the runner's own decision (routeQuestion); it never runs as a check");
};

export const CHECKS: Record<string, Check> = {
  "load-config": loadConfig,
  "parse-brief": parseBrief,
  "bring-up-stack": bringUpStack,
  tests,
  "pre-push": prePush,
  "pre-push-ship": prePushShip,
  "manifest-fix": manifestFix,
  "measure-diff": measureDiff,
  "main-moved": mainMoved,
  "ship-gate": shipGate,
  "loop-done": loopDone,
  "output-format": schemaCheck,
  "route-question": routeQuestion,
};
