/**
 * What a classifier reads: its state, built from the node's inputs by the binding's fields, the
 * code-side features added to its p, and how its answers combine. Shared by every classifier
 * adapter, so a setup tuned on one runs on another.
 */

import { type Combine, RunError, type DataValues, type PatternFeature, type StateField } from "../contracts.ts";
import { renderValue } from "../dataOps.ts";
import { shapeDiff } from "./diffShape.ts";
import { sampleText } from "./sample.ts";

const given = (inputs: DataValues, id: string): boolean => Object.hasOwn(inputs, id) && inputs[id] !== undefined;

function inputText(inputs: DataValues, id: string, who: string): string {
  if (!given(inputs, id)) throw new RunError(`classifier ${who}: no input ${id}`);
  return renderValue(inputs[id]!, { raw: true });
}

/** `text` before the first line `pattern` matches, trimmed; `text` as it is with no pattern. */
export function cutBefore(text: string, pattern: string | undefined): string {
  if (pattern === undefined) return text;
  const at = new RegExp(pattern, "m").exec(text);
  return (at === null ? text : text.slice(0, at.index)).trim();
}

/** The state to send: each field's input cut, shaped, sampled down to its `maxChars`, and followed by its
 *  note. An optional field whose input is absent is left out, note and all. */
export function buildState(fields: Record<string, StateField>, inputs: DataValues, who: string): Record<string, string> {
  const state: Record<string, string> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (f.optional === true && !given(inputs, f.input)) continue;
    const raw = cutBefore(inputText(inputs, f.input, who), f.cutBefore);
    const text = f.shape === undefined ? raw : shapeDiff(raw, f.shape);
    const sample = f.maxChars === undefined ? { text, how: "" } : sampleText(text, f.maxChars, { diff: f.shape !== undefined, head: f.sample === "head", ...(f.keep === undefined ? {} : { keep: f.keep }) });
    state[name] = sample.text;
    if (f.note !== undefined) state[f.note.field] = f.note.text + (sample.how === "" ? "" : ` (${sample.how})`);
  }
  return state;
}

/** The features' sum: each weight whose pattern matches its input's text. */
export function featureSum(features: PatternFeature[], inputs: DataValues, who: string): number {
  return features.reduce((sum, f) => sum + (new RegExp(f.pattern, "m").test(inputText(inputs, f.input, who)) ? f.weight : 0), 0);
}

/** The answers, each in [0, 1], made one: their mean, or the largest for an "any of these" setup. */
export function combineAnswers(values: readonly number[], combine: Combine): number {
  if (values.length === 0) throw new Error("no answers to combine");
  return combine === "max" ? Math.max(...values) : values.reduce((a, b) => a + b, 0) / values.length;
}

/** p as a probability and the yes/no at the cut-off. A sum can pass 1 (features add to the mean);
 *  the answer is decided on the sum, and p is capped at 1, which keeps the same side of any cut-off. */
export function decide(score: number, cutoff: number, yes: string, no: string): { answer: string; p: number } {
  return { answer: score >= cutoff ? yes : no, p: Math.min(1, Math.max(0, score)) };
}
