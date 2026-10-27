import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GraphDef, NodeDef } from "../contracts.ts";
import { defineGraph, GraphError, validateGraph } from "../define.ts";
import { graph as toy } from "../examples/toy.ts";

const MIN = 60_000;
const agent = (id: string, inputs: string[], outputs: string[], extra: Partial<NodeDef> = {}): NodeDef => ({
  id,
  kind: "agent",
  role: id,
  inputs,
  outputs,
  timeCapMs: MIN,
  ...extra,
});

/** A valid two-node graph to break one way at a time. */
function base(): GraphDef {
  return {
    id: "g",
    data: [
      { id: "req", schema: "text", boundary: "input" },
      { id: "a-out", schema: "files" },
      { id: "b-out", schema: "files", boundary: "terminal" },
    ],
    nodes: [agent("a", ["req"], ["a-out"]), agent("b", ["a-out"], ["b-out"])],
    loops: [],
  };
}

const has = (problems: string[], fragment: string) =>
  assert.ok(problems.some((p) => p.includes(fragment)), `expected a problem with "${fragment}", got:\n${problems.join("\n")}`);

test("the toy graph and the base graph are valid", () => {
  assert.deepEqual(validateGraph(toy), []);
  assert.deepEqual(validateGraph(base()), []);
});

test("a node takes its model from one of its own text inputs, and only an agent has a model", () => {
  const g = base();
  g.nodes[1] = agent("b", ["a-out", "model"], ["b-out"], { modelFrom: "model" });
  g.data.push({ id: "model", schema: "text" });
  g.data.push({ id: "m-check", schema: "check" });
  g.nodes.push({ id: "m", kind: "check", role: "m", inputs: ["req"], outputs: ["m-check", "model"], timeCapMs: MIN });
  assert.deepEqual(validateGraph(g), []);
  g.nodes[1]!.modelFrom = "a-out";
  has(validateGraph(g), "node b takes its model from a-out, which must be one of its text inputs");
  g.nodes[1]!.modelFrom = "req";
  has(validateGraph(g), "node b takes its model from req, which must be one of its text inputs");
  g.nodes[1]!.modelFrom = "model";
  g.nodes[1]!.kind = "data";
  has(validateGraph(g), "node b is a data: only an agent runs on a model");
});

test("an input with no producer fails", () => {
  const g = base();
  g.data.push({ id: "ghost", schema: "files" });
  g.nodes[1]!.inputs.push("ghost");
  has(validateGraph(g), "data ghost is read but nothing produces it");
});

test("an optional input with no producer fails too", () => {
  const g = base();
  g.data.push({ id: "ghost", schema: "files" });
  g.nodes[1]!.optionalInputs = ["ghost"];
  has(validateGraph(g), "data ghost is read but nothing produces it");
});

test("an output with no consumer fails unless it is terminal", () => {
  const g = base();
  delete g.data[2]!.boundary;
  has(validateGraph(g), "data b-out is produced but nothing reads it");
  g.data[2]!.boundary = "terminal";
  assert.deepEqual(validateGraph(g), []);
});

test("a cycle outside a loop fails", () => {
  const g = base();
  g.data.push({ id: "back", schema: "files" });
  g.nodes[1]!.outputs.push("back");
  g.nodes[0]!.optionalInputs = ["back"];
  has(validateGraph(g), "cycle outside a loop: a → b → a");
});

test("the same cycle inside a loop passes when its back edge is carried", () => {
  const g = base();
  g.data.push({ id: "verdict", schema: "check" });
  g.nodes.push({ id: "c", kind: "check", role: "c", inputs: ["b-out"], outputs: ["verdict"], timeCapMs: MIN });
  g.data[2]!.boundary = undefined;
  g.nodes[0]!.optionalInputs = ["verdict"];
  g.loops.push({ id: "l", nodes: ["a", "b", "c"], until: { node: "c", answer: "pass" }, cap: 2, carry: ["verdict"] });
  assert.deepEqual(validateGraph(g), []);
  g.loops[0]!.carry = [];
  has(validateGraph(g), "cycle inside loop l not broken by a carry");
});

test("a carried input read as required fails", () => {
  const g = base();
  g.data.push({ id: "verdict", schema: "check" });
  g.nodes.push({ id: "c", kind: "check", role: "c", inputs: ["b-out"], outputs: ["verdict"], timeCapMs: MIN });
  g.data[2]!.boundary = undefined;
  g.nodes[0]!.inputs.push("verdict");
  g.loops.push({ id: "l", nodes: ["a", "b", "c"], until: { node: "c", answer: "pass" }, cap: 2, carry: ["verdict"] });
  has(validateGraph(g), "node a reads carried verdict as required");
});

