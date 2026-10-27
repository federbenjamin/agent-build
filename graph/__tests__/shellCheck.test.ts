import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { notesAtBase, stepAtBase } from "../adapters/baseSteps.ts";
import type { ProcessResult } from "../adapters/process.ts";
import { shellCheck } from "../adapters/shellCheck.ts";
import type { CheckRequest } from "../adapters/types.ts";
import { CHECK_DETAIL_CHARS, CHECK_STEPS } from "../constants.ts";
import { RunError } from "../contracts.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const tomlOf = (steps: Record<string, string>): string => Object.entries(steps).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n") + "\n";

/** A git repo whose first commit holds `.claude/build-steps.toml` with `steps`; `base` is that commit. */
function repoWith(steps: Record<string, string>, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graph-check-"));
  git(dir, "init", "-q");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "build-steps.toml"), tomlOf(steps));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD"), done: () => rmSync(dir, { recursive: true }) };
}

const rest = (worktree: string, baseSha: string) => ({ outputs: [], outDir: "/r/o", place: { runDir: "/r", worktree, branch: "b", baseSha }, formats: {}, nodeId: "n" });
const req = (r: { dir: string; base: string }, role: string, signal = new AbortController().signal): CheckRequest => ({ role, inputs: {}, worktree: r.dir, baseSha: r.base, iteration: 1, signal, ...rest(r.dir, r.base) });
const bare = (role: string): CheckRequest => ({ role, inputs: {}, worktree: "/w", baseSha: "0", iteration: 1, signal: new AbortController().signal, ...rest("/w", "0") });

test("a step that exits 0 passes, and its output is in the detail", async () => {
  const r = repoWith({ tests: "echo 12 passed" });
  const out = await shellCheck().run(req(r, "tests"));
  assert.equal(out.answer, "pass");
  assert.equal(out.detail, "tests: exit 0\n12 passed");
  r.done();
});

test("a step that exits non-zero fails with its exit code and both streams in order", async () => {
  const r = repoWith({ checks: "echo compiling; echo 'error: bad type' >&2; exit 2" });
  const out = await shellCheck().run(req(r, "checks"));
  assert.equal(out.answer, "fail");
  assert.match(out.detail, /^checks: exit 2\n/);
  assert.match(out.detail, /compiling[\s\S]*error: bad type/);
  r.done();
});

test("the step runs in the worktree, with the repo's own command line (a pipe works)", async () => {
  const r = repoWith({ tests: "pwd | tr a-z A-Z | cat" });
  const out = await shellCheck().run(req(r, "tests"));
  assert.equal(out.answer, "pass");
  assert.ok(out.detail.includes(realpathSync(r.dir).toUpperCase()), out.detail);
  r.done();
});

test("a long output keeps its end, under a marker, within the detail limit", async () => {
  const r = repoWith({ tests: "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; echo THE-END" });
  const out = await shellCheck().run(req(r, "tests"));
  assert.ok(out.detail.endsWith("THE-END"));
  assert.ok(out.detail.length < CHECK_DETAIL_CHARS + 40);
  assert.ok(!out.detail.includes("line-0\n"));
  r.done();
});

test("a verification step the repo does not map is a run error naming it", async () => {
  const r = repoWith({ tests: "true" });
  await assert.rejects(shellCheck().run(req(r, "mutation_proof")), (e: unknown) => e instanceof RunError && /mutation_proof/.test(e.message));
  r.done();
});

test("only verification steps run: push, pr_open, merge, install and an unknown name are refused before any command", async () => {
  let ran = 0;
  const run = async (): Promise<ProcessResult> => (ran++, { code: 0, stdout: "", stderr: "", output: "" });
  const check = shellCheck({ run, stepCommand: () => "gh pr merge 1" });
  for (const role of ["push", "pr_open", "merge", "install", "lint"]) {
    await assert.rejects(check.run(bare(role)), (e: unknown) => e instanceof RunError && /a shell check runs one of/.test(e.message), role);
  }
  assert.equal(ran, 0);
  assert.ok(["checks", "exit_checks", "fix_checks", "tests", "mutation_proof", "db_gate", "size"].every((s) => CHECK_STEPS.includes(s)));
  assert.ok(!CHECK_STEPS.some((s) => ["push", "pr_open", "merge", "install", "codex_role"].includes(s)));
});

