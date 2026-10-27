/**
 * A finished run's record (`mock/record.ts`): each node's verdict, each gate's decisions, whether
 * each data item reached the nodes that ran, each check's answers, and the Markdown it renders.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Gate, NodeRun, RunHistory } from "../contracts.ts";
import { graph as toy } from "../examples/toy.ts";
import { gateText, renderRecord, runRecord } from "../mock/record.ts";

const history = (nodes: NodeRun[], over: Partial<RunHistory> = {}): RunHistory => ({ runId: "r", graph: toy, phase: "done", nodes, loops: [], asking: [], data: {}, ...over });
const line = (h: RunHistory, node: string) => runRecord(toy, h).nodes.find((n) => n.node === node)!;
const done = (node: string, over: Partial<NodeRun> = {}): NodeRun => ({ node, iteration: 0, status: "done", ...over });

test("a gate reads back as the condition it holds, nested gates parenthesised", () => {
  const cases: [Gate, string][] = [
    [{ classifier: "needs-review", answer: "yes" }, "needs-review = yes"],
    [{ loop: "fix-loop", answer: "clean" }, "loop fix-loop = clean"],
    [{ on: "test-report", answer: "pass" }, "test-report = pass"],
    [{ anyOf: [{ on: "a", answer: "pass" }, { loop: "l", answer: "capped" }] }, "any of (a = pass, loop l = capped)"],
    [{ allOf: [{ classifier: "k", answer: "no" }, { anyOf: [{ on: "x", answer: "fail" }, { on: "y", answer: "fail" }] }] }, "all of (k = no, any of (x = fail, y = fail))"],
  ];
  for (const [gate, text] of cases) assert.equal(gateText(gate), text);
});

test("a node's verdict: ran beats failed beats skipped, and a node with no record was not reached", () => {
  const h = history([
    done("plan"),
    { node: "fix", iteration: 1, status: "failed", reason: "boom" },
    done("fix", { iteration: 2 }),
    { node: "review", iteration: 0, status: "skipped", reason: "gate" },
    { node: "tests", iteration: 1, status: "failed", reason: "x" },
    { node: "tests", iteration: 2, status: "skipped" },
    { node: "merge-fix", iteration: 1, status: "running" },
  ]);
  assert.equal(line(h, "plan").verdict, "ran");
  assert.equal(line(h, "fix").verdict, "ran", "a later success does not hide that it ran, and the runs list both");
  assert.equal(line(h, "tests").verdict, "failed");
  assert.equal(line(h, "review").verdict, "skipped");
  assert.equal(line(h, "open-pr").verdict, "not reached");
  assert.equal(line(h, "merge-fix").verdict, "not reached", "a node that only started has not finished");
  assert.deepEqual(runRecord(toy, h).counts, { ran: 2, failed: 1, skipped: 1, "not reached": 3 });
});

test("a run is located as - for the top level, #<iteration> in a loop, @<item> in a fan-out, and carries its answer and reason", () => {
  const h = history([
    done("needs-review", { answer: "yes" }),
    done("tests", { iteration: 2, answer: "pass" }),
    { node: "fix", iteration: 1, instance: "P1", status: "failed", reason: "boom" },
    { node: "review", iteration: 0, instance: "P2", status: "skipped", reason: "gate" },
  ]);
  const r = runRecord(toy, h);
  assert.deepEqual(r.nodes.find((n) => n.node === "needs-review")!.runs, [{ at: "-", status: "done", answer: "yes" }]);
  assert.deepEqual(r.nodes.find((n) => n.node === "tests")!.runs, [{ at: "#2", status: "done", answer: "pass" }]);
  assert.deepEqual(r.nodes.find((n) => n.node === "fix")!.runs, [{ at: "#1@P1", status: "failed", reason: "boom" }]);
  assert.deepEqual(r.nodes.find((n) => n.node === "review")!.runs, [{ at: "-@P2", status: "skipped", reason: "gate" }]);
  const close = history([done("needs-review", { answer: "no", p: 0.27666, cutoff: 0.2875 })]);
  assert.match(renderRecord(runRecord(toy, close)), /\| needs-review \| classifier \| ran \| - done no \(p 0\.277, cut-off 0\.2875\) \|/, "a classifier row says how close the call was");
});

test("a restarted fan-out node keeps its count in the record and Markdown, while an original run stays as it was", () => {
  const restarted = history([
    { node: "review", iteration: 0, instance: "P2", status: "done", restarts: 1 },
    { node: "review", iteration: 0, instance: "P2", status: "failed", restarts: 2, reason: "boom" },
  ]);
  assert.deepEqual(line(restarted, "review").runs, [
    { at: "-@P2", status: "done", restarts: 1 },
    { at: "-@P2", status: "failed", restarts: 2, reason: "boom" },
  ]);
  assert.match(renderRecord(runRecord(toy, restarted)), /\| review \| agent \| ran \| -@P2 done \(1 restart\); -@P2 failed \(2 restarts\): boom \|/);

  const original = renderRecord(runRecord(toy, history([{ node: "review", iteration: 0, instance: "P2", status: "done" }])));
  assert.match(original, /\| review \| agent \| ran \| -@P2 done \|/);
  assert.doesNotMatch(original, /restart/);
});

test("a gate's decisions: closed with the reason when skipped, open with the status otherwise, none when never reached", () => {
  const h = history([done("needs-review"), { node: "review", iteration: 0, status: "skipped", reason: "gate needs-review answered no, not yes" }]);
  const gates = runRecord(toy, h).gates;
  assert.deepEqual(gates.find((g) => g.node === "review"), { node: "review", gate: "needs-review = yes", decisions: ["- closed: gate needs-review answered no, not yes"] });
  assert.deepEqual(gates.find((g) => g.node === "open-pr")!.decisions, []);
  const open = runRecord(toy, history([done("review")])).gates.find((g) => g.node === "review")!;
  assert.deepEqual(open.decisions, ["- open (done)"]);
});

test("a data item is missed by a reader that ran without it though it was produced; not produced, nobody missed it", () => {
  const h = history(
    [done("plan"), done("review", { inputs: [] }), done("fix", { iteration: 1, inputs: ["plan"] }), done("needs-review", { inputs: ["plan"] })],
    { data: { plan: { schema: "files", files: ["/p"] } } }
  );
  const plan = runRecord(toy, h).data.find((d) => d.id === "plan")!;
  assert.equal(plan.produced, true);
  assert.deepEqual(plan.producers, ["plan"]);
  assert.deepEqual(plan.readers.find((r) => r.node === "review"), { node: "review", optional: false, runs: 1, got: 0 });
  assert.deepEqual(plan.readers.find((r) => r.node === "fix"), { node: "fix", optional: false, runs: 1, got: 1 });
  assert.deepEqual(plan.missed, ["review"]);
  const code = runRecord(toy, history([done("tests", { inputs: [] })])).data.find((d) => d.id === "code")!;
  assert.equal(code.produced, false);
  assert.deepEqual(code.missed, [], "an item nothing produced is not missed by its readers");
});

test("a reader that never ran, or ran without recorded inputs, is not counted as missing the item", () => {
  const h = history([done("plan"), done("review")], { data: { plan: { schema: "files", files: ["/p"] } } });
  const plan = runRecord(toy, h).data.find((d) => d.id === "plan")!;
  assert.deepEqual(plan.readers.find((r) => r.node === "review"), { node: "review", optional: false, runs: 0, got: 0 });
  assert.deepEqual(plan.missed, []);
});

test("a loop's outcome item names the loop as its producer; an optional reader is marked", () => {
  const r = runRecord(toy, history([]));
  assert.deepEqual(r.data.find((d) => d.id === "fix-outcome")!.producers, ["loop fix-loop"]);
  assert.equal(r.data.find((d) => d.id === "review")!.readers.find((x) => x.node === "fix")!.optional, true);
  assert.deepEqual(r.data.find((d) => d.id === "request")!.producers, []);
});

test("an item counts as produced when its producer finished, even if the history holds no value", () => {
  const r = runRecord(toy, history([done("plan")]));
  assert.equal(r.data.find((d) => d.id === "plan")!.produced, true);
  assert.equal(r.data.find((d) => d.id === "review")!.produced, false);
});

test("each check lists its runs: the answer, or the failure with its reason", () => {
  const h = history([done("tests", { iteration: 1, answer: "fail" }), done("tests", { iteration: 2 }), { node: "tests", iteration: 3, status: "failed", reason: "no repo" }, { node: "tests", iteration: 4, status: "skipped" }]);
  assert.deepEqual(runRecord(toy, h).checks, [{ node: "tests", runs: ["#1 fail", "#2 done", "#3 failed: no repo", "#4 skipped"] }]);
});

test("runCounts tallies every node run by status, each iteration and item separately", () => {
  const h = history([done("plan"), done("fix", { iteration: 1 }), done("fix", { iteration: 2 }), { node: "tests", iteration: 1, status: "failed" }]);
  assert.deepEqual(runRecord(toy, h).runCounts, { done: 3, failed: 1 });
});

test("a question is told with its asker, type, route, and who answered it, and whether the brief changed", () => {
  const q = { id: "SIMP.4", type: "product" as const, text: "?", searched: [] };
  const h = history([], {
    questions: [
      { from: { node: "fix", iteration: 2, instance: "P1" }, question: q, route: "resolver", answer: { question_id: "SIMP.4", answer: "a", source: "brief", by: "resolver", brief_change: "x" } },
      { from: { node: "plan", iteration: 0 }, question: { ...q, id: "Q2", type: "blocked" }, route: "retry" },
    ],
  });
  assert.deepEqual(runRecord(toy, h).questions, ["fix#2@P1 asked SIMP.4 (product) → resolver, answered by resolver, brief changed", "plan asked Q2 (blocked) → retry"]);
});

test("the Markdown opens with the phase and error, then the counts, the loops and the tables", () => {
  const h = history([done("plan"), { node: "open-pr", iteration: 0, status: "failed", reason: "bad | pipe\nnew line" }], {
    phase: "failed",
    error: "boom | here",
    loops: [{ loop: "fix-loop", iterations: 1, outcome: "capped" }, { loop: "other", iterations: 2 }],
  });
  const md = renderRecord(runRecord(toy, h));
  const lines = md.split("\n");
  assert.equal(lines[0], "phase: failed — boom \\| here");
  assert.equal(lines[1], "nodes: 1 ran, 0 skipped, 1 failed, 5 not reached (a node that ran once counts as ran)");
  assert.equal(lines[2], "node runs: 1 done, 1 failed");
  assert.equal(lines[3], "loops: fix-loop 1 iterations, capped; other 2 iterations, unfinished");
  assert.ok(md.includes("| open-pr | data | failed | - failed: bad \\| pipe new line |"), "a cell never breaks the table");
  for (const h3 of ["### Nodes", "### Gates", "### Data", "### Checks", "### Questions"]) assert.ok(md.includes(h3), h3);
  assert.ok(md.endsWith("none\n"), "no questions");
});

test("the Markdown of a clean run with nothing recorded says none for loops and never reached for gates", () => {
  const md = renderRecord(runRecord(toy, history([])));
  assert.match(md, /^phase: done\n/);
  assert.match(md, /\nloops: none\n/);
  assert.match(md, /\| review \| needs-review = yes \| never reached \|/);
  assert.match(md, /\| request \| \(run input\) \| no \|/);
});

// A fan-out's status item has a producer (the fan-out), as a loop's outcome item does (`loop <id>`).
test("a fan-out's status item names the fan-out as its producer, not a run input", () => {
  const g = {
    id: "fan",
    data: [
      { id: "req", schema: "text" as const, boundary: "input" as const },
      { id: "listed", schema: "check" as const },
      { id: "items", schema: "items" as const },
      { id: "worked", schema: "check" as const, boundary: "terminal" as const },
      { id: "chain-ok", schema: "check" as const, boundary: "terminal" as const },
    ],
    nodes: [
      { id: "K-list", kind: "check" as const, role: "list", inputs: ["req"], outputs: ["listed", "items"], timeCapMs: 1000 },
      { id: "K-work", kind: "check" as const, role: "work", inputs: ["listed"], outputs: ["worked"], timeCapMs: 1000 },
    ],
    loops: [],
    fanOuts: [{ id: "chain", over: "items", nodes: ["K-work"], status: "chain-ok" }],
  };
  const r = runRecord(g, { runId: "r", graph: g, phase: "done", nodes: [], loops: [], asking: [], data: {} });
  assert.ok(r.data.find((d) => d.id === "chain-ok")!.producers.some((p) => p.includes("chain")));
  assert.doesNotMatch(renderRecord(r), /\| chain-ok \| \(run input\)/);
});
