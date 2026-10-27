/**
 * The generic workflow on the toy graph, in Temporal's time-skipping test environment, with the stub
 * adapters: gates both ways, a loop ending clean and one hitting its cap, the answer signal, an
 * activity timeout and its one retry, and a failed node.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundle } from "@temporalio/worker";

import * as activities from "../activities.ts";
import { groupAlive } from "../adapters/process.ts";

import { formatStatus } from "../commands.ts";
import { parseRunConfig } from "../config.ts";
import { type GraphDef, parseAttemptRecord, QUERY_STATUS, type RunConfig, type RunHistory, type StubAgentBinding, type StubCheckBinding, type StubClassifierBinding, SIGNAL_ANSWER, WORKFLOW_NAME, type WorkflowInput } from "../contracts.ts";
import { graph as toy } from "../examples/toy.ts";
import { requestInputs } from "../schedule.ts";
import { createWorker, WORKFLOWS_PATH } from "../worker.ts";
import { recordedEvents, recorderCmd } from "./helpers/eventRecorder.ts";

const examples = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
const quiet = new DefaultLogger((process.env.GRAPH_TEST_LOG as "WARN" | undefined) ?? "ERROR");
Runtime.install({ logger: quiet });

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let tmp: string;
let repo: string;
let runs = 0;

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "graph-wf-"));
  repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "toy\n");
  git(["add", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], repo);
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet });
});

after(async () => {
  await env?.teardown();
  rmSync(tmp, { recursive: true, force: true });
});

/** The toy config, whose default bindings are the stubs. */
type ToyConfig = Omit<RunConfig, "agent" | "classifier" | "check"> & { agent: StubAgentBinding; classifier: StubClassifierBinding; check: StubCheckBinding };

function toyConfig(change: (c: ToyConfig) => void = () => {}): RunConfig {
  const file = join(examples, "toy.config.json");
  const config = parseRunConfig(JSON.parse(readFileSync(file, "utf8")), examples).config as ToyConfig;
  change(config);
  return config;
}

async function start(config: RunConfig, graph: GraphDef = toy, over: Partial<WorkflowInput> = {}) {
  const runId = `run-${++runs}`;
  const taskQueue = `q-${runs}`;
  const input: WorkflowInput = { runId, repo, runDir: join(tmp, "runs", runId), graph, inputs: requestInputs(graph, "add greet"), config, events: recorderCmd, ...over };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue, workflowId: runId, args: [input] });
  return { worker, handle, input };
}

async function run(config: RunConfig, graph: GraphDef = toy): Promise<{ h: RunHistory; input: WorkflowInput }> {
  const { worker, handle, input } = await start(config, graph);
  const h = (await worker.runUntil(handle.result())) as RunHistory;
  return { h, input };
}

const status = (h: RunHistory, node: string, iteration = 0) => h.nodes.find((n) => n.node === node && n.iteration === iteration);

type Handle = Awaited<ReturnType<typeof start>>["handle"];

/** Run until the workflow fails (it must), then read its status, live from the workflow. */
async function failedStatus(worker: Awaited<ReturnType<typeof start>>["worker"], handle: Handle): Promise<RunHistory> {
  return worker.runUntil(async () => {
    await assert.rejects(handle.result());
    return handle.query<RunHistory>(QUERY_STATUS);
  });
}

/** Poll the status query until `until` holds or the run ends; returns the last status seen. */
async function waitFor(handle: Handle, until: (h: RunHistory) => boolean): Promise<RunHistory> {
  let seen = await handle.query<RunHistory>(QUERY_STATUS);
  for (let i = 0; i < 200 && !until(seen) && seen.phase !== "done" && seen.phase !== "failed"; i++) {
    await sleep(25);
    seen = await handle.query<RunHistory>(QUERY_STATUS);
  }
  return seen;
}

