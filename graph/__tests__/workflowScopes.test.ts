/**
 * The generic workflow's question handling in Temporal's time-skipping test environment: an amended
 * brief reaches the nodes of a live loop and of a live fan-out item, and a question that was answered
 * is not routed again when its asker runs again.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, type WorkflowBundle } from "@temporalio/worker";

import { type GraphDef, type RunConfig, type RunHistory, WORKFLOW_NAME, type WorkflowInput } from "../contracts.ts";
import { assertValidGraph } from "../define.ts";
import { requestInputs } from "../schedule.ts";
import { createWorker, WORKFLOWS_PATH } from "../worker.ts";
import { OPERATOR_APPROVE } from "../constants.ts";
import { runAnswering } from "./helpers/operator.ts";

const quiet = new DefaultLogger((process.env.GRAPH_TEST_LOG as "WARN" | undefined) ?? "ERROR");
Runtime.install({ logger: quiet });
const MIN = 60_000;
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "engine");

/** The services every graph here shares: the brief writer's resolver and amender, and the router. */
const SERVICE_DATA: GraphDef["data"] = [
  { id: "route-question", schema: "check" },
  { id: "answer", schema: "files" },
  { id: "amend-commit", schema: "ref" },
  { id: "brief-amended", schema: "files" },
];
const SERVICE_NODES: GraphDef["nodes"] = [
  { id: "K-route-question", kind: "check", role: "route", inputs: [], outputs: ["route-question"], timeCapMs: MIN },
  { id: "A-answer-question", kind: "agent", role: "resolver", inputs: ["request"], outputs: ["answer"], timeCapMs: MIN },
  { id: "A-amend", kind: "agent", role: "amender", inputs: ["brief"], outputs: ["amend-commit", "brief-amended"], writes: true, timeCapMs: MIN },
];

const graphOf = (g: GraphDef): GraphDef => (assertValidGraph(g), g);

/** K-ask (asks while the brief is v1) then K-after (reports the brief it read), both inside a loop. */
const loopGraph = graphOf({
  id: "loop-amend",
  data: [
    { id: "request", schema: "text", boundary: "input" },
    { id: "brief", schema: "files" },
    { id: "parsed", schema: "check" },
    { id: "brief-head", schema: "text" },
    { id: "asked", schema: "check" },
    { id: "after", schema: "check", boundary: "terminal" },
    ...SERVICE_DATA,
  ],
  nodes: [
    { id: "A-write-brief", kind: "agent", role: "briefer", inputs: ["request"], outputs: ["brief"], timeCapMs: MIN },
    { id: "K-parse", kind: "check", role: "parse", inputs: ["brief"], outputs: ["parsed", "brief-head"], timeCapMs: MIN },
    { id: "K-ask", kind: "check", role: "ask", inputs: ["request", "parsed", "brief-head"], outputs: ["asked"], timeCapMs: MIN },
    { id: "K-after", kind: "check", role: "after", inputs: ["asked", "brief", "brief-head"], outputs: ["after"], timeCapMs: MIN },
    ...SERVICE_NODES,
  ],
  loops: [{ id: "work", nodes: ["K-ask", "K-after"], until: { node: "K-after", answer: "pass" }, cap: 1 }],
  services: { route: "K-route-question", resolver: "A-answer-question", amend: "A-amend" },
  amended: { output: "brief-amended", replaces: "brief", reparse: "K-parse" },
});

/** The same two checks inside a fan-out over three items (the engine pipeline's `list`). */
const fanGraph = graphOf({
  id: "fan-amend",
  data: [
    { id: "request", schema: "text", boundary: "input" },
    { id: "brief", schema: "files" },
    { id: "parsed", schema: "check" },
    { id: "brief-head", schema: "text" },
    { id: "listed", schema: "check", boundary: "terminal" },
    { id: "items", schema: "items" },
    { id: "asked", schema: "check" },
    { id: "after", schema: "check", boundary: "terminal" },
    ...SERVICE_DATA,
  ],
  nodes: [
    { id: "A-write-brief", kind: "agent", role: "briefer", inputs: ["request"], outputs: ["brief"], timeCapMs: MIN },
    { id: "K-parse", kind: "check", role: "parse", inputs: ["brief"], outputs: ["parsed", "brief-head"], timeCapMs: MIN },
    { id: "K-list", kind: "check", role: "list", inputs: ["request"], outputs: ["listed", "items"], timeCapMs: MIN },
    { id: "K-ask", kind: "check", role: "ask", inputs: ["request", "parsed", "brief-head"], outputs: ["asked"], timeCapMs: MIN },
    { id: "K-after", kind: "check", role: "after", inputs: ["asked", "brief", "brief-head"], outputs: ["after"], timeCapMs: MIN },
    ...SERVICE_NODES,
  ],
  loops: [],
  fanOuts: [{ id: "items-fan", over: "items", nodes: ["K-ask", "K-after"] }],
  services: { route: "K-route-question", resolver: "A-answer-question", amend: "A-amend" },
  amended: { output: "brief-amended", replaces: "brief", reparse: "K-parse" },
});

