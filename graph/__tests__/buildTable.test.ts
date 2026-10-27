/**
 * The build graph's fix table (`pipelines/build/table.ts`): how an answer becomes a row, the graph's
 * own round intake, hand-test numbering in the mirror, and the final round's verdict.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parseSessionFile, type Round, serialiseTableJson, type TableJson } from "../../runtime/lib/runFiles.ts";
import { EXIT_CHECKS } from "../../runtime/lib/fixFile.ts";
import { buildRound, roundIntake } from "../../runtime/lib/table.ts";
import { DEFAULTS } from "../../runtime/thresholds.ts";
import type { OpContext } from "../adapters/types.ts";
import type { DataValues, FilesValue } from "../contracts.ts";
import { editedAssertionRows } from "../pipelines/build/checks.ts";
import { DRAFT_FILE, type DraftFile } from "../pipelines/build/slices.ts";
import { answeredKind, finalTable, fixTable, graphIntake, mirrorHandTests, type TableState } from "../pipelines/build/table.ts";
import { opContext } from "./helpers/opContext.ts";

const round = (over: Partial<Round> = {}): Round => ({ head: "h", rows: [], leftovers: [], banked: [], closed: [], consumed: [], refused: [], ...over });
const STATE: TableState = { round: "escalate", rows: [], fixed: ["1", "2", "3"], driftGroups: 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [] };

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A run dir with a one-commit repo as its run tree, and a D-final-table context over `table`. */
function finalCtx(table: TableJson, state: TableState): { ctx: OpContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "graph-table-"));
  const tree = join(dir, "tree");
  mkdirSync(tree);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tree });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: tree });
  const files = (...paths: string[]): FilesValue => ({ schema: "files", files: paths });
  const inputs: DataValues = {
    table: files(put(join(dir, "in", "table", "table.json"), serialiseTableJson(table)), put(join(dir, "in", "table", "state.json"), JSON.stringify(state))),
    "repo-config": files(put(join(dir, "in", "repo-config.json"), JSON.stringify({ tree, stepsFile: "", steps: {}, notes: {}, briefsDir: null, baseRef: "main", thresholds: DEFAULTS }))),
  };
  const ctx = opContext(dir, { nodeId: "D-final-table", role: "final-table", inputs, outputs: ["has-leftovers", "final-clean"], place: { worktree: tree } });
  return { ctx, dir };
}

const verdict = (r: Awaited<ReturnType<typeof finalTable>>, id: string) => (r.status === "done" && r.outputs[id]?.schema === "check" ? r.outputs[id] : undefined);

test("an answered decision stays urgent; only a row that was not urgent becomes structure", () => {
  for (const k of ["behavior", "security"] as const) assert.equal(answeredKind(k), k);
  assert.equal(answeredKind("missing"), "behavior", "missing is legal only on a VERIFIER id; the answer is a SESSION row");
  const block = ["### SESSION.2 — VERIFIER.1 answered", "- locator: brief.md:1", `- kind: ${answeredKind("missing")}`, "- stage: confirm-1", "- finding: f", "- after: a"].join("\n");
  assert.equal(parseSessionFile(block)[0]?.kind, "behavior");
  for (const k of ["structure", "text"] as const) assert.equal(answeredKind(k), "structure");
  assert.equal(answeredKind(undefined), "structure");
});

test("the graph's round 1 reads the wave's hand test; today's round 1 still does not", () => {
  const empty: TableJson = { schema: 2, rounds: {} };
  assert.equal(roundIntake("1", empty).handTests, false);
  const intake = graphIntake("1", empty, STATE, { drift: true });
  assert.equal(intake.handTests, true);
  const built = buildRound({
    round: "1",
    head: "h",
    table: empty,
    isTarget: () => true,
    handTests: [{ file: "hand-test-1.txt", n: 1, text: "H1 · fail (code) · abc1234 — hand-test-1/H1.out — exit 1, not 0\n" }],
    merge: { near: 3, exactAbove: 30 },
    intake,
  });
  assert.deepEqual(built.round.rows.map((r) => [r.id, r.kind]), [["HAND.1", "behavior"]]);
});

