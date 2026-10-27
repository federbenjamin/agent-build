/**
 * A fix round shared out among fixers (`pipelines/build/slices.ts`, and the D-plan-slices and D-merge-fix
 * operations): the draft slices, the merge under the cap and the packing into the fixer cap, each
 * slice's peers, and the join of the slices' fix files into the round's one.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { briefText } from "../../runtime/__tests__/helpers/owedRun.ts";
import { type Locator, serialiseTableJson, type TableJson } from "../../runtime/lib/runFiles.ts";
import { EXIT_CHECKS } from "../../runtime/lib/fixFile.ts";
import { DEFAULTS } from "../../runtime/thresholds.ts";
import type { OpContext } from "../adapters/types.ts";
import type { DataValues, FilesValue } from "../contracts.ts";
import { sessionName } from "../runKeys.ts";
import { OPS } from "../pipelines/build/ops.ts";
import { CONFLICT_FILE, DRAFT_FILE, type DraftSlice, draftSlices, joinSliceFixes, type Link, LINKS_FILE, parseCrosstalk, PLAN_FILE, planSlices, type SlicePlan, withPeers } from "../pipelines/build/slices.ts";
import type { TableState } from "../pipelines/build/table.ts";
import { opContext } from "./helpers/opContext.ts";

const at = (path: string, parsed = true): Locator => ({ path, start: 1, end: 1, parsed });
const draft = (id: string, n: number): DraftSlice => ({ id, rows: Array.from({ length: n }, (_, i) => `${id}.${i + 1}`), files: [`${id.toLowerCase()}.ts`] });
const link = (from: string, to: string): Link => ({ from, to, kind: "signature", evidence: `${to.toLowerCase()}.ts:1`, note: "n" });

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
const files = (...paths: string[]): FilesValue => ({ schema: "files", files: paths });
const checks = (what: string) => `exit checks:\n${EXIT_CHECKS.map((k) => `${k}: ${what}`).join("\n")}\n`;

test("draft slices: rows that point at one path join, through a chain of rows; a row with no parsed path is its own", () => {
  const slices = draftSlices([
    { id: "A.1", locators: [at("src/a.ts"), at("src/b.ts")] },
    { id: "A.2", locators: [at("./src/c.ts")] },
    { id: "A.3", locators: [at("src/c.ts"), at("src/d.ts")] },
    { id: "HAND.1", locators: [at("(none)", false)] },
    { id: "A.4", locators: [at("src/d.ts"), at("src/b.ts")] },
    { id: "A.5", locators: [] },
  ]);
  assert.deepEqual(slices, [
    { id: "D1", rows: ["A.1", "A.2", "A.3", "A.4"], files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] },
    { id: "D2", rows: ["HAND.1"], files: [] },
    { id: "D3", rows: ["A.5"], files: [] },
  ]);
});

test("the plan merges linked drafts under half the round's rows, packs the rest biggest first into the fixer cap, and warns of every link left split", () => {
  const drafts = [draft("D1", 2), draft("D2", 1), draft("D3", 1), draft("D4", 1)];
  const plan = planSlices(drafts, [link("D1", "D2"), link("D1", "D3"), link("D4", "D4"), link("D9", "D1")], 2, 0.5);
  assert.deepEqual(
    plan.slices.map((s) => [s.id, s.drafts, s.rows.length]),
    [
      ["S1", ["D1", "D2"], 3],
      ["S2", ["D3", "D4"], 2],
    ]
  );
  assert.deepEqual(plan.slices[0]!.files, ["d1.ts", "d2.ts"]);
  assert.deepEqual(plan.warnings, [link("D1", "D3")], "D1+D2+D3 would hold 4 of 5 rows, over the cap of 3");
  assert.equal(plan.dropped, 2, "a link to itself and one naming no draft slice");
});

test("the cap is the largest draft slice when that is more than the share", () => {
  const plan = planSlices([draft("D1", 4), draft("D2", 1)], [link("D2", "D1")], 4, 0.5);
  assert.deepEqual(plan.slices.map((s) => s.drafts), [["D1"], ["D2"]]);
  assert.deepEqual(plan.warnings, [link("D2", "D1")]);
});

test("with no links the draft is packed as it is, with no warnings; a cap of one is one slice of every row", () => {
  const drafts = [draft("D1", 1), draft("D2", 3), draft("D3", 1)];
  const free = planSlices(drafts, [], 4, 0.5);
  assert.deepEqual(free.slices.map((s) => s.drafts), [["D2"], ["D1"], ["D3"]], "the biggest first: one fixer a draft slice while the cap allows");
  assert.deepEqual([free.warnings, free.dropped], [[], 0]);
  const one = planSlices(drafts, [link("D1", "D2")], 1, 0.5);
  assert.deepEqual(one.slices.map((s) => [s.id, s.drafts, s.rows]), [["S1", ["D1", "D2", "D3"], ["D1.1", "D2.1", "D2.2", "D2.3", "D3.1"]]]);
  assert.deepEqual(one.warnings, [], "a link inside one slice warns nobody");
});

test("each slice's peers are the round's other slices, with how to reach them and the links between the two either way", () => {
  const plan = planSlices([draft("D1", 2), draft("D2", 1), draft("D3", 1)], [link("D1", "D2"), link("D3", "D1")], 3, 0.25);
  const sliced = withPeers("1", plan, (item) => ({ session: `s-${item}`, nodeRun: `/run/${item}` }));
  assert.equal(sliced.slices.length, 3);
  const s1 = sliced.slices.find((s) => s.drafts.includes("D1"))!;
  assert.deepEqual(
    s1.peers.map((p) => [p.item, p.session, p.nodeRun, p.links.length]),
    sliced.slices.filter((s) => s !== s1).map((s) => [s.id, `s-${s.id}`, `/run/${s.id}`, 1])
  );
  const s3 = sliced.slices.find((s) => s.drafts.includes("D3"))!;
  assert.deepEqual(s3.peers.find((p) => p.item === s1.id)!.links, [link("D3", "D1")]);
  assert.deepEqual(s3.peers.find((p) => p.item !== s1.id)!.links, [], "D2 and D3 share no link");
});

const PLAN: SlicePlan = {
  round: "1",
  slices: [
    { id: "S1", drafts: ["D1"], rows: ["R.1", "R.3"], files: ["a.ts"], peers: [] },
    { id: "S2", drafts: ["D2"], rows: ["R.2"], files: ["b.ts"], peers: [] },
  ],
};

test("the slices' fix files join into the round's one: a line per row in table order, one exit checks block naming each slice", () => {
  const s2 = `R.2 · dropped — not a problem\n\n${checks("two")}`;
  const s1 = `R.3 · fixed · abc1234 — three\nR.1 · fixed · abc1234 — one\n\n${checks("one")}`;
  const joined = joinSliceFixes(PLAN, [s2, s1], ["R.1", "R.2", "R.3"]);
  assert.equal(joined, ["R.1 · fixed · abc1234 — one", "R.2 · dropped — not a problem", "R.3 · fixed · abc1234 — three", "exit checks:", ...EXIT_CHECKS.map((k) => `${k}: S1 — one; S2 — two`), ""].join("\n"));
  assert.throws(() => joinSliceFixes(PLAN, [s1], ["R.1", "R.2", "R.3"]), /no fix file from slice S2/);
  assert.throws(() => joinSliceFixes(PLAN, [s1, s1, s2], ["R.1", "R.2", "R.3"]), /two fix files from slice S1/);
  assert.throws(() => joinSliceFixes(PLAN, [s1, `R.9 · dropped — x\n\n${checks("x")}`], ["R.1", "R.2", "R.3"]), /answers R\.9, which no slice of round 1 holds/);
  const solo = `R.1 · fixed · abc1234 — one\n\n${checks("as written")}`;
  assert.equal(joinSliceFixes({ round: "1", slices: [{ ...PLAN.slices[0]!, rows: ["R.1"] }] }, [solo], ["R.1"]), solo, "one slice's file passes through as written");
});

test("a conflicted slice replaces its rows and exit checks with the exact blocked merge result", () => {
  const commit = "123456789abcdef0123456789abcdef01234567";
  const s1 = `R.1 · fixed · abc1234 — one\nR.3 · dropped — three\n\n${checks("one")}`;
  const s2 = `R.2 · fixed · abc1234 — two\n\n${checks("two")}`;
  assert.equal(
    joinSliceFixes(PLAN, [s1, s2], ["R.1", "R.2", "R.3"], [{ slice: "S2", commit, unmerged: { cause: "conflict", paths: ["a.txt"] } }]),
    [
      "R.1 · fixed · abc1234 — one",
      "R.2 · blocked — merging slice S2's commit 123456789abcdef0123456789abcdef01234567 conflicted on a.txt with a slice merged before it; its fix is not in the run tree",
      "R.3 · dropped — three",
      "exit checks:",
      ...EXIT_CHECKS.map((key) => `${key}: S1 — one; S2 — none — slice S2's commit did not merge`),
      "",
    ].join("\n")
  );
});

test("a merged slice's null unmerged leaves its fix file unchanged", () => {
  const s1 = `R.1 · fixed · abc1234 — one\nR.3 · dropped — three\n\n${checks("one")}`;
  const s2 = `R.2 · fixed · abc1234 — two\n\n${checks("two")}`;
  const rows = ["R.1", "R.2", "R.3"];
  assert.equal(joinSliceFixes(PLAN, [s1, s2], rows, [{ slice: "S2", commit: "123456789abcdef", unmerged: null }]), joinSliceFixes(PLAN, [s1, s2], rows));
});

test("a conflict naming a slice outside the plan is rejected", () => {
  const s1 = `R.1 · fixed · abc1234 — one\nR.3 · dropped — three\n\n${checks("one")}`;
  const s2 = `R.2 · fixed · abc1234 — two\n\n${checks("two")}`;
  assert.throws(() => joinSliceFixes(PLAN, [s1, s2], ["R.1", "R.2", "R.3"], [{ slice: "S9", commit: "123456789abcdef", unmerged: { cause: "conflict", paths: ["a.txt"] } }]), /S9/);
});

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "graph-slices-"));
  dirs.push(d);
  return d;
};
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function opCtx(dir: string, nodeId: string, role: string, inputs: DataValues, outputs: string[], tree = dir): OpContext {
  return opContext(dir, { runId: "build-17-ab", nodeId, role, inputs, outputs, iteration: 2, place: { worktree: tree } });
}

const repoConfig = (dir: string, tree: string, subagentMax: number) =>
  files(put(join(dir, "in", "repo-config.json"), JSON.stringify({ tree, stepsFile: "", steps: {}, notes: {}, briefsDir: null, baseRef: "main", thresholds: { ...DEFAULTS, SUBAGENT_MAX: subagentMax } })));

test("D-plan-slices writes the fix-slices list and the slice plan: the fixer cap from the repo's thresholds, each peer's session and node-run folder", async () => {
  const dir = scratch();
  const drafts = { round: "2", slices: [draft("D1", 2), draft("D2", 1), draft("D3", 1)] };
  const inputs: DataValues = {
    "draft-slices": files(put(join(dir, "in", "draft", DRAFT_FILE), JSON.stringify(drafts))),
    "repo-config": repoConfig(dir, dir, 2),
    links: files(put(join(dir, "in", "links", LINKS_FILE), JSON.stringify({ links: [link("D2", "D3"), link("D1", "D3")] }))),
  };
  const r = await OPS["plan-slices"]!(opCtx(dir, "D-plan-slices", "slices", inputs, ["slice-plan"]));
  assert.equal(r.status, "done");
  const out = r.status === "done" ? r.outputs : {};
  assert.deepEqual(out["fix-slices"], { schema: "items", items: [{ id: "S1", after: [] }, { id: "S2", after: [] }] });
  const plan = JSON.parse(readFileSync(join(dir, "out", "slice-plan", PLAN_FILE), "utf8")) as SlicePlan;
  assert.deepEqual(plan.slices.map((s) => [s.id, s.drafts]), [["S1", ["D1"]], ["S2", ["D2", "D3"]]]);
  const peer = plan.slices[0]!.peers[0]!;
  assert.equal(peer.item, "S2");
  assert.equal(peer.session, sessionName("build-17-ab", "A-fixer", 2, "S2"));
  assert.equal(peer.session, "build-17-ab-A-fixer-2-S2");
  assert.equal(peer.nodeRun, join(dir, "nodes", "A-fixer", "2", "S2"));
  assert.deepEqual(peer.files, ["d2.ts", "d3.ts"]);
  assert.deepEqual(peer.links, [link("D1", "D3")]);
});

test("D-plan-slices with no links (the slicer skipped or failed open) packs the draft with no warnings", async () => {
  const dir = scratch();
  const drafts = { round: "1", slices: [draft("D1", 1), draft("D2", 1)] };
  const inputs: DataValues = { "draft-slices": files(put(join(dir, "in", "draft", DRAFT_FILE), JSON.stringify(drafts))), "repo-config": repoConfig(dir, dir, 4) };
  const r = await OPS["plan-slices"]!(opCtx(dir, "D-plan-slices", "slices", inputs, ["slice-plan"]));
  assert.equal(r.status, "done");
  const plan = JSON.parse(readFileSync(join(dir, "out", "slice-plan", PLAN_FILE), "utf8")) as SlicePlan;
  assert.deepEqual(plan.slices.map((s) => [s.id, s.drafts, s.peers.map((p) => p.links.length)]), [["S1", ["D1"], [0]], ["S2", ["D2"], [0]]]);
});

test("D-merge-fix after two slices merged back: the run tree's head, the joined fix file, and the diff over the round's whole range", async () => {
  const dir = scratch();
  const tree = join(dir, "tree");
  mkdirSync(tree);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: tree, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const roundHead = git("rev-parse", "HEAD");
  for (const f of ["a.ts", "b.ts"]) {
    writeFileSync(join(tree, f), `${f}\n`);
    git("add", f);
    git("commit", "-q", "-m", `fix: ${f}`);
  }
  const head = git("rev-parse", "HEAD");
  const table: TableJson = { schema: 2, rounds: { "1": { head: roundHead, rows: [], leftovers: [], banked: [], closed: [], consumed: [], refused: [] } } };
  const state: TableState = { round: "1", rows: [{ id: "R.1", kind: "structure" }, { id: "R.2", kind: "behavior" }, { id: "R.3", kind: "structure" }], fixed: [], driftGroups: 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [] };
  const inputs: DataValues = {
    "slice-fix": files(
      put(join(dir, "in", "S1", "fix-1.txt"), `R.1 · fixed · abc1234 — one\nR.3 · dropped — three\n\n${checks("one")}`),
      put(join(dir, "in", "S2", "fix-1.txt"), `R.2 · fixed · abc1234 — two\n\n${checks("two")}`)
    ),
    "slice-plan": files(put(join(dir, "in", "plan", PLAN_FILE), JSON.stringify(PLAN))),
    table: files(put(join(dir, "in", "table", "table.json"), serialiseTableJson(table)), put(join(dir, "in", "table", "state.json"), JSON.stringify(state))),
    brief: files(put(join(dir, "in", "brief", "quick-x.md"), briefText())),
    "repo-config": repoConfig(dir, tree, 4),
  };
  const r = await OPS["merge-fix"]!(opCtx(dir, "D-merge-fix", "merge-fix", inputs, ["fix-file", "fix-diff", "owed-review-fix-call"], tree));
  assert.equal(r.status, "done");
  const out = r.status === "done" ? r.outputs : {};
  assert.deepEqual(out["fix-head"], { schema: "ref", kind: "commit", id: head });
  assert.equal(
    readFileSync(join(dir, "out", "fix-file", "fix-1.txt"), "utf8"),
    ["R.1 · fixed · abc1234 — one", "R.2 · fixed · abc1234 — two", "R.3 · dropped — three", "exit checks:", ...EXIT_CHECKS.map((k) => `${k}: S1 — one; S2 — two`), ""].join("\n")
  );
  const patch = readFileSync(join(dir, "out", "fix-diff", "fix.patch"), "utf8");
  assert.ok(patch.includes("a.ts") && patch.includes("b.ts"), "both slices' commits are in the round's diff");
  assert.equal(out["owed-review-fix-call"]?.schema === "check" && out["owed-review-fix-call"].answer, "pass", "S2 fixed a behavior row");
});

test("D-merge-fix writes a conflicted slice's blocked fix file and does not owe a re-review call", async () => {
  const dir = scratch();
  const tree = join(dir, "tree");
  mkdirSync(tree);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: tree, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const roundHead = git("rev-parse", "HEAD");
  for (const file of ["a.ts", "b.ts"]) {
    writeFileSync(join(tree, file), `${file}\n`);
    git("add", file);
    git("commit", "-q", "-m", `fix: ${file}`);
  }
  const head = git("rev-parse", "HEAD");
  const table: TableJson = { schema: 2, rounds: { "1": { head: roundHead, rows: [], leftovers: [], banked: [], closed: [], consumed: [], refused: [] } } };
  const state: TableState = { round: "1", rows: [{ id: "R.1", kind: "structure" }, { id: "R.2", kind: "behavior" }, { id: "R.3", kind: "structure" }], fixed: [], driftGroups: 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [] };
  const commit = "123456789abcdef0123456789abcdef01234567";
  const inputs: DataValues = {
    "slice-fix": files(
      put(join(dir, "in", "S1", "fix-1.txt"), `R.1 · fixed · abc1234 — one\nR.3 · dropped — three\n\n${checks("one")}`),
      put(join(dir, "in", "S2", "fix-1.txt"), `R.2 · fixed · abc1234 — two\n\n${checks("two")}`)
    ),
    "slice-conflict": files(put(join(dir, "in", "conflict", CONFLICT_FILE), JSON.stringify({ slice: "S2", commit, unmerged: { cause: "conflict", paths: ["b.ts"] } }))),
    "slice-plan": files(put(join(dir, "in", "plan", PLAN_FILE), JSON.stringify(PLAN))),
    table: files(put(join(dir, "in", "table", "table.json"), serialiseTableJson(table)), put(join(dir, "in", "table", "state.json"), JSON.stringify(state))),
    brief: files(put(join(dir, "in", "brief", "quick-x.md"), briefText())),
    "repo-config": repoConfig(dir, tree, 4),
  };
  const result = await OPS["merge-fix"]!(opCtx(dir, "D-merge-fix", "merge-fix", inputs, ["fix-file", "fix-diff", "owed-review-fix-call"], tree));
  assert.equal(result.status, "done");
  if (result.status !== "done") throw new Error("D-merge-fix did not finish");
  assert.deepEqual(result.outputs["fix-head"], { schema: "ref", kind: "commit", id: head });
  assert.equal(
    readFileSync(join(dir, "out", "fix-file", "fix-1.txt"), "utf8"),
    [
      "R.1 · fixed · abc1234 — one",
      "R.2 · blocked — merging slice S2's commit 123456789abcdef0123456789abcdef01234567 conflicted on b.ts with a slice merged before it; its fix is not in the run tree",
      "R.3 · dropped — three",
      "exit checks:",
      ...EXIT_CHECKS.map((key) => `${key}: S1 — one; S2 — none — slice S2's commit did not merge`),
      "",
    ].join("\n")
  );
  assert.equal(result.outputs["owed-review-fix-call"]?.schema === "check" && result.outputs["owed-review-fix-call"].answer, "fail");
});

// ---- crosstalk.jsonl ----

test("parseCrosstalk skips blank lines, keeps good ones in order, and names each bad line by its 1-based number", () => {
  const good = (to: string) => JSON.stringify({ at: "t", to, session: "s", text: "x" });
  const text = [good("A"), "", "   ", "{nope", JSON.stringify([1]), JSON.stringify({ at: "t", to: "B", session: "s" }), good("C")].join("\n");
  const { messages, problems } = parseCrosstalk(text, "f.jsonl");
  assert.deepEqual(messages.map((m) => m.to), ["A", "C"]);
  assert.equal(problems.length, 3);
  assert.equal(problems[0], "f.jsonl line 4: not JSON; dropped");
  assert.equal(problems[1], "f.jsonl line 5: at, to, session, text not a string; dropped");
  assert.equal(problems[2], "f.jsonl line 6: text not a string; dropped");
  assert.deepEqual(parseCrosstalk("\n\n"), { messages: [], problems: [] });
});
