/**
 * The review table's pure core (`lib/table.ts`): intake per round, how a prior row routes, the merge
 * rule, the two kind rules, refusals, the final round, and what the CLI prints and writes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type FinalRound,
  normaliseLocator,
  parseFixFile,
  parseStageKey,
  parseTableJson,
  type Round,
  type RoundId,
  type Row,
  serialiseTableJson,
  type StageKey,
  type TableJson,
} from "../lib/runFiles.ts";
import {
  applyKindRules,
  buildRound,
  givenRows,
  type InputFile,
  leftoverLines,
  locatorsMeet,
  type ReaderInput,
  renderRoundTable,
  type RoundInputs,
  roundStages,
  stageCarry,
  type StageInput,
  summaryLines,
  TableInputError,
} from "../lib/table.ts";

const LIM = { near: 3, exactAbove: 30 };
const EMPTY: TableJson = { schema: 2, rounds: {} };
const SHA = "4f1c2a9";

function blk(id: string, loc: string, kind: string, title = `title ${id}`): string {
  return `### ${id} — ${title}\n- locator: ${loc}\n- kind: ${kind}\n- finding: ${id} is wrong\n- after: ${id} is right\n`;
}

function reader(name: string, text: string, opts: { slice?: number; dir?: string } = {}): ReaderInput {
  const slice = opts.slice ?? null;
  return { file: `${opts.dir ?? ""}${name}${slice === null ? "" : `-${slice}`}.md`, reader: name, slice, text };
}

function wave(...files: ReaderInput[]) {
  return buildRound({ round: "1", head: "aaaaaaa", table: EMPTY, isTarget: () => false, wave: files, merge: LIM });
}

function row(id: string, kind: Row["kind"], loc = `src/${id.toLowerCase()}.ts:10`, also: string[] = []): Row {
  return {
    id,
    also,
    kind,
    locators: normaliseLocator(loc),
    texts: [{ id, finding: `title ${id} — ${id} is wrong`, after: `${id} is right` }],
    origin: /^HAND\./.test(id) ? "hand-test" : "reader",
    enteredAt: "1",
    history: [],
  };
}

function emptyRound(rows: Row[] = []): Round {
  return { head: "bbbbbbb", rows, leftovers: [], banked: [], closed: [], consumed: [], refused: [] };
}

function tableWith(rounds: Partial<Record<RoundId, Row[] | Round>>): TableJson {
  const out: TableJson = { schema: 2, rounds: {} };
  for (const [id, v] of Object.entries(rounds) as [RoundId, Row[] | Round][]) {
    const r = Array.isArray(v) ? emptyRound(v) : v;
    out.rounds[id] = id === "final" ? { ...r, open: [] } : r;
  }
  return out;
}

const EXIT = "exit checks:\nvacuity: none — no rows\nmutation: none — no test\nbranches: none — no branch\nshared function: none\n";

function fix(round: string, lines: string[]): InputFile {
  return { file: `fix-${round}.txt`, text: `${lines.join("\n")}\n${EXIT}` };
}

function stageText(status: string[], blocks: string[] = []): string {
  const s = status.length === 0 ? "- none" : status.join("\n");
  const n = blocks.length === 0 ? "NO FINDINGS — nothing new" : blocks.join("\n");
  return `## Status\n${s}\n\n## New\n${n}\n`;
}

/** A stage folder by its key: `confirm-1`, `drift-1`, `drift-confirm-2`. */
function key(k: string): StageKey {
  const s = parseStageKey(k);
  if (s === null) throw new Error(`not a stage key: ${k}`);
  return s;
}

function stage(name: string, files: [string, string][], ran = true): StageInput {
  const k = key(name);
  return { stage: k, ran, files: files.map(([r, text]) => reader(r, text, { dir: `${k.folder}/` })) };
}

