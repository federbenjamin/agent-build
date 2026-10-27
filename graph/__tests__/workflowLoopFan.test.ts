/**
 * A fan-out inside a loop, run by the generic workflow in Temporal's time-skipping test environment:
 * each iteration runs the fan-out over the list that iteration made, records it by iteration, keys
 * each item's runs by iteration and item, and an item that failed in one iteration blocks nothing in
 * the next. The loop also holds a fail-open reader with no recorded output: it ends done with its
 * error, and the node that reads it runs without it.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime } from "@temporalio/worker";

import { type RunHistory, WORKFLOW_NAME, type WorkflowInput } from "../contracts.ts";
import { defineGraph } from "../define.ts";
import { renderMermaid } from "../mermaid.ts";
import { requestInputs } from "../schedule.ts";
import { createWorker, WORKFLOWS_PATH } from "../worker.ts";
import { runAnswering } from "./helpers/operator.ts";

const quiet = new DefaultLogger((process.env.GRAPH_TEST_LOG as "WARN" | undefined) ?? "ERROR");
Runtime.install({ logger: quiet });
const MIN = 60_000;
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "engine");

/** Loop L: K-plan lists the iteration's items, fan-out F runs A-work and K-each on each, K-stop ends
 *  the loop on iteration 2 with what F handed it. */
const graph = defineGraph({
  id: "loop-fan",
  data: [
    { id: "request", schema: "text", boundary: "input" },
    { id: "planned", schema: "check" },
    { id: "items", schema: "items" },
    { id: "work", schema: "files" },
    { id: "each", schema: "check", boundary: "terminal" },
    { id: "fan-ok", schema: "check" },
    { id: "links", schema: "files" },
    { id: "stop", schema: "check" },
  ],
  nodes: [
    { id: "K-plan", kind: "check", role: "plan", inputs: ["request"], outputs: ["planned", "items"], timeCapMs: MIN },
    { id: "A-links", kind: "agent", role: "linker", inputs: ["planned"], outputs: ["links"], failOpen: true, timeCapMs: MIN },
    { id: "A-work", kind: "agent", role: "worker", inputs: ["request", "planned"], outputs: ["work"], timeCapMs: MIN },
    { id: "K-each", kind: "check", role: "each", inputs: ["work"], outputs: ["each"], timeCapMs: MIN },
    { id: "K-stop", kind: "check", role: "stop", inputs: ["planned"], optionalInputs: ["work", "fan-ok", "links"], outputs: ["stop"], timeCapMs: MIN },
  ],
  loops: [{ id: "L", nodes: ["K-plan", "A-links", "A-work", "K-each", "K-stop"], until: { node: "K-stop", answer: "pass" }, cap: 3 }],
  fanOuts: [{ id: "F", over: "items", nodes: ["A-work", "K-each"], status: "fan-ok" }],
});

let env: TestWorkflowEnvironment;
let tmp: string;
let h: RunHistory;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "graph-loop-fan-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "toy\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  // The stub agent's runs are keyed by item and iteration: one fixture folder per run.
  for (const key of ["A@1", "B@1", "A@2", "C@2"]) {
    const dir = join(tmp, "agents", "worker", "work", `@${key}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "work.md"), `work ${key}\n`);
  }
  env = await TestWorkflowEnvironment.createTimeSkipping();
  const bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet });
  const input: WorkflowInput = {
    runId: "loop-fan",
    repo,
    runDir: join(tmp, "run"),
    graph,
    inputs: requestInputs(graph, "go"),
    config: {
      pipeline: join(ENGINE, "loopFan.ts"),
      agent: { adapter: "stub", fixtureDir: join(tmp, "agents") },
      classifier: { adapter: "stub", answers: {}, default: { answer: "no", p: 0 } },
      check: { adapter: "pipeline" },
      tracker: { adapter: "file" },
      forge: { adapter: "file" },
      roles: {},
    },
  };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: "loop-fan", workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: "loop-fan", workflowId: input.runId, args: [input] });
  h = await worker.runUntil(runAnswering(handle, []));
});

after(async () => {
  await env?.teardown();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const runOf = (node: string, iteration: number, instance?: string) => h.nodes.find((n) => n.node === node && n.iteration === iteration && n.instance === instance);

test("each iteration runs the fan-out over the list it made, and the record keeps each run by iteration", () => {
  assert.deepEqual(h.fanOuts, [
    { fanOut: "F", iteration: 1, items: ["A", "B"] },
    { fanOut: "F", iteration: 2, items: ["A", "C"] },
  ]);
  assert.deepEqual(h.loops, [{ loop: "L", iterations: 2, outcome: "clean" }]);
  for (const [i, item] of [[1, "A"], [1, "B"], [2, "A"], [2, "C"]] as const) assert.equal(runOf("A-work", i, item)?.status, "done", `A-work #${i} @${item}`);
  assert.equal(runOf("K-stop", 2)?.answer, "pass");
});

test("an item that failed in one iteration fails that iteration's status and blocks nothing in the next", () => {
  assert.match(runOf("K-each", 1, "A")?.reason ?? "", /A breaks in iteration 1/);
  assert.equal(runOf("K-each", 1, "A")?.status, "failed");
  assert.equal(runOf("K-each", 2, "A")?.status, "done");
  assert.equal(runOf("K-each", 2, "C")?.status, "done", "C comes after A, and iteration 2's A finished");
  assert.equal(h.phase, "failed", "a node failed in iteration 1");
  assert.deepEqual(h.nodes.filter((n) => n.status === "failed").map((n) => `${n.node}#${n.iteration}@${n.instance}`), ["K-each#1@A"], "only that node failed the run");
});

test("a fail-open reader whose output is missing ends done with its error, and its reader runs without it", () => {
  for (const i of [1, 2]) {
    const links = runOf("A-links", i);
    assert.equal(links?.status, "done");
    assert.match(links?.error ?? "", /no fixture folder/);
    assert.ok(!(runOf("K-stop", i)?.inputs ?? []).includes("links"), "K-stop ran without links");
  }
});

test("the loop's stop node reads each iteration's fan-out exports: the items' files joined, and the status", () => {
  const last = h.data.stop;
  assert.equal(last?.schema === "check" ? last.detail : undefined, "iteration 2: 2 work files, fan pass");
  assert.equal(runOf("K-stop", 1)?.answer, "fail");
});

test("the drawing nests the fan-out in its loop and names each iteration's items", () => {
  const mmd = renderMermaid(graph, h);
  const loopAt = mmd.indexOf("subgraph s_loop_3a_L[");
  const fanAt = mmd.indexOf("subgraph s_fan_3a_F[");
  assert.ok(loopAt >= 0 && fanAt > loopAt, "the fan-out's subgraph opens inside the loop's");
  assert.match(mmd, /for each items \(F\): #1 A, B; #2 A, C/);
});
