/** The base branch a run freshens against, as the upstream has it now. */

import { gitOut, gitTry } from "../../../runtime/lib/gitOps.ts";

export interface Base {
  /** The commit the base branch is at. */
  sha: string;
  /** The ref read: `<remote>/<branch>` after a fetch, or the local branch. */
  ref: string;
  /** How it was read, for the node's output. */
  note: string;
}

/**
 * Fetch the base branch from its upstream (the branch's configured remote, else `origin`) and return
 * the fetched commit. A repo with no such remote (a mock's stand-in) reads the local branch and says
 * so. A fetch that fails throws: comparing against a stale local branch would hide a move of main.
 */
export function resolveBase(tree: string, baseRef: string): Base {
  const remotes = gitOut(["remote"], { cwd: tree }).split("\n").map((r) => r.trim()).filter(Boolean);
  const configured = gitTry(["config", "--get", `branch.${baseRef}.remote`], { cwd: tree })?.trim();
  const remote = configured !== undefined && configured !== "" && remotes.includes(configured) ? configured : remotes.includes("origin") ? "origin" : null;
  if (remote === null) {
    const sha = gitOut(["rev-parse", `${baseRef}^{commit}`], { cwd: tree }).trim();
    return { sha, ref: baseRef, note: `no remote: read the local ${baseRef}` };
  }
  gitOut(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${baseRef}:refs/remotes/${remote}/${baseRef}`], { cwd: tree });
  const ref = `${remote}/${baseRef}`;
  return { sha: gitOut(["rev-parse", `${ref}^{commit}`], { cwd: tree }).trim(), ref, note: `fetched ${baseRef} from ${remote}` };
}
