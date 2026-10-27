/**
 * The build graph's gates and operations around the close loop and ship: the D-open-pr gate, K-loop-done's
 * decision, the ship checks after a capped loop, the upstream fetch, the one drift group, a store
 * brief's amend grading, and a builder's commit kept off other parts' files.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { briefText } from "../../runtime/__tests__/helpers/owedRun.ts";
import { FALLBACKS } from "../../runtime/steps.ts";
import { serialiseTableJson, type TableJson } from "../../runtime/lib/runFiles.ts";
import { EXIT_CHECKS } from "../../runtime/lib/fixFile.ts";
import { DEFAULTS } from "../../runtime/thresholds.ts";
import { repoReadersMissing } from "../adapters/baseSteps.ts";
import { featureSum } from "../adapters/classifierState.ts";
import { fileForge, fileTracker } from "../adapters/fileFakes.ts";
import { githubForge } from "../adapters/githubForge.ts";
import type { CheckRequest, Forge, OpContext } from "../adapters/types.ts";
import { type DataValues, type FilesValue, type Gate, type PatternFeature, type QuestionRun, RunError, type RunHistory } from "../contracts.ts";
import { gateFails, nodeById } from "../define.ts";
import { graph } from "../pipelines/build.ts";
import { resolveBase } from "../pipelines/build/base.ts";
import { briefMark } from "../pipelines/build/briefs.ts";
import { CHECKS } from "../pipelines/build/checks.ts";
import { closeDecision, driftReadOwed } from "../pipelines/build/decide.ts";
import { answersSection, OPS } from "../pipelines/build/ops.ts";
import { foreignPartPaths } from "../pipelines/build/schema.ts";
import { PLAN_FILE, type SlicePlan } from "../pipelines/build/slices.ts";
import type { TableState } from "../pipelines/build/table.ts";
import { opContext } from "./helpers/opContext.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A repo on `main` with one commit; returns its path. */
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

const files = (...paths: string[]): FilesValue => ({ schema: "files", files: paths });
const repoConfig = (dir: string, tree: string, over: { steps?: Record<string, string>; briefsDir?: string | null } = {}) =>
  files(put(join(dir, "in", "repo-config.json"), JSON.stringify({ tree, stepsFile: join(tree, ".claude/build-steps.toml"), steps: over.steps ?? {}, notes: {}, briefsDir: over.briefsDir ?? null, baseRef: "main", thresholds: DEFAULTS })));

const checkReq = (dir: string, tree: string, inputs: DataValues, over: Partial<CheckRequest> = {}): CheckRequest => ({
  role: "pre-push-ship",
  inputs,
  worktree: tree,
  baseSha: "",
  iteration: 0,
  signal: new AbortController().signal,
  outputs: [],
  outDir: join(dir, "out"),
  place: { runDir: dir, worktree: tree, branch: "b", baseSha: "" },
  formats: {},
  nodeId: "K-pre-push-ship",
  ...over,
});

const finalGate = nodeById(graph, "D-final-table")!.gate as Gate;
const ck = (answer: "pass" | "fail") => ({ schema: "check" as const, answer, detail: "" });
const loop = (answer: "clean" | "capped" | "aborted") => ({ schema: "outcome" as const, answer });

test("D-open-pr runs whenever D-final-table did, after K-pre-push-ship on a capped loop: a red check lands at D-merge-pr's wait, not a stop", () => {
  const pr = nodeById(graph, "D-open-pr")!;
  assert.equal(pr.gate, undefined);
  assert.ok(pr.inputs.includes("final") && pr.optionalInputs?.includes("pre-push-ship"));
  assert.equal(gateFails(graph, finalGate, { "close-outcome": loop("clean") }), null);
  assert.equal(gateFails(graph, finalGate, { "close-outcome": loop("capped") }), null);
  assert.notEqual(gateFails(graph, finalGate, { "close-outcome": loop("aborted") }), null, "an aborted loop ships nothing");
  assert.deepEqual(nodeById(graph, "K-pre-push-ship")!.gate, { loop: "close", answer: "capped" });
  assert.equal(nodeById(graph, "K-ship-gate")!.gate, undefined, "the gate always runs, so its answer reaches the wait");
  assert.equal(nodeById(graph, "D-merge-pr")!.gate, undefined, "the merge node decides itself whether it waits");
});

test("K-loop-done goes again on red checks even with rows left open, and ends only on green", () => {
  const base = { fixOwed: false, fixMerged: false, mainMoved: "pass" as const, driftMerged: false };
  assert.equal(closeDecision({ ...base, nothingOpen: false, prePush: "fail" }).done, false);
  assert.equal(closeDecision({ ...base, nothingOpen: false, prePush: "pass" }).done, true);
  assert.equal(closeDecision({ ...base, nothingOpen: true, prePush: "pass" }).done, true);
});

test("K-loop-done stops the run when main moved and the drift merge did not land", () => {
  const s = { fixOwed: false, fixMerged: false, nothingOpen: true, mainMoved: "fail" as const, prePush: null };
  assert.throws(() => closeDecision({ ...s, driftMerged: false }), /drift merge did not land/);
  assert.equal(closeDecision({ ...s, driftMerged: true }).done, false);
});

test("a drift merge owes a read only in the run's first drift group", () => {
  assert.equal(driftReadOwed(["src/a.ts"], 0).owed, true);
  assert.equal(driftReadOwed(["src/a.ts"], 1).owed, false);
  assert.match(driftReadOwed(["src/a.ts"], 1).why, /one drift group/);
  assert.equal(driftReadOwed([], 0).owed, false);
});

test("K-pre-push-ship answers pass on green and fail on red, a result and not a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-ship-"));
  const tree = repo(join(dir, "tree"));
  const green = await CHECKS["pre-push-ship"]!(checkReq(dir, tree, { "repo-config": repoConfig(dir, tree, { steps: { checks: "true" } }) }));
  assert.equal(green.answer, "pass");
  const red = await CHECKS["pre-push-ship"]!(checkReq(dir, tree, { "repo-config": repoConfig(dir, tree, { steps: { checks: "false" } }) }));
  assert.equal(red.answer, "fail");
  assert.match(red.detail, /checks: red/);
  rmSync(dir, { recursive: true });
});

test("the base is fetched from the upstream; a repo with no remote reads its local main and says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-base-"));
  const bare = join(dir, "bare.git");
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  const seed = repo(join(dir, "seed"));
  git(seed, "push", "-q", bare, "main");
  git(dir, "clone", "-q", bare, join(dir, "run"));
  git(seed, "commit", "-q", "--allow-empty", "-m", "main moved");
  git(seed, "push", "-q", bare, "main");
  const moved = git(seed, "rev-parse", "HEAD");
  const run = join(dir, "run");
  assert.notEqual(git(run, "rev-parse", "main"), moved, "the local main is stale");
  const base = resolveBase(run, "main");
  assert.equal(base.sha, moved);
  assert.equal(base.ref, "origin/main");
  const local = resolveBase(seed, "main");
  assert.equal(local.ref, "main");
  assert.match(local.note, /no remote/);
  rmSync(dir, { recursive: true });
});

