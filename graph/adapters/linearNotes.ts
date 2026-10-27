/**
 * Where a ticket goes comes from the target repo's build notes (`steps.ts --get notes`, as of the run's base commit), never from
 * code: a `## tracker` section whose lines read `team: <team key>` and `labels: <name>, <name>`
 * (a leading `-` or `*` is fine).
 */

import { LINEAR_NOTES_SECTION } from "../constants.ts";
import { RunError } from "../contracts.ts";
import { notesAtBase, noteSections } from "./baseSteps.ts";

export interface LinearTarget {
  team: string;
  labels: string[];
}

/** The `## tracker` section of `notes`: its team and labels. Throws `RunError` with no team. */
export function parseLinearTarget(notes: string, source: string): LinearTarget {
  const section = noteSections(notes)[LINEAR_NOTES_SECTION];
  if (section === undefined) throw new RunError(`${source} has no "## ${LINEAR_NOTES_SECTION}" section naming the Linear team`);
  let team: string | undefined;
  let labels: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\s*[-*]?\s*(team|labels)\s*:\s*(.*?)\s*$/i.exec(line);
    if (m === null) continue;
    if (m[1]!.toLowerCase() === "team") team = m[2]!;
    else labels = m[2]!.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  if (team === undefined || team === "") throw new RunError(`${source}: the "## ${LINEAR_NOTES_SECTION}" section has no "team:" line`);
  return { team, labels };
}

/** The target of the repo at `worktree`, from its notes as of the run's base commit. */
export function linearTargetOf(worktree: string, base: string, deps: { notesAtBase?: typeof notesAtBase } = {}): LinearTarget {
  const notes = (deps.notesAtBase ?? notesAtBase)(worktree, base);
  if (notes === null) throw new RunError("the repo maps no notes step, so no Linear team is known");
  return parseLinearTarget(notes.text, notes.path);
}
