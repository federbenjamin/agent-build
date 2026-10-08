/**
 * The runtime's caller of a repo's `signals` step arms `--app-code` and `--fix-security`, and
 * `prCode`, the PR's-code test built on the first. A repo answers with its own arm; a repo whose
 * step lacks the arm gets the fallback, and every result says which (`source`) and why (`note`).
 *
 * "No arm" is any of: the repo maps no `signals` step, the command exits 2 (an older step refuses
 * the unknown flag), or its stdout fits neither grammar:
 *   --app-code      `app-code: <path>` lines, or `none`
 *   --fix-security  `fires: <reason>` lines, or `quiet`
 * Fallbacks: app code is every changed path that is not tests, prose, or a lockfile (`isUncounted`),
 * with no comment detection. Fix security fires on any diff that changes a path; an empty diff
 * changes nothing and fires nothing.
 *
 * An arm that could not answer — a spawn error, a signal, a timeout, or any other non-zero exit —
 * still returns the fallback, but with `failure` set: its answer is unknown, not absent, and the
 * caller stops loudly (`armEnvFailure`).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isUncounted } from "../size.ts";
import { stepCommand } from "../steps.ts";
import { matchesTarget } from "./brief.ts";
import { type ExecFn, gitOut, MAX_BUFFER } from "./gitOps.ts";
import { logicChangedPaths } from "./logicPaths.ts";

export type ArmSource = "repo" | "fallback";
export type Arm = "--app-code" | "--fix-security";

/** A signals arm is a local diff read; one that runs this long is hung, and the fallback answers. */
const ARM_TIMEOUT_MS = 120_000;

export const FIX_SECURITY_FALLBACK_REASON = "fallback — no fix-security arm";

export interface ArmRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not run or was killed (spawn error, timeout). */
  error?: string;
}

export interface ArmDeps {
  /** The repo's `signals` command, or null when it maps none. Default: `stepCommand(repo, "signals")`. */
  signalsCommand?: (repo: string) => string | null;
  /** Runs `<command> <arm> <diff-file>` with cwd = repo. Default: `/bin/sh -c`. */
  runArm?: (command: string, arm: Arm, diffFile: string, repo: string) => ArmRun;
  /** git for `prCode`. Default: the real git. */
  git?: ExecFn;
}

export interface AppCodeResult {
  paths: string[];
  source: ArmSource;
  note: string;
  /** Why the repo's arm could not answer (it failed to run or crashed); null when its answer, or a
   *  fallback the repo owes, stands. */
  failure: string | null;
}

export interface FixSecurityResult {
  fires: boolean;
  reasons: string[];
  source: ArmSource;
  note: string;
  failure: string | null;
}

export interface PrCodeResult {
  /** The PR's code the range changed: app-code paths plus the target-file paths with a logic change
   *  (`prCode`), sorted. Empty means none. */
  paths: string[];
  /** The branch-own, non-merge commits read (`rev-list --no-merges <from>..<to> --not <base>`). */
  commits: string[];
  appCode: string[];
  targets: string[];
  source: ArmSource;
  note: string;
  failure: string | null;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function defaultRunArm(command: string, arm: Arm, diffFile: string, repo: string): ArmRun {
  const r = spawnSync("/bin/sh", ["-c", `${command} ${arm} ${shellQuote(diffFile)}`], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER,
    timeout: ARM_TIMEOUT_MS,
  });
  const error =
    r.error !== undefined
      ? r.error.message
      : r.signal !== null
        ? `killed by ${r.signal}`
        : undefined;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(error ? { error } : {}) };
}

type Grammar = { line: RegExp; label: string; empty: string };
const GRAMMAR: Record<Arm, Grammar> = {
  "--app-code": { line: /^app-code: (\S.*)$/, label: "app-code: <path>", empty: "none" },
  "--fix-security": { line: /^fires: (\S.*)$/, label: "fires: <reason>", empty: "quiet" },
};

