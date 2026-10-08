import assert from "node:assert/strict";
import { test } from "node:test";

import { Shape } from "../lib/shape.ts";

test("Shape: every guard returns its value without recording an issue when the input has the required shape", () => {
  const shape = new Shape("event");
  const object = { name: "build" };

  assert.equal(shape.obj(object, "root"), object);
  assert.deepEqual(shape.arr(["unit"], "items"), ["unit"]);
  assert.equal(shape.str("run-1", "runid"), "run-1");
  assert.equal(shape.optStr({ note: "needed" }, "note", "root"), "needed");
  assert.equal(shape.optStr({}, "note", "root"), undefined);
  assert.equal(shape.int(0, "pr"), 0);
  assert.equal(shape.bool(true, "ready"), true);
  assert.equal(shape.oneOf("plan", ["plan", "finished"] as const, "event"), "plan");
  assert.deepEqual(shape.strs(["one", "two"], "ids"), ["one", "two"]);
  assert.deepEqual(shape.issues(), []);
});

test("Shape: invalid values return the documented fallbacks and name each failing path", () => {
  const shape = new Shape("event");

  assert.equal(shape.obj([], "root"), null);
  assert.deepEqual(shape.arr("no", "items"), []);
  assert.equal(shape.str(4, "runid"), "");
  assert.equal(shape.optStr({ note: false }, "note", "root"), "");
  assert.equal(shape.int(-1, "pr"), 0);
  assert.equal(shape.bool("yes", "ready"), false);
  assert.equal(shape.oneOf("other", ["plan", "finished"] as const, "event"), "plan");
  assert.deepEqual(shape.strs(["one", 2], "ids"), ["one", ""]);
  shape.bad("manual", "a known value");

  assert.deepEqual(shape.issues().map(({ message }) => message), [
    "event root: expected an object",
    "event items: expected an array",
    "event runid: expected a string",
    "event root.note: expected a string",
    "event pr: expected a non-negative integer",
    "event ready: expected a boolean",
    "event event: expected one of plan | finished",
    "event ids[1]: expected a string",
    "event manual: expected a known value",
  ]);
});

test("Shape: issues returns a snapshot that later validation cannot mutate", () => {
  const shape = new Shape("build event");
  shape.bad("schema", "1");
  const before = shape.issues();

  shape.bad("runid", "a non-empty string");

  assert.deepEqual(before, [{ message: "build event schema: expected 1" }]);
  assert.notEqual(before, shape.issues());
  assert.deepEqual(shape.issues(), [
    { message: "build event schema: expected 1" },
    { message: "build event runid: expected a non-empty string" },
  ]);
});
