/**
 * Where the run's brief is, and what it says at a commit: committed in the repo's briefs dir, or kept
 * in the run's store (the brief output's file, which an amend replaces with the amended one).
 */

import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import { gitTry } from "../../../runtime/lib/gitOps.ts";
import { gradedContent } from "../../../runtime/lib/brief.ts";
import type { DataValues } from "../../contracts.ts";
import { filesOf, readText, repoConfigOf } from "./common.ts";

/** The brief input's `.md` file. */
export function briefFile(inputs: DataValues): string {
  const f = filesOf(inputs.brief).find((x) => x.endsWith(".md"));
  if (f === undefined) throw new Error("the brief output holds no .md file");
  return f;
}

/** The brief's path in the run tree (the repo's briefs dir), or null when the run's store keeps it. */
export function briefPathInTree(inputs: DataValues): string | null {
  const cfg = repoConfigOf(inputs);
  return cfg.briefsDir === null ? null : join(cfg.briefsDir, basename(briefFile(inputs)));
}

/** The brief's text at commit `sha` of `tree`: the committed file, or for a store brief the input's
 *  file (a store brief is not in the tree; the input is the current version). */
export function briefTextAt(inputs: DataValues, tree: string, sha: string): string | null {
  const inTree = briefPathInTree(inputs);
  return inTree === null ? readText(briefFile(inputs)) : gitTry(["show", `${sha}:${inTree}`], { cwd: tree });
}

/** A brief version's fingerprint: its whole text and its graded content (`gradedContent`), hashed. */
export interface BriefMark {
  raw: string;
  graded: string;
}

const hash = (t: string): string => createHash("sha256").update(t).digest("hex");

export function briefMark(text: string): BriefMark {
  return { raw: hash(text), graded: hash(gradedContent(text)) };
}
