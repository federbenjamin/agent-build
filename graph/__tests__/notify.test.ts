import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RunError } from "../contracts.ts";
import { blockedNeeds, fireBlockedEvent } from "../notify.ts";

test("the blocked event reaches the consumer without stalling the worker's event loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-notify-"));
  const out = join(dir, "events.jsonl");
  const consumer = join(dir, "slow.mjs");
  writeFileSync(
    consumer,
    'import { appendFileSync } from "node:fs";\nlet s = "";\nprocess.stdin.on("data", (d) => (s += d)).on("end", () => setTimeout(() => appendFileSync(process.argv[2], s), 600));\n'
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const event = { runId: "g-1", repo: dir, events: `${process.execPath} ${consumer} ${out}`, node: "plan", question: "Which greeting?" };
  try {
    assert.deepEqual(await fireBlockedEvent(event), []);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 10, `the event loop ran ${ticks} ticks while the consumer worked`);
  const sent = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  assert.equal(sent.event, "blocked");
  assert.equal(sent.runid, "g-1");
  assert.equal(sent.needs, blockedNeeds(event));
  rmSync(dir, { recursive: true });
});

test("an event the emitter refuses is a RunError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-notify-"));
  await assert.rejects(fireBlockedEvent({ runId: "has space", repo: dir, events: `${process.execPath} -e 0`, node: "plan", question: "q" }), (e: unknown) => {
    assert.ok(e instanceof RunError);
    assert.match(e.message, /blocked event refused/);
    return true;
  });
  rmSync(dir, { recursive: true });
});

test("a blank consumer line is no consumer: the emitter is never spawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-notify-"));
  // A spawned emitter refuses this runid, so `[]` rather than a RunError shows it never ran.
  try {
    for (const events of ["", "  ", "\t\n"]) {
      assert.deepEqual(await fireBlockedEvent({ runId: "has space", repo: dir, events, node: "plan", question: "q" }), [], JSON.stringify(events));
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a run that carries no consumer fires nothing, whatever the worker's BUILD_EVENT_CMD", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-notify-"));
  const out = join(dir, "events.jsonl");
  const saved = process.env.BUILD_EVENT_CMD;
  process.env.BUILD_EVENT_CMD = `${process.execPath} -e require("node:fs").writeFileSync(${JSON.stringify(out)},"x")`;
  try {
    assert.deepEqual(await fireBlockedEvent({ runId: "g-2", repo: dir, node: "plan", question: "q" }), []);
  } finally {
    if (saved === undefined) delete process.env.BUILD_EVENT_CMD;
    else process.env.BUILD_EVENT_CMD = saved;
  }
  assert.equal(existsSync(out), false, "the worker's consumer never ran");
  rmSync(dir, { recursive: true });
});