test("gate true and a loop that ends clean: every node runs, the loop stops on its first pass, the PR is opened", async () => {
  const { h, input } = await run(toyConfig());
  assert.equal(h.phase, "done");
  assert.equal(status(h, "review")?.status, "done");
  assert.deepEqual(h.loops, [{ loop: "fix-loop", iterations: 2, outcome: "clean" }]);
  assert.equal(status(h, "tests", 1)?.answer, "fail");
  assert.equal(status(h, "tests", 2)?.answer, "pass");
  assert.equal(status(h, "needs-review")?.answer, "yes");
  assert.equal(h.data["test-report"]?.schema === "check" && h.data["test-report"].answer, "pass");
  assert.equal(h.data.pr?.schema === "ref" && h.data.pr.kind, "pr");
  assert.deepEqual(h.data["fix-outcome"], { schema: "outcome", answer: "clean" });
  assert.ok(existsSync(join(input.runDir, "worktrees", "fix", ".git")), "the writing fixer has its own worktree");
  const pr = JSON.parse(readFileSync(join(input.runDir, "forge", "prs", "1.json"), "utf8")) as { body: string };
  assert.match(pr.body, /## code\n\n--- \/dev\/null/);
  assert.ok(existsSync(join(input.runDir, "history.json")));
  assert.match(readFileSync(join(input.runDir, "graph.mmd"), "utf8"), /class n_open_2d_pr ran/);
  // Every attempt of every node kind leaves its record, closed when it ended; an agent's names what its CLI reported (a stub: nothing).
  const attempt = (node: string, iteration: number) => parseAttemptRecord(JSON.parse(readFileSync(join(input.runDir, "nodes", node, String(iteration), "rerun-0", "attempt-1.json"), "utf8")));
  for (const [node, iteration] of [["plan", 0], ["needs-review", 0], ["tests", 2], ["merge-fix", 1]] as const) {
    const a = attempt(node, iteration);
    assert.equal(a.outcome, "done", node);
    assert.ok(a.endedAt !== undefined && Date.parse(a.endedAt) >= Date.parse(a.startedAt), node);
  }
  assert.deepEqual([attempt("fix", 1).model, attempt("fix", 1).tokens, attempt("fix", 1).costUsd], [null, null, null]);
  assert.equal(attempt("tests", 2).model, undefined, "only an agent's record carries model, tokens and cost");
  const review = status(h, "review")!;
  assert.ok(review.startedAt !== undefined && review.endedAt !== undefined && review.startedAt <= review.endedAt);
  assert.equal(h.runKind, "mock");
});

test("gate false and a loop that hits its cap: the reviewer is skipped, the loop stops at 3, and no PR opens on red tests", async () => {
  const { h } = await run(
    toyConfig((c) => {
      c.classifier.answers = {};
      (c.check = { adapter: "stub", answers: { tests: ["fail"] }, default: "pass" });
    })
  );
  assert.equal(h.phase, "done");
  assert.deepEqual(status(h, "review"), { node: "review", iteration: 0, status: "skipped", reason: "gate needs-review answered no, not yes" });
  assert.deepEqual(h.loops, [{ loop: "fix-loop", iterations: 3, outcome: "capped" }]);
  assert.equal(status(h, "fix", 3)?.status, "done");
  assert.deepEqual(h.data["fix-outcome"], { schema: "outcome", answer: "capped" });
  assert.deepEqual(status(h, "open-pr"), { node: "open-pr", iteration: 0, status: "skipped", reason: "gate loop fix-loop answered capped, not clean" });
  assert.equal(h.data.pr, undefined);
});

test("a node that asks the operator waits for the answer signal, notifies through BUILD_EVENT_CMD, then runs on", async () => {
  const { worker, handle } = await start(toyConfig((c) => (c.roles.planner = { agent: { ...c.agent, ask: "Which greeting?" } })));
  const h = (await worker.runUntil(async () => {
    let seen: RunHistory | undefined;
    for (let i = 0; i < 200 && (seen?.asking.length ?? 0) === 0; i++) {
      seen = await handle.query<RunHistory>(QUERY_STATUS);
      if (seen.asking.length === 0) await sleep(25);
    }
    assert.deepEqual(seen?.asking, [{ node: "plan", iteration: 0, question: "Which greeting?" }]);
    assert.equal(seen?.phase, "waiting");
    await handle.signal(SIGNAL_ANSWER, "hello");
    return handle.result();
  })) as RunHistory;
  assert.equal(h.phase, "done");
  assert.deepEqual(h.asking, []);
  assert.equal(status(h, "plan")?.status, "done");
  const events = recordedEvents();
  const blocked = events.find((e) => e.runid === handle.workflowId);
  assert.equal(blocked?.event, "blocked");
  assert.match(String(blocked?.needs), /node plan asks: Which greeting\?/);
});

test("a node rerun on the operator's answer writes its attempt record under the next rerun, beside the first run's", async () => {
  const { worker, handle, input } = await start(toyConfig((c) => (c.roles.planner = { agent: { ...c.agent, ask: "Which greeting?" } })));
  await worker.runUntil(async () => {
    await waitFor(handle, (s) => s.asking.length > 0);
    await handle.signal(SIGNAL_ANSWER, "hello");
    return handle.result();
  });
  const record = (file: string) => parseAttemptRecord(JSON.parse(readFileSync(join(input.runDir, "nodes", "plan", "0", file), "utf8")));
  const asked = record("rerun-0/attempt-1.json");
  const answered = record("rerun-1/attempt-1.json");
  assert.deepEqual([asked.outcome, asked.rerun, asked.attempt], ["needs-operator", 0, 1]);
  assert.deepEqual([answered.outcome, answered.rerun, answered.attempt], ["done", 1, 1]);
  assert.ok(Date.parse(answered.startedAt) >= Date.parse(asked.endedAt!), "the rerun began after the first run ended");
});

test("two answers to one question do not answer the next question before the operator sees it", async () => {
  const config = toyConfig((c) => {
    c.roles.planner = { agent: { ...c.agent, ask: "Which greeting?" } };
    c.roles.fixer = { agent: { ...c.agent, ask: "Which file?" } };
    (c.check = { adapter: "stub", answers: { tests: "pass" }, default: "pass" });
  });
  const runId = `run-${++runs}`;
  const taskQueue = `q-${runs}`;
  const input: WorkflowInput = { runId, repo, runDir: join(tmp, "runs", runId), graph: toy, inputs: requestInputs(toy, "x"), config, events: recorderCmd };
  // No sticky cache: a stopped worker's next workflow task goes back to the shared queue.
  const uncached = () =>
    Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities, maxCachedWorkflows: 0, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue, workflowId: runId, args: [input] });
  await (await uncached()).runUntil(waitFor(handle, (s) => s.asking.length > 0));
  // With no worker running, both answers land in the workflow's next activation together.
  await handle.signal(SIGNAL_ANSWER, "hello");
  await handle.signal(SIGNAL_ANSWER, "hello again");
  const h = (await (await uncached()).runUntil(async () => {
    // The fixer's question is settled once its notification completed: the workflow task that
    // records that completion also evaluates whether an answer is waiting for it.
    const notified = async (): Promise<number> => {
      const events = (await handle.fetchHistory()).events ?? [];
      const notifies = new Set(
        events.filter((e) => e.activityTaskScheduledEventAttributes?.activityType?.name === "notifyOperator").map((e) => Number(e.eventId))
      );
      return events.filter((e) => notifies.has(Number(e.activityTaskCompletedEventAttributes?.scheduledEventId))).length;
    };
    for (let i = 0; i < 200 && (await notified()) < 2; i++) await sleep(25);
    const next = await waitFor(handle, () => true);
    assert.deepEqual(next.asking, [{ node: "fix", iteration: 1, question: "Which file?" }], "the fixer's question waits for its own answer");
    await handle.signal(SIGNAL_ANSWER, "greet.ts");
    return handle.result();
  })) as RunHistory;
  assert.equal(h.phase, "done");
});