/** A check that raises questions on its first two runs, with the router and the resolver. */
const reaskGraph = graphOf({
  id: "reask",
  data: [
    { id: "request", schema: "text", boundary: "input" },
    { id: "asked", schema: "check", boundary: "terminal" },
    { id: "route-question", schema: "check" },
    { id: "answer", schema: "files" },
  ],
  nodes: [
    { id: "K-reask", kind: "check", role: "reask", inputs: ["request"], outputs: ["asked"], timeCapMs: MIN },
    { id: "K-route-question", kind: "check", role: "route", inputs: [], outputs: ["route-question"], timeCapMs: MIN },
    { id: "A-answer-question", kind: "agent", role: "resolver", inputs: ["request"], outputs: ["answer"], timeCapMs: MIN },
  ],
  loops: [],
  services: { route: "K-route-question", resolver: "A-answer-question" },
});

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let tmp: string;
let runs = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A repo, and stub agents: a v1 brief, an answer (that amends the brief when `amends`), and an amend that writes v2. */
function setup(name: string, pipeline: string, amends: boolean): { repo: string; config: RunConfig } {
  const root = join(tmp, name);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "toy\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const agents = join(root, "agents");
  put(join(agents, "briefer", "brief", "brief.md"), "v1 brief\n");
  put(join(agents, "resolver", "answer", "answer.json"), JSON.stringify({ answer: "use v2", source: "brief", searched: [{ source: "brief", said: "v1 says to ask" }], ...(amends ? { brief_change: "say v2" } : {}) }));
  put(join(agents, "amender", "brief-amended", "brief.md"), "v2 brief\n");
  git(repo, "checkout", "-q", "-b", "amend");
  writeFileSync(join(repo, "README.md"), "toy, amended\n");
  git(repo, "commit", "-q", "-am", "amend brief: v2");
  mkdirSync(join(agents, "amender", "amend-commit"), { recursive: true });
  git(repo, "format-patch", "-q", "-1", "-o", join(agents, "amender", "amend-commit"));
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-q", "-D", "amend");
  return {
    repo,
    config: {
      pipeline,
      agent: { adapter: "stub", fixtureDir: agents },
      classifier: { adapter: "stub", answers: {}, default: { answer: "no", p: 0 } },
      check: { adapter: "pipeline" },
      tracker: { adapter: "file" },
      forge: { adapter: "file" },
      roles: {},
    },
  };
}

async function run(graph: GraphDef, pipeline: string, amends = true): Promise<{ h: RunHistory; runDir: string }> {
  const id = `scopes-${++runs}`;
  const { repo, config } = setup(id, pipeline, amends);
  const runDir = join(tmp, id, "run");
  const input: WorkflowInput = { runId: id, repo, runDir, graph, inputs: requestInputs(graph, "go"), config };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: id, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: id, workflowId: id, args: [input] });
  return { h: await worker.runUntil(runAnswering(handle, [OPERATOR_APPROVE])), runDir };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "graph-scopes-"));
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet });
});

after(async () => {
  await env?.teardown();
  rmSync(tmp, { recursive: true, force: true });
});

const detail = (h: RunHistory, id: string): string | undefined => {
  const v = h.data[id];
  return v?.schema === "check" ? v.detail : undefined;
};

test("an amend raised inside a live loop reaches the loop's next node, reparsed", async () => {
  const { h } = await run(loopGraph, join(ENGINE, "pipeline.ts"));
  assert.deepEqual(h.nodes.filter((n) => n.status === "failed"), []);
  assert.equal(h.phase, "done");
  assert.deepEqual(h.loops, [{ loop: "work", iterations: 1, outcome: "clean" }]);
  assert.equal(detail(h, "after"), "brief v2 brief; head v2 brief", "K-after, in the same iteration, read the amended brief and its reparsed head");
  assert.equal(detail(h, "asked"), "the brief settles it", "the asker's re-run, in the loop, read the amended brief");
  assert.equal(h.nodes.find((n) => n.node === "K-parse" && n.instance?.startsWith("K-ask#1:"))?.status, "done", "the reparse ran for the amend");
});

test("an amend raised inside a live fan-out item reaches that item's next node, reparsed", async () => {
  const { h } = await run(fanGraph, join(ENGINE, "pipeline.ts"));
  assert.deepEqual(h.nodes.filter((n) => n.status === "failed"), []);
  assert.equal(h.phase, "done");
  const lines = (detail(h, "after") ?? "").split("\n");
  assert.deepEqual(lines, ["brief v2 brief; head v2 brief", "brief v2 brief; head v2 brief", "brief v2 brief; head v2 brief"], "P1 read the amend in its own scope; P2 and P3 start after it");
  assert.equal(h.questions?.length, 1, "only P1 asked: the others started on the amended brief");
  assert.equal(h.questions?.[0]?.from.instance, "P1");
});

test("a question that was answered is not routed again when its asker runs again and still raises it", async () => {
  const { h, runDir } = await run(reaskGraph, join(ENGINE, "scopes.ts"), false);
  assert.equal(h.phase, "done");
  assert.deepEqual(h.questions?.map((q) => [q.question.id, q.route]), [["Q1", "resolver"], ["Q2", "resolver"]], "Q1 once, though the second run raised it again; Q2 is new");
  assert.equal(h.nodes.filter((n) => n.node === "A-answer-question").length, 2, "the resolver served two questions, not three");
  assert.equal(readFileSync(join(runDir, "reask-count"), "utf8"), "3", "the check ran for Q1, for Q2, and once more with nothing new");
  assert.equal(detail(h, "asked"), "run 3");
});
