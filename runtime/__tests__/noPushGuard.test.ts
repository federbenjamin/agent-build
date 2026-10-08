/** hooks/no-push-guard.sh: the PreToolUse:Bash hook that keeps a subagent from pushing or touching PRs. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOOK = join(ROOT, "hooks", "no-push-guard.sh");

const TMP = mkdtempSync(join(tmpdir(), "no-push-guard-"));
const LOG = join(TMP, "guard.log");

function makeRepo(name: string, withSteps: boolean): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (withSteps) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "build-steps.toml"), 'push = "pnpm push"\npr_open = "pnpm pr:open"\nmerge = "pnpm pr:merge"\n');
  }
  return dir;
}

const STEP_REPO = makeRepo("with-steps", true);
const BARE_REPO = makeRepo("no-steps", false);

function runRaw(input: string, log = LOG): { status: number | null; stderr: string } {
  const r = spawnSync("/bin/bash", [HOOK, ROOT], { input, encoding: "utf8", env: { ...process.env, NO_PUSH_GUARD_LOG: log } });
  return { status: r.status, stderr: r.stderr };
}

function run(cmd: string, opts: { agentId?: string | null; cwd?: string; log?: string } = {}): { status: number | null; stderr: string } {
  const agentId = opts.agentId === undefined ? "a1" : opts.agentId;
  const payload: Record<string, unknown> = {
    agent_type: "agent-build:builder",
    session_id: "s1",
    cwd: opts.cwd ?? BARE_REPO,
    tool_input: { command: cmd },
  };
  if (agentId !== null) payload.agent_id = agentId;
  return runRaw(JSON.stringify(payload), opts.log);
}

function expectBlocked(cmd: string, cwd?: string): void {
  const r = run(cmd, { cwd, log: join(TMP, "scratch.log") });
  assert.equal(r.status, 2, `expected block: ${cmd}`);
  assert.match(r.stderr, /no-push-guard/, cmd);
}

function expectPassed(cmd: string, cwd?: string): void {
  const r = run(cmd, { cwd, log: join(TMP, "scratch.log") });
  assert.equal(r.status, 0, `expected pass: ${cmd} (${r.stderr})`);
}

test.after(() => rmSync(TMP, { recursive: true, force: true }));

test("the main session (no agent_id) passes every command and writes no log", () => {
  assert.equal(run("git push", { agentId: null }).status, 0);
  assert.equal(run("pnpm pr:merge", { agentId: null, cwd: STEP_REPO }).status, 0);
  assert.equal(existsSync(LOG), false);
});

test("a subagent is blocked on every built-in push and PR-mutation form, however disguised", () => {
  for (const cmd of [
    "git push",
    "git push origin HEAD",
    "gh pr create --fill",
    "gh -R x/y pr merge",
    "gh api -X PATCH repos/x/y/pulls/1",
    "echo hi && git push",
    "$(git push)",
    "g''it push",
    "git${IFS}push",
    "env FOO=1 git push",
    'bash -c "git push"',
    "npx gh pr create",
    "sudo git push",
    "env -i git push",
    "nice -n 5 git push",
    "timeout 5 git push",
    "git\tpush",
    "gh api -XPOST repos/x/y/pulls",
    "gh api --method=POST repos/x/y/pulls",
  ]) {
    expectBlocked(cmd);
  }
});

test("a main-session call passes even when jq is absent; a subagent's is blocked for want of it", () => {
  const env = { ...process.env, PATH: "/usr/bin:/bin", NO_PUSH_GUARD_LOG: join(TMP, "scratch.log") };
  const payload = (agentId: string | null) => {
    const p: Record<string, unknown> = { session_id: "s1", cwd: BARE_REPO, tool_input: { command: "git push" } };
    if (agentId !== null) p.agent_id = agentId;
    return JSON.stringify(p);
  };
  // /usr/bin:/bin has no jq on a stock macOS; skip when it does.
  const hasJq = spawnSync("/bin/bash", ["-c", "command -v jq"], { env, encoding: "utf8" }).status === 0;
  if (hasJq) return;
  assert.equal(spawnSync("/bin/bash", [HOOK, ROOT], { input: payload(null), env, encoding: "utf8" }).status, 0);
  const sub = spawnSync("/bin/bash", [HOOK, ROOT], { input: payload("a1"), env, encoding: "utf8" });
  assert.equal(sub.status, 2);
  assert.match(sub.stderr, /jq is missing/);
});

test("read-only and look-alike git/gh commands pass", () => {
  for (const cmd of [
    "git stash push -u -m x",
    "git help push",
    "git commit -m x",
    'git commit -m "fix the push step"',
    "gh pr list",
    "gh pr view 1",
    "gh api repos/x/y",
    "grep -rn push scripts/",
    "echo push",
  ]) {
    expectPassed(cmd);
  }
});

test("the repo's own push, pr_open and merge steps are blocked when run through a script runner", () => {
  for (const cmd of ["pnpm push", "pnpm pr:open", "pnpm pr:merge", "pnpm run pr:merge", "npx pnpm pr:merge", "pnpm -s test && pnpm pr:merge"]) {
    expectBlocked(cmd, STEP_REPO);
  }
});

test("non-ship runner commands pass, and step matching fails open without step data", () => {
  expectPassed("pnpm -s test", STEP_REPO);
  expectPassed("pnpm install", STEP_REPO);
  // `cat` is not a runner, so the pr:merge token is only data here.
  expectPassed("cat package.json | grep pr:merge", STEP_REPO);
  // No build-steps.toml: the fallback steps are git/gh forms, never runner tokens.
  expectPassed("pnpm pr:merge", BARE_REPO);
  expectPassed("pnpm pr:merge", join(TMP, "does-not-exist"));
});

test("garbage stdin fails open", () => {
  assert.equal(runRaw("", join(TMP, "scratch.log")).status, 0);
  assert.equal(runRaw("not json", join(TMP, "scratch.log")).status, 0);
  assert.equal(runRaw(JSON.stringify({ agent_id: "a1" }), join(TMP, "scratch.log")).status, 0);
});

test("the log gets exactly one line per subagent firing: time, verdict, agent type, session", () => {
  const log = join(TMP, "fires.log");
  assert.equal(run("git push", { log }).status, 2);
  assert.equal(run("git status", { log }).status, 0);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "",/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z blocked agent-build:builder s1$/);
  assert.match(lines[1] ?? "",/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z passed agent-build:builder s1$/);
});
