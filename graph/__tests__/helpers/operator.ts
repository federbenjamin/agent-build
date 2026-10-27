/** Play the operator for a run in a test: answer each question it asks, in order, from `replies`. */

import { setTimeout as sleep } from "node:timers/promises";

import type { WorkflowHandle } from "@temporalio/client";

import { QUERY_STATUS, type RunHistory, SIGNAL_ANSWER } from "../../contracts.ts";

const POLL_MS = 25;

/** The run's history once it ends, each question it put to the operator answered by the next reply.
 *  A question with no reply left fails the test. `asked`, when given, collects each question's text.
 *  It waits on `describe()`, not `result()`: on the time-skipping server a pending `result()` lets
 *  time skip, so a run waiting on the operator would jump to its run timeout before the answer. */
export async function runAnswering(handle: WorkflowHandle, replies: readonly string[], asked?: string[]): Promise<RunHistory> {
  const left = [...replies];
  const answered = new Set<string>();
  for (;;) {
    if ((await handle.describe()).status.name !== "RUNNING") break;
    const ask = (await handle.query<RunHistory>(QUERY_STATUS)).asking[0];
    const key = ask === undefined ? undefined : `${ask.node}#${ask.iteration}: ${ask.question}`;
    if (key !== undefined && !answered.has(key)) {
      answered.add(key);
      asked?.push(ask!.question);
      const reply = left.shift();
      if (reply === undefined) throw new Error(`the run asks the operator and no reply is left: ${key}`);
      await handle.signal(SIGNAL_ANSWER, reply);
    }
    await sleep(POLL_MS);
  }
  return (await handle.result()) as RunHistory;
}
