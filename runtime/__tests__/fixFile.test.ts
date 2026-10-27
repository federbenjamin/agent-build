/**
 * The fix file's grammar (lib/fixFile.ts): its parser, the all-`blocked` writer, and the join of a
 * round's slice fix files.
 */

import "./helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import * as fixFile from "../lib/fixFile.ts";
import { blockedFixFile, joinFixFiles, parseFixFile } from "../lib/fixFile.ts";
import * as runFiles from "../lib/runFiles.ts";
import { refuses } from "./helpers/refuses.ts";

test("the fix file's grammar has one home: fixFile.ts exports it and runFiles.ts exports none of it", () => {
  const moved = ["DECISION_WHICH", "EXIT_CHECKS", "parseFixFile", "joinFixFiles", "blockedFixFile"];
  assert.deepEqual(moved.filter((name) => !(name in fixFile)), []);
  assert.deepEqual(moved.filter((name) => name in runFiles), []);
});

const EXIT = [
  "exit checks:",
  "vacuity: CURSORY.3 — node --test … → vacuity input fails, invariant holds",
  "mutation: pnpm exec tsx scripts/mutationProof.ts map.json → 3/3 BINDING",
  "branches: send.ts:44 (4xx) → send.test.ts \"stops on 401\"",
  "shared function: none",
];

const FIX_EXAMPLE = [
  "CURSORY.3 · fixed · 4f1c2a9 — 4xx ends the loop; test send.test.ts \"stops on 401\"",
  "HUNTER.2 · fixed · 4f1c2a9 · kind=security — the swallowed 409 now maps to the taxonomy",
  "SIMP.2 · dropped — chat.ts:30 already delegates to formatDraft; no second copy",
  "CODEX.4 · relabel structure→text — the finding is the comment on line 12, not the shape",
  "VERIFIER.1 · decision — brief — deliverable 4 names a file the design moved; brief must change",
  "HAND.2 · fixed · 7a0b3c1 — the empty reply now renders the retry row",
  ...EXIT,
].join("\n");
const FIX_ROWS = ["CURSORY.3", "HUNTER.2", "SIMP.2", "CODEX.4", "VERIFIER.1", "HAND.2"];

test("blockedFixFile: every row blocked with one reason, one exit-checks block, grammar checked", () => {
  const text = blockedFixFile(["R.1", "R.2"], "why", "no fixer ran");
  assert.equal(
    text,
    "R.1 · blocked — why\nR.2 · blocked — why\n\nexit checks:\nvacuity: none — no fixer ran\nmutation: none — no fixer ran\nbranches: none — no fixer ran\nshared function: none — no fixer ran\n"
  );
  const f = parseFixFile(text, { rows: ["R.1", "R.2"] });
  assert.deepEqual(f.lines.map((l) => (l.action === "blocked" ? l.reason : l.action)), ["why", "why"]);
  refuses(() => blockedFixFile(["R.1"], "", "x"), /not a fix line/);
  refuses(() => blockedFixFile(["R.1"], "a\nb", "x"), /not a fix line/);
});

