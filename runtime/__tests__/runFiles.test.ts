/**
 * The run dir's file grammars (lib/runFiles.ts): the finding block and its locator, session.md, the
 * stage file, the fix file, the hand-test file, and table.json.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  driftGroupOf,
  isFixedAt,
  isRoundId,
  KIND_RANK,
  KINDS,
  normaliseKind,
  normaliseLocator,
  parseFindingBlock,
  parseFixFile,
  parseHandTestFile,
  parseReaderFile,
  parseSessionFile,
  parseStageFile,
  parseStageKey,
  parseTableJson,
  parseVerdict,
  RunFileError,
  serialiseTableJson,
  splitFindingId,
  stageIdRange,
  STAGES_FIXING,
  type TableJson,
} from "../lib/runFiles.ts";

function block(id: string, fields: Record<string, string>, title = "a title"): string {
  return [`### ${id} — ${title}`, ...Object.entries(fields).map(([k, v]) => `- ${k}: ${v}`)].join("\n");
}

const BASE = {
  locator: "apps/mobile/src/chat/send.ts:40-45",
  kind: "behavior",
  finding: "a 401 retries forever; trigger: sign out, then send.",
  after: "a 4xx ends the loop after one try.",
};

/** Assert `fn` throws a RunFileError whose message matches `re`. */
function refuses(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof RunFileError, `expected RunFileError, got ${String(e)}`);
    assert.match(e.message, re);
    return true;
  });
}

// ── Finding block ───────────────────────────────────────────────────────────────────────────

test("parseFindingBlock: the spec's example parses with every field", () => {
  const text = block("CURSORY.3", {
    ...BASE,
    invariant: "sendMessage returns within one retry on any 4xx",
    vacuity: "a test that mocks only 500s still passes",
  }, "the retry loop never stops on a 4xx");
  const [f] = parseFindingBlock(text);
  assert.deepEqual(f, {
    id: "CURSORY.3",
    title: "the retry loop never stops on a 4xx",
    line: 1,
    locator: BASE.locator,
    locators: [{ path: "apps/mobile/src/chat/send.ts", start: 40, end: 45, parsed: true }],
    kind: "behavior",
    finding: BASE.finding,
    after: BASE.after,
    invariant: "sendMessage returns within one retry on any 4xx",
    vacuity: "a test that mocks only 500s still passes",
  });
});

const KIND_ALIASES: [string, string][] = [
  ["behaviour", "behavior"],
  ["Behavior", "behavior"],
  ["BEHAVIOUR — the loop", "behavior"],
  ["dev tool", "dev-tool"],
  ["dev_tool", "dev-tool"],
  ["test app", "test-app"],
  ["test tool", "test-tool"],
  ["`security`", "security"],
  ["structure, a second copy", "structure"],
  ["text", "text"],
];
for (const [raw, want] of KIND_ALIASES) {
  test(`parseFindingBlock: kind \`${raw}\` normalises to ${want}`, () => {
    const [f] = parseFindingBlock(block("CURSORY.1", { ...BASE, kind: raw }));
    assert.equal(f!.kind, want);
  });
}

test("parseFindingBlock: an unknown kind is refused naming the block and the value", () => {
  refuses(() => parseFindingBlock(block("CURSORY.1", { ...BASE, kind: "perf" })), /line 1: finding CURSORY\.1: `kind` must be one of .* got `perf`/);
});

test("parseFindingBlock: `missing` on a CURSORY id is refused; on VERIFIER and a VERIFIER slice it parses", () => {
  refuses(() => parseFindingBlock(block("CURSORY.1", { ...BASE, kind: "missing" })), /CURSORY\.1: `kind: missing` is legal only on a VERIFIER id/);
  assert.equal(parseFindingBlock(block("VERIFIER.1", { ...BASE, kind: "missing" }))[0]!.kind, "missing");
  assert.equal(parseFindingBlock(block("VERIFIER-2.1", { ...BASE, kind: "missing" }))[0]!.kind, "missing");
});

test("parseFindingBlock: `fix:` with no `after:` is read as `after:`; `after:` wins when both are there", () => {
  const { after: _a, ...noAfter } = BASE;
  assert.equal(parseFindingBlock(block("CURSORY.1", { ...noAfter, fix: "stop on 4xx" }))[0]!.after, "stop on 4xx");
  assert.equal(parseFindingBlock(block("CURSORY.1", { ...BASE, fix: "old patch" }))[0]!.after, BASE.after);
});

