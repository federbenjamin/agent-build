/**
 * The engine's question services and fan-out chains in Temporal's time-skipping test environment:
 * an amended brief reaches every later node, reparsed; an amend whose merge fails fails the node that
 * asked; a failed fan-out item skips every item after it, however far down the chain, and fails the
 * fan-out's status; a blocked question sends its asker back once with its evidence, then goes to the
 * operator; a resolver's refusal reaches the operator with what it searched; the ship path's wait
 * after the PR (`shipGraph`: the build pipeline's real ship nodes) and how each run ends, with its one
 * `finished` event.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, type WorkflowBundle } from "@temporalio/worker";

import { type GraphDef, QUERY_STATUS, type RunConfig, type RunHistory, SIGNAL_ANSWER, WORKFLOW_NAME, type WorkflowInput } from "../contracts.ts";
import { defineGraph } from "../define.ts";
import { requestInputs } from "../schedule.ts";
import { createWorker, WORKFLOWS_PATH } from "../worker.ts";
import { OPERATOR_ABANDON, OPERATOR_APPROVE, OPERATOR_MERGE } from "../constants.ts";
import { briefText } from "../../runtime/__tests__/helpers/owedRun.ts";
import { runAnswering } from "./helpers/operator.ts";
import { recordedEvents, recorderCmd } from "./helpers/eventRecorder.ts";

const quiet = new DefaultLogger((process.env.GRAPH_TEST_LOG as "WARN" | undefined) ?? "ERROR");
Runtime.install({ logger: quiet });
const MIN = 60_000;
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "engine");
const PIPELINE = join(ENGINE, "pipeline.ts");

const amendGraph = defineGraph({
  id: "amend",
  data: [
    { id: "request", schema: "text", boundary: "input" },
    { id: "brief", schema: "files" },
    { id: "parsed", schema: "check" },
    { id: "brief-head", schema: "text" },
    { id: "asked", schema: "check" },
    { id: "after", schema: "check", boundary: "terminal" },
    { id: "route-question", schema: "check" },
    { id: "answer", schema: "files" },
    { id: "amend-commit", schema: "ref" },
    { id: "brief-amended", schema: "files" },
  ],
  nodes: [
    { id: "A-write-brief", kind: "agent", role: "briefer", inputs: ["request"], outputs: ["brief"], timeCapMs: MIN },
    { id: "K-parse", kind: "check", role: "parse", inputs: ["brief"], outputs: ["parsed", "brief-head"], timeCapMs: MIN },
    { id: "K-ask", kind: "check", role: "ask", inputs: ["request", "parsed", "brief-head"], outputs: ["asked"], timeCapMs: MIN },
    { id: "K-after", kind: "check", role: "after", inputs: ["asked", "brief", "brief-head"], outputs: ["after"], timeCapMs: MIN },
    { id: "K-route-question", kind: "check", role: "route", inputs: [], outputs: ["route-question"], timeCapMs: MIN },
    { id: "A-answer-question", kind: "agent", role: "resolver", inputs: ["request"], outputs: ["answer"], timeCapMs: MIN },
    { id: "A-amend", kind: "agent", role: "amender", inputs: ["brief"], outputs: ["amend-commit", "brief-amended"], writes: true, timeCapMs: MIN },
  ],
  services: { route: "K-route-question", resolver: "A-answer-question", amend: "A-amend" },
  amended: { output: "brief-amended", replaces: "brief", reparse: "K-parse" },
});

const fanGraph = defineGraph({
  id: "fan",
  data: [
    { id: "request", schema: "text", boundary: "input" },
    { id: "listed", schema: "check" },
    { id: "items", schema: "items" },
    { id: "worked", schema: "check" },
    { id: "chain-ok", schema: "check" },
    { id: "end", schema: "check", boundary: "terminal" },
    { id: "whole", schema: "check", boundary: "terminal" },
  ],
  nodes: [
    { id: "K-list", kind: "check", role: "list", inputs: ["request"], outputs: ["listed", "items"], timeCapMs: MIN },
    { id: "K-work", kind: "check", role: "work", inputs: ["request"], outputs: ["worked"], timeCapMs: MIN },
    { id: "K-end", kind: "check", role: "after", inputs: ["listed"], optionalInputs: ["worked"], outputs: ["end"], timeCapMs: MIN },
    { id: "K-whole", kind: "check", role: "after", inputs: ["listed"], outputs: ["whole"], gate: { on: "chain-ok", answer: "pass" }, timeCapMs: MIN },
  ],
  fanOuts: [{ id: "chain", over: "items", nodes: ["K-work"], status: "chain-ok" }],
});

/** One agent that raises a question, with the build graph's K-output-format reading its `questions.json`;
 *  `answering` gives it an answers output, `ownsBrief` makes its output what an amend replaces. */
