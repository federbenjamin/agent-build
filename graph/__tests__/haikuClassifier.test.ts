import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { HAIKU_SCHEMA, haikuArgs, haikuClassifier, haikuPrompt } from "../adapters/haikuClassifier.ts";
import type { ProcessOptions, ProcessResult } from "../adapters/process.ts";
import type { ClassifyRequest } from "../adapters/types.ts";
import { type HaikuBinding, RunError } from "../contracts.ts";

const binding: HaikuBinding = {
  adapter: "haiku",
  setup: { name: "test", sha256: "0" },
  model: "claude-haiku-5-5",
  fields: { diff: { input: "diff", maxChars: 10, sample: "head", note: { field: "diff_note", text: "" } } },
  system: "You answer one question.\n\nQuestion: Does this change call an outside service?",
  prompt: "## Diff{{diff_note}}\n\n{{diff}}",
  calls: 1,
  cutoff: 0.5,
};

const request = (over: Partial<ClassifyRequest> = {}): ClassifyRequest => ({
  question: "exposure",
  state: { diff: { schema: "text", text: "fetch(url) and a long tail" } },
  iteration: 0,
  signal: new AbortController().signal,
  ...over,
});

const result = (over: Partial<ProcessResult> = {}): ProcessResult => ({ code: 0, stdout: "", stderr: "", output: "", ...over });
const json = (o: unknown): ProcessResult => result({ stdout: JSON.stringify(o) });
const answer = (p_yes: unknown) => json({ is_error: false, structured_output: { reason: "r", p_yes } });

function fakeClaude(...rs: ProcessResult[]) {
  const calls: { cmd: string; args: string[]; opts: ProcessOptions }[] = [];
  return { calls, run: async (cmd: string, args: string[], opts: ProcessOptions) => (calls.push({ cmd, args, opts }), rs[Math.min(calls.length, rs.length) - 1]!) };
}

test("it runs claude -p with the setup's system prompt and model, none of the user's settings or MCP servers, no tools, and the p_yes schema", async () => {
  const { calls, run } = fakeClaude(answer(0.8));
  const req = request();
  assert.deepEqual(await haikuClassifier(binding, { run }).classify(req), { answer: "yes", p: 0.8, sent: "## Diff (first 10 of 26 characters)\n\nfetch(url)" }, "it hands back the user message it sent");
  const [{ cmd, args, opts }] = calls as [(typeof calls)[number]];
  assert.equal(cmd, "claude");
  assert.deepEqual(args, haikuArgs(binding));
  assert.deepEqual(args.slice(0, 3), ["-p", "--model", "claude-haiku-5-5"]);
  assert.equal(args[args.indexOf("--system-prompt") + 1], binding.system);
  assert.equal(args[args.indexOf("--setting-sources") + 1], "", "no user, project or local settings");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "", "all tools off");
  assert.equal(args[args.indexOf("--json-schema") + 1], JSON.stringify(HAIKU_SCHEMA));
  assert.deepEqual(HAIKU_SCHEMA.required, ["reason", "p_yes"]);
  assert.equal(opts.input, "## Diff (first 10 of 26 characters)\n\nfetch(url)", "the prompt with each field in place, the head cut and its note");
  assert.equal(opts.signal.aborted, false);
});

test("cancelling the node aborts its calls with the node's reason", async () => {
  const node = new AbortController();
  const reason = new Error("cancelled");
  const run = (_cmd: string, _args: string[], opts: ProcessOptions): Promise<ProcessResult> =>
    new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
  const decision = haikuClassifier({ ...binding, calls: 2 }, { run }).classify(request({ signal: node.signal }));
  node.abort(reason);
  await assert.rejects(decision, (e: unknown) => e === reason);
});

test("a setup asking for several calls makes them at once and answers on the mean of their p_yes", async () => {
  let live = 0;
  let most = 0;
  const ps = [0.2, 0.6];
  const run = async (): Promise<ProcessResult> => {
    live++;
    most = Math.max(most, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return answer(ps.shift());
  };
  const r = await haikuClassifier({ ...binding, calls: 2, cutoff: 0.4 }, { run }).classify(request());
  assert.deepEqual([r.answer, r.p], ["yes", 0.4]);
  assert.equal(most, 2, "both calls ran at the same time");
});

test("one failed call of several fails the decision", async () => {
  const { run } = fakeClaude(answer(0.9), result({ code: 1, stderr: "rate limited" }));
  await assert.rejects(haikuClassifier({ ...binding, calls: 2 }, { run }).classify(request()), /haiku: claude exited 1: rate limited/);
});

test("a failed call aborts its siblings and fails the decision only once they have exited", async () => {
  const events: string[] = [];
  let n = 0;
  const run = (_cmd: string, _args: string[], opts: ProcessOptions): Promise<ProcessResult> => {
    const k = ++n;
    if (k === 1) return Promise.resolve(result({ code: 1, stderr: "overloaded" }));
    return new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => {
        events.push(`call ${k} aborted`);
        setTimeout(() => (events.push(`call ${k} exited`), reject(opts.signal.reason)), 10);
      });
    });
  };
  await assert.rejects(
    haikuClassifier({ ...binding, calls: 3 }, { run }).classify(request()).finally(() => events.push("decision failed")),
    /haiku: claude exited 1: overloaded/,
  );
  assert.deepEqual(events, ["call 2 aborted", "call 3 aborted", "call 2 exited", "call 3 exited", "decision failed"]);
});

test("p below the cut-off answers no, at it answers yes", async () => {
  assert.equal((await haikuClassifier(binding, fakeClaude(answer(0.49))).classify(request())).answer, "no");
  assert.equal((await haikuClassifier(binding, fakeClaude(answer(0.5))).classify(request())).answer, "yes");
});

test("no usable probability fails: no JSON, no structured output, p_yes out of range or not a number, or an error result", async () => {
  const bad: ProcessResult[] = [
    result({ stdout: "not json" }),
    json({ result: "p is 0.7" }),
    answer(1.2),
    answer("0.7"),
    json({ structured_output: { p: 0.7 } }),
    json({ is_error: true, structured_output: { reason: "r", p_yes: 0.7 } }),
  ];
  for (const r of bad) {
    await assert.rejects(haikuClassifier(binding, fakeClaude(r)).classify(request()), /^Error: haiku (printed no JSON|gave no probability)/, r.stdout);
  }
});

test("a non-zero exit fails with the end of stderr", async () => {
  await assert.rejects(haikuClassifier(binding, fakeClaude(result({ code: 1, stderr: "not logged in" }))).classify(request()), /haiku: claude exited 1: not logged in/);
});

test("a timeout or cancel is the runner's rejection, passed through", async () => {
  const reason = new Error("cancelled");
  const run = async (): Promise<ProcessResult> => {
    throw reason;
  };
  await assert.rejects(haikuClassifier(binding, { run }).classify(request()), (e: unknown) => e === reason);
});

test("an input the node was not given fails before claude runs", async () => {
  const { calls, run } = fakeClaude(answer(1));
  await assert.rejects(haikuClassifier(binding, { run }).classify(request({ state: {} })), /no input diff/);
  assert.equal(calls.length, 0);
});

test("the prompt fills each placeholder once, from the state, and never reads a field's text as a placeholder", () => {
  assert.equal(haikuPrompt("{{a}} and {{b}}", { a: "{{b}}", b: "B" }), "{{b}} and B");
  assert.throws(() => haikuPrompt("{{missing}}", {}), (e: unknown) => e instanceof RunError && /no state field missing/.test(e.message), "a run error: a retry would not bring the field");
});