test("an amend of a brief kept in the store is graded against the brief the table saw", async () => {
  const v1 = briefText();
  const v2 = v1.replace("1. app answers", "1. app answers twice");
  for (const [now, verifier, manifest] of [[v2, "pass", "fail"], [v1, "fail", "pass"]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "graph-amend-"));
    const tree = repo(join(dir, "tree"));
    const head = git(tree, "rev-parse", "HEAD");
    git(tree, "checkout", "-q", "-b", "fix");
    git(tree, "commit", "-q", "--allow-empty", "-m", "amend brief: say twice");
    git(tree, "checkout", "-q", "main");
    git(tree, "merge", "-q", "--ff-only", "fix");
    const table: TableJson = { schema: 2, rounds: { "1": { head, rows: [], leftovers: [], banked: [], closed: [], consumed: [], refused: [] } } };
    const state: TableState = { round: "1", rows: [], fixed: [], driftGroups: 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [], brief: briefMark(v1) };
    const plan: SlicePlan = { round: "1", slices: [{ id: "S1", drafts: [], rows: [], files: [], peers: [] }] };
    const ctx = opContext(dir, {
      nodeId: "D-merge-fix",
      role: "merge-fix",
      inputs: {
        "slice-fix": files(put(join(dir, "in", "fix", "fix-1.txt"), `exit checks:\n${EXIT_CHECKS.map((k) => `${k}: none`).join("\n")}\n`)),
        "slice-plan": files(put(join(dir, "in", "plan", PLAN_FILE), JSON.stringify(plan))),
        table: files(put(join(dir, "in", "table", "table.json"), serialiseTableJson(table)), put(join(dir, "in", "table", "state.json"), JSON.stringify(state))),
        brief: files(put(join(dir, "in", "brief", "quick-x.md"), now)),
        "repo-config": repoConfig(dir, tree),
      },
      outputs: ["fix-file", "fix-diff", "owed-review-fix-call", "owed-review-fix", "owed-manifest-fix", "owed-completeness-fix", "owed-security-fix", "owed-hand-test-fix"],
      place: { worktree: tree, branch: "main", baseSha: head },
      iteration: 1,
    });
    const r = await OPS["merge-fix"]!(ctx);
    assert.equal(r.status, "done");
    const out = r.status === "done" ? r.outputs : {};
    assert.equal(out["owed-completeness-fix"]?.schema === "check" && out["owed-completeness-fix"].answer, verifier);
    assert.equal(out["owed-manifest-fix"]?.schema === "check" && out["owed-manifest-fix"].answer, manifest);
    rmSync(dir, { recursive: true });
  }
});

test("a retried D-commit-brief leaves one work-start comment, and a run whose id extends another's gets its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-brief-"));
  const tree = repo(join(dir, "tree"));
  const tracker = fileTracker(join(dir, "t"));
  const ctxFor = (runId: string, attempt: number): OpContext =>
    opContext(dir, {
      runId,
      nodeId: "D-commit-brief",
      role: "commit-brief",
      inputs: {
        brief: files(put(join(dir, "in", "brief", "quick-x.md"), briefText())),
        "repo-config": repoConfig(dir, tree),
        "ticket-id": { schema: "text", text: "DEV-3" },
      },
      outputs: ["work-start"],
      outDir: join(dir, "out", `${runId}-${attempt}`),
      place: { worktree: tree, branch: "main", baseSha: git(tree, "rev-parse", "HEAD") },
      iteration: 1,
      tracker,
    });
  const commentFiles = () => readdirSync(join(dir, "t", "comments"));
  const workStart = (r: Awaited<ReturnType<(typeof OPS)[string]>>) => (r.status === "done" && r.outputs["work-start"]?.schema === "files" ? jsonIn(r.outputs["work-start"], "work-start.json") : {});

  const first = await OPS["commit-brief"]!(ctxFor("run-1", 1));
  const retry = await OPS["commit-brief"]!(ctxFor("run-1", 2));
  assert.equal(commentFiles().length, 1);
  assert.deepEqual(workStart(retry).comment, workStart(first).comment);
  assert.match(JSON.parse(readFileSync(join(dir, "t", "comments", "1.json"), "utf8")).body, /^Work started: run run-1, brief quick-x at [0-9a-f]{9}\.$/);

  await OPS["commit-brief"]!(ctxFor("run-10", 1));
  assert.equal(commentFiles().length, 2);
  rmSync(dir, { recursive: true });
});

/** A brief with two parts side by side: P1 owns src/app.ts, P2 owns src/b.ts. */
const TWO_PARTS = [
  "class: R1 — operator, 2026-09-28",
  "model: sonnet — the brief names every file",
  "",
  "## Target files",
  "",
  "- src/app.ts",
  "- src/b.ts",
  "",
  "## Parts",
  "",
  ...["P1 · the app answers|src/app.ts|1", "P2 · b answers|src/b.ts|2"].flatMap((p) => {
    const [head, files, d] = p.split("|");
    return [`- ${head}`, "  - model: sonnet — small", `  - files: ${files}`, "  - test files: none", `  - deliverables: ${d}`, "  - after: none", "  - tests: none"];
  }),
  "",
  "## Hand test",
  "",
  "- H1 · the app answers",
  "  - run: `node src/app.ts`",
  "  - pass: exit 0",
  "",
  "## Deliverables",
  "",
  "1. app answers",
  "2. b answers",
  "",
].join("\n");

test("a builder's commit that touches another part's file fails K-output-format's check; a file no part lists does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-part-"));
  const tree = repo(join(dir, "tree"));
  const commitOn = (branch: string, paths: string[]): string => {
    git(tree, "checkout", "-q", "-b", branch, "main");
    for (const p of paths) put(join(tree, p), `${branch}\n`);
    git(tree, "add", ".");
    git(tree, "commit", "-q", "-m", branch);
    const sha = git(tree, "rev-parse", "HEAD");
    git(tree, "checkout", "-q", "main");
    return sha;
  };
  const own = commitOn("own", ["src/app.ts", "README.md"]);
  const foreign = commitOn("foreign", ["src/app.ts", "src/b.ts"]);
  const brief = files(put(join(dir, "in", "brief", "quick-x.md"), TWO_PARTS));
  const req = (sha: string) =>
    checkReq(dir, tree, { "part-commit": { schema: "ref", kind: "commit", id: sha }, "builder-report": files(put(join(dir, "in", "report", "report.md"), "built\n")) }, {
      formats: { "builder-report": "builder-report" },
      subject: { node: "A-builder", iteration: 0, instance: "P1" },
      subjectInputs: { brief },
    });
  assert.deepEqual(foreignPartPaths(req(own)), [], "README.md is an out-of-lane fix no part lists");
  assert.deepEqual(foreignPartPaths(req(foreign)), ["part P1's commit touches src/b.ts, which part P2 lists: a STOP, not an edit"]);
  rmSync(dir, { recursive: true });
});

// ---- D-pull-main, D-pull-main-drift and K-main-moved against an upstream ----

const tenLines = (first: string, last: string) => `${[first, ...Array.from({ length: 8 }, (_, i) => `line ${i + 2}`), last].join("\n")}\n`;

interface World {
  dir: string;
  tree: string;
  /** The commit the branch started from. */
  base: string;
  /** Where the run tree's branch is before any freshen. */
  before: string;
  /** What main is at after its move (the upstream's), or null when it did not move. */
  moved: string | null;
}

/**
 * A run tree on branch `work` that edited line 1 of a.txt after `base`. With a remote, the tree is a
 * clone of a bare upstream and main then moves there (`a`: line 10 of a.txt, a file the branch changed;
 * `c`: c.txt, one it did not; `none`); without one the tree is the only repo and main stays at `base`.
 */