const askerGraph = (answering: boolean, ownsBrief = false): GraphDef =>
  defineGraph({
    id: `asker${answering ? "-answers" : ""}${ownsBrief ? "-brief" : ""}`,
    data: [
      { id: "request", schema: "text", boundary: "input" },
      { id: "draft", schema: "files", boundary: "terminal" },
      ...(answering ? [{ id: "draft-answers", schema: "files" as const, boundary: "terminal" as const }] : []),
      { id: "output-format", schema: "check" },
      { id: "route-question", schema: "check" },
      { id: "answer", schema: "files" },
      ...(ownsBrief ? [{ id: "amend-commit", schema: "ref" as const }, { id: "draft-amended", schema: "files" as const }] : []),
    ],
    nodes: [
      { id: "A-work", kind: "agent", role: "worker", inputs: ["request"], outputs: answering ? ["draft", "draft-answers"] : ["draft"], ...(answering ? { answers: "draft-answers" } : {}), timeCapMs: MIN },
      { id: "K-output-format", kind: "check", role: "schema", inputs: [], outputs: ["output-format"], timeCapMs: MIN },
      { id: "K-route-question", kind: "check", role: "route", inputs: [], outputs: ["route-question"], timeCapMs: MIN },
      { id: "A-answer-question", kind: "agent", role: "resolver", inputs: ["request"], outputs: ["answer"], timeCapMs: MIN },
      ...(ownsBrief ? [{ id: "A-amend", kind: "agent" as const, role: "amender", inputs: ["request"], outputs: ["amend-commit", "draft-amended"], writes: true, timeCapMs: MIN }] : []),
    ],
    services: { schema: "K-output-format", route: "K-route-question", resolver: "A-answer-question", ...(ownsBrief ? { amend: "A-amend" } : {}) },
    ...(ownsBrief ? { amended: { output: "draft-amended", replaces: "draft" } } : {}),
  });

const WORK_QUESTION = { id: "W.1", text: "the bucket name is not in the repo", searched: [{ source: "code", said: "no bucket in src" }, { source: "docs", said: "silent" }] };
/** What the asker's rerun is handed for WORK_QUESTION when it was blocked on its last run. */
const BLOCKED_LINE = "W.1: blocked on the last run: the bucket name is not in the repo Searched: code: no bucket in src; docs: silent. (source: your last run)";

/** How a `runAsker` worker behaves, past the defaults: the questions it raises (else WORK_QUESTION of
 *  the given type), whether it writes only them (no notes.md), whether a run handed answers writes a
 *  real draft instead, and whether its draft is what an amend replaces. */
interface AskerShape {
  questions?: object[];
  questionsOnly?: boolean;
  answeredDraft?: boolean;
  ownsBrief?: boolean;
}

/** Run `askerGraph` on a stub worker that raises WORK_QUESTION of `type` every time it runs, a resolver
 *  that writes `resolved`, and an operator who gives `replies`. Returns the history, the questions the
 *  operator was asked, the answers each worker run was handed, and the number of resolver runs. */
async function runAsker(
  answering: boolean,
  type: string,
  resolved: object,
  replies: string[],
  shape: AskerShape = {}
): Promise<{ h: RunHistory; asked: string[]; seen: string[][]; resolverRuns: number }> {
  const id = `svc-${++runs}`;
  const { repo, config } = setup(id);
  const agents = (config.agent as { fixtureDir: string }).fixtureDir;
  if (shape.questionsOnly !== true) put(join(agents, "worker", "draft", "notes.md"), "work\n");
  put(join(agents, "worker", "draft", "questions.json"), JSON.stringify(shape.questions ?? [{ ...WORK_QUESTION, type }]));
  if (shape.answeredDraft === true) put(join(agents, "worker-answered", "draft", "notes.md"), "work on the answers\n");
  put(join(agents, "resolver", "answer", "answer.json"), JSON.stringify(resolved));
  const bound: RunConfig = { ...config, pipeline: join(ENGINE, "blocked.ts"), agent: { adapter: "stub", fixtureDir: agents, replay: join(ENGINE, "seenAnswers.ts") } };
  const graph = askerGraph(answering, shape.ownsBrief === true);
  const input: WorkflowInput = { runId: id, repo, runDir: join(tmp, id, "run"), graph, inputs: requestInputs(graph, "go"), config: bound };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: id, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: id, workflowId: id, args: [input] });
  const asked: string[] = [];
  const h = await worker.runUntil(runAnswering(handle, replies, asked));
  const lines = (role: string): string[][] => {
    const file = join(agents, `seen-${role}.jsonl`);
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
  };
  return { h, asked, seen: lines("worker"), resolverRuns: lines("resolver").length };
}

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let tmp: string;
let runs = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A repo, and the stub agents' files: a v1 brief, an answer that amends it, and an amend that writes
 *  a v2 brief and commits a README change. */