test("an agent that hangs past its time cap fails there without a retry; the run tree is untouched", async () => {
  // The time-skipping server does not skip time while an activity runs, so the cap is real time: keep it short.
  const capped: GraphDef = { ...toy, nodes: toy.nodes.map((n) => (n.id === "fix" ? { ...n, timeCapMs: 1_500 } : n)) };
  const config = toyConfig((c) => {
    c.roles.planner = { agent: { ...c.agent, ask: "Go?" } };
    c.roles.fixer = { agent: { ...c.agent, hangOnAttempts: [1] } };
    (c.check = { adapter: "stub", answers: { tests: "pass" }, default: "pass" });
  });
  const { worker, handle, input } = await start(config, capped);
  const h = (await worker.runUntil(async () => {
    await waitFor(handle, (s) => s.asking.length > 0);
    const place = JSON.parse(readFileSync(join(input.runDir, "place.json"), "utf8")) as { worktree: string };
    writeFileSync(join(place.worktree, "sibling.txt"), "another node's uncommitted work\n");
    await handle.signal(SIGNAL_ANSWER, "go");
    return handle.result();
  })) as RunHistory;
  assert.equal(h.phase, "failed");
  const fix = status(h, "fix", 1);
  assert.equal(fix?.status, "failed");
  assert.match(fix?.reason ?? "", /time cap of 1500 ms reached/);
  assert.ok(!existsSync(join(input.runDir, "nodes", "fix", "1", "rerun-0", "attempt-2.json")), "a cap hit is never retried");
  assert.equal(parseAttemptRecord(JSON.parse(readFileSync(join(input.runDir, "nodes", "fix", "1", "rerun-0", "attempt-1.json"), "utf8"))).outcome, "aborted");
  const place = JSON.parse(readFileSync(join(input.runDir, "place.json"), "utf8")) as { worktree: string };
  assert.equal(readFileSync(join(place.worktree, "sibling.txt"), "utf8"), "another node's uncommitted work\n", "the run tree is untouched");
});

