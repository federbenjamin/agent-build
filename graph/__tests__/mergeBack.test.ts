/**
 * Writer merge-back: a writer's commits reach the run tree through `mergeInto` (the `merge-back`
 * operation), under the run tree's lock.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { RunPlace } from "../contracts.ts";
import { runDataOp } from "../dataOps.ts";
import { fileForge, fileTracker } from "../adapters/fileFakes.ts";
import { OPS } from "../pipelines/build/ops.ts";
import { CONFLICT_FILE, PLAN_FILE, type SlicePlan } from "../pipelines/build/slices.ts";
import { addNodeWorktree, addRunWorktree, commitLeftovers, headSha, mergeInto, resetWorktree, withRunTree } from "../worktree.ts";
import { opContext } from "./helpers/opContext.ts";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** `mergeInto`'s head; throws on the conflict arm. */
function mergedHead(dir: string, sha: string, message: string): string {
  const out = mergeInto(dir, sha, message);
  if ("conflict" in out) throw new Error(`merging ${sha} conflicted on ${out.conflict.paths.join(", ")}`);
  return out.head;
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "graph-merge-"));
  const repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
  git(["add", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], repo);
  const run = join(tmp, "run");
  addRunWorktree(repo, run, "graph/r", headSha(repo));
  /** A writer's own tree, reset to the run tree's HEAD, with one commit changing `file`. */
  const writer = (name: string, file: string, text: string): string => {
    const dir = join(tmp, name);
    addNodeWorktree(run, dir);
    resetWorktree(dir, headSha(run));
    writeFileSync(join(dir, file), text);
    commitLeftovers(dir, `${name} work`);
    return headSha(dir);
  };
  return { tmp, repo, run, writer };
}

test("a writer's commit fast-forwards a run tree that has not moved", () => {
  const { tmp, run, writer } = setup();
  const sha = writer("w1", "b.txt", "new\n");
  assert.deepEqual(mergeInto(run, sha, "merge w1"), { head: sha });
  assert.equal(readFileSync(join(run, "b.txt"), "utf8"), "new\n");
  rmSync(tmp, { recursive: true, force: true });
});

test("two writers that started at one head both land: the second merges beside the first", () => {
  const { tmp, run, writer } = setup();
  const a = writer("w1", "b.txt", "one\n");
  const b = writer("w2", "c.txt", "two\n");
  mergeInto(run, a, "merge w1");
  const head = mergedHead(run, b, "merge w2");
  assert.equal(git(["rev-list", "--parents", "-n", "1", head], run).split(" ").length, 3, "a merge commit");
  assert.equal(readFileSync(join(run, "b.txt"), "utf8"), "one\n");
  assert.equal(readFileSync(join(run, "c.txt"), "utf8"), "two\n");
  rmSync(tmp, { recursive: true, force: true });
});

test("merging a commit the tree already holds changes nothing", () => {
  const { tmp, run, writer } = setup();
  const a = writer("w1", "b.txt", "one\n");
  const head = mergedHead(run, a, "merge");
  assert.deepEqual(mergeInto(run, a, "merge again"), { head });
  rmSync(tmp, { recursive: true, force: true });
});

test("a conflicting merge is aborted, names the path, and leaves the run tree as it was", () => {
  const { tmp, run, writer } = setup();
  const a = writer("w1", "a.txt", "mine\n");
  const b = writer("w2", "a.txt", "theirs\n");
  const head = mergedHead(run, a, "merge w1");
  assert.deepEqual(mergeInto(run, b, "merge w2"), { conflict: { commit: b, paths: ["a.txt"] } });
  assert.equal(headSha(run), head);
  assert.equal(git(["status", "--porcelain"], run), "");
  rmSync(tmp, { recursive: true, force: true });
});

test("a merge git refuses over a dirty or untracked file in the run tree is a plain error, not a conflict", () => {
  const { tmp, run, writer } = setup();
  const first = writer("w1", "b.txt", "one\n");
  const edits = writer("w2", "a.txt", "theirs\n");
  const adds = writer("w3", "new.txt", "theirs\n");
  const head = mergedHead(run, first, "merge w1");
  writeFileSync(join(run, "a.txt"), "dirty\n");
  writeFileSync(join(run, "new.txt"), "untracked\n");
  for (const sha of [edits, adds]) {
    assert.throws(
      () => mergeInto(run, sha, "merge"),
      (e: unknown) => e instanceof Error && e.message.includes(run) && /would be (overwritten|lost)/.test(e.message),
    );
    assert.equal(headSha(run), head);
  }
  assert.equal(git(["status", "--porcelain"], run), "M a.txt\n?? new.txt");
  rmSync(tmp, { recursive: true, force: true });
});

test("a writer's uncommitted work is committed so its ref holds it; a clean tree commits nothing", () => {
  const { tmp, run } = setup();
  const dir = join(tmp, "w");
  addNodeWorktree(run, dir);
  assert.equal(commitLeftovers(dir, "nothing"), false);
  writeFileSync(join(dir, "left.txt"), "x\n");
  assert.equal(commitLeftovers(dir, "left"), true);
  assert.equal(git(["status", "--porcelain"], dir), "");
  rmSync(tmp, { recursive: true, force: true });
});

