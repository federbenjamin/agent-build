/**
 * K-output-format (`pipelines/build/schema.ts`): every formatted agent output is checked against its grammar,
 * and the questions the outputs raise are collected. Each case writes the files an agent would and
 * reads the check's answer.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { EXIT_CHECKS } from "../../runtime/lib/fixFile.ts";
import type { CheckRequest } from "../adapters/types.ts";
import type { DataValues, FilesValue } from "../contracts.ts";
import { schemaCheck } from "../pipelines/build/schema.ts";
import { DRAFT_FILE, LINKS_FILE, PLAN_FILE, type SlicePlan } from "../pipelines/build/slices.ts";
import type { TableState } from "../pipelines/build/table.ts";

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
const files = (...paths: string[]): FilesValue => ({ schema: "files", files: paths });

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "graph-schema-"));
  dirs.push(d);
  return d;
};
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const req = (dir: string, inputs: DataValues, formats: Record<string, string>, over: Partial<CheckRequest> = {}): CheckRequest => ({
  role: "schema",
  inputs,
  worktree: dir,
  baseSha: "",
  iteration: 0,
  signal: new AbortController().signal,
  outputs: [],
  outDir: join(dir, "out"),
  place: { runDir: dir, worktree: dir, branch: "b", baseSha: "" },
  formats,
  nodeId: "K-output-format",
  subject: { node: "A-x", iteration: 0 },
  ...over,
});

const BLOCK = (id: string, over: Record<string, string> = {}) =>
  [`### ${id} — a title`, ...Object.entries({ locator: "src/a.ts:1-2", kind: "behavior", finding: "it breaks", after: "it holds", ...over }).map(([k, v]) => `- ${k}: ${v}`), ""].join("\n");

// ---- what is checked ----

test("an input with no format, or a format no validator knows, is not checked", async () => {
  const dir = scratch();
  const junk = put(join(dir, "x", "junk.md"), "");
  const r = await schemaCheck(req(dir, { loose: files(junk), odd: files(junk) }, { odd: "mystery" }));
  assert.equal(r.answer, "pass");
  assert.equal(r.detail, "A-x: every output parses");
});

test("the detail names the node, with #<iteration> when it is past the first", async () => {
  const dir = scratch();
  assert.equal((await schemaCheck(req(dir, {}, {}))).detail, "A-x: every output parses");
  assert.equal((await schemaCheck(req(dir, {}, {}, { subject: { node: "A-x", iteration: 3 } }))).detail, "A-x#3: every output parses");
  assert.equal((await schemaCheck(req(dir, {}, {}, { subject: undefined }))).detail, "?: every output parses");
});

// ---- findings ----

test("a reader file with a finding block, or a NO FINDINGS line, parses", async () => {
  const dir = scratch();
  const withBlock = put(join(dir, "a", "review.md"), `Notes\n\n${BLOCK("CURSORY.1")}`);
  const clean = put(join(dir, "b", "review.md"), "NO FINDINGS\n");
  assert.equal((await schemaCheck(req(dir, { findings: files(withBlock) }, { findings: "findings" }))).answer, "pass");
  assert.equal((await schemaCheck(req(dir, { findings: files(clean) }, { findings: "findings" }))).answer, "pass");
});

test("a reader file with neither a block nor NO FINDINGS fails, naming the input, the format and the file", async () => {
  const dir = scratch();
  const f = put(join(dir, "review.md"), "I looked and it seems fine.\n");
  const r = await schemaCheck(req(dir, { "findings-review": files(f) }, { "findings-review": "findings" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /^A-x: findings-review \(findings\): review\.md: /);
  assert.match(r.detail, /no `### <ID> — <title>` blocks/);
});

test("a finding whose id belongs to another reader fails: the file's name says whose ids it may hold", async () => {
  const dir = scratch();
  const f = put(join(dir, "review.md"), BLOCK("HUNTER.1"));
  const r = await schemaCheck(req(dir, { findings: files(f) }, { findings: "findings" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /review\.md/);
});

test("a finding missing a required field fails", async () => {
  const dir = scratch();
  const f = put(join(dir, "review.md"), BLOCK("CURSORY.1").replace("- after: it holds\n", ""));
  const r = await schemaCheck(req(dir, { findings: files(f) }, { findings: "findings" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /CURSORY\.1/);
});

test("a findings output with no .md file fails, listing the files it did hold", async () => {
  const dir = scratch();
  const f = put(join(dir, "notes.txt"), "x");
  const r = await schemaCheck(req(dir, { findings: files(f) }, { findings: "findings" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /no file to check among notes\.txt/);
  const none = await schemaCheck(req(dir, { findings: files() }, { findings: "findings" }));
  assert.match(none.detail, /no file to check among \(none\)/);
});

test("every file of a findings output is checked: one bad file among good ones fails and is the only one named", async () => {
  const dir = scratch();
  const good = put(join(dir, "a", "review.md"), BLOCK("CURSORY.1"));
  const bad = put(join(dir, "b", "review-codex.md"), "nothing\n");
  const r = await schemaCheck(req(dir, { findings: files(good, bad) }, { findings: "findings" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /review-codex\.md/);
  assert.doesNotMatch(r.detail, /review\.md:/);
});

// ---- non-empty outputs ----

test("prior-art and risk-moment outputs must hold a non-blank file", async () => {
  const dir = scratch();
  for (const format of ["prior-art", "risk-moment"]) {
    const blank = put(join(dir, format, "out.txt"), "  \n\n");
    const full = put(join(dir, format, "full.txt"), "something\n");
    const bad = await schemaCheck(req(dir, { out: files(blank) }, { out: format }));
    assert.equal(bad.answer, "fail", format);
    assert.match(bad.detail, new RegExp(`out \\(${format}\\): out\\.txt: empty`));
    assert.equal((await schemaCheck(req(dir, { out: files(full) }, { out: format }))).answer, "pass", format);
    assert.match((await schemaCheck(req(dir, { out: files() }, { out: format }))).detail, /no file to check among \(none\)/);
  }
});

// ---- the brief ----

test("a brief must parse: a model line and its sections, or it fails with the parser's reason", async () => {
  const dir = scratch();
  const ok = put(join(dir, "ok", "brief.md"), PART_BRIEF);
  const bad = put(join(dir, "bad", "brief.md"), "# just a title\n");
  assert.equal((await schemaCheck(req(dir, { brief: files(ok) }, { brief: "brief" }))).answer, "pass");
  const r = await schemaCheck(req(dir, { brief: files(bad) }, { brief: "brief" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /brief \(brief\): brief\.md: .*model/);
});

// ---- hand test ----

const HT_PASS = "H1 · pass · abc1234 — hand-test-1/H1.out\n";

test("a hand-test file passes when each output file it names sits beside it", async () => {
  const dir = scratch();
  const txt = put(join(dir, "hand-test-1.txt"), HT_PASS);
  put(join(dir, "hand-test-1", "H1.out"), "ok\n");
  assert.equal((await schemaCheck(req(dir, { "hand-results": files(txt) }, { "hand-results": "hand-test" }))).answer, "pass");
});

test("a hand-test line naming an output file that is not there fails, naming the claim and the file", async () => {
  const dir = scratch();
  const txt = put(join(dir, "hand-test-1.txt"), `${HT_PASS}H2 · fail (code) · abc1234 — hand-test-1/H2.out — exit 1\n`);
  put(join(dir, "hand-test-1", "H1.out"), "ok\n");
  const r = await schemaCheck(req(dir, { "hand-results": files(txt) }, { "hand-results": "hand-test" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /hand-test-1\.txt: H2: no output file hand-test-1\/H2\.out/);
  assert.doesNotMatch(r.detail, /H1: no output/);
});

test("a hand-test line that is not a claim line fails, and only files named hand-test-<n>.txt are read", async () => {
  const dir = scratch();
  const bad = put(join(dir, "hand-test-1.txt"), "H1 passed, I think\n");
  const r = await schemaCheck(req(dir, { "hand-results": files(bad) }, { "hand-results": "hand-test" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /hand-test-1\.txt: /);
  const other = put(join(dir, "notes.txt"), "x");
  assert.match((await schemaCheck(req(dir, { "hand-results": files(other) }, { "hand-results": "hand-test" }))).detail, /no file to check among notes\.txt/);
});

// ---- the builder's report ----

const PART_BRIEF = [
  "class: R1 — operator, 2026-09-28",
  "model: sonnet — the brief names every file",
  "",
  "## Target files",
  "",
  "- src/app.ts",
  "",
  "## Parts",
  "",
  "- P1 · the app answers",
  "  - model: sonnet — small",
  "  - files: src/app.ts",
  "  - test files: none",
  "  - deliverables: 1",
  "  - after: none",
  "  - tests: none",
  "",
  "## Hand test",
  "",
  "- H1 · the app answers",
  "  - run: `node src/app.ts`",
  "  - pass: exit 0",
  "",
  "## Deliverables",
  "",
  "1. app answers",
  "",
].join("\n");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

/** A repo whose branch `part` holds one commit on src/app.ts; the check's inputs for part P1. */
function builderWorld(report: string, candidates?: string) {
  const dir = scratch();
  const tree = join(dir, "tree");
  mkdirSync(tree);
  git(tree, "init", "-q", "-b", "main");
  git(tree, "commit", "-q", "--allow-empty", "-m", "init");
  git(tree, "checkout", "-q", "-b", "part");
  put(join(tree, "src", "app.ts"), "x\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "part");
  const sha = git(tree, "rev-parse", "HEAD");
  git(tree, "checkout", "-q", "main");
  const reportFiles = [put(join(dir, "in", "report", "report.md"), report), ...(candidates === undefined ? [] : [put(join(dir, "in", "report", "candidates.md"), candidates)])];
  const inputs: DataValues = { "part-commit": { schema: "ref", kind: "commit", id: sha }, "builder-report": files(...reportFiles) };
  const r = (over: Partial<CheckRequest> = {}) =>
    req(dir, inputs, { "builder-report": "builder-report" }, {
      worktree: tree,
      place: { runDir: dir, worktree: tree, branch: "main", baseSha: "" },
      subject: { node: "A-builder", iteration: 0, instance: "P1" },
      subjectInputs: { brief: files(put(join(dir, "in", "brief", "quick-x.md"), PART_BRIEF)) },
      ...over,
    });
  return { dir, r };
}

const SLICE_BRIEF = PART_BRIEF.replace("  - tests: none", "  - tests: W1").replace(
  "## Hand test",
  ["## Test slices", "", "- W1 · plain · the app's answer", "  - files: src/__tests__/app.test.ts", "  - covers: 1", "  - under test: app", "", "## Hand test"].join("\n")
);

/** A test writer's verify output for slice W1, its commit changing `paths` from the run tree's head. */
function verifyWorld(paths: string[]) {
  const dir = scratch();
  const tree = join(dir, "tree");
  mkdirSync(tree);
  git(tree, "init", "-q", "-b", "main");
  git(tree, "commit", "-q", "--allow-empty", "-m", "init");
  git(tree, "checkout", "-q", "-b", "verify");
  for (const p of paths) put(join(tree, p), "x\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "verify");
  const sha = git(tree, "rev-parse", "HEAD");
  git(tree, "checkout", "-q", "main");
  const report = put(join(dir, "in", "tests-verified", "report.md"), "verified\n");
  return req(dir, { "proofs-commit": { schema: "ref", kind: "commit", id: sha }, "tests-verified": files(report) }, { "tests-verified": "tests" }, {
    worktree: tree,
    place: { runDir: dir, worktree: tree, branch: "main", baseSha: "" },
    subject: { node: "A-prove-tests", iteration: 0, instance: "W1" },
    subjectInputs: { brief: files(put(join(dir, "in", "brief", "quick-x.md"), SLICE_BRIEF)) },
  });
}

test("a test writer's commit inside its slice's files passes; one that touches any other file is refused, naming it", async () => {
  const inside = await schemaCheck(verifyWorld(["src/__tests__/app.test.ts"]));
  assert.equal(inside.answer, "pass", inside.detail);
  const outside = await schemaCheck(verifyWorld(["src/__tests__/app.test.ts", "src/app.ts"]));
  assert.equal(outside.answer, "fail");
  assert.match(outside.detail, /slice W1's commit touches src\/app\.ts, which its slice does not list: a STOP, not an edit/);
  assert.doesNotMatch(outside.detail, /app\.test\.ts,/);
});

test("a builder's report that is non-empty, from a commit inside its lane, passes", async () => {
  const w = builderWorld("built it\n");
  const r = await schemaCheck(w.r());
  assert.equal(r.answer, "pass");
  assert.equal(r.detail, "A-builder: every output parses");
});

test("a builder's report that is blank fails", async () => {
  const r = await schemaCheck(builderWorld("  \n").r());
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /builder-report \(builder-report\): report\.md: empty/);
});

test("a builder's candidates.md must hold well-formed finding blocks; an empty one holds none and passes", async () => {
  const bad = await schemaCheck(builderWorld("built\n", "### SESSION.1 — no fields\n").r());
  assert.equal(bad.answer, "fail");
  assert.match(bad.detail, /candidates\.md: /);
  const good = await schemaCheck(builderWorld("built\n", BLOCK("CAND.1")).r());
  assert.equal(good.answer, "pass");
  const none = await schemaCheck(builderWorld("built\n", "").r());
  assert.equal(none.answer, "pass");
});

test("a builder's check with no commit among its inputs, no part, or no brief fails rather than passing unchecked", async () => {
  const w = builderWorld("built\n");
  const noCommit = await schemaCheck(w.r({ inputs: { "builder-report": files(put(join(w.dir, "r.md"), "x")) } }));
  assert.equal(noCommit.answer, "fail");
  assert.match(noCommit.detail, /a builder's check needs its commit, its part and the brief/);
  const noPart = await schemaCheck(w.r({ subject: { node: "A-builder", iteration: 0 } }));
  assert.match(noPart.detail, /needs its commit, its part and the brief/);
  const noBrief = await schemaCheck(w.r({ subjectInputs: {} }));
  assert.match(noBrief.detail, /needs its commit, its part and the brief/);
});

test("a part the brief does not list fails the builder's check, naming it", async () => {
  const w = builderWorld("built\n");
  const r = await schemaCheck(w.r({ subject: { node: "A-builder", iteration: 0, instance: "P9" } }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /part P9 is not in the brief/);
});

// ---- the fix file and its questions ----

const exitChecks = `exit checks:\n${EXIT_CHECKS.map((k) => `${k}: none — nothing to check`).join("\n")}\n`;
const state = (over: Partial<TableState> = {}): TableState => ({ round: "1", rows: [{ id: "R.1", kind: "structure" }, { id: "R.2", kind: "structure" }], fixed: [], driftGroups: 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [], ...over });
const tableOf = (dir: string, s: TableState): FilesValue => files(put(join(dir, "table", "state.json"), JSON.stringify(s)));
/** Fixer S1's check of `fixFiles`, S1 being the one slice of a plan holding every row of `s`. */
function fixerReq(dir: string, fixFiles: string[], s: TableState = state()): CheckRequest {
  const plan: SlicePlan = { round: s.round ?? "1", slices: [{ id: "S1", drafts: ["D1"], rows: s.rows.map((r) => r.id), files: [], peers: [] }] };
  return req(dir, { "fix-file": files(...fixFiles) }, { "fix-file": "fix-file" }, {
    subject: { node: "A-fixer", iteration: 1, instance: "S1" },
    subjectInputs: { table: tableOf(dir, s), "slice-plan": files(put(join(dir, "fixer-plan", PLAN_FILE), JSON.stringify(plan))) },
  });
}
const fixReq = (dir: string, text: string, s: TableState = state()) => fixerReq(dir, [put(join(dir, "fix", "fix-1.txt"), text)], s);

test("a fix file with a line for each row of its round and its exit checks parses and raises no question", async () => {
  const dir = scratch();
  const r = await schemaCheck(fixReq(dir, `R.1 · fixed · abc1234 — did it\nR.2 · dropped — not a problem\n\n${exitChecks}`));
  assert.equal(r.answer, "pass");
  assert.deepEqual(r.questions, []);
  assert.equal(r.detail, "A-fixer#1: every output parses");
});

test("each decision line of a fix file becomes a question of its kind, asked by the row", async () => {
  const dir = scratch();
  const text = `R.1 · decision — public-surface — rename the export?\nR.2 · decision — product — drop the flag?\n\n${exitChecks}`;
  const r = await schemaCheck(fixReq(dir, text));
  assert.equal(r.answer, "pass");
  assert.deepEqual(r.questions, [
    { id: "R.1", type: "public-surface", text: "rename the export?", searched: [] },
    { id: "R.2", type: "product", text: "drop the flag?", searched: [] },
  ]);
  assert.match(r.detail, /; 2 questions$/);
});

test("a fix file missing a row, naming a row that is not in the round, or missing its exit checks fails", async () => {
  const dir = scratch();
  const missingRow = await schemaCheck(fixReq(dir, `R.1 · fixed · abc1234 — did it\n\n${exitChecks}`));
  assert.equal(missingRow.answer, "fail");
  assert.match(missingRow.detail, /R\.2: row has no line/);
  const stranger = await schemaCheck(fixReq(dir, `R.1 · fixed · abc1234 — a\nR.2 · fixed · abc1234 — b\nR.9 · fixed · abc1234 — c\n\n${exitChecks}`));
  assert.match(stranger.detail, /R\.9: not a row of this round's table/);
  const noChecks = await schemaCheck(fixReq(dir, "R.1 · fixed · abc1234 — a\nR.2 · fixed · abc1234 — b\n"));
  assert.match(noChecks.detail, /missing `exit checks:`/);
});

const TWO_SLICES: SlicePlan = {
  round: "1",
  slices: [
    { id: "S1", drafts: ["D1"], rows: ["R.1"], files: ["a.ts"], peers: [] },
    { id: "S2", drafts: ["D2"], rows: ["R.2"], files: ["b.ts"], peers: [] },
  ],
};

test("a slice's fix file answers its slice's rows only: the slice plan's slice by the fixer's item", async () => {
  const dir = scratch();
  const sliced = (text: string, item: string) => {
    const r = fixReq(dir, text);
    return {
      ...r,
      subject: { node: "A-fixer", iteration: 1, instance: item },
      subjectInputs: { ...r.subjectInputs, "slice-plan": files(put(join(dir, "plan", PLAN_FILE), JSON.stringify(TWO_SLICES))) },
    };
  };
  assert.equal((await schemaCheck(sliced(`R.2 · dropped — not a problem\n\n${exitChecks}`, "S2"))).answer, "pass");
  const whole = await schemaCheck(sliced(`R.1 · fixed · abc1234 — a\nR.2 · fixed · abc1234 — b\n\n${exitChecks}`, "S2"));
  assert.match(whole.detail, /R\.1: not a row of this round's table/);
  const lost = await schemaCheck(sliced(`R.2 · dropped — x\n\n${exitChecks}`, "S9"));
  assert.match(lost.detail, /the slice plan of round 1 has no slice S9/);
});

test("the slicer's links parse, and each end names a draft slice of the round", async () => {
  const dir = scratch();
  const draft = files(put(join(dir, "draft", DRAFT_FILE), JSON.stringify({ round: "1", slices: [{ id: "D1", rows: ["R.1"], files: ["a.ts"] }, { id: "D2", rows: ["R.2"], files: ["b.ts"] }] })));
  const linksReq = (body: unknown) =>
    req(dir, { links: files(put(join(dir, "links", LINKS_FILE), JSON.stringify(body))) }, { links: "links" }, { subject: { node: "A-link-slices", iteration: 1 }, subjectInputs: { "draft-slices": draft } });
  const link = { from: "D1", to: "D2", kind: "signature", evidence: "b.ts:3 calls f", note: "f takes two" };
  assert.equal((await schemaCheck(linksReq({ links: [link] }))).answer, "pass");
  assert.equal((await schemaCheck(linksReq({ links: [] }))).answer, "pass");
  assert.match((await schemaCheck(linksReq({ links: [{ ...link, to: "D7" }] }))).detail, /no draft slice D7/);
  assert.match((await schemaCheck(linksReq({ links: [{ ...link, kind: "vibes" }] }))).detail, /links\[0\]\.kind/);
});

test("a fix file check without the table among the fixer's inputs fails saying so", async () => {
  const dir = scratch();
  const r = await schemaCheck(req(dir, { "fix-file": files(put(join(dir, "fix-1.txt"), "x")) }, { "fix-file": "fix-file" }, { subjectInputs: {} }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /a fix file needs the table among the fixer's inputs/);
});

test("a decision the fixer also put in questions.json is asked once, with the searched evidence of questions.json", async () => {
  const dir = scratch();
  const questions = put(join(dir, "fix", "questions.json"), JSON.stringify([{ id: "R.1", type: "product", text: "drop the flag?", searched: [{ source: "code", said: "unused" }] }]));
  const text = `R.1 · decision — product — drop the flag?\nR.2 · fixed · abc1234 — b\n\n${exitChecks}`;
  const r = await schemaCheck(fixReq(dir, text));
  assert.equal(r.questions?.length, 1);
  const withJson = await schemaCheck(fixerReq(dir, [put(join(dir, "fix", "fix-1.txt"), text), questions]));
  assert.equal(withJson.answer, "pass");
  assert.deepEqual(withJson.questions, [{ id: "R.1", type: "product", text: "drop the flag?", searched: [{ source: "code", said: "unused" }] }]);
  assert.match(withJson.detail, /; 1 questions$/);
});

// ---- questions.json ----

test("questions.json is read from any input, and a malformed one fails naming that input", async () => {
  const dir = scratch();
  const good = put(join(dir, "a", "questions.json"), JSON.stringify([{ id: "Q1", type: "brief", text: "which?", searched: [] }]));
  const bad = put(join(dir, "b", "questions.json"), JSON.stringify([{ id: "Q2", type: "nonsense", text: "?" }]));
  const ok = await schemaCheck(req(dir, { answers: files(good) }, {}));
  assert.equal(ok.answer, "pass");
  assert.deepEqual(ok.questions, [{ id: "Q1", type: "brief", text: "which?", searched: [] }]);
  const r = await schemaCheck(req(dir, { other: files(bad) }, {}));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /^A-x: other: /);
});

test("a questions.json beside a formatted output is not read as that output's file", async () => {
  const dir = scratch();
  const md = put(join(dir, "review.md"), BLOCK("CURSORY.1"));
  const q = put(join(dir, "questions.json"), JSON.stringify([{ id: "Q1", type: "brief", text: "which?", searched: [] }]));
  const r = await schemaCheck(req(dir, { findings: files(md, q) }, { findings: "findings" }));
  assert.equal(r.answer, "pass");
  assert.equal(r.questions?.length, 1);
});

test("an output holding only questions.json passes with its questions: the agent stopped on them", async () => {
  const dir = scratch();
  const blocked = { id: "B1", type: "blocked", text: "no row can be fixed: the table names a file the diff deleted", searched: [{ source: "code", said: "src/a.ts is gone" }] };
  const q = put(join(dir, "fix", "questions.json"), JSON.stringify([blocked]));
  const r = await schemaCheck(fixerReq(dir, [q]));
  assert.equal(r.answer, "pass", r.detail);
  assert.deepEqual(r.questions, [blocked]);
  const empty = put(join(dir, "findings", "questions.json"), "[]");
  const none = await schemaCheck(req(dir, { findings: files(empty) }, { findings: "findings" }));
  assert.equal(none.answer, "fail", "an empty questions.json asks nothing, so the output has nothing in it");
  assert.match(none.detail, /no file to check among \(none\)/);
});

test("a struggles.json beside a valid output is not read as that output's file, whatever it holds", async () => {
  const dir = scratch();
  const md = put(join(dir, "review.md"), BLOCK("CURSORY.1"));
  const struggles = put(join(dir, "struggles.json"), "not json, and not a list either");
  const r = await schemaCheck(req(dir, { findings: files(md, struggles) }, { findings: "findings" }));
  assert.equal(r.answer, "pass", r.detail);
  assert.equal(r.questions?.length ?? 0, 0);
  const alone = await schemaCheck(req(dir, { findings: files(struggles) }, { findings: "findings" }));
  assert.equal(alone.answer, "fail", "struggles.json is no output of its own");
  assert.match(alone.detail, /no file to check among \(none\)/);
});

test("a failing check returns no questions and lists every problem, input by input", async () => {
  const dir = scratch();
  const junk = put(join(dir, "a", "review.md"), "nothing");
  const blank = put(join(dir, "b", "out.txt"), "");
  const r = await schemaCheck(req(dir, { findings: files(junk), tests: files(blank) }, { findings: "findings", tests: "tests" }));
  assert.equal(r.answer, "fail");
  assert.match(r.detail, /findings \(findings\): .*; tests \(tests\): out\.txt: empty/);
  assert.equal("questions" in r, false);
});

// ---- the stage read ----

test("a stage read needs the table and the fix file, and a table that has built a round", async () => {
  const dir = scratch();
  const md = put(join(dir, "r", "review.md"), "x");
  const none = await schemaCheck(req(dir, { findings: files(md) }, { findings: "stage" }, { subjectInputs: {} }));
  assert.equal(none.answer, "fail");
  assert.match(none.detail, /a stage read needs the table and the fix file among its inputs/);
  const noRound = await schemaCheck(
    req(dir, { findings: files(md) }, { findings: "stage" }, { subjectInputs: { table: tableOf(dir, state({ round: null })), "fix-file": files(put(join(dir, "fix-1.txt"), "x")) } })
  );
  assert.match(noRound.detail, /the table has built no round/);
});
