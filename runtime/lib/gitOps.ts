/**
 * The one shared shell-out helper for the tooling scripts' git/gh calls — replaces five
 * divergent sh()/git() wrappers that each hand-tuned cwd/encoding/stdio/maxBuffer (the source
 * of the ENOBUFS gap class and the localhost drift). Invariants live here once: cwd defaults to
 * the caller's cwd (the repo being built — this module lives outside it), encoding "utf8", stdio captures with stdin closed, maxBuffer 64 MiB (the 1 MiB
 * default truncates a large diff/log into an ENOBUFS throw that a `*Try`/`gitOk` probe would
 * misread as a legitimate empty/false answer), optional per-call timeout.
 *
 * Three result semantics, chosen by function: `*Out` throws on nonzero exit (caller owns the
 * failure); `*Try` returns null on ANY failure (absence is an answer); `gitOk` is a boolean
 * status probe; `*Inherit` streams stdio to ours (mutating gate subprocesses). Every function
 * takes an optional `exec` seam so self-tests drive failure paths without real subprocesses.
 */

import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

/** 64 MiB. Node's default 1 MiB truncates large diffs/logs and surfaces as a
 * confusing ENOBUFS (or worse, a silently short read) — one constant, one home. */
export const MAX_BUFFER = 64 * 1024 * 1024;

export interface RunOpts {
  /** Working directory; defaults to the process cwd — the repo under build, not this module's repo. */
  cwd?: string;
  /** Kill the subprocess after this many ms (execFileSync then throws). */
  timeout?: number;
  /** Test seam: replaces the real execFileSync-backed runner. */
  exec?: ExecFn;
  /** Stream stdio to ours instead of capturing (inherit-mode helpers set this). */
  inherit?: boolean;
  /** Written to the subprocess stdin — the only way to drive a plumbing command that takes a
   *  request list (`cat-file --batch`) instead of argv. */
  input?: string;
  /** Decode stdout as this instead of utf8. `latin1` makes one JS char one byte, which is what a
   *  caller framing binary-safe output by a byte length git reports needs. */
  encoding?: BufferEncoding;
}

/** The runner contract: return captured stdout, throw on nonzero exit. */
export type ExecFn = (cmd: string, args: string[], opts: RunOpts) => string;

/** Build the execFileSync options object. Extracted from defaultExec so a unit test can pin the
 * fixed invariants (process-cwd default, utf8, capture-vs-inherit stdio, 64 MiB maxBuffer, and
 * the timeout passthrough) directly — a regression that drops maxBuffer would otherwise ship green
 * (a real-subprocess test with small output never overflows 1 MiB, and `scripts/` is off the
 * branch-coverage floor). */
export function buildExecOptions(opts: RunOpts): ExecFileSyncOptionsWithStringEncoding {
  return {
    cwd: opts.cwd ?? process.cwd(),
    encoding: opts.encoding ?? "utf8",
    stdio: opts.inherit
      ? "inherit"
      : [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  };
}

const defaultExec: ExecFn = (cmd, args, opts) => {
  const out = execFileSync(cmd, args, buildExecOptions(opts));
  return typeof out === "string" ? out : "";
};

/** Run any command, return raw stdout; throws on nonzero exit. */
export function runOut(cmd: string, args: string[], opts: RunOpts = {}): string {
  return (opts.exec ?? defaultExec)(cmd, args, opts);
}

/** git, raw stdout; throws on nonzero exit. */
export function gitOut(args: string[], opts: RunOpts = {}): string {
  return runOut("git", args, opts);
}

/** gh, raw stdout; throws on nonzero exit. */
export function ghOut(args: string[], opts: RunOpts = {}): string {
  return runOut("gh", args, opts);
}

/** git as a probe: raw stdout, or null on ANY failure (nonzero, timeout, spawn error). */
export function gitTry(args: string[], opts: RunOpts = {}): string | null {
  try {
    return gitOut(args, opts);
  } catch {
    return null;
  }
}

/** gh as a probe: raw stdout, or null on ANY failure. */
export function ghTry(args: string[], opts: RunOpts = {}): string | null {
  try {
    return ghOut(args, opts);
  } catch {
    return null;
  }
}

/** git as a boolean status probe (`cat-file -e`, `diff --quiet`, `merge-base
 * --is-ancestor`): true on exit 0, false on any failure. */
export function gitOk(args: string[], opts: RunOpts = {}): boolean {
  return gitTry(args, opts) !== null;
}

/** Run any command with stdio streamed to ours (gate subprocesses whose output the
 * operator reads live); throws on nonzero exit. */
export function runInherit(cmd: string, args: string[], opts: RunOpts = {}): void {
  (opts.exec ?? defaultExec)(cmd, args, { ...opts, inherit: true });
}

/** git with stdio streamed to ours; throws on nonzero exit. */
export function gitInherit(args: string[], opts: RunOpts = {}): void {
  runInherit("git", args, opts);
}

/** Preflight for gates that diff `base...HEAD`: a shallow clone resolves the base ref but
 * has no connected history, so the diff dies with git's opaque "no merge base". Fail with the
 * actionable cause instead — call AFTER the caller's own base-resolves check and BEFORE the
 * first `...HEAD` diff. Carries a bad-ref backstop because `merge-base` fails identically for
 * a shallow clone and a typo'd --base; site-level guards keep their site-specific advice.
 * Merge-base-form (`...`) diffs only — a two-dot log needs no merge base. */
export function assertMergeBase(base: string, opts: RunOpts = {}): void {
  if (!gitOk(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], opts)) {
    throw new Error(
      `Diff base "${base}" does not resolve to a commit — refusing to diff against a bad base.`
    );
  }
  if (gitOk(["merge-base", base, "HEAD"], opts)) return;
  // Three-way on the probe RESULT, not a boolean collapse: a failed probe must not assert
  // "not shallow" — that branch's advice (don't bother fetching) is actively wrong if the
  // repo is shallow and only the probe glitched.
  const shallow = gitTry(["rev-parse", "--is-shallow-repository"], opts)?.trim();
  throw new Error(
    shallow === "true"
      ? `No merge base between "${base}" and HEAD: the repository is SHALLOW — run \`git fetch --unshallow origin\`, then retry.`
      : shallow === "false"
        ? `No merge base between "${base}" and HEAD — the repository is not shallow and "${base}" resolves locally, so the histories are genuinely disjoint (a rewritten or orphaned base, or the wrong base ref); fetching more history cannot create a common ancestor — verify the base ref.`
        : `No merge base between "${base}" and HEAD, and the shallow probe itself failed — try \`git fetch --unshallow origin\`, then verify the base ref.`
  );
}