test("the merge-back operation merges its commit input and writes the run tree's new head; a conflicting one comes back as data", async () => {
  const { tmp, run, writer } = setup();
  const sha = writer("w1", "b.txt", "new\n");
  const other = writer("w2", "b.txt", "clash\n");
  const place: RunPlace = { runDir: tmp, worktree: run, branch: "graph/r", baseSha: "" };
  const ctx = { runId: "r", nodeId: "merge", place, tracker: fileTracker(join(tmp, "t")), forge: fileForge(join(tmp, "f")), signal: new AbortController().signal };
  const out = await runDataOp("merge-back", { ...ctx, inputs: { c: { schema: "ref", kind: "commit", id: sha } } });
  assert.deepEqual(out, { schema: "ref", kind: "commit", id: headSha(run) });
  const merged = headSha(run);
  assert.deepEqual(await runDataOp("merge-back", { ...ctx, inputs: { c: { schema: "ref", kind: "commit", id: other } } }), { conflict: { commit: other, paths: ["b.txt"] } });
  assert.equal(headSha(run), merged);
  rmSync(tmp, { recursive: true, force: true });
});

function sliceMergeContext(tmp: string, run: string, slice: string, sha: string) {
  const plan: SlicePlan = {
    round: "1",
    slices: [
      { id: "S1", drafts: ["D1"], rows: ["R.1"], files: ["s1.txt"], peers: [] },
      { id: "S2", drafts: ["D2"], rows: ["R.2"], files: ["s2.txt"], peers: [] },
    ],
  };
  const planFile = join(tmp, "plan", PLAN_FILE);
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(planFile, JSON.stringify(plan));
  return opContext(tmp, {
    nodeId: "D-merge-slice",
    role: "merge-slice",
    inputs: { "fix-commit": { schema: "ref", kind: "commit", id: sha }, "slice-plan": { schema: "files", files: [planFile] } },
    outputs: ["slice-conflict"],
    outDir: join(tmp, "out", slice),
    place: { worktree: run, branch: "graph/r" },
    iteration: 1,
    instance: slice,
  });
}

test("merge-slice moves the run tree to a head holding the fixer's commit and records its slice, commit, and null unmerged", async () => {
  const { tmp, run, writer } = setup();
  const before = headSha(run);
  const sha = writer("w1", "b.txt", "new\n");
  const result = await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S1", sha));
  assert.equal(result.status, "done");
  if (result.status !== "done") throw new Error("merge-slice did not finish");
  assert.deepEqual(Object.keys(result.outputs), ["slice-conflict"]);
  assert.notEqual(headSha(run), before);
  git(["merge-base", "--is-ancestor", sha, "HEAD"], run);
  const conflict = result.outputs["slice-conflict"];
  assert.equal(conflict?.schema, "files");
  if (conflict?.schema !== "files") throw new Error("merge-slice wrote no conflict file");
  assert.deepEqual(JSON.parse(readFileSync(conflict.files.find((path) => path.endsWith(CONFLICT_FILE))!, "utf8")), { slice: "S1", commit: sha, unmerged: null });
  rmSync(tmp, { recursive: true, force: true });
});

test("merge-slice keeps the earlier head and records the conflicting paths when a later slice cannot merge", async () => {
  const { tmp, run, writer } = setup();
  const first = writer("w1", "a.txt", "one\n");
  const second = writer("w2", "a.txt", "two\n");
  const merged = await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S1", first));
  assert.equal(merged.status, "done");
  const firstHead = headSha(run);
  const conflicted = await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S2", second));
  assert.equal(conflicted.status, "done");
  if (conflicted.status !== "done") throw new Error("merge-slice did not finish");
  assert.deepEqual(Object.keys(conflicted.outputs), ["slice-conflict"]);
  const conflict = conflicted.outputs["slice-conflict"];
  assert.equal(conflict?.schema, "files");
  if (conflict?.schema !== "files") throw new Error("merge-slice wrote no conflict file");
  assert.deepEqual(JSON.parse(readFileSync(conflict.files.find((path) => path.endsWith(CONFLICT_FILE))!, "utf8")), { slice: "S2", commit: second, unmerged: { cause: "conflict", paths: ["a.txt"] } });
  assert.equal(headSha(run), firstHead);
  assert.equal(git(["status", "--porcelain"], run), "");
  rmSync(tmp, { recursive: true, force: true });
});

test("merge-slice fails, writing no conflict, when git refuses the merge over a dirty run tree", async () => {
  const { tmp, run, writer } = setup();
  const first = writer("w1", "b.txt", "one\n");
  const second = writer("w2", "a.txt", "two\n");
  assert.equal((await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S1", first))).status, "done");
  writeFileSync(join(run, "a.txt"), "dirty\n");
  await assert.rejects(OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S2", second)), (e: unknown) => e instanceof Error);
  rmSync(tmp, { recursive: true, force: true });
});

test("the run tree's lock runs its holders one at a time, in arrival order", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = withRunTree("/tree", async () => {
    order.push("first in");
    await gate;
    order.push("first out");
  });
  const second = withRunTree("/tree", () => void order.push("second"));
  const elsewhere = withRunTree("/other", () => void order.push("other tree"));
  await elsewhere;
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first in", "other tree", "first out", "second"]);
});