test("a cancel ends the run cancelled: the hung node is marked cancelled, the history is recorded, and one finished event names the branch and worktrees", async () => {
  const config = toyConfig((c) => (c.roles.fixer = { agent: { ...c.agent, hangOnAttempts: [1] } }));
  const { worker, handle, input } = await start(config);
  await worker.runUntil(async () => {
    await waitFor(handle, (s) => s.nodes.some((n) => n.node === "fix" && n.status === "running"));
    await handle.cancel();
    await assert.rejects(handle.result());
  });
  const h = JSON.parse(readFileSync(join(input.runDir, "history.json"), "utf8")) as RunHistory;
  assert.equal(h.phase, "cancelled");
  assert.equal(status(h, "fix", 1)?.status, "cancelled");
  assert.ok(status(h, "fix", 1)?.endedAt !== undefined);
  assert.deepEqual(h.nodes.filter((n) => n.status === "running" || n.status === "waiting"), [], "no node is left open");
  assert.equal(status(h, "merge-fix", 1), undefined, "nothing after the cancel starts");
  const finished = recordedEvents().filter((e) => e.runid === handle.workflowId && e.event === "finished");
  assert.equal(finished.length, 1, "one finished event per run");
  const place = JSON.parse(readFileSync(join(input.runDir, "place.json"), "utf8")) as { worktree: string; branch: string };
  assert.deepEqual([finished[0]!.outcome, finished[0]!.branch], ["cancelled", place.branch]);
  assert.ok((finished[0]!.worktrees as string[]).includes(place.worktree) && (finished[0]!.worktrees as string[]).includes(join(input.runDir, "worktrees", "fix")), "the run tree and the agents' worktrees are left, and named");
  assert.equal("pr" in finished[0]!, false, "a run that opened no PR names none: the key is absent, never null");
  const cancelled = h.nodes.filter((n) => n.status === "cancelled");
  assert.ok(cancelled.length > 0);
  for (const n of cancelled) assert.equal(n.reason, "cancelled by the operator", n.node);
  for (const line of formatStatus(h).split("\n")) assert.doesNotMatch(line, /:\s*$/, `a status line with an empty reason: ${JSON.stringify(line)}`);
});

/** A `sleep 60` in a process group of its own, as an agent CLI runs; resolves once it has started. */
async function sleepingGroup(): Promise<number> {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
  return child.pid!;
}

/** Run the toy graph with a pgid record written for the fixer's first attempt before the fixer starts. */
async function runWithRecordedPgid(record: (runDir: string) => Promise<unknown>): Promise<RunHistory> {
  const config = toyConfig((c) => {
    c.roles.planner = { agent: { ...c.agent, ask: "Go?" } };
    (c.check = { adapter: "stub", answers: { tests: "pass" }, default: "pass" });
  });
  const { worker, handle, input } = await start(config);
  return (await worker.runUntil(async () => {
    await waitFor(handle, (s) => s.asking.length > 0);
    mkdirSync(join(input.runDir, "nodes", "fix", "1"), { recursive: true });
    writeFileSync(join(input.runDir, "nodes", "fix", "1", "pgid.json"), JSON.stringify(await record(input.runDir)));
    await handle.signal(SIGNAL_ANSWER, "go");
    return handle.result();
  })) as RunHistory;
}