test("the command is the one in the base commit, whatever the worktree's file says now", async () => {
  const r = repoWith({ tests: "exit 1" });
  writeFileSync(join(r.dir, ".claude", "build-steps.toml"), tomlOf({ tests: "true" }));
  assert.equal((await shellCheck().run(req(r, "tests"))).answer, "fail", "an uncommitted edit to the steps file");
  git(r.dir, "commit", "-q", "-am", "agent: make the tests green");
  assert.equal(readFileSync(join(r.dir, ".claude", "build-steps.toml"), "utf8"), tomlOf({ tests: "true" }));
  assert.equal((await shellCheck().run(req(r, "tests"))).answer, "fail", "a committed one");
  r.done();
});

test("a fallback that reads package.json (tests, checks) reads the base commit's too", () => {
  const r = repoWith({}, { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  writeFileSync(join(r.dir, "package.json"), JSON.stringify({ scripts: {} }));
  assert.equal(stepAtBase(r.dir, r.base, "tests"), "npm test");
  r.done();
});

test("the notes are read from the base commit, and a notes file missing there, or from the store, is a refusal", () => {
  const r = repoWith({ notes: "docs/notes.md" }, { "docs/notes.md": "## tracker\n- team: DEV\n" });
  writeFileSync(join(r.dir, "docs", "notes.md"), "## tracker\n- team: EVIL\n");
  assert.equal(notesAtBase(r.dir, r.base)?.text, "## tracker\n- team: DEV\n");
  const none = repoWith({ notes: "docs/gone.md" });
  assert.throws(() => notesAtBase(none.dir, none.base), (e: unknown) => e instanceof RunError && /the notes file docs\/gone\.md, which the repo's build steps name, is not in commit/.test(e.message));
  const store = repoWith({ notes: join(none.dir, "no-such-notes.md") });
  assert.throws(() => notesAtBase(store.dir, store.base), (e: unknown) => e instanceof RunError && /no-such-notes\.md, which the repo's build steps name, is not there/.test(e.message));
  store.done();
  const unmapped = repoWith({});
  assert.equal(notesAtBase(unmapped.dir, unmapped.base), null);
  for (const x of [r, none, unmapped]) x.done();
});

test("every git call made to resolve a step runs without the adapters' API keys", () => {
  const r = repoWith({ tests: "true" });
  const bin = mkdtempSync(join(tmpdir(), "graph-fakegit-"));
  const log = join(bin, "seen.log");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s|%s\\n' "$TYPESAFE_API_KEY" "$LINEAR_API_KEY" >> ${log}\nexec ${realGit} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const saved = { PATH: process.env.PATH, a: process.env.TYPESAFE_API_KEY, b: process.env.LINEAR_API_KEY };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.TYPESAFE_API_KEY = "secret-a";
  process.env.LINEAR_API_KEY = "secret-b";
  try {
    assert.equal(stepAtBase(r.dir, r.base, "tests"), "true");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(lines.length >= 2, "git ran for the profile probe and for the file reads");
    assert.ok(lines.every((l) => l === "|"), lines.join(" / "));
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.a === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved.a;
    if (saved.b === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = saved.b;
    rmSync(bin, { recursive: true });
    r.done();
  }
});

test("a cancel or time cap is the runner's rejection, passed through", async () => {
  const reason = new Error("time cap of 1000 ms reached");
  const run = async (): Promise<ProcessResult> => {
    throw reason;
  };
  const check = shellCheck({ run, stepCommand: () => "sleep 100" });
  await assert.rejects(check.run(bare("tests")), (e: unknown) => e === reason);
});

test("a step ended by a signal is a fail that says so", async () => {
  const run = async (): Promise<ProcessResult> => ({ code: null, stdout: "", stderr: "", output: "" });
  assert.deepEqual(await shellCheck({ run, stepCommand: () => "x" }).run(bare("tests")), { answer: "fail", detail: "tests: ended on a signal" });
});

test("the real runner kills a hung step when the signal aborts", async () => {
  const r = repoWith({ tests: "sleep 60" });
  const ctl = new AbortController();
  const running = shellCheck().run(req(r, "tests", ctl.signal));
  ctl.abort(new Error("cancelled"));
  await assert.rejects(running, /cancelled/);
  assert.ok(existsSync(r.dir));
  r.done();
});
