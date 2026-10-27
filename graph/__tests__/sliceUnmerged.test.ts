import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { briefText } from "../../runtime/__tests__/helpers/owedRun.ts";
import { EXIT_CHECKS } from "../../runtime/lib/fixFile.ts";
import { serialiseTableJson, type TableJson } from "../../runtime/lib/runFiles.ts";
import { DEFAULTS } from "../../runtime/thresholds.ts";
import type { OpContext } from "../adapters/types.ts";
import type { DataValues, FilesValue } from "../contracts.ts";
import { OPS } from "../pipelines/build/ops.ts";
import { CONFLICT_FILE, foreignSliceFiles, joinSliceFixes, PLAN_FILE, type SlicePlan } from "../pipelines/build/slices.ts";
import type { TableState } from "../pipelines/build/table.ts";
import { addNodeWorktree, addRunWorktree, commitLeftovers, headSha, resetWorktree } from "../worktree.ts";
import { opContext } from "./helpers/opContext.ts";

const PLAN: SlicePlan = {
  round: "1",
  slices: [
    { id: "S1", drafts: ["D1"], rows: ["R.1", "R.3"], files: ["a.ts"], peers: [] },
    { id: "S2", drafts: ["D2"], rows: ["R.2"], files: ["b.ts"], peers: [] },
  ],
};

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const files = (...paths: string[]): FilesValue => ({ schema: "files", files: paths });
const checks = (what: string) => `exit checks:\n${EXIT_CHECKS.map((key) => `${key}: ${what}`).join("\n")}\n`;

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "graph-slice-unmerged-"));
  const repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.ts"), "base\n");
  writeFileSync(join(repo, "b.ts"), "one\ntwo\nthree\n");
  git(["add", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], repo);
  const run = join(tmp, "run");
  addRunWorktree(repo, run, "graph/r", headSha(repo));
  const base = headSha(run);
  const writer = (name: string, change: (dir: string) => void) => {
    const dir = join(tmp, name);
    addNodeWorktree(run, dir);
    resetWorktree(dir, base);
    change(dir);
    commitLeftovers(dir, `${name} work`);
    return headSha(dir);
  };
  return { tmp, run, writer };
}

function repoConfig(dir: string, tree: string): FilesValue {
  return files(put(join(dir, "in", "repo-config.json"), JSON.stringify({ tree, stepsFile: "", steps: {}, notes: {}, briefsDir: null, baseRef: "main", thresholds: { ...DEFAULTS, SUBAGENT_MAX: 2 } })));
}

function sliceMergeContext(dir: string, tree: string, slice: string, commit: string, plan: SlicePlan | null = PLAN): OpContext {
  return opContext(dir, {
    nodeId: "D-merge-slice",
    role: "merge-slice",
    inputs: {
      "fix-commit": { schema: "ref", kind: "commit", id: commit },
      ...(plan === null ? {} : { "slice-plan": files(put(join(dir, "in", slice, PLAN_FILE), JSON.stringify(plan))) }),
    },
    outputs: ["slice-conflict"],
    outDir: join(dir, "out", slice),
    place: { worktree: tree, branch: "graph/r" },
    instance: slice,
  });
}

function mergeFixContext(dir: string, tree: string, roundHead: string, conflicts: FilesValue, plan: SlicePlan | null = PLAN): OpContext {
  const table: TableJson = { schema: 2, rounds: { "1": { head: roundHead, rows: [], leftovers: [], banked: [], closed: [], consumed: [], refused: [] } } };
  const state: TableState = { round: "1", rows: [{ id: "R.1", kind: "structure" }, { id: "R.2", kind: "behavior" }, { id: "R.3", kind: "structure" }], fixed: [], driftGroups: 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [] };
  const inputs: DataValues = {
    "slice-fix": files(
      put(join(dir, "in", "S1", "fix-1.txt"), `R.1 · fixed · abc1234 — one\nR.3 · dropped — three\n\n${checks("one")}`),
      put(join(dir, "in", "S2", "fix-1.txt"), `R.2 · fixed · abc1234 — two\n\n${checks("two")}`)
    ),
    "slice-conflict": conflicts,
    ...(plan === null ? {} : { "slice-plan": files(put(join(dir, "in", "plan", PLAN_FILE), JSON.stringify(plan))) }),
    table: files(put(join(dir, "in", "table", "table.json"), serialiseTableJson(table)), put(join(dir, "in", "table", "state.json"), JSON.stringify(state))),
    brief: files(put(join(dir, "in", "brief", "quick-x.md"), briefText())),
    "repo-config": repoConfig(dir, tree),
  };
  return opContext(dir, {
    nodeId: "D-merge-fix",
    role: "merge-fix",
    inputs,
    outputs: ["fix-file", "fix-diff", "owed-review-fix-call"],
    outDir: join(dir, "out", "round"),
    place: { worktree: tree, branch: "graph/r" },
  });
}

