/**
 * The build graph on the small recorded run's fixture, with stub agents and classifiers, the pipeline's
 * own checks and operations, and the file tracker and forge, in Temporal's time-skipping test
 * environment. The run replays the recorded run until its fix round 2, which the recorded run never
 * made: the fixer has no recorded output there, so the run stops at that point.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { defaultPayloadConverter } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime } from "@temporalio/worker";

import { readRunDirs } from "../runDirs.ts";
import { parseRunConfig } from "../config.ts";
import { TASK_QUEUE } from "../constants.ts";
import { type RunHistory, WORKFLOW_NAME, type WorkflowInput } from "../contracts.ts";
import { mockConfig, operatorReplies, seedRepo, startMock } from "../mock/mock.ts";
import { graph } from "../pipelines/build.ts";
import { requestInputs } from "../schedule.ts";
import { formatStats, statsReport } from "../stats.ts";
import { createWorker, WORKFLOWS_PATH } from "../worker.ts";
import { recordedEvents, recorderCmd } from "./helpers/eventRecorder.ts";
import { FIXTURES, NO_FIXTURES } from "./helpers/fixtures.ts";
import { runAnswering } from "./helpers/operator.ts";

const fixture = join(FIXTURES, "build-1792523343-EIBekQ");
const quiet = new DefaultLogger((process.env.GRAPH_TEST_LOG as "WARN" | undefined) ?? "ERROR");
Runtime.install({ logger: quiet });

let env: TestWorkflowEnvironment;
let tmp: string;
let h: RunHistory;
let small: { runId: string; runDir: string };
const asked: string[] = [];

before(async () => {
  if (NO_FIXTURES) return;
  // The shell that starts the mock and the worker (this process) both carry a consumer: the mock must still fire nothing.
  process.env.BUILD_EVENT_CMD = recorderCmd;
  tmp = mkdtempSync(join(tmpdir(), "graph-build-mock-"));
  env = await TestWorkflowEnvironment.createTimeSkipping();
  process.env.TEMPORAL_ADDRESS = env.address;
  small = startMock(fixture, tmp);
  const bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet });
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowBundle: bundle, shutdownGraceTime: "1s" });
  h = await worker.runUntil(runAnswering(env.client.workflow.getHandle(small.runId), operatorReplies(fixture), asked));
});

after(async () => {
  await env?.teardown();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const runOf = (node: string, iteration = 0, instance?: string) =>
  h.nodes.find((n) => n.node === node && n.iteration === iteration && (instance === undefined || n.instance === instance));

test("intake, brief and build replay: the part and the test slice are built and merged back", { skip: NO_FIXTURES }, () => {
  for (const id of ["K-load-config", "D-pin-run-tree", "A-prior-art", "A-write-brief", "K-parse-brief", "D-commit-brief", "D-install", "K-tests", "D-pull-main", "K-measure-diff"]) {
    assert.equal(runOf(id)?.status, "done", id);
  }
  assert.equal(runOf("A-builder", 0, "P1")?.status, "done");
  assert.equal(runOf("D-merge-part", 0, "P1")?.status, "done");
  assert.equal(runOf("A-prove-tests", 0, "W1")?.status, "done");
  assert.equal(runOf("D-fetch-ticket")?.status, "skipped", "no ticket is named");
});

test("the wave runs what the recorded run's classifiers called, the hunter among them", { skip: NO_FIXTURES }, () => {
  for (const id of ["A-review", "A-silent-failures", "A-review-codex", "A-completeness", "A-simplifier", "A-hand-test"]) assert.equal(runOf(id)?.status, "done", id);
  assert.equal(runOf("A-security")?.status, "skipped");
  assert.match(runOf("A-repo-review")?.reason ?? "", /empty/);
});

test("fix round 1: the fixer's decision goes to the resolver, the brief is amended, the re-reads run", { skip: NO_FIXTURES }, () => {
  assert.equal(runOf("A-fixer", 1)?.status, "done");
  assert.equal(runOf("D-merge-fix", 1)?.status, "done");
  const q = h.questions?.find((x) => x.question.id === "SIMP.4");
  assert.equal(q?.route, "resolver");
  assert.ok(q?.answer?.brief_change !== undefined);
  assert.equal(h.nodes.find((n) => n.node === "A-amend-brief")?.status, "done");
  assert.equal(runOf("A-review-fix", 1)?.status, "done");
  assert.equal(runOf("A-completeness-fix", 1)?.status, "done", "the graded amend owes the verifier");
  assert.equal(runOf("K-manifest-fix", 1)?.status, "skipped");
});

test("fix round 2 is owed and has no recorded fixer, so the close loop aborts there", { skip: NO_FIXTURES }, () => {
  assert.equal(runOf("D-build-fix-table", 2)?.status, "done");
  assert.match(runOf("A-fixer", 2)?.reason ?? "", /has no @S1@2/);
  assert.match(runOf("K-loop-done", 2)?.reason ?? "", /fix round was owed and no fix merged/);
  assert.equal(h.loops.find((l) => l.loop === "close")?.outcome, "aborted");
  assert.equal(runOf("D-final-table")?.status, "skipped");
  assert.equal(h.phase, "failed");
});

// ---- stats over the recorded runs ----

test("stats reads the run dirs of both recorded runs, mocks as they are, and prints their node tails and classifier rows", { skip: NO_FIXTURES }, async () => {
  // The small run is the one above; the second is run here, into the same state dir.
  const second = join(FIXTURES, "build-1790977465-962");
  const tmp2 = mkdtempSync(join(tmpdir(), "graph-build-mock-2-"));
  try {
    seedRepo(second, join(tmp2, "repo"));
    if (existsSync(join(second, "tracker"))) cpSync(join(second, "tracker"), join(tmp2, "tracker"), { recursive: true });
    const { config } = parseRunConfig(mockConfig(second, tmp2), tmp2);
    const input: WorkflowInput = {
      runId: "mock-second",
      repo: join(tmp2, "repo"),
      runDir: join(tmp, "runs", "mock-second"),
      graph,
      inputs: requestInputs(graph, readFileSync(join(second, "start.json"), "utf8").trim()),
      config,
    };
    const worker = await createWorker({ connection: env.nativeConnection, taskQueue: "build-mock-2", workflowBundle: await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet }), shutdownGraceTime: "1s" });
    const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: "build-mock-2", workflowId: input.runId, args: [input] });
    // The second recording's brief-change proposals wait on the operator's approve replies.
    await worker.runUntil(runAnswering(handle, operatorReplies(second)).catch(() => undefined));

    // Lay the first run beside the second the way the state dir does: runs/<id>/.
    cpSync(small.runDir, join(tmp, "runs", "mock-small"), { recursive: true });
    const dirs = readRunDirs(tmp);
    assert.deepEqual(dirs.map((d) => d.name), ["mock-second", "mock-small"]);
    for (const d of dirs) {
      assert.deepEqual(d.problems, [], `${d.name}: every file read`);
      assert.equal(d.history?.runKind, "mock");
      assert.ok(d.attempts.length > 0, `${d.name}: attempt records`);
    }
    assert.ok(dirs.every((d) => d.table !== null), "each run's last table is found from its history");
    assert.ok(dirs.some((d) => d.fixes.size > 0), "the mirrored fix files are read back");
    assert.ok(dirs.some((d) => d.fixerRounds.size > 0), "the round each close-loop iteration's fixer took is read back");
    assert.ok(dirs.some((d) => [...d.fixReads.values()].some((ss) => ss.length > 0)), "the fix reads' status lines are read back from the mirror");
    const report = statsReport(dirs);
    assert.deepEqual([report.kind, report.counted, report.leftOut], ["mock", 2, 0]);
    assert.ok(report.classifiers.length > 0);
    assert.ok((report.classifiers.find((c) => c.node === "C-review-fix")?.labelled ?? 0) > 0, "C-review-fix's loop decisions whose confirm read ran are labelled");
    assert.deepEqual(
      report.classifiers.filter((c) => c.node === "C-review-fix").map((c) => c.population),
      ["single-slice"],
      "each recorded fix round ran one slice, and every C-review-fix decision is counted in its round's population"
    );
    assert.ok(report.classifiers.every((c) => c.explored === 0 && c.errors === 0), "a mock never explores and never fails open");
    const text = formatStats(report);
    assert.match(text, /^2 mock runs\n/);
    assert.ok(dirs.every((d) => d.crosstalk.length === 0), "a mock fixer sends no peer a message");
    assert.match(text, /\ncrosstalk \(run, fix round, slice, to, first line\)\n {2}none\n/);
    assert.match(text, /\nnodes \(attempts, p50, p90, max, cap, margin, cap hits, lost, restarts\)\n/);
    assert.match(text, /\n {2}A-builder {2}\d+ {2}\d+s {2}\d+s {2}\d+s {2}90\.0m {2}90\.0m {2}0 {2}0 {2}0\n/, "a node row: attempts, tail, cap, margin, cap hits, lost, restarts");
    assert.match(text, /\nclassifiers \(decisions, fired, explored, errors;/);
    assert.match(text, /\n {2}C-silent-failures {2}\d+ {2}\d+ {2}0 {2}0; {2}\d+ {2}\d+ /, "a classifier row: decisions, fired, explored, errors; labels");
    assert.match(text, new RegExp(`\\n {2}${small.runId} {2}mock {2}failed `), "the small run stops at its unrecorded fix round 2");
  } finally {
    rmSync(tmp2, { recursive: true, force: true });
  }
});

test("a mock run fires no event, whatever its shell's and its worker's BUILD_EVENT_CMD: its start carries no consumer", { skip: NO_FIXTURES }, async () => {
  assert.equal(process.env.BUILD_EVENT_CMD, recorderCmd);
  const started = (await env.client.workflow.getHandle(small.runId).fetchHistory()).events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
  assert.ok(started, "the run's start input is in its history");
  const input = defaultPayloadConverter.fromPayload<WorkflowInput>(started);
  assert.equal(input.runId, small.runId);
  assert.equal("events" in input, false, "build-graph start gave the mock's run no consumer");
  assert.ok(asked.length > 0 && h.phase === "failed", "the run reached its blocked and finished events");
  assert.deepEqual(recordedEvents().filter((e) => e.runid === small.runId), []);
});
