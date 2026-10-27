import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { ContractError, type DataValue, type DataValues, type JevBinding, NON_RETRYABLE_ERROR_TYPES, RunError } from "../contracts.ts";
import { CAP_ABORT_LEAD_MS, HEARTBEAT_TIMEOUT_MS, NODE_MAX_ATTEMPTS, PROCESS_TEARDOWN_BUDGET_MS } from "../constants.ts";
import { defineGraph, scopeUnits } from "../define.ts";
import { graph as toy } from "../examples/toy.ts";
import {
  activityOptions,
  carryForward,
  checkRunConfig,
  checkRunInputs,
  conflictStep,
  conflictText,
  conflictWriter,
  decide,
  fanStatus,
  finalPhase,
  finishedOutcome,
  localAbortMs,
  loopExports,
  loopStep,
  nodeInputs,
  requestInputs,
  restartText,
  skipReason,
  unitDeps,
} from "../schedule.ts";

const files = (f: string): DataValue => ({ schema: "files", files: [f] });
const verdict = (answer: string): DataValue => ({ schema: "verdict", answer, p: 0.9 });
const check = (answer: "pass" | "fail"): DataValue => ({ schema: "check", answer, detail: "" });
const node = (id: string) => toy.nodes.find((n) => n.id === id)!;
const loop = toy.loops[0]!;
const view = (started: string[], finished: string[], data: DataValues) => ({ started: new Set(started), finished: new Set(finished), data });

test("scope units: the top level holds the nodes outside loops and each loop; a body holds its nodes", () => {
  assert.deepEqual(scopeUnits(toy, null).map((u) => `${u.kind}:${u.id}`), ["node:plan", "node:needs-review", "node:review", "node:open-pr", "loop:fix-loop"]);
  assert.deepEqual(scopeUnits(toy, { kind: "loop", id: "fix-loop" }).map((u) => u.id), ["fix", "merge-fix", "tests"]);
});

test("dependencies: a gate is a dependency, a loop waits on what its body reads from outside, a carry is not waited on", () => {
  assert.deepEqual(unitDeps(toy, { kind: "node", id: "review" }, null), ["node:plan", "node:needs-review"]);
  assert.deepEqual(unitDeps(toy, { kind: "loop", id: "fix-loop" }, null).sort(), ["node:plan", "node:review"]);
  assert.deepEqual(unitDeps(toy, { kind: "node", id: "open-pr" }, null), ["loop:fix-loop"], "its inputs and its gate on the loop's outcome");
  assert.deepEqual(unitDeps(toy, { kind: "node", id: "fix" }, { kind: "loop", id: "fix-loop" }), []);
  assert.deepEqual(unitDeps(toy, { kind: "node", id: "tests" }, { kind: "loop", id: "fix-loop" }), ["node:fix", "node:merge-fix"]);
});

test("decide starts what is ready, in parallel, and nothing twice", () => {
  const request = { request: { schema: "text", text: "go" } } as const;
  assert.deepEqual(decide(toy, null, view([], [], request)).start.map((u) => u.id), ["plan"]);
  const afterPlan = { ...request, plan: files("p") };
  assert.deepEqual(decide(toy, null, view(["node:plan"], ["node:plan"], afterPlan)).start.map((u) => u.id), ["needs-review"]);
  const both = decide(toy, null, view(["node:plan", "node:needs-review"], ["node:plan", "node:needs-review"], { ...afterPlan, "review-call": verdict("yes") }));
  assert.deepEqual(both.start.map((u) => u.id), ["review"]);
  assert.deepEqual(decide(toy, null, view(["node:plan", "node:needs-review", "node:review"], ["node:plan", "node:needs-review"], afterPlan)).start, []);

  const fan = defineGraph({
    id: "fan",
    data: [
      { id: "req", schema: "text", boundary: "input" },
      { id: "x", schema: "files", boundary: "terminal" },
      { id: "y", schema: "files", boundary: "terminal" },
    ],
    nodes: [
      { id: "b", kind: "agent", role: "b", inputs: ["req"], outputs: ["x"], timeCapMs: 1000 },
      { id: "c", kind: "agent", role: "c", inputs: ["req"], outputs: ["y"], timeCapMs: 1000 },
    ],
  });
  assert.deepEqual(decide(fan, null, view([], [], { req: { schema: "text", text: "go" } })).start.map((u) => u.id), ["b", "c"]);
});