function setup(name: string): { repo: string; config: RunConfig } {
  const root = join(tmp, name);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "toy\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const agents = join(root, "agents");
  put(join(agents, "briefer", "brief", "brief.md"), "v1 brief\n");
  put(join(agents, "resolver", "answer", "answer.json"), JSON.stringify({ answer: "use v2", source: "brief", searched: [{ source: "brief", said: "v1 says to ask" }], brief_change: "say v2" }));
  put(join(agents, "amender", "brief-amended", "brief.md"), "v2 brief\n");
  git(repo, "checkout", "-q", "-b", "amend");
  writeFileSync(join(repo, "README.md"), "toy, amended\n");
  git(repo, "commit", "-q", "-am", "amend brief: v2");
  mkdirSync(join(agents, "amender", "amend-commit"), { recursive: true });
  git(repo, "format-patch", "-q", "-1", "-o", join(agents, "amender", "amend-commit"));
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-q", "-D", "amend");
  const config: RunConfig = {
    pipeline: PIPELINE,
    agent: { adapter: "stub", fixtureDir: agents },
    classifier: { adapter: "stub", answers: {}, default: { answer: "no", p: 0 } },
    check: { adapter: "pipeline" },
    tracker: { adapter: "file" },
    forge: { adapter: "file" },
    roles: {},
  };
  return { repo, config };
}

async function run(graph: GraphDef, request: string, replies: string[] = [OPERATOR_APPROVE], events?: string): Promise<RunHistory> {
  const id = `svc-${++runs}`;
  const { repo, config } = setup(id);
  const input: WorkflowInput = { runId: id, repo, runDir: join(tmp, id, "run"), graph, inputs: requestInputs(graph, request), config, ...(events === undefined ? {} : { events }) };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: id, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: id, workflowId: id, args: [input] });
  return worker.runUntil(runAnswering(handle, replies));
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "graph-svc-"));
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet });
});

after(async () => {
  await env?.teardown();
  rmSync(tmp, { recursive: true, force: true });
});

const runOf = (h: RunHistory, node: string, instance?: string) => h.nodes.find((n) => n.node === node && n.instance === instance);

const abandonGraph = defineGraph({
  id: "abandon",
  data: [
    { id: "request", schema: "text", boundary: "input" },
    { id: "waited", schema: "check" },
    { id: "late", schema: "check", boundary: "terminal" },
  ],
  nodes: [
    { id: "D-wait", kind: "data", role: "wait", inputs: ["request"], outputs: ["waited"], timeCapMs: MIN },
    { id: "K-late", kind: "check", role: "after", inputs: ["waited"], outputs: ["late"], timeCapMs: MIN },
  ],
  ops: { wait: { output: "check", needs: null, idempotent: true } },
});

