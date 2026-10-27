import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GraphDef, RunHistory } from "../contracts.ts";
import { graph as toy } from "../examples/toy.ts";
import { mermaidId, renderMermaid } from "../mermaid.ts";

const lines = (s: string) => s.split("\n").map((l) => l.trim());

test("the definition: each kind has its shape and class, data items are cylinders, the loop is a subgraph", () => {
  const out = lines(renderMermaid(toy));
  assert.equal(out[0], "flowchart LR");
  for (const kind of ["agent", "classifier", "check", "data"]) assert.ok(out.some((l) => l.startsWith(`classDef ${kind} `)), kind);
  assert.ok(out.includes('n_plan["plan<br/><i>agent: planner</i>"]:::agent'));
  assert.ok(out.includes('n_needs_2d_review{"needs-review<br/><i>classifier: needs-review</i>"}:::classifier'));
  assert.ok(out.includes('n_tests[["tests<br/><i>check: tests</i>"]]:::check'));
  assert.ok(out.includes('n_open_2d_pr[/"open-pr<br/><i>data: pr</i>"/]:::data'));
  assert.ok(out.includes('d_pr[("pr<br/><i>ref, terminal</i>")]:::data'));
  assert.ok(out.includes('subgraph s_loop_3a_fix_2d_loop["loop fix-loop: until tests = pass, cap 3"]'));
  assert.ok(!out.some((l) => l.startsWith("class ")), "no run marks without a history");
});

test("edges: outputs and inputs solid, optional dotted, carried labelled, the gate labelled with its answer", () => {
  const out = lines(renderMermaid(toy));
  assert.ok(out.includes("n_plan --> d_plan"));
  assert.ok(out.includes("d_plan --> n_fix"));
  assert.ok(out.includes("d_review -.-> n_fix"));
  assert.ok(out.includes("d_test_2d_report -.->|next iteration| n_fix"));
  assert.ok(out.includes('d_review_2d_call -.->|"gate = yes"| n_review'));
});

test("a run's history marks each node ran, skipped, or failed, with its last iteration, and the loop's outcome", () => {
  const history: RunHistory = {
    runId: "g-1",
    graph: toy,
    phase: "failed",
    nodes: [
      { node: "plan", iteration: 0, status: "done", attempt: 1 },
      { node: "needs-review", iteration: 0, status: "done" },
      { node: "review", iteration: 0, status: "skipped", reason: "gate needs-review answered no, not yes" },
      { node: "fix", iteration: 1, status: "done" },
      { node: "tests", iteration: 1, status: "done" },
      { node: "fix", iteration: 2, status: "done" },
      { node: "tests", iteration: 2, status: "done", answer: "pass" },
      { node: "open-pr", iteration: 0, status: "failed", reason: "boom" },
    ],
    loops: [{ loop: "fix-loop", iterations: 2, outcome: "clean" }],
    asking: [],
    data: {},
  };
  const out = lines(renderMermaid(toy, history));
  assert.ok(out.includes("%% graph toy, run g-1 (failed)"));
  assert.ok(out.includes("class n_plan ran"));
  assert.ok(out.includes("class n_review skipped"));
  assert.ok(out.includes("class n_open_2d_pr failed"));
  assert.ok(out.includes('n_fix["fix<br/><i>agent: fixer</i><br/>ran #2 (ran 2)"]:::agent'));
  assert.ok(out.includes('n_tests[["tests<br/><i>check: tests</i><br/>ran #2: pass (ran 2)"]]:::check'));
  assert.ok(out.includes('subgraph s_loop_3a_fix_2d_loop["loop fix-loop: until tests = pass, cap 3, 2 iterations, clean"]'));
});

test("ids: every character outside [A-Za-z0-9] is escaped, so two ids never collide; quotes in labels are escaped", () => {
  assert.notEqual(mermaidId("n", "a-b"), mermaidId("n", "a_b"));
  assert.match(mermaidId("n", "a.b-c_d"), /^n_[A-Za-z0-9_]+$/);
  const g = { ...toy, nodes: toy.nodes.map((n) => (n.id === "plan" ? { ...n, role: 'say "hi"' } : n)) };
  assert.ok(renderMermaid(g).includes("say #quot;hi#quot;"));
});

test("a node is drawn with its worst record: a failure in one iteration stays visible after a later success", () => {
  const history: RunHistory = {
    runId: "g-2",
    graph: toy,
    phase: "failed",
    nodes: [
      { node: "fix", iteration: 1, status: "failed", reason: "boom" },
      { node: "fix", iteration: 2, status: "done" },
      { node: "tests", iteration: 1, status: "done" },
      { node: "tests", iteration: 2, status: "skipped" },
    ],
    loops: [],
    asking: [],
    data: {},
  };
  const out = lines(renderMermaid(toy, history));
  assert.ok(out.includes("class n_fix failed"));
  assert.ok(out.includes('n_fix["fix<br/><i>agent: fixer</i><br/>failed #1 (failed 1, ran 1)"]:::agent'));
  assert.ok(out.includes("class n_tests ran"), "a run once beats a later skip");
});

test("a loop's outcome item hangs off the loop, and a gate on the loop is drawn from it", () => {
  const out = lines(renderMermaid(toy));
  assert.ok(out.includes("s_loop_3a_fix_2d_loop --> d_fix_2d_outcome"));
  assert.ok(out.includes('d_fix_2d_outcome -.->|"gate = clean"| n_open_2d_pr'));
});

// ---- a fan-out's status edge ----

const withFan = (status?: string): GraphDef => ({
  id: "fan",
  data: [
    { id: "req", schema: "text", boundary: "input" },
    { id: "listed", schema: "check" },
    { id: "items", schema: "items" },
    { id: "worked", schema: "check", boundary: "terminal" },
    { id: "chain-ok", schema: "check" },
    { id: "whole", schema: "check", boundary: "terminal" },
  ],
  nodes: [
    { id: "K-list", kind: "check", role: "list", inputs: ["req"], outputs: ["listed", "items"], timeCapMs: 1000 },
    { id: "K-work", kind: "check", role: "work", inputs: ["req"], outputs: ["worked"], timeCapMs: 1000 },
    { id: "K-whole", kind: "check", role: "whole", inputs: ["listed"], outputs: ["whole"], ...(status === undefined ? {} : { gate: { on: status, answer: "pass" } }), timeCapMs: 1000 },
  ],
  loops: [],
  fanOuts: [{ id: "chain", over: "items", nodes: ["K-work"], ...(status === undefined ? {} : { status }) }],
});

test("a fan-out with a status draws an edge from its subgraph to the status item, and the gate on it from the item", () => {
  const out = lines(renderMermaid(withFan("chain-ok")));
  assert.ok(out.includes("d_items -.->|for each| s_fan_3a_chain"));
  assert.ok(out.includes("s_fan_3a_chain --> d_chain_2d_ok"));
  assert.ok(out.includes('d_chain_2d_ok -.->|"gate = pass"| n_K_2d_whole'));
  assert.ok(out.includes('d_chain_2d_ok[("chain-ok<br/><i>check</i>")]:::data'), "the status item sits outside the fan-out's body");
});

test("a fan-out with no status draws no edge out of its subgraph", () => {
  const out = lines(renderMermaid(withFan()));
  assert.ok(out.includes("d_items -.->|for each| s_fan_3a_chain"));
  assert.ok(!out.some((l) => l.startsWith("s_fan_3a_chain -->")));
});
