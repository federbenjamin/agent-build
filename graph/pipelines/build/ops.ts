/**
 * The build pipeline's data operations, by role: they move the run tree (pin the base, commit the
 * brief, merge main), share a fix round out among fixers, join their fix files and read what the round
 * owes, and ship. Every write to the run tree holds its lock.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { gitOut, gitTry } from "../../../runtime/lib/gitOps.ts";
import { parseHandTestBlock, summariseBrief } from "../../../runtime/lib/brief.ts";
import { parseClassLine } from "../../../runtime/lib/riskClass.ts";
import { type Kind } from "../../../runtime/lib/runFiles.ts";
import { parseFixFile } from "../../../runtime/lib/fixFile.ts";
import type { DataValue, QuestionRun, RefValue } from "../../contracts.ts";
import { RunError, searchedText } from "../../contracts.ts";
import { fileRunStore } from "../../adapters/fileRunStore.ts";
import { nodeKey, sessionName } from "../../runKeys.ts";
import { FIXER_NODE } from "../build.ts";
import type { OpContext, OpResult } from "../../adapters/types.ts";
import { agentWorktrees, changedFiles, headSha, mergeInto, mergeWriterCommit, resetWorktree, runLeftovers, snapshotWorktree } from "../../worktree.ts";
import { type Base, resolveBase } from "./base.ts";
import { briefFile, briefMark, briefPathInTree, briefTextAt } from "./briefs.ts";
import { attemptDir } from "../../adapters/agentIo.ts";
import { runProcess } from "../../adapters/process.ts";
import { OPERATOR_ABANDON, OPERATOR_MERGE, SLICE_MERGE_SHARE } from "../../constants.ts";
import { checkOf, commit, fileNamed, filesOf, inputJson, readText, repoConfigOf, runLines, startOf, tail, writeOut, yes } from "./common.ts";
import { claimsOwed, draftReasons, driftReadOwed, type FixOutcome, owedAfterFix, shipStep } from "./decide.ts";
import { CONFLICT_FILE, DRAFT_FILE, type DraftFile, foreignSliceFiles, joinSliceFixes, LINKS_FILE, parseLinks, PLAN_FILE, planSlices, type SliceConflict, type SlicePlan, type SliceUnmerged, withPeers } from "./slices.ts";
import { finalTable, fixerCap, fixFileName, fixTable, tableJsonOf, tableStateOf } from "./table.ts";

type Op = (ctx: OpContext) => Promise<OpResult>;
const done = (outputs: Record<string, DataValue>): OpResult => ({ status: "done", outputs });

/** D-pin-run-tree: pin the run tree to the start's base (`start.base`, else where it was made). */
const pinRunTree: Op = async (ctx) => {
  const start = startOf(ctx.inputs);
  const cfg = repoConfigOf(ctx.inputs);
  const tree = ctx.place.worktree;
  const base = await ctx.withRunTree(() => {
    if (start.base !== undefined) resetWorktree(tree, gitOut(["rev-parse", `${start.base}^{commit}`], { cwd: tree }).trim());
    return headSha(tree);
  });
  return done({ "run-tree": writeOut(ctx.outDir, "run-tree", { "run-tree.json": { tree, branch: ctx.place.branch, base, baseRef: cfg.baseRef } }) });
};

/** D-commit-brief: commit the brief (into the repo's briefs dir, or an empty marker commit when the run's
 *  store keeps it), and post the work-start comment on a named ticket. */
