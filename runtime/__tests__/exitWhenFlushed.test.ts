// Self-tests for scripts/lib/exitWhenFlushed.ts — the exit seam every gate script's `main` takes
// by default. Two contracts live here: it sets an exit code without terminating (the flush fix),
// and the first call latches (the missing-`return` footgun a RETURNING seam introduces).
//
// Driven through `makeExitWhenFlushed` against a fake host rather than the exported singleton:
// mutating the real `process.exitCode` from a test would decide the test runner's own exit code.

import assert from "node:assert/strict";
import { test } from "node:test";
import { exitWhenFlushed, makeExitWhenFlushed } from "../lib/exitWhenFlushed.ts";

type Host = { exitCode?: number | string | null | undefined };

test("the code is recorded on the host rather than terminating the process", () => {
  const host: Host = {};
  const exit = makeExitWhenFlushed(host);
  let reachedNextLine = false;
  exit(1);
  reachedNextLine = true;
  assert.equal(host.exitCode, 1);
  assert.equal(reachedNextLine, true, "exitWhenFlushed must RETURN — the flush fix depends on it");
});

test("a gate that never calls exit leaves the host untouched", () => {
  const host: Host = {};
  makeExitWhenFlushed(host);
  assert.equal(host.exitCode, undefined);
});

test("first call wins — a fall-through exit(0) cannot green-wash a decided failure", () => {
  const host: Host = {};
  const exit = makeExitWhenFlushed(host);
  // The shape a missing `return` produces: the gate fails, keeps running, and reaches a later
  // `exit(runDenoArm(...))`-style call that happens to succeed.
  exit(1);
  exit(0);
  assert.equal(host.exitCode, 1, "a trailing exit(0) must not overwrite the failing code");
});

test("first call wins for a second FAILING code too — no escalation, no downgrade", () => {
  const host: Host = {};
  const exit = makeExitWhenFlushed(host);
  exit(2);
  exit(1);
  assert.equal(host.exitCode, 2);
});

test("a pass recorded first is not overwritten either — matching process.exit", () => {
  const host: Host = {};
  const exit = makeExitWhenFlushed(host);
  exit(0);
  exit(1);
  assert.equal(host.exitCode, 0, "process.exit(0) would already have terminated the process");
});

test("each instance latches independently — the factory carries no shared state", () => {
  const a: Host = {};
  const b: Host = {};
  makeExitWhenFlushed(a)(1);
  makeExitWhenFlushed(b)(3);
  assert.equal(a.exitCode, 1);
  assert.equal(b.exitCode, 3);
});

test("the exported singleton is the one-argument seam every gate's `main` defaults to", () => {
  assert.equal(typeof exitWhenFlushed, "function");
  assert.equal(exitWhenFlushed.length, 1);
});