function conflictFile(result: Awaited<ReturnType<NonNullable<(typeof OPS)["merge-slice"]>>>): string {
  assert.equal(result.status, "done");
  if (result.status !== "done") throw new Error("merge-slice did not finish");
  const output = result.outputs["slice-conflict"];
  assert.equal(output?.schema, "files");
  if (output?.schema !== "files") throw new Error("merge-slice wrote no conflict file");
  const path = output.files.find((file) => file.endsWith(CONFLICT_FILE));
  if (path === undefined) throw new Error("merge-slice omitted slice-conflict.json");
  return path;
}

test("a slice keeps its own and unowned files when its commit lands", async () => {
  const { tmp, run, writer } = setup();
  const commit = writer("s1", (dir) => {
    writeFileSync(join(dir, "a.ts"), "owned\n");
    writeFileSync(join(dir, "notes.ts"), "unowned\n");
  });
  const result = await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S1", commit));
  const conflict = JSON.parse(readFileSync(conflictFile(result), "utf8"));
  assert.deepEqual(conflict, { slice: "S1", commit, unmerged: null });
  git(["merge-base", "--is-ancestor", commit, "HEAD"], run);
  assert.equal(readFileSync(join(run, "notes.ts"), "utf8"), "unowned\n");
  rmSync(tmp, { recursive: true, force: true });
});

test("a clean merge that crosses a peer lane is refused without moving or dirtying the run tree", async () => {
  const { tmp, run, writer } = setup();
  const s2 = writer("s2", (dir) => writeFileSync(join(dir, "b.ts"), "one\npeer\nthree\n"));
  const s1 = writer("s1", (dir) => writeFileSync(join(dir, "b.ts"), "one\ntwo\nmine\n"));
  await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S2", s2));
  const before = headSha(run);
  const result = await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S1", s1));
  const conflict = JSON.parse(readFileSync(conflictFile(result), "utf8"));
  assert.deepEqual(conflict, { slice: "S1", commit: s1, unmerged: { cause: "lane", owned: [{ slice: "S2", files: ["b.ts"] }] } });
  assert.equal(headSha(run), before);
  assert.equal(git(["status", "--porcelain"], run), "");
  rmSync(tmp, { recursive: true, force: true });
});

test("renaming a peer-owned file cannot evade the slice lane", async () => {
  const { tmp, run, writer } = setup();
  const commit = writer("s1", (dir) => git(["mv", "b.ts", "moved.ts"], dir));
  const result = await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S1", commit));
  const conflict = JSON.parse(readFileSync(conflictFile(result), "utf8"));
  assert.equal(conflict.unmerged.cause, "lane");
  assert.deepEqual(conflict.unmerged.owned, [{ slice: "S2", files: ["b.ts"] }]);
  assert.equal(git(["status", "--porcelain"], run), "");
  rmSync(tmp, { recursive: true, force: true });
});