function world(opts: { remote: boolean; main: "a" | "c" | "none" }): World {
  const dir = mkdtempSync(join(tmpdir(), "graph-freshen-"));
  const seed = repo(join(dir, "seed"));
  put(join(seed, "a.txt"), tenLines("one", "ten"));
  put(join(seed, "c.txt"), "c\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "files");
  let tree = seed;
  if (opts.remote) {
    const bare = join(dir, "bare.git");
    git(dir, "init", "-q", "--bare", "-b", "main", bare);
    git(seed, "push", "-q", bare, "main");
    tree = join(dir, "tree");
    git(dir, "clone", "-q", bare, tree);
  }
  const base = git(tree, "rev-parse", "HEAD");
  git(tree, "checkout", "-q", "-b", "work");
  put(join(tree, "a.txt"), tenLines("one, edited by the branch", "ten"));
  git(tree, "commit", "-q", "-am", "branch edit");
  const before = git(tree, "rev-parse", "HEAD");
  let moved: string | null = null;
  if (opts.remote && opts.main !== "none") {
    if (opts.main === "a") put(join(seed, "a.txt"), tenLines("one", "ten, edited by main"));
    else put(join(seed, "c.txt"), "c, edited by main\n");
    git(seed, "commit", "-q", "-am", "main moves");
    git(seed, "push", "-q", join(dir, "bare.git"), "main");
    moved = git(seed, "rev-parse", "HEAD");
  }
  return { dir, tree, base, before, moved };
}

function freshenCtx(w: World, role: "wave" | "drift", over: { driftGroups?: number } = {}): OpContext {
  const state: TableState = { round: "1", rows: [], fixed: [], driftGroups: over.driftGroups ?? 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [] };
  const inputs: DataValues = {
    "repo-config": repoConfig(w.dir, w.tree),
    "run-tree": files(put(join(w.dir, "in", "run-tree", "run-tree.json"), JSON.stringify({ tree: w.tree, branch: "work", base: w.base, baseRef: "main" }))),
    table: files(put(join(w.dir, "in", "table", "state.json"), JSON.stringify(state))),
  };
  return opContext(w.dir, {
    nodeId: role === "wave" ? "D-pull-main" : "D-pull-main-drift",
    role: "pull-main",
    inputs,
    outputs: role === "wave" ? ["diff"] : ["drift-diff", "drift-first"],
    place: { worktree: w.tree, branch: "work", baseSha: w.base },
    iteration: 1,
  });
}

const outputs = (r: Awaited<ReturnType<(typeof OPS)[string]>>) => {
  assert.equal(r.status, "done");
  return r.status === "done" ? r.outputs : {};
};
const jsonIn = (v: unknown, name: string): Record<string, unknown> => {
  const f = (v as FilesValue).files.find((p) => p.endsWith(name));
  assert.ok(f, `no ${name}`);
  return JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
};
const answerOf = (v: unknown): { answer: string; detail: string } => v as { answer: string; detail: string };

test("D-pull-main merges the fetched upstream main and records it as the diff's upstream, with the branch's own files", async () => {
  const w = world({ remote: true, main: "c" });
  const out = outputs(await OPS["pull-main"]!(freshenCtx(w, "wave")));
  const head = git(w.tree, "rev-parse", "HEAD");
  assert.notEqual(head, w.before, "main's move was merged");
  assert.deepEqual(out["pull-main-head"], { schema: "ref", kind: "commit", id: head });
  const diff = jsonIn(out.diff, "diff.json");
  assert.deepEqual(diff.upstream, { ref: "origin/main", sha: w.moved, note: "fetched main from origin" });
  assert.equal(diff.merged, true);
  assert.equal(diff.base, w.base);
  assert.deepEqual(diff.files, ["a.txt"], "the PR's diff is the branch's change, not what main brought");
  rmSync(w.dir, { recursive: true });
});

test("D-pull-main in a repo with no remote reads the local main, says so in the upstream note, and merges nothing", async () => {
  const w = world({ remote: false, main: "none" });
  const out = outputs(await OPS["pull-main"]!(freshenCtx(w, "wave")));
  assert.equal(git(w.tree, "rev-parse", "HEAD"), w.before);
  const diff = jsonIn(out.diff, "diff.json");
  const upstream = diff.upstream as { ref: string; sha: string; note: string };
  assert.equal(upstream.ref, "main");
  assert.equal(upstream.sha, w.base);
  assert.match(upstream.note, /no remote/);
  assert.equal(diff.merged, false);
  assert.deepEqual(diff.files, ["a.txt"]);
  rmSync(w.dir, { recursive: true });
});

test("D-pull-main-drift owes a read when main touched a file the branch changed and the run has no drift group yet", async () => {
  const w = world({ remote: true, main: "a" });
  const out = outputs(await OPS["pull-main"]!(freshenCtx(w, "drift", { driftGroups: 0 })));
  const first = answerOf(out["drift-first"]);
  assert.equal(first.answer, "pass");
  assert.match(first.detail, /main touched the branch's a\.txt/);
  const diff = jsonIn(out["drift-diff"], "diff.json");
  assert.deepEqual(diff.files, ["a.txt"]);
  assert.deepEqual(diff.overlap, ["a.txt"]);
  assert.equal(diff.range, `${w.before}..${git(w.tree, "rev-parse", "HEAD")}`);
  assert.deepEqual(diff.upstream, { ref: "origin/main", sha: w.moved, note: "fetched main from origin" });
  assert.deepEqual(out["drift-head"], { schema: "ref", kind: "commit", id: git(w.tree, "rev-parse", "HEAD") });
  rmSync(w.dir, { recursive: true });
});

test("D-pull-main-drift owes no read once the table counts a drift group, though the overlap is still reported", async () => {
  const w = world({ remote: true, main: "a" });
  const out = outputs(await OPS["pull-main"]!(freshenCtx(w, "drift", { driftGroups: 1 })));
  const first = answerOf(out["drift-first"]);
  assert.equal(first.answer, "fail");
  assert.match(first.detail, /one drift group/);
  assert.deepEqual(jsonIn(out["drift-diff"], "diff.json").overlap, ["a.txt"]);
  rmSync(w.dir, { recursive: true });
});

test("D-pull-main-drift owes no read when main touched only files the branch did not change", async () => {
  const w = world({ remote: true, main: "c" });
  const out = outputs(await OPS["pull-main"]!(freshenCtx(w, "drift")));
  assert.equal(answerOf(out["drift-first"]).answer, "fail");
  assert.match(answerOf(out["drift-first"]).detail, /none of the branch's files/);
  const diff = jsonIn(out["drift-diff"], "diff.json");
  assert.deepEqual(diff.files, ["c.txt"]);
  assert.deepEqual(diff.overlap, []);
  rmSync(w.dir, { recursive: true });
});

test("D-pull-main-drift with main already in the branch brings nothing: an empty patch, no files, no read", async () => {
  const w = world({ remote: true, main: "none" });
  const out = outputs(await OPS["pull-main"]!(freshenCtx(w, "drift")));
  assert.equal(answerOf(out["drift-first"]).answer, "fail");
  const diff = jsonIn(out["drift-diff"], "diff.json");
  assert.deepEqual(diff.files, []);
  assert.equal(diff.range, `${w.before}..${w.before}`);
  const patch = ((out["drift-diff"] as FilesValue).files.find((p) => p.endsWith("diff.patch")))!;
  assert.equal(readFileSync(patch, "utf8"), "");
  rmSync(w.dir, { recursive: true });
});

test("D-pull-main-drift reads the drift group count from the table's state.json", async () => {
  const w = world({ remote: true, main: "a" });
  const ctx = freshenCtx(w, "drift", { driftGroups: 0 });
  assert.equal(answerOf(outputs(await OPS["pull-main"]!(ctx))["drift-first"]).answer, "pass");
  rmSync(w.dir, { recursive: true });
  const again = world({ remote: true, main: "a" });
  const ctx2 = freshenCtx(again, "drift", { driftGroups: 2 });
  assert.equal(answerOf(outputs(await OPS["pull-main"]!(ctx2))["drift-first"]).answer, "fail");
  rmSync(again.dir, { recursive: true });
});

test("D-pull-main stops the run, naming a person, when main conflicts with the branch", async () => {
  const w = world({ remote: true, main: "a" });
  // The branch edits line 10 too, so the upstream's edit to it conflicts.
  put(join(w.tree, "a.txt"), tenLines("one, edited by the branch", "ten, edited by the branch"));
  git(w.tree, "commit", "-q", "-am", "branch edits line 10");
  const head = git(w.tree, "rev-parse", "HEAD");
  await assert.rejects(OPS["pull-main"]!(freshenCtx(w, "wave")), (e: unknown) => e instanceof RunError && /conflicts on a\.txt.*a person resolves it/.test(e.message));
  assert.equal(git(w.tree, "rev-parse", "HEAD"), head, "the run tree is left as it was");
  rmSync(w.dir, { recursive: true });
});

test("K-main-moved passes when the upstream's main is already in the branch, naming the ref it read", async () => {
  const w = world({ remote: true, main: "none" });
  const r = await CHECKS["main-moved"]!(checkReq(w.dir, w.tree, { "repo-config": repoConfig(w.dir, w.tree) }, { role: "main-moved", nodeId: "K-main-moved" }));
  assert.equal(r.answer, "pass");
  assert.match(r.detail, /origin\/main .* is in the branch; fetched main from origin/);
  assert.equal(jsonIn(r.outputs!["drift-report"], "drift.json").moved, false);
  rmSync(w.dir, { recursive: true });
});

test("K-main-moved fails when main moved, counting main's files and the ones the branch changed too", async () => {
  for (const [main, mainFiles, overlap] of [["a", ["a.txt"], ["a.txt"]], ["c", ["c.txt"], []]] as const) {
    const w = world({ remote: true, main });
    const r = await CHECKS["main-moved"]!(checkReq(w.dir, w.tree, { "repo-config": repoConfig(w.dir, w.tree) }, { role: "main-moved", nodeId: "K-main-moved" }));
    assert.equal(r.answer, "fail");
    assert.match(r.detail, new RegExp(`origin/main moved to ${w.moved!.slice(0, 9)}: 1 files, ${overlap.length} of them the branch's`));
    const report = jsonIn(r.outputs!["drift-report"], "drift.json");
    assert.deepEqual([report.mainFiles, report.overlap, report.mergeBase, report.moved], [mainFiles, overlap, w.base, true]);
    rmSync(w.dir, { recursive: true });
  }
});

test("K-main-moved in a repo with no remote reads the local main and passes with that in its detail", async () => {
  const w = world({ remote: false, main: "none" });
  const r = await CHECKS["main-moved"]!(checkReq(w.dir, w.tree, { "repo-config": repoConfig(w.dir, w.tree) }, { role: "main-moved", nodeId: "K-main-moved" }));
  assert.equal(r.answer, "pass");
  assert.match(r.detail, /no remote: read the local main/);
  rmSync(w.dir, { recursive: true });
});

// ---- K-loop-done ----

const closeReq = (inputs: DataValues) => checkReq("/unused", "/unused", inputs, { role: "loop-done", nodeId: "K-loop-done" });
const ref = (id: string) => ({ schema: "ref" as const, kind: "commit" as const, id });

test("K-loop-done ends the loop (pass) only on green checks, and goes again (fail) when a fix merged", async () => {
  const done = await CHECKS["loop-done"]!(closeReq({ "fix-owed": ck("fail"), "nothing-open": ck("pass"), "pre-push": ck("pass") }));
  assert.equal(done.answer, "pass");
  assert.match(done.detail, /nothing to fix, no drift/);
  const again = await CHECKS["loop-done"]!(closeReq({ "fix-owed": ck("pass"), "fix-head": ref("a".repeat(40)), "nothing-open": ck("fail") }));
  assert.equal(again.answer, "fail");
  assert.match(again.detail, /a fix round merged/);
});

test("K-loop-done with rows left open but green checks ends the loop for the draft", async () => {
  const r = await CHECKS["loop-done"]!(closeReq({ "fix-owed": ck("fail"), "nothing-open": ck("fail"), "pre-push": ck("pass") }));
  assert.equal(r.answer, "pass");
  assert.match(r.detail, /rows are left open/);
});

test("K-loop-done stops the run when a fix was owed and no fix-head came back", async () => {
  await assert.rejects(CHECKS["loop-done"]!(closeReq({ "fix-owed": ck("pass"), "nothing-open": ck("fail") })), /fix round was owed and no fix merged/);
});

test("K-loop-done reads a missing or non-check input as not passed: no checks input stops it", async () => {
  await assert.rejects(CHECKS["loop-done"]!(closeReq({ "fix-owed": ck("fail"), "nothing-open": ck("pass") })), /pre-push checks did not run/);
  await assert.rejects(
    CHECKS["loop-done"]!(closeReq({ "fix-owed": { schema: "text", text: "pass" }, "fix-head": ref("a".repeat(40)), "nothing-open": ck("pass") })),
    /pre-push checks did not run/,
    "a fix-owed that is not a check does not count as owed"
  );
});

test("K-loop-done goes again on red checks and on a drift merge that landed; stops on a drift merge that did not", async () => {
  const red = await CHECKS["loop-done"]!(closeReq({ "fix-owed": ck("fail"), "nothing-open": ck("pass"), "pre-push": ck("fail") }));
  assert.equal(red.answer, "fail");
  assert.match(red.detail, /pre-push checks are red/);
  const drifted = await CHECKS["loop-done"]!(closeReq({ "fix-owed": ck("fail"), "nothing-open": ck("pass"), "main-moved": ck("fail"), "drift-head": ref("b".repeat(40)) }));
  assert.equal(drifted.answer, "fail");
  assert.match(drifted.detail, /main moved/);
  await assert.rejects(CHECKS["loop-done"]!(closeReq({ "fix-owed": ck("fail"), "nothing-open": ck("pass"), "main-moved": ck("fail") })), /drift merge did not land/);
});

// ---- K-tests: the verify phase's edits ----

test("a line the verify phase changed that the author phase added is a red row of K-tests, in a new test file or one that was there; an appended line, or a line from before the authors, is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-verify-edits-"));
  const tree = repo(join(dir, "tree"));
  put(join(tree, "src", "old.test.ts"), "keep\nfirst\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "base");
  const brief = git(tree, "rev-parse", "HEAD");
  put(join(tree, "src", "new.test.ts"), "a\nexpect(x).toBe(1)\nb\n");
  put(join(tree, "src", "old.test.ts"), "keep\nfirst\nexpect(y).toBe(1)\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "author");
  const integration = git(tree, "rev-parse", "HEAD");
  put(join(tree, "src", "new.test.ts"), "a\nexpect(x).toBe(2)\nb\nc\n");
  put(join(tree, "src", "old.test.ts"), "kept\nfirst\nexpect(y).toBe(2)\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "verify");
  const verify = git(tree, "rev-parse", "HEAD");
  const commit = (id: string) => ({ schema: "ref" as const, kind: "commit" as const, id });
  const r = await CHECKS.tests!(
    checkReq(dir, tree, { "repo-config": repoConfig(dir, tree), "brief-commit": commit(brief), "install-head": commit(integration), "proofs-head": commit(verify) }, { role: "tests", nodeId: "K-tests", outputs: ["test-rows"] })
  );
  assert.equal(r.answer, "pass", "no tests step: the step itself is skipped");
  const out = r.outputs!["test-rows"];
  const rows = JSON.parse(readFileSync(out?.schema === "files" ? out.files[0]! : "", "utf8")) as { locator: string; kind: string; finding: string }[];
  assert.deepEqual(rows.map((r) => r.locator), ["src/new.test.ts:2", "src/old.test.ts:3"], "the appended line c and the edit of keep, which was there before the authors, are no rows");
  assert.equal(rows[0]!.kind, "test-app");
  assert.match(rows[0]!.finding, /was `expect\(x\)\.toBe\(1\)`, now `expect\(x\)\.toBe\(2\)`/);
  assert.match(rows[1]!.finding, /was `expect\(y\)\.toBe\(1\)`, now `expect\(y\)\.toBe\(2\)`/);
  rmSync(dir, { recursive: true });
});

test("every slice's verify edit is a row whatever order the slices merged in: the range ends at the run tree's head, not at proofs-head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-verify-order-"));
  const tree = repo(join(dir, "tree"));
  const brief = git(tree, "rev-parse", "HEAD");
  put(join(tree, "src", "a.test.ts"), "expect(a).toBe(1)\n");
  put(join(tree, "src", "b.test.ts"), "expect(b).toBe(1)\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "authors W1 and W2");
  const integration = git(tree, "rev-parse", "HEAD");
  const slice = (name: string, file: string, text: string) => {
    git(tree, "checkout", "-q", "-b", name, integration);
    put(join(tree, "src", file), text);
    git(tree, "commit", "-q", "-am", `verify ${name}`);
    git(tree, "checkout", "-q", "-");
  };
  git(tree, "checkout", "-q", "-b", "run");
  slice("W1", "a.test.ts", "expect(a).toBe(2)\n");
  slice("W2", "b.test.ts", "expect(b).toBe(2)\n");
  git(tree, "merge", "-q", "--no-ff", "-m", "merge W2", "W2");
  const lastItemHead = git(tree, "rev-parse", "HEAD");
  git(tree, "merge", "-q", "--no-ff", "-m", "merge W1", "W1");
  const commit = (id: string) => ({ schema: "ref" as const, kind: "commit" as const, id });
  const r = await CHECKS.tests!(
    checkReq(dir, tree, { "repo-config": repoConfig(dir, tree), "brief-commit": commit(brief), "install-head": commit(integration), "proofs-head": commit(lastItemHead) }, { role: "tests", nodeId: "K-tests", outputs: ["test-rows"] })
  );
  const out = r.outputs!["test-rows"];
  const rows = JSON.parse(readFileSync(out?.schema === "files" ? out.files[0]! : "", "utf8")) as { locator: string }[];
  assert.deepEqual(rows.map((x) => x.locator).sort(), ["src/a.test.ts:1", "src/b.test.ts:1"], "W1 merged after the last item's head and is still read");
  rmSync(dir, { recursive: true });
});

// ---- D-open-pr: the PR body lists the answers ----

const asked = (over: Partial<QuestionRun["question"]> = {}): QuestionRun["question"] => ({ id: "P1-Q.1", type: "brief", text: "which file owns the retry?", searched: [{ source: "brief", said: "names no owner" }], ...over });
const qrun = (question: QuestionRun["question"], answer?: QuestionRun["answer"]): QuestionRun => ({ from: { node: "A-builder", iteration: 0 }, question, route: "resolver", ...(answer === undefined ? {} : { answer }) });

test("the PR body's answers list gives each answered question with its answer, source, who answered and what was searched; an unanswered one is left out", () => {
  const resolved = qrun(asked(), { question_id: "P1-Q.1", answer: "src/retry.ts", source: "code", by: "resolver", searched: [{ source: "code", said: "retry.ts owns it" }, { source: "docs", said: "silent" }] });
  const operator = qrun(asked({ id: "S.2", type: "product", text: "drop the flag?", searched: [{ source: "plan", said: "undecided" }] }), { question_id: "S.2", answer: "drop it", source: "operator", by: "operator" });
  const amending = qrun(asked({ id: "S.3", searched: [] }), { question_id: "S.3", answer: "use v2", source: "brief", by: "resolver", searched: [{ source: "brief", said: "v1" }], brief_change: "say v2" });
  const open = qrun(asked({ id: "S.4" }));
  const text = answersSection([resolved, operator, amending, open]);
  assert.match(text, /^\n\n## Answers\n\n/);
  assert.match(text, /- \*\*P1-Q\.1\*\* \(brief\): which file owns the retry\?\n {2}- answer: src\/retry\.ts\n {2}- source: code, by the resolver\n {2}- searched: code: retry\.ts owns it; docs: silent/);
  assert.match(text, /- \*\*S\.2\*\* \(product\): drop the flag\?\n {2}- answer: drop it\n {2}- source: operator, by the operator\n {2}- searched: plan: undecided/, "an operator answer carries no searched list of its own: the asker's is shown");
  assert.match(text, /source: brief, by the resolver; brief change: say v2\n {2}- searched: brief: v1/);
  assert.doesNotMatch(text, /S\.4/);
  assert.equal(answersSection([open]), "");
  assert.equal(answersSection([]), "");
  assert.match(answersSection([qrun(asked({ searched: [] }), { question_id: "P1-Q.1", answer: "x", source: "plan", by: "resolver" })]), /searched: nothing/);
});

test("D-open-pr opens the PR with the answers in its body, between the final round and the ticket line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-pr-"));
  const tree = repo(join(dir, "tree"));
  const brief = put(join(dir, "in", "brief", "quick-x.md"), `# Retry the push\n\n${briefText()}`);
  const final = put(join(dir, "in", "final", "final.md"), "# Final round\n");
  const record = {
    questions: [qrun(asked(), { question_id: "P1-Q.1", answer: "src/retry.ts", source: "code", by: "resolver", searched: [{ source: "code", said: "retry.ts owns it" }] })],
  } as RunHistory;
  const forgeDir = join(dir, "f");
  const ctx = opContext(dir, {
    nodeId: "D-open-pr",
    role: "open-pr",
    inputs: { brief: files(brief), final: files(final), "final-clean": ck("pass"), "ticket-id": { schema: "text", text: "DEV-9" } },
    outputs: ["pr"],
    place: { worktree: tree, branch: "work" },
    record,
  });
  assert.equal((await OPS["open-pr"]!(ctx)).status, "done");
  const pr = JSON.parse(readFileSync(join(forgeDir, "prs", "1.json"), "utf8")) as { title: string; body: string; draft: boolean };
  assert.equal(pr.title, "Retry the push");
  assert.equal(pr.draft, false);
  const at = (needle: string) => pr.body.indexOf(needle);
  assert.ok(at("# Final round") >= 0 && at("# Final round") < at("## Answers") && at("## Answers") < at("Fixes DEV-9"), pr.body);
  assert.match(pr.body, /answer: src\/retry\.ts\n {2}- source: code, by the resolver/);
  const without = { ...ctx, record: { questions: [] } as unknown as RunHistory };
  await OPS["open-pr"]!(without);
  assert.doesNotMatch((JSON.parse(readFileSync(join(forgeDir, "prs", "2.json"), "utf8")) as { body: string }).body, /## Answers/);
  rmSync(dir, { recursive: true });
});

