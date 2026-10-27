/** The run's own worktree of the repo, and each agent's own worktree, so a retried agent's reset never touches a checkout anyone has open. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { gitOut as rawGitOut, gitTry as rawGitTry, type RunOpts } from "../runtime/lib/gitOps.ts";
import { childEnv } from "./adapters/process.ts";
import { SNAPSHOT_AUTHOR, SNAPSHOT_EMAIL, UNUSABLE_PUSH_URL } from "./constants.ts";
import type { MergeConflict } from "./contracts.ts";

/** git without the adapters' API keys in its environment. */
const gitOut = (args: string[], opts: RunOpts): string => rawGitOut(args, { ...opts, env: childEnv(process.env) });
const gitTry = (args: string[], opts: RunOpts): string | null => rawGitTry(args, { ...opts, env: childEnv(process.env) });

export const runBranch = (runId: string): string => `graph/${runId}`;

export function isGitRepo(dir: string): boolean {
  return gitTry(["rev-parse", "--git-dir"], { cwd: dir }) !== null;
}

export function headSha(dir: string): string {
  return gitOut(["rev-parse", "HEAD"], { cwd: dir }).trim();
}

/** Add `path` as a worktree of `repo` on `branch` at commit `sha` (the run's base, read once by the
 *  caller); returns that sha. A path that is already a worktree is kept, and its HEAD returned. */
export function addRunWorktree(repo: string, path: string, branch: string, sha: string): string {
  if (existsSync(join(path, ".git"))) return headSha(path);
  gitOut(["worktree", "add", "-q", "-B", branch, path, sha], { cwd: repo });
  return sha;
}

/** An agent's own worktree at `path`, detached at the run worktree's HEAD (made once; each run of a
 *  writing node first resets it to the run tree's HEAD of the moment, `resetWorktree`), with pushing
 *  blocked in it: every remote's push URL is one no transport handles, set for this worktree alone
 *  (`extensions.worktreeConfig` lets a linked worktree have its own config), so the run worktree, where
 *  the forge pushes, keeps the real URLs. */
export function addNodeWorktree(runWorktree: string, path: string): void {
  if (!existsSync(join(path, ".git"))) gitOut(["worktree", "add", "-q", "--detach", path, "HEAD"], { cwd: runWorktree });
  blockPush(path);
}

/** The agents' worktrees under a run dir (`worktrees/<node>[/<item>]`): each folder there holding a
 *  `.git`, in path order. An absent folder holds none; one that cannot be read is listed as it is
 *  (it is left on disk, holding what nobody could see) and handed to `unreadable`. */
export function agentWorktrees(runDir: string, unreadable: (dir: string, e: Error) => void = () => {}): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      found.push(dir);
      unreadable(dir, e as Error);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, ".git"))) found.push(p);
      else walk(p);
    }
  };
  walk(join(runDir, "worktrees"));
  return found.sort();
}

/** What a run leaves on disk: its run tree while it is there, then every agent worktree no cleanup
 *  removed (`agentWorktrees`). */
export function runLeftovers(runDir: string, runTree: string | undefined, unreadable?: (dir: string, e: Error) => void): string[] {
  return [...(runTree !== undefined && existsSync(runTree) ? [runTree] : []), ...agentWorktrees(runDir, unreadable)];
}

export function blockPush(worktree: string): void {
  gitOut(["config", "extensions.worktreeConfig", "true"], { cwd: worktree });
  for (const remote of gitOut(["remote"], { cwd: worktree }).split("\n").filter((r) => r !== "")) {
    gitOut(["config", "--worktree", `remote.${remote}.pushurl`, UNUSABLE_PUSH_URL], { cwd: worktree });
  }
}

/** Commit everything in the worktree as it stands, ignored files aside, and return that commit. */
export function snapshotWorktree(dir: string, message: string): string {
  gitOut(["add", "-A"], { cwd: dir });
  gitOut(["-c", `user.name=${SNAPSHOT_AUTHOR}`, "-c", `user.email=${SNAPSHOT_EMAIL}`, "commit", "-q", "--allow-empty", "--no-verify", "-m", message], { cwd: dir });
  return headSha(dir);
}

/** Put the worktree back at `sha`: tracked changes dropped, untracked files removed (ignored ones kept). */
export function resetWorktree(dir: string, sha: string): void {
  gitOut(["reset", "-q", "--hard", sha], { cwd: dir });
  gitOut(["clean", "-q", "-fd"], { cwd: dir });
}

const ident = ["-c", `user.name=${SNAPSHOT_AUTHOR}`, "-c", `user.email=${SNAPSHOT_EMAIL}`];

/** Commit whatever the worktree holds uncommitted (ignored files aside); false when it was clean. */
export function commitLeftovers(dir: string, message: string): boolean {
  if (gitOut(["status", "--porcelain"], { cwd: dir }).trim() === "") return false;
  gitOut(["add", "-A"], { cwd: dir });
  gitOut([...ident, "commit", "-q", "--no-verify", "-m", message], { cwd: dir });
  return true;
}

