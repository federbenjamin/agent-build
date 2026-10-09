/** The fallbacks a repo with no build steps runs on: install and tests from its package files, a PR opened with
 *  SHIP's body, and a merge that reaches the base branch whether or not the repo allows auto-merge. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FALLBACKS, packageTestCommand, resolveSteps } from "../steps.ts";

const STEPS = join(import.meta.dirname, "..", "steps.ts");
const SHIP = join(import.meta.dirname, "..", "..", "skills", "build", "SHIP.md");

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "steps-fallbacks-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const commands = (dir: string) => Object.fromEntries(resolveSteps(dir).steps.map((s) => [s.step, [s.command, s.source]]));

test("tests and checks fall back to npm test when package.json has a real test script", () => {
  const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  const c = commands(dir);
  assert.deepEqual(c.tests, ["npm test", "fallback"]);
  assert.deepEqual(c.checks, ["npm test", "fallback"]);
  assert.deepEqual(c.exit_checks, [null, "fallback"], "only tests and checks take the package's script");

  const cli = spawnSync("node", [STEPS, dir], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /\(absent: every step uses its fallback\)/);
  assert.match(cli.stdout, /^tests\s+fallback\s+npm test$/m);
  assert.match(cli.stdout, /^checks\s+fallback\s+npm test$/m);
});

test("no package.json, no test script, npm init's placeholder, or unreadable JSON leaves tests and checks with none", () => {
  const cases: Record<string, string>[] = [
    {},
    { "package.json": JSON.stringify({ scripts: { build: "tsc" } }) },
    { "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) },
    { "package.json": JSON.stringify({ scripts: { test: "  " } }) },
    { "package.json": "{ not json" },
    { "package.json": "null" },
  ];
  for (const files of cases) {
    const dir = repo(files);
    assert.equal(packageTestCommand(dir), null, JSON.stringify(files));
    const c = commands(dir);
    assert.deepEqual([c.tests, c.checks], [[null, "fallback"], [null, "fallback"]], JSON.stringify(files));
  }
});

test("install falls back to the frozen install of the repo's lockfile, and to none without one", () => {
  const pkg = JSON.stringify({ scripts: { test: "vitest run" } });
  assert.deepEqual(commands(repo({ "package.json": pkg, "package-lock.json": "{}" })).install, ["npm ci", "fallback"]);
  assert.deepEqual(commands(repo({ "package.json": pkg, "pnpm-lock.yaml": "" })).install, ["pnpm install --frozen-lockfile", "fallback"]);
  assert.deepEqual(commands(repo({ "package.json": pkg })).install, [null, "fallback"]);
  assert.deepEqual(commands(repo({ "package.json": pkg, "package-lock.json": "{}", ".claude/build-steps.toml": 'install = "make deps"\n' })).install, ["make deps", "repo"]);
});

test("a repo's own tests and checks steps win over its package.json", () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    ".claude/build-steps.toml": 'tests = "pnpm -s test"\n',
  });
  const c = commands(dir);
  assert.deepEqual(c.tests, ["pnpm -s test", "repo"]);
  assert.deepEqual(c.checks, ["npm test", "fallback"]);
});

test("the pr_open fallback takes SHIP's title and body file, never a body filled from commits", () => {
  assert.doesNotMatch(FALLBACKS.pr_open!, /--fill/);
  assert.doesNotMatch(FALLBACKS.pr_open!, /--body|--title/, "SHIP appends the flags; the fallback names none of its own");
  const ship = readFileSync(SHIP, "utf8");
  assert.ok(
    ship.includes("on the `pr_open` fallback, `--title '<type>: <summary>' --body-file <inputs-dir>/pr-body.txt`"),
    "SHIP step 1 names the flags the fallback takes"
  );
  assert.ok(ship.includes("draft the PR body into `<inputs-dir>/pr-body.txt` while it runs"), "SHIP writes the body where the flag reads it");
});

/** Runs the merge fallback through `sh` with a fake `gh` that logs each call. `auto` is how the
 *  repo answers `--auto`: allowed, or refused as on a new repo; `ready` is the answer to `pr ready`. */
function runMerge(opts: { auto: "allowed" | "refused"; ready?: "ok" | "fails" }): { status: number | null; calls: string[] } {
  const root = mkdtempSync(join(tmpdir(), "merge-fallback-"));
  const bin = join(root, "bin");
  const log = join(root, "calls.txt");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      `if [ "$*" = "pr ready" ]; then [ '${opts.ready ?? "ok"}' = ok ]; exit $?; fi`,
      `case " $* " in *" --auto "*) [ '${opts.auto}' = allowed ]; exit $?;; esac`,
      `[ '${opts.ready ?? "ok"}' = ok ]`,
      "",
    ].join("\n")
  );
  chmodSync(join(bin, "gh"), 0o755);
  const run = spawnSync("/bin/sh", ["-c", FALLBACKS.merge!], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {}
  return { status: run.status, calls };
}

test("the merge fallback readies the draft, then turns on auto-merge where the repo allows it", () => {
  const r = runMerge({ auto: "allowed" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["pr ready", "pr merge --auto --squash"]);
});

test("the merge fallback merges at once where the repo does not allow auto-merge", () => {
  const r = runMerge({ auto: "refused" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ["pr ready", "pr merge --auto --squash", "pr merge --squash"]);
});

test("the merge fallback exits non-zero when the draft cannot be readied", () => {
  const r = runMerge({ auto: "allowed", ready: "fails" });
  assert.notEqual(r.status, 0);
  assert.equal(r.calls[0], "pr ready");
  assert.ok(!r.calls.includes("pr merge --auto --squash"), "no auto-merge is turned on for a PR still a draft");
});