test("merge-slice requires the plan that names every slice lane", async () => {
  const { tmp, run, writer } = setup();
  const commit = writer("s1", (dir) => writeFileSync(join(dir, "a.ts"), "owned\n"));
  await assert.rejects(OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S1", commit, null)), (error: unknown) => error instanceof Error && /slice-plan/.test(error.message) && /slices\.json/.test(error.message));
  rmSync(tmp, { recursive: true, force: true });
});

test("foreign slice files keep changed order inside each plan-ordered peer", () => {
  const plan: SlicePlan = {
    round: "1",
    slices: [
      { ...PLAN.slices[0]!, files: ["a.ts", "mine.ts"] },
      { ...PLAN.slices[1]!, files: ["b.ts"] },
      { id: "S3", drafts: ["D3"], rows: ["R.4"], files: ["c.ts"], peers: [] },
    ],
  };
  assert.deepEqual(foreignSliceFiles(plan, "S1", ["a.ts", "notes.ts", "mine.ts"]), []);
  assert.deepEqual(foreignSliceFiles(plan, "S1", ["notes.ts", "b.ts"]), [{ slice: "S2", files: ["b.ts"] }]);
  assert.deepEqual(foreignSliceFiles(plan, "S1", ["c.ts", "b.ts", "c.ts"]), [{ slice: "S2", files: ["b.ts"] }, { slice: "S3", files: ["c.ts", "c.ts"] }]);
  assert.throws(() => foreignSliceFiles(plan, "S9", ["b.ts"]), /S9/);
});

test("a lane-refused slice blocks only its fixed rows and keeps the fixer's other words", () => {
  const commit = "123456789abcdef0123456789abcdef01234567";
  const s1 = `R.1 · fixed · abc1234 — one\nR.3 · dropped — three\n\n${checks("one")}`;
  const s2 = `R.2 · fixed · abc1234 — two\n\n${checks("two")}`;
  const joined = joinSliceFixes(PLAN, [s1, s2], ["R.1", "R.2", "R.3"], [{ slice: "S1", commit, unmerged: { cause: "lane", owned: [{ slice: "S2", files: ["b.ts"] }] } }]);
  assert.equal(
    joined,
    [
      `R.1 · blocked — slice S1's commit ${commit} touches b.ts, which slice S2 owns, so it was not merged; its fix is not in the run tree`,
      "R.2 · fixed · abc1234 — two",
      "R.3 · dropped — three",
      "exit checks:",
      ...EXIT_CHECKS.map((key) => `${key}: S1 — none — slice S1's commit did not merge; S2 — two`),
      "",
    ].join("\n")
  );
});

test("D-merge-fix carries a lane refusal into the round file without merging that slice's commit", async () => {
  const { tmp, run, writer } = setup();
  const roundHead = headSha(run);
  const s2 = writer("s2", (dir) => writeFileSync(join(dir, "b.ts"), "one\npeer\nthree\n"));
  const s1 = writer("s1", (dir) => writeFileSync(join(dir, "b.ts"), "one\ntwo\nmine\n"));
  const s2Result = await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S2", s2));
  const s1Result = await OPS["merge-slice"]!(sliceMergeContext(tmp, run, "S1", s1));
  const head = headSha(run);
  const result = await OPS["merge-fix"]!(mergeFixContext(tmp, run, roundHead, files(conflictFile(s2Result), conflictFile(s1Result))));
  assert.equal(result.status, "done");
  if (result.status !== "done") throw new Error("merge-fix did not finish");
  assert.deepEqual(result.outputs["fix-head"], { schema: "ref", kind: "commit", id: head });
  assert.equal(
    readFileSync(join(tmp, "out", "round", "fix-file", "fix-1.txt"), "utf8"),
    [
      `R.1 · blocked — slice S1's commit ${s1} touches b.ts, which slice S2 owns, so it was not merged; its fix is not in the run tree`,
      "R.2 · fixed · abc1234 — two",
      "R.3 · dropped — three",
      "exit checks:",
      ...EXIT_CHECKS.map((key) => `${key}: S1 — none — slice S1's commit did not merge; S2 — two`),
      "",
    ].join("\n")
  );
  assert.throws(() => git(["merge-base", "--is-ancestor", s1, "HEAD"], run));
  rmSync(tmp, { recursive: true, force: true });
});

test("D-merge-fix with no slice plan fails naming the input it lacks", async () => {
  const { tmp, run } = setup();
  await assert.rejects(OPS["merge-fix"]!(mergeFixContext(tmp, run, headSha(run), files(), null)), (error: unknown) => error instanceof Error && /slice-plan/.test(error.message) && /slices\.json/.test(error.message));
  rmSync(tmp, { recursive: true, force: true });
});