test("a fixed round after a drift round's fixer carries the drift round, and the final round then does not", () => {
  const table: TableJson = { schema: 2, rounds: { "1": round(), "2": round(), "drift-1": round() } };
  const state = { fixed: ["1", "2", "drift-1"], carriedDrift: [] as string[] };
  const three = graphIntake("3", table, state, { drift: true });
  assert.deepEqual(three.carry.map((c) => c.from), ["2", "drift-1"]);
  assert.ok(three.newStages.some((s) => s.key === "drift-confirm-1"));
  assert.deepEqual(graphIntake("3", table, { fixed: ["1", "2"], carriedDrift: [] }, { drift: true }).carry.map((c) => c.from), ["2"], "a drift round no fixer took is not carried");
  assert.ok(graphIntake("final", table, state, { drift: false }).carry.some((c) => c.from === "drift-1"));
  assert.ok(!graphIntake("final", table, { ...state, carriedDrift: ["drift-1"] }, { drift: false }).carry.some((c) => c.from === "drift-1"));
});

test("a later hand test is mirrored as number iteration + 1, its output paths with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-hand-"));
  const out = join(dir, "nodes", "A-hand-test-fix", "2", "out", "hand-results-fix");
  const txt = put(join(out, "hand-test-1.txt"), "H1 · pass · abc1234 — hand-test-1/H1.out\n");
  const output = put(join(out, "hand-test-1", "H1.out"), "ok\n");
  const s = structuredClone(STATE);
  mirrorHandTests({ schema: "files", files: [txt, output] }, join(dir, "close"), s);
  assert.equal(readFileSync(join(dir, "close", "hand-test-3.txt"), "utf8"), "H1 · pass · abc1234 — hand-test-3/H1.out\n");
  assert.ok(existsSync(join(dir, "close", "hand-test-3", "H1.out")));
  assert.ok(!existsSync(join(dir, "close", "hand-test-1.txt")));
  rmSync(dir, { recursive: true });
});

test("an escalate round's rows finalise as open without a fix file: escalate has no fixer", async () => {
  const row = { id: "VERIFIER.1", also: [], kind: "behavior" as const, locators: [], texts: [{ id: "VERIFIER.1", finding: "f", after: "a" }], origin: "reader" as const, enteredAt: "3" as const, history: [] };
  const table: TableJson = { schema: 2, rounds: { "1": round(), "2": round(), "3": round(), escalate: round({ rows: [row] }) } };
  const { ctx, dir } = finalCtx(table, STATE);
  const r = await finalTable(ctx);
  const clean = verdict(r, "final-clean");
  assert.equal(clean?.answer, "fail");
  assert.match(clean?.detail ?? "", /VERIFIER\.1 behavior/);
  assert.match(readFileSync(join(dir, "close", "fix-escalate.txt"), "utf8"), /^VERIFIER\.1 · blocked — /);
  rmSync(dir, { recursive: true });
});

test("final-clean fails while a banked decision waits unanswered, and passes once it is answered", async () => {
  const table: TableJson = { schema: 2, rounds: { "1": round({ banked: [{ id: "SIMP.4", question: "structure — split it?" }] }), "2": round(), "3": round(), escalate: round() } };
  const a = finalCtx(table, STATE);
  const waiting = verdict(await finalTable(a.ctx), "final-clean");
  assert.equal(waiting?.answer, "fail");
  assert.match(waiting?.detail ?? "", /SIMP\.4 banked, unanswered/);
  rmSync(a.dir, { recursive: true });
  const b = finalCtx(table, { ...STATE, answered: ["SIMP.4"] });
  assert.equal(verdict(await finalTable(b.ctx), "final-clean")?.answer, "pass");
  rmSync(b.dir, { recursive: true });
});

// ---- a loop capped before its fixer: D-final-table writes the missing fix files as blocked ----

const rowOf = (id: string, kind: "behavior" | "structure", enteredAt: "1" | "2" | "3" = "1") => ({
  id,
  also: [],
  kind,
  locators: [],
  texts: [{ id, finding: "f", after: "a" }],
  origin: "reader" as const,
  enteredAt,
  history: [],
});
const mirrorFile = (dir: string, name: string) => join(dir, "close", name);

