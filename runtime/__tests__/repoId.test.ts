/** repoId (`lib/repoId.ts`): the origin parser, the profile, the store's root and dir, the brief's
 *  location, and the CLI, over real throwaway repos. */
import "./helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { briefLocation, initStore, inStore, parseOrigin, repoId, repoProfile, storeDir, storeRoot } from "../lib/repoId.ts";

const SCRIPT = fileURLToPath(new URL("../lib/repoId.ts", import.meta.url));

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "repo-id-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}

function withStoreEnv<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.AGENT_BUILD_STORE;
  if (value === undefined) delete process.env.AGENT_BUILD_STORE;
  else process.env.AGENT_BUILD_STORE = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.AGENT_BUILD_STORE;
    else process.env.AGENT_BUILD_STORE = before;
  }
}

test("the four origin forms parse to owner and name; a local path, a file URL, and a deeper path do not", () => {
  const want = { owner: "o", name: "r" };
  for (const url of ["git@github.com:o/r.git", "https://github.com/o/r", "https://github.com/o/r.git", "ssh://git@github.com/o/r.git"]) {
    assert.deepEqual(parseOrigin(url), want, url);
  }
  assert.deepEqual(parseOrigin("ssh://git@github.com:22/o/r.git\n"), want, "a port and a trailing newline");
  for (const url of ["/srv/git/r.git", "../r", "file:///srv/o/r.git", "https://gitlab.com/g/sub/r.git", "https://github.com/o"]) {
    assert.equal(parseOrigin(url), null, url);
  }
});

test("repoId reads origin; no origin is null", () => {
  withDir((dir) => {
    git(dir, "init", "-q");
    assert.equal(repoId(dir), null, "no origin");
    git(dir, "remote", "add", "origin", "git@github.com:o/r.git");
    assert.deepEqual(repoId(dir), { owner: "o", name: "r" });
  });
  withDir((dir) => assert.equal(repoId(dir), null, "not a git repo"));
});

test("repoProfile: public, private, unset, a folder that is no git repo, and a misspelt value", () => {
  withDir((dir) => {
    assert.equal(repoProfile(dir), null, "not a git repo");
    git(dir, "init", "-q");
    assert.equal(repoProfile(dir), null, "unset");
    git(dir, "config", "agents.profile", "public");
    assert.equal(repoProfile(dir), "public");
    git(dir, "config", "agents.profile", "private");
    assert.equal(repoProfile(dir), "private");
    git(dir, "config", "agents.profile", "pubic");
    assert.throws(() => repoProfile(dir), /agents\.profile is "pubic" in .* — set it to public or private/);
  });
});

test("storeRoot is AGENT_BUILD_STORE when set, else ~/.local/state/agent-build/store; storeDir needs an origin", () => {
  const neutral = join(homedir(), ".local", "state", "agent-build", "store");
  assert.equal(withStoreEnv(undefined, storeRoot), neutral);
  assert.equal(withStoreEnv("", storeRoot), neutral, "an empty value is unset");
  withDir((dir) => {
    git(dir, "init", "-q");
    withStoreEnv("/elsewhere/store", () => {
      assert.equal(storeRoot(), "/elsewhere/store");
      assert.throws(() => storeDir(dir), /has no origin of the form <owner>\/<name>/);
      git(dir, "remote", "add", "origin", "https://github.com/o/r");
      assert.equal(storeDir(dir), "/elsewhere/store/o/r");
    });
  });
});

test("briefLocation: `store:` is a path under the store dir; anything else is the code repo's", () => {
  withDir((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
    const store = join(dir, "store");
    mkdirSync(join(store, "o", "r", "briefs"), { recursive: true });
    withStoreEnv(store, () => {
      assert.deepEqual(briefLocation("store:briefs/x.md", repo), { cwd: join(store, "o", "r"), path: "briefs/x.md", store: true });
      assert.deepEqual(briefLocation("docs/briefs/x.md", repo), { cwd: repo, path: "docs/briefs/x.md", store: false });
      assert.equal(inStore(join(store, "o", "r", "briefs", "x.md")), true);
      assert.equal(inStore(join(repo, "docs", "x.md")), false);
      assert.equal(inStore(`${store}-other/x.md`), false, "a sibling folder whose name starts with the store's is not in it");
    });
  });
});

test("initStore: a first run makes the store a git repo at its root; an existing store gains only the folder", () => {
  withDir((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
    const store = join(dir, "fresh", "store");
    withStoreEnv(store, () => {
      assert.equal(initStore(repo), join(store, "o", "r"));
      assert.equal(existsSync(join(store, "o", "r", "briefs")), true);
      assert.equal(git(join(store, "o", "r"), "rev-parse", "--show-toplevel").trim(), realpathSync(store));
      initStore(repo);
      assert.equal(git(store, "rev-list", "--all").trim(), "", "a second call commits nothing and inits nothing");
    });
    const cloned = join(dir, "cloned");
    mkdirSync(cloned);
    git(cloned, "init", "-q");
    const r = spawnSync("node", [SCRIPT, repo, "--init-store"], { encoding: "utf8", env: { ...process.env, AGENT_BUILD_STORE: cloned } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^store: ${cloned}/o/r$`, "m"));
    assert.equal(existsSync(join(cloned, "o", "r", "briefs")), true);
    assert.equal(existsSync(join(cloned, "o", "r", ".git")), false, "a store already in a git repo is not inited again");
  });
});

test("the CLI prints repo, profile, store, and run root", () => {
  withDir((dir) => {
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "git@github.com:o/r.git");
    git(dir, "config", "agents.profile", "public");
    const r = spawnSync("node", [SCRIPT, dir], { encoding: "utf8", env: { ...process.env, AGENT_BUILD_STORE: "/s", AGENT_BUILD_RUN_ROOT: "/runs" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "repo: o/r\nprofile: public\nstore: /s/o/r\nrun-root: /runs\n");
  });
  withDir((dir) => {
    const none = spawnSync("node", [SCRIPT, dir], { encoding: "utf8", env: { ...process.env, AGENT_BUILD_RUN_ROOT: "/runs" } });
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, "repo: none\nprofile: unset\nstore: none\nrun-root: /runs\n", "a folder that is no git repo");
  });
});

test("repoProfile and repoId hand a given env to every git call they make", () => {
  const seen: (NodeJS.ProcessEnv | undefined)[] = [];
  const exec = (_cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }): string => (seen.push(opts.env), args[0] === "remote" ? "https://github.com/o/r.git" : "private");
  const env = { ONLY: "this" };
  repoId("/r", { exec, env });
  repoProfile("/r", { exec, env });
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((e) => e === env));
});