test("a gate answered otherwise skips its node, and the loop then starts", () => {
  const data = { plan: files("p"), "review-call": verdict("no") };
  const d = decide(toy, null, view(["node:plan", "node:needs-review"], ["node:plan", "node:needs-review"], data));
  assert.deepEqual(d.skip, [{ node: "review", reason: "gate needs-review answered no, not yes" }]);
  const next = decide(toy, null, view(["node:plan", "node:needs-review", "node:review"], ["node:plan", "node:needs-review", "node:review"], data));
  assert.deepEqual(next.start.map((u) => u.id), ["fix-loop"]);
});

test("skip reasons: a gate that did not answer, a missing required input; an optional input is not needed", () => {
  assert.equal(skipReason(toy, node("review"), { plan: files("p") }), "gate needs-review did not answer");
  assert.equal(skipReason(toy, node("open-pr"), { code: files("c"), "fix-outcome": { schema: "outcome", answer: "clean" } }), "input test-report missing");
  assert.equal(skipReason(toy, node("fix"), { plan: files("p") }), null);
});

test("loop step: the stop answer ends it clean, the cap ends it capped, no stop value aborts it", () => {
  assert.equal(loopStep(loop, 1, check("fail")), "again");
  assert.equal(loopStep(loop, 2, check("pass")), "clean");
  assert.equal(loopStep(loop, 3, check("fail")), "capped");
  assert.equal(loopStep(loop, 1, undefined), "aborted");
});

test("the next iteration carries only what the carry ids got in the iteration that just ended", () => {
  assert.deepEqual(carryForward(loop, { code: files("c1"), "test-report": check("fail") }), { "test-report": check("fail") });
  assert.deepEqual(carryForward(loop, { code: files("c2") }), {}, "a carry its producer did not write this time is not kept from before");
});

test("a finished loop exports its last iteration's values and its outcome, nothing older", () => {
  const last = { code: files("c2") };
  assert.deepEqual(loopExports(loop, last, "capped"), { code: files("c2"), "fix-outcome": { schema: "outcome", answer: "capped" } });
  assert.equal(loopExports(loop, last, "clean")["test-report"], undefined, "test-report from an earlier iteration does not escape");
  assert.deepEqual(loopExports({ ...loop, outcome: undefined }, last, "clean"), last);
});

test("a node's inputs are the required and optional inputs present", () => {
  assert.deepEqual(nodeInputs(node("fix"), { plan: files("p"), review: files("r"), code: files("c") }), { plan: files("p"), review: files("r") });
});

test("a carried input comes from the iteration's starting snapshot, never from this iteration's live value", () => {
  const live = { plan: files("p"), "test-report": check("pass") };
  assert.deepEqual(nodeInputs(node("fix"), live, {}, ["test-report"]), { plan: files("p") }, "iteration 1 has no carry");
  assert.deepEqual(nodeInputs(node("fix"), live, { "test-report": check("fail") }, ["test-report"]), { plan: files("p"), "test-report": check("fail") });
});

test("run inputs: exactly the declared input items, each valid against its schema", () => {
  assert.deepEqual(requestInputs(toy, "add greet"), { request: { schema: "text", text: "add greet" } });
  assert.deepEqual(checkRunInputs(toy, requestInputs(toy, "x")), []);
  assert.deepEqual(checkRunInputs(toy, {}), ["no value for input request"]);
  assert.deepEqual(checkRunInputs(toy, { request: { schema: "files", files: ["/x"] } } as DataValues), [
    "data request schema: expected text",
    "data request text: expected a string",
  ]);
  assert.deepEqual(checkRunInputs(toy, { ...requestInputs(toy, "x"), code: files("/injected") }), ["code is not an input of graph toy"]);
});