test("a round 1 left unfixed by the cap gets a blocked fix file, so its urgent row finalises as open", async () => {
  const table: TableJson = { schema: 2, rounds: { "1": round({ rows: [rowOf("VERIFIER.1", "behavior")] }) } };
  const { ctx, dir } = finalCtx(table, STATE);
  const r = await finalTable(ctx);
  const text = readFileSync(mirrorFile(dir, "fix-1.txt"), "utf8");
  assert.match(text, /^VERIFIER\.1 · blocked — no fixer ran on round 1: the run's fixer rounds are spent\n/);
  assert.match(text, /\nexit checks:\n/);
  assert.equal(verdict(r, "final-clean")?.answer, "fail");
  assert.match(verdict(r, "final-clean")?.detail ?? "", /VERIFIER\.1 behavior/);
  rmSync(dir, { recursive: true });
});

test("a round 2 or 3 left unfixed by the cap is blocked the same way, when the next round is the one built", async () => {
  const two: TableJson = { schema: 2, rounds: { "1": round(), "2": round({ rows: [rowOf("SIMP.2", "structure", "2")] }) } };
  const a = finalCtx(two, STATE);
  await finalTable(a.ctx);
  assert.match(readFileSync(mirrorFile(a.dir, "fix-2.txt"), "utf8"), /^SIMP\.2 · blocked — no fixer ran on round 2/);
  assert.ok(!existsSync(mirrorFile(a.dir, "fix-1.txt")), "round 1 held no rows: nothing to block");
  rmSync(a.dir, { recursive: true });
  const three: TableJson = { schema: 2, rounds: { "1": round(), "2": round(), "3": round({ rows: [rowOf("SIMP.3", "structure", "3")] }) } };
  const b = finalCtx(three, STATE);
  await finalTable(b.ctx);
  assert.match(readFileSync(mirrorFile(b.dir, "fix-3.txt"), "utf8"), /^SIMP\.3 · blocked — no fixer ran on round 3/);
  rmSync(b.dir, { recursive: true });
});

test("a non-urgent row the cap left unfixed is a leftover, not an open row: final-clean passes and has-leftovers passes", async () => {
  const table: TableJson = { schema: 2, rounds: { "1": round({ rows: [rowOf("SIMP.1", "structure")] }) } };
  const { ctx, dir } = finalCtx(table, STATE);
  const r = await finalTable(ctx);
  assert.equal(verdict(r, "final-clean")?.answer, "pass");
  assert.equal(verdict(r, "has-leftovers")?.answer, "pass");
  assert.match(readFileSync(mirrorFile(dir, "fix-1.txt"), "utf8"), /^SIMP\.1 · blocked — /);
  rmSync(dir, { recursive: true });
});

test("a fix file the mirror already holds is never overwritten by the blocked one", async () => {
  const table: TableJson = { schema: 2, rounds: { "1": round({ rows: [rowOf("SIMP.1", "structure")] }) } };
  const { ctx, dir } = finalCtx(table, STATE);
  const written = `SIMP.1 · blocked — written by a real fixer\n\nexit checks:\n${EXIT_CHECKS.map((k) => `${k}: none — mine`).join("\n")}\n`;
  put(mirrorFile(dir, "fix-1.txt"), written);
  await finalTable(ctx);
  assert.equal(readFileSync(mirrorFile(dir, "fix-1.txt"), "utf8"), written);
  rmSync(dir, { recursive: true });
});

test("a run whose rounds are all empty writes no blocked fix file and finalises clean", async () => {
  const table: TableJson = { schema: 2, rounds: { "1": round(), "2": round(), "3": round(), escalate: round() } };
  const { ctx, dir } = finalCtx(table, STATE);
  const r = await finalTable(ctx);
  for (const n of ["1", "2", "3", "escalate"]) assert.ok(!existsSync(mirrorFile(dir, `fix-${n}.txt`)), n);
  assert.equal(verdict(r, "final-clean")?.answer, "pass");
  assert.equal(verdict(r, "has-leftovers")?.answer, "fail");
  rmSync(dir, { recursive: true });
});

// ---- the wave's hand test, mirrored as hand test 1 ----

const waveOutput = (dir: string, iteration: number, id = "hand-results") => join(dir, "nodes", "A-hand-test", String(iteration), "out", id);

test("the wave's hand test (iteration 0) is mirrored as hand-test-1, its output paths with it, and not mirrored twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-hand-"));
  const out = waveOutput(dir, 0);
  const txt = put(join(out, "hand-test-1.txt"), "H1 · fail (code) · abc1234 — hand-test-1/H1.out — exit 1, not 0\n");
  const output = put(join(out, "hand-test-1", "H1.out"), "boom\n");
  const s = structuredClone(STATE);
  const value = { schema: "files" as const, files: [txt, output] };
  const copied = mirrorHandTests(value, join(dir, "close"), s);
  assert.deepEqual(copied.sort(), [join(dir, "close", "hand-test-1", "H1.out"), join(dir, "close", "hand-test-1.txt")].sort());
  assert.equal(readFileSync(join(dir, "close", "hand-test-1.txt"), "utf8"), "H1 · fail (code) · abc1234 — hand-test-1/H1.out — exit 1, not 0\n");
  assert.deepEqual(s.seen.sort(), [output, txt].sort());
  assert.deepEqual(mirrorHandTests(value, join(dir, "close"), s), [], "a file already seen is not copied again");
  rmSync(dir, { recursive: true });
});

