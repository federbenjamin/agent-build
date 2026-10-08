/**
 * Acceptance fixtures for lib/riskClass.ts — the reader-set floor per class and the
 * pinned/unconfirmed class-line parser. `READER_NAMES` is bonded against this repo's `agents.json`
 * so a reader name can never silently drift from a real spawnable agent. The security `signals`
 * stay in each repo (its `signals` step).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLOW_AGENTS,
  isRiskClass,
  parseClassLine,
  parseWaveLine,
  READER_NAMES,
  retiredClassReason,
  RISK_CLASS_READERS,
  RISK_CLASSES,
  STAGE_READER_NAMES,
} from "../lib/riskClass.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// ── reader sets nest: R0 ⊂ R1 ⊂ R2 ─────────────────────────────────────────────

test("RISK_CLASS_READERS: each class's reader set is a strict superset of the class below it", () => {
  const order: readonly (typeof RISK_CLASSES)[number][] = RISK_CLASSES;
  for (let i = 1; i < order.length; i++) {
    const lower = new Set(RISK_CLASS_READERS[order[i - 1]!]);
    const higher = new Set(RISK_CLASS_READERS[order[i]!]);
    for (const reader of lower) {
      assert.ok(
        higher.has(reader),
        `${order[i]} must retain every reader ${order[i - 1]} has — missing ${reader}`
      );
    }
    assert.ok(
      higher.size > lower.size,
      `${order[i]} must add at least one reader over ${order[i - 1]}`
    );
  }
});

test("RISK_CLASS_READERS: build-verifier is in every class wave", () => {
  for (const cls of RISK_CLASSES) {
    assert.ok(
      RISK_CLASS_READERS[cls].includes("build-verifier"),
      `${cls} must include build-verifier; only the brief's yaml-bound sit-out may omit it from a run`
    );
  }
});

test("RISK_CLASS_READERS: three classes, security-review at R2", () => {
  assert.deepEqual(RISK_CLASSES, ["R0", "R1", "R2"]);
  assert.deepEqual(RISK_CLASS_READERS.R0, ["review-cursory", "build-verifier"]);
  assert.deepEqual(RISK_CLASS_READERS.R1, [
    "review-cursory",
    "gate-silent-failure-hunter",
    "build-verifier",
  ]);
  assert.deepEqual(RISK_CLASS_READERS.R2, [
    "review-cursory",
    "gate-silent-failure-hunter",
    "build-verifier",
    "security-review",
  ]);
});

test("isRiskClass: accepts exactly R0-R2, rejects everything else", () => {
  for (const cls of RISK_CLASSES) assert.equal(isRiskClass(cls), true);
  for (const bad of ["R3", "R4", "r2", "", "R", "R2 "]) assert.equal(isRiskClass(bad), false);
});

// ── READER_NAMES ↔ agents.json (bonded) ────────────────────────────────────────

test("bonded: every READER_NAMES name is a declared agent in agents.json", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "agents.json"), "utf8")) as {
    agents: { name: string }[];
  };
  const declaredNames = new Set(manifest.agents.map((a) => a.name));
  const missing = READER_NAMES.filter((name) => !declaredNames.has(name));
  assert.deepEqual(
    missing,
    [],
    `READER_NAMES names with no matching manifest entry: ${JSON.stringify(missing)}`
  );
});

test("READER_NAMES stays the five wave readers; STAGE_READER_NAMES adds only the paired Codex read", () => {
  assert.deepEqual(READER_NAMES, [
    "review-cursory",
    "gate-silent-failure-hunter",
    "build-verifier",
    "simplifier",
    "security-review",
  ]);
  assert.deepEqual(STAGE_READER_NAMES, [...READER_NAMES, "review-cursory-codex"]);
});

test("FLOW_AGENTS are the builder, fixer, and hand tester, and none is a reader token", () => {
  assert.deepEqual(FLOW_AGENTS, ["builder", "fixer", "hand-tester"]);
  for (const agent of FLOW_AGENTS) {
    assert.equal((STAGE_READER_NAMES as readonly string[]).includes(agent), false, agent);
    assert.throws(() => parseWaveLine(agent), /not a reader name/);
  }
});

test("READER_NAMES covers every class reader plus the diff-selected simplifier", () => {
  const classReaders = new Set(RISK_CLASSES.flatMap((c) => RISK_CLASS_READERS[c]));
  for (const r of classReaders) assert.ok(READER_NAMES.includes(r), `${r} missing`);
  assert.ok(READER_NAMES.includes("simplifier"));
});

// ── parseClassLine ───────────────────────────────────────────────────────────

test("parseClassLine: the pinned operator form", () => {
  const parsed = parseClassLine("class: R2 — operator, 2026-08-29\n\nrest of brief");
  assert.deepEqual(parsed, { cls: "R2", rest: "— operator, 2026-08-29" });
});

test("parseClassLine: the /afk unconfirmed form", () => {
  const parsed = parseClassLine("class: R1 (agent, unconfirmed)\n");
  assert.deepEqual(parsed, { cls: "R1", rest: "(agent, unconfirmed)" });
});

test("parseClassLine: no class line at all → null", () => {
  assert.equal(parseClassLine("just some brief text\nwith no class line\n"), null);
});

test("parseClassLine: an out-of-range class digit is not a valid class line", () => {
  assert.equal(parseClassLine("class: R9 — operator, 2026-08-29\n"), null);
  assert.equal(parseClassLine("class: R3 — operator, 2026-08-29\n"), null);
});

test("retiredClassReason: names the R2 re-pin for an R3 line, and is null otherwise", () => {
  assert.match(retiredClassReason("class: R3 — operator, 2026-09-01\n")!, /re-pin .*class: R2/);
  assert.equal(retiredClassReason("class: R2 — operator, 2026-09-01\n"), null);
  assert.equal(retiredClassReason("no class line"), null);
});

test("parseWaveLine: class readers before the first |, repo readers from a repo: segment, typos throw", () => {
  assert.deepEqual(
    parseWaveLine("review-cursory build-verifier | skipped: simplifier — 40 < 100 | repo: comment-reader"),
    { readers: ["review-cursory", "build-verifier"], repoReaders: ["comment-reader"] }
  );
  assert.deepEqual(parseWaveLine(undefined), { readers: [], repoReaders: [] });
  assert.throws(() => parseWaveLine("comment-reader"), /not a reader name/);
  assert.throws(() => parseWaveLine("review-cursory | repo comment-reader"), /repo-reader segment/);
  assert.throws(() => parseWaveLine("review-cursory | repo: "), /repo-reader segment/);
});