test("the run fails when any node failed in any iteration, or a loop aborted; a later success does not undo it", () => {
  const done = { node: "plan", iteration: 0, status: "done" } as const;
  assert.equal(finalPhase([done], [{ loop: "fix-loop", iterations: 3, outcome: "capped" }]), "done");
  assert.equal(finalPhase([{ node: "fix", iteration: 1, status: "failed" }, { node: "fix", iteration: 2, status: "done" }], []), "failed");
  assert.equal(finalPhase([{ node: "fix", iteration: 1, status: "failed" }, { node: "fix", iteration: 2, status: "skipped" }], []), "failed");
  assert.equal(finalPhase([done], [{ loop: "fix-loop", iterations: 1, outcome: "aborted" }]), "failed");
});

const ref = (kind: "commit" | "merge" | "pr" | "ticket", id: string): DataValue => ({ schema: "ref", kind, id });

test("a run's finished outcome: a merge ref wins over every phase, else failed, cancelled and abandoned say so, else unmerged", () => {
  assert.deepEqual(finishedOutcome({ phase: "done", data: { merge: ref("merge", "7"), pr: ref("pr", "7") } }), { outcome: "merged", pr: 7 });
  assert.equal(finishedOutcome({ phase: "failed", data: { merge: ref("merge", "7") } }).outcome, "merged", "a failure after the merge (cleanup) does not undo it");
  assert.equal(finishedOutcome({ phase: "cancelled", data: { merge: ref("merge", "7") } }).outcome, "merged");
  assert.equal(finishedOutcome({ phase: "failed", data: {} }).outcome, "failed");
  assert.equal(finishedOutcome({ phase: "cancelled", data: {} }).outcome, "cancelled");
  assert.equal(finishedOutcome({ phase: "abandoned", data: { pr: ref("pr", "9") } }).outcome, "abandoned");
  assert.equal(finishedOutcome({ phase: "done", data: {} }).outcome, "unmerged", "a graph that merges nothing");
  assert.equal(finishedOutcome({ phase: "running", data: {} }).outcome, "unmerged");
});

test("a finished outcome names the PR's number only when a pr ref holds one", () => {
  assert.deepEqual(finishedOutcome({ phase: "abandoned", data: { pr: ref("pr", "12") } }), { outcome: "abandoned", pr: 12 });
  assert.deepEqual(finishedOutcome({ phase: "failed", data: {} }), { outcome: "failed" }, "no pr key at all");
  assert.deepEqual(finishedOutcome({ phase: "failed", data: { pr: ref("pr", "not-a-number") } }), { outcome: "failed" });
  assert.deepEqual(finishedOutcome({ phase: "failed", data: { commit: ref("commit", "123") } }), { outcome: "failed" }, "only a pr ref counts");
});

test("a gate on a loop reads its outcome", () => {
  const data = { code: files("c"), "test-report": check("fail") };
  assert.equal(skipReason(toy, node("open-pr"), data), "gate loop fix-loop did not answer");
  assert.equal(skipReason(toy, node("open-pr"), { ...data, "fix-outcome": { schema: "outcome", answer: "capped" } }), "gate loop fix-loop answered capped, not clean");
  assert.equal(skipReason(toy, node("open-pr"), { ...data, "fix-outcome": { schema: "outcome", answer: "clean" } }), null);
});

test("activity options: the node's cap per attempt, a heartbeat timeout, one retry, contract errors not retried", () => {
  const o = activityOptions(toy, node("fix"));
  assert.equal(o.startToCloseTimeout, node("fix").timeCapMs);
  assert.equal(o.heartbeatTimeout, HEARTBEAT_TIMEOUT_MS);
  assert.equal(o.retry.maximumAttempts, NODE_MAX_ATTEMPTS);
  assert.equal(NODE_MAX_ATTEMPTS, 2);
  assert.deepEqual(o.retry.nonRetryableErrorTypes, NON_RETRYABLE_ERROR_TYPES);
  assert.equal("heartbeatTimeout" in activityOptions(toy, { ...node("fix"), timeCapMs: HEARTBEAT_TIMEOUT_MS }), false);
});

