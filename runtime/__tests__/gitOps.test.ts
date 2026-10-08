/**
 * Self-test for scripts/lib/gitOps.ts — the shared shell-out helper. Pins the
 * fixed invariants (repo-root cwd, 64 MiB maxBuffer, capture stdio with stdin
 * closed) and each result semantic (throw / null / boolean / inherit) via the
 * exec seam; one real-subprocess case proves the default runner end-to-end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertMergeBase,
  buildExecOptions,
  ghOut,
  ghTry,
  gitInherit,
  gitOk,
  gitOut,
  gitTry,
  MAX_BUFFER,
  runInherit,
  runOut,
  type RunOpts,
} from "../lib/gitOps.ts";

// Strip inherited GIT_* before anything spawns git (docs/rules/tests.md §Tests). This file's
// real-subprocess cases assert that the default runner resolves THIS repo from its REPO_ROOT cwd —
// under the lefthook pre-push hook an inherited GIT_DIR overrides that cwd, so the assertion would
// pass for the wrong reason.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

function recorder(result: string | Error) {
  const calls: { cmd: string; args: string[]; opts: RunOpts }[] = [];
  const exec = (cmd: string, args: string[], opts: RunOpts): string => {
    calls.push({ cmd, args, opts });
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, exec };
}

test("MAX_BUFFER is the 64 MiB convention", () => {
  assert.equal(MAX_BUFFER, 64 * 1024 * 1024);
});

test("gitOut/ghOut/runOut route the right binary and return raw stdout", () => {
  const { calls, exec } = recorder("  out  \n");
  assert.equal(gitOut(["status"], { exec }), "  out  \n");
  assert.equal(ghOut(["pr", "view"], { exec }), "  out  \n");
  assert.equal(runOut("pnpm", ["-v"], { exec }), "  out  \n");
  assert.deepEqual(
    calls.map((c) => [c.cmd, ...c.args]),
    [
      ["git", "status"],
      ["gh", "pr", "view"],
      ["pnpm", "-v"],
    ]
  );
});

test("throw semantics: *Out propagates the runner's failure", () => {
  const { exec } = recorder(new Error("exit 128"));
  assert.throws(() => gitOut(["fetch"], { exec }), /exit 128/);
  assert.throws(() => ghOut(["api"], { exec }), /exit 128/);
});

test("null semantics: *Try returns stdout on success, null on any failure", () => {
  const ok = recorder("hit\n");
  assert.equal(gitTry(["show", "x"], { exec: ok.exec }), "hit\n");
  assert.equal(ghTry(["pr", "view"], { exec: ok.exec }), "hit\n");
  const bad = recorder(new Error("boom"));
  assert.equal(gitTry(["show", "x"], { exec: bad.exec }), null);
  assert.equal(ghTry(["pr", "view"], { exec: bad.exec }), null);
});

test("boolean semantics: gitOk is exit-status-as-answer", () => {
  assert.equal(gitOk(["cat-file", "-e", "abc"], { exec: recorder("").exec }), true);
  assert.equal(gitOk(["diff", "--quiet"], { exec: recorder(new Error("differs")).exec }), false);
});

test("inherit semantics: runInherit/gitInherit set the inherit flag and rethrow", () => {
  const { calls, exec } = recorder("");
  gitInherit(["merge", "--no-edit"], { exec });
  runInherit("pnpm", ["test"], { exec });
  assert.deepEqual(
    calls.map((c) => [c.cmd, c.opts.inherit === true]),
    [
      ["git", true],
      ["pnpm", true],
    ]
  );
  assert.throws(() => gitInherit(["merge"], { exec: recorder(new Error("conflict")).exec }));
});

test("per-call cwd and timeout pass through the seam", () => {
  const { calls, exec } = recorder("");
  gitOut(["status"], { exec, cwd: "/elsewhere", timeout: 30_000 });
  assert.equal(calls[0]!.opts.cwd, "/elsewhere");
  assert.equal(calls[0]!.opts.timeout, 30_000);
});

// buildExecOptions owns the fixed invariants that defaultExec feeds to execFileSync. Pinning it
// directly catches a dropped maxBuffer / wrong cwd / wrong stdio that a real-subprocess test with
// small output would miss (and that no coverage floor guards — `scripts/` is excluded).
test("buildExecOptions: capture default pins the process cwd, utf8, capture stdio, 64 MiB maxBuffer", () => {
  const o = buildExecOptions({});
  assert.equal(o.cwd, process.cwd());
  assert.equal(o.encoding, "utf8");
  assert.deepEqual(o.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(o.maxBuffer, MAX_BUFFER);
  assert.equal(o.timeout, undefined);
});

test("buildExecOptions: inherit flag flips stdio to inherit (capture off)", () => {
  assert.equal(buildExecOptions({ inherit: true }).stdio, "inherit");
});

test("buildExecOptions: explicit cwd and timeout pass through; maxBuffer stays fixed", () => {
  const o = buildExecOptions({ cwd: "/elsewhere", timeout: 5000 });
  assert.equal(o.cwd, "/elsewhere");
  assert.equal(o.timeout, 5000);
  assert.equal(o.maxBuffer, MAX_BUFFER);
});

// Real-subprocess cases: the default runner end-to-end (repo-root cwd default — rev-parse resolves
// this repo regardless of the test process's own cwd).
test("default runner: real `git rev-parse --is-inside-work-tree` from REPO_ROOT", () => {
  assert.equal(gitOut(["rev-parse", "--is-inside-work-tree"]).trim(), "true");
  assert.equal(gitOk(["rev-parse", "--verify", "HEAD"]), true);
  assert.equal(gitTry(["cat-file", "-e", "0000000000000000000000000000000000000000"]), null);
});

// The inherit path can only be exercised for real: execFileSync with stdio "inherit" returns null,
// which defaultExec coerces to "" — a branch the mock-seam tests never reach.
test("default runner: real inherit-mode subprocess runs and returns void (null→'' coercion)", () => {
  // --is-ancestor HEAD HEAD succeeds with NO output — inherit mode writes at the fd level,
  // so a chatty probe (e.g. --version) would pollute the suite stream past any console mock.
  assert.doesNotThrow(() =>
    runInherit("git", ["merge-base", "--is-ancestor", "HEAD", "HEAD"], { timeout: 5000 })
  );
});

// assertMergeBase: dispatches on the leading args so the same seam drives the bad-ref
// preflight, the merge-base probe, and the shallow-repository probe with independently
// controllable outcomes. Each branch asserts the FULL arg array — a regression that swaps
// ref order or drops HEAD must fail here, not slide past a loose args[0] match.
function mergeBaseSeam(opts: {
  baseResolves?: boolean;
  mergeBaseOk: boolean;
  shallow: string | Error;
}) {
  const exec = (_cmd: string, args: string[]): string => {
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      assert.deepEqual(args, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]);
      if (opts.baseResolves === false) throw new Error("bad ref");
      return "";
    }
    if (args[0] === "merge-base") {
      assert.deepEqual(args, ["merge-base", "origin/main", "HEAD"]);
      if (!opts.mergeBaseOk) throw new Error("no merge base");
      return "";
    }
    if (args[0] === "rev-parse") {
      assert.deepEqual(args, ["rev-parse", "--is-shallow-repository"]);
      if (opts.shallow instanceof Error) throw opts.shallow;
      return opts.shallow;
    }
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return exec;
}

test("assertMergeBase: merge-base resolves — does not throw", () => {
  const exec = mergeBaseSeam({ mergeBaseOk: true, shallow: "false\n" });
  assert.doesNotThrow(() => assertMergeBase("origin/main", { exec }));
});

test("assertMergeBase: base does not resolve — bad-base message, never unshallow advice", () => {
  const exec = mergeBaseSeam({ baseResolves: false, mergeBaseOk: true, shallow: "false\n" });
  assert.throws(
    (): void => assertMergeBase("origin/main", { exec }),
    (err: unknown) =>
      err instanceof Error &&
      /does not resolve to a commit/.test(err.message) &&
      !/--unshallow/.test(err.message)
  );
});

test("assertMergeBase: no merge-base + shallow repo — actionable unshallow message", () => {
  const exec = mergeBaseSeam({ mergeBaseOk: false, shallow: "true\n" });
  assert.throws(() => assertMergeBase("origin/main", { exec }), /--unshallow/);
});

test("assertMergeBase: no merge-base + non-shallow repo — generic fetch-history message", () => {
  const exec = mergeBaseSeam({ mergeBaseOk: false, shallow: "false\n" });
  assert.throws(
    (): void => assertMergeBase("origin/main", { exec }),
    (err: unknown) =>
      err instanceof Error &&
      /histories are genuinely disjoint/.test(err.message) &&
      !/--unshallow/.test(err.message)
  );
});

test("assertMergeBase: no merge-base + shallow probe itself fails — says so, never asserts non-shallow", () => {
  const exec = mergeBaseSeam({ mergeBaseOk: false, shallow: new Error("rev-parse failed") });
  assert.throws(
    (): void => assertMergeBase("origin/main", { exec }),
    (err: unknown) =>
      err instanceof Error &&
      /shallow probe itself failed/.test(err.message) &&
      !/genuinely disjoint/.test(err.message)
  );
});