test("a gate on a classifier waits for yes or no, the only answers a classifier gives", () => {
  const g = base();
  g.data.push({ id: "call", schema: "verdict" });
  g.nodes.push({ id: "k", kind: "classifier", role: "k", inputs: ["req"], outputs: ["call"], timeCapMs: MIN });
  g.nodes[1]!.gate = { classifier: "k", answer: "yes" };
  assert.deepEqual(validateGraph(g), []);
  g.nodes[1]!.gate = { classifier: "k", answer: "run" };
  has(validateGraph(g), "node b is gated on classifier k = run; a classifier answers yes or no");
});

test("a gate naming a non-classifier fails", () => {
  const g = base();
  g.nodes[1]!.gate = { classifier: "a", answer: "yes" };
  has(validateGraph(g), "node b is gated on a, an agent, not a classifier");
  g.nodes[1]!.gate = { classifier: "nobody", answer: "yes" };
  has(validateGraph(g), "node b is gated on nobody, which is not a node");
});

test("duplicate ids fail", () => {
  const g = base();
  g.data.push({ id: "req", schema: "text" });
  g.nodes.push(agent("a", ["req"], ["b-out"]));
  const problems = validateGraph(g);
  has(problems, "duplicate data id req");
  has(problems, "duplicate node, loop or fan-out id a");
});

test("kind contracts: a classifier writes one verdict, a data node's role is an operation", () => {
  const g = base();
  g.nodes.push({ id: "k", kind: "classifier", role: "k", inputs: ["a-out"], outputs: ["b-out"], timeCapMs: MIN });
  g.nodes.push({ id: "d", kind: "data", role: "teleport", inputs: ["a-out"], outputs: [], timeCapMs: MIN });
  const problems = validateGraph(g);
  has(problems, "node k is a classifier: it writes exactly one verdict output");
  has(problems, "node d is a data node: its role is one of ingest, ticket, comment, push, pr, merge, merge-back, got teleport");
});

test("a loop's stop node must be an ungated check or classifier inside it", () => {
  const g = base();
  g.loops.push({ id: "l", nodes: ["b"], until: { node: "b", answer: "pass" }, cap: 0 });
  const problems = validateGraph(g);
  has(problems, "loop l stops on b, an agent: a check or classifier decides");
  has(problems, "loop l needs a cap of a whole number ≥ 1");
});

test("defineGraph throws a GraphError listing every problem", () => {
  assert.throws(
    () =>
      defineGraph({
        id: "bad",
        data: [{ id: "x", schema: "files" }],
        nodes: [{ id: "n", kind: "agent", role: "n", inputs: ["x"], outputs: ["x"], timeCapMs: MIN }],
      }),
    (e: unknown) => e instanceof GraphError && e.problems.some((p) => p.includes("cycle outside a loop: n → n"))
  );
});

test("a node kind or data schema outside the known lists fails", () => {
  const g = base();
  (g.nodes[0] as { kind: string }).kind = "agnet";
  (g.data[1] as { schema: string }).schema = "file";
  const problems = validateGraph(g);
  has(problems, "node a has kind agnet, not one of agent, classifier, check, data");
  has(problems, "data a-out has schema file, not one of");
});

test("a data operation's input contract: merge needs a ref, ingest needs text", () => {
  const g = base();
  g.data.push({ id: "merged", schema: "ref", boundary: "terminal" });
  g.nodes.push({ id: "m", kind: "data", role: "merge", inputs: ["req"], outputs: ["merged"], timeCapMs: MIN });
  has(validateGraph(g), "node m (merge) needs a required ref input");
  g.data.push({ id: "ticket-text", schema: "text", boundary: "terminal" });
  g.nodes.push({ id: "i", kind: "data", role: "ingest", inputs: ["a-out"], outputs: ["ticket-text"], timeCapMs: MIN });
  has(validateGraph(g), "node i (ingest) needs a required text input");
});

