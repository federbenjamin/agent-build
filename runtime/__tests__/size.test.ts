/** The `size` step's global fallback: what counts, the bucket, and the three verdict lines. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isUncounted, measure, verdicts } from "../size.ts";
import { DEFAULTS } from "../thresholds.ts";

function diffFor(path: string, added: number, removed = 0): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    ...Array.from({ length: added }, (_, i) => `+line ${i}`),
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
  ].join("\n");
}

test("tests, prose docs, and lockfiles never count; behavior markdown does", () => {
  for (const p of ["src/__tests__/a.ts", "a.test.ts", "docs/x.md", "README.md", "pnpm-lock.yaml"])
    assert.equal(isUncounted(p), true, p);
  for (const p of ["src/a.ts", "AGENTS.md", ".claude/skills/x/SKILL.md", "docs/rules/a.md"])
    assert.equal(isUncounted(p), false, p);
});

test("added and removed lines count per top-level dir; the +++/--- headers do not", () => {
  const s = measure([diffFor("src/a.ts", 3, 2), diffFor("docs/a.md", 50), diffFor("x.ts", 1)].join("\n"));
  assert.deepEqual(s, { counted: 6, byDir: { src: 5, ".": 1 } });
});

test("the three verdict lines: bucket, simplifier floor, codex pair by the pair floors", () => {
  const b = DEFAULTS.PR_SIZE_BUCKETS;
  const small = verdicts({ counted: 12, byDir: { src: 12 } }, b, "M", "R0", "M", "R1", true);
  assert.equal(small.size, "[S] 12 counted lines · src 12");
  assert.equal(small.simplifier, "simplifier: sits out (12 < 100)");
  assert.equal(small.pair, "codex pair: skipped (R0, S — needs ≥ R1 and ≥ M)");
  const big = verdicts({ counted: 150, byDir: { src: 150 } }, b, "M", "R1", "M", "R1", true);
  assert.equal(big.simplifier, "simplifier: fires (150 ≥ 100)");
  assert.equal(big.pair, "codex pair: fires (R1, M)");
  assert.equal(verdicts({ counted: 0, byDir: {} }, b, "M", null, "M", "R1", true).pair, "codex pair: undecided — pass --class R<n>");
});