test("an operation's waiting reason stays in the run's record, and only its question goes out in the blocked event", async () => {
  const id = `svc-${++runs}`;
  const { repo, config } = setup(id);
  const input: WorkflowInput = { runId: id, repo, runDir: join(tmp, id, "run"), graph: abandonGraph, inputs: requestInputs(abandonGraph, "go"), config, events: recorderCmd };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: id, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: id, workflowId: id, args: [input] });
  const waiting = await worker.runUntil(async () => {
    for (;;) {
      const h = await handle.query<RunHistory>(QUERY_STATUS);
      if (h.asking.length > 0) {
        await handle.signal(SIGNAL_ANSWER, "abandon");
        await handle.result();
        return h;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  assert.equal(runOf(waiting, "D-wait")?.reason, "merge or abandon?\nwhat a step printed, which stays in the worker");
  assert.equal(waiting.asking[0]?.question, "merge or abandon?");
  const blocked = recordedEvents().filter((e) => e.runid === id && e.event === "blocked");
  assert.equal(blocked.length, 1);
  assert.match(String(blocked[0]!.needs), /merge or abandon\?/);
  assert.doesNotMatch(String(blocked[0]!.needs), /what a step printed/);
});

test("a finished event the run's consumer refuses is said in the run's error, in the record and in the run's result", async () => {
  const h = await run(abandonGraph, "go", ["merge"], `${process.execPath} -e process.exit(1)`);
  assert.equal(h.phase, "done", "a lost event does not fail a run that did its work");
  assert.match(h.error ?? "", /^the finished event did not reach the launcher: buildEvent: BUILD_EVENT_CMD failed/);
  const recorded = JSON.parse(readFileSync(join(tmp, `svc-${runs}`, "run", "history.json"), "utf8")) as RunHistory;
  assert.equal(recorded.error, h.error);
});

test("an operation that ends the run on the operator's abandon ends it abandoned, by the cancel path: the node is cancelled, nothing after it runs, the history is recorded", async () => {
  const h = await run(abandonGraph, "go", ["abandon"]);
  assert.equal(h.phase, "abandoned");
  assert.deepEqual([runOf(h, "D-wait")?.status, runOf(h, "D-wait")?.reason], ["cancelled", "the operator abandoned the run"]);
  assert.equal(runOf(h, "K-late"), undefined, "nothing after the abandon starts");
  const recorded = JSON.parse(readFileSync(join(tmp, `svc-${runs}`, "run", "history.json"), "utf8")) as RunHistory;
  assert.equal(recorded.phase, "abandoned");
  const other = await run(abandonGraph, "go", ["merge"]);
  assert.deepEqual([other.phase, runOf(other, "K-late")?.status], ["done", "done"], "any other reply lets the run go on");
});

test("an amended brief is what every later node reads, and the reparse check runs again on it", async () => {
  const h = await run(amendGraph, "clean");
  assert.deepEqual(h.nodes.filter((n) => n.status === "failed"), []);
  assert.equal(h.phase, "done");
  const after = h.data.after;
  assert.equal(after?.schema === "check" && after.detail, "brief v2 brief; head v2 brief");
  assert.equal(runOf(h, "K-parse", "K-ask:Q1")?.status, "done", "the reparse ran for the amend");
  const asked = h.data.asked;
  assert.equal(asked?.schema === "check" && asked.detail, "the brief settles it", "the asker's re-run read the amended brief");
  const brief = h.data.brief;
  assert.equal(brief?.schema === "files" && readFileSync(brief.files[0]!, "utf8"), "v2 brief\n");
});

test("a resolver's brief change waits on the operator: a reply other than approve is the operator's own answer, and the brief stays", async () => {
  const h = await run(amendGraph, "clean", ["  keep v1: the answer is in its prose  "]);
  assert.equal(h.phase, "done");
  assert.equal(h.nodes.some((n) => n.node === "A-amend"), false, "no amend ran");
  const q = h.questions?.[0];
  assert.equal(q?.route, "resolver");
  assert.deepEqual(q?.answer, { question_id: "Q1", answer: "  keep v1: the answer is in its prose  ", source: "operator", by: "operator" });
  const after = h.data.after;
  assert.equal(after?.schema === "check" && after.detail, "brief v1 brief; head v1 brief");
  const approved = await run(amendGraph, "clean", [" Approve "]);
  assert.equal(approved.questions?.[0]?.answer?.by, "resolver", "approve is read trimmed, in any case");
  assert.equal(approved.data.after?.schema === "check" && approved.data.after.detail, "brief v2 brief; head v2 brief");
});

test("an amend whose merge fails fails the node that asked, and withholds its outputs", async () => {
  const h = await run(amendGraph, "dirty");
  assert.equal(h.phase, "failed");
  const asker = runOf(h, "K-ask");
  assert.equal(asker?.status, "failed");
  assert.match(asker?.reason ?? "", /the amend for Q1 failed: merge/);
  assert.equal(runOf(h, "K-after")?.status, "skipped");
  assert.equal(h.data.asked, undefined);
});

test("a failed fan-out item skips the item after it and the one after that", async () => {
  const h = await run(fanGraph, "go");
  assert.equal(runOf(h, "K-work", "P1")?.status, "failed");
  assert.equal(runOf(h, "K-work", "P2")?.status, "skipped");
  assert.match(runOf(h, "K-work", "P2")?.reason ?? "", /item P1/);
  assert.equal(runOf(h, "K-work", "P3")?.status, "skipped", "P3 comes after P2, which was skipped for P1");
  assert.match(runOf(h, "K-work", "P3")?.reason ?? "", /item P2/);
});

test("a fan-out's status fails when an item failed, and a node gated on it does not run", async () => {
  const h = await run(fanGraph, "go");
  const status = h.data["chain-ok"];
  assert.equal(status?.schema === "check" && status.answer, "fail");
  assert.match(status?.schema === "check" ? status.detail : "", /items P1, P2, P3/);
  assert.equal(runOf(h, "K-whole")?.status, "skipped");
  assert.match(runOf(h, "K-whole")?.reason ?? "", /chain-ok answered fail/);
});

const RESOLVED = { answer: "use the staging bucket", source: "docs", searched: [{ source: "docs", said: "staging is the default" }] };

test("a blocked question sends its asker back once with the question and what it searched, a second block goes to the operator, and the third run is handed both", async () => {
  const { h, asked, seen } = await runAsker(false, "blocked", RESOLVED, ["use the staging bucket"]);
  assert.equal(h.phase, "done");
  assert.deepEqual(seen, [[], [BLOCKED_LINE], [BLOCKED_LINE, "W.1: use the staging bucket (source: operator)"]]);
  assert.deepEqual(h.questions?.map((q) => q.route), ["retry", "operator"]);
  assert.equal(h.questions?.[0]?.answer, undefined, "the first block is no answer");
  assert.deepEqual(h.questions?.[1]?.answer, { question_id: "W.1", answer: "use the staging bucket", source: "operator", by: "operator" });
  assert.equal(asked.length, 1, "the operator is asked once, after the rerun was blocked too");
  assert.match(asked[0]!, /asks \(blocked\): the bucket name is not in the repo/);
  assert.equal(h.nodes.some((n) => n.node === "A-answer-question"), false, "a blocked question never reaches the resolver");
});

test("a blocked asker with an answers output still runs again on the operator's answer, instead of writing it and stopping", async () => {
  const { h, seen } = await runAsker(true, "blocked", RESOLVED, ["use the staging bucket"]);
  assert.equal(h.phase, "done");
  assert.equal(seen.length, 3, "block, blocked rerun, then a run on the operator's answer");
  assert.deepEqual(seen[2], [BLOCKED_LINE, "W.1: use the staging bucket (source: operator)"]);
  const written = h.data["draft-answers"];
  const rows = JSON.parse(readFileSync(written?.schema === "files" ? written.files[0]! : "", "utf8")) as { question_id: string; by: string }[];
  assert.deepEqual(rows.map((r) => [r.question_id, r.by]), [["W.1", "operator"]], "the last run raised W.1 again: its answer from the run before is written, not asked again");
  assert.equal(h.questions?.filter((q) => q.answer !== undefined).length, 1, "the answer is recorded once");
});

test("an asker with an answers output that raises a resolvable question is not run again: the answer lands in its answers file", async () => {
  const { h, seen, asked } = await runAsker(true, "brief", RESOLVED, []);
  assert.equal(h.phase, "done");
  assert.equal(seen.length, 1);
  assert.deepEqual(asked, []);
  const written = h.data["draft-answers"];
  const rows = JSON.parse(readFileSync(written?.schema === "files" ? written.files[0]! : "", "utf8")) as { question_id: string; by: string; source: string; searched: unknown[] }[];
  assert.deepEqual(rows.map((r) => [r.question_id, r.by, r.source, r.searched.length]), [["W.1", "resolver", "docs", 1]]);
});

test("a resolver that refuses puts what it searched into the question the operator is asked, and the operator's reply is the answer", async () => {
  const refusal = { needs_operator: true, searched: [{ source: "code", said: "src/retry.ts has no owner" }, { source: "plan", said: "silent on retries" }] };
  const { h, asked, seen } = await runAsker(false, "brief", refusal, ["retry.ts owns it"]);
  assert.equal(h.phase, "done");
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /asks \(brief\): the bucket name is not in the repo/);
  assert.match(asked[0]!, /The resolver found no answer in: code: src\/retry\.ts has no owner; plan: silent on retries\./);
  assert.deepEqual(h.questions?.map((q) => q.route), ["operator"], "the route is the one that settled it");
  assert.equal(h.questions?.[0]?.answer?.by, "operator");
  assert.deepEqual(seen[1], ["W.1: retry.ts owns it (source: operator)"]);
});

for (const answering of [true, false]) {
  test(`an asker${answering ? " with an answers output" : ""} that writes only its questions runs again on their answers, and is done on the run that writes its output`, async () => {
    const { h, seen, asked } = await runAsker(answering, "brief", RESOLVED, [], { questionsOnly: true, answeredDraft: true });
    assert.equal(h.phase, "done");
    assert.deepEqual(asked, []);
    assert.deepEqual(seen, [[], ["W.1: use the staging bucket (source: docs)"]]);
    const draft = h.data.draft;
    assert.deepEqual(draft?.schema === "files" && draft.files.map((f) => f.split("/").pop()), ["notes.md"]);
  });

  test(`an asker${answering ? " with an answers output" : ""} whose rerun writes only questions it was answered already fails, naming them`, async () => {
    const { h, seen } = await runAsker(answering, "brief", RESOLVED, [], { questionsOnly: true });
    assert.equal(h.phase, "failed");
    assert.equal(seen.length, 2);
    const work = runOf(h, "A-work");
    assert.equal(work?.status, "failed");
    assert.match(work?.reason ?? "", /draft hold only questions\.json, and every question in it is answered already: W\.1/);
  });
}

test("a blocked asker whose own rerun writes only the same blocked question fails after the operator answers it, instead of ending done on a questions file", async () => {
  const { h, seen } = await runAsker(true, "blocked", RESOLVED, ["use the staging bucket"], { questionsOnly: true });
  assert.equal(h.phase, "failed");
  assert.equal(seen.length, 3);
  assert.match(runOf(h, "A-work")?.reason ?? "", /answered already: W\.1/);
});

const DESIGN_QUESTION = { id: "W.2", type: "design-entry", text: "which retry shape", searched: [{ source: "code", said: "no retry" }] };

test("a batch with a blocked question keeps the answers before it: the rerun is handed them, they are not asked again, and each is recorded once", async () => {
  const { h, seen, resolverRuns, asked } = await runAsker(false, "blocked", RESOLVED, ["use the staging bucket"], {
    questions: [DESIGN_QUESTION, { ...WORK_QUESTION, type: "blocked" }],
  });
  assert.equal(h.phase, "done");
  assert.deepEqual(seen[1], ["W.2: use the staging bucket (source: docs)", BLOCKED_LINE]);
  assert.equal(resolverRuns, 1, "W.2 reaches the resolver once");
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /asks \(blocked\)/);
  assert.equal(h.questions?.filter((q) => q.question.id === "W.2").length, 1);
  assert.deepEqual(seen[2], ["W.2: use the staging bucket (source: docs)", BLOCKED_LINE, "W.1: use the staging bucket (source: operator)"]);
});