test("a hand-test file whose name does not match keeps its relative path, and an undefined input mirrors nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-hand-"));
  const other = put(join(waveOutput(dir, 0), "notes", "extra.txt"), "x\n");
  const s = structuredClone(STATE);
  assert.deepEqual(mirrorHandTests({ schema: "files", files: [other] }, join(dir, "close"), s), [join(dir, "close", "notes", "extra.txt")]);
  assert.deepEqual(mirrorHandTests(undefined, join(dir, "close"), s), []);
  assert.deepEqual(mirrorHandTests({ schema: "text", text: "no files" }, join(dir, "close"), s), []);
  rmSync(dir, { recursive: true });
});

test("hand tests from successive runs are numbered by iteration, so none overwrites an earlier one", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-hand-"));
  const s = structuredClone(STATE);
  const first = put(join(waveOutput(dir, 0), "hand-test-1.txt"), "H1 · fail (code) · a — hand-test-1/H1.out — x\n");
  const second = put(join(waveOutput(dir, 1, "hand-results-fix"), "hand-test-1.txt"), "H1 · pass · b — hand-test-1/H1.out\n");
  mirrorHandTests({ schema: "files", files: [first] }, join(dir, "close"), s);
  mirrorHandTests({ schema: "files", files: [second] }, join(dir, "close"), s);
  assert.match(readFileSync(join(dir, "close", "hand-test-1.txt"), "utf8"), /fail \(code\)/);
  assert.match(readFileSync(join(dir, "close", "hand-test-2.txt"), "utf8"), /pass · b — hand-test-2\/H1\.out/);
  rmSync(dir, { recursive: true });
});

test("D-build-fix-table's first round reads the wave's hand test: a failed claim is a round-1 row and is recorded as the claim's first run", async () => {
  const { ctx, dir } = finalCtx({ schema: 2, rounds: {} }, STATE);
  const out = waveOutput(dir, 0);
  const txt = put(join(out, "hand-test-1.txt"), "H1 · fail (code) · abc1234 — hand-test-1/H1.out — exit 1, not 0\n");
  const output = put(join(out, "hand-test-1", "H1.out"), "boom\n");
  const brief = put(join(dir, "in", "brief", "quick-x.md"), ["## Target files", "", "- src/app.ts", ""].join("\n"));
  delete ctx.inputs.table;
  ctx.inputs["hand-results"] = { schema: "files", files: [txt, output] };
  ctx.inputs.brief = { schema: "files", files: [brief] };
  ctx.outputs = ["fix-owed", "nothing-open"];
  const r = await fixTable(ctx);
  assert.equal(r.status, "done");
  const o = r.status === "done" ? r.outputs : {};
  const state = JSON.parse(readFileSync(join(ctx.outDir, "table", "state.json"), "utf8")) as TableState;
  assert.equal(state.round, "1");
  assert.deepEqual(state.rows, [{ id: "HAND.1", kind: "behavior" }]);
  assert.deepEqual(state.claims, { H1: ["fail"] });
  assert.equal(o["fix-owed"]?.schema === "check" && o["fix-owed"].answer, "pass", "a row reaches the fixer");
  assert.ok(existsSync(join(dir, "close", "hand-test-1.txt")));
  rmSync(dir, { recursive: true });
});