/** What a merge into the run tree did: the tree's HEAD after it, or the writer's commit and the paths
 *  git left conflicted (the merge aborted, the tree as it was). */
export type MergeOutcome = { head: string } | { conflict: MergeConflict };

/** Run git; null when it exits 0, else what it said on stderr (its error message when stderr is empty). */
function gitRefusal(args: string[], opts: RunOpts): string | null {
  try {
    gitOut(args, opts);
    return null;
  } catch (e) {
    const { stderr, message } = e as { stderr?: unknown; message?: string };
    const said = typeof stderr === "string" ? stderr.trim() : "";
    return said !== "" ? said : (message ?? String(e));
  }
}

/**
 * Merge commit `sha` (a writer's head, an object the run tree's repo already holds) into the run
 * tree at `dir`. A commit already in the tree changes nothing; a tree behind it fast-forwards;
 * otherwise a merge commit. A conflict aborts the merge and returns the commit and the conflicted paths,
 * the HEAD unchanged. A merge git refuses with no conflicted path (a dirty or untracked file in its
 * way) is no conflict: it throws a plain `Error` with git's words, as does an abort that fails.
 * Hold the run tree's lock (`withRunTree`) around it.
 */
export function mergeInto(dir: string, sha: string, message: string): MergeOutcome {
  if (gitTry(["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: dir }) !== null) return { head: headSha(dir) };
  if (gitTry(["merge-base", "--is-ancestor", "HEAD", sha], { cwd: dir }) !== null) {
    gitOut(["merge", "-q", "--ff-only", sha], { cwd: dir });
    return { head: headSha(dir) };
  }
  const refused = gitRefusal([...ident, "merge", "-q", "--no-ff", "--no-edit", "-m", message, sha], { cwd: dir });
  if (refused === null) return { head: headSha(dir) };
  const paths = unmergedPaths(dir);
  const started = gitTry(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir }) !== null;
  const abortRefused = started ? gitRefusal(["merge", "--abort"], { cwd: dir }) : null;
  if (abortRefused !== null) {
    throw new Error(`merging ${sha} into the run tree at ${dir} failed (${refused}), and \`git merge --abort\` failed there too, so the merge is still in progress in ${dir}: ${abortRefused}`);
  }
  if (paths.length === 0) throw new Error(`git refused to merge ${sha} into the run tree at ${dir}, with no conflicted path: ${refused}`);
  return { conflict: { commit: sha, paths } };
}

/** The paths git leaves unmerged in the worktree at `dir`: a merge, cherry-pick or rebase stopped on a conflict. */
export function unmergedPaths(dir: string): string[] {
  return (gitTry(["diff", "--name-only", "--diff-filter=U"], { cwd: dir }) ?? "").split("\n").filter((p) => p !== "");
}

/**
 * The commit a writer's fresh run hands its merge, after its commit `conflicted` did not merge: the
 * worktree's HEAD when it holds `conflicted`, or when it descends from `start` (the head the run began
 * at) and changes something beyond it; else `conflicted` again, so the merge conflicts as before (and
 * counts against the cap) instead of merging nothing in its place.
 */
export function restartCommit(dir: string, start: string, conflicted: string): string {
  const head = headSha(dir);
  if (gitTry(["merge-base", "--is-ancestor", conflicted, head], { cwd: dir }) !== null) return head;
  const onStart = gitTry(["merge-base", "--is-ancestor", start, head], { cwd: dir }) !== null;
  return onStart && gitOut(["diff", "--name-only", start, head], { cwd: dir }).trim() !== "" ? head : conflicted;
}

/** The files commit `sha` changed since it left the tree at `dir` (its merge base with HEAD), run in
 *  `dir`. A moved file counts at both paths: rename detection would hide the path it left. */
export function changedFiles(dir: string, sha: string): string[] {
  const base = gitOut(["merge-base", sha, "HEAD"], { cwd: dir }).trim();
  return gitOut(["diff", "--name-only", "--no-renames", `${base}..${sha}`], { cwd: dir }).split("\n").map((l) => l.trim()).filter(Boolean);
}

/** `mergeInto` with a writer merge's one subject: `build-graph: merge <label> (<sha9>)`. Hold the lock. */
export function mergeWriterCommit(dir: string, sha: string, label: string): MergeOutcome {
  return mergeInto(dir, sha, `build-graph: merge ${label} (${sha.slice(0, 9)})`);
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` holding the run tree's lock: the merges into the run tree, and the checks and operations
 * that run in it, take turns. The lock lives in this worker process, the one worker a run has.
 */
export async function withRunTree<T>(runTree: string, fn: () => Promise<T> | T): Promise<T> {
  const prior = locks.get(runTree) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prior.then(() => mine);
  locks.set(runTree, tail);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(runTree) === tail) locks.delete(runTree);
  }
}