const BRIEF_CHANGE = { ...RESOLVED, brief_change: "name the staging bucket in the brief" };

for (const ownsBrief of [false, true]) {
  test(`a resolver's brief change ${ownsBrief ? "to a brief the asker writes itself" : "in a graph with no amend service"} puts no approve wait, and the asker's rerun reads the change`, async () => {
    const { h, seen, asked } = await runAsker(false, "design-entry", BRIEF_CHANGE, [], { ownsBrief });
    assert.equal(h.phase, "done");
    assert.deepEqual(asked, []);
    assert.deepEqual(seen[1], ["W.1: use the staging bucket Brief change: name the staging bucket in the brief (source: docs)"]);
    assert.equal(h.nodes.some((n) => n.node === "A-amend"), false, "nothing amends");
    assert.equal(h.questions?.[0]?.answer?.brief_change, BRIEF_CHANGE.brief_change);
  });
}

// ---- the ship path: the wait after the PR, and how the run ends ----

const BUILD_PIPELINE = join(ENGINE, "..", "..", "pipelines", "build", "pipeline.ts");

/** The build graph's ship nodes (K-pre-push-ship, D-open-pr, D-merge-pr, D-remove-worktrees), each with the build
 *  pipeline's real operation or check, fed what the earlier nodes would have produced as run inputs. */