test("D-build-fix-table writes the round's draft slices, rows on one file together, and can-split passes with two and a fixer cap above one", async () => {
  const block = (n: number, locator: string) => [`### CURSORY.${n} — a title`, `- locator: ${locator}`, "- kind: behavior", "- finding: it breaks", "- after: it holds", ""].join("\n");
  const findings = (dir: string) => ({
    "findings-review": { schema: "files", files: [put(join(dir, "nodes", "A-review", "0", "out", "findings-review", "review.md"), [block(1, "src/a.ts:1-2"), block(2, "src/b.ts:4"), block(3, "src/a.ts:9")].join("\n"))] } satisfies FilesValue,
  });
  const run = async (subagentMax: number) => {
    const { ctx, dir } = firstRoundCtx({});
    Object.assign(ctx.inputs, findings(dir));
    ctx.inputs["repo-config"] = { schema: "files", files: [put(join(dir, "in", "cap", "repo-config.json"), JSON.stringify({ tree: ctx.place.worktree, stepsFile: "", steps: {}, notes: {}, briefsDir: null, baseRef: "main", thresholds: { ...DEFAULTS, SUBAGENT_MAX: subagentMax } }))] };
    ctx.outputs = ["fix-owed", "nothing-open", "draft-slices", "can-split"];
    const r = await fixTable(ctx);
    assert.equal(r.status, "done");
    const out = r.status === "done" ? r.outputs : {};
    const draft = JSON.parse(readFileSync(join(ctx.outDir, "draft-slices", DRAFT_FILE), "utf8")) as DraftFile;
    rmSync(dir, { recursive: true });
    return { draft, canSplit: out["can-split"]?.schema === "check" ? out["can-split"].answer : undefined };
  };
  const four = await run(4);
  assert.deepEqual(four.draft, {
    round: "1",
    slices: [
      { id: "D1", rows: ["CURSORY.1", "CURSORY.3"], files: ["src/a.ts"] },
      { id: "D2", rows: ["CURSORY.2"], files: ["src/b.ts"] },
    ],
  });
  assert.equal(four.canSplit, "pass");
  assert.equal((await run(1)).canSplit, "fail", "a fixer cap of one never splits");
});

/** A round-1 D-build-fix-table context over `inputs`, in a run dir whose tree is a repo with one commit. */
function firstRoundCtx(inputs: DataValues): { ctx: OpContext; dir: string } {
  const { ctx, dir } = finalCtx({ schema: 2, rounds: {} }, STATE);
  delete ctx.inputs.table;
  const brief = put(join(dir, "in", "brief", "quick-x.md"), ["## Target files", "", "- src/app.ts", ""].join("\n"));
  Object.assign(ctx.inputs, { brief: { schema: "files", files: [brief] } satisfies FilesValue }, inputs);
  ctx.outputs = ["fix-owed", "nothing-open"];
  return { ctx, dir };
}

const modelOf = (r: Awaited<ReturnType<typeof fixTable>>): string | undefined => {
  const v = r.status === "done" ? r.outputs["fixer-model"] : undefined;
  return v?.schema === "text" ? v.text : undefined;
};

test("D-build-fix-table hands the fixer its round's model: sonnet for round 1, opus for round 3 whatever the brief says", async () => {
  const first = firstRoundCtx({});
  assert.equal(modelOf(await fixTable(first.ctx)), "sonnet");
  rmSync(first.dir, { recursive: true });

  const table: TableJson = { schema: 2, rounds: { "1": round(), "2": round() } };
  const { ctx, dir } = finalCtx(table, { ...STATE, round: "2", fixed: ["1", "2"] });
  ctx.nodeId = "D-build-fix-table";
  ctx.outputs = ["fix-owed", "nothing-open"];
  ctx.inputs.brief = { schema: "files", files: [put(join(dir, "in", "brief", "quick-x.md"), ["## Target files", "", "- src/app.ts", ""].join("\n"))] };
  const rows = [{ title: "check tests is red", locator: "src/a.ts", kind: "behavior", finding: "tests: 1 failing", after: "tests pass" }];
  ctx.inputs["pre-push-rows"] = { schema: "files", files: [put(join(dir, "nodes", "K-checks", "1", "out", "pre-push-rows", "rows.json"), JSON.stringify(rows))] };
  const r = await fixTable(ctx);
  assert.equal((JSON.parse(readFileSync(join(ctx.outDir, "table", "state.json"), "utf8")) as TableState).round, "3");
  assert.equal(modelOf(r), "opus");
  rmSync(dir, { recursive: true });
});

