/** What a data node does: its role is one operation on the tracker or the forge. A `merge` merges
 *  only when every check among its inputs passed (`gateProblem`); the forge merges what it is asked to. */

import { readFileSync } from "node:fs";

import { type CheckValue, ContractError, type DataOp, type DataValue, type DataValues, type MergeConflict, RunError, type RunPlace } from "./contracts.ts";
import type { Forge, Tracker } from "./adapters/types.ts";
import { type MergeOutcome, mergeWriterCommit, withRunTree } from "./worktree.ts";

/** A declared file's text, trailing whitespace trimmed unless `raw`. One that cannot be read fails
 *  the operation: a ticket or PR never goes out with a placeholder where an artifact should be. */
function readDeclared(file: string, raw: boolean): string {
  try {
    const text = readFileSync(file, "utf8");
    return raw ? text : text.trimEnd();
  } catch (e) {
    throw new ContractError([{ message: `cannot read declared file ${file}: ${(e as Error).message}` }]);
  }
}

/** A data value as text: files are read, so one that cannot be is an error. Each file's trailing
 *  whitespace is trimmed for a ticket's or PR's body; `raw` keeps it, as a classifier's state does, so
 *  a tuned setup reads the file as it was measured. */
export function renderValue(v: DataValue, opts: { raw?: boolean } = {}): string {
  switch (v.schema) {
    case "text":
      return v.text;
    case "files":
      return v.files.map((f) => readDeclared(f, opts.raw === true)).join("\n\n");
    case "verdict":
      return `${v.answer} (p=${v.p})`;
    case "check":
      return `${v.answer}: ${v.detail}`;
    case "ref":
      return `${v.kind} ${v.id}${v.url === undefined ? "" : ` ${v.url}`}`;
    case "outcome":
      return v.answer;
    case "items":
      return v.items.map((it) => it.id).join(", ");
  }
}

/** The inputs as one text, a `## <id>` section each, in id order: a ticket's or PR's body. */
export function bundleText(inputs: DataValues): string {
  return Object.keys(inputs)
    .sort()
    .map((id) => `## ${id}\n\n${renderValue(inputs[id]!)}`)
    .join("\n\n");
}

/** Why the gate is not green, or null when it is: at least one check, every one passing. */
export function gateProblem(gate: readonly { answer: string }[]): string | null {
  if (gate.length === 0) return "no gate data";
  const failed = gate.filter((g) => g.answer !== "pass").length;
  return failed === 0 ? null : `${failed} of ${gate.length} gate checks did not pass`;
}

export interface DataOpContext {
  runId: string;
  nodeId: string;
  inputs: DataValues;
  place: RunPlace;
  tracker: Tracker;
  forge: Forge;
  signal: AbortSignal;
}

const textOf = (inputs: DataValues): string | undefined =>
  Object.values(inputs).find((v): v is Extract<DataValue, { schema: "text" }> => v.schema === "text")?.text;

/** A data op's value, or the commit and paths of a `merge-back` whose merge conflicted (the run tree as it was). */
export type DataOpResult = DataValue | { conflict: MergeConflict };

export async function runDataOp(op: DataOp, ctx: DataOpContext): Promise<DataOpResult> {
  const title = `${ctx.runId}: ${ctx.nodeId}`;
  const { signal } = ctx;
  switch (op) {
    case "ingest": {
      const ref = textOf(ctx.inputs)?.trim();
      if (ref === undefined || ref === "") throw new Error(`ingest ${ctx.nodeId}: no text input names a ticket`);
      const t = await ctx.tracker.ingest(ref, signal);
      return { schema: "text", text: `${t.title}\n\n${t.body}` };
    }
    case "ticket":
      return ctx.tracker.file({ title, body: bundleText(ctx.inputs) }, signal);
    case "comment": {
      const ticket = Object.entries(ctx.inputs).find(([, v]) => v.schema === "ref" && v.kind === "ticket");
      if (ticket?.[1].schema !== "ref") throw new Error(`comment ${ctx.nodeId}: no input is a ticket`);
      const rest = Object.fromEntries(Object.entries(ctx.inputs).filter(([id]) => id !== ticket[0]));
      if (Object.keys(rest).length === 0) throw new Error(`comment ${ctx.nodeId}: no input besides the ticket to say`);
      return ctx.tracker.comment(ticket[1].id, bundleText(rest), signal);
    }
    case "push":
      return ctx.forge.push({ worktree: ctx.place.worktree, branch: ctx.place.branch, signal });
    case "pr":
      return ctx.forge.openPr({ worktree: ctx.place.worktree, branch: ctx.place.branch, title, body: bundleText(ctx.inputs), signal });
    case "merge": {
      const pr = Object.values(ctx.inputs).find((v) => v.schema === "ref" && v.kind === "pr");
      if (pr?.schema !== "ref") throw new Error(`merge ${ctx.nodeId}: no input is a PR`);
      const problem = gateProblem(Object.values(ctx.inputs).filter((v): v is CheckValue => v.schema === "check"));
      if (problem !== null) throw new RunError(`merge ${ctx.nodeId}: refusing to merge PR ${pr.id}: ${problem}`);
      return ctx.forge.merge({ worktree: ctx.place.worktree, pr: pr.id, branch: ctx.place.branch, signal });
    }
    case "merge-back": {
      const commits = Object.values(ctx.inputs).filter((v): v is Extract<DataValue, { schema: "ref" }> => v.schema === "ref" && v.kind === "commit");
      if (commits.length !== 1) throw new ContractError([{ message: `merge-back ${ctx.nodeId}: wants one commit input, got ${commits.length}` }]);
      const sha = commits[0]!.id;
      const merged = await mergeIntoRunTree(ctx.place, sha, ctx.nodeId);
      return "conflict" in merged ? merged : { schema: "ref", kind: "commit", id: merged.head };
    }
  }
}

/** Merge writer `label`'s commit `sha` into the run tree under its lock. */
export async function mergeIntoRunTree(place: RunPlace, sha: string, label: string): Promise<MergeOutcome> {
  return withRunTree(place.worktree, () => mergeWriterCommit(place.worktree, sha, label));
}
