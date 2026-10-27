/** The run store keys (`runKeys.ts`): what an activity writes under, the run-dir reader reads back. */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { attemptAt, attemptBefore, attemptKey, attemptOutKey, attemptOwner, nodeKey, outKey, outputFileOwner } from "../runKeys.ts";

test("an attempt record's key names its node run back, whatever the item is called; any other key names none", () => {
  const node = { id: "A-fix" } as Parameters<typeof nodeKey>[0]["node"];
  for (const task of [{ node, iteration: 0 }, { node, iteration: 2, instance: "rerun-3" }, { node, iteration: 1, instance: "P#1@x", rerun: 4 }]) {
    assert.equal(attemptOwner(attemptKey(task, 3)), nodeKey(task), JSON.stringify(task));
    assert.deepEqual(outputFileOwner(`${outKey(task)}/report/struggles.json`), { nodeRun: nodeKey(task), name: "struggles.json" });
    assert.deepEqual(outputFileOwner(`${outKey(task)}/slice-fix/crosstalk.jsonl`), { nodeRun: nodeKey(task), name: "crosstalk.jsonl" });
  }
  assert.equal(nodeKey({ node, iteration: 1, instance: "P#1@x" }), "nodes/A-fix/1/P_1_x");
  for (const other of ["nodes/A-fix/0/pgid", "nodes/A-fix/0/start-sha", "history", "nodes/A-fix/0/rerun-0/attempt-x"]) assert.equal(attemptOwner(other), null, other);
  assert.equal(outputFileOwner("nodes/A-fix/0/out/report/deep/struggles.json"), null, "only a file directly in an output folder");
});

test("an earlier attempt's kept side files name their node run and that attempt, whatever the item is called; the attempt before one is the latest that ran before it", () => {
  const node = { id: "A-fix" } as Parameters<typeof nodeKey>[0]["node"];
  for (const task of [{ node, iteration: 0 }, { node, iteration: 2, instance: "rerun-3" }, { node, iteration: 1, instance: "attempt-1", rerun: 4 }]) {
    const kept = { rerun: task.rerun ?? 0, attempt: 2 };
    assert.deepEqual(outputFileOwner(`${attemptOutKey(task, 2)}/report/struggles.json`), { nodeRun: nodeKey(task), name: "struggles.json", kept }, JSON.stringify(task));
    assert.deepEqual(attemptAt(attemptKey(task, 3)), { nodeRun: nodeKey(task), rerun: task.rerun ?? 0, attempt: 3 });
  }
  assert.equal(outputFileOwner("nodes/A-fix/0/rerun-0/attempt-1/out/report/deep/struggles.json"), null);
  const ran = [
    { rerun: 0, attempt: 1 },
    { rerun: 0, attempt: 2 },
    { rerun: 2, attempt: 1 },
    { rerun: 10, attempt: 1 },
  ];
  assert.deepEqual(attemptBefore(ran, { rerun: 0, attempt: 2 }), { rerun: 0, attempt: 1 });
  assert.deepEqual(attemptBefore(ran, { rerun: 2, attempt: 1 }), { rerun: 0, attempt: 2 });
  assert.deepEqual(attemptBefore(ran, { rerun: 10, attempt: 1 }), { rerun: 2, attempt: 1 }, "by number, not by name");
  assert.equal(attemptBefore(ran, { rerun: 0, attempt: 1 }), null);
});