const sessionOf = (ctx: OpContext) => (JSON.parse(readFileSync(join(ctx.outDir, "table", "state.json"), "utf8")) as TableState).session;

test("a resolver answer that changed no brief is still a session row of the next round, saying whose answer and which source", async () => {
  const { ctx, dir } = firstRoundCtx({});
  const answers = put(join(dir, "nodes", "A-fixer", "0", "out", "fix-answers", "answers.json"), JSON.stringify([{ question_id: "S.4", answer: "keep it as it is", source: "code", by: "resolver", searched: [{ source: "code", said: "src/app.ts:3 returns early" }] }]));
  ctx.inputs["fix-answers"] = { schema: "files", files: [answers] };
  const r = await fixTable(ctx);
  assert.equal(r.status, "done");
  const state = JSON.parse(readFileSync(join(ctx.outDir, "table", "state.json"), "utf8")) as TableState;
  assert.deepEqual(state.answered, ["S.4"]);
  assert.equal(state.rows.length, 1, "the answer is a row the round-1 fixer takes");
  const session = readFileSync(join(dir, "close", "session.md"), "utf8");
  assert.match(session, /S\.4 answered: keep it as it is/);
  assert.match(session, /the resolver's, source: code/);
  assert.doesNotMatch(session, /brief change/);
  rmSync(dir, { recursive: true });
});

test("an operator answer is a session row that says it is the operator's", async () => {
  const { ctx, dir } = firstRoundCtx({});
  const answers = put(join(dir, "nodes", "A-fixer", "0", "out", "fix-answers", "answers.json"), JSON.stringify([{ question_id: "S.5", answer: "split it", source: "operator", by: "operator" }]));
  ctx.inputs["fix-answers"] = { schema: "files", files: [answers] };
  assert.equal((await fixTable(ctx)).status, "done");
  assert.match(readFileSync(join(dir, "close", "session.md"), "utf8"), /the operator's answer/);
  assert.equal(sessionOf(ctx).length, 1);
  rmSync(dir, { recursive: true });
});

test("a line the verify phase edited in an authored test reaches the next table as a session row through test-rows", async () => {
  const { ctx, dir } = firstRoundCtx({});
  const tree = ctx.place.worktree;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: tree, encoding: "utf8" }).trim();
  const brief = git("rev-parse", "HEAD");
  put(join(tree, "src", "a.test.ts"), "a\nexpect(x).toBe(1)\nb\n");
  git("add", "-A");
  git("commit", "-q", "-m", "author");
  const integration = git("rev-parse", "HEAD");
  put(join(tree, "src", "a.test.ts"), "a\nexpect(x).toBe(2)\nb\n");
  git("add", "-A");
  git("commit", "-q", "-m", "verify");
  const verify = git("rev-parse", "HEAD");
  const rows = editedAssertionRows(tree, { brief, integration, verify });
  assert.equal(rows.length, 1);
  const file = put(join(dir, "nodes", "K-tests", "0", "out", "test-rows", "rows.json"), JSON.stringify(rows));
  ctx.inputs["test-rows"] = { schema: "files", files: [file] };
  assert.equal((await fixTable(ctx)).status, "done");
  const state = JSON.parse(readFileSync(join(ctx.outDir, "table", "state.json"), "utf8")) as TableState;
  assert.equal(state.rows.length, 1, "the edit is a row the fixer judges");
  const session = readFileSync(join(dir, "close", "session.md"), "utf8");
  assert.match(session, /the verify phase edited an authored test in src\/a\.test\.ts/);
  assert.match(session, /src\/a\.test\.ts:2/);
  assert.match(session, /was `expect\(x\)\.toBe\(1\)`, now `expect\(x\)\.toBe\(2\)`/);
  rmSync(dir, { recursive: true });
});

