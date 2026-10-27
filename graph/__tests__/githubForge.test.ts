import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FALLBACKS, PR_STEP_ENV } from "../../runtime/steps.ts";
import { githubForge, prOpenCommand } from "../adapters/githubForge.ts";
import type { ProcessOptions, ProcessResult } from "../adapters/process.ts";
import { RunError } from "../contracts.ts";

const signal = new AbortController().signal;
const out = (stdout: string, code = 0, stderr = ""): ProcessResult => ({ code, stdout, stderr, output: stdout + stderr });

interface Call {
  cmd: string;
  args: string[];
  opts: ProcessOptions;
  /** The body file's text at call time (the file is gone after). */
  bodyFile?: string;
}

type Extra = Omit<NonNullable<Parameters<typeof githubForge>[1]>, "run">;

/** A runner that answers each call from `replies` (by order) and records it; the repo's steps are
 *  `runtime/steps.ts`'s fallbacks unless `extra.stepCommand` says otherwise. */
function fakeRun(replies: ProcessResult[], extra: Extra = {}) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> => {
    const f = opts.env?.[PR_STEP_ENV.bodyFile];
    calls.push({ cmd, args, opts, ...(f !== undefined ? { bodyFile: readFileSync(f, "utf8") } : {}) });
    const r = replies[calls.length - 1];
    if (r === undefined) throw new Error("no reply scripted");
    return r;
  };
  return { calls, forge: githubForge("base0", { run, stepCommand: (_w, _b, step) => FALLBACKS[step] ?? null, ...extra }) };
}

const script = (c: Call): string => (c.cmd === "sh" && c.args[0] === "-c" ? c.args[1]! : `${c.cmd} ${c.args.join(" ")}`);

test("push runs the repo's push step (its fallback here) in the worktree with the branch in its env, and returns the pushed commit", async () => {
  const { calls, forge } = fakeRun([out(""), out("abc123def\n")]);
  const ref = await forge.push({ worktree: "/w", branch: "graph/g-1", signal });
  assert.deepEqual(ref, { schema: "ref", kind: "commit", id: "abc123def" });
  assert.deepEqual(calls.map(script), ["git push -u origin HEAD", "git rev-parse HEAD"]);
  assert.equal(calls[0]!.opts.env?.[PR_STEP_ENV.branch], "graph/g-1");
  assert.ok(calls.every((c) => c.opts.cwd === "/w" && c.opts.signal === signal));
});

test("a failed push carries the end of its output and never reads a sha", async () => {
  const { calls, forge } = fakeRun([out("", 1, "remote: permission denied")]);
  await assert.rejects(forge.push({ worktree: "/w", branch: "b", signal }), /the push step `git push -u origin HEAD` exited 1\nremote: permission denied/);
  assert.equal(calls.length, 1);
});

test("the steps are read at the run's base commit, and a step the repo maps to nothing is a RunError", async () => {
  const asked: [string, string, string][] = [];
  const { calls, forge } = fakeRun([], { stepCommand: (w, b, s) => (asked.push([w, b, s]), null) });
  await assert.rejects(forge.push({ worktree: "/w", branch: "b", signal }), (e: unknown) => e instanceof RunError && /the repo maps no push step/.test(e.message));
  assert.deepEqual(asked, [["/w", "base0", "push"]]);
  assert.equal(calls.length, 0);
});

test("openPr on the fallback gives gh the title and body file from the env, and returns the PR number and url", async () => {
  const { calls, forge } = fakeRun([out("Creating pull request\nhttps://github.com/o/r/pull/58\n")]);
  const ref = await forge.openPr({ worktree: "/w", branch: "graph/g-1", title: "g-1: ship", body: "## report\n\nall green", signal });
  assert.deepEqual(ref, { schema: "ref", kind: "pr", id: "58", url: "https://github.com/o/r/pull/58" });
  const [call] = calls;
  assert.equal(script(call!), `gh pr create --title "$${PR_STEP_ENV.title}" --body-file "$${PR_STEP_ENV.bodyFile}"`, "not a draft: the fallback's --draft is dropped");
  assert.equal(call!.opts.env?.[PR_STEP_ENV.title], "g-1: ship");
  assert.equal(call!.opts.env?.[PR_STEP_ENV.branch], "graph/g-1");
  assert.equal(call!.bodyFile, "## report\n\nall green\n");
  assert.equal(call!.opts.cwd, "/w");
});

test("openPr on the fallback keeps --draft for a draft", async () => {
  const { calls, forge } = fakeRun([out("https://github.com/o/r/pull/59\n")]);
  await forge.openPr({ worktree: "/w", branch: "b", title: "t", body: "x", draft: true, signal });
  assert.match(script(calls[0]!), /^gh pr create --draft --title /);
});