const commitBrief: Op = async (ctx) => {
  const src = briefFile(ctx.inputs);
  const slug = basename(src, ".md");
  const inTree = briefPathInTree(ctx.inputs);
  const tree = ctx.place.worktree;
  const sha = await ctx.withRunTree(() => {
    if (inTree !== null) {
      mkdirSync(dirname(join(tree, inTree)), { recursive: true });
      writeFileSync(join(tree, inTree), readText(src));
      return snapshotWorktree(tree, `brief: ${slug}`);
    }
    return snapshotWorktree(tree, `brief: ${slug} (kept in the run's store)`);
  });
  const ticket = ctx.inputs["ticket-id"]?.schema === "text" ? ctx.inputs["ticket-id"].text.trim() : "";
  const started = `Work started: run ${ctx.runId},`;
  const comment = ticket === "" ? null : await ctx.tracker.comment(ticket, `${started} brief ${slug} at ${sha.slice(0, 9)}.`, ctx.signal, started);
  return done({ "brief-commit": commit(sha), "work-start": writeOut(ctx.outDir, "work-start", { "work-start.json": { ticket: ticket || null, comment } }) });
};

/** D-install: the merged-back parts and test slices, with the repo's `install` step run on them. */
const install: Op = async (ctx) => {
  const cfg = repoConfigOf(ctx.inputs);
  const install = cfg.steps.install ?? null;
  const tree = ctx.place.worktree;
  const head = await ctx.withRunTree(async () => {
    if (install !== null) {
      const r = await runProcess("sh", ["-c", install], { cwd: tree, signal: ctx.signal });
      if (r.code !== 0) throw new RunError(`install failed: ${tail(r.output)}`);
    }
    return headSha(tree);
  });
  return done({ "install-head": commit(head) });
};

/** Merge the base branch, fetched from its upstream (`resolveBase`), into the run tree, then run
 *  the notes' `## freshen` additions. */
async function mergeMain(ctx: OpContext): Promise<{ before: string; after: string; base: Base }> {
  const cfg = repoConfigOf(ctx.inputs);
  const tree = ctx.place.worktree;
  return ctx.withRunTree(async () => {
    const before = headSha(tree);
    const base = resolveBase(tree, cfg.baseRef);
    const main = base.sha;
    const merged = mergeInto(tree, main, `freshen: merge ${base.ref} (${main.slice(0, 9)})`);
    if ("conflict" in merged) throw new RunError(`merging ${main} into the run tree conflicts on ${merged.conflict.paths.join(", ")}: a person resolves it`);
    const after = merged.head;
    for (const c of runLines(cfg.notes.freshen)) {
      const r = await runProcess("sh", ["-c", c], { cwd: tree, signal: ctx.signal });
      if (r.code !== 0) throw new RunError(`freshen addition \`${c}\` failed: ${tail(r.output)}`);
    }
    return { before, after, base };
  });
}