// ---- answers that come in when no fixed round is left ----

const answerFile = (dir: string, node: string, answers: object[]) =>
  put(join(dir, "nodes", node, "0", "out", "fix-answers", "answers.json"), JSON.stringify(answers));
const spentTable = (): TableJson => ({ schema: 2, rounds: { "1": round(), "2": round(), "3": round(), escalate: round({ rows: [rowOf("CURSORY.7", "behavior", "3")] }) } });

test("an answer that comes in after the last fixed round is built is no throw: D-build-fix-table hands it to the final round, which lists it", async () => {
  const { ctx, dir } = finalCtx(spentTable(), STATE);
  ctx.nodeId = "D-build-fix-table";
  ctx.outputs = ["fix-owed", "nothing-open"];
  ctx.inputs["fix-answers"] = { schema: "files", files: [answerFile(dir, "A-fixer", [{ question_id: "S.9", answer: "rename it", source: "code", by: "resolver", searched: [{ source: "code", said: "x" }] }])] };
  const r = await fixTable(ctx);
  assert.equal(r.status, "done");
  assert.equal(r.status === "done" && r.outputs["fix-owed"]?.schema === "check" && r.outputs["fix-owed"].answer, "fail", "no round was built");
  const state = JSON.parse(readFileSync(join(ctx.outDir, "table", "state.json"), "utf8")) as TableState;
  assert.deepEqual(state.session.map((b) => [b.title.split(" ")[0], b.stage]), [["S.9", "escalate"]]);
  const table = JSON.parse(readFileSync(join(ctx.outDir, "table", "table.json"), "utf8")) as TableJson;
  const fin = finalCtx(table, state);
  const f = await finalTable(fin.ctx);
  assert.equal(verdict(f, "has-leftovers")?.answer, "pass");
  assert.match(readFileSync(join(fin.ctx.outDir, "final", "final.md"), "utf8"), /SESSION\.1 · structure · .*S\.9 asked; answer: rename it/);
  rmSync(dir, { recursive: true });
  rmSync(fin.dir, { recursive: true });
});

test("an answer D-final-table is the first to read is a row of the final round: an urgent one is open, so final-clean fails", async () => {
  const table: TableJson = { schema: 2, rounds: { "1": round({ rows: [rowOf("HUNTER.2", "behavior")] }), "2": round(), "3": round(), escalate: round() } };
  const { ctx, dir } = finalCtx(table, STATE);
  ctx.inputs["fix-answers"] = { schema: "files", files: [answerFile(dir, "A-fixer", [{ question_id: "HUNTER.2", answer: "return 409", source: "operator", by: "operator" }])] };
  const r = await finalTable(ctx);
  const clean = verdict(r, "final-clean");
  assert.equal(clean?.answer, "fail");
  assert.equal(clean?.detail, "open: SESSION.1 behavior", "the answer to the behavior row's decision keeps its kind");
  rmSync(dir, { recursive: true });
});

test("a red check that stays red while no round is left is one row of the final round, however many tables read it", async () => {
  let table = spentTable();
  let state = STATE;
  const dirs: string[] = [];
  for (const i of [1, 2]) {
    const { ctx, dir } = finalCtx(table, state);
    dirs.push(dir);
    ctx.nodeId = "D-build-fix-table";
    ctx.outputs = ["fix-owed", "nothing-open"];
    const rows = [{ title: "check tests is red", locator: "src/a.ts", kind: "behavior", finding: "tests: 1 failing", after: "tests pass" }];
    ctx.inputs["pre-push-rows"] = { schema: "files", files: [put(join(dir, "nodes", "K-pre-push", String(i), "out", "pre-push-rows", "rows.json"), JSON.stringify(rows))] };
    assert.equal((await fixTable(ctx)).status, "done");
    state = JSON.parse(readFileSync(join(ctx.outDir, "table", "state.json"), "utf8")) as TableState;
    table = JSON.parse(readFileSync(join(ctx.outDir, "table", "table.json"), "utf8")) as TableJson;
  }
  assert.deepEqual(state.session.map((b) => [b.id, b.stage]), [["SESSION.1", "escalate"]]);
  for (const d of dirs) rmSync(d, { recursive: true });
});