test("the never-retried types are the names the error classes really carry", () => {
  assert.ok(NON_RETRYABLE_ERROR_TYPES.includes(new ContractError([]).name));
  assert.ok(NON_RETRYABLE_ERROR_TYPES.includes(new RunError("x").name));
});

test("a data operation that is not idempotent gets one attempt; ingest keeps its retry", () => {
  const data = (role: string) => ({ id: role, kind: "data" as const, role, inputs: [], outputs: ["o"], timeCapMs: 60_000 });
  for (const role of ["ticket", "pr", "push", "merge"]) assert.equal(activityOptions(toy, data(role)).retry.maximumAttempts, 1, role);
  assert.equal(activityOptions(toy, data("ingest")).retry.maximumAttempts, NODE_MAX_ATTEMPTS);
});

test("a check bound to the shell runner must name a verification step; stubbed checks and other roles are not held to it", () => {
  const shell = { adapter: "shell" as const };
  const stub = { adapter: "stub" as const, answers: {}, default: "pass" as const };
  const base = { agent: { adapter: "codex" as const }, classifier: { adapter: "stub" as const, answers: {}, default: { answer: "no", p: 0 } }, tracker: { adapter: "file" as const }, forge: { adapter: "file" as const } };
  const graph = (role: string) => ({ ...toy, nodes: toy.nodes.map((n) => (n.id === "tests" ? { ...n, role } : n)) });
  assert.deepEqual(checkRunConfig(toy, { ...base, check: shell, roles: {} }), []);
  assert.deepEqual(checkRunConfig(graph("merge"), { ...base, check: shell, roles: {} }), ["node tests is a check bound to the shell runner: its role merge must be one of checks, exit_checks, fix_checks, tests, mutation_proof, db_gate, size"]);
  assert.deepEqual(checkRunConfig(graph("merge"), { ...base, check: stub, roles: {} }), []);
  assert.equal(checkRunConfig(graph("push"), { ...base, check: stub, roles: { push: { check: shell } } }).length, 1, "a role's own shell binding counts");
});

test("a stub classifier answers yes or no, as a real one does, so a gate on it can fire", () => {
  const check = { adapter: "stub" as const, answers: {}, default: "pass" as const };
  const config = (answers: Record<string, { answer: string; p: number } | { answer: string; p: number }[]>, dflt = "no") => ({
    agent: { adapter: "codex" as const },
    classifier: { adapter: "stub" as const, answers, default: { answer: dflt, p: 0 } },
    check,
    tracker: { adapter: "file" as const },
    forge: { adapter: "file" as const },
    roles: {},
  });
  assert.deepEqual(checkRunConfig(toy, config({ "needs-review": [{ answer: "yes", p: 1 }, { answer: "no", p: 0 }] })), []);
  assert.deepEqual(checkRunConfig(toy, config({ "needs-review": { answer: "run", p: 1 } })), ["node needs-review's stub answers run; a classifier answers yes or no"]);
  assert.deepEqual(checkRunConfig(toy, config({}, "skip")), ["node needs-review's stub answers skip; a classifier answers yes or no"]);
});

test("every classifier node needs a binding, and a Jev or Haiku setup reads only what its node is handed", () => {
  const base = { agent: { adapter: "codex" as const }, check: { adapter: "stub" as const, answers: {}, default: "pass" as const }, tracker: { adapter: "file" as const }, forge: { adapter: "file" as const } };
  const jev = (fields: JevBinding["fields"], features: JevBinding["features"] = []): JevBinding => ({ adapter: "jev", setup: { name: "test", sha256: "0" }, model: "m", fields, questions: { q: { type: "noul", instructions: "Q?" } }, combine: "mean", features, cutoff: 0.5 });
  const withOptional = { ...toy, data: [...toy.data, { id: "extra", schema: "text" as const }], nodes: toy.nodes.map((n) => (n.id === "needs-review" ? { ...n, optionalInputs: ["extra"] } : n)) };
  const run = (b: JevBinding | undefined) => checkRunConfig(withOptional, { ...base, roles: b === undefined ? {} : { "needs-review": { classifier: b } } });
  assert.deepEqual(run(undefined), ["node needs-review has no classifier binding: the config has no default and no roles.needs-review.classifier"]);
  assert.deepEqual(run(jev({ plan: { input: "plan" }, extra: { input: "extra", optional: true } })), []);
  assert.deepEqual(run(jev({ extra: { input: "extra" } })), ["node needs-review's classifier field extra reads the optional input extra and is not marked optional"]);
  assert.deepEqual(run(jev({ x: { input: "nowhere" } })), ["node needs-review's classifier field x reads nowhere, which is not an input of the node"]);
  assert.deepEqual(run(jev({ plan: { input: "plan" } }, [{ input: "extra", pattern: "x", weight: 1 }])), ["node needs-review's classifier feature reads extra, which is not a required input of the node"]);
});

