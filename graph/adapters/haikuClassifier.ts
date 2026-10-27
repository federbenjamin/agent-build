/**
 * The Haiku classifier: `claude -p` on the setup's model with the setup's own system prompt, none of
 * the user's settings, hooks or MCP servers (`--setting-sources ''`, `--strict-mcp-config`), no tools,
 * and a JSON schema for `p_yes` and a reason. The user message is the setup's `prompt` with each
 * `{{name}}` replaced by the state field `name`, the same state fields a Jev setup uses. A setup may
 * ask for several calls, made at once; p is the mean of their `p_yes`. One failed call fails the
 * decision: the others are aborted, and it fails once they have exited.
 */

import { tmpdir } from "node:os";

import { CLASSIFIER_NO, CLASSIFIER_YES } from "../constants.ts";
import { type HaikuBinding, RunError } from "../contracts.ts";
import { tail } from "./agentIo.ts";
import { buildState, decide } from "./classifierState.ts";
import { type ProcessRunner, runProcess } from "./process.ts";
import type { Classifier } from "./types.ts";

/** The answer's schema: a probability that the answer is yes, and one or two sentences of reason. */
export const HAIKU_SCHEMA = {
  type: "object",
  properties: { reason: { type: "string" }, p_yes: { type: "number", minimum: 0, maximum: 1 } },
  required: ["reason", "p_yes"],
  additionalProperties: false,
};

export interface HaikuDeps {
  run?: ProcessRunner;
}

/** The user message: `prompt` with each `{{name}}` replaced by the state field `name`, in one pass,
 *  so a field's text is never read as a placeholder. */
export function haikuPrompt(prompt: string, state: Record<string, string>): string {
  return prompt.replace(/\{\{([\w-]+)\}\}/g, (_, name: string) => {
    const v = state[name];
    if (v === undefined) throw new RunError(`haiku prompt: no state field ${name}`);
    return v;
  });
}

/** The CLI's arguments: the system prompt replaces Claude Code's own, and nothing of the user's
 *  setup is loaded, so the cost and the calibration do not move with their settings. */
export function haikuArgs(b: HaikuBinding): string[] {
  return [
    "-p",
    "--model",
    b.model,
    "--system-prompt",
    b.system,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--tools",
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(HAIKU_SCHEMA),
  ];
}

/** p from the CLI's JSON result: its `structured_output.p_yes`, which the schema constrains. */
function pOf(stdout: string): number {
  let parsed: { structured_output?: { p_yes?: unknown }; is_error?: boolean };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`haiku printed no JSON result: ${tail(stdout, 200)}`);
  }
  const p = parsed?.structured_output?.p_yes;
  if (parsed?.is_error === true || typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`haiku gave no probability: ${tail(stdout, 200)}`);
  }
  return p;
}

export function haikuClassifier(binding: HaikuBinding, deps: HaikuDeps = {}): Classifier {
  const run = deps.run ?? runProcess;
  return {
    async classify(req) {
      const input = haikuPrompt(binding.prompt, buildState(binding.fields, req.state, req.question));
      const calls = new AbortController();
      const cancel = () => calls.abort(req.signal.reason);
      if (req.signal.aborted) cancel();
      else req.signal.addEventListener("abort", cancel, { once: true });
      let failure: { error: unknown } | undefined;
      const one = async (): Promise<number> => {
        try {
          const r = await run("claude", haikuArgs(binding), { cwd: tmpdir(), input, signal: calls.signal });
          if (r.code !== 0) throw new Error(`haiku: claude exited ${r.code ?? "on a signal"}: ${tail(r.stderr || r.stdout)}`);
          return pOf(r.stdout);
        } catch (error) {
          if (failure === undefined) {
            failure = { error };
            calls.abort(error);
          }
          throw error;
        }
      };
      try {
        const settled = await Promise.allSettled(Array.from({ length: binding.calls }, one));
        if (failure !== undefined) throw failure.error;
        const ps = settled.map((r) => (r as PromiseFulfilledResult<number>).value);
        return { ...decide(ps.reduce((a, b) => a + b, 0) / ps.length, binding.cutoff, CLASSIFIER_YES, CLASSIFIER_NO), sent: input };
      } finally {
        req.signal.removeEventListener("abort", cancel);
      }
    },
  };
}
