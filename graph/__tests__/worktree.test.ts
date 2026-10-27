import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { UNUSABLE_PUSH_URL } from "../constants.ts";
import { addNodeWorktree, addRunWorktree, agentWorktrees, blockPush, runLeftovers } from "../worktree.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repo with a bare origin and two remotes, a run worktree of it, and an agent worktree of that. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graph-wt-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "-q", "--bare", origin);
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "f"), "x");
  git(repo, "add", "f");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "remote", "add", "backup", origin);
  const run = join(root, "run");
  addRunWorktree(repo, run, "graph/g-1", git(repo, "rev-parse", "HEAD"));
  const agent = join(root, "agent");
  addNodeWorktree(run, agent);
  return { root, origin, repo, run, agent, done: () => rmSync(root, { recursive: true }) };
}

test("in an agent's worktree every remote's push URL is unusable, so git push fails there", () => {
  const f = fixture();
  for (const remote of ["origin", "backup"]) assert.equal(git(f.agent, "remote", "get-url", "--push", remote), UNUSABLE_PUSH_URL);
  git(f.agent, "checkout", "-q", "-b", "agent-branch");
  for (const args of [["push", "origin", "agent-branch"], ["push", "-u", "backup", "HEAD"], ["push"]]) {
    assert.throws(() => git(f.agent, ...args), /build-graph-agents-cannot-push|remote helper|No configured push destination|fatal/, args.join(" "));
  }
  assert.throws(() => git(f.origin, "rev-parse", "--verify", "agent-branch"));
  f.done();
});

test("the run worktree and the repo keep the real URLs, so the forge still pushes the run branch", () => {
  const f = fixture();
  assert.equal(git(f.run, "remote", "get-url", "--push", "origin"), f.origin);
  assert.equal(git(f.repo, "remote", "get-url", "--push", "origin"), f.origin);
  git(f.run, "push", "-q", "-u", "origin", "graph/g-1");
  assert.ok(git(f.origin, "rev-parse", "--verify", "graph/g-1"));
  f.done();
});

test("blocking is repeatable, and a remote added later is blocked on the next call", () => {
  const f = fixture();
  addNodeWorktree(f.run, f.agent);
  git(f.repo, "remote", "add", "late", f.origin);
  assert.equal(git(f.agent, "remote", "get-url", "--push", "late"), f.origin, "not yet");
  blockPush(f.agent);
  assert.equal(git(f.agent, "remote", "get-url", "--push", "late"), UNUSABLE_PUSH_URL);
  f.done();
});

test("the run worktree is cut at the base its caller read, even when the repo moved on since", () => {
  const f = fixture();
  const base = git(f.repo, "rev-parse", "HEAD");
  writeFileSync(join(f.repo, "f"), "moved");
  git(f.repo, "commit", "-q", "-am", "a commit after the start check");
  const run = join(f.root, "run-2");
  assert.equal(addRunWorktree(f.repo, run, "graph/g-2", base), base);
  assert.equal(git(run, "rev-parse", "HEAD"), base);
  f.done();
});

test("what a run leaves: the run tree while it is there, then each agent worktree; an absent worktrees folder holds none, and a folder that cannot be read is listed and said", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-left-"));
  const runDir = join(root, "run");
  const tree = join(runDir, "worktree");
  mkdirSync(tree, { recursive: true });
  try {
    assert.deepEqual(agentWorktrees(runDir), [], "no worktrees folder: nothing left, nothing said");
    for (const node of ["A-fixer", join("A-builder", "P1")]) {
      mkdirSync(join(runDir, "worktrees", node), { recursive: true });
      writeFileSync(join(runDir, "worktrees", node, ".git"), "gitdir: x\n");
    }
    const locked = join(runDir, "worktrees", "A-tests");
    mkdirSync(join(locked, "P2"), { recursive: true });
    chmodSync(locked, 0o000);
    const said: string[] = [];
    const left = runLeftovers(runDir, tree, (dir, e) => said.push(`${dir}: ${(e as NodeJS.ErrnoException).code}`));
    assert.deepEqual(left, [tree, join(runDir, "worktrees", "A-builder", "P1"), join(runDir, "worktrees", "A-fixer"), locked]);
    assert.deepEqual(said, [`${locked}: EACCES`]);
    chmodSync(locked, 0o755);
    rmSync(tree, { recursive: true });
    assert.deepEqual(runLeftovers(runDir, tree), [join(runDir, "worktrees", "A-builder", "P1"), join(runDir, "worktrees", "A-fixer")], "a run tree that is gone is not listed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
