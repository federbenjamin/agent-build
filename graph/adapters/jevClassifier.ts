/**
 * The Jev classifier: one `POST {TYPESAFE_BASE_URL}/v1/systemone` with the binding's state and
 * questions, the key from `TYPESAFE_API_KEY`. p is the questions' combination (their mean, or the
 * largest) plus the binding's code-side features; the answer is `yes` at the binding's cut-off. A request over the size limit
 * is refused before it is sent. 429 and 5xx are retried with backoff, three tries in all.
 * API: https://docs.typesafe.ai/api
 */

import {
  CLASSIFIER_NO,
  CLASSIFIER_YES,
  JEV_BACKOFF_INITIAL_MS,
  JEV_BACKOFF_JITTER,
  JEV_BACKOFF_MAX_MS,
  JEV_CHARS_PER_TOKEN,
  JEV_MAX_QUESTION_TOKENS,
  JEV_MAX_RETRY_AFTER_MS,
  JEV_MAX_TRIES,
  JEV_REQUEST_TIMEOUT_MS,
  TYPESAFE_DEFAULT_BASE_URL,
} from "../constants.ts";
import { type JevBinding, type JevQuestion, RunError } from "../contracts.ts";
import { buildState, combineAnswers, decide, featureSum } from "./classifierState.ts";
import type { Classifier } from "./types.ts";

export interface JevDeps {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** The estimated tokens of the largest request: the state beside each question, one at a time. */
export function estimateQuestionTokens(state: unknown, questions: Record<string, JevQuestion>): number {
  const stateChars = JSON.stringify(state).length;
  const largest = Math.max(...Object.values(questions).map((q) => JSON.stringify(q).length));
  return Math.ceil((stateChars + largest) / JEV_CHARS_PER_TOKEN);
}

/** The wait before the next try: the server's `Retry-After` when it is short enough, else exponential. */
export function retryDelayMs(attempt: number, headers: Headers, random: () => number): number {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0 && ms <= JEV_MAX_RETRY_AFTER_MS) return ms;
  const seconds = Number(headers.get("retry-after"));
  if (headers.has("retry-after") && Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 <= JEV_MAX_RETRY_AFTER_MS) return seconds * 1000;
  const exp = Math.min(JEV_BACKOFF_INITIAL_MS * 2 ** attempt, JEV_BACKOFF_MAX_MS);
  return Math.round(exp * (1 - random() * JEV_BACKOFF_JITTER));
}

/** An error response's reason, from the fields the API is known to use, never the echoed input. */
function reasonOf(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail.slice(0, 300);
  if (Array.isArray(detail)) {
    return detail
      .map((d) => `${((d as { loc?: unknown[] }).loc ?? []).join(".")}: ${(d as { msg?: string }).msg ?? "invalid"}`)
      .join("; ")
      .slice(0, 300);
  }
  const message = (detail as { message?: unknown } | undefined)?.message ?? (body as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message.slice(0, 300) : "no reason given";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One answer as a number in [0, 1]: a noul as it is, a score over its top level. */
export function normalizedAnswer(name: string, q: JevQuestion, answers: unknown): number {
  const a = (typeof answers === "object" && answers !== null ? (answers as Record<string, unknown>)[name] : undefined) as Record<string, unknown> | undefined;
  if (a === undefined || typeof a !== "object" || a === null || a.type !== q.type) throw new Error(`Jev answer ${name} is missing or not a ${q.type}`);
  if (q.type === "noul") {
    if (!isNum(a.noul) || a.noul < 0 || a.noul > 1) throw new Error(`Jev answer ${name}: noul is not a probability`);
    return a.noul;
  }
  const top = q.criteria.length - 1;
  if (!isNum(a.score) || a.score < 0 || a.score > top) throw new Error(`Jev answer ${name}: score is not within 0 to ${top}`);
  return a.score / top;
}

export function jevClassifier(binding: JevBinding, deps: JevDeps = {}): Classifier {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const env = deps.env ?? process.env;
  const names = Object.keys(binding.questions);

  return {
    async classify(req) {
      const key = env.TYPESAFE_API_KEY?.trim();
      if (key === undefined || key === "") throw new RunError("Jev classifier: TYPESAFE_API_KEY is not set");
      const state = buildState(binding.fields, req.state, req.question);
      const tokens = estimateQuestionTokens(state, binding.questions);
      if (tokens > JEV_MAX_QUESTION_TOKENS) {
        throw new RunError(`Jev classifier ${req.question}: about ${tokens} tokens per question, over the limit of ${JEV_MAX_QUESTION_TOKENS}`);
      }
      const base = (env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, "");
      const body = JSON.stringify({ model: binding.model, state, questions: binding.questions });

      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(`${base}/v1/systemone`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
          body,
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(JEV_REQUEST_TIMEOUT_MS)]),
        });
        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        if (res.ok) {
          const answers = (parsed as { answers?: unknown } | undefined)?.answers;
          const combined = combineAnswers(names.map((n) => normalizedAnswer(n, binding.questions[n]!, answers)), binding.combine);
          return { ...decide(combined + featureSum(binding.features, req.state, req.question), binding.cutoff, CLASSIFIER_YES, CLASSIFIER_NO), sent: JSON.stringify(state) };
        }
        const retryable = res.status === 429 || res.status >= 500;
        const failure = `Jev HTTP ${res.status}: ${reasonOf(parsed)}`;
        if (!retryable) throw new RunError(failure);
        if (attempt + 1 >= JEV_MAX_TRIES) throw new Error(`${failure} (after ${JEV_MAX_TRIES} tries)`);
        await sleep(retryDelayMs(attempt, res.headers, random), req.signal);
      }
    },
  };
}