// ---- a fan-out's status ----

const ids = (n: number) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

test("fan status: every item finished passes and says how many", () => {
  assert.deepEqual(fanStatus(ids(3), () => false), { schema: "check", answer: "pass", detail: "all 3 items finished" });
});

test("fan status: an empty list passes, saying the list is empty", () => {
  assert.deepEqual(fanStatus([], () => true), { schema: "check", answer: "pass", detail: "the list is empty" });
});

test("fan status: a single down item is enough to fail it", () => {
  assert.deepEqual(fanStatus(ids(3), (i) => i === "P2"), { schema: "check", answer: "fail", detail: "items P2 failed or skipped for one that did" });
});

test("fan status: a down item fails it, naming the down items in list order and not the others", () => {
  const down = new Set(["P3", "P1"]);
  assert.deepEqual(fanStatus(ids(4), (i) => down.has(i)), { schema: "check", answer: "fail", detail: "items P1, P3 failed or skipped for one that did" });
});

/** A fan-out `chain` over `items` whose status `chain-ok` gates a node, and a loop with a node gated on it. */
const fanGraph = defineGraph({
  id: "fan",
  data: [
    { id: "req", schema: "text", boundary: "input" },
    { id: "listed", schema: "check" },
    { id: "items", schema: "items" },
    { id: "worked", schema: "check", boundary: "terminal" },
    { id: "chain-ok", schema: "check" },
    { id: "whole", schema: "check", boundary: "terminal" },
    { id: "after-ok", schema: "check" },
    { id: "stop", schema: "check", boundary: "terminal" },
  ],
  nodes: [
    { id: "K-list", kind: "check", role: "list", inputs: ["req"], outputs: ["listed", "items"], timeCapMs: 1000 },
    { id: "K-work", kind: "check", role: "work", inputs: ["req"], outputs: ["worked"], timeCapMs: 1000 },
    { id: "K-whole", kind: "check", role: "whole", inputs: ["listed"], outputs: ["whole"], gate: { on: "chain-ok", answer: "pass" }, timeCapMs: 1000 },
    { id: "K-reads", kind: "check", role: "reads", inputs: ["chain-ok"], outputs: ["after-ok"], timeCapMs: 1000 },
    { id: "K-stop", kind: "check", role: "stop", inputs: ["after-ok"], outputs: ["stop"], timeCapMs: 1000 },
  ],
  fanOuts: [{ id: "chain", over: "items", nodes: ["K-work"], status: "chain-ok" }],
  loops: [{ id: "L", nodes: ["K-reads", "K-stop"], until: { node: "K-stop", answer: "pass" }, cap: 1 }],
});

test("a node gated on a fan-out's status, or reading it, waits for the fan-out unit and not a node", () => {
  assert.deepEqual(unitDeps(fanGraph, { kind: "node", id: "K-whole" }, null).sort(), ["fan:chain", "node:K-list"]);
  assert.deepEqual(unitDeps(fanGraph, { kind: "node", id: "K-reads" }, null), ["fan:chain"]);
});