test("a merge needs the gate: a check among its required inputs, or it fails at the end of a run instead of at its start", () => {
  const g = base();
  g.data.push({ id: "pr", schema: "ref" }, { id: "gate", schema: "check" }, { id: "merged", schema: "ref", boundary: "terminal" });
  g.nodes.push({ id: "open", kind: "data", role: "pr", inputs: ["a-out"], outputs: ["pr"], timeCapMs: MIN });
  g.nodes.push({ id: "m", kind: "data", role: "merge", inputs: ["pr"], outputs: ["merged"], timeCapMs: MIN });
  has(validateGraph(g), "node m (merge) needs a required check input: the gate");
  g.nodes.push({ id: "t", kind: "check", role: "tests", inputs: ["a-out"], outputs: ["gate"], timeCapMs: MIN });
  g.nodes.find((n) => n.id === "m")!.inputs = ["pr", "gate"];
  assert.deepEqual(validateGraph(g).filter((p) => p.includes("node m")), []);
  g.nodes.find((n) => n.id === "m")!.inputs = ["pr"];
  g.nodes.find((n) => n.id === "m")!.optionalInputs = ["gate"];
  has(validateGraph(g), "node m (merge) needs a required check input: the gate");
});

test("only an agent declares that it writes", () => {
  const g = base();
  g.data.push({ id: "v", schema: "verdict" });
  g.nodes.push({ id: "k", kind: "classifier", role: "k", inputs: ["a-out"], outputs: ["v"], writes: true, timeCapMs: MIN });
  g.nodes[1]!.gate = { classifier: "k", answer: "yes" };
  has(validateGraph(g), "node k is a classifier: only an agent writes to a worktree");
});

test("a gate on a loop needs the loop to declare an outcome item, and one of its outcomes", () => {
  const g = structuredClone(toy);
  const pr = g.nodes.find((n) => n.id === "open-pr")!;
  pr.gate = { loop: "fix-loop", answer: "green" };
  has(validateGraph(g), "node open-pr is gated on loop fix-loop = green; a loop ends clean, capped, aborted");
  pr.gate = { loop: "nope", answer: "clean" };
  has(validateGraph(g), "node open-pr is gated on loop nope, which is not a loop");
  pr.gate = { loop: "fix-loop", answer: "clean" };
  delete g.loops[0]!.outcome;
  has(validateGraph(g), "node open-pr is gated on loop fix-loop, which declares no outcome");
});

test("a loop's outcome item has schema outcome, and no node of the loop reads or gates on it", () => {
  const g = structuredClone(toy);
  g.data.find((d) => d.id === "fix-outcome")!.schema = "check";
  has(validateGraph(g), "loop fix-loop writes its outcome to fix-outcome, which is check, not outcome");
  const h = structuredClone(toy);
  h.nodes.find((n) => n.id === "fix")!.optionalInputs!.push("fix-outcome");
  has(validateGraph(h), "node fix reads the outcome of its own loop fix-loop");
  const k = structuredClone(toy);
  k.nodes.find((n) => n.id === "tests")!.gate = { loop: "fix-loop", answer: "clean" };
  has(validateGraph(k), "node tests is gated on its own loop fix-loop");
});

// ---- fan-out status ----

const chk = (id: string, inputs: string[], outputs: string[], extra: Partial<NodeDef> = {}): NodeDef => ({ id, kind: "check", role: id, inputs, outputs, timeCapMs: MIN, ...extra });

/** A valid fan-out whose status `chain-ok` gates a node outside it, to break one way at a time. */
function fanBase(): GraphDef {
  return {
    id: "f",
    data: [
      { id: "req", schema: "text", boundary: "input" },
      { id: "listed", schema: "check" },
      { id: "items", schema: "items" },
      { id: "worked", schema: "check" },
      { id: "chain-ok", schema: "check" },
      { id: "end", schema: "check", boundary: "terminal" },
      { id: "whole", schema: "check", boundary: "terminal" },
    ],
    nodes: [
      chk("K-list", ["req"], ["listed", "items"]),
      chk("K-work", ["req"], ["worked"]),
      chk("K-end", ["listed"], ["end"], { optionalInputs: ["worked"] }),
      chk("K-whole", ["listed"], ["whole"], { gate: { on: "chain-ok", answer: "pass" } }),
    ],
    loops: [],
    fanOuts: [{ id: "chain", over: "items", nodes: ["K-work"], status: "chain-ok" }],
  };
}

test("a fan-out with a status item that a node outside it gates on is valid", () => {
  assert.deepEqual(validateGraph(fanBase()), []);
});

test("a fan-out status naming an undeclared item fails", () => {
  const g = fanBase();
  g.fanOuts![0]!.status = "ghost";
  has(validateGraph(g), "fan-out chain writes its status to ghost, which is not declared");
});