test("a repo's own pr_open step runs as it is, reading the PR from its env; a step printing no URL has the PR read back", async () => {
  const { calls, forge } = fakeRun([out("opened\n"), out("https://github.com/o/r/pull/60\n")], { stepCommand: () => "node scripts/prOpen.ts" });
  const ref = await forge.openPr({ worktree: "/w", branch: "graph/g-2", title: "t", body: "x", draft: true, signal });
  assert.deepEqual(ref, { schema: "ref", kind: "pr", id: "60", url: "https://github.com/o/r/pull/60" });
  assert.deepEqual(calls.map(script), ["node scripts/prOpen.ts", "gh pr view graph/g-2 --json url --jq .url"]);
  assert.equal(calls[0]!.bodyFile, "x\n");
});

test("a step mapped to a blank command is a RunError naming the step and the steps file, for push, pr_open and merge, and nothing runs", async () => {
  for (const blank of ["", "   ", "\n"]) {
    const { calls, forge } = fakeRun([out(""), out("abc\n")], { stepCommand: () => blank });
    const refused = (step: string) => (e: unknown) => e instanceof RunError && new RegExp(`maps a blank ${step} step in its build steps file \\(\\.claude/build-steps\\.toml`).test(e.message);
    await assert.rejects(forge.push({ worktree: "/w", branch: "b", signal }), refused("push"));
    await assert.rejects(forge.openPr({ worktree: "/w", branch: "b", title: "t", body: "x", signal }), refused("pr_open"));
    await assert.rejects(forge.merge({ worktree: "/w", pr: "1", signal }), refused("merge"));
    assert.equal(calls.length, 0, JSON.stringify(blank));
  }
});

test("the brief's class reaches pr_open and merge as BUILD_PR_CLASS, and is unset when the brief has none, even if the worker's env holds one", async () => {
  const saved = process.env[PR_STEP_ENV.riskClass];
  process.env[PR_STEP_ENV.riskClass] = "R2";
  try {
    const { calls, forge } = fakeRun([out("https://github.com/o/r/pull/61\n"), out(""), out('{"state":"MERGED"}'), out("https://github.com/o/r/pull/62\n")]);
    await forge.openPr({ worktree: "/w", branch: "b", title: "t", body: "x", riskClass: "R1", signal });
    await forge.merge({ worktree: "/w", pr: "61", branch: "b", riskClass: "R1", signal });
    await forge.openPr({ worktree: "/w", branch: "b", title: "t", body: "x", signal });
    assert.deepEqual(calls.filter((c) => c.cmd === "sh").map((c) => c.opts.env?.[PR_STEP_ENV.riskClass]), ["R1", "R1", undefined]);
  } finally {
    if (saved === undefined) delete process.env[PR_STEP_ENV.riskClass];
    else process.env[PR_STEP_ENV.riskClass] = saved;
  }
});

test("prOpenCommand: the fallback gets the title and body flags and --draft only for a draft; any other command is left alone", () => {
  assert.equal(prOpenCommand(FALLBACKS.pr_open!, true), `gh pr create --draft --title "$BUILD_PR_TITLE" --body-file "$BUILD_PR_BODY_FILE"`);
  assert.equal(prOpenCommand(FALLBACKS.pr_open!, false), `gh pr create --title "$BUILD_PR_TITLE" --body-file "$BUILD_PR_BODY_FILE"`);
  assert.equal(prOpenCommand("pnpm pr:open --draft", false), "pnpm pr:open --draft");
});

test("the body file is removed after the call, success or failure", async () => {
  const ok = fakeRun([out("https://github.com/o/r/pull/1")]);
  await ok.forge.openPr({ worktree: "/w", branch: "b", title: "t", body: "x", signal });
  assert.equal(existsSync(ok.calls[0]!.opts.env![PR_STEP_ENV.bodyFile]!), false);
  const bad = fakeRun([out("", 1, "no commits between main and b")]);
  await assert.rejects(bad.forge.openPr({ worktree: "/w", branch: "b", title: "t", body: "x", signal }), /pr_open step .* exited 1\nno commits between/);
  assert.equal(existsSync(bad.calls[0]!.opts.env![PR_STEP_ENV.bodyFile]!), false);
});

test("a pr_open step and a gh pr view with no pull request URL is an error that shows what the step printed", async () => {
  const { forge } = fakeRun([out("done, somehow"), out("")]);
  await assert.rejects(forge.openPr({ worktree: "/w", branch: "b", title: "t", body: "x", signal }), /printed no pull request URL, and gh pr view b found none\ndone, somehow/);
});

