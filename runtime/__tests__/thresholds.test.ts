/** The thresholds loader: defaults, a repo's TS or JSON override, and a named file that is missing. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bucketFor, bucketRank, DEFAULTS, loadThresholds } from "../thresholds.ts";

function repo(toml?: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "build-thresholds-"));
  if (toml !== undefined) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/build-steps.toml"), toml);
  }
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  return dir;
}

test("no build-steps.toml: every value is the default and says so", async () => {
  const r = await loadThresholds(repo());
  assert.equal(r.found, false);
  assert.deepEqual(r.values, DEFAULTS);
  assert.equal(r.source.WAVE_HUNTER_MIN_LINES, "default");
});

test("a TS module's TOOLING overrides only the keys it sets; unrelated keys are ignored", async () => {
  const dir = repo('thresholds = "tooling.ts"\n', {
    "tooling.ts": "export const TOOLING = { WAVE_CURSORY_SPLIT_LINES: 3, UNRELATED: 1 } as const;\n",
  });
  const r = await loadThresholds(dir);
  assert.equal(r.values.WAVE_CURSORY_SPLIT_LINES, 3);
  assert.equal(r.source.WAVE_CURSORY_SPLIT_LINES, "repo");
  assert.equal(r.values.WAVE_HUNTER_MIN_LINES, DEFAULTS.WAVE_HUNTER_MIN_LINES);
  assert.equal(r.source.WAVE_HUNTER_MIN_LINES, "default");
  assert.equal((r.values as Record<string, unknown>).UNRELATED, undefined);
});

test("a JSON file works the same way", async () => {
  const dir = repo('thresholds = "t.json"\n', { "t.json": '{"WATCH_SILENT_MIN": 40}' });
  assert.equal((await loadThresholds(dir)).values.WATCH_SILENT_MIN, 40);
});

test("DEFAULTS: the watch and table numbers are in; the tier, hand-test budget, and stall numbers are out", () => {
  const values = DEFAULTS as Record<string, unknown>;
  assert.deepEqual(
    {
      WATCH_SILENT_MIN: values.WATCH_SILENT_MIN,
      WATCH_NO_EDIT_MIN: values.WATCH_NO_EDIT_MIN,
      WATCH_SAME_SLICE_READS: values.WATCH_SAME_SLICE_READS,
      WATCH_SAME_REFUSAL: values.WATCH_SAME_REFUSAL,
      WATCH_COMPACTIONS: values.WATCH_COMPACTIONS,
      WATCH_SCAN_MIN: values.WATCH_SCAN_MIN,
      TABLE_MERGE_NEAR_LINES: values.TABLE_MERGE_NEAR_LINES,
      TABLE_MERGE_EXACT_ABOVE_LINES: values.TABLE_MERGE_EXACT_ABOVE_LINES,
    },
    {
      WATCH_SILENT_MIN: 12,
      WATCH_NO_EDIT_MIN: 15,
      WATCH_SAME_SLICE_READS: 5,
      WATCH_SAME_REFUSAL: 4,
      WATCH_COMPACTIONS: 2,
      WATCH_SCAN_MIN: 5,
      TABLE_MERGE_NEAR_LINES: 3,
      TABLE_MERGE_EXACT_ABOVE_LINES: 30,
    }
  );
  for (const gone of [
    "BUILD_TIER_BIG_BOY_ESTIMATED_LINES",
    "BUILD_TIER_BIG_BOY_CHECKLIST_ITEMS",
    "BUILD_TIER_BIG_BOY_SURFACE_SPAN",
    "HAND_TEST_BUDGET_MIN",
    "STALL_MINUTES",
  ]) {
    assert.equal(Object.hasOwn(DEFAULTS, gone), false, `${gone} is retired`);
  }
});

test("DEFAULTS: the part, slice, small-work, batch, off-part, and contract-tunable numbers are in, and the bucket keys name real buckets", () => {
  const values = DEFAULTS as Record<string, unknown>;
  assert.deepEqual(
    {
      PART_MAX_LINES: values.PART_MAX_LINES,
      TEST_SLICE_MAX_FUNCTIONS: values.TEST_SLICE_MAX_FUNCTIONS,
      SMALL_WORK_BELOW_BUCKET: values.SMALL_WORK_BELOW_BUCKET,
      BATCH_SHIP_BUCKET: values.BATCH_SHIP_BUCKET,
      WATCH_OFF_PART_FILES: values.WATCH_OFF_PART_FILES,
      SUBAGENT_MAX: values.SUBAGENT_MAX,
      CODEX_MAX: values.CODEX_MAX,
      CODEX_PAIR_MIN_SIZE: values.CODEX_PAIR_MIN_SIZE,
      CODEX_PAIR_MIN_CLASS: values.CODEX_PAIR_MIN_CLASS,
    },
    {
      PART_MAX_LINES: 2000,
      TEST_SLICE_MAX_FUNCTIONS: 4,
      SMALL_WORK_BELOW_BUCKET: "M",
      BATCH_SHIP_BUCKET: "L",
      WATCH_OFF_PART_FILES: 3,
      SUBAGENT_MAX: 4,
      CODEX_MAX: 4,
      CODEX_PAIR_MIN_SIZE: "M",
      CODEX_PAIR_MIN_CLASS: "R1",
    }
  );
  for (const key of ["SMALL_WORK_BELOW_BUCKET", "BATCH_SHIP_BUCKET", "SIMPLIFIER_TRIGGER_MIN_BUCKET", "CODEX_PAIR_MIN_SIZE"] as const) {
    assert.doesNotThrow(() => bucketRank(DEFAULTS[key], DEFAULTS.PR_SIZE_BUCKETS), `${key} names a PR_SIZE_BUCKETS entry`);
  }
  assert.ok(bucketRank(DEFAULTS.BATCH_SHIP_BUCKET, DEFAULTS.PR_SIZE_BUCKETS) > bucketRank(DEFAULTS.SMALL_WORK_BELOW_BUCKET, DEFAULTS.PR_SIZE_BUCKETS));
});

test("a repo override of a retired name is ignored, so a repo that still sets one runs unharmed", async () => {
  const dir = repo('thresholds = "t.json"\n', { "t.json": '{"STALL_MINUTES": 40, "WAVE_HUNTER_MIN_LINES": 3}' });
  const r = await loadThresholds(dir);
  assert.equal(Object.hasOwn(r.values, "STALL_MINUTES"), false);
  assert.equal(r.values.WAVE_HUNTER_MIN_LINES, 3);
});

test("a named thresholds file that does not exist is an error, never a silent default", async () => {
  await assert.rejects(loadThresholds(repo('thresholds = "nope.ts"\n')), /names nope\.ts, which does not exist/);
});

test("bucketFor picks the highest bucket whose floor the count reaches", () => {
  assert.equal(bucketFor(0, DEFAULTS.PR_SIZE_BUCKETS), "XS");
  assert.equal(bucketFor(99, DEFAULTS.PR_SIZE_BUCKETS), "S");
  assert.equal(bucketFor(100, DEFAULTS.PR_SIZE_BUCKETS), "M");
  assert.equal(bucketFor(9999, DEFAULTS.PR_SIZE_BUCKETS), "XXL");
});
