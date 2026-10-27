/**
 * `stats` (`stats.ts`): what recorded runs say. The cases build the run data a caller would read, so
 * each label, tail and fingerprint is checked against numbers worked out by hand.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type FixRound, type Kind, parseStageKey, type RoundId, type Row, type TableJson } from "../../runtime/lib/runFiles.ts";
import { type FixFile, parseFixFile } from "../../runtime/lib/fixFile.ts";
import { buildRound } from "../../runtime/lib/table.ts";
import { STRUGGLE_MIN_RUNS } from "../constants.ts";
import type { AttemptRecord, NodeRun, RunHistory, RunKind } from "../contracts.ts";
import { graph } from "../pipelines/build.ts";
import { fixReadStatuses } from "../pipelines/build/table.ts";
import { formatStats, type RunData, statsReport } from "../stats.ts";

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const row = (id: string, kind: Kind, over: Partial<Row> = {}): Row => ({ id, also: [], kind, locators: [], texts: [], origin: "reader", enteredAt: "1", history: [], ...over });
const table = (rows: Row[], leftovers: Row[] = []): TableJson => ({
  schema: 2,
  rounds: { "1": { head: "abc1234", rows, leftovers: leftovers.map((r) => ({ row: r, reason: "no round left" })), banked: [], closed: [], consumed: [], refused: [] } },
});

interface Call {
  answer: "yes" | "no";
  p: number;
  explored?: true;
  error?: string;
  /** Whether the gated reader ran. */
  ran?: boolean;
}
function run(
  name: string,
  hunter: Call,
  extra: { table?: TableJson | null; fixes?: RunData["fixes"]; fixReads?: RunData["fixReads"]; fixerRounds?: RunData["fixerRounds"]; kind?: RunKind } = {}
): RunData {
  const nodes: NodeRun[] = [
    { node: "C-silent-failures", iteration: 0, status: "done", answer: hunter.answer, p: hunter.p, ...(hunter.explored ? { explored: true as const } : {}), ...(hunter.error === undefined ? {} : { error: hunter.error }) },
    hunter.ran === false ? { node: "A-silent-failures", iteration: 0, status: "skipped", reason: "gate answered no" } : { node: "A-silent-failures", iteration: 0, status: "done" },
  ];
  const history: RunHistory = { runId: name, graph, runKind: extra.kind ?? "real", phase: "done", nodes, loops: [], asking: [], data: {} };
  return {
    name,
    graph: null,
    history,
    attempts: [],
    table: extra.table === undefined ? table([]) : extra.table,
    fixes: extra.fixes ?? new Map(),
    fixReads: extra.fixReads ?? new Map(),
    fixerRounds: extra.fixerRounds ?? new Map(),
    struggles: [],
    crosstalk: [],
    problems: [],
  };
}
const hunterOf = (runs: RunData[]) => statsReport(runs).classifiers.find((c) => c.node === "C-silent-failures")!;

test("a reader's row of an urgent kind labels its gate's decision 1; a row of another kind, or no row, labels it 0", () => {
  const c = hunterOf([
    run("r1", { answer: "yes", p: 0.8 }, { table: table([row("HUNTER.1", "behavior")]) }),
    run("r2", { answer: "yes", p: 0.6 }, { table: table([row("HUNTER.1", "text")]) }),
    run("r3", { answer: "yes", p: 0.4 }, { table: table([]) }),
  ]);
  assert.deepEqual([c.decisions, c.fired, c.labelled, c.positive], [3, 3, 3, 1]);
  assert.equal(c.meanPPositive, 0.8);
  assert.ok(Math.abs(c.meanPNegative! - 0.5) < 1e-9);
});

const HUNTER = "silent-failures";
const LIM = { near: 3, exactAbove: 30 };
const EXIT = "exit checks:\nvacuity: none — no rows\nmutation: none — no test\nbranches: none — no branch\nshared function: none\n";

const statusRead = (stage: string, answer: string) => {
  const key = parseStageKey(stage)!;
  return { stage: key, ran: true, files: [{ file: `${key.folder}/${HUNTER}.md`, reader: HUNTER, slice: null, text: `## Status\n- HUNTER.1 · ${answer}\n\n## New\nNO FINDINGS — nothing new\n` }] };
};

