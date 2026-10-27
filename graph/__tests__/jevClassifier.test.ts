import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateQuestionTokens, jevClassifier, normalizedAnswer, retryDelayMs } from "../adapters/jevClassifier.ts";
import type { ClassifyRequest } from "../adapters/types.ts";
import { JEV_MAX_QUESTION_TOKENS } from "../constants.ts";
import { type JevBinding, RunError } from "../contracts.ts";

const binding = (over: Partial<JevBinding> = {}): JevBinding => ({
  adapter: "jev",
  setup: { name: "test", sha256: "0" },
  model: "jev-1.14.0",
  fields: { diff: { input: "diff" } },
  questions: {
    risky: { type: "noul", instructions: "Is it risky?", criteria: { true: "yes", false: "no" } },
    amount: { type: "score", instructions: "How much?", criteria: ["none", "some", "much", "a lot", "all"] },
  },
  combine: "mean",
  features: [],
  cutoff: 0.5,
  ...over,
});

const ap = ({ answer, p }: { answer: string; p: number }) => ({ answer, p });

const request = (over: Partial<ClassifyRequest> = {}): ClassifyRequest => ({
  question: "hunter",
  state: { diff: { schema: "text", text: "+ a line" } },
  iteration: 0,
  signal: new AbortController().signal,
  ...over,
});

const answers = (noul: number, score: number) => ({ risky: { type: "noul", noul }, amount: { type: "score", score, confidence: 0.9, legend: {}, probabilities: {} } });
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

interface Sent {
  url: string;
  init: RequestInit;
  body: any;
}

/** A fetch that serves `replies` in order and records each request. */
function fakeApi(replies: (Response | Error)[]) {
  const sent: Sent[] = [];
  const slept: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(init.body as string) });
    const next = replies[sent.length - 1];
    if (next === undefined) throw new Error("no reply scripted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  const sleep = async (ms: number) => void slept.push(ms);
  return { sent, slept, deps: { fetch, sleep, random: () => 0, env: { TYPESAFE_API_KEY: "key-123" } as Record<string, string> } };
}

test("a request carries the pinned model, the state built from the inputs, and the questions, with the key as a bearer token", async () => {
  const { sent, deps } = fakeApi([reply({ answers: answers(0.9, 4) })]);
  await jevClassifier(binding(), deps).classify(request());
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(sent[0]!.init.method, "POST");
  assert.equal((sent[0]!.init.headers as Record<string, string>).Authorization, "Bearer key-123");
  assert.deepEqual(sent[0]!.body, { model: "jev-1.14.0", state: { diff: "+ a line" }, questions: binding().questions });
});

test("TYPESAFE_BASE_URL replaces the host, trailing slashes dropped", async () => {
  const { sent, deps } = fakeApi([reply({ answers: answers(0.5, 2) })]);
  await jevClassifier(binding(), { ...deps, env: { ...deps.env, TYPESAFE_BASE_URL: "http://localhost:9/" } }).classify(request());
  assert.equal(sent[0]!.url, "http://localhost:9/v1/systemone");
});

test("p is the mean of the answers, a score over its top level, and the answer follows the cut-off", async () => {
  const hi = fakeApi([reply({ answers: answers(0.8, 3) })]); // (0.8 + 0.75) / 2
  const r = await jevClassifier(binding(), hi.deps).classify(request());
  assert.deepEqual(ap(r), { answer: "yes", p: 0.775 });
  assert.equal(r.sent, JSON.stringify(hi.sent[0]!.body.state), "it hands back the state exactly as it sent it");
  const lo = fakeApi([reply({ answers: answers(0.2, 1) })]); // (0.2 + 0.25) / 2
  assert.deepEqual(ap(await jevClassifier(binding(), lo.deps).classify(request())), { answer: "no", p: 0.225 });
  const edge = fakeApi([reply({ answers: answers(0.5, 2) })]); // exactly the cut-off
  assert.equal((await jevClassifier(binding(), edge.deps).classify(request())).answer, "yes");
});

test("an \"any of these\" setup takes the largest answer, so one strong answer fires it where the mean would not", async () => {
  const any = binding({ combine: "max" });
  const one = fakeApi([reply({ answers: answers(0.9, 0) })]); // max(0.9, 0); the mean would be 0.45
  assert.deepEqual(ap(await jevClassifier(any, one.deps).classify(request())), { answer: "yes", p: 0.9 });
  const mean = fakeApi([reply({ answers: answers(0.9, 0) })]);
  assert.deepEqual(ap(await jevClassifier(binding(), mean.deps).classify(request())), { answer: "no", p: 0.45 });
  const score = fakeApi([reply({ answers: answers(0.1, 3) })]); // the score's 0.75 is the largest
  assert.deepEqual(ap(await jevClassifier(any, score.deps).classify(request())), { answer: "yes", p: 0.75 });
  const none = fakeApi([reply({ answers: answers(0.3, 1) })]);
  assert.equal((await jevClassifier(any, none.deps).classify(request())).answer, "no");
});

test("a feature adds to p before the cut-off, and p is capped at 1", async () => {
  const b = binding({ cutoff: 0.9, features: [{ input: "report", pattern: "^decision", weight: 0.4 }] });
  const state = { diff: { schema: "text" as const, text: "x" }, report: { schema: "text" as const, text: "decision: yes" } };
  const withFeature = fakeApi([reply({ answers: answers(0.8, 3) })]); // 0.775 + 0.4
  assert.deepEqual(ap(await jevClassifier(b, withFeature.deps).classify(request({ state }))), { answer: "yes", p: 1 });
  const without = fakeApi([reply({ answers: answers(0.8, 3) })]);
  assert.equal((await jevClassifier(b, without.deps).classify(request({ state: { ...state, report: { schema: "text", text: "none" } } }))).answer, "no");
});