test("an agent process group recorded by an attempt the worker never ended is killed before its node's worktree is reset", async () => {
  const orphan = await sleepingGroup();
  try {
    const h = await runWithRecordedPgid(async () => ({ pid: orphan }));
    assert.equal(h.phase, "done");
    assert.equal(groupAlive(orphan), false, "the orphaned agent was terminated");
  } finally {
    try {
      process.kill(-orphan, "SIGKILL");
    } catch {}
  }
});

test("a recorded process group that is already gone, or one cleared by its attempt, is left alone: no kill, no failure", async () => {
  const gone = await sleepingGroup();
  process.kill(-gone, "SIGKILL");
  for (let i = 0; i < 100 && groupAlive(gone); i++) await sleep(20);
  const bystander = await sleepingGroup();
  try {
    const h = await runWithRecordedPgid(async () => ({ pid: gone }));
    assert.equal(h.phase, "done");
    const cleared = await runWithRecordedPgid(async () => ({ pid: null }));
    assert.equal(cleared.phase, "done");
    assert.equal(groupAlive(bystander), true, "an unrelated process group is untouched");
  } finally {
    process.kill(-bystander, "SIGKILL");
  }
});

test("a run that fails outside any node says so in its status and its recorded history", async () => {
  const notRepo = join(tmp, "not-a-repo");
  mkdirSync(notRepo, { recursive: true });
  const { worker, handle, input } = await start(toyConfig(), toy, { repo: notRepo });
  const seen = await failedStatus(worker, handle);
  assert.equal(seen.phase, "failed");
  assert.match(seen.error ?? "", /is not a git repo/);
  const recorded = JSON.parse(readFileSync(join(input.runDir, "history.json"), "utf8")) as RunHistory;
  assert.equal(recorded.phase, "failed");
});

test("handed an output as if it were an input, the run refuses to start its nodes", async () => {
  const inputs = { ...requestInputs(toy, "x"), code: { schema: "files", files: ["/injected"] } } as WorkflowInput["inputs"];
  const { worker, handle } = await start(toyConfig(), toy, { inputs });
  const seen = await failedStatus(worker, handle);
  assert.equal(seen.phase, "failed");
  assert.match(seen.error ?? "", /code is not an input of graph toy/);
  assert.deepEqual(seen.nodes, []);
});

test("a run whose record cannot be written ends failed, not done", async () => {
  const runDir = join(tmp, "runs", "unrecordable");
  mkdirSync(join(runDir, "graph.mmd"), { recursive: true });
  const { worker, handle } = await start(toyConfig((c) => ((c.check = { adapter: "stub", answers: { tests: "pass" }, default: "pass" }))), toy, { runDir });
  const seen = await failedStatus(worker, handle);
  assert.equal(seen.phase, "failed");
  assert.match(seen.error ?? "", /EISDIR|illegal operation on a directory/);
});

test("a node that breaks its contract fails without a retry; what needs it skips, the run ends failed", async () => {
  const { worker, handle } = await start(toyConfig((c) => (c.roles.reviewer = { agent: { ...c.agent, fixtureDir: join(tmp, "no-fixtures") } })));
  const h = (await worker.runUntil(handle.result())) as RunHistory;
  const events = (await handle.fetchHistory()).events ?? [];
  const failed = events.filter((e) => e.activityTaskFailedEventAttributes);
  assert.equal(failed.length, 1);
  const startedId = Number(failed[0]!.activityTaskFailedEventAttributes!.startedEventId);
  const started = events.find((e) => Number(e.eventId) === startedId);
  assert.equal(started?.activityTaskStartedEventAttributes?.attempt, 1, "a contract error is not retried");
  assert.equal(h.phase, "failed");
  const review = status(h, "review");
  assert.equal(review?.status, "failed");
  assert.match(review?.reason ?? "", /no fixture folder/);
  assert.equal(status(h, "fix", 1)?.status, "done", "fix reads review as optional");
});