test("merge runs the repo's merge step with the PR number and branch in its env, then reads the PR", async () => {
  const { calls, forge } = fakeRun([out(""), out('{"state":"MERGED"}')]);
  const ref = await forge.merge({ worktree: "/w", pr: "58", branch: "graph/g-1", signal });
  assert.deepEqual(ref, { schema: "ref", kind: "merge", id: "58" });
  assert.equal(script(calls[0]!), FALLBACKS.merge);
  assert.equal(calls[0]!.opts.env?.[PR_STEP_ENV.number], "58");
  assert.equal(calls[0]!.opts.env?.[PR_STEP_ENV.branch], "graph/g-1");
  assert.deepEqual([calls[1]!.cmd, ...calls[1]!.args], ["gh", "pr", "view", "58", "--json", "state"]);
  assert.equal(calls[0]!.opts.cwd, "/w");
});

test("merge refuses a PR id that is not a number", async () => {
  const { calls, forge } = fakeRun([]);
  for (const bad of ["--admin", "1 2", "", "abc"]) {
    await assert.rejects(forge.merge({ worktree: "/w", pr: bad, signal }), RunError, bad);
  }
  assert.equal(calls.length, 0);
});

test("a failed merge step names itself and its exit on the first line, and carries its complaint below", async () => {
  const { forge } = fakeRun([out("", 1, "Pull request is not mergeable")]);
  await assert.rejects(forge.merge({ worktree: "/w", pr: "5", signal }), /the merge step .* exited 1\nPull request is not mergeable/);
});

test("each operation runs its commands once: a rejection from the runner is not retried here", async () => {
  const reason = new Error("cancelled");
  let n = 0;
  const forge = githubForge("base0", {
    stepCommand: (_w, _b, step) => FALLBACKS[step] ?? null,
    run: async () => {
      n++;
      throw reason;
    },
  });
  await assert.rejects(forge.push({ worktree: "/w", branch: "b", signal }), (e: unknown) => e === reason);
  assert.equal(n, 1);
});

test("with real git and no steps file, push runs the fallback and publishes the run branch to the origin", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-forge-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", origin);
  git(root, "clone", "-q", origin, work);
  writeFileSync(join(work, "f"), "x");
  git(work, "add", "f");
  git(work, "commit", "-q", "-m", "init");
  git(work, "checkout", "-q", "-b", "graph/g-1");
  const ref = await githubForge(git(work, "rev-parse", "HEAD")).push({ worktree: work, branch: "graph/g-1", signal });
  assert.deepEqual(ref, { schema: "ref", kind: "commit", id: git(work, "rev-parse", "HEAD") });
  assert.equal(git(origin, "rev-parse", "graph/g-1"), ref.id);
  rmSync(root, { recursive: true });
});

test("a merge queue or auto-merge is waited for: the PR is read until it is MERGED, and the step runs once", async () => {
  const slept: number[] = [];
  const { calls, forge } = fakeRun([out("Pull request will be merged automatically"), out('{"state":"OPEN"}'), out('{"state":"OPEN"}'), out('{"state":"MERGED"}')], {
    sleep: async (ms) => void slept.push(ms),
  });
  const ref = await forge.merge({ worktree: "/w", pr: "9", signal });
  assert.deepEqual(ref, { schema: "ref", kind: "merge", id: "9" });
  assert.deepEqual(slept, [5000, 5000]);
  assert.equal(calls.filter((c) => c.cmd === "sh").length, 1, "never resubmitted");
  assert.equal(calls.length, 4);
});

test("a PR still queued when the wait runs out fails, and is not reported merged", async () => {
  let t = 0;
  const { forge } = fakeRun(Array.from({ length: 50 }, (_, i) => (i === 0 ? out("") : out('{"state":"OPEN"}'))), { sleep: async () => void (t += 5 * 60_000), now: () => t });
  await assert.rejects(forge.merge({ worktree: "/w", pr: "9", signal }), /PR 9 is OPEN, queued but not merged after 600 s/);
});

test("a PR closed without merging fails, and a state gh does not print is an error", async () => {
  await assert.rejects(fakeRun([out(""), out('{"state":"CLOSED"}')]).forge.merge({ worktree: "/w", pr: "9", signal }), /closed without being merged/);
  await assert.rejects(fakeRun([out(""), out("not json")]).forge.merge({ worktree: "/w", pr: "9", signal }), /printed no state/);
});

test("a cancel while waiting for the queue ends the wait with the signal's reason", async () => {
  const reason = new Error("cancelled");
  const { forge } = fakeRun([out(""), out('{"state":"OPEN"}')], { sleep: async () => { throw reason; } });
  await assert.rejects(forge.merge({ worktree: "/w", pr: "9", signal }), (e: unknown) => e === reason);
});