/** The table and fix files a run leaves when the hunter's wave row `HUNTER.1` of `kind` reached
 *  round `at`'s fixer, which wrote `line`, and the next round was built on the confirm read's `answer`
 *  (null: no read ran), all through the table library's own routing. Round 2 is reached by a round-1
 *  fix the confirm read found unresolved. */
function routed(kind: Kind, line: string, answer: string | null, at: "1" | "2" = "1"): { table: TableJson; fixes: ReadonlyMap<FixRound, FixFile> } {
  const wave = { file: `${HUNTER}.md`, reader: HUNTER, slice: null, text: `### HUNTER.1 — t\n- locator: src/a.ts:10\n- kind: ${kind}\n- finding: f\n- after: a\n` };
  let table = buildRound({ round: "1", head: "aaaaaaa", table: { schema: 2, rounds: {} }, isTarget: () => false, wave: [wave], merge: LIM }).table;
  const fixes = new Map<FixRound, FixFile>();
  const step = (fixed: "1" | "2", next: "2" | "3", text: string, read: string | null) => {
    const fix = `HUNTER.1 · ${text}\n${EXIT}`;
    const stage = fixed === "1" ? "confirm-1" : "confirm-2";
    table = buildRound({ round: next, head: "bbbbbbb", table, isTarget: () => false, fixes: { [fixed]: { file: `fix-${fixed}.txt`, text: fix } }, stages: read === null ? [] : [statusRead(stage, read)], merge: LIM }).table;
    fixes.set(fixed, parseFixFile(fix, { rows: ["HUNTER.1"], round: fixed }));
  };
  if (at === "2") step("1", "2", "fixed · 4f1c2a9 — done", "unresolved — still open");
  step(at, at === "1" ? "2" : "3", line, answer);
  return { table, fixes };
}

test("a row labels its decision by the kind the table carries it with: a drop or relabel the confirm read disagreed with keeps it urgent", () => {
  const cases: [string, ReturnType<typeof routed>, 0 | 1][] = [
    ["dropped, agreed", routed("behavior", "dropped — not a defect", "agree"), 0],
    ["dropped, disagreed", routed("behavior", "dropped — not a defect", "disagree — it is real"), 1],
    ["dropped, no read", routed("behavior", "dropped — not a defect", null), 0],
    ["relabelled down, agreed", routed("behavior", "relabel behavior→text — wording only", "agree", "2"), 0],
    ["relabelled down, disagreed", routed("behavior", "relabel behavior→text — wording only", "disagree — it is behaviour", "2"), 1],
    ["fixed and resolved", routed("behavior", "fixed · 4f1c2a9 — done", "resolved"), 1],
    ["fixed as a higher kind, unresolved", routed("structure", "fixed · 4f1c2a9 · kind=security — done", "unresolved — still open"), 1],
    ["fixed as a higher kind, resolved", routed("structure", "fixed · 4f1c2a9 · kind=security — done", "resolved"), 1],
    ["fixed as a higher kind, no read", routed("structure", "fixed · 4f1c2a9 · kind=security — done", null), 1],
    ["fixed as a lower kind, resolved", routed("structure", "fixed · 4f1c2a9 · kind=text — done", "resolved"), 0],
    ["fixed as a lower kind, unresolved", routed("behavior", "fixed · 4f1c2a9 · kind=text — done", "unresolved — still open"), 1],
    ["a structure row fixed and resolved", routed("structure", "fixed · 4f1c2a9 — done", "resolved"), 0],
  ];
  for (const [what, { table, fixes }, label] of cases) {
    const c = hunterOf([run("r1", { answer: "yes", p: 0.7 }, { table, fixes })]);
    assert.deepEqual([c.labelled, c.positive], [1, label], what);
  }
});

const CURSORY = "review";
const SEC = "security";
const emptyRound = (head: string) => ({ head, rows: [], leftovers: [], banked: [], closed: [], consumed: [], refused: [] });

/** A finding block the confirm read raises as new, numbered `n` (in its stage's id range). */
const fresh = (n: number, kind: Kind): string => `### CURSORY.${n} — t2\n- locator: src/b.ts:5\n- kind: ${kind}\n- finding: f\n- after: a\n`;
const NONE = "NO FINDINGS — nothing new\n";