test("D-open-pr opens a draft after a capped loop whose ship checks did not answer, and a ready PR after a clean loop that never ran them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-pr-"));
  const tree = repo(join(dir, "tree"));
  const brief = put(join(dir, "in", "brief", "quick-x.md"), `# Retry the push\n\n${briefText()}`);
  const final = put(join(dir, "in", "final", "final.md"), "# Final round\n");
  const forgeDir = join(dir, "f");
  const ctx = (inputs: DataValues): OpContext =>
    opContext(dir, {
      nodeId: "D-open-pr",
      role: "open-pr",
      inputs: { brief: files(brief), final: files(final), "final-clean": ck("pass"), ...inputs },
      outputs: ["pr"],
      place: { worktree: tree, branch: "work" },
    });
  const draftOf = (n: number) => (JSON.parse(readFileSync(join(forgeDir, "prs", `${n}.json`), "utf8")) as { draft: boolean }).draft;
  await OPS["open-pr"]!(ctx({ "close-outcome": loop("capped") }));
  assert.equal(draftOf(1), true, "K-pre-push-ship failed: no answer after a capped loop is not green");
  await OPS["open-pr"]!(ctx({ "close-outcome": loop("clean") }));
  assert.equal(draftOf(2), false);
  await OPS["open-pr"]!(ctx({ "close-outcome": loop("capped"), "pre-push-ship": ck("pass") }));
  assert.equal(draftOf(3), false);
  rmSync(dir, { recursive: true });
});

