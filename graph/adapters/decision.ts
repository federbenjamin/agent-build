/**
 * A classifier node's decision record (the map's d.decision): the node, its setup (name and content
 * hash), adapter, model and cut-off, and a digest of the exact state it sent. The record goes on the
 * verdict; the record and the state sent go to one file in the node's output folder, which a later
 * tuning round reads. Pure: the caller writes the file.
 */

import { createHash } from "node:crypto";

import { CLASSIFIER_NO, CLASSIFIER_YES, EXPLORE_RATE } from "../constants.ts";
import type { ClassifierBinding, ClassifierDecision, RunKind, VerdictValue } from "../contracts.ts";

/** The decision file's name in the node's output folder. */
export const DECISION_FILE = "decision.json";

export const stateDigest = (sent: string): string => createHash("sha256").update(sent).digest("hex");

/** The record for `node`'s decision under `binding`; with what it sent, its digest and the file it is
 *  kept in. A stub sends nothing, so its record names only the node and the adapter. */
export function decisionRecord(node: string, binding: ClassifierBinding, sent?: { text: string; file: string }): ClassifierDecision {
  const base: ClassifierDecision = { node, adapter: binding.adapter };
  if (binding.adapter === "stub") return base;
  return {
    ...base,
    setup: binding.setup,
    model: binding.model,
    cutoff: binding.cutoff,
    ...(sent === undefined ? {} : { stateDigest: stateDigest(sent.text), decisionFile: sent.file }),
  };
}

/** The decision file's text: the record, its answer and p, and the state as sent. */
export function decisionFileText(record: ClassifierDecision, answer: { answer: string; p: number }, sent: string): string {
  return `${JSON.stringify({ ...record, answer: answer.answer, p: answer.p, state: sent }, null, 2)}\n`;
}

/** Whether a `no` from `node` at `iteration` of run `runId` is explored: its gated reader runs anyway.
 *  The coin is the same on every worker and replay: the first 8 hex digits of the sha256 of
 *  `<run id>|<node>|<iteration>|explore`, over 2^32, below `rate`. */
export const explores = (runId: string, node: string, iteration: number, rate: number): boolean =>
  parseInt(createHash("sha256").update([runId, node, iteration, "explore"].join("|")).digest("hex").slice(0, 8), 16) / 2 ** 32 < rate;

/** Whether a verdict is explored: a `no` from an `initial` setup in a real run whose coin for this
 *  node and iteration falls under `EXPLORE_RATE`. A mock, a stub, a binding whose `status` (its setup
 *  file's, or an inline binding's own key) is absent or not `initial`, and a `yes` never are. */
export function isExplored(binding: ClassifierBinding, run: { runId: string; kind: RunKind }, node: string, iteration: number, answer: string): boolean {
  return binding.adapter !== "stub" && binding.status === "initial" && run.kind === "real" && answer === CLASSIFIER_NO && explores(run.runId, node, iteration, EXPLORE_RATE);
}

/** The verdict of a classifier whose call failed for good: `yes`, so its reader runs, at the cut-off
 *  (a stub has none: 1), so the answer and p agree; the decision says why. */
export function failedOpenVerdict(node: string, binding: ClassifierBinding, error: string): VerdictValue {
  return { schema: "verdict", answer: CLASSIFIER_YES, p: binding.adapter === "stub" ? 1 : binding.cutoff, decision: { ...decisionRecord(node, binding), error } };
}
