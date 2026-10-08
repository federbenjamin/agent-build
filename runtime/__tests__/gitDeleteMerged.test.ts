// Tests for git-delete-merged.sh: the REAL script, run against throwaway repos in a tmpdir. GitHub is
// a fake `gh` first on PATH whose `pr list` prints FAKE_MERGED_HEADS, one commit per line.
//
// Asserted invariants:
//   - a branch whose tip main holds is deleted, and so is one whose tip a merged PR's head holds:
//     the PR's own branch, and a part branch merged into it;
//   - a branch with no merged PR, with a commit made after the PR's head, or checked out is kept,
//     and the script exits 1.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "git-delete-merged.sh");
const root = mkdtempSync(join(tmpdir(), "git-delete-merged-"));
after(() => rmSync(root, { recursive: true, force: true }));

const fakeBin = join(root, "bin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "gh"), '#!/bin/sh\n[ "$1 $2" = "pr list" ] && printf "%s\\n" "$FAKE_MERGED_HEADS"\nexit 0\n');
chmodSync(join(fakeBin, "gh"), 0o755);

function sh(cwd: string, command: string, args: string[], mergedHeads = "") {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) clean[k] = v;
  const env = {
    ...clean,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    FAKE_MERGED_HEADS: mergedHeads,
  };
  const r = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60_000 });
  if (r.status === null) throw new Error(`killed or timed out: ${command} ${args.join(" ")}\n${r.stderr}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(cwd: string, ...args: string[]): string {
  const r = sh(cwd, "git", args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let n = 0;
// A repo on main with one commit; a branch `feat/x` two commits ahead that main does not hold; and
// `part`, at the first of those two (a part branch merged into feat/x).
function makeRepo(): { dir: string; tip: string } {
  const dir = join(root, `repo-${++n}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  git(dir, "switch", "-q", "-c", "feat/x");
  git(dir, "commit", "-q", "--allow-empty", "-m", "part work");
  git(dir, "branch", "part");
  git(dir, "commit", "-q", "--allow-empty", "-m", "work");
  const tip = git(dir, "rev-parse", "HEAD");
  git(dir, "switch", "-q", "main");
  return { dir, tip };
}

const branches = (dir: string) => git(dir, "branch", "--format=%(refname:short)").split("\n");

test("deleted: a branch whose tip main holds, and the branches a merged PR's head holds", () => {
  const merged = makeRepo();
  git(merged.dir, "merge", "-q", "--ff-only", "feat/x");
  const a = sh(merged.dir, SCRIPT, ["feat/x"]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, "feat/x: deleted\n");
  assert.deepEqual(branches(merged.dir), ["main", "part"]);

  const squashed = makeRepo();
  const b = sh(root, SCRIPT, ["-C", squashed.dir, "part", "feat/x"], `0000000000000000000000000000000000000000\n${squashed.tip}`);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, "part: deleted\nfeat/x: deleted\n");
  assert.deepEqual(branches(squashed.dir), ["main"]);
});

test("kept, exit 1: no merged PR, a commit made after the PR's head, a name that is no branch, the checked-out branch", () => {
  const none = makeRepo();
  const a = sh(none.dir, SCRIPT, ["feat/x"]);
  assert.equal(a.status, 1);
  assert.match(a.stdout, /^feat\/x: kept — neither main nor a merged PR of the named branches holds its tip [0-9a-f]{7}\n/);
  assert.deepEqual(branches(none.dir), ["feat/x", "main", "part"]);

  const ahead = makeRepo();
  git(ahead.dir, "switch", "-q", "feat/x");
  git(ahead.dir, "commit", "-q", "--allow-empty", "-m", "never pushed");
  git(ahead.dir, "switch", "-q", "main");
  const b = sh(ahead.dir, SCRIPT, ["feat/x", "nope", "part"], ahead.tip);
  assert.equal(b.status, 1);
  assert.match(b.stdout, /feat\/x: kept/);
  assert.match(b.stdout, /nope: no such local branch/);
  assert.match(b.stdout, /part: deleted/);
  assert.deepEqual(branches(ahead.dir), ["feat/x", "main"]);

  const current = makeRepo();
  git(current.dir, "switch", "-q", "feat/x");
  const c = sh(current.dir, SCRIPT, ["feat/x"], current.tip);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /feat\/x/);
  assert.deepEqual(branches(current.dir), ["feat/x", "main", "part"]);
});