test("a loop whose body reads a fan-out's status waits for the fan-out, and the fan-out waits for its list", () => {
  assert.deepEqual(unitDeps(fanGraph, { kind: "loop", id: "L" }, null), ["fan:chain"]);
  assert.deepEqual(unitDeps(fanGraph, { kind: "fan", id: "chain" }, null), ["node:K-list"]);
});

test("a node gated on a fan-out's status neither starts nor skips until the fan-out has finished", () => {
  const listed = { listed: check("pass"), items: { schema: "items", items: [{ id: "P1", after: [] }] } } as const satisfies DataValues;
  const finished = ["node:K-list"];
  const before = decide(fanGraph, null, view(["node:K-list"], finished, listed));
  assert.deepEqual(before.start.map((u) => u.id), ["chain"], "only the fan-out is ready");
  assert.deepEqual(before.skip, []);
  const during = decide(fanGraph, null, view(["node:K-list", "fan:chain"], finished, listed));
  assert.deepEqual(during.skip, []);
  assert.deepEqual(during.start, []);
});

test("once the fan-out finished, a failed status skips the gated node with the reason and a passed one starts it", () => {
  const listed = { listed: check("pass") };
  const done = ["node:K-list", "fan:chain"];
  const failed = decide(fanGraph, null, view(done, done, { ...listed, "chain-ok": check("fail") }));
  assert.deepEqual(failed.skip, [{ node: "K-whole", reason: "gate chain-ok answered fail, not pass" }]);
  assert.ok(!failed.start.some((u) => u.id === "K-whole"));
  const passed = decide(fanGraph, null, view(done, done, { ...listed, "chain-ok": check("pass") }));
  assert.ok(passed.start.some((u) => u.id === "K-whole"));
  assert.deepEqual(passed.skip, []);
});

/** Loop R lists each round's items (K-plan), fans out over them (F: K-work), and stops on K-stop, which
 *  reads F's status and carries nothing. */
const loopFan = defineGraph({
  id: "loop-fan",
  data: [
    { id: "req", schema: "text", boundary: "input" },
    { id: "planned", schema: "check" },
    { id: "items", schema: "items" },
    { id: "worked", schema: "check", boundary: "terminal" },
    { id: "fan-ok", schema: "check" },
    { id: "stop", schema: "check" },
  ],
  nodes: [
    { id: "K-plan", kind: "check", role: "plan", inputs: ["req"], outputs: ["planned", "items"], timeCapMs: 1000 },
    { id: "K-work", kind: "check", role: "work", inputs: ["req", "planned"], outputs: ["worked"], timeCapMs: 1000 },
    { id: "K-stop", kind: "check", role: "stop", inputs: ["fan-ok"], outputs: ["stop"], timeCapMs: 1000 },
  ],
  loops: [{ id: "R", nodes: ["K-plan", "K-work", "K-stop"], until: { node: "K-stop", answer: "pass" }, cap: 2 }],
  fanOuts: [{ id: "F", over: "items", nodes: ["K-work"], status: "fan-ok" }],
});

test("a fan-out inside a loop is a unit of the loop's body, not of the top level; its nodes are its own", () => {
  assert.deepEqual(scopeUnits(loopFan, null).map((u) => `${u.kind}:${u.id}`), ["loop:R"]);
  assert.deepEqual(scopeUnits(loopFan, { kind: "loop", id: "R" }).map((u) => `${u.kind}:${u.id}`), ["node:K-plan", "node:K-stop", "fan:F"]);
  assert.deepEqual(scopeUnits(loopFan, { kind: "fan", id: "F" }).map((u) => `${u.kind}:${u.id}`), ["node:K-work"]);
});