/** What a run leaves when `CURSORY.1` (of `kind`) reached fix round `fixed`'s fixer, which fixed it,
 *  and the round after was built on the confirm read (its `status` for CURSORY.1 and its `## New`
 *  section `news`), through the table library's own routing. Round 1's row comes from the wave; an
 *  escalate row is seeded after empty rounds 2 and 3. The fix reads come back from a mirror of the
 *  read through `fixReadStatuses`, as `runDirs` reads a run's. */
function confirmed(news: string, status = "resolved", over: { kind?: Kind; fixed?: "1" | "escalate" } = {}): Pick<RunData, "table" | "fixes" | "fixReads"> {
  const kind = over.kind ?? "behavior";
  const fixed = over.fixed ?? "1";
  const wave = { file: `${CURSORY}.md`, reader: CURSORY, slice: null, text: `### CURSORY.1 — t\n- locator: src/a.ts:10\n- kind: ${kind}\n- finding: f\n- after: a\n` };
  const first =
    fixed === "1"
      ? buildRound({ round: "1", head: "aaaaaaa", table: { schema: 2, rounds: {} }, isTarget: () => false, wave: [wave], merge: LIM }).table
      : { schema: 2 as const, rounds: { "1": emptyRound("aaaaaaa"), "2": emptyRound("aaaaaaa"), "3": emptyRound("aaaaaaa"), escalate: { ...emptyRound("aaaaaaa"), rows: [row("CURSORY.1", kind)] } } };
  const fix = `CURSORY.1 · fixed · 4f1c2a9 — done\n${EXIT}`;
  const key = parseStageKey(fixed === "1" ? "confirm-1" : "escalate")!;
  const text = `## Status\n- CURSORY.1 · ${status}\n\n## New\n${news}`;
  const read = { stage: key, ran: true, files: [{ file: `${key.folder}/${CURSORY}.md`, reader: CURSORY, slice: null, text }] };
  const table = buildRound({ round: fixed === "1" ? "2" : "final", head: "bbbbbbb", table: first, isTarget: () => false, fixes: { [fixed]: { file: `fix-${fixed}.txt`, text: fix } }, stages: [read], merge: LIM }).table;
  const fixes = new Map<FixRound, FixFile>([[fixed, parseFixFile(fix, { rows: ["CURSORY.1"], round: fixed })]]);
  const mirror = mkdtempSync(join(tmpdir(), "stats-mirror-"));
  try {
    mkdirSync(join(mirror, key.folder));
    writeFileSync(join(mirror, key.folder, `${CURSORY}.md`), text);
    return { table, fixes, fixReads: fixReadStatuses(mirror, table, fixes) };
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

/** A run whose close loop's iteration 1 asked C-review-fix about the fix of round `fixerRounds.get(1)`. */
function rereviewRun(name: string, call: Call, routedRun: ReturnType<typeof confirmed>, fixerRounds: RunData["fixerRounds"] = new Map<number, RoundId>([[1, "1"]])): RunData {
  const d = run(name, { answer: "yes", p: 0.5 }, { ...routedRun, fixerRounds });
  d.history!.nodes.push(
    { node: "C-review-fix", iteration: 1, status: "done", answer: call.answer, p: call.p },
    call.ran === false ? { node: "A-review-fix", iteration: 1, status: "skipped", reason: "gate answered no" } : { node: "A-review-fix", iteration: 1, status: "done" }
  );
  return d;
}
const rereviewOf = (runs: RunData[]) => statsReport(runs).classifiers.find((c) => c.node === "C-review-fix")!;

test("a C-review-fix decision at a loop iteration is 1 when the confirm read raised a new urgent row or sent an urgent fix back unresolved, else 0", () => {
  // An urgent row another stage's read raised that entered at the same round is not this read's.
  const foreign = confirmed(NONE);
  foreign.table!.rounds["2"]!.rows.push(row("CURSORY.601", "behavior", { enteredAt: "2" }));
  // An unresolved another reader gave counts for that reader, not for the gated one.
  const otherReader = confirmed(NONE, "unresolved — still open");
  const fixReads = new Map([...otherReader.fixReads].map(([r, ss]) => [r, ss.map((s) => ({ ...s, reader: SEC }))] as const));
  const cases: [string, ReturnType<typeof confirmed>, 0 | 1][] = [
    ["a new behavior row", confirmed(fresh(101, "behavior")), 1],
    ["a new structure row", confirmed(fresh(101, "structure")), 0],
    ["no new row; the fixed row resolved", confirmed(NONE), 0],
    ["no new row; the fixed behavior row reported unresolved", confirmed(NONE, "unresolved — still open"), 1],
    ["no new row; a fixed structure row reported unresolved", confirmed(NONE, "unresolved — still open", { kind: "structure" }), 0],
    ["no new row; an unresolved from a reader the classifier does not gate", { ...otherReader, fixReads }, 0],
    ["no new row; an urgent row of another stage's range", foreign, 0],
  ];
  for (const [what, routedRun, label] of cases) {
    const c = rereviewOf([rereviewRun("r1", { answer: "yes", p: 0.98 }, routedRun)]);
    assert.deepEqual([c.decisions, c.labelled, c.positive], [1, 1, label], what);
  }
});

test("a C-review-fix decision on the escalate round's fix reads what final took in: its open rows and its carried fixes", () => {
  const escalate = new Map<number, RoundId>([[1, "escalate"]]);
  const cases: [string, ReturnType<typeof confirmed>, 0 | 1][] = [
    ["a new behavior row, held only in final's open", confirmed(fresh(401, "behavior"), "resolved", { fixed: "escalate" }), 1],
    ["the fixed behavior row reported unresolved, held only in final's open", confirmed(NONE, "unresolved — still open", { fixed: "escalate" }), 1],
    ["no new row, the fix resolved", confirmed(NONE, "resolved", { fixed: "escalate" }), 0],
  ];
  for (const [what, routedRun, label] of cases) {
    const c = rereviewOf([rereviewRun("r1", { answer: "yes", p: 0.98 }, routedRun, escalate)]);
    assert.deepEqual([c.decisions, c.labelled, c.positive], [1, 1, label], what);
  }
});

test("C-review-fix's rows split by the fix round's population: the items the fixer's fan-out ran over at the decision's iteration", () => {
  const sliced = (name: string, slices: string[] | null, routedRun: ReturnType<typeof confirmed>, p: number): RunData => {
    const d = rereviewRun(name, { answer: "yes", p }, routedRun);
    if (slices !== null) d.history!.fanOuts = [{ fanOut: "fix-slices", iteration: 1, items: slices }];
    return d;
  };
  const report = statsReport([
    sliced("r1", ["S1"], confirmed(fresh(101, "behavior")), 0.9),
    sliced("r2", ["S1", "S2"], confirmed(NONE), 0.4),
    sliced("r3", ["S1", "S2", "S3"], confirmed(NONE, "unresolved — still open"), 0.7),
    sliced("r4", null, confirmed(NONE), 0.2),
  ]);
  const rows = report.classifiers.filter((c) => c.node === "C-review-fix").map((c) => [c.population, c.decisions, c.labelled, c.positive, c.meanPPositive, c.meanPNegative]);
  assert.deepEqual(rows, [
    [null, 1, 1, 0, null, 0.2],
    ["single-slice", 1, 1, 1, 0.9, null],
    ["multi-slice", 2, 2, 1, 0.7, 0.4],
  ]);
  assert.deepEqual(
    report.classifiers.filter((c) => c.node === "C-silent-failures").map((c) => [c.population, c.decisions]),
    [[null, 4]],
    "a decision outside the loop has no population"
  );
  assert.match(formatStats(report), /\n {2}C-review-fix \(multi-slice\) {2}2 {2}2 {2}0 {2}0; {2}2 {2}1 {2}0\.70 {2}0\.40\n/);
});

test("a C-review-fix decision has no label when its confirm read was skipped or its iteration's fix round is unknown", () => {
  const c = rereviewOf([rereviewRun("r1", { answer: "no", p: 0.9, ran: false }, confirmed(NONE)), rereviewRun("r2", { answer: "yes", p: 0.99 }, confirmed(NONE), new Map())]);
  assert.deepEqual([c.decisions, c.labelled], [2, 0]);
});

test("a leftover (a row no round was left to fix) counts as a row, and a leftover with no row does not", () => {
  const c = hunterOf([
    run("r1", { answer: "yes", p: 0.9 }, { table: table([], [row("HUNTER.1", "security")]) }),
    run("r2", { answer: "yes", p: 0.9 }, {
      table: { schema: 2, rounds: { "1": { head: "abc1234", rows: [], leftovers: [{ reason: "no row recorded" }], banked: [], closed: [], consumed: [], refused: [] } } },
    }),
  ]);
  assert.deepEqual([c.labelled, c.positive], [2, 1]);
});

test("a decision that failed open has no label, however its reader's rows came out, and is counted as an error", () => {
  const c = hunterOf([
    run("r1", { answer: "yes", p: 0.5, error: "Jev HTTP 503: down (after 3 tries)" }, { table: table([row("HUNTER.1", "behavior")]) }),
    run("r2", { answer: "yes", p: 0.8 }, { table: table([row("HUNTER.1", "behavior")]) }),
  ]);
  assert.deepEqual([c.decisions, c.errors, c.labelled, c.positive], [2, 1, 1, 1]);
  assert.equal(c.meanPPositive, 0.8, "the failed-open p of 0.5 is in no mean");
});

test("an explored no is labelled by the reader that ran anyway, and a no whose reader was skipped has no label", () => {
  const c = hunterOf([
    run("r1", { answer: "no", p: 0.2, explored: true }, { table: table([row("HUNTER.1", "behavior")]) }),
    run("r2", { answer: "no", p: 0.1, ran: false }, { table: table([]) }),
  ]);
  assert.deepEqual([c.decisions, c.fired, c.explored, c.labelled, c.positive], [2, 0, 1, 1, 1]);
});

test("mock runs are counted only when there are no real ones, and are left out beside them", () => {
  const real = run("real-1", { answer: "yes", p: 0.8 });
  const mock = run("mock-1", { answer: "yes", p: 0.8 }, { kind: "mock" });
  const both = statsReport([real, mock]);
  assert.deepEqual([both.kind, both.counted, both.leftOut], ["real", 1, 1]);
  assert.deepEqual(statsReport([mock]).kind, "mock");
  assert.equal(formatStats(statsReport([])), "no runs\n");
});

// ---- nodes and runs ----

const attempt = (node: string, start: number, end: number | undefined, over: Partial<AttemptRecord> = {}): RunData["attempts"][number] => ({
  key: `nodes/${node}/0`,
  record: { node, iteration: 0, rerun: 0, attempt: 1, startedAt: at(start), ...(end === undefined ? {} : { endedAt: at(end), outcome: "done" as const }), ...over },
});

test("a node's tail is its attempts' durations, its margin is the cap less the longest, and an attempt that never ended is lost", () => {
  const cap = graph.nodes.find((n) => n.id === "A-silent-failures")!.timeCapMs;
  const d = run("r1", { answer: "yes", p: 0.8 });
  d.attempts = [
    ...[60, 120, 180, 240, 300].map((s, i) => attempt("A-silent-failures", i * 1_000_000, i * 1_000_000 + s * 1000)),
    attempt("A-silent-failures", 9_000_000, undefined),
  ];
  const n = statsReport([d]).nodes.find((x) => x.node === "A-silent-failures")!;
  assert.deepEqual([n.attempts, n.lost, n.p50Ms, n.p90Ms, n.maxMs], [6, 1, 180_000, 300_000, 300_000]);
  assert.equal(n.capMs, cap);
  assert.equal(n.marginMs, cap - 300_000);
  assert.equal(n.capHits, 0);
});

test("an attempt aborted within the teardown budget of its cap is a cap hit, and one aborted early is not", () => {
  const cap = graph.nodes.find((n) => n.id === "A-silent-failures")!.timeCapMs;
  const d = run("r1", { answer: "yes", p: 0.8 });
  d.attempts = [attempt("A-silent-failures", 0, cap - 1_000, { outcome: "aborted" }), attempt("A-silent-failures", 0, 60_000, { outcome: "aborted", attempt: 2 })];
  assert.equal(statsReport([d]).nodes.find((x) => x.node === "A-silent-failures")!.capHits, 1);
});

test("a run's cost sums its agents' costs and is a floor when an agent reported none", () => {
  const d = run("r1", { answer: "yes", p: 0.8 });
  d.attempts = [attempt("A-silent-failures", 0, 600_000, { costUsd: 1.25 }), attempt("A-completeness", 0, 900_000, { costUsd: null }), attempt("K-tests", 0, 1000_000)];
  const r = statsReport([d]).runs[0]!;
  assert.equal(r.costUsd, 1.25);
  assert.equal(r.costIsFloor, true);
  assert.equal(r.wallMs, 1_000_000);
  assert.match(formatStats(statsReport([d])), /r1 {2}real {2}done {2}16\.7m {2}\$1\.25 or more/);
});

test("restarted writer attempts count each run's latest restart once, while a merge conflict itself adds none", () => {
  const first = run("restart-1", { answer: "yes", p: 0.8 });
  first.attempts = [
    attempt("A-builder", 0, 1_000),
    attempt("A-builder", 2_000, 3_000, { rerun: 1, conflict: { commit: "writer-first", paths: ["graph/stats.ts"], restart: 1 } }),
    attempt("A-builder", 4_000, 5_000, { rerun: 1, attempt: 2, conflict: { commit: "writer-first", paths: ["graph/stats.ts"], restart: 1 } }),
    attempt("D-merge-part", 6_000, 7_000, { outcome: "merge-conflict", conflict: { commit: "writer-first", paths: ["graph/stats.ts"] } }),
  ];
  const second = run("restart-2", { answer: "yes", p: 0.8 });
  second.attempts = [
    { ...attempt("A-builder", 0, 1_000, { rerun: 1, conflict: { commit: "writer-second", paths: ["graph/contracts.ts"], restart: 1 } }), key: "nodes/A-builder/0/other-item" },
    { ...attempt("A-builder", 2_000, 3_000, { rerun: 2, conflict: { commit: "writer-second", paths: ["graph/contracts.ts"], restart: 2 } }), key: "nodes/A-builder/0/other-item" },
  ];

  const report = statsReport([first, second]);
  assert.deepEqual(report.runs.map((r) => [r.run, r.restarts]), [["restart-1", 1], ["restart-2", 2]]);
  assert.deepEqual(
    report.nodes.map((n) => [n.node, n.restarts]),
    [["A-builder", 3], ["D-merge-part", 0]]
  );
  const formatted = formatStats(statsReport([first]));
  assert.match(formatted, /runs \(wall, cost: Claude at list price, Codex unpriced, restarts\)/);
  assert.match(formatted, /nodes \(attempts, p50, p90, max, cap, margin, cap hits, lost, restarts\)/);
  assert.match(formatted, /\n  restart-1 .*  1\n/);
  assert.match(formatted, /\n  A-builder .*  0  1\n/);
});

test("runs without a merge-conflict record report zero restarts for every node", () => {
  const clean = run("clean", { answer: "yes", p: 0.8 });
  clean.attempts = [attempt("A-builder", 0, 1_000), attempt("D-merge-part", 2_000, 3_000)];
  const report = statsReport([clean]);
  assert.equal(report.runs[0]!.restarts, 0);
  assert.deepEqual(report.nodes.map((n) => [n.node, n.restarts]), [["A-builder", 0], ["D-merge-part", 0]]);
});

// ---- struggles ----

test("a struggle seen in three runs is printed; fewer is not; a malformed entry is dropped with a line saying so", () => {
  const entry = { category: "Missing Context", where: "src/a.ts", needed: "The test command.\nMore detail." };
  const runs = ["r1", "r2", "r3"].map((name) => {
    const d = run(name, { answer: "yes", p: 0.8 });
    d.attempts = [attempt("A-silent-failures", 0, 1000)];
    d.struggles = [{ key: "nodes/A-silent-failures/0", file: "nodes/A-silent-failures/0/out/x/struggles.json", raw: [entry, { category: "x" }] }];
    return d;
  });
  const rare = run("r4", { answer: "yes", p: 0.8 });
  rare.attempts = [attempt("A-silent-failures", 0, 1000)];
  rare.struggles = [{ key: "nodes/A-silent-failures/0", file: "nodes/A-silent-failures/0/out/x/struggles.json", raw: [{ category: "other", where: "b.ts", needed: "a thing" }] }];
  const report = statsReport([...runs, rare]);
  assert.equal(STRUGGLE_MIN_RUNS, 3);
  assert.deepEqual(report.struggles, [{ fingerprint: "missing context · src/a.ts · the test command", runs: ["r1", "r2", "r3"] }]);
  assert.ok(report.problems.some((p) => /r1: .*entry 2 lacks a category, where or needed; dropped/.test(p)));
});

test("an attempt with no exit writes no struggles into the count", () => {
  const entry = { category: "c", where: "w", needed: "n" };
  const runs = ["r1", "r2", "r3"].map((name) => {
    const d = run(name, { answer: "yes", p: 0.8 });
    d.attempts = [attempt("A-silent-failures", 0, undefined)];
    d.struggles = [{ key: "nodes/A-silent-failures/0", file: "f", raw: [entry] }];
    return d;
  });
  assert.deepEqual(statsReport(runs).struggles, []);
});

// ---- crosstalk ----

const msg = (to: string, text: string, over: Record<string, unknown> = {}): string => JSON.stringify({ at: at(0), to, session: "r1-A-fixer-2-S2", text, ...over });
const CROSS_KEY = "nodes/A-fixer/2/S1";
const CROSS_FILE = `${CROSS_KEY}/out/slice-fix/crosstalk.jsonl`;

function crossRun(name: string, text: string, opts: { withAttempt?: boolean; rounds?: RunData["fixerRounds"]; kind?: RunKind } = {}): RunData {
  const d = run(name, { answer: "yes", p: 0.8 }, { kind: opts.kind, fixerRounds: opts.rounds ?? new Map([[2, "3" as RoundId]]) });
  if (opts.withAttempt !== false) d.attempts = [{ key: CROSS_KEY, record: { node: "A-fixer", iteration: 2, instance: "S1", rerun: 0, attempt: 1, startedAt: at(0) } }];
  d.crosstalk = [{ key: CROSS_KEY, file: CROSS_FILE, text }];
  return d;
}

test("a fixer's message prints with its run, fix round, slice, recipient and only the first line of its text", () => {
  const text = `${msg("S2", "  Rename foo to bar.\nSecond line stays out.  ")}\n`;
  const report = statsReport([crossRun("r1", text)]);
  assert.deepEqual(report.crosstalk, [{ run: "r1", nodeRun: CROSS_KEY, iteration: 2, round: "3", slice: "S1", to: "S2", firstLine: "Rename foo to bar." }]);
  const out = formatStats(report);
  assert.match(out, /\ncrosstalk \(run, fix round, slice, to, first line\)\n {2}r1 {2}round 3 {2}S1 {2}-> S2 {2}Rename foo to bar\.\n/);
  assert.ok(!out.includes("Second line"));
});

test("a run with no crosstalk prints the section header and none", () => {
  const out = formatStats(statsReport([run("r1", { answer: "yes", p: 0.8 })]));
  assert.match(out, /\ncrosstalk \(run, fix round, slice, to, first line\)\n {2}none\n/);
});

test("a bad crosstalk line is dropped with a problem naming the file and line, and the good lines still print", () => {
  const text = `${[msg("S2", "first"), "not json at all", "", msg("S3", "third", { session: undefined }), msg("S4", "fourth")].join("\n")}\n`;
  const report = statsReport([crossRun("r1", text)]);
  assert.deepEqual(report.crosstalk.map((c) => c.to), ["S2", "S4"]);
  assert.ok(report.problems.includes(`r1: ${CROSS_FILE} line 2: not JSON; dropped`), report.problems.join("\n"));
  assert.ok(report.problems.some((p) => p.startsWith(`r1: ${CROSS_FILE} line 4: session not a string; dropped`)), report.problems.join("\n"));
  assert.equal(report.problems.length, 2);
  const out = formatStats(report);
  assert.match(out, /-> S2 {2}first\n {2}r1 .*-> S4 {2}fourth\n/);
  assert.match(out, /not read\n.*line 2/);
});

test("a message from an iteration with no recorded round prints the iteration; with no attempt record it prints the node run", () => {
  const text = msg("S2", "hello");
  const noRound = statsReport([crossRun("r1", text, { rounds: new Map() })]);
  assert.match(formatStats(noRound), /\n {2}r1 {2}iteration 2 {2}S1 {2}-> S2 {2}hello\n/);
  const noAttempt = statsReport([crossRun("r1", text, { withAttempt: false })]);
  assert.deepEqual([noAttempt.crosstalk[0]!.iteration, noAttempt.crosstalk[0]!.round, noAttempt.crosstalk[0]!.slice], [null, null, null]);
  assert.match(formatStats(noAttempt), new RegExp(`\\n {2}r1 {2}${CROSS_KEY} {2}- {2}-> S2 {2}hello\\n`));
});

test("a mock run's crosstalk is left out when a real run exists", () => {
  const report = statsReport([crossRun("real1", msg("S2", "from real")), crossRun("mock1", msg("S9", "from mock"), { kind: "mock" })]);
  assert.deepEqual(report.crosstalk.map((c) => c.run), ["real1"]);
});