test("parseFindingBlock: the old fields (tier, relevance, surface, fires, ease) and unknown ones are ignored", () => {
  const text = block("CODEX.1", { ...BASE, surface: "R9", fires: "never", ease: "hard", tier: "BLOCK", relevance: "independent", whatever: "x" });
  const [f] = parseFindingBlock(text);
  assert.equal(f!.kind, "behavior");
  assert.equal(Object.keys(f!).includes("tier"), false);
});

for (const field of ["locator", "kind", "finding", "after"] as const) {
  test(`parseFindingBlock: a block missing \`${field}\` is refused naming the block and the field`, () => {
    const fields: Record<string, string> = { ...BASE };
    delete fields[field];
    refuses(() => parseFindingBlock(block("HUNTER.2", fields)), new RegExp(`finding HUNTER\\.2: missing \`${field}\``));
  });
}

test("parseFindingBlock: every bad block is named, not just the first", () => {
  const text = [block("A.1", { ...BASE, kind: "nope" }), block("B.2", { locator: "x.ts:1", kind: "text", finding: "f" })].join("\n\n");
  refuses(() => parseFindingBlock(text), /line 1: finding A\.1: .*\nline 7: finding B\.2: missing `after`/);
});

test("parseFindingBlock: a line of two or more spaces after a field line is appended to that field", () => {
  const text = [
    "### VERIFIER.1 — wrapped",
    "- locator: a.ts:1",
    "- kind: behavior",
    "- finding: first half",
    "  second half",
    "    third",
    "- after: fixed",
    "",
    "  not appended: a blank line ended the field",
  ].join("\n");
  const [f] = parseFindingBlock(text);
  assert.equal(f!.finding, "first half second half third");
  assert.equal(f!.after, "fixed");
});

test("parseFindingBlock: a non-finding heading ends the block, so its bullets are not fields", () => {
  const text = [
    "### CURSORY.1 — t",
    "- locator: a.ts:1",
    "- kind: text",
    "- finding: f",
    "## What else was checked",
    "- after: this is a cleared note, not the block's field",
  ].join("\n");
  refuses(() => parseFindingBlock(text), /CURSORY\.1: missing `after`/);
});

test("parseFindingBlock: a head with a hyphen for the dash parses; a head with no title is refused", () => {
  const hyphen = block("CURSORY.1", BASE).replace(" — ", " - ");
  assert.equal(parseFindingBlock(hyphen)[0]!.title, "a title");
  refuses(() => parseFindingBlock(`### CURSORY.2\n- locator: a.ts:1`), /line 1: head must be `### <ID> — <title>`/);
});

test("parseFindingBlock: an id used twice in one file is refused", () => {
  const text = [block("CODEX.1", BASE), block("CODEX.1", BASE)].join("\n\n");
  refuses(() => parseFindingBlock(text), /line 7: finding CODEX\.1: id used twice/);
});