test("429 and 5xx are retried with backoff, at most three tries, and the third success is returned", async () => {
  const { sent, slept, deps } = fakeApi([reply("slow down", 429), reply("oops", 503), reply({ answers: answers(1, 4) })]);
  assert.deepEqual(ap(await jevClassifier(binding(), deps).classify(request())), { answer: "yes", p: 1 });
  assert.equal(sent.length, 3);
  assert.deepEqual(slept, [500, 1000], "exponential from 500 ms, no jitter with random() = 0");
});

test("three failing tries end the call with an error naming the status; a fourth is never sent", async () => {
  const { sent, deps } = fakeApi([reply("a", 500), reply("b", 502), reply({ detail: "overloaded" }, 503), reply({ answers: answers(1, 4) })]);
  await assert.rejects(jevClassifier(binding(), deps).classify(request()), (e: unknown) => /Jev HTTP 503: overloaded \(after 3 tries\)/.test((e as Error).message) && !(e instanceof RunError));
  assert.equal(sent.length, 3);
});

test("a 4xx other than 429 is a run error, never retried, and does not echo the request back", async () => {
  const { sent, deps } = fakeApi([reply({ detail: [{ loc: ["body", "questions"], msg: "field required", input: { state: "SECRET DIFF TEXT" } }] }, 422)]);
  await assert.rejects(jevClassifier(binding(), deps).classify(request()), (e: unknown) => e instanceof RunError && /Jev HTTP 422: body\.questions: field required/.test(e.message) && !/SECRET/.test(e.message));
  assert.equal(sent.length, 1);
  const auth = fakeApi([reply({ detail: "bad key" }, 401)]);
  await assert.rejects(jevClassifier(binding(), auth.deps).classify(request()), RunError);
});

test("Retry-After is honoured when it is short enough, and ignored past a minute", () => {
  assert.equal(retryDelayMs(0, new Headers({ "retry-after-ms": "250" }), () => 0), 250);
  assert.equal(retryDelayMs(0, new Headers({ "retry-after": "2" }), () => 0), 2000);
  assert.equal(retryDelayMs(1, new Headers({ "retry-after": "600" }), () => 0), 1000);
  assert.equal(retryDelayMs(10, new Headers(), () => 0), 5000, "backoff is capped");
  assert.equal(retryDelayMs(0, new Headers(), () => 1), 375, "jitter takes up to a quarter off");
});

test("a request over 32k tokens per question is refused before anything is sent", async () => {
  const { sent, deps } = fakeApi([reply({ answers: answers(1, 4) })]);
  const big = { diff: { schema: "text" as const, text: "x".repeat(JEV_MAX_QUESTION_TOKENS * 3) } };
  await assert.rejects(jevClassifier(binding(), deps).classify(request({ state: big })), (e: unknown) => e instanceof RunError && /over the limit of 32000/.test(e.message));
  assert.equal(sent.length, 0);
});

test("the size estimate is characters over three, state plus the largest question", () => {
  const q = { risky: { type: "noul" as const, instructions: "x".repeat(100) } };
  const chars = JSON.stringify({ diff: "y".repeat(600) }).length + JSON.stringify(q.risky).length;
  assert.equal(estimateQuestionTokens({ diff: "y".repeat(600) }, q), Math.ceil(chars / 3));
});

test("with no key set the call is refused as a run error before any request", async () => {
  const { sent, deps } = fakeApi([]);
  for (const env of [{}, { TYPESAFE_API_KEY: "   " }]) {
    await assert.rejects(jevClassifier(binding(), { ...deps, env }).classify(request()), (e: unknown) => e instanceof RunError && /TYPESAFE_API_KEY/.test(e.message));
  }
  assert.equal(sent.length, 0);
});

test("a malformed answer fails: a missing question, the wrong type, a probability out of range, a score past its top level", async () => {
  const bad: unknown[] = [
    { answers: { risky: { type: "noul", noul: 0.5 } } },
    { answers: { ...answers(0.5, 2), risky: { type: "score", score: 1 } } },
    { answers: answers(1.5, 2) },
    { answers: answers(0.5, 5) },
    { answers: answers(Number.NaN, 2) },
    { nothing: true },
  ];
  for (const body of bad) {
    const { deps } = fakeApi([reply(body)]);
    await assert.rejects(jevClassifier(binding(), deps).classify(request()), /^Error: Jev answer/, JSON.stringify(body));
  }
  const { deps } = fakeApi([reply("<html>gateway</html>")]);
  await assert.rejects(jevClassifier(binding(), deps).classify(request()));
});

test("a request that times out or is cancelled rejects with the fetch's error and is not retried", async () => {
  const timeout = Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" });
  const { sent, deps } = fakeApi([timeout, reply({ answers: answers(1, 4) })]);
  await assert.rejects(jevClassifier(binding(), deps).classify(request()), (e: unknown) => e === timeout);
  assert.equal(sent.length, 1);
});

test("a cancel while waiting between tries ends the wait", async () => {
  const ctl = new AbortController();
  const { deps } = fakeApi([reply("x", 500), reply({ answers: answers(1, 4) })]);
  const cancel = new Error("cancelled");
  const sleep = async () => {
    ctl.abort(cancel);
    throw cancel;
  };
  await assert.rejects(jevClassifier(binding(), { ...deps, sleep }).classify(request({ signal: ctl.signal })), (e: unknown) => e === cancel);
});

test("normalizedAnswer divides a score by its top level and passes a noul through", () => {
  const all = answers(0.3, 3);
  assert.equal(normalizedAnswer("risky", binding().questions.risky!, all), 0.3);
  assert.equal(normalizedAnswer("amount", binding().questions.amount!, all), 0.75);
});
