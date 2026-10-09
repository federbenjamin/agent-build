import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACKS, codexOnPath, resolveSteps } from "../runtime/steps.ts";

// Strip inherited GIT_* before anything spawns git: an inherited GIT_DIR (a hook) would answer the
// profile and origin probes from another repo.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

function repo(toml) {
  const dir = mkdtempSync(join(tmpdir(), "build-steps-"));
  if (toml !== undefined) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/build-steps.toml"), toml);
  }
  return dir;
}

const byStep = (r) => Object.fromEntries(r.steps.map((s) => [s.step, s]));

test("a repo with no file gets every fallback and says it was absent", () => {
  const r = resolveSteps(repo());
  assert.equal(r.found, false);
  assert.deepEqual(
    r.steps.map((s) => [s.step, s.command, s.source]),
    Object.entries(FALLBACKS).map(([k, v]) => [k, k === "codex_role" && !codexOnPath() ? null : v, "fallback"])
  );
  assert.equal(byStep(r).push.command, "git push");
  assert.equal(byStep(r).db_gate.command, null);
});

test("mapped steps win, unmapped steps fall back, comments and blanks are skipped", () => {
  const r = resolveSteps(
    repo('# header\n\npush = "pnpm push"   # gated\nchecks = "a \\"quoted\\" && b"\n')
  );
  const s = byStep(r);
  assert.equal(r.found, true);
  assert.deepEqual(s.push, { step: "push", command: "pnpm push", source: "repo" });
  assert.equal(s.checks.command, 'a "quoted" && b');
  assert.deepEqual(s.merge, { step: "merge", command: FALLBACKS.merge, source: "fallback" });
});

test("an unknown step, a malformed line, or a step mapped twice is refused with its line", () => {
  assert.throws(() => resolveSteps(repo('pussh = "git push"\n')), /:1: unknown step "pussh"/);
  assert.throws(() => resolveSteps(repo("\npush = pnpm push\n")), /:2: expected step = "command"/);
  assert.throws(
    () => resolveSteps(repo('push = "a"\npush = "b"\n')),
    /:2: step "push" mapped twice/
  );
});

test("--get prints one step's command, (none) for a null step, and refuses an unknown step", () => {
  const cli = new URL("../runtime/steps.ts", import.meta.url).pathname;
  const dir = repo('push = "pnpm push"\n');
  const get = (step) => spawnSync("node", [cli, dir, "--get", step], { encoding: "utf8" });
  assert.equal(get("push").stdout, "pnpm push\n");
  assert.equal(get("notes").stdout, "(none)\n");
  assert.equal(get("pussh").status, 2);
});

test("a fallback script runs from the runtime folder that resolved it, never a fixed home path", () => {
  const here = new URL("../runtime/", import.meta.url).pathname.replace(/\/$/, "");
  for (const [step, script] of [["size", "size.ts"], ["codex_role", "codexRole.ts"]]) {
    assert.equal(FALLBACKS[step], `node ${here}/${script}`, `${step}'s fallback names this tree's ${script}`);
    assert.ok(existsSync(join(here, script)), `${join(here, script)} exists`);
  }
});

/** A git repo with origin `o/r` and `agents.profile` set to `profile` (unset when undefined), its
 *  tree holding `tree` as build steps when given; the store (AGENT_BUILD_STORE) holds `stored`. */
function profiled(profile, { tree, stored } = {}) {
  const dir = repo(tree);
  const git = (...args) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  if (profile !== undefined) git("config", "agents.profile", profile);
  const store = mkdtempSync(join(tmpdir(), "build-store-"));
  if (stored !== undefined) {
    mkdirSync(join(store, "o", "r"), { recursive: true });
    writeFileSync(join(store, "o", "r", "build-steps.toml"), stored);
  }
  return { dir, store, storeFile: join(store, "o", "r", "build-steps.toml"), treeFile: join(dir, ".claude/build-steps.toml") };
}

function withStore(store, fn) {
  const before = process.env.AGENT_BUILD_STORE;
  process.env.AGENT_BUILD_STORE = store;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.AGENT_BUILD_STORE;
    else process.env.AGENT_BUILD_STORE = before;
  }
}

test("a public repo reads its steps from the store, never its tree", () => {
  const p = profiled("public", { stored: 'push = "pnpm push"\n' });
  const r = withStore(p.store, () => resolveSteps(p.dir));
  assert.equal(r.file, p.storeFile);
  assert.equal(r.found, true);
  assert.deepEqual(byStep(r).push, { step: "push", command: "pnpm push", source: "repo" });
  const absent = profiled("public");
  mkdirSync(join(absent.store, "o", "r"), { recursive: true });
  const a = withStore(absent.store, () => resolveSteps(absent.dir));
  assert.equal(a.file, absent.storeFile, "with a store dir and no file in it, the store's path is still the one looked at");
  assert.equal(a.found, false);
});

test("a public repo with no store dir is an error, never a run on fallbacks", () => {
  const p = profiled("public");
  assert.throws(
    () => withStore(p.store, () => resolveSteps(p.dir)),
    (err) => err.message.includes(join(p.store, "o", "r")) && /^no store dir at /.test(err.message)
  );
});

test("a public repo with build steps in its tree is an error naming both files", () => {
  const p = profiled("public", { tree: 'push = "a"\n', stored: 'push = "b"\n' });
  assert.throws(
    () => withStore(p.store, () => resolveSteps(p.dir)),
    (err) => err.message.includes(p.treeFile) && err.message.includes(p.storeFile) && /a public repo keeps its build steps in the store/.test(err.message)
  );
});

test("a private repo, an unset profile, and a folder that is no git repo read the tree's file", () => {
  for (const profile of ["private", undefined]) {
    const p = profiled(profile, { tree: 'push = "tree push"\n', stored: 'push = "store push"\n' });
    const r = withStore(p.store, () => resolveSteps(p.dir));
    assert.equal(r.file, p.treeFile, `profile ${profile ?? "unset"}`);
    assert.equal(byStep(r).push.command, "tree push");
  }
  const plain = repo('push = "plain push"\n');
  const r = withStore(mkdtempSync(join(tmpdir(), "build-store-")), () => resolveSteps(plain));
  assert.equal(r.file, join(plain, ".claude/build-steps.toml"));
  assert.equal(byStep(r).push.command, "plain push");
});