test("parseFindingBlock: with a stage, an id outside its range is refused; a split prefix is in range", () => {
  refuses(() => parseFindingBlock(block("CODEX.101", BASE), { stage: "wave" }), /CODEX\.101: id number 101 is outside stage wave's range 0–99/);
  assert.equal(parseFindingBlock(block("CODEX.101", BASE), { stage: "confirm-1" }).length, 1);
  assert.equal(parseFindingBlock(block("CURSORY-2.3", BASE), { stage: "wave" }).length, 1);
  refuses(() => parseFindingBlock(block("CODEX.99", BASE), { stage: "drift-confirm" }), /range 600–699/);
});

test("stageIdRange and splitFindingId: 100 × index; a slice prefix maps to its reader", () => {
  assert.deepEqual(stageIdRange("wave"), { min: 0, max: 99 });
  assert.deepEqual(stageIdRange("last"), { min: 300, max: 399 });
  assert.deepEqual(stageIdRange("drift-confirm"), { min: 600, max: 699 });
  assert.deepEqual(splitFindingId("CURSORY-2.3"), { prefix: "CURSORY-2", readerPrefix: "CURSORY", slice: 2, number: 3 });
  assert.deepEqual(splitFindingId("CODEX.101"), { prefix: "CODEX", readerPrefix: "CODEX", number: 101 });
});

test("normaliseKind: returns the token it could not read", () => {
  assert.deepEqual(normaliseKind("Perf, slow"), { token: "perf" });
});

test("KIND_RANK: security > missing > behavior > structure = test-app > test-tool = dev-tool = text", () => {
  const r = KIND_RANK;
  assert.ok(r.security > r.missing && r.missing > r.behavior && r.behavior > r.structure);
  assert.equal(r.structure, r["test-app"]);
  assert.ok(r["test-app"] > r["test-tool"]);
  assert.equal(r["test-tool"], r["dev-tool"]);
  assert.equal(r["dev-tool"], r.text);
  assert.deepEqual(Object.keys(r).sort(), [...KINDS].sort());
});

test("STAGES_FIXING: round 1 fixes all; round 2 adds structure and test-app to the urgent three; 3, escalate, drift the urgent three", () => {
  assert.deepEqual([...STAGES_FIXING["1"]].sort(), [...KINDS].sort());
  assert.deepEqual([...STAGES_FIXING["2"]].sort(), ["behavior", "missing", "security", "structure", "test-app"]);
  for (const r of ["3", "escalate", "drift"] as const) {
    assert.deepEqual([...STAGES_FIXING[r]].sort(), ["behavior", "missing", "security"]);
  }
  assert.equal(isFixedAt("text", "2"), false);
  assert.equal(isFixedAt("test-app", "3"), false);
});

// ── Locator ─────────────────────────────────────────────────────────────────────────────────

const LOCATOR_TABLE: [string, [string, number, number, boolean][]][] = [
  ["a.ts:42", [["a.ts", 42, 42, true]]],
  ["`a.ts:40-45`", [["a.ts", 40, 45, true]]],
  ["a.ts:131-155, :157-173", [["a.ts", 131, 155, true], ["a.ts", 157, 173, true]]],
  ["x.ts:250-278 (vs y.ts:158-183)", [["x.ts", 250, 278, true], ["y.ts", 158, 183, true]]],
  ["apps/x/y.ts", [["apps/x/y.ts", 0, 0, true]]],
  ["the send loop", [["the send loop", 0, 0, false]]],
  // Measured in B2b: three backticked pieces, the last a bare range on the second path.
  [
    "`apps/r.ts:2389-2397`, `apps/m.ts:97-112`, `:490-498`",
    [["apps/r.ts", 2389, 2397, true], ["apps/m.ts", 97, 112, true], ["apps/m.ts", 490, 498, true]],
  ],
  ["a.ts:42:7", [["a.ts", 42, 42, true]]],
  ["a.ts:45–40", [["a.ts", 40, 45, true]]],
];
for (const [raw, want] of LOCATOR_TABLE) {
  test(`normaliseLocator: ${raw}`, () => {
    assert.deepEqual(
      normaliseLocator(raw),
      want.map(([path, start, end, parsed]) => ({ path, start, end, parsed }))
    );
  });
}

// ── Reader file ─────────────────────────────────────────────────────────────────────────────

test("parseReaderFile: NO FINDINGS is clean; no blocks and no NO FINDINGS is refused", () => {
  assert.deepEqual(parseReaderFile("NO FINDINGS — checked retries and auth\n").findings, []);
  refuses(() => parseReaderFile("I looked and it seems fine."), /no `### <ID> — <title>` blocks and no line starting `NO FINDINGS`/);
  refuses(() => parseReaderFile("the reader said no findings mid-sentence"), /NO FINDINGS/);
});

test("parseReaderFile: prose-drift lines come back as advice; the wave range applies by default", () => {
  const text = [
    block("CURSORY.1", BASE),
    "",
    "## Prose drift (advisory)",
    "- docs/x.md:12 · says the loop retries 3 times · it retries once",
    "",
    "## Other categories checked",
    "- this is not advice",
  ].join("\n");
  const { findings, advice } = parseReaderFile(text);
  assert.equal(findings.length, 1);
  assert.deepEqual(advice, [{ locator: "docs/x.md:12", text: "says the loop retries 3 times · it retries once" }]);
  refuses(() => parseReaderFile(block("CURSORY.101", BASE)), /outside stage wave's range/);
});

// ── session.md ──────────────────────────────────────────────────────────────────────────────

test("parseSessionFile: the spec's example parses with its stage", () => {
  const text = block("SESSION.1", { locator: "packages/core/src/queue/pending.ts:88", kind: "behavior", stage: "wave", finding: "f", after: "a" });
  const [f] = parseSessionFile(text);
  assert.equal(f!.stage, "wave");
  assert.equal(f!.kind, "behavior");
});

test("parseSessionFile: every stage is legal, drift-confirm included (R.2)", () => {
  for (const stage of ["wave", "confirm-1", "confirm-2", "last", "escalate", "drift", "drift-confirm"]) {
    assert.equal(parseSessionFile(block("SESSION.1", { ...BASE, stage }))[0]!.stage, stage);
  }
});

test("parseSessionFile: a missing or unknown stage, a non-SESSION id, and a repeated id are refused", () => {
  refuses(() => parseSessionFile(block("SESSION.1", BASE)), /SESSION\.1: missing `stage`/);
  refuses(() => parseSessionFile(block("SESSION.1", { ...BASE, stage: "final" })), /`stage` must be one of .* got `final`/);
  refuses(() => parseSessionFile(block("CURSORY.1", { ...BASE, stage: "wave" })), /CURSORY\.1: a session\.md id is `SESSION\.<n>`/);
  const twice = [block("SESSION.1", { ...BASE, stage: "wave" }), block("SESSION.1", { ...BASE, stage: "last" })].join("\n\n");
  refuses(() => parseSessionFile(twice), /SESSION\.1: id used twice/);
  assert.deepEqual(parseSessionFile(""), []);
});

// ── Stage file ──────────────────────────────────────────────────────────────────────────────

function stageFile(status: string[], news: string): string {
  return ["## Status", ...status, "", "## New", news].join("\n");
}

const GIVEN = [
  { id: "CURSORY.3", line: "fixed" as const },
  { id: "HUNTER.2", line: "fixed" as const },
  { id: "CODEX.4", line: "relabel" as const },
  { id: "SIMP.2", also: ["CODEX.7"], line: "dropped" as const },
];

test("parseStageFile: the spec's example parses; `## New` ids are in the stage's range", () => {
  const text = stageFile(
    [
      "- CURSORY.3 · resolved",
      "- HUNTER.2 · unresolved — the catch still swallows the 409; send.ts:61",
      "- CODEX.4 · agree",
      "- SIMP.2 · disagree — the copy at chat.ts:30 is still a second implementation",
    ],
    block("CODEX.101", { ...BASE, locator: "apps/mobile/src/chat/send.ts:52" })
  );
  const s = parseStageFile(text, { stage: "confirm-1", given: GIVEN });
  assert.deepEqual(s.status.map((x) => [x.row, x.status, x.reason ?? null]), [
    ["CURSORY.3", "resolved", null],
    ["HUNTER.2", "unresolved", "the catch still swallows the 409; send.ts:61"],
    ["CODEX.4", "agree", null],
    ["SIMP.2", "disagree", "the copy at chat.ts:30 is still a second implementation"],
  ]);
  assert.equal(s.findings[0]!.id, "CODEX.101");
  assert.equal(s.findings[0]!.line, 8);
  refuses(() => parseStageFile(text, { stage: "confirm-2", given: GIVEN }), /line 8: finding CODEX\.101: id number 101 is outside stage confirm-2's range 200–299/);
});

test("parseStageFile: a row given and missing from `## Status` is refused", () => {
  const text = stageFile(["- CURSORY.3 · resolved", "- CODEX.4 · agree", "- SIMP.2 · agree"], "NO FINDINGS — nothing new");
  refuses(() => parseStageFile(text, { stage: "confirm-1", given: GIVEN }), /HUNTER\.2: row given and missing from `## Status`/);
});

const STATUS_ALIASES: [string, string, string][] = [
  ["resolved", "resolved", "fixed"],
  ["Resolved ✓", "resolved", "fixed"],
  ["fixed", "resolved", "fixed"],
  ["fixed differently — typed ports replace both matchers", "resolved", "fixed"],
  ["closed", "resolved", "fixed"],
  ["holds", "resolved", "fixed"],
  ["confirmed", "resolved", "fixed"],
  ["open — still retries", "unresolved", "fixed"],
  ["not fixed — still retries", "unresolved", "fixed"],
  ["still open — still retries", "unresolved", "fixed"],
  ["UNRESOLVED — still retries", "unresolved", "fixed"],
  ["agreed", "agree", "dropped"],
  ["disagreed — it is a real copy", "disagree", "dropped"],
];
for (const [word, want, line] of STATUS_ALIASES) {
  test(`parseStageFile: status \`${word}\` reads as ${want}`, () => {
    const text = stageFile([`- CURSORY.3 · ${word}`], "NO FINDINGS");
    const s = parseStageFile(text, { stage: "confirm-1", given: [{ id: "CURSORY.3", line: line as "fixed" | "dropped" }] });
    assert.equal(s.status[0]!.status, want);
  });
}

for (const sep of ["·", "—", "-", ":", "|"]) {
  test(`parseStageFile: separator \`${sep}\` between id and word`, () => {
    const s = parseStageFile(stageFile([`- CURSORY.3 ${sep} resolved`], "NO FINDINGS"), { stage: "confirm-1" });
    assert.equal(s.status[0]!.status, "resolved");
  });
}

test("parseStageFile: a parenthetical gloss after the id is skipped (B2b's confirm files wrote one)", () => {
  const text = stageFile(["- VERIFIER.1 (duplicate `...X` spread, `reads/profile.ts:48`) · resolved ✓ — one spread left"], "NO FINDINGS");
  const s = parseStageFile(text, { stage: "confirm-1", given: [{ id: "VERIFIER.1", line: "fixed" }] });
  assert.deepEqual(s.status.map((x) => [x.row, x.status, x.reason]), [["VERIFIER.1", "resolved", "one spread left"]]);
});

test("parseStageFile: a wrapped status line, a bold word, and a prose bullet (B2b shapes)", () => {
  const text = stageFile(
    [
      "- CURSORY.101 (the comment is false for",
      "  `readLiveFactRows`) · unresolved — still says every member",
      "- VERIFIER.1 — **fixed** — commit 232a40f",
      "- `reopen`: it has two real bindings",
    ],
    "NO FINDINGS"
  );
  const s = parseStageFile(text, { stage: "confirm-1" });
  assert.deepEqual(s.status.map((x) => [x.id, x.status, x.reason, x.line]), [
    ["CURSORY.101", "unresolved", "still says every member", 2],
    ["VERIFIER.1", "resolved", "commit 232a40f", 4],
  ]);
  assert.deepEqual(s.warnings, ["line 5: not a status line (no row id); ignored"]);
});

test("parseStageFile: two ids on one status line, or a word outside the aliases, are refused", () => {
  refuses(() => parseStageFile(stageFile(["- SIMP.7 + CODEX.205 · fixed — moved"], "NO FINDINGS"), { stage: "confirm-2" }), /line 2: a status line is/);
  refuses(() => parseStageFile(stageFile(["- CODEX.204 veto dispute · accepted on the evidence"], "NO FINDINGS"), { stage: "confirm-2" }), /line 2: a status line is/);
});

test("parseStageFile: an unknown word, and unresolved or disagree with no reason, are refused", () => {
  refuses(() => parseStageFile(stageFile(["- CURSORY.3 · maybe"], "NO FINDINGS"), { stage: "confirm-1" }), /CURSORY\.3: unknown status `maybe`/);
  refuses(() => parseStageFile(stageFile(["- CURSORY.3 · unresolved"], "NO FINDINGS"), { stage: "confirm-1" }), /`unresolved` needs a reason/);
  refuses(() => parseStageFile(stageFile(["- CURSORY.3 · disagree"], "NO FINDINGS"), { stage: "confirm-1" }), /`disagree` needs a reason/);
});

test("parseStageFile: agree on a fixed row, or resolved on a dropped row, is refused", () => {
  refuses(() => parseStageFile(stageFile(["- CURSORY.3 · agree"], "NO FINDINGS"), { stage: "confirm-1", given: [{ id: "CURSORY.3", line: "fixed" }] }), /fixer's line was `fixed`, so the answer is resolved \| unresolved/);
  refuses(() => parseStageFile(stageFile(["- CURSORY.3 · resolved"], "NO FINDINGS"), { stage: "confirm-1", given: [{ id: "CURSORY.3", line: "dropped" }] }), /agree \| disagree/);
});

test("parseStageFile: a status for a row not given is a warning; an `also` id answers its row", () => {
  const text = stageFile(["- CODEX.7 · agree", "- OTHER.9 · resolved"], "NO FINDINGS");
  const s = parseStageFile(text, { stage: "confirm-1", given: [{ id: "SIMP.2", also: ["CODEX.7"], line: "dropped" }] });
  assert.deepEqual(s.status.map((x) => [x.row, x.id]), [["SIMP.2", "CODEX.7"]]);
  assert.deepEqual(s.warnings, ["line 3: OTHER.9 was not given to this reader; ignored"]);
});

test("parseStageFile: `- none` with no rows given; missing sections and an empty `## New` are refused", () => {
  assert.deepEqual(parseStageFile(stageFile(["- none"], "NO FINDINGS — clean"), { stage: "drift", given: [] }).status, []);
  refuses(() => parseStageFile("## New\nNO FINDINGS", { stage: "drift" }), /missing `## Status` section/);
  refuses(() => parseStageFile("## Status\n- none", { stage: "drift" }), /missing `## New` section/);
  refuses(() => parseStageFile(stageFile(["- none"], "looked, fine"), { stage: "drift" }), /`## New` holds no finding block and no line starting `NO FINDINGS`/);
});

test("parseStageFile: build-verifier must end with a VERDICT line; both forms parse", () => {
  const body = stageFile(["- none"], "NO FINDINGS");
  refuses(() => parseStageFile(body, { stage: "confirm-1", reader: "build-verifier" }), /build-verifier ends with `VERDICT: CLEAN`/);
  assert.deepEqual(parseStageFile(`${body}\n\nVERDICT: CLEAN\n`, { stage: "confirm-1", reader: "build-verifier" }).verdict, { verdict: "CLEAN" });
  assert.deepEqual(parseVerdict("x\nVERDICT: INCOMPLETE — check 2 exercise blocked"), { verdict: "INCOMPLETE", check: "check 2 exercise blocked" });
  refuses(() => parseVerdict("VERDICT: BLOCKED-INCOMPLETE — env"), /`VERDICT: CLEAN` or `VERDICT: INCOMPLETE — <check>`/);
  assert.equal(parseVerdict("no verdict here"), null);
});

// ── Fix file ────────────────────────────────────────────────────────────────────────────────

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

test("CURSORY.4: a drift group's round is `drift-<n>`; a bare `drift` round id is refused", () => {
  assert.deepEqual([isRoundId("drift-1"), isRoundId("drift-12"), isRoundId("drift"), isRoundId("drift-0"), isRoundId("final")], [true, true, false, false, true]);
  assert.equal(driftGroupOf("drift-3"), 3);
  assert.equal(isFixedAt("structure", "drift-2"), false);
  assert.equal(isFixedAt("security", "drift-2"), true);
  const t = { schema: 2 as const, rounds: { "drift-2": TABLE.rounds["1"]!, "drift-1": TABLE.rounds["1"]!, "1": TABLE.rounds["1"]! } };
  assert.deepEqual(Object.keys(JSON.parse(serialiseTableJson(t)).rounds), ["1", "drift-1", "drift-2"], "rounds print in build order");
  refuses(() => parseTableJson(JSON.stringify({ schema: 2, rounds: { drift: TABLE.rounds["1"] } })), /table\.json rounds\.drift: expected a round id/);
  assert.deepEqual(parseStageKey("drift-confirm-2"), { stage: "drift-confirm", group: 2, key: "drift-confirm-2", folder: "stage-drift-confirm-2" });
  assert.equal(parseStageKey("drift"), null);
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

// ── Hand-test file ──────────────────────────────────────────────────────────────────────────

test("parseHandTestFile: each line form parses", () => {
  const text = [
    "H1 · pass · 4f1c2a9 — hand-test-1/H1.out",
    "H2 · fail (code) · 4f1c2a9 — hand-test-1/H2.out — the reply row is empty; expected the retry row",
    "H3 · fail (env) · 4f1c2a9 — hand-test-1/H3.out — local Supabase not answering on :54321",
    "H4 · fail (claim) · 4f1c2a9 — hand-test-1/H4.out — the claim names a flag that does not exist",
  ].join("\n");
  assert.deepEqual(parseHandTestFile(text), [
    { claim: "H1", line: 1, result: "pass", sha: "4f1c2a9", output: "hand-test-1/H1.out" },
    { claim: "H2", line: 2, result: "fail", cause: "code", sha: "4f1c2a9", output: "hand-test-1/H2.out", differed: "the reply row is empty; expected the retry row" },
    { claim: "H3", line: 3, result: "fail", cause: "env", sha: "4f1c2a9", output: "hand-test-1/H3.out", differed: "local Supabase not answering on :54321" },
    { claim: "H4", line: 4, result: "fail", cause: "claim", sha: "4f1c2a9", output: "hand-test-1/H4.out", differed: "the claim names a flag that does not exist" },
  ]);
});

test("parseHandTestFile: a fail with no cause or no difference, an absolute output, and a repeated claim are refused", () => {
  refuses(() => parseHandTestFile("H2 · fail · 4f1c2a9 — hand-test-1/H2.out — x"), /line 1: a hand-test line is/);
  refuses(() => parseHandTestFile("H2 · fail (code) · 4f1c2a9 — hand-test-1/H2.out"), /line 1: a hand-test line is/);
  refuses(() => parseHandTestFile("H1 · pass · 4f1c2a9 — /tmp/H1.out"), /H1: the output file is relative to the run dir/);
  refuses(() => parseHandTestFile("H1 · pass · 4f1c2a9 — a.out\nH1 · pass · 4f1c2a9 — b.out"), /line 2: H1: a second line for this claim/);
});

// ── table.json ──────────────────────────────────────────────────────────────────────────────

const ROW = {
  id: "CURSORY.3",
  also: ["CODEX.1"],
  kind: "behavior" as const,
  locators: [{ path: "a.ts", start: 40, end: 45, parsed: true }],
  texts: [
    { id: "CURSORY.3", finding: "f", after: "a", invariant: "i", vacuity: "v" },
    { id: "CODEX.1", finding: "f2", after: "a2" },
  ],
  origin: "reader" as const,
  enteredAt: "1" as const,
  history: ["1: fixed — 4f1c2a9; confirm-1: unresolved — still retries"],
};

const TABLE: TableJson = {
  schema: 2,
  rounds: {
    "1": {
      head: "4f1c2a9",
      rows: [ROW],
      leftovers: [{ advice: { locator: "docs/x.md:3", text: "stale" }, reason: "prose drift" }],
      banked: [],
      closed: [],
      consumed: ["review-cursory.md", "session.md"],
      refused: [{ file: "security-review.md", error: "line 3: finding SEC.1: missing `kind`" }],
    },
    final: {
      head: "8e2d0b1",
      rows: [],
      leftovers: [{ row: { ...ROW, kind: "text" }, reason: "text at round 2" }],
      banked: [{ id: "VERIFIER.1", question: "brief — deliverable 4" }],
      closed: ["CURSORY.3"],
      consumed: ["fix-1.txt"],
      refused: [],
      open: [{ id: "HAND.2", kind: "behavior" }],
    },
  },
};

test("table.json: serialise then parse round-trips, and re-serialising gives the same text", () => {
  const text = serialiseTableJson(TABLE);
  assert.deepEqual(parseTableJson(text), TABLE);
  assert.equal(serialiseTableJson(parseTableJson(text)), text);
  assert.ok(text.endsWith("}\n"));
});

test("table.json: key order is fixed, so an input in another order prints the same text", () => {
  const { head, ...rest } = TABLE.rounds["1"]!;
  const reordered = { rounds: { final: TABLE.rounds.final, "1": { ...rest, head } }, schema: 2 };
  assert.equal(serialiseTableJson(reordered as TableJson), serialiseTableJson(TABLE));
});

test("table.json: a wrong schema, an unknown round, a bad kind, and `open` outside final are refused by path", () => {
  refuses(() => parseTableJson(JSON.stringify({ ...TABLE, schema: 1 })), /table\.json schema: expected 2/);
  refuses(() => parseTableJson(JSON.stringify({ schema: 2, rounds: { "4": TABLE.rounds["1"] } })), /table\.json rounds\.4: expected a round id/);
  const badKind = JSON.parse(serialiseTableJson(TABLE));
  badKind.rounds["1"].rows[0].kind = "perf";
  refuses(() => parseTableJson(JSON.stringify(badKind)), /table\.json rounds\.1\.rows\[0\]\.kind: expected one of behavior/);
  const openInOne = JSON.parse(serialiseTableJson(TABLE));
  openInOne.rounds["1"].open = [];
  refuses(() => parseTableJson(JSON.stringify(openInOne)), /rounds\.1\.open: expected no `open` outside round `final`/);
  refuses(() => parseTableJson("{not json"), /table\.json is not JSON/);
  refuses(() => serialiseTableJson({ schema: 2, rounds: { final: { ...TABLE.rounds["1"]! } } } as TableJson), /rounds\.final\.open: expected an array/);
});