const diffFiles = (tree: string, range: string) =>
  gitOut(["diff", "--name-only", range], { cwd: tree })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** D-pull-main (the wave's) and D-pull-main-drift (the loop's): merge main. The wave's writes the PR's
 *  diff; the drift's writes what the merge brought, and `drift-first` passes when a read is owed
 *  (`driftReadOwed`: it touched a file the branch changed, in the run's one drift group). */
const pullMain: Op = async (ctx) => {
  const tree = ctx.place.worktree;
  const { before, after, base } = await mergeMain(ctx);
  const runTreeBase = inputJson<{ base: string }>(ctx.inputs, "run-tree", "run-tree.json");
  const upstream = { ref: base.ref, sha: base.sha, note: base.note };
  if (!ctx.outputs.includes("drift-first")) {
    const range = `${gitOut(["merge-base", base.sha, after], { cwd: tree }).trim()}..${after}`;
    return done({
      "pull-main-head": commit(after),
      diff: writeOut(ctx.outDir, "diff", {
        "diff.patch": gitOut(["diff", range], { cwd: tree }),
        "diff.json": { range, base: runTreeBase.base, files: diffFiles(tree, range), merged: before !== after, upstream },
      }),
    });
  }
  const brought = before === after ? [] : diffFiles(tree, `${before}..${after}`);
  const branch = new Set(diffFiles(tree, `${runTreeBase.base}..${before}`));
  const overlap = brought.filter((f) => branch.has(f));
  const read = driftReadOwed(overlap, tableStateOf(ctx.inputs.table).driftGroups);
  return done({
    "drift-head": commit(after),
    "drift-diff": writeOut(ctx.outDir, "drift-diff", {
      "diff.patch": before === after ? "" : gitOut(["diff", `${before}..${after}`], { cwd: tree }),
      "diff.json": { range: `${before}..${after}`, files: brought, overlap, upstream },
    }),
    "drift-first": yes(read.owed, read.why),
  });
};

/**
 * D-plan-slices: the round's fix slices (`planSlices`): the draft slices, merged where A-link-slices linked them
 * within the cap and packed into at most the fixer cap, as the `fix-slices` list; and the slice plan,
 * each slice's rows, files and peers (`withPeers`), each peer's session name and node-run folder made
 * by the functions that name them. With no links (A-link-slices skipped or failed open) the draft is packed
 * with no warnings.
 */
const planFixSlices: Op = async (ctx) => {
  const draft = inputJson<DraftFile>(ctx.inputs, "draft-slices", DRAFT_FILE);
  const linksFile = fileNamed(ctx.inputs.links, LINKS_FILE);
  const links = linksFile === undefined ? [] : parseLinks(JSON.parse(readText(linksFile)), LINKS_FILE);
  const plan = planSlices(draft.slices, links, fixerCap(ctx.inputs), SLICE_MERGE_SHARE);
  const store = fileRunStore(ctx.place.runDir);
  const reach = (item: string) => ({
    session: sessionName(ctx.runId, FIXER_NODE, ctx.iteration, item),
    nodeRun: store.path(nodeKey({ node: { id: FIXER_NODE }, iteration: ctx.iteration, instance: item })),
  });
  return done({
    "fix-slices": { schema: "items", items: plan.slices.map((s) => ({ id: s.id, after: [] })) },
    "slice-plan": writeOut(ctx.outDir, "slice-plan", { [PLAN_FILE]: withPeers(draft.round, plan, reach) }),
  });
};

/**
 * D-merge-slice, once per fix slice: merge its fixer's commit into the run tree unless it touches a file
 * another slice of the plan owns (`foreignSliceFiles`), and write the slice's conflict file
 * (`SliceConflict`). A commit out of its lane is not merged, and one whose merge conflicts is aborted:
 * either leaves the run tree as it was and is written as data with its cause, for D-merge-fix to answer
 * `blocked`; any other error fails the node.
 */
const mergeSlice: Op = async (ctx) => {
  const fix = ctx.inputs["fix-commit"];
  if (fix?.schema !== "ref" || fix.kind !== "commit") throw new Error(`${ctx.nodeId}: no fix-commit input`);
  const item = ctx.instance;
  if (item === undefined) throw new Error(`${ctx.nodeId}: runs once per fix slice, but has no slice`);
  const plan = inputJson<SlicePlan>(ctx.inputs, "slice-plan", PLAN_FILE);
  const tree = ctx.place.worktree;
  const unmerged = await ctx.withRunTree((): SliceUnmerged | null => {
    const owned = foreignSliceFiles(plan, item, changedFiles(tree, fix.id));
    if (owned.length > 0) return { cause: "lane", owned };
    const merged = mergeWriterCommit(tree, fix.id, ctx.nodeId);
    return "conflict" in merged ? { cause: "conflict", paths: [...merged.conflict.paths] } : null;
  });
  const conflict: SliceConflict = { slice: item, commit: fix.id, unmerged };
  return done({ "slice-conflict": writeOut(ctx.outDir, "slice-conflict", { [CONFLICT_FILE]: conflict }) });
};

/**
 * D-merge-fix, once every slice's merge ran: the run tree's head, the round's one fix file joined from
 * the slices' (`joinSliceFixes`, each slice's checked against its own rows; one slice's file as it is;
 * a slice whose commit did not merge answers the rows it fixed `blocked`), the round's diff, and what the round
 * owes (`owedAfterFix`).
 */
const mergeFix: Op = async (ctx) => {
  const state = tableStateOf(ctx.inputs.table);
  const round = state.round;
  if (round === null) throw new Error("the table built no round");
  const roundHead = tableJsonOf(ctx.inputs.table).rounds[round]!.head;
  const tree = ctx.place.worktree;
  const head = await ctx.withRunTree(() => headSha(tree));
  const plan = inputJson<SlicePlan>(ctx.inputs, "slice-plan", PLAN_FILE);
  const conflicts = filesOf(ctx.inputs["slice-conflict"])
    .filter((f) => basename(f) === CONFLICT_FILE)
    .map((f) => JSON.parse(readText(f)) as SliceConflict);
  const fixText = joinSliceFixes(plan, filesOf(ctx.inputs["slice-fix"]).filter((f) => f.endsWith(".txt")).map(readText), state.rows.map((r) => r.id), conflicts);
  const fix = parseFixFile(fixText, { rows: state.rows.map((r) => r.id) });
  const kindOf = new Map(state.rows.map((r) => [r.id, r.kind]));
  const amends = gitOut(["log", "--format=%H %s", `${roundHead}..${head}`], { cwd: tree })
    .split("\n")
    .filter((l) => / amend brief:/.test(` ${l.slice(41)}`))
    .map((l) => l.slice(0, 40));
  // The brief as the table saw it, against the brief now: in the tree at the fix's head, or (kept in
  // the run's store) the amended brief the engine published.
  const now = briefTextAt(ctx.inputs, tree, head);
  const graded = state.brief !== undefined && now !== null && briefMark(now).graded !== state.brief.graded;
  const claims = parseClaims(now ?? readText(briefFile(ctx.inputs)));
  const outcome: FixOutcome = {
    rows: fix.lines.map((l) => ({ id: l.row, kind: (l.action === "relabel" ? l.from : kindOf.get(l.row)) ?? ("structure" as Kind), action: l.action })),
    amend: { any: amends.length > 0, graded },
    claimsOwed: claimsOwed(claims, state.claims),
  };
  const owed = owedAfterFix(outcome);
  const say = (b: boolean, what: string) => yes(b, b ? what : `not owed: ${what}`);
  return done({
    "fix-head": commit(head),
    "fix-file": writeOut(ctx.outDir, "fix-file", { [fixFileName(round)]: fixText }),
    "fix-diff": writeOut(ctx.outDir, "fix-diff", { "fix.patch": gitOut(["diff", `${roundHead}..${head}`], { cwd: tree }) }),
    "owed-review-fix-call": say(owed.reviewFixCall, "the round fixed an urgent row"),
    "owed-review-fix": say(owed.reviewFix, "the round dropped or relabelled an urgent row"),
    "owed-manifest-fix": say(owed.manifestFix, "an amend in the range changed no graded content"),
    "owed-completeness-fix": say(owed.completenessFix, "an amend in the range changed graded content"),
    "owed-security-fix": say(owed.securityFix, "the round fixed a security row"),
    "owed-hand-test-fix": say(owed.handTestFix, `claims never run or last failed: ${outcome.claimsOwed.join(", ") || "none"}`),
  });
};

function parseClaims(briefText: string): string[] {
  try {
    return parseHandTestBlock(briefText).claims.map((c) => c.id);
  } catch {
    return summariseBrief(briefText).claims.map((c) => c.id);
  }
}

/** The PR body's list of every answered question: what was asked, the answer, where it came from,
 *  and what was searched for it (the resolver's sources, else the asker's). */
export function answersSection(questions: readonly QuestionRun[]): string {
  const answered = questions.filter((q) => q.answer !== undefined);
  if (answered.length === 0) return "";
  const lines = answered.map(({ question: q, answer: a }) => {
    const searched = a!.searched ?? q.searched;
    return [
      `- **${q.id}** (${q.type}): ${q.text}`,
      `  - answer: ${a!.answer}`,
      `  - source: ${a!.source}, by the ${a!.by}${a!.brief_change === undefined ? "" : `; brief change: ${a!.brief_change}`}`,
      `  - searched: ${searched.length === 0 ? "nothing" : searchedText(searched)}`,
    ].join("\n");
  });
  return `\n\n## Answers\n\n${lines.join("\n")}`;
}

/** The ship checks D-open-pr and D-merge-pr read: `final-clean`, `pre-push-ship`, and whether the close loop
 *  ended at its cap (`close-outcome`), which owes a `pre-push-ship` answer. */
const shipChecks = (inputs: OpContext["inputs"]) => {
  const outcome = inputs["close-outcome"];
  return { finalClean: checkOf(inputs["final-clean"]), prePushShip: checkOf(inputs["pre-push-ship"]), capped: outcome?.schema === "outcome" && outcome.answer === "capped" };
};

/** D-open-pr: push the run branch and open the PR, a draft for any of `draftReasons` (D-merge-pr then
 *  waits on the operator). */
const openPr: Op = async (ctx) => {
  const draft = draftReasons(shipChecks(ctx.inputs)).length > 0;
  const brief = summariseBrief(readText(briefFile(ctx.inputs)));
  const title = readText(briefFile(ctx.inputs)).split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? ctx.runId;
  const final = fileNamed(ctx.inputs.final, "final.md");
  const tickets = ctx.inputs["ticket-refs"]?.schema === "ref" ? `\n\nLeftovers filed: ${ctx.inputs["ticket-refs"].id}` : "";
  const ticket = ctx.inputs["ticket-id"]?.schema === "text" && ctx.inputs["ticket-id"].text !== "" ? `\n\nFixes ${ctx.inputs["ticket-id"].text}` : "";
  const answers = answersSection(ctx.record?.questions ?? []);
  const body = `Class ${brief.cls ?? "?"} · model ${brief.model ?? "?"}\n\n${final === undefined ? "" : readText(final)}${answers}${tickets}${ticket}\n`;
  await ctx.withRunTree(() => ctx.forge.push({ worktree: ctx.place.worktree, branch: ctx.place.branch, signal: ctx.signal }));
  const pr = await ctx.forge.openPr({ worktree: ctx.place.worktree, branch: ctx.place.branch, title, body, draft, ...(brief.cls === null ? {} : { riskClass: brief.cls }), signal: ctx.signal });
  return done({ pr });
};

/**
 * D-merge-pr: merge the PR through the forge (the repo's merge step, which readies a draft), at once
 * when nothing holds it, else after asking the operator (`shipStep`) with the PR and why it waits. The
 * reply `merge` runs the step again; `abandon` ends the run abandoned (no cleanup), with a comment on
 * the run's ticket naming what it leaves. A merge that fails (the step, the wait for the queue, a read
 * of the PR) is followed by one read of the PR: one already MERGED ends the node merged; else the
 * operator is asked with the failure's first line (the step, its command and exit), and its whole
 * output stays in a file beside the node's attempts and in the node's waiting reason. A `RunError`
 * (a step the repo does not map) fails the node: no reply would change it.
 */
const mergePr: Op = async (ctx) => {
  const pr = ctx.inputs.pr;
  if (pr?.schema !== "ref" || pr.kind !== "pr") throw new Error("D-merge-pr: no pr input");
  const where = pr.url ?? `PR ${pr.id}`;
  const finalMd = fileNamed(ctx.inputs.final, "final.md");
  const ask = (why: readonly string[]): Extract<OpResult, { status: "needs-operator" }> => ({
    status: "needs-operator",
    question: `${where} waits: ${why.join("; ")}.${finalMd === undefined ? "" : ` The final round: ${finalMd}.`} Reply ${OPERATOR_MERGE} to run the repo's merge step (it readies a draft), or ${OPERATOR_ABANDON} to end the run and leave the branch, the PR and the worktrees as they are.`,
  });
  const step = shipStep({ ...shipChecks(ctx.inputs), shipGate: checkOf(ctx.inputs["ship-gate"]), hold: startOf(ctx.inputs).hold, reply: ctx.answers.at(-1) ?? null });
  if (step.do === "ask") return ask(step.why);
  if (step.do === "abandon") return { status: "abandon", reason: await abandonNote(ctx, pr) };
  // The class line alone: a merge never waits on the rest of the brief parsing.
  const riskClass = parseClassLine(readText(briefFile(ctx.inputs)))?.cls ?? null;
  try {
    return done({ merge: await ctx.forge.merge({ worktree: ctx.place.worktree, pr: pr.id, branch: ctx.place.branch, ...(riskClass === null ? {} : { riskClass }), signal: ctx.signal }) });
  } catch (e) {
    if (ctx.signal.aborted || e instanceof RunError) throw e;
    const failure = (e as Error).message;
    let state: string;
    try {
      state = await ctx.forge.prState({ worktree: ctx.place.worktree, pr: pr.id, signal: ctx.signal });
    } catch (readError) {
      if (ctx.signal.aborted) throw readError;
      state = "unread (its state could not be read)";
    }
    if (state === "MERGED") return done({ merge: { schema: "ref", kind: "merge", id: pr.id } });
    const file = join(attemptDir(ctx), `merge-failure-${ctx.answers.length + 1}.txt`);
    writeFileSync(file, `${failure}\n`);
    const asked = ask([`the merge failed: ${failure.split("\n")[0]}; the PR is ${state}; the whole output is in ${file}`]);
    return { ...asked, reason: `${asked.question}\n${tail(failure, 1500)}` };
  }
};

/** Why the run ends abandoned, after a comment on the run's ticket (when it names one) listing the
 *  branch, the PR and the worktrees it leaves; a comment that fails is said in the reason, not fatal. */
async function abandonNote(ctx: OpContext, pr: RefValue): Promise<string> {
  const where = pr.url ?? `PR ${pr.id}`;
  const reason = `the operator abandoned the run at ${where}`;
  const ticket = ctx.inputs["ticket-id"]?.schema === "text" ? ctx.inputs["ticket-id"].text.trim() : "";
  if (ticket === "") return reason;
  const key = `Run ${ctx.runId} abandoned`;
  const left = runLeftovers(ctx.place.runDir, ctx.place.worktree);
  try {
    await ctx.tracker.comment(ticket, `${key} by the operator. Left as they are: branch ${ctx.place.branch}, ${where}, worktrees ${left.join(", ")}.`, ctx.signal, key);
    return reason;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return `${reason}; the comment on ${ticket} failed: ${(e as Error).message}`;
  }
}

/** D-remove-worktrees: remove the agents' worktrees; the run tree stays for the record. */
const removeWorktrees: Op = async (ctx) => {
  const removed = agentWorktrees(ctx.place.runDir).filter((p) => gitTry(["worktree", "remove", "--force", p], { cwd: ctx.place.worktree }) !== null);
  return done({ "remove-worktrees": writeOut(ctx.outDir, "remove-worktrees", { "cleanup.json": { removed: removed.length, merged: ctx.inputs.merge?.schema === "ref" ? ctx.inputs.merge.id : null } }) });
};

const askOperator: Op = async () => {
  throw new RunError("D-ask-operator is the runner's own wait on the operator; it never runs as an operation");
};

export const OPS: Record<string, Op> = {
  "pin-run-tree": pinRunTree,
  "commit-brief": commitBrief,
  install,
  "pull-main": pullMain,
  "build-fix-table": fixTable,
  "plan-slices": planFixSlices,
  "merge-slice": mergeSlice,
  "merge-fix": mergeFix,
  "final-table": finalTable,
  "open-pr": openPr,
  "merge-pr": mergePr,
  "remove-worktrees": removeWorktrees,
  "ask-operator": askOperator,
};