const shipGraph = defineGraph({
  id: "ship",
  data: [
    { id: "start", schema: "text", boundary: "input" },
    { id: "repo-config", schema: "files", boundary: "input" },
    { id: "brief", schema: "files", boundary: "input" },
    { id: "final", schema: "files", boundary: "input" },
    { id: "final-clean", schema: "check", boundary: "input" },
    { id: "close-outcome", schema: "outcome", boundary: "input" },
    { id: "ship-gate", schema: "check", boundary: "input" },
    { id: "ticket-id", schema: "text", boundary: "input" },
    { id: "pre-push-ship", schema: "check" },
    { id: "pr", schema: "ref" },
    { id: "merge", schema: "ref", boundary: "terminal" },
    { id: "remove-worktrees", schema: "files", boundary: "terminal" },
  ],
  nodes: [
    { id: "K-pre-push-ship", kind: "check", role: "pre-push-ship", inputs: ["repo-config", "final"], outputs: ["pre-push-ship"], timeCapMs: MIN },
    { id: "D-open-pr", kind: "data", role: "open-pr", inputs: ["final", "final-clean", "close-outcome", "brief"], optionalInputs: ["pre-push-ship", "ticket-id"], outputs: ["pr"], timeCapMs: MIN },
    { id: "D-merge-pr", kind: "data", role: "merge-pr", inputs: ["pr", "ship-gate", "final-clean", "close-outcome", "final", "start", "brief"], optionalInputs: ["pre-push-ship", "ticket-id"], outputs: ["merge"], timeCapMs: MIN },
    { id: "D-remove-worktrees", kind: "data", role: "remove-worktrees", inputs: ["merge"], outputs: ["remove-worktrees"], timeCapMs: MIN },
  ],
  ops: {
    "open-pr": { output: "ref", needs: null, idempotent: false },
    "merge-pr": { output: "ref", needs: "ref", idempotent: false, gated: true },
    "remove-worktrees": { output: "files", needs: null, idempotent: true },
  },
});

interface Ship {
  hold?: boolean;
  finalClean?: "pass" | "fail";
  /** The repo's `checks` step: `true` is green, `false` is K-pre-push-ship red; `broken` is a repo
   *  config K-pre-push-ship cannot read, so the node fails and gives no answer. */
  checks?: "true" | "false" | "broken";
  /** How the close loop ended: `capped` (the default) owes a K-pre-push-ship answer. */
  loop?: "clean" | "capped";
  ticket?: string;
  replies?: string[];
}

