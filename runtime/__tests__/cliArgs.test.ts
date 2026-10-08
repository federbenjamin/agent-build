/**
 * Unit tests for the shared strict-argv guard (`scripts/lib/cliArgs.ts`) — the single
 * implementation the CLI entry points across `scripts/` (e.g. `diffReviewArgs.ts`,
 * `reviewLensSelect.ts`) delegate to.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertKnownFlags, takeValue, takeValues } from "../lib/cliArgs.ts";

test("assertKnownFlags: no-op when every flag is known", () => {
  assert.doesNotThrow(() =>
    assertKnownFlags(["--fix", "path.ts"], new Set(["--fix", "--comment"]))
  );
});

test("assertKnownFlags: throws on an unknown flag, names it and the known set", () => {
  assert.throws(
    () => assertKnownFlags(["--fixes"], new Set(["--fix"])),
    /unknown flag\(s\): --fixes — known: --fix/
  );
});

test("assertKnownFlags: accepts a plain array for `known`, not just a Set", () => {
  assert.doesNotThrow(() => assertKnownFlags(["--quiet"], ["--quiet"]));
  assert.throws(() => assertKnownFlags(["--loud"], ["--quiet"]), /unknown flag/);
});

test("assertKnownFlags: non-flag positional tokens are never flagged", () => {
  assert.doesNotThrow(() => assertKnownFlags(["a.ts", "b.ts"], []));
});

test("assertKnownFlags: reports every unknown flag, not just the first", () => {
  assert.throws(() => assertKnownFlags(["--a", "--b", "x.ts"], []), /unknown flag\(s\): --a, --b/);
});

test("takeValue: takes the value after the flag, the first occurrence wins, and refuses a missing or flag-like value", () => {
  assert.deepEqual(takeValue(["--sha", "abc", "x"], "--sha"), { value: "abc", rest: ["x"] });
  assert.equal(takeValue(["--sha", "abc", "--sha", "def"], "--sha").value, "abc");
  assert.deepEqual(takeValue(["--sha", "abc"], "--missing"), { rest: ["--sha", "abc"] });
  assert.throws(() => takeValue(["--sha"], "--sha"), /--sha requires a value, got \(missing\)/);
  assert.throws(() => takeValue(["--sha", "--class"], "--sha"), /--sha requires a value, got --class/);
});

test("takeValues: collects every occurrence in argv order, is empty when absent, and refuses a missing value", () => {
  assert.deepEqual(takeValues(["--check", "verifier=PASS", "x", "--check", "hand-test=N/A"], "--check"), {
    values: ["verifier=PASS", "hand-test=N/A"],
    rest: ["x"],
  });
  assert.deepEqual(takeValues(["x"], "--check"), { values: [], rest: ["x"] });
  assert.throws(() => takeValues(["--check", "a=PASS", "--check"], "--check"), /--check requires a value/);
});