/** The arm's items when stdout fits its grammar (`[]` for the empty word), else null. */
export function parseArmOutput(arm: Arm, stdout: string): string[] | null {
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, "").trimEnd()).filter((l) => l !== "");
  const g = GRAMMAR[arm];
  if (lines.length === 1 && lines[0] === g.empty) return [];
  if (lines.length === 0) return null;
  const items: string[] = [];
  for (const l of lines) {
    const m = g.line.exec(l);
    if (!m) return null;
    items.push(m[1]!);
  }
  return items;
}

/** The stderr line that says why: the first that opens with an error name (`Error: …`,
 *  `TypeError …`), else the first; package-manager warnings (`npm warn …`, printed by `npx` before
 *  the command runs) never. */
export function whyLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^npm warn\b/i.test(l));
  const line = lines.find((l) => /^[A-Za-z]*Error\b/.test(l)) ?? lines[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** An old step's refusal of the unknown flag: the one non-zero exit that means "no arm". */
const NO_ARM_EXIT = 2;

/** Ask the repo's arm. `{ items }` when it answered, else `{ why, failed }` for the fallback's note;
 *  `failed` when the arm could not answer rather than having none. */
function askArm(
  repo: string,
  arm: Arm,
  diff: string,
  deps: ArmDeps
): { items: string[]; note: string } | { why: string; failed: boolean } {
  const command = (deps.signalsCommand ?? ((r) => stepCommand(r, "signals")))(repo);
  if (command === null) return { why: "the repo maps no signals step", failed: false };
  const dir = mkdtempSync(join(tmpdir(), "signals-arm-"));
  try {
    const file = join(dir, "range.diff");
    writeFileSync(file, diff);
    const r = (deps.runArm ?? defaultRunArm)(command, arm, file, repo);
    const call = `\`${command} ${arm}\``;
    if (r.error !== undefined) return { why: `${call} did not run: ${r.error}`, failed: true };
    if (r.status !== 0) {
      const err = whyLine(r.stderr);
      return { why: `${call} exited ${r.status}${err ? `: ${err}` : ""}`, failed: r.status !== NO_ARM_EXIT };
    }
    const items = parseArmOutput(arm, r.stdout);
    if (items === null) {
      const g = GRAMMAR[arm];
      return { why: `${call} printed neither \`${g.label}\` lines nor \`${g.empty}\``, failed: false };
    }
    return { items, note: `repo arm ${call} exited 0` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The one line a caller prints, and stops on, when an arm could not answer — a spawn error, a signal
 * or timeout, or any non-zero exit but 2 (the sandbox refusing the local socket `npx tsx` opens, or
 * the arm crashing) — so its answer is unknown, not absent. Null for a repo arm's answer and for a
 * fallback the repo really owes: no signals step, an older step's exit 2 on the unknown flag, output
 * in neither grammar.
 */
export function armEnvFailure(r: { failure: string | null }): string | null {
  return r.failure === null ? null : `the signals arm could not run here (${r.failure}) — re-run outside the sandbox`;
}

/** Every path a unified diff touches: the post-image path, or the pre-image one for a deletion. */
export function diffChangedPaths(diff: string): string[] {
  const out = new Set<string>();
  let header: string | null = null;
  let minus: string | null = null;
  let plus: string | null = null;
  const flush = () => {
    const p = plus ?? minus ?? header;
    if (p !== null) out.add(p);
    header = minus = plus = null;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      header = / b\/(.+)$/.exec(line)?.[1] ?? null;
    } else if (header !== null && line.startsWith("--- ")) {
      minus = line === "--- /dev/null" ? null : (/^--- a\/(.+)$/.exec(line)?.[1] ?? null);
    } else if (header !== null && line.startsWith("+++ ")) {
      plus = line === "+++ /dev/null" ? null : (/^\+\+\+ b\/(.+)$/.exec(line)?.[1] ?? null);
    } else if (header !== null && line.startsWith("rename to ")) {
      plus = line.slice("rename to ".length);
    }
  }
  flush();
  return [...out];
}

/** The app-code paths a diff changes logic in: the repo's `--app-code` arm, or the fallback. */
export function appCodePaths(repo: string, diff: string, deps: ArmDeps = {}): AppCodeResult {
  const r = askArm(repo, "--app-code", diff, deps);
  if ("items" in r) return { paths: [...new Set(r.items)].sort(), source: "repo", note: r.note, failure: null };
  return {
    paths: diffChangedPaths(diff).filter((p) => !isUncounted(p)).sort(),
    source: "fallback",
    note: `fallback — ${r.why}; every changed path outside tests, prose, and lockfiles, no comment detection`,
    failure: r.failed ? r.why : null,
  };
}

/** Does a fix diff owe the R2 security read? The repo's `--fix-security` arm, or the fallback. */
export function fixSecurity(repo: string, diff: string, deps: ArmDeps = {}): FixSecurityResult {
  const r = askArm(repo, "--fix-security", diff, deps);
  if ("items" in r) return { fires: r.items.length > 0, reasons: r.items, source: "repo", note: r.note, failure: null };
  const changed = diffChangedPaths(diff).length > 0;
  return {
    fires: changed,
    reasons: changed ? [FIX_SECURITY_FALLBACK_REASON] : [],
    source: "fallback",
    note: `fallback — ${r.why}; ${changed ? "any changed path fires" : "an empty diff fires nothing"}`,
    failure: r.failed ? r.why : null,
  };
}

/**
 * The PR's code a range changed. Only branch-own commits count — `rev-list --no-merges
 * <from>..<to> --not <base>`, so a merge and a main commit merged in never do. Each is diffed against
 * its parent without rename detection (a move changes both paths); the joined diff goes to the
 * `--app-code` arm, where a comment-only change does not count. A path matching a target entry
 * counts on a logic change (`logicChangedPaths`, over each commit diffed with exact renames): a
 * comment-only or blank-line change does not count, nor does an identical rename (either of its
 * paths); any other change does, a changed path string included. `targets: "all"` (a
 * `--from-branch` run) makes every path a target. `brief` — the brief, or a `--from-branch` run's
 * hand-test file — is never the PR's code, whatever a target entry or the arm says: an `amend
 * brief:` commit fixes the spec, not the code the hand test ran.
 */
export function prCode(
  repo: string,
  from: string,
  to: string,
  base: string,
  targets: readonly string[] | "all",
  brief: string | null,
  deps: ArmDeps = {}
): PrCodeResult {
  const git = (args: string[]) => gitOut(args, { cwd: repo, ...(deps.git ? { exec: deps.git } : {}) });
  const commits = git(["rev-list", "--no-merges", `${from}..${to}`, "--not", base])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const diffArgs = ["diff-tree", "-r", "--root", "--no-commit-id", "--no-ext-diff", "--no-textconv", "-p", "--no-color"];
  const readTargets = targets === "all" || targets.length > 0;
  const logic = new Set<string>();
  const patches: string[] = [];
  for (const c of commits) {
    patches.push(git([...diffArgs, "--no-renames", c]));
    if (readTargets) for (const p of logicChangedPaths(git([...diffArgs, "-M100%", c]))) logic.add(p);
  }
  const app = appCodePaths(repo, patches.join(""), deps);
  const code = (p: string) => p !== brief;
  const appCode = app.paths.filter(code);
  const targetHits = [...logic].filter((p) => code(p) && (targets === "all" || matchesTarget(p, targets))).sort();
  return {
    paths: [...new Set([...appCode, ...targetHits])].sort(),
    commits,
    appCode,
    targets: targetHits,
    source: app.source,
    note: app.note,
    failure: app.failure,
  };
}