async function runShip(o: Ship = {}) {
  const id = `svc-${++runs}`;
  const { repo, config } = setup(id);
  const runDir = join(tmp, id, "run");
  const inDir = join(tmp, id, "in");
  const file = (name: string, text: string): string => (mkdirSync(join(inDir, name), { recursive: true }), writeFileSync(join(inDir, name, `${name}.md`), text), join(inDir, name, `${name}.md`));
  const repoConfig = join(inDir, "repo-config.json");
  mkdirSync(inDir, { recursive: true });
  writeFileSync(repoConfig, o.checks === "broken" ? "{ not json" : JSON.stringify({ tree: repo, stepsFile: "", steps: { checks: o.checks ?? "true" }, notes: {}, briefsDir: null, baseRef: "main", thresholds: {} }));
  // An agent's worktree a cleanup would remove, and an abandon must leave.
  mkdirSync(join(runDir, "worktrees", "A-fixer"), { recursive: true });
  writeFileSync(join(runDir, "worktrees", "A-fixer", ".git"), "gitdir: elsewhere\n");
  const inputs: WorkflowInput["inputs"] = {
    start: { schema: "text", text: JSON.stringify({ request: "ship it", hold: o.hold === true }) },
    "repo-config": { schema: "files", files: [repoConfig] },
    brief: { schema: "files", files: [file("brief", `# Retry the push\n\n${briefText()}`)] },
    final: { schema: "files", files: [file("final", "# Final round\n")] },
    "final-clean": { schema: "check", answer: o.finalClean ?? "pass", detail: o.finalClean === "fail" ? "1 urgent row open" : "clean" },
    "close-outcome": { schema: "outcome", answer: o.loop ?? "capped" },
    "ship-gate": { schema: "check", answer: "pass", detail: "every node finished" },
    "ticket-id": { schema: "text", text: o.ticket ?? "" },
  };
  const input: WorkflowInput = { runId: id, repo, runDir, graph: shipGraph, inputs, config: { ...config, pipeline: BUILD_PIPELINE }, events: recorderCmd };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: id, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: id, workflowId: id, args: [input] });
  const asked: string[] = [];
  const h = await worker.runUntil(runAnswering(handle, o.replies ?? [], asked));
  const finished = recordedEvents().filter((e) => e.runid === id && e.event === "finished");
  const pr = (n: number) => JSON.parse(readFileSync(join(runDir, "forge", "prs", `${n}.json`), "utf8")) as { draft: boolean; merged: boolean };
  return { h, asked, finished, id, runDir, pr, repo };
}

test("a run whose final round is clean, whose checks are green and that is not held never waits: it merges, cleans up, and fires one finished merged with the PR", async () => {
  const r = await runShip();
  assert.equal(r.h.phase, "done");
  assert.deepEqual(r.asked, [], "no question reached the operator");
  assert.equal(runOf(r.h, "D-merge-pr")?.status, "done");
  assert.equal(runOf(r.h, "D-remove-worktrees")?.status, "done");
  assert.deepEqual(r.pr(1), { ...r.pr(1), draft: false, merged: true });
  assert.equal(r.finished.length, 1, "exactly one finished event");
  assert.deepEqual([r.finished[0]!.outcome, r.finished[0]!.pr], ["merged", 1]);
});

test("a held run asks with the PR link and why; a reply that is neither merge nor abandon asks again naming both; merge then merges, once, as merged", async () => {
  const r = await runShip({ hold: true, replies: ["let me read it first", OPERATOR_MERGE] });
  assert.equal(r.h.phase, "done");
  assert.equal(r.asked.length, 2);
  assert.match(r.asked[0]!, /file:\/\/.*prs\/1\.json waits: the start holds the run before its merge\./);
  assert.match(r.asked[1]!, /the reply "let me read it first" is neither merge nor abandon/);
  assert.deepEqual([runOf(r.h, "D-merge-pr")?.status, runOf(r.h, "D-remove-worktrees")?.status], ["done", "done"]);
  assert.equal(r.pr(1).merged, true);
  assert.equal(r.finished.length, 1);
  assert.deepEqual([r.finished[0]!.outcome, r.finished[0]!.pr], ["merged", 1]);
});

test("a final round that is not clean opens a draft and waits for the operator with the open rows' reason; merge readies and merges it", async () => {
  const r = await runShip({ finalClean: "fail", replies: [OPERATOR_MERGE] });
  assert.equal(r.pr(1).draft, true);
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0]!, /the final round is not clean: 1 urgent row open/);
  assert.equal(r.h.phase, "done");
  assert.equal(r.finished[0]!.outcome, "merged");
});