test("a fan-out status must be a check item, not text or files", () => {
  for (const schema of ["text", "files"] as const) {
    const g = fanBase();
    g.data.find((d) => d.id === "chain-ok")!.schema = schema;
    has(validateGraph(g), `fan-out chain writes its status to chain-ok, which is ${schema}, not check`);
  }
});

test("a node of the fan-out reading its own fan's status fails, as an input and as a gate", () => {
  const asInput = fanBase();
  asInput.nodes.find((n) => n.id === "K-work")!.optionalInputs = ["chain-ok"];
  has(validateGraph(asInput), "node K-work reads the status of its own fan-out chain");
  const asGate = fanBase();
  asGate.nodes.find((n) => n.id === "K-work")!.gate = { on: "chain-ok", answer: "pass" };
  has(validateGraph(asGate), "node K-work reads the status of its own fan-out chain");
});

test("a fan-out status item written by a node as well has two producers", () => {
  const g = fanBase();
  g.nodes.find((n) => n.id === "K-end")!.outputs.push("chain-ok");
  has(validateGraph(g), "data chain-ok has more than one producer: node K-end, fan-out chain");
});

test("a fan-out status that nothing reads fails unless it is terminal", () => {
  const g = fanBase();
  delete g.nodes.find((n) => n.id === "K-whole")!.gate;
  has(validateGraph(g), "data chain-ok is produced but nothing reads it");
  g.data.find((d) => d.id === "chain-ok")!.boundary = "terminal";
  assert.deepEqual(validateGraph(g), []);
});

test("a node gating on the status of a fan-out that waits on that node is a cycle outside a loop", () => {
  const g = fanBase();
  g.nodes.find((n) => n.id === "K-list")!.gate = { on: "chain-ok", answer: "pass" };
  has(validateGraph(g), "cycle outside a loop");
});

// ---- the amended brief ----

/** A valid graph with an amend service that rewrites `brief` (output `brief-amended`) and a reparse check. */
function amendBase(): GraphDef {
  return {
    id: "a",
    data: [
      { id: "request", schema: "text", boundary: "input" },
      { id: "brief", schema: "files" },
      { id: "parsed", schema: "check", boundary: "terminal" },
      { id: "route-question", schema: "check" },
      { id: "answer", schema: "files" },
      { id: "amend-commit", schema: "ref" },
      { id: "brief-amended", schema: "files" },
    ],
    nodes: [
      agent("A-write-brief", ["request"], ["brief"]),
      chk("K-parse", ["brief"], ["parsed"]),
      chk("K-route-question", [], ["route-question"]),
      agent("A-answer-question", ["request"], ["answer"]),
      agent("A-amend", ["brief"], ["amend-commit", "brief-amended"], { writes: true }),
    ],
    loops: [],
    services: { route: "K-route-question", resolver: "A-answer-question", amend: "A-amend" },
    amended: { output: "brief-amended", replaces: "brief", reparse: "K-parse" },
  };
}

test("an amended brief with an amend service, a matching schema and a top-level reparse check is valid", () => {
  assert.deepEqual(validateGraph(amendBase()), []);
});

test("amended needs the amend service to exist and to write", () => {
  const none = amendBase();
  delete none.services!.amend;
  has(validateGraph(none), "amended needs an amend service");
  const readOnly = amendBase();
  delete readOnly.nodes.find((n) => n.id === "A-amend")!.writes;
  has(validateGraph(readOnly), "service amend is node A-amend, which does not write");
});

test("amended output must be one the amend service writes", () => {
  const g = amendBase();
  g.amended!.output = "answer";
  has(validateGraph(g), "amended: answer is not an output of the amend service A-amend");
});

test("amended replaces an item that is declared and has the output's schema", () => {
  const missing = amendBase();
  missing.amended!.replaces = "ghost";
  has(validateGraph(missing), "amended replaces ghost, which is not declared");
  const other = amendBase();
  other.amended!.replaces = "parsed";
  has(validateGraph(other), "amended: brief-amended is files and parsed is check");
});