test("blockedFixFile with the fixer's own text: fixed lines blocked, the rest kept as written, rows order", () => {
  const rows = ["R.1", "R.2", "R.3", "R.4"];
  const written = [
    "R.1 · fixed · abc1234 — one",
    "R.2 · dropped — two",
    "R.3 · decision — product — three?",
    "R.4 · fixed · abc1234 · kind=security — four",
    ...EXIT,
  ].join("\n");
  assert.equal(
    blockedFixFile(rows, "why", "did not merge", written),
    [
      "R.1 · blocked — why",
      "R.2 · dropped — two",
      "R.3 · decision — product — three?",
      "R.4 · blocked — why",
      "",
      "exit checks:",
      ...["vacuity", "mutation", "branches", "shared function"].map((c) => `${c}: none — did not merge`),
      "",
    ].join("\n")
  );
  refuses(() => blockedFixFile(["R.1"], "why", "x", written), /not a row of this round's table/);
});

test("parseFixFile: the spec's example parses, one line of each form", () => {
  const f = parseFixFile(FIX_EXAMPLE, { rows: FIX_ROWS, round: "2" });
  assert.deepEqual(f.lines.map((l) => [l.row, l.action]), FIX_ROWS.map((r, i) => [r, ["fixed", "fixed", "dropped", "relabel", "decision", "fixed"][i]]));
  assert.deepEqual(f.lines[0], { row: "CURSORY.3", line: 1, action: "fixed", sha: "4f1c2a9", what: "4xx ends the loop; test send.test.ts \"stops on 401\"" });
  assert.deepEqual(f.lines[1], { row: "HUNTER.2", line: 2, action: "fixed", sha: "4f1c2a9", kind: "security", what: "the swallowed 409 now maps to the taxonomy" });
  assert.deepEqual(f.lines[2], { row: "SIMP.2", line: 3, action: "dropped", reason: "chat.ts:30 already delegates to formatDraft; no second copy" });
  assert.deepEqual(f.lines[3], { row: "CODEX.4", line: 4, action: "relabel", from: "structure", to: "text", reason: "the finding is the comment on line 12, not the shape" });
  assert.deepEqual(f.lines[4], { row: "VERIFIER.1", line: 5, action: "decision", which: "brief", question: "deliverable 4 names a file the design moved; brief must change" });
  assert.equal(f.exitChecks["shared function"], "none");
  assert.equal(f.exitChecks.branches, "send.ts:44 (4xx) → send.test.ts \"stops on 401\"");
});

test("TEXT-CURSORY.11: parseFixFile reads `<ROW> · blocked — <evidence>`, the line for a row the fixer could not fix", () => {
  const f = parseFixFile(`CURSORY.3 · blocked — three fixes failed tsc on send.ts:40\nexit checks:\nvacuity: none\nmutation: none\nbranches: none\nshared function: none\n`, {
    rows: ["CURSORY.3"],
    round: "2",
  });
  assert.deepEqual(f.lines[0], { row: "CURSORY.3", line: 1, action: "blocked", reason: "three fixes failed tsc on send.ts:40" });
  refuses(() => parseFixFile("CURSORY.3 · blocked\nexit checks:\n"), /not a fix line/);
});

test("parseFixFile: a fix file without `branches:` is refused", () => {
  const text = FIX_EXAMPLE.split("\n").filter((l) => !l.startsWith("branches:")).join("\n");
  refuses(() => parseFixFile(text), /missing exit check `branches:`/);
});

test("parseFixFile: no `exit checks:` block is refused", () => {
  refuses(() => parseFixFile(FIX_EXAMPLE.split("\nexit checks:")[0]!), /missing `exit checks:` and its four lines/);
});

test("parseFixFile: a `fixed` line with no sha is refused", () => {
  refuses(() => parseFixFile(["CURSORY.3 · fixed — stops on 4xx", ...EXIT].join("\n")), /line 1: CURSORY\.3: a `fixed` line .* the sha is missing/);
});

test("parseFixFile: an unknown decision kind is refused", () => {
  refuses(() => parseFixFile(["VERIFIER.1 · decision — taste — which name?", ...EXIT].join("\n")), /decision `taste` is not one of brief \| public-surface/);
});

test("parseFixFile: a row missing and a row not in the table are refused", () => {
  refuses(() => parseFixFile(FIX_EXAMPLE, { rows: [...FIX_ROWS, "SEC.1"] }), /SEC\.1: row has no line/);
  refuses(() => parseFixFile(FIX_EXAMPLE, { rows: FIX_ROWS.slice(1) }), /line 1: CURSORY\.3: not a row of this round's table/);
});

test("parseFixFile: a relabel to a kind the round still fixes is refused; that is `fixed · kind=`", () => {
  refuses(() => parseFixFile(["CODEX.4 · relabel text→behavior — it is logic", ...EXIT].join("\n"), { round: "2" }), /round 2 fixes `behavior`; fix the row and write `fixed · <sha> · kind=behavior`/);
  assert.equal(parseFixFile(["CODEX.4 · relabel structure→text — prose", ...EXIT].join("\n"), { round: "2" }).lines[0]!.action, "relabel");
});

test("parseFixFile: a stray line and an unknown kind= are refused", () => {
  refuses(() => parseFixFile(["I fixed things", ...EXIT].join("\n")), /line 1: not a fix line/);
  refuses(() => parseFixFile(["CODEX.4 · fixed · 4f1c2a9 · kind=perf — x", ...EXIT].join("\n")), /`kind=perf` is not one of/);
});

// ── Joining a round's slice fix files ─────────────────────────────────────────────────────────

const sliceFix = (lines: string[], tag: string) =>
  `${[...lines, "exit checks:", `vacuity: none — ${tag}`, `mutation: map.json → 1/1 BINDING (${tag})`, "branches: none", `shared function: none — ${tag}`].join("\n")}\n`;

test("joinFixFiles: the slices' row lines in table order and one exit checks block naming each slice's result; the joined file parses against the whole round", () => {
  const s1 = sliceFix(["HUNTER.2 · fixed · 4f1c2a9 — guard", "CURSORY.3 · dropped — not true at send.ts:40"], "S1");
  const s2 = sliceFix(["SIMP.1 · relabel structure→text — a comment"], "S2");
  const rows = ["CURSORY.3", "SIMP.1", "HUNTER.2"];
  const joined = joinFixFiles([{ slice: "S1", rows: ["HUNTER.2", "CURSORY.3"], text: s1 }, { slice: "S2", rows: ["SIMP.1"], text: s2 }], rows, "3");
  assert.deepEqual(joined.split("\n").slice(0, 4), ["CURSORY.3 · dropped — not true at send.ts:40", "SIMP.1 · relabel structure→text — a comment", "HUNTER.2 · fixed · 4f1c2a9 — guard", "exit checks:"]);
  const f = parseFixFile(joined, { rows, round: "3" });
  assert.equal(f.exitChecks.mutation, "S1 — map.json → 1/1 BINDING (S1); S2 — map.json → 1/1 BINDING (S2)");
  assert.equal(f.exitChecks.branches, "S1 — none; S2 — none");
});

test("joinFixFiles: one slice's file is the round's file as it is; a slice file with another slice's row, or a round row no slice wrote, is refused", () => {
  const one = sliceFix(["HUNTER.2 · fixed · 4f1c2a9 — guard"], "S1");
  assert.equal(joinFixFiles([{ slice: "S1", rows: ["HUNTER.2"], text: one }], ["HUNTER.2"]), one);
  refuses(() => joinFixFiles([{ slice: "S1", rows: ["HUNTER.2"], text: one }, { slice: "S2", rows: ["SIMP.1"], text: sliceFix(["HUNTER.2 · dropped — x"], "S2") }], ["HUNTER.2", "SIMP.1"]), /HUNTER\.2: not a row of this round's table/);
  refuses(() => joinFixFiles([{ slice: "S1", rows: ["HUNTER.2"], text: one }, { slice: "S2", rows: ["SIMP.1"], text: sliceFix(["SIMP.1 · dropped — x"], "S2") }], ["HUNTER.2", "SIMP.1", "CODEX.1"]), /CODEX\.1: row has no line/);
});

test("blockedFixFile and joinFixFiles keep a CRLF file's lines as the parser read them, with no carriage return", () => {
  const crlf = (lines: string[]) => lines.join("\r\n");
  const written = crlf(["R.1 · fixed · abc1234 — one", "R.2 · dropped — two", ...EXIT]);
  assert.deepEqual(blockedFixFile(["R.1", "R.2"], "why", "x", written).split("\n").slice(0, 2), ["R.1 · blocked — why", "R.2 · dropped — two"]);
  const joined = joinFixFiles([{ slice: "S1", rows: ["R.1"], text: crlf(["R.1 · dropped — one", ...EXIT]) }, { slice: "S2", rows: ["R.2"], text: crlf(["R.2 · decision — product — two?", ...EXIT]) }], ["R.1", "R.2"]);
  assert.deepEqual(joined.split("\n").slice(0, 2), ["R.1 · dropped — one", "R.2 · decision — product — two?"]);
  assert.doesNotMatch(joined, /\r/);
});