test("K-pre-push-ship red reaches the wait end to end: the PR is a draft, the question quotes the red check, and the run does not end silently", async () => {
  const r = await runShip({ checks: "false", replies: [OPERATOR_MERGE] });
  assert.equal(runOf(r.h, "K-pre-push-ship")?.answer, "fail", "a red check is a result, not a failed node");
  assert.notEqual(runOf(r.h, "K-pre-push-ship")?.status, "failed");
  assert.equal(r.pr(1).draft, true, "a red ship check makes the PR a draft even though the final round is clean");
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0]!, /the pre-push checks are red: checks: red/);
  assert.deepEqual([r.h.phase, r.finished.length, r.finished[0]!.outcome], ["done", 1, "merged"]);
});

test("a K-pre-push-ship that fails under a capped loop is no answer, not green: the PR is a draft and the run waits naming it", async () => {
  const r = await runShip({ checks: "broken", replies: [OPERATOR_ABANDON] });
  assert.equal(runOf(r.h, "K-pre-push-ship")?.status, "failed");
  assert.equal(r.pr(1).draft, true);
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0]!, /the pre-push checks did not answer after the capped close loop/);
  assert.equal(r.pr(1).merged, false, "nothing merged without the operator");
});

test("the reply abandon ends the run abandoned by the cancel path: D-merge-pr cancelled, no cleanup, the run tree and worktrees left, one ticket comment, one finished event naming branch, worktrees and PR", async () => {
  const r = await runShip({ hold: true, ticket: "DEV-9", replies: [OPERATOR_ABANDON] });
  assert.equal(r.h.phase, "abandoned");
  assert.equal(runOf(r.h, "D-merge-pr")?.status, "cancelled");
  assert.equal(runOf(r.h, "D-remove-worktrees"), undefined, "cleanup never runs on an abandon");
  assert.equal(r.h.data.merge, undefined);
  const place = JSON.parse(readFileSync(join(r.runDir, "place.json"), "utf8")) as { worktree: string; branch: string };
  assert.equal(existsSync(place.worktree), true, "the run tree is left");
  assert.equal(existsSync(join(r.runDir, "worktrees", "A-fixer")), true, "the agents' worktrees are left");
  assert.equal(r.pr(1).merged, false, "the PR is left open");
  assert.equal((JSON.parse(readFileSync(join(r.runDir, "history.json"), "utf8")) as RunHistory).phase, "abandoned");
  assert.equal(r.finished.length, 1, "exactly one finished event");
  const e = r.finished[0]!;
  assert.deepEqual([e.outcome, e.pr, e.branch], ["abandoned", 1, place.branch]);
  assert.ok((e.worktrees as string[]).includes(place.worktree) && (e.worktrees as string[]).includes(join(r.runDir, "worktrees", "A-fixer")), "the event lists the run tree and the agents' worktrees");
  const comments = readdirSync(join(r.runDir, "tracker", "comments"));
  assert.equal(comments.length, 1, "one comment on the ticket");
  assert.match(readFileSync(join(r.runDir, "tracker", "comments", comments[0]!), "utf8"), /DEV-9/);
});

test("an abandoned run without a ticket comments nowhere, and still ends abandoned with its one event", async () => {
  const r = await runShip({ hold: true, replies: [OPERATOR_ABANDON] });
  assert.equal(r.h.phase, "abandoned");
  assert.equal(existsSync(join(r.runDir, "tracker")), false);
  assert.equal(r.finished.length, 1);
});

test("a run that fails fires one finished failed and no PR number when none was opened", async () => {
  // No brief in the files: D-open-pr's op throws on the unreadable input, and D-merge-pr, D-remove-worktrees skip.
  const id = `svc-${++runs}`;
  const { repo, config } = setup(id);
  const input: WorkflowInput = {
    runId: id,
    repo,
    runDir: join(tmp, id, "run"),
    graph: amendGraph,
    inputs: requestInputs(amendGraph, "clean"),
    config: { ...config, agent: { adapter: "stub", fixtureDir: join(tmp, id, "no-fixtures") } },
    events: recorderCmd,
  };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: id, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: id, workflowId: id, args: [input] });
  const h = (await worker.runUntil(handle.result())) as RunHistory;
  assert.equal(h.phase, "failed");
  const finished = recordedEvents().filter((e) => e.runid === id && e.event === "finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0]!.outcome, "failed");
  assert.equal("pr" in finished[0]!, false);
  const place = JSON.parse(readFileSync(join(input.runDir, "place.json"), "utf8")) as { worktree: string; branch: string };
  assert.equal(finished[0]!.branch, place.branch, "a failed run names the branch it leaves");
  assert.deepEqual(finished[0]!.worktrees, [place.worktree, join(input.runDir, "worktrees", "A-write-brief")], "and the worktrees: the run tree and the agent's own");
});