test("amended reparse must be a declared, top-level check node that reads the replaced item", () => {
  const ghost = amendBase();
  ghost.amended!.reparse = "ghost";
  has(validateGraph(ghost), "amended reparses with ghost, which is not declared");
  const notCheck = amendBase();
  notCheck.data.push({ id: "notes", schema: "files", boundary: "terminal" });
  notCheck.nodes.push(agent("A-reader", ["brief"], ["notes"]));
  notCheck.amended!.reparse = "A-reader";
  has(validateGraph(notCheck), "amended reparses with A-reader: a top-level check node that reads brief");
  const service = amendBase();
  service.data.push({ id: "output-format", schema: "check" });
  service.nodes.push(chk("K-output-format", ["brief"], ["output-format"]));
  service.services!.schema = "K-output-format";
  service.amended!.reparse = "K-output-format";
  has(validateGraph(service), "amended reparses with K-output-format: a top-level check node that reads brief");
  const unrelated = amendBase();
  unrelated.data.push({ id: "other", schema: "text", boundary: "terminal" });
  unrelated.nodes.push(chk("K-other", ["request"], ["other"]));
  unrelated.amended!.reparse = "K-other";
  has(validateGraph(unrelated), "amended reparses with K-other: a top-level check node that reads brief");
});

test("a reparse check inside a loop is refused: the amend runs it at the top level", () => {
  const g = amendBase();
  g.loops.push({ id: "l", nodes: ["K-parse"], until: { node: "K-parse", answer: "pass" }, cap: 1 });
  has(validateGraph(g), "amended reparses with K-parse: a top-level check node that reads brief");
});

// ---- a fan-out inside a loop ----

/** Loop L lists the round's items (K-plan) and fans out over them (F: K-work), then stops on K-stop,
 *  which reads F's status: a valid fan-out inside a loop, to break one way at a time. */
function loopFanBase(): GraphDef {
  return {
    id: "lf",
    data: [
      { id: "req", schema: "text", boundary: "input" },
      { id: "planned", schema: "check" },
      { id: "items", schema: "items" },
      { id: "worked", schema: "check", boundary: "terminal" },
      { id: "fan-ok", schema: "check" },
      { id: "stop", schema: "check" },
    ],
    nodes: [chk("K-plan", ["req"], ["planned", "items"]), chk("K-work", ["req"], ["worked"]), chk("K-stop", ["planned", "fan-ok"], ["stop"])],
    loops: [{ id: "L", nodes: ["K-plan", "K-work", "K-stop"], until: { node: "K-stop", answer: "pass" }, cap: 2 }],
    fanOuts: [{ id: "F", over: "items", nodes: ["K-work"], status: "fan-ok" }],
  };
}

test("a fan-out whose nodes all sit in one loop is valid", () => {
  assert.deepEqual(validateGraph(loopFanBase()), []);
});

test("a fan-out with nodes both in a loop and outside it is refused", () => {
  const g = loopFanBase();
  g.data.push({ id: "more", schema: "check", boundary: "terminal" });
  g.nodes.push(chk("K-more", ["req"], ["more"]));
  g.fanOuts![0]!.nodes.push("K-more");
  has(validateGraph(g), "fan-out F has nodes in loop L and no loop: a fan-out sits wholly inside one loop or outside every loop");
});

test("a loop's stop node cannot be a fan-out's node: it runs once an iteration", () => {
  const g = loopFanBase();
  g.fanOuts![0]!.nodes.push("K-stop");
  g.nodes.find((n) => n.id === "K-stop")!.inputs = ["planned"];
  has(validateGraph(g), "node K-stop is in fan-out F and stops loop L");
});

test("inside a loop, a list made after the fan-out it feeds is a cycle in the loop's body", () => {
  const g = loopFanBase();
  g.nodes.find((n) => n.id === "K-plan")!.inputs = ["req", "fan-ok"];
  g.nodes.find((n) => n.id === "K-stop")!.inputs = ["planned"];
  has(validateGraph(g), "cycle inside loop L not broken by a carry: K-plan → fan F → K-plan");
});

// ---- fail-open agents ----

test("only an agent that does not write fails open, and its outputs are read as optional only", () => {
  const ok = base();
  ok.nodes[0]!.failOpen = true;
  ok.nodes[1]!.inputs = ["req"];
  ok.nodes[1]!.optionalInputs = ["a-out"];
  assert.deepEqual(validateGraph(ok), []);
  const required = base();
  required.nodes[0]!.failOpen = true;
  has(validateGraph(required), "node b reads a-out as required, which a leaves out when it fails open: an optional input");
  const check = fanBase();
  check.nodes[0]!.failOpen = true;
  has(validateGraph(check), "node K-list fails open: only an agent that does not write does");
});
