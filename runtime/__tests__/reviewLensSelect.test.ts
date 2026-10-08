/**
 * reviewLensSelect.ts: the docs-only-diff predicate (used by `/build`'s CLOSE step to decide whether
 * a wave even fires) and `BEHAVIOR_MD_RES`, which the review table's kind rule reads. The lens
 * catalog and the locator dedupe are gone; the review table (`lib/table.ts`) merges findings now.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as ReviewLensSelect from "../reviewLensSelect.ts";
import { BEHAVIOR_MD_RES, isDocsOnlyDiff } from "../reviewLensSelect.ts";

// ── isDocsOnlyDiff / BEHAVIOR_MD_RES ────────────────────────────────────────────

test("isDocsOnlyDiff: false on any source path; false on empty set", () => {
  assert.equal(isDocsOnlyDiff(["docs/PLAN.md", "packages/core/src/x.ts"]), false);
  assert.equal(isDocsOnlyDiff([]), false);
});

test("isDocsOnlyDiff: true on plain prose-only paths", () => {
  assert.equal(
    isDocsOnlyDiff(["docs/dev/local-dev.md", "README.md", "packages/core/README.md"]),
    true
  );
});

test("behavior-bearing markdown (.agents/**, .claude/**, AGENTS.md, docs/rules/**) is NOT docs-only", () => {
  for (const p of [
    ".agents/agents/big-boy.md",
    ".claude/skills/plan-review/SKILL.md",
    ".codex/agents/foo.md",
    "docs/rules/database.md",
    "AGENTS.md",
  ]) {
    assert.equal(isDocsOnlyDiff([p]), false, `${p} must not be docs-only`);
    assert.equal(
      BEHAVIOR_MD_RES.some((re) => re.test(p)),
      true,
      `${p} must match BEHAVIOR_MD_RES`
    );
  }
});

test("BEHAVIOR_MD_RES: plain prose paths do not match it", () => {
  for (const p of ["docs/dev/local-dev.md", "README.md", "docs/PLAN.md"]) {
    assert.equal(
      BEHAVIOR_MD_RES.some((re) => re.test(p)),
      false,
      `${p} must not match BEHAVIOR_MD_RES`
    );
  }
});

// ── module surface: the deleted names must actually be gone ────────────────────

test("module surface: the lens-catalog names and the locator dedupe are gone", () => {
  const deletedNames = [
    "LENS_CATALOG",
    "selectLenses",
    "runSelect",
    "parseSelectArgv",
    "resolveSelectPaths",
    "runCoverage",
    "checkLensCoverage",
    "checkSecurityForceSelect",
    "tierOf",
    "EXPECTED_TIER_1_SLUGS",
    "TIER_2_SLUGS",
    "FEASIBILITY_LENS_SLUGS",
    "STANDING_DOSSIER_LENSES",
    "CONTRACT_BOUND_SLUGS",
    "dedupByLocator",
  ];
  const keys = Object.keys(ReviewLensSelect);
  const stillPresent = deletedNames.filter((n) => keys.includes(n));
  assert.deepEqual(
    stillPresent,
    [],
    `expected these names removed from reviewLensSelect.ts, still exported: ${JSON.stringify(stillPresent)}`
  );
});

test("module surface: exactly the two kept exports remain", () => {
  assert.deepEqual(Object.keys(ReviewLensSelect).sort(), ["BEHAVIOR_MD_RES", "isDocsOnlyDiff"]);
});