test("D-open-pr whose repo push step refuses the branch (a push gate that re-runs the red checks) fails, with the step's output in its error, and opens no PR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-pr-"));
  const tree = repo(join(dir, "tree"));
  const brief = put(join(dir, "in", "brief", "quick-x.md"), `# Retry the push\n\n${briefText()}`);
  const final = put(join(dir, "in", "final", "final.md"), "# Final round\n");
  const scripts: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    scripts.push(cmd === "sh" ? args[1]! : cmd);
    return { code: 1, stdout: "", stderr: "push gate: checks are red\nlint: 3 errors", output: "push gate: checks are red\nlint: 3 errors" };
  };
  const ctx = opContext(dir, {
    nodeId: "D-open-pr",
    role: "open-pr",
    inputs: { brief: files(brief), final: files(final), "final-clean": ck("pass"), "close-outcome": loop("capped"), "pre-push-ship": ck("fail") },
    outputs: ["pr"],
    place: { worktree: tree, branch: "work" },
    forge: githubForge("base0", { run, stepCommand: (_w, _b, step) => (step === "push" ? "pnpm push:gated" : (FALLBACKS[step] ?? null)) }),
  });
  await assert.rejects(OPS["open-pr"]!(ctx), /the push step `pnpm push:gated` exited 1\npush gate: checks are red\nlint: 3 errors/);
  assert.deepEqual(scripts, ["pnpm push:gated"], "no pr_open after a refused push");
  rmSync(dir, { recursive: true });
});

// ---- D-merge-pr: the wait after D-open-pr ----

interface MergeCall {
  pr: string;
  branch?: string;
  riskClass?: string;
}

/** A D-merge-pr context over a forge that records its merges and, when `mergeFails` is set, fails them
 *  with that (a text, or an error); its PR reads as `state` (OPEN by default; a function may throw). */
