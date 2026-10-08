/**
 * Self-tests for lib/gateMarkers.ts — the pure marker/check-line primitives shared by
 * emitMarker.ts (the writer), checkMergeEligibility.ts (the reader), and their
 * own self-tests.
 *
 * A **check line** is a `<name>: PASS|N/A` line inside a gate-CLEAN comment, one per CLOSE move;
 * the run's class rides its own `class:` line and is never a check name.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as gateMarkers from "../lib/gateMarkers.ts";
import {
  CHECK_LINE_RE,
  GATE_CLEAN_MARKER,
  MARKER_CHECK_NAMES,
  buildGateCleanBody,
  parseCheckLines,
  stripFencedBlocks,
  wholeLineHeadingRe,
} from "../lib/gateMarkers.ts";

test("wholeLineHeadingRe: accepts the bare marker line", () => {
  const re = wholeLineHeadingRe(GATE_CLEAN_MARKER);
  assert.ok(re.test(GATE_CLEAN_MARKER));
  assert.ok(re.test(`intro\n${GATE_CLEAN_MARKER}\ntrailer`));
});

test("wholeLineHeadingRe: rejects trailing text on the same line", () => {
  const re = wholeLineHeadingRe(GATE_CLEAN_MARKER);
  assert.ok(!re.test(`${GATE_CLEAN_MARKER} pending re-run`));
  assert.ok(!re.test(`${GATE_CLEAN_MARKER}UP notes`));
});

test("wholeLineHeadingRe: rejects a mid-prose mention", () => {
  const re = wholeLineHeadingRe(GATE_CLEAN_MARKER);
  assert.ok(!re.test(`before I post ${GATE_CLEAN_MARKER} let me check`));
});

// ── parseCheckLines ──────────────────────────────────────────────────────────────────────────

test("parseCheckLines: parses PASS and N/A per check, over all six real names", () => {
  assert.deepEqual([...MARKER_CHECK_NAMES], ["freshen", "wave", "fix", "confirm", "hand-test", "verifier"]);
  const body =
    "freshen: PASS\nwave: PASS\nfix: PASS\nconfirm: PASS\nhand-test: N/A\nverifier: PASS";
  const parsed = parseCheckLines(body);
  assert.deepEqual(parsed.freshen, ["PASS"]);
  assert.deepEqual(parsed.wave, ["PASS"]);
  assert.deepEqual(parsed.fix, ["PASS"]);
  assert.deepEqual(parsed.confirm, ["PASS"]);
  assert.deepEqual(parsed["hand-test"], ["N/A"]);
  assert.deepEqual(parsed.verifier, ["PASS"]);
});

test("parseCheckLines: distinguishes a MISSING check (no line at all) from an explicit N/A", () => {
  // The whole reason parseCheckLines returns arrays rather than booleans: a required-check
  // reader (mergeEligibility) must tell "never ran" apart from "ran and was N/A" — both are
  // ineligible, but only one names a check that was declared at all.
  const parsed = parseCheckLines("verifier: PASS\nhand-test: N/A");
  assert.deepEqual(parsed["hand-test"], ["N/A"]); // present, explicitly N/A
  assert.deepEqual(parsed.freshen, []); // absent entirely — never declared
  assert.deepEqual(parsed.wave, []);
});

test("parseCheckLines: trailing text after PASS is not a check line", () => {
  const parsed = parseCheckLines("verifier: PASS please merge");
  assert.deepEqual(parsed.verifier, []);
});

test("parseCheckLines: a mid-prose mention is not a check line", () => {
  const parsed = parseCheckLines("please set verifier: PASS in your reply");
  assert.deepEqual(parsed.verifier, []);
});

test("parseCheckLines: lowercase 'pass' and an unknown value both parse as nothing", () => {
  const parsed = parseCheckLines("verifier: pass\nhand-test: FAIL");
  assert.deepEqual(parsed.verifier, []);
  assert.deepEqual(parsed["hand-test"], []);
});

test("parseCheckLines: an unrecognized check name (not one of the six) is never captured", () => {
  // The retired /close-out names, the old flow's `apply` and `explain` must read as prose, never
  // as a check — a stale marker body pasted into a new PR must not buy a check.
  const parsed = parseCheckLines(
    "prove-claims: PASS\ndiff-review: PASS\npr-confidence: N/A\nui-smoke: PASS\nexplain: PASS\napply: PASS"
  );
  for (const name of MARKER_CHECK_NAMES) assert.deepEqual(parsed[name], []);
  assert.ok(!CHECK_LINE_RE.test("apply: PASS"));
});

test("parseCheckLines: duplicate lines for the same check collect both values, in order", () => {
  const parsed = parseCheckLines("verifier: PASS\nverifier: N/A");
  assert.deepEqual(parsed.verifier, ["PASS", "N/A"]);
});

test("CHECK_LINE_RE: matches exactly the six declared check names", () => {
  for (const name of MARKER_CHECK_NAMES) {
    assert.ok(CHECK_LINE_RE.test(`${name}: PASS`), `expected a match for ${name}: PASS`);
  }
  assert.ok(!CHECK_LINE_RE.test("bogus-check: PASS"));
});

// ── stripFencedBlocks ────────────────────────────────────────────────────────────────────────

test("stripFencedBlocks: drops backtick-fenced content, keeps prose", () => {
  const body = `before\n\`\`\`md\n${GATE_CLEAN_MARKER}\n\`\`\`\nafter`;
  const stripped = stripFencedBlocks(body);
  assert.ok(!stripped.includes(GATE_CLEAN_MARKER));
  assert.ok(stripped.includes("before"));
  assert.ok(stripped.includes("after"));
});

test("stripFencedBlocks: an UNCLOSED fence strips to the end (fail-closed)", () => {
  const body = `intro\n\`\`\`\n${GATE_CLEAN_MARKER}\ngated-sha: deadbeef\nprovenance: x`;
  assert.ok(!stripFencedBlocks(body).includes(GATE_CLEAN_MARKER));
});

test("stripFencedBlocks: tilde fences are stripped too", () => {
  const body = `~~~\n${GATE_CLEAN_MARKER}\n~~~`;
  assert.ok(!stripFencedBlocks(body).includes(GATE_CLEAN_MARKER));
});

// ── buildGateCleanBody (C12): every emitted line is what the parsers above expect ───────────

test("buildGateCleanBody: emits the heading, gated-sha, provenance, class, and security lines", () => {
  const body = buildGateCleanBody({
    sha: "a".repeat(40),
    provenance: "builder@abc1234/sonnet/high",
    cls: "R2",
    security: "no match",
  });
  assert.ok(wholeLineHeadingRe(GATE_CLEAN_MARKER).test(body));
  assert.ok(body.includes(`gated-sha: ${"a".repeat(40)}`));
  assert.ok(body.includes("provenance: builder@abc1234/sonnet/high"));
  assert.ok(body.includes("class: R2"));
  assert.ok(!body.includes("rung:"));
  assert.ok(body.includes("security: no match"));
});

test("buildGateCleanBody: with no `checks` given, no check lines are emitted at all", () => {
  const body = buildGateCleanBody({
    sha: "a".repeat(40),
    provenance: "builder@abc1234/sonnet/high",
    cls: "R0",
    security: "no match",
  });
  const parsed = parseCheckLines(body);
  for (const name of MARKER_CHECK_NAMES) assert.deepEqual(parsed[name], []);
});

test("buildGateCleanBody: emits every supplied check line, in MARKER_CHECK_NAMES order regardless of input key order", () => {
  const body = buildGateCleanBody({
    sha: "a".repeat(40),
    provenance: "builder@abc1234/sonnet/high",
    cls: "R2",
    security: "no match",
    // Deliberately reverse-of-declared order in the input object.
    checks: { verifier: "PASS", fix: "N/A", freshen: "PASS" },
  });
  const checkLines = body
    .split("\n")
    .filter((l) => CHECK_LINE_RE.test(l))
    .map((l) => l.split(":")[0]);
  assert.deepEqual(checkLines, ["freshen", "fix", "verifier"]);
  const parsed = parseCheckLines(body);
  assert.deepEqual(parsed.freshen, ["PASS"]);
  assert.deepEqual(parsed.fix, ["N/A"]);
  assert.deepEqual(parsed.verifier, ["PASS"]);
  assert.deepEqual(parsed.wave, []); // never supplied — no line at all
  assert.deepEqual(parsed["hand-test"], []);
});

// ── §1.10: the diff-review markers and their builders are gone ─────────────────────────────

test("the diff-review markers, builders, and section helper are gone", () => {
  for (const name of [
    "DIFF_REVIEW_MARKER",
    "DIFF_REVIEW_FIX_MARKER",
    "DIFF_REVIEW_FIX_HEADING_RE",
    "buildDiffReviewBody",
    "buildDiffReviewFixBody",
    "hasSectionContent",
  ]) {
    assert.ok(!(name in gateMarkers), name);
  }
});