test("in the loop's body, the fan-out waits for the node that writes its list, and a node reading its status waits for the fan-out", () => {
  const R = { kind: "loop" as const, id: "R" };
  assert.deepEqual(unitDeps(loopFan, { kind: "fan", id: "F" }, R), ["node:K-plan"], "its list and its node's input, both K-plan's");
  assert.deepEqual(unitDeps(loopFan, { kind: "node", id: "K-stop" }, R), ["fan:F"]);
  assert.deepEqual(unitDeps(loopFan, { kind: "node", id: "K-work" }, { kind: "fan", id: "F" }), [], "inside an item, what the loop wrote is already there");
  assert.deepEqual(unitDeps(loopFan, { kind: "loop", id: "R" }, null), [], "the loop reads only the run's input from outside");
  const started = decide(loopFan, R, view(["node:K-plan"], ["node:K-plan"], { planned: check("pass"), items: { schema: "items", items: [{ id: "S1", after: [] }] } }));
  assert.deepEqual(started.start.map((u) => `${u.kind}:${u.id}`), ["fan:F"], "once the list is written the fan-out starts, and K-stop still waits");
});

test("an attempt is aborted by its worker twice the teardown budget before its cap, or at half a cap too short for it", () => {
  assert.equal(CAP_ABORT_LEAD_MS, 2 * PROCESS_TEARDOWN_BUDGET_MS);
  assert.equal(localAbortMs(600_000), 600_000 - CAP_ABORT_LEAD_MS);
  assert.equal(localAbortMs(CAP_ABORT_LEAD_MS), CAP_ABORT_LEAD_MS / 2);
});

test("a writer gets each bounded fresh run with its original conflict, then the cap names the blocked merge", () => {
  const conflict = { commit: "123456789abcdef", paths: ["graph/a.ts", "graph/b.ts"] };

  assert.deepEqual(conflictStep(conflict, 0, "W2", 2), { restart: { ...conflict, restart: 1 } });
  assert.deepEqual(conflictStep(conflict, 1, "W2", 2), { restart: { ...conflict, restart: 2 } });
  assert.deepEqual(conflictStep(conflict, 2, "W2", 2), {
    fail: "merging 123456789 into the run tree conflicted on graph/a.ts, graph/b.ts; W2 had its 2 fresh runs for it (WRITER_RESTART_CAP) and the last still conflicts",
  });
  assert.deepEqual(conflictStep(conflict, 0, "W2", 0), {
    fail: "merging 123456789 into the run tree conflicted on graph/a.ts, graph/b.ts; W2 had its 0 fresh runs for it (WRITER_RESTART_CAP) and the last still conflicts",
  });
});

test("a conflict's records share one opening: the restart reason names the writer, the restart and the cap", () => {
  const conflict = { commit: "123456789abcdef", paths: ["graph/a.ts", "graph/b.ts"] };
  assert.equal(conflictText(conflict), "merging 123456789 into the run tree conflicted on graph/a.ts, graph/b.ts");
  assert.equal(
    restartText({ ...conflict, restart: 2 }, "A-builder", 3),
    "merging 123456789 into the run tree conflicted on graph/a.ts, graph/b.ts; A-builder runs again on the run tree's head (restart 2 of 3)"
  );
});

test("the writer a merge's conflict runs again is the node of the merge's own scope that wrote the commit it read, and no other", () => {
  const sha = "abc123";
  const merge = node("merge-fix");
  const fixLoop = { kind: "loop", id: "fix-loop" } as const;
  const read: DataValues = { "fix-commit": { schema: "ref", kind: "commit", id: sha } };
  assert.equal(conflictWriter(toy, fixLoop, merge, read, sha), "fix");
  assert.equal(conflictWriter(toy, null, merge, read, sha), undefined, "fix is a node of the loop, not of the top level");
  assert.equal(conflictWriter(toy, fixLoop, merge, read, "def456"), undefined, "no input holds that commit");
  assert.equal(conflictWriter(toy, fixLoop, merge, {}, sha), undefined, "the input is absent");
  const fromInput = defineGraph({
    id: "merge-input",
    data: [
      { id: "given", schema: "ref", boundary: "input" },
      { id: "merged", schema: "ref", boundary: "terminal" },
    ],
    nodes: [{ id: "D-merge", kind: "data", role: "merge-back", inputs: ["given"], outputs: ["merged"], timeCapMs: 1 }],
    loops: [],
  });
  assert.equal(conflictWriter(fromInput, null, fromInput.nodes[0]!, { given: { schema: "ref", kind: "commit", id: sha } }, sha), undefined, "a run input has no writer");
});