function mergeCtx(
  dir: string,
  over: { inputs?: DataValues; answers?: string[]; mergeFails?: string | Error; state?: () => string; signal?: AbortSignal; tracker?: OpContext["tracker"]; forge?: Forge } = {}
) {
  const tree = repo(join(dir, "tree"));
  const merges: MergeCall[] = [];
  const reads: string[] = [];
  const forge: Forge = over.forge ?? {
    ...fileForge(join(dir, "f")),
    async merge(req) {
      merges.push({ pr: req.pr, ...(req.branch === undefined ? {} : { branch: req.branch }), ...(req.riskClass === undefined ? {} : { riskClass: req.riskClass }) });
      if (over.mergeFails !== undefined) throw typeof over.mergeFails === "string" ? new Error(over.mergeFails) : over.mergeFails;
      return { schema: "ref", kind: "merge", id: req.pr };
    },
    async prState(req) {
      reads.push(req.pr);
      return over.state === undefined ? "OPEN" : over.state();
    },
  };
  const inputs: DataValues = {
    pr: { schema: "ref", kind: "pr", id: "7", url: "https://example.test/pull/7" },
    brief: files(put(join(dir, "in", "brief", "quick-x.md"), `# Retry the push\n\n${briefText()}`)),
    final: files(put(join(dir, "in", "final", "final.md"), "# Final round\n")),
    "final-clean": ck("pass"),
    "ship-gate": ck("pass"),
    start: { schema: "text", text: JSON.stringify({ request: "x", hold: false }) },
    ...over.inputs,
  };
  const ctx = opContext(dir, {
    runId: "run-9",
    nodeId: "D-merge-pr",
    role: "merge-pr",
    inputs,
    outputs: ["merge"],
    place: { worktree: tree, branch: "work" },
    forge,
    ...(over.tracker && { tracker: over.tracker }),
    ...(over.signal && { signal: over.signal }),
    ...(over.answers && { answers: over.answers }),
  });
  return { ctx, merges, reads };
}

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "graph-mergepr-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const questionOf = (r: { status: string; question?: string }): string => {
  assert.equal(r.status, "needs-operator", JSON.stringify(r));
  return r.question!;
};

test("D-merge-pr merges at once when nothing holds the run: no question, the PR, its branch and class reach the merge step", async () => {
  await withDir(async (dir) => {
    const { ctx, merges } = mergeCtx(dir, { inputs: { "pre-push-ship": ck("pass") } });
    const r = await OPS["merge-pr"]!(ctx);
    assert.equal(r.status, "done");
    assert.deepEqual(r.status === "done" && r.outputs.merge, { schema: "ref", kind: "merge", id: "7" });
    assert.equal(merges.length, 1);
    assert.deepEqual([merges[0]!.pr, merges[0]!.branch, merges[0]!.riskClass], ["7", "work", "R1"], "the PR, its branch and the brief's class reach the merge step");
  });
});

test("D-merge-pr asks, with the PR link and the reason, when the final round is not clean; it merges nothing", async () => {
  await withDir(async (dir) => {
    const { ctx, merges } = mergeCtx(dir, { inputs: { "final-clean": { schema: "check", answer: "fail", detail: "2 urgent rows open" } } });
    const q = questionOf(await OPS["merge-pr"]!(ctx));
    assert.match(q, /^https:\/\/example\.test\/pull\/7 waits: the final round is not clean: 2 urgent rows open\./);
    assert.match(q, /The final round: .*final\.md\./);
    assert.match(q, /Reply merge .*or abandon /);
    assert.deepEqual(merges, []);
  });
});

test("D-merge-pr asks when the start holds the run, naming the hold; a PR with no url is named by its number", async () => {
  await withDir(async (dir) => {
    const { ctx, merges } = mergeCtx(dir, { inputs: { start: { schema: "text", text: JSON.stringify({ request: "x", hold: true }) }, pr: { schema: "ref", kind: "pr", id: "7" } } });
    const q = questionOf(await OPS["merge-pr"]!(ctx));
    assert.match(q, /^PR 7 waits: the start holds the run before its merge\./);
    assert.deepEqual(merges, []);
  });
});

test("D-merge-pr asks when K-pre-push-ship is red, though the final round is clean", async () => {
  await withDir(async (dir) => {
    const { ctx, merges } = mergeCtx(dir, { inputs: { "pre-push-ship": { schema: "check", answer: "fail", detail: "checks: red\nlint failed" } } });
    const q = questionOf(await OPS["merge-pr"]!(ctx));
    assert.match(q, /the pre-push checks are red: checks: red/);
    assert.deepEqual(merges, []);
  });
});

test("D-merge-pr asks after a capped loop whose K-pre-push-ship did not answer, though the final round is clean and the gate green", async () => {
  await withDir(async (dir) => {
    const { ctx, merges } = mergeCtx(dir, { inputs: { "close-outcome": loop("capped") } });
    assert.match(questionOf(await OPS["merge-pr"]!(ctx)), /the pre-push checks did not answer after the capped close loop/);
    assert.deepEqual(merges, []);
    const clean = mergeCtx(join(dir, "clean"), { inputs: { "close-outcome": loop("clean") } });
    assert.equal((await OPS["merge-pr"]!(clean.ctx)).status, "done", "a clean loop never ran the ship checks and owes none");
  });
});

test("D-merge-pr asks when the gate is red", async () => {
  await withDir(async (dir) => {
    const { ctx } = mergeCtx(dir, { inputs: { "ship-gate": { schema: "check", answer: "fail", detail: "node A-fixer failed" } } });
    assert.match(questionOf(await OPS["merge-pr"]!(ctx)), /the gate is red: node A-fixer failed/);
  });
});

test("D-merge-pr on the reply merge runs the merge step although the run was held and the final round is not clean", async () => {
  await withDir(async (dir) => {
    const { ctx, merges } = mergeCtx(dir, { answers: ["  Merge "], inputs: { "final-clean": ck("fail"), start: { schema: "text", text: JSON.stringify({ request: "x", hold: true }) } } });
    const r = await OPS["merge-pr"]!(ctx);
    assert.equal(r.status, "done");
    assert.equal(merges.length, 1);
  });
});

const STEP_FAILED = "the merge step `gh pr merge` exited 1\ngh: Pull request is not mergeable: the base branch policy prohibits the merge\nGH_TOKEN=ghp_from_a_chatty_script";

test("D-merge-pr whose merge fails on an open PR asks again with the failure's first line, the PR's state and the file its output is in; the output never enters the question", async () => {
  await withDir(async (dir) => {
    const failing = mergeCtx(dir, { answers: ["merge"], mergeFails: STEP_FAILED });
    const r = await OPS["merge-pr"]!(failing.ctx);
    const q = questionOf(r);
    assert.ok(q.includes(`the merge failed: the merge step \`gh pr merge\` exited 1; the PR is OPEN; the whole output is in ${join(dirname(failing.ctx.outDir), "merge-failure-2.txt")}`), q);
    assert.match(q, /Reply merge .*or abandon /, "the two options are offered again");
    assert.doesNotMatch(q, /not mergeable|GH_TOKEN/, "the step's output stays out of the question, which the blocked event carries");
    assert.equal(readFileSync(join(dirname(failing.ctx.outDir), "merge-failure-2.txt"), "utf8"), `${STEP_FAILED}\n`);
    assert.match(r.status === "needs-operator" ? (r.reason ?? "") : "", /not mergeable: the base branch policy/, "the node's waiting reason keeps the output");
    assert.deepEqual([failing.merges.length, failing.reads], [1, ["7"]], "one merge, then one read of the PR");
    const retried = mergeCtx(join(dir, "again"), { answers: ["merge", "merge"] });
    assert.equal((await OPS["merge-pr"]!(retried.ctx)).status, "done", "the latest reply is the one read: the step runs again");
  });
});

test("D-merge-pr keeps only the end of a very long failed merge output in its reason, and the question stays short", async () => {
  await withDir(async (dir) => {
    const { ctx } = mergeCtx(dir, { answers: ["merge"], mergeFails: `the merge step \`m\` exited 1\n${"old line\n".repeat(1000)}the last line` });
    const r = await OPS["merge-pr"]!(ctx);
    assert.ok(questionOf(r).length < 1000, `${questionOf(r).length} characters`);
    const reason = r.status === "needs-operator" ? (r.reason ?? "") : "";
    assert.ok(reason.length < 3000, `${reason.length} characters`);
    assert.match(reason, /the last line$/);
  });
});