function build(p: Partial<RoundInputs> & { round: RoundId; table: TableJson }) {
  return buildRound({ head: "ccccccc", isTarget: () => false, merge: LIM, ...p });
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
const leftoverIds = (r: Round) => r.leftovers.map((l) => l.row?.id ?? `advice:${l.advice?.locator}`);

// ── Merge ────────────────────────────────────────────────────────────────────────────────────

test("merge: two findings 3 lines apart are one row; 4 lines apart are two", () => {
  const near = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:10", "behavior") + blk("CURSORY.2", "a.ts:13", "behavior")));
  assert.deepEqual(near.round.rows.map((r) => [r.id, r.also]), [["CURSORY.1", ["CURSORY.2"]]]);
  const far = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:10", "behavior") + blk("CURSORY.2", "a.ts:14", "behavior")));
  assert.deepEqual(ids(far.round.rows), ["CURSORY.1", "CURSORY.2"]);
});

test("merge: a 31-line range merges only on an exact match; a 30-line range merges on overlap", () => {
  const long = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:10-40", "behavior") + blk("CURSORY.2", "a.ts:20", "behavior")));
  assert.equal(long.round.rows.length, 2);
  const exact = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:10-40", "behavior") + blk("CURSORY.2", "a.ts:10-40", "behavior")));
  assert.equal(exact.round.rows.length, 1);
  const thirty = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:10-39", "behavior") + blk("CURSORY.2", "a.ts:20", "behavior")));
  assert.equal(thirty.round.rows.length, 1);
});

test("merge: a missing finding never merges, even on the same line", () => {
  const r = wave(
    reader("review-cursory", blk("CURSORY.1", "a.ts:10", "behavior")),
    reader("build-verifier", blk("VERIFIER.1", "a.ts:10", "missing"))
  );
  assert.deepEqual(ids(r.round.rows), ["CURSORY.1", "VERIFIER.1"]);
});

test("merge: an unparsed locator never merges; another path never merges", () => {
  const r = wave(
    reader(
      "review-cursory",
      blk("CURSORY.1", "the send loop", "behavior") + blk("CURSORY.2", "the send loop", "behavior") + blk("CURSORY.3", "b.ts:10", "behavior")
    ),
    reader("review-cursory-codex", blk("CODEX.1", "c.ts:10", "behavior"))
  );
  assert.equal(r.round.rows.length, 4);
});

test("merge: a merged row keeps both texts in merge order, takes the higher kind, and is transitive", () => {
  const r = wave(
    reader("review-cursory-codex", blk("CODEX.1", "a.ts:13", "text", "codex says")),
    reader("gate-silent-failure-hunter", blk("HUNTER.1", "a.ts:16", "security", "hunter says")),
    reader("review-cursory", blk("CURSORY.4", "a.ts:10", "structure", "cursory says"))
  );
  assert.equal(r.round.rows.length, 1);
  const [only] = r.round.rows;
  assert.equal(only!.id, "CURSORY.4");
  assert.deepEqual(only!.also, ["CODEX.1", "HUNTER.1"]);
  assert.equal(only!.kind, "security");
  assert.deepEqual(
    only!.texts.map((t) => t.finding),
    ["cursory says — CURSORY.4 is wrong", "codex says — CODEX.1 is wrong", "hunter says — HUNTER.1 is wrong"]
  );
});

test("merge: on equal kind rank the row's first finding's kind wins", () => {
  const r = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:10", "test-app") + blk("CURSORY.2", "a.ts:11", "structure")));
  assert.equal(r.round.rows[0]!.kind, "test-app");
});

test("locatorsMeet: a whole file meets only a whole file", () => {
  const [whole] = normaliseLocator("a.ts");
  const [line] = normaliseLocator("a.ts:3");
  assert.equal(locatorsMeet(whole!, line!, LIM), false);
  assert.equal(locatorsMeet(whole!, whole!, LIM), true);
});

// ── Kind rules ───────────────────────────────────────────────────────────────────────────────

test("kind rule: a dev-tool finding on a target file becomes behavior; test-tool becomes test-app", () => {
  const target = (p: string) => p === "src/x.ts";
  assert.equal(applyKindRules("dev-tool", normaliseLocator("src/x.ts:4"), target), "behavior");
  assert.equal(applyKindRules("test-tool", normaliseLocator("src/x.ts:4"), target), "test-app");
  assert.equal(applyKindRules("dev-tool", normaliseLocator("src/x.ts:4, scripts/y.ts:2"), target), "dev-tool");
  assert.equal(applyKindRules("dev-tool", normaliseLocator("the build script"), () => true), "dev-tool");
  const r = buildRound({
    round: "1",
    head: "aaaaaaa",
    table: EMPTY,
    isTarget: target,
    wave: [reader("review-cursory", blk("CURSORY.1", "src/x.ts:4", "dev-tool"))],
    merge: LIM,
  });
  assert.equal(r.round.rows[0]!.kind, "behavior");
});

test("kind rule: text on behaviour markdown is dev-tool, or behavior when the path is a target; other text stays", () => {
  assert.equal(applyKindRules("text", normaliseLocator(".claude/build/notes.md:12"), () => false), "dev-tool");
  assert.equal(applyKindRules("text", normaliseLocator(".claude/build/notes.md:12"), () => true), "behavior");
  assert.equal(applyKindRules("text", normaliseLocator("docs/rules/x.md:3"), () => false), "dev-tool");
  assert.equal(applyKindRules("text", normaliseLocator("README.md:3"), () => true), "text");
});

// ── Round 1 ──────────────────────────────────────────────────────────────────────────────────

test("round 1: every kind is a row; prose drift is a text row numbered after the reader's own; session wave blocks join", () => {
  const r = buildRound({
    round: "1",
    head: "aaaaaaa",
    table: EMPTY,
    isTarget: () => false,
    wave: [reader("review-cursory", `${blk("CURSORY.1", "a.ts:1", "text")}\n## Prose drift (advisory)\n- docs/x.md:3 · says 5 · is 6\n`)],
    session: {
      file: "session.md",
      text: `### SESSION.1 — red test\n- locator: b.ts:1\n- kind: behavior\n- stage: wave\n- finding: f\n- after: a\n\n### SESSION.2 — later\n- locator: c.ts:1\n- kind: behavior\n- stage: confirm-1\n- finding: f\n- after: a\n`,
    },
    merge: LIM,
  });
  assert.deepEqual(ids(r.round.rows), ["CURSORY.1", "CURSORY.2", "SESSION.1"]);
  const drift = r.round.rows[1]!;
  assert.equal(drift.kind, "text");
  assert.equal(drift.origin, "reader");
  assert.deepEqual(drift.locators.map((l) => [l.path, l.start]), [["docs/x.md", 3]]);
  assert.ok(drift.texts[0]!.finding.endsWith("says 5 · is 6"));
  assert.equal(r.round.rows[2]!.origin, "session");
  assert.deepEqual(r.round.leftovers, []);
  assert.deepEqual(r.round.consumed, ["review-cursory.md", "session.md"]);
});

test("round 1: a prose-drift line that reports nothing is no row; one with no locator still is", () => {
  const drift = [
    "## Prose drift (advisory)",
    "- None noticed beyond what the diff's own doc updates already correct.",
    "- none",
    "- None noticed.",
    "_None._",
    "- N/A",
    "- nothing to flag",
    "- none.ts:4 · says 5 · is 6",
    "- None of the docs name the new flag",
    "- Nothing in README.md says the step moved",
  ].join("\n");
  const r = wave(reader("review-cursory", `NO FINDINGS\n\n${drift}\n`));
  assert.deepEqual(ids(r.round.rows), ["CURSORY.1", "CURSORY.2", "CURSORY.3"]);
  assert.deepEqual(
    r.round.rows.map((row) => [row.locators.map((l) => l.path), row.texts[0]!.finding.replace(/^.*— /, "")]),
    [
      [["none.ts"], "says 5 · is 6"],
      [[], "None of the docs name the new flag"],
      [[], "Nothing in README.md says the step moved"],
    ]
  );
  assert.deepEqual(r.round.leftovers, []);
});

test("refusal: a file that fails its grammar is left out and named; the other files go through", () => {
  const bad = "### CODEX.1 — no kind\n- locator: a.ts:1\n- finding: f\n- after: a\n";
  const r = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:1", "behavior")), reader("review-cursory-codex", bad));
  assert.deepEqual(ids(r.round.rows), ["CURSORY.1"]);
  assert.equal(r.round.refused.length, 1);
  assert.equal(r.round.refused[0]!.file, "review-cursory-codex.md");
  assert.match(r.round.refused[0]!.error, /missing `kind`/);
  assert.deepEqual(r.round.consumed, ["review-cursory.md"]);
});

test("R.14: at the wave, a failed Codex file renamed out of the reader set leaves `refused` empty", () => {
  const r = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:1", "behavior")));
  assert.deepEqual(r.round.refused, []);
});

// ── Routing a prior row ──────────────────────────────────────────────────────────────────────

test("round 2 intake: each fixer line and stage answer routes as §1.7 says", () => {
  const table = tableWith({
    "1": [
      row("CURSORY.1", "behavior"),
      row("CURSORY.2", "behavior"),
      row("CURSORY.3", "text"),
      row("CODEX.1", "structure"),
      row("CODEX.2", "structure"),
      row("CODEX.3", "test-tool"),
      row("CODEX.4", "behavior"),
    ],
  });
  const r = build({
    round: "2",
    table,
    fixes: {
      "1": fix("1", [
        `CURSORY.1 · fixed · ${SHA} — done`,
        `CURSORY.2 · fixed · ${SHA} — done`,
        `CURSORY.3 · fixed · ${SHA} — done`,
        "CODEX.1 · dropped — not real",
        "CODEX.2 · dropped — not real",
        "CODEX.3 · dropped — not real",
        "CODEX.4 · decision — product — which copy?",
      ]),
    },
    stages: [
      stage("confirm-1", [
        [
          "review-cursory-codex",
          stageText([
            "- CURSORY.1 · resolved",
            "- CURSORY.2 · unresolved — still loops",
            "- CURSORY.3 · unresolved — still wrong",
            "- CODEX.1 · agree",
            "- CODEX.2 · disagree — it is real",
            "- CODEX.3 · disagree — it is real",
          ]),
        ],
      ]),
    ],
  });
  assert.deepEqual(ids(r.round.rows), ["CURSORY.2", "CODEX.2"]);
  assert.equal(r.round.rows[1]!.kind, "structure");
  assert.deepEqual(leftoverIds(r.round), ["CURSORY.3", "CODEX.3"]);
  assert.deepEqual(r.round.closed, ["CURSORY.1", "CODEX.1"]);
  assert.deepEqual(r.round.banked, [{ id: "CODEX.4", question: "product — which copy?" }]);
  assert.deepEqual(r.round.rows[0]!.history, [
    `1: fixed ${SHA} — done; confirm-1: review-cursory-codex unresolved — still loops`,
  ]);
  assert.deepEqual(r.round.refused, []);
  assert.deepEqual(r.round.consumed, ["fix-1.txt", "stage-confirm-1/review-cursory-codex.md"]);
});

test("round 3 intake: relabel agree routes by the new kind, disagree by the old; fixed · kind= takes the higher kind", () => {
  const table = tableWith({
    "1": [],
    "2": [row("CURSORY.5", "behavior"), row("CURSORY.6", "behavior"), row("CURSORY.7", "structure"), row("CURSORY.8", "behavior")],
  });
  const r = build({
    round: "3",
    table,
    fixes: {
      "2": fix("2", [
        "CURSORY.5 · relabel behavior→text — only the comment",
        "CURSORY.6 · relabel behavior→text — only the comment",
        `CURSORY.7 · fixed · ${SHA} · kind=behavior — it was a bug`,
        `CURSORY.8 · fixed · ${SHA} · kind=structure — only the shape`,
      ]),
    },
    stages: [
      stage("confirm-2", [
        [
          "review-cursory-codex",
          stageText([
            "- CURSORY.5 · agree",
            "- CURSORY.6 · disagree — it is behaviour",
            "- CURSORY.7 · unresolved — still a bug",
            "- CURSORY.8 · unresolved — still a bug",
          ]),
        ],
      ]),
    ],
  });
  assert.deepEqual(r.round.rows.map((x) => [x.id, x.kind]), [["CURSORY.6", "behavior"], ["CURSORY.7", "behavior"], ["CURSORY.8", "behavior"]]);
  assert.deepEqual(r.round.leftovers.map((l) => [l.row!.id, l.row!.kind, l.reason]), [["CURSORY.5", "text", "kind text is not fixed at round 3"]]);
});

test("routing: with no stage run a fixed row closes; a stage that ran but left a row unanswered keeps it", () => {
  const table = tableWith({ "1": [row("CURSORY.1", "behavior")] });
  const fixes = { "1": fix("1", [`CURSORY.1 · fixed · ${SHA} — done`]) };
  const notRun = build({ round: "2", table, fixes, stages: [stage("confirm-1", [], false)] });
  assert.deepEqual(notRun.round.closed, ["CURSORY.1"]);
  assert.equal(notRun.round.rows.length, 0);
  const refusedCodex = build({
    round: "2",
    table,
    fixes,
    stages: [stage("confirm-1", [["review-cursory-codex", "## Status\n- CURSORY.1 · maybe\n\n## New\nNO FINDINGS\n"]])],
  });
  assert.deepEqual(ids(refusedCodex.round.rows), ["CURSORY.1"]);
  assert.match(refusedCodex.round.rows[0]!.history[0]!, /confirm-1: no answer/);
  assert.equal(refusedCodex.round.refused.length, 1);
});

test("R.14: after the refused Codex file is renamed, the Sonnet stand-in answers and `refused` is empty", () => {
  const table = tableWith({ "1": [row("CURSORY.1", "behavior")] });
  const r = build({
    round: "2",
    table,
    fixes: { "1": fix("1", [`CURSORY.1 · fixed · ${SHA} — done`]) },
    stages: [stage("confirm-1", [["review-cursory", stageText(["- CURSORY.1 · resolved"])]])],
  });
  assert.deepEqual(r.round.refused, []);
  assert.deepEqual(r.round.closed, ["CURSORY.1"]);
});

test("R.16: when two readers answer one row, unresolved beats resolved and disagree beats agree; history keeps both", () => {
  const table = tableWith({ "1": [row("HUNTER.1", "behavior"), row("HUNTER.2", "structure")] });
  const r = build({
    round: "2",
    table,
    fixes: { "1": fix("1", [`HUNTER.1 · fixed · ${SHA} — done`, "HUNTER.2 · dropped — not real"]) },
    stages: [
      stage("confirm-1", [
        ["review-cursory-codex", stageText(["- HUNTER.1 · resolved", "- HUNTER.2 · agree"])],
        ["gate-silent-failure-hunter", stageText(["- HUNTER.1 · unresolved — the catch still swallows", "- HUNTER.2 · disagree — it is real"])],
      ]),
    ],
  });
  assert.deepEqual(ids(r.round.rows), ["HUNTER.1", "HUNTER.2"]);
  assert.equal(
    r.round.rows[0]!.history[0],
    `1: fixed ${SHA} — done; confirm-1: review-cursory-codex resolved, gate-silent-failure-hunter unresolved — the catch still swallows`
  );
});

test("givenRows: Codex and its stand-in get every fixed, dropped, and relabelled row; another reader only rows holding its ids", () => {
  const rows = [row("CURSORY.1", "behavior", "a.ts:1", ["HUNTER.3"]), row("CODEX.1", "behavior"), row("SEC.1", "security"), row("CURSORY.2", "behavior")];
  const f = parseFixFile(fix("2", [`CURSORY.1 · fixed · ${SHA} — x`, "CODEX.1 · dropped — y", "SEC.1 · relabel security→text — z", "CURSORY.2 · decision — brief — q"]).text, {
    rows: ids(rows),
    round: "2",
  });
  assert.deepEqual(givenRows(rows, f, "review-cursory-codex").map((g) => [g.id, g.line]), [["CURSORY.1", "fixed"], ["CODEX.1", "dropped"], ["SEC.1", "relabel"]]);
  assert.deepEqual(ids(givenRows(rows, f, "review-cursory")), ["CURSORY.1", "CODEX.1", "SEC.1"]);
  assert.deepEqual(ids(givenRows(rows, f, "gate-silent-failure-hunter")), ["CURSORY.1"]);
  assert.deepEqual(ids(givenRows(rows, f, "security-review")), ["SEC.1"]);
  assert.deepEqual(ids(givenRows(rows, f, "build-verifier")), []);
});

test("routing: a reader file that misses a given row is refused", () => {
  const table = tableWith({ "1": [row("CURSORY.1", "behavior"), row("CURSORY.2", "behavior")] });
  const r = build({
    round: "2",
    table,
    fixes: { "1": fix("1", [`CURSORY.1 · fixed · ${SHA} — done`, `CURSORY.2 · fixed · ${SHA} — done`]) },
    stages: [stage("confirm-1", [["review-cursory-codex", stageText(["- CURSORY.1 · resolved"])]])],
  });
  assert.equal(r.round.refused.length, 1);
  assert.match(r.round.refused[0]!.error, /CURSORY\.2: row given and missing/);
});

// ── New findings at a stage ──────────────────────────────────────────────────────────────────

test("round 2: new stage findings merge with each other, never with prior rows; kinds not fixed at 2 are leftovers", () => {
  const table = tableWith({ "1": [row("CURSORY.1", "behavior", "a.ts:10")] });
  const r = build({
    round: "2",
    table,
    fixes: { "1": fix("1", [`CURSORY.1 · fixed · ${SHA} — done`]) },
    stages: [
      stage("confirm-1", [
        [
          "review-cursory-codex",
          stageText(["- CURSORY.1 · unresolved — no"], [blk("CODEX.101", "a.ts:11", "behavior"), blk("CODEX.102", "z.ts:1", "text")]),
        ],
        ["security-review", stageText([], [blk("SEC.101", "a.ts:12", "security")])],
      ]),
    ],
    session: {
      file: "session.md",
      text: "### SESSION.1 — w2 red\n- locator: q.ts:5\n- kind: behavior\n- stage: confirm-1\n- finding: f\n- after: a\n",
    },
  });
  assert.deepEqual(r.round.rows.map((x) => [x.id, x.also, x.kind]), [
    ["CURSORY.1", [], "behavior"],
    ["CODEX.101", ["SEC.101"], "security"],
    ["SESSION.1", [], "behavior"],
  ]);
  assert.deepEqual(leftoverIds(r.round), ["CODEX.102"]);
});

test("a round with no prior rows needs no fix file", () => {
  const r = build({ round: "2", table: tableWith({ "1": [] }) });
  assert.equal(r.round.rows.length, 0);
});

// ── Hand tests ───────────────────────────────────────────────────────────────────────────────

test("hand test: a code fail is a HAND behavior row next round; env and claim fails are not rows", () => {
  const r = build({
    round: "2",
    table: tableWith({ "1": [] }),
    handTests: [
      {
        file: "hand-test-1.txt",
        n: 1,
        text: `H1 · pass · ${SHA} — hand-test-1/H1.out\nH2 · fail (code) · ${SHA} — hand-test-1/H2.out — the reply row is empty\nH3 · fail (env) · ${SHA} — hand-test-1/H3.out — no stack\nH4 · fail (claim) · ${SHA} — hand-test-1/H4.out — wrong command\n`,
      },
    ],
  });
  assert.deepEqual(r.round.rows.map((x) => [x.id, x.kind, x.origin]), [["HAND.2", "behavior", "hand-test"]]);
  assert.deepEqual(r.round.consumed, ["hand-test-1.txt"]);
});

test("hand test: a HAND row closes on a later pass, stays open without one, and a consumed file is not read again", () => {
  const table = tableWith({
    "1": [],
    "2": { ...emptyRound([row("HAND.2", "behavior", "")]), consumed: ["hand-test-1.txt"] },
  });
  const hand1: InputFile & { n: number } = {
    file: "hand-test-1.txt",
    n: 1,
    text: `H2 · fail (code) · ${SHA} — hand-test-1/H2.out — empty\n`,
  };
  const fixes = { "2": fix("2", [`HAND.2 · fixed · ${SHA} — renders the retry row`]) };
  const stages = [stage("confirm-2", [["review-cursory-codex", stageText(["- HAND.2 · resolved"])]])];
  const noRerun = build({ round: "3", table, fixes, stages, handTests: [hand1] });
  assert.deepEqual(ids(noRerun.round.rows), ["HAND.2"]);
  assert.deepEqual(noRerun.round.consumed, ["fix-2.txt", "stage-confirm-2/review-cursory-codex.md"]);
  const passed = build({
    round: "3",
    table,
    fixes,
    stages,
    handTests: [hand1, { file: "hand-test-2.txt", n: 2, text: `H2 · pass · ${SHA} — hand-test-2/H2.out\n` }],
  });
  assert.deepEqual(passed.round.closed, ["HAND.2"]);
  assert.equal(passed.round.rows.length, 0);
});

// ── Escalate, drift, final ───────────────────────────────────────────────────────────────────

test("escalate: only behavior, security, and missing rows go on; the rest are leftovers", () => {
  const table = tableWith({ "1": [], "2": [], "3": [row("CURSORY.2", "behavior")] });
  const r = build({
    round: "escalate",
    table,
    fixes: { "3": fix("3", [`CURSORY.2 · fixed · ${SHA} — done`]) },
    stages: [
      stage("last", [
        ["review-cursory-codex", stageText(["- CURSORY.2 · unresolved — no"], [blk("CODEX.301", "x.ts:1", "structure"), blk("CODEX.302", "y.ts:1", "behavior")])],
      ]),
    ],
  });
  assert.deepEqual(ids(r.round.rows), ["CURSORY.2", "CODEX.302"]);
  assert.deepEqual(leftoverIds(r.round), ["CODEX.301"]);
});

test("drift: the drift read's urgent findings are rows, the rest leftovers", () => {
  const r = build({
    round: "drift-1",
    table: EMPTY,
    stages: [stage("drift-1", [["review-cursory", stageText([], [blk("CURSORY.501", "m.ts:1", "behavior"), blk("CURSORY.502", "n.ts:1", "text")])]])],
  });
  assert.deepEqual(ids(r.round.rows), ["CURSORY.501"]);
  assert.deepEqual(leftoverIds(r.round), ["CURSORY.502"]);
  assert.deepEqual(r.round.consumed, ["stage-drift-1/review-cursory.md"]);
});

test("CURSORY.4: a second drift group is its own round; final carries both, so group 1's unresolved row stays open", () => {
  const drift1 = build({
    round: "drift-1",
    table: tableWith({ "1": [], "2": [], "3": [], escalate: [] }),
    stages: [stage("drift-1", [["review-cursory", stageText([], [blk("CURSORY.501", "m.ts:1", "security")])]])],
  });
  assert.throws(() => build({ round: "drift-3", table: drift1.table }), /round drift-3 needs round drift-2/);
  const drift2 = build({
    round: "drift-2",
    table: drift1.table,
    stages: [stage("drift-2", [["review-cursory", stageText([], [])]])],
  });
  assert.deepEqual(Object.keys(drift2.table.rounds), ["1", "2", "3", "escalate", "drift-1", "drift-2"]);
  assert.equal(drift2.table.rounds["drift-1"]!.rows[0]!.id, "CURSORY.501", "group 2 never rewrites group 1's round");
  const final = build({
    round: "final",
    table: drift2.table,
    fixes: { "drift-1": fix("drift-1", [`CURSORY.501 · fixed · ${SHA} — guarded`]) },
    stages: [stage("drift-confirm-1", [["review-cursory-codex", stageText(["- CURSORY.501 · unresolved — still open"])]])],
  });
  assert.deepEqual((final.round as FinalRound).open, [{ id: "CURSORY.501", kind: "security" }]);
  assert.deepEqual(final.round.consumed, ["fix-drift-1.txt", "stage-drift-confirm-1/review-cursory-codex.md"]);
});

test("CURSORY.4: a session.md drift block enters the one drift round that holds it, never two", () => {
  const session = { file: "session.md", text: "### SESSION.1 — main broke it\n- locator: m.ts:1\n- kind: behavior\n- stage: drift\n- finding: f\n- after: a\n" };
  const drift1 = build({ round: "drift-1", table: EMPTY, session, stages: [stage("drift-1", [["review-cursory", stageText([], [])]])] });
  assert.deepEqual(ids(drift1.round.rows), ["SESSION.1"]);
  const drift2 = build({ round: "drift-2", table: drift1.table, session, stages: [stage("drift-2", [["review-cursory", stageText([], [])]])] });
  assert.deepEqual(ids(drift2.round.rows), [], "group 1's round already holds SESSION.1");
  const rebuilt1 = build({ round: "drift-1", table: drift2.table, session, stages: [stage("drift-1", [["review-cursory", stageText([], [])]])] });
  assert.deepEqual(ids(rebuilt1.round.rows), ["SESSION.1"], "re-building group 1 keeps its block");
});

test("CURSORY.8: a second file that reuses a finding id is refused, so one fix line never answers two findings", () => {
  // A repo reader's prefix is its own, so only the clash guard stands between it and a global id.
  const r = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:1", "behavior")), reader("comment-reader", blk("CURSORY.1", "z.ts:90", "behavior")));
  assert.deepEqual(ids(r.round.rows), ["CURSORY.1"]);
  assert.deepEqual(r.round.refused.map((f) => f.file), ["comment-reader.md"]);
  assert.match(r.round.refused[0]!.error, /finding CURSORY\.1 is also in review-cursory\.md — slice k from the second on writes <PREFIX>-<k>/);
});

test("fix4: a global reader's ids take its own prefix (slice k from the second on adds -<k>), at the wave and at a stage", () => {
  const r = wave(
    reader("review-cursory", blk("CURSORY.1", "a.ts:1", "behavior"), { slice: 1 }),
    reader("review-cursory", blk("CURSORY.1", "z.ts:90", "behavior"), { slice: 2 }),
    reader("security-review", blk("SECURITY.1", "b.ts:1", "security")),
    reader("simplifier", blk("SIMP.1", "c.ts:1", "structure")),
    reader("review-cursory-codex", blk("CODEX-2.1", "d.ts:1", "behavior"), { slice: 2 })
  );
  assert.deepEqual(ids(r.round.rows).sort(), ["CODEX-2.1", "CURSORY.1", "SIMP.1"]);
  assert.deepEqual(
    r.round.refused.map((f) => [f.file, f.error]),
    [
      ["review-cursory-2.md", "line 1: finding CURSORY.1: this reader's ids are `CURSORY-2.<n>` (CLOSE §The readers → Id prefixes), got `CURSORY`"],
      ["security-review.md", "line 1: finding SECURITY.1: this reader's ids are `SEC.<n>` (CLOSE §The readers → Id prefixes), got `SECURITY`"],
    ]
  );
  const atStage = build({
    round: "2",
    table: tableWith({ "1": [] }),
    stages: [
      stage("confirm-1", [
        ["review-cursory-codex", stageText([], [blk("CODEX.101", "a.ts:1", "behavior")])],
        ["security-review", stageText([], [blk("CODEX.102", "b.ts:1", "security")])],
      ]),
    ],
  });
  assert.deepEqual(atStage.round.refused.map((f) => f.file), ["stage-confirm-1/security-review.md"]);
  assert.match(atStage.round.refused[0]!.error, /this reader's ids are `SEC\.<n>`/);
});

test("CURSORY.6: a relabel the reader disagrees with keeps the row's own kind, whatever old kind the fixer typed", () => {
  const table = tableWith({ "1": [], "2": [row("CURSORY.3", "behavior")] });
  const r = build({
    round: "3",
    table,
    fixes: { "2": fix("2", ["CURSORY.3 · relabel structure→text — only a comment"]) },
    stages: [stage("confirm-2", [["review-cursory-codex", stageText(["- CURSORY.3 · disagree — a real 4xx loop"])]])],
  });
  assert.deepEqual(r.round.rows.map((x) => [x.id, x.kind]), [["CURSORY.3", "behavior"]]);
  assert.deepEqual(r.round.leftovers, []);
});

test("TEXT-CURSORY.11: a `blocked` row is given to no reader and stays open with its kind; final holds it in open", () => {
  const table = tableWith({ "1": [row("CURSORY.1", "behavior"), row("CURSORY.2", "text")] });
  const fixes = { "1": fix("1", ["CURSORY.1 · blocked — three fixes failed the type-check", "CURSORY.2 · blocked — the doc is generated"]) };
  const f = parseFixFile(fixes["1"].text, { rows: ["CURSORY.1", "CURSORY.2"], round: "1" });
  assert.deepEqual(givenRows(table.rounds["1"]!.rows, f, "review-cursory-codex"), []);
  const r = build({ round: "2", table, fixes, stages: [stage("confirm-1", [["review-cursory-codex", stageText([])]])] });
  assert.deepEqual(ids(r.round.rows), ["CURSORY.1"]);
  assert.deepEqual(leftoverIds(r.round), ["CURSORY.2"]);
  assert.equal(r.round.rows[0]!.history[0], "1: blocked — three fixes failed the type-check; confirm-1: no answer");
  const final = build({
    round: "final",
    table: tableWith({ "1": [], "2": [], "3": [], escalate: [row("CURSORY.1", "behavior")] }),
    fixes: { escalate: fix("escalate", ["CURSORY.1 · blocked — still failing"]) },
  });
  assert.deepEqual((final.round as FinalRound).open, [{ id: "CURSORY.1", kind: "behavior" }]);
  assert.throws(() => build({ round: "2", table }), /fix-1\.txt is missing: round 1 has 2 rows — a fixer that wrote nothing \(a `blocked:` report\) is re-spawned fresh/);
});

test("final: a still-open behavior row is in `open`, every round's leftovers are gathered, and rows are empty", () => {
  const leftover = { row: row("CURSORY.9", "text"), reason: "kind text is not fixed at round 2" };
  const table = tableWith({
    "1": { ...emptyRound(), leftovers: [{ advice: { locator: "docs/x.md:1", text: "stale" }, reason: "prose drift (advisory)" }] },
    "2": { ...emptyRound(), leftovers: [leftover] },
    "3": [],
    escalate: [row("CURSORY.2", "behavior"), row("CURSORY.3", "security")],
  });
  const r = build({
    round: "final",
    table,
    fixes: { escalate: fix("escalate", [`CURSORY.2 · fixed · ${SHA} — done`, `CURSORY.3 · fixed · ${SHA} — done`]) },
    stages: [
      stage("escalate", [
        ["review-cursory-codex", stageText(["- CURSORY.2 · unresolved — still", "- CURSORY.3 · resolved"], [blk("CODEX.401", "k.ts:1", "dev-tool")])],
      ]),
    ],
    session: {
      file: "session.md",
      text: "### SESSION.1 — late\n- locator: s.ts:1\n- kind: behavior\n- stage: escalate\n- finding: f\n- after: a\n\n### SESSION.2 — late text\n- locator: t.ts:1\n- kind: text\n- stage: drift-confirm\n- finding: f\n- after: a\n",
    },
  });
  const final = r.round as FinalRound;
  assert.deepEqual(final.rows, []);
  assert.deepEqual(final.open, [{ id: "CURSORY.2", kind: "behavior" }, { id: "SESSION.1", kind: "behavior" }]);
  assert.deepEqual(final.closed, ["CURSORY.3"]);
  assert.deepEqual(leftoverIds(final), ["advice:docs/x.md:1", "CURSORY.9", "CODEX.401", "SESSION.2"]);
  assert.deepEqual(summaryLines("final", final).at(-1), "open: CURSORY.2 behavior, SESSION.1 behavior");
});

test("final: every round's banked rows are gathered, so a banked run never prints `banked 0`", () => {
  const banked = [{ id: "VERIFIER.6", question: "brief — deliverable 4 names a moved file" }];
  const table = tableWith({ "1": [], "2": { ...emptyRound(), banked }, "3": [], escalate: [] });
  const final = build({ round: "final", table }).round as FinalRound;
  assert.deepEqual(final.banked, banked);
  assert.match(summaryLines("final", final)[0]!, / · banked 1$/);
});

test("final after drift: escalate rows route on stage-escalate, drift rows on stage-drift-confirm-<n>", () => {
  const table = tableWith({
    "1": [],
    "2": [],
    "3": [],
    escalate: [row("CURSORY.2", "behavior")],
    "drift-1": [row("CURSORY.501", "behavior")],
  });
  const r = build({
    round: "final",
    table,
    fixes: {
      escalate: fix("escalate", [`CURSORY.2 · fixed · ${SHA} — done`]),
      "drift-1": fix("drift-1", [`CURSORY.501 · fixed · ${SHA} — done`]),
    },
    stages: [
      stage("escalate", [["review-cursory-codex", stageText(["- CURSORY.2 · resolved"])]]),
      stage("drift-confirm-1", [["review-cursory-codex", stageText(["- CURSORY.501 · unresolved — still drifts"])]]),
    ],
  });
  const final = r.round as FinalRound;
  assert.deepEqual(final.closed, ["CURSORY.2"]);
  assert.deepEqual(final.open, [{ id: "CURSORY.501", kind: "behavior" }]);
});

test("intake: each stage folder names the round and fix file its readers answer; each round names its stage folders", () => {
  const c = (k: string) => {
    const x = stageCarry(key(k));
    return x === null ? null : { from: x.from, fix: x.fix, folder: x.stage.folder };
  };
  assert.deepEqual(c("confirm-1"), { from: "1", fix: "1", folder: "stage-confirm-1" });
  assert.deepEqual(c("last"), { from: "3", fix: "3", folder: "stage-last" });
  assert.deepEqual(c("escalate"), { from: "escalate", fix: "escalate", folder: "stage-escalate" });
  assert.deepEqual(c("drift-confirm-2"), { from: "drift-2", fix: "drift-2", folder: "stage-drift-confirm-2" });
  assert.equal(c("drift-1"), null);
  assert.equal(parseStageKey("wave"), null);
  assert.equal(parseStageKey("drift"), null, "a drift folder needs its group");
  const folders = (r: RoundId, t: TableJson) => roundStages(r, t).map((s) => s.folder);
  assert.deepEqual(folders("1", EMPTY), []);
  assert.deepEqual(folders("2", EMPTY), ["stage-confirm-1"]);
  assert.deepEqual(folders("drift-2", EMPTY), ["stage-drift-2"]);
  assert.deepEqual(folders("final", EMPTY), ["stage-escalate"]);
  assert.deepEqual(folders("final", tableWith({ "drift-1": [], "drift-2": [] })), ["stage-escalate", "stage-drift-confirm-1", "stage-drift-confirm-2"]);
});

// ── Bad input ────────────────────────────────────────────────────────────────────────────────

test("bad input: a prior round missing, or a fix file missing or malformed, throws TableInputError", () => {
  assert.throws(() => build({ round: "2", table: EMPTY }), TableInputError);
  assert.throws(() => build({ round: "final", table: tableWith({ "1": [], "2": [], "3": [] }) }), /needs round escalate/);
  const table = tableWith({ "1": [row("CURSORY.1", "behavior")] });
  assert.throws(() => build({ round: "2", table }), /fix-1\.txt is missing: round 1 has 1 rows/);
  assert.throws(() => build({ round: "2", table, fixes: { "1": fix("1", []) } }), /CURSORY\.1: row has no line/);
});

// ── Output ───────────────────────────────────────────────────────────────────────────────────

test("table.json: the built table round-trips through serialiseTableJson", () => {
  const r = wave(reader("review-cursory", blk("CURSORY.1", "a.ts:1-3, :9", "behavior")));
  const text = serialiseTableJson(r.table);
  assert.deepEqual(parseTableJson(text), r.table);
});

test("summary: kinds counted in KINDS order, refusals listed", () => {
  const r = wave(
    reader("review-cursory", blk("CURSORY.1", "a.ts:1", "text") + blk("CURSORY.2", "b.ts:1", "behavior") + blk("CURSORY.3", "c.ts:1", "behavior")),
    reader("simplifier", "nothing here\n")
  );
  assert.deepEqual(summaryLines("1", r.round), [
    "round 1 · head aaaaaaa · rows 3 (behavior 2, text 1) · leftovers 0 · banked 0",
    "refused: simplifier.md — no `### <ID> — <title>` blocks and no line starting `NO FINDINGS`",
  ]);
  assert.deepEqual(summaryLines("2", emptyRound()), ["round 2 · head bbbbbbb · rows 0 · leftovers 0 · banked 0"]);
});

test("table-<round>.md: the fixer's view of each row", () => {
  const r: Row = {
    ...row("CURSORY.2", "behavior", "a.ts:40-45, :50"),
    also: ["CODEX.1"],
    texts: [
      { id: "CURSORY.2", finding: "loop — retries forever", after: "ends after one try", invariant: "one retry", vacuity: "500s only" },
      { id: "CODEX.1", finding: "loop — no stop on 401", after: "stops" },
    ],
    history: [`1: fixed ${SHA} — x; confirm-1: review-cursory-codex unresolved — no`],
  };
  assert.equal(
    renderRoundTable("2", emptyRound([r, row("VERIFIER.1", "missing", "the brief")])),
    [
      "# Fix table — round 2",
      "",
      "head bbbbbbb · 2 rows. Write one line per row in fix-2.txt.",
      "",
      "## CURSORY.2 · behavior",
      "",
      "- also: CODEX.1",
      "- origin: reader, entered at round 1",
      "- locators: a.ts:40-45, a.ts:50-50",
      "- CURSORY.2: loop — retries forever",
      "  - after: ends after one try",
      "  - invariant: one retry",
      "  - vacuity: 500s only",
      "- CODEX.1: loop — no stop on 401",
      "  - after: stops",
      `- history: 1: fixed ${SHA} — x; confirm-1: review-cursory-codex unresolved — no`,
      "",
      "## VERIFIER.1 · missing",
      "",
      "- origin: reader, entered at round 1",
      "- locators: the brief (unparsed)",
      "- VERIFIER.1: title VERIFIER.1 — VERIFIER.1 is wrong",
      "  - after: VERIFIER.1 is right",
      "",
    ].join("\n")
  );
  assert.match(renderRoundTable("3", emptyRound()), /No rows: this round has no fixer\./);
});

test("leftovers list: one line per row or advice, as §1.7 prints it", () => {
  const final: FinalRound = {
    ...emptyRound(),
    open: [],
    leftovers: [
      { row: row("CURSORY.9", "text", "a.ts:12"), reason: "r" },
      { row: row("CODEX.3", "structure", "b.ts:4-9"), reason: "r" },
      { advice: { locator: "docs/x.md:3", text: "says 5 · is 6" }, reason: "prose drift (advisory)" },
    ],
  };
  assert.deepEqual(leftoverLines(final, "b42-x"), [
    "- b42-x · CURSORY.9 · text · a.ts:12 — title CURSORY.9 — CURSORY.9 is wrong (after: CURSORY.9 is right)",
    "- b42-x · CODEX.3 · structure · b.ts:4-9 — title CODEX.3 — CODEX.3 is wrong (after: CODEX.3 is right)",
    "- b42-x · advice · docs/x.md:3 — says 5 · is 6",
  ]);
});