test("D-merge-pr whose merge failed on a PR GitHub already reports MERGED ends merged: a step refused on a merged PR, a wait that ran out before the queue merged it, a read that blipped", async () => {
  for (const failure of ["the merge step `gh pr merge` exited 1\nPull request #7 was already merged", "PR 7 is OPEN, queued but not merged after 600 s", "gh pr view exited 1\nconnection reset"]) {
    await withDir(async (dir) => {
      const { ctx, reads } = mergeCtx(dir, { answers: ["merge"], mergeFails: failure, state: () => "MERGED" });
      const r = await OPS["merge-pr"]!(ctx);
      assert.equal(r.status, "done", failure);
      assert.deepEqual(r.status === "done" && r.outputs.merge, { schema: "ref", kind: "merge", id: "7" });
      assert.deepEqual(reads, ["7"]);
    });
  }
});

test("D-merge-pr asks about a CLOSED PR, and about one whose state it could not read, naming it", async () => {
  await withDir(async (dir) => {
    const closed = mergeCtx(dir, { mergeFails: "PR 7 was closed without being merged", state: () => "CLOSED" });
    assert.match(questionOf(await OPS["merge-pr"]!(closed.ctx)), /the merge failed: PR 7 was closed without being merged; the PR is CLOSED;/);
    const unread = mergeCtx(join(dir, "u"), { mergeFails: STEP_FAILED, state: () => { throw new Error("gh pr view exited 1\nsecret body"); } });
    const q = questionOf(await OPS["merge-pr"]!(unread.ctx));
    assert.match(q, /the PR is unread \(its state could not be read\)/);
    assert.doesNotMatch(q, /secret body/);
  });
});

test("D-merge-pr fails, rather than asking forever, on a RunError from the forge: a step the repo does not map", async () => {
  await withDir(async (dir) => {
    const { ctx, reads } = mergeCtx(dir, { mergeFails: new RunError("forge: the repo maps a blank merge step in its build steps file") });
    await assert.rejects(OPS["merge-pr"]!(ctx), (e: unknown) => e instanceof RunError && /blank merge step/.test(e.message));
    assert.deepEqual(reads, [], "no read: no reply would change it");
  });
});

test("D-merge-pr over the real GitHub forge: a merge queue slower than the wait, then merged while the operator was asked, ends merged on the next merge", async () => {
  await withDir(async (dir) => {
    let t = 0;
    let merged = false;
    const scripts: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      scripts.push(cmd === "sh" ? args[1]! : `${cmd} ${args.join(" ")}`);
      if (cmd === "sh") return merged ? { code: 1, stdout: "", stderr: "Pull request #7 was already merged", output: "Pull request #7 was already merged" } : { code: 0, stdout: "auto-merge enabled", stderr: "", output: "auto-merge enabled" };
      const state = JSON.stringify({ state: merged ? "MERGED" : "OPEN" });
      return { code: 0, stdout: state, stderr: "", output: state };
    };
    const forge = githubForge("base0", { run, stepCommand: (_w, _b, step) => FALLBACKS[step] ?? null, sleep: async () => void (t += 60_000), now: () => t });
    const first = mergeCtx(dir, { forge });
    const q = questionOf(await OPS["merge-pr"]!(first.ctx));
    assert.match(q, /the merge failed: PR 7 is OPEN, queued but not merged after 600 s; the PR is OPEN;/);
    merged = true;
    const second = mergeCtx(join(dir, "2"), { forge, answers: ["merge"] });
    const r = await OPS["merge-pr"]!(second.ctx);
    assert.deepEqual(r.status === "done" && r.outputs.merge, { schema: "ref", kind: "merge", id: "7" }, "a PR GitHub reports MERGED ends the node merged, whatever the step said");
    assert.equal(scripts.filter((c) => c === FALLBACKS.merge).length, 2, "the reply merge ran the step again");
  });
});

test("D-merge-pr whose merge step is cut short by a cancel rethrows the cancel instead of asking the operator", async () => {
  await withDir(async (dir) => {
    const ac = new AbortController();
    const { ctx } = mergeCtx(dir, { answers: ["merge"], signal: ac.signal, mergeFails: "merge step killed by the cancel" });
    ac.abort(new Error("cancelled"));
    await assert.rejects(OPS["merge-pr"]!(ctx), /merge step killed by the cancel/);
  });
});

test("D-merge-pr on any other reply asks again, naming merge and abandon and quoting the reply, and merges nothing", async () => {
  await withDir(async (dir) => {
    const { ctx, merges } = mergeCtx(dir, { answers: ["hmm, let me look"] });
    const q = questionOf(await OPS["merge-pr"]!(ctx));
    assert.match(q, /is neither merge nor abandon/);
    assert.ok(q.includes('"hmm, let me look"'));
    assert.deepEqual(merges, []);
  });
});

test("D-merge-pr on the reply abandon returns abandon without merging, and comments once on the run's ticket naming the branch, the PR and the worktrees it leaves", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, "worktrees", "A-fixer"), { recursive: true });
    writeFileSync(join(dir, "worktrees", "A-fixer", ".git"), "gitdir: x\n");
    const { ctx, merges } = mergeCtx(dir, { answers: ["abandon"], inputs: { "ticket-id": { schema: "text", text: "DEV-9\n" } } });
    const r = await OPS["merge-pr"]!(ctx);
    assert.equal(r.status, "abandon");
    assert.match(r.status === "abandon" ? r.reason : "", /the operator abandoned the run at https:\/\/example\.test\/pull\/7/);
    assert.deepEqual(merges, []);
    const comments = readdirSync(join(dir, "t", "comments"));
    assert.equal(comments.length, 1);
    const c = JSON.parse(readFileSync(join(dir, "t", "comments", comments[0]!), "utf8")) as { ref: string; body: string };
    assert.equal(c.ref, "DEV-9");
    assert.match(c.body, /^Run run-9 abandoned by the operator\./);
    for (const left of ["branch work", "https://example.test/pull/7", ctx.place.worktree, join(dir, "worktrees", "A-fixer")]) assert.ok(c.body.includes(left), `names ${left}`);
    // The workflow may run the node again (a retry): the same abandon comments no second time.
    assert.equal((await OPS["merge-pr"]!(ctx)).status, "abandon");
    assert.equal(readdirSync(join(dir, "t", "comments")).length, 1, "idempotent");
  });
});

test("D-merge-pr abandons without a comment when the run has no ticket; a comment that fails is said in the reason and does not stop the abandon", async () => {
  await withDir(async (dir) => {
    const none = mergeCtx(dir, { answers: ["abandon"] });
    const r = await OPS["merge-pr"]!(none.ctx);
    assert.equal(r.status, "abandon");
    assert.equal(existsSync(join(dir, "t")), false, "no tracker call at all");
    const broken = mergeCtx(join(dir, "b"), {
      answers: ["abandon"],
      inputs: { "ticket-id": { schema: "text", text: "DEV-9" } },
      tracker: { ...fileTracker(join(dir, "b", "t")), comment: async () => { throw new Error("Linear is down"); } },
    });
    const b = await OPS["merge-pr"]!(broken.ctx);
    assert.equal(b.status, "abandon");
    assert.match(b.status === "abandon" ? b.reason : "", /the comment on DEV-9 failed: Linear is down/);
  });
});

test("D-merge-pr refuses to run without the PR it merges", async () => {
  await withDir(async (dir) => {
    const { ctx } = mergeCtx(dir, { inputs: { pr: files("x") } });
    await assert.rejects(OPS["merge-pr"]!(ctx), /no pr input/);
  });
});

// ---- K-measure-diff ----

const sizeReq = (dir: string, over: { diff?: string | null; notes?: Record<string, string>; buckets?: unknown } = {}) => {
  const inputs: DataValues = {
    "repo-config": files(
      put(join(dir, "in", "repo-config.json"), JSON.stringify({ tree: dir, stepsFile: "", steps: {}, notes: over.notes ?? {}, briefsDir: null, baseRef: "main", thresholds: { ...DEFAULTS, ...(over.buckets === undefined ? {} : { PR_SIZE_BUCKETS: over.buckets }) } }))
    ),
    ...(over.diff === null ? {} : { diff: files(put(join(dir, "in", "diff", "diff.patch"), over.diff ?? "")) }),
  };
  return checkReq(dir, dir, inputs, { role: "measure-diff", nodeId: "K-measure-diff" });
};

const patchOf = (path: string, added: number, removed = 0) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...Array.from({ length: removed }, () => "-old"), ...Array.from({ length: added }, () => "+new")].join("\n") + "\n";

test("K-measure-diff counts the diff's changed production lines, leaves tests and prose uncounted, and names the bucket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-size-"));
  const diff = patchOf("src/a.ts", 12, 3) + patchOf("src/__tests__/a.test.ts", 50) + patchOf("docs/x.md", 40);
  const r = await CHECKS["measure-diff"]!(sizeReq(dir, { diff }));
  assert.equal(r.answer, "pass");
  assert.equal(r.detail, "[S] 15 counted lines; repo readers: none");
  const report = jsonIn(r.outputs!["size-report"], "size.json");
  assert.deepEqual([report.counted, report.bucket], [15, "S"]);
  rmSync(dir, { recursive: true });
});

test("K-measure-diff puts the count in the bucket of the repo's own thresholds, at the boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-size-"));
  const buckets = [{ name: "small", min: 0 }, { name: "big", min: 5 }];
  const at = async (n: number) => (await CHECKS["measure-diff"]!(sizeReq(dir, { diff: patchOf("src/a.ts", n), buckets }))).detail;
  assert.match(await at(4), /^\[small\] 4 counted lines/);
  assert.match(await at(5), /^\[big\] 5 counted lines/);
  rmSync(dir, { recursive: true });
});

test("K-measure-diff lists the repo readers the notes name, one per bullet, the text after a name not part of it, ignoring other lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-size-"));
  const r = await CHECKS["measure-diff"]!(sizeReq(dir, { diff: patchOf("src/a.ts", 1), notes: { "repo readers": "The readers:\n- api-reader\n- ui_reader  \n* star-reader\n- comment-reader (size S and up)\n-no-space" } }));
  assert.match(r.detail, /repo readers: api-reader, ui_reader, comment-reader$/);
  assert.deepEqual(r.outputs!["repo-readers"], { schema: "items", items: [{ id: "api-reader", after: [] }, { id: "ui_reader", after: [] }, { id: "comment-reader", after: [] }] });
  rmSync(dir, { recursive: true });
});

test("K-measure-diff with no diff.patch among its input fails loudly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-size-"));
  await assert.rejects(CHECKS["measure-diff"]!(sizeReq(dir, { diff: null })), /holds no diff\.patch/);
  rmSync(dir, { recursive: true });
});

// ---- K-ship-gate ----

test("K-ship-gate accepts a reader a classifier skipped, with the classifier's answer as the skip reason; a failed node still fails it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-gate-"));
  const nodes: RunHistory["nodes"] = [
    { node: "C-silent-failures", iteration: 0, status: "done", answer: "no" },
    { node: "A-silent-failures", iteration: 0, status: "skipped", reason: "gate C-silent-failures answered no, not yes" },
    { node: "C-security", iteration: 0, status: "done", answer: "no" },
    { node: "A-security", iteration: 0, status: "skipped", reason: "gate C-security answered no, not yes" },
    { node: "K-ship-gate", iteration: 0, status: "running" },
  ];
  const record = (n: RunHistory["nodes"]) => ({ runId: "r", graph, phase: "running", nodes: n, loops: [], data: {} }) as unknown as RunHistory;
  const req = (n: RunHistory["nodes"]) => checkReq(dir, dir, { pr: ref("7") }, { role: "ship-gate", nodeId: "K-ship-gate", record: record(n) });
  assert.deepEqual(await CHECKS["ship-gate"]!(req(nodes)), { answer: "pass", detail: "PR 7: every node that ran finished, every skip has its reason" });
  const failed = await CHECKS["ship-gate"]!(req([...nodes, { node: "A-review", iteration: 0, status: "failed", reason: "x" }]));
  assert.deepEqual([failed.answer, failed.detail], ["fail", "failed: A-review#0"]);
});

test("K-ship-gate fails a skip with no recorded reason, naming the node, its iteration and its item", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-gate-"));
  const record = (n: RunHistory["nodes"]) => ({ runId: "r", graph, phase: "running", nodes: n, loops: [], data: {} }) as unknown as RunHistory;
  const req = (n: RunHistory["nodes"]) => checkReq(dir, dir, { pr: ref("7") }, { role: "ship-gate", nodeId: "K-ship-gate", record: record(n) });
  const skipped = (reason?: string): RunHistory["nodes"][number] => ({ node: "A-repo-review", iteration: 2, instance: "api", status: "skipped", ...(reason === undefined ? {} : { reason }) });
  for (const bare of [skipped(), skipped("  ")]) {
    const r = await CHECKS["ship-gate"]!(req([{ node: "A-silent-failures", iteration: 0, status: "skipped", reason: "gate C-silent-failures answered no, not yes" }, bare]));
    assert.deepEqual([r.answer, r.detail], ["fail", "skipped with no recorded reason: A-repo-review#2@api"]);
  }
  assert.equal((await CHECKS["ship-gate"]!(req([skipped("input diff missing")]))).answer, "pass");
  rmSync(dir, { recursive: true });
});

test("the shipped setups' size features read the size report K-measure-diff really writes: a change to its format fails here, not silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-size-features-"));
  const classifiers = join(dirname(fileURLToPath(import.meta.url)), "..", "classifiers");
  const setups = readdirSync(classifiers)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, features: ((JSON.parse(readFileSync(join(classifiers, f), "utf8")) as { features?: PatternFeature[] }).features ?? []).filter((x) => x.input === "size-report") }))
    .filter((s) => s.features.length > 0);
  assert.deepEqual(setups.map((s) => s.f).sort(), ["completeness.json", "simplifier.json"]);
  const counts = [5, 99, 100, 249, 250, 999, 1000, 4000];
  const reports = new Map<number, DataValues>();
  for (const n of counts) reports.set(n, { "size-report": (await CHECKS["measure-diff"]!(sizeReq(join(dir, String(n)), { diff: patchOf("src/a.ts", n) }))).outputs!["size-report"]! });
  const sum = (f: string, n: number) => featureSum(setups.find((s) => s.f === f)!.features, reports.get(n)!, f);
  assert.deepEqual(counts.map((n) => sum("simplifier.json", n)), [-0.2, -0.2, 0, 0, 0, 0, 0.2, 0.2], "under 100 counted lines -0.2, 1,000 or more +0.2");
  assert.deepEqual(counts.map((n) => sum("completeness.json", n)), [-0.3, -0.3, -0.3, -0.3, 0, 0, 0, 0], "under 250 counted lines -0.3");
  for (const { f, features } of setups) {
    for (const x of features) {
      const hits = counts.filter((n) => featureSum([x], reports.get(n)!, f) !== 0);
      assert.ok(hits.length > 0 && hits.length < counts.length, `${f}: ${x.pattern} matches some size reports and not others`);
    }
  }
  rmSync(dir, { recursive: true });
});

test("the readers the run's start check looks for are the readers K-measure-diff fans out, however the notes space their heading", async () => {
  for (const notes of ["## repo readers\n- api-reader\n", "##  Repo Readers  \n- ghost-reader (size M)\n- api-reader\n", "##\trepo readers\n- tab-reader\n\n## stack\n- not-a-reader\n"]) {
    const dir = mkdtempSync(join(tmpdir(), "graph-readers-"));
    const tree = repo(join(dir, "tree"));
    put(join(tree, ".claude", "build-steps.toml"), 'notes = "docs/notes.md"\n');
    put(join(tree, "docs", "notes.md"), notes);
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "notes");
    const setup = await CHECKS["load-config"]!(checkReq(dir, tree, { start: { schema: "text", text: "go" } }, { role: "load-config", nodeId: "K-load-config", outDir: join(dir, "setup") }));
    const size = await CHECKS["measure-diff"]!(checkReq(dir, tree, { "repo-config": setup.outputs!["repo-config"]!, diff: files(put(join(dir, "in", "diff", "diff.patch"), patchOf("src/a.ts", 1))) }, { role: "measure-diff", nodeId: "K-measure-diff" }));
    const fanned = size.outputs!["repo-readers"];
    const ids = fanned?.schema === "items" ? fanned.items.map((i) => i.id) : [];
    const checked = repoReadersMissing(tree, git(tree, "rev-parse", "HEAD")).map((m) => /^repo reader (\S+),/.exec(m)![1]);
    assert.ok(ids.length > 0, JSON.stringify(notes));
    assert.deepEqual(checked, ids, JSON.stringify(notes));
    rmSync(dir, { recursive: true });
  }
});
