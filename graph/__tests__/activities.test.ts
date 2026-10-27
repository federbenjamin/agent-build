/**
 * The activities that wrap a node run (`activities.ts`), called directly in Temporal's mock activity
 * environment: the attempt record every node kind leaves, and the classifier node's exploration and
 * fail-open. A real run's classifier is the Jev adapter with `fetch` replaced, so no model is called.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MockActivityEnvironment } from "@temporalio/testing";

import { agentNode, classifierNode, recordRun } from "../activities.ts";
import { filesUnder } from "../adapters/agentIo.ts";
import { groupAlive } from "../adapters/process.ts";
import { explores } from "../adapters/decision.ts";
import { parseRunConfig } from "../config.ts";
import { EXPLORE_RATE } from "../constants.ts";
import { type AttemptRecord, type DataValues, type NodeDef, type NodeOutcome, type NodeTask, parseAttemptRecord, type RunConfig, type RunHistory, type RunPlace } from "../contracts.ts";
import { gateFails } from "../define.ts";
import { graph as toy } from "../examples/toy.ts";
import { readRunDir } from "../runDirs.ts";
import { statsReport } from "../stats.ts";

const graphDir = join(dirname(fileURLToPath(import.meta.url)), "..");

let tmp: string;
let runs = 0;
const savedKey = process.env.TYPESAFE_API_KEY;
const realFetch = globalThis.fetch;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "graph-activities-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** A run dir with a git repo as its run tree. */
function place(): RunPlace {
  const worktree = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", worktree]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: worktree });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  return { runDir: join(tmp, "run"), worktree, branch: "main", baseSha };
}

const mockEnv = (attempt = 1) => new MockActivityEnvironment({ attempt, startToCloseTimeoutMs: 600_000 });

const attemptFiles = (runDir: string, node: string, iteration: number): string[] =>
  readdirSync(join(runDir, "nodes", node, String(iteration)), { recursive: true })
    .map(String)
    .filter((f) => /attempt-\d+\.json$/.test(f))
    .sort();
const attemptAt = (runDir: string, node: string, iteration: number, file: string): AttemptRecord =>
  parseAttemptRecord(JSON.parse(readFileSync(join(runDir, "nodes", node, String(iteration), file), "utf8")));

// ---- agent attempt records ----

const agentDef: NodeDef = { id: "A-x", kind: "agent", role: "writer", inputs: [], outputs: ["notes"], timeCapMs: 600_000 };

/** A stub agent that, like the Claude adapter, leaves the CLI's `claude.json` beside `out/` when the
 *  fixture folder holds one. */
function replayingConfig(fixtureDir: string): RunConfig {
  const replay = join(tmp, "replay.mjs");
  writeFileSync(
    replay,
    [
      'import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      "export const replayAgent = (binding) => ({",
      "  async run(req) {",
      '    const usage = join(binding.fixtureDir, "claude.json");',
      '    if (existsSync(usage)) cpSync(usage, join(dirname(req.outDir), "claude.json"));',
      "    const files = {};",
      "    for (const id of req.outputs) {",
      '      const f = join(req.outDir, id, "note.md");',
      "      mkdirSync(dirname(f), { recursive: true });",
      '      writeFileSync(f, "x\\n");',
      "      files[id] = [f];",
      "    }",
      '    return { status: "done", files };',
      "  },",
      "});",
    ].join("\n")
  );
  return parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir, replay }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
}

function agentTask(config: RunConfig, p: RunPlace, over: Partial<NodeTask> = {}): NodeTask {
  return { runId: `r-${++runs}`, node: agentDef, iteration: 1, inputs: {}, answers: [], place: p, config, ...over };
}

// The shape `claude -p --output-format json` prints: two models, so the sum and the top model are checked.
const CLAUDE_JSON = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 91234,
  num_turns: 7,
  result: "done",
  session_id: "00000000-0000-0000-0000-000000000000",
  total_cost_usd: 0.4321,
  usage: { input_tokens: 12, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000, output_tokens: 800 },
  modelUsage: {
    "claude-haiku-4-5": { inputTokens: 2, outputTokens: 100, cacheReadInputTokens: 10000, cacheCreationInputTokens: 1000, costUSD: 0.0321 },
    "claude-opus-4-5": { inputTokens: 10, outputTokens: 700, cacheReadInputTokens: 30000, cacheCreationInputTokens: 2000, costUSD: 0.4 },
  },
};

test("an agent attempt's record names the model that cost most, the tokens summed over every model, and the CLI's cost, read from claude.json", async () => {
  const fixtureDir = join(tmp, "fx");
  mkdirSync(join(fixtureDir, "writer", "notes"), { recursive: true });
  writeFileSync(join(fixtureDir, "claude.json"), JSON.stringify(CLAUDE_JSON));
  const p = place();
  await mockEnv().run(agentNode, agentTask(replayingConfig(fixtureDir), p));
  const a = attemptAt(p.runDir, "A-x", 1, "rerun-0/attempt-1.json");
  assert.equal(a.outcome, "done");
  assert.equal(a.model, "claude-opus-4-5");
  assert.deepEqual(a.tokens, { input: 12, output: 800, cacheRead: 40000, cacheWrite: 3000 });
  assert.equal(a.costUsd, 0.4321);
});

test("a node's modelFrom input reaches the runner as the request's model, trimmed; a node without one sends none", async () => {
  const replay = join(tmp, "model-replay.mjs");
  writeFileSync(
    replay,
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      "export const replayAgent = () => ({",
      "  async run(req) {",
      '    writeFileSync(join(dirname(req.outDir), "model.txt"), req.model ?? "none");',
      '    const f = join(req.outDir, "notes", "note.md");',
      "    mkdirSync(dirname(f), { recursive: true });",
      '    writeFileSync(f, "x\\n");',
      '    return { status: "done", files: { notes: [f] } };',
      "  },",
      "});",
    ].join("\n")
  );
  const config = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir: tmp, replay }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
  const modelDef: NodeDef = { ...agentDef, inputs: ["fixer-model"], modelFrom: "fixer-model" };
  const p = place();
  await mockEnv().run(agentNode, agentTask(config, p, { node: modelDef, inputs: { "fixer-model": { schema: "text", text: "opus\n" } } }));
  const seen = () => readFileSync(filesUnder(join(p.runDir, "nodes", "A-x")).find((f) => f.endsWith("model.txt"))!, "utf8");
  assert.equal(seen(), "opus");
  await mockEnv().run(agentNode, agentTask(config, p, { runId: "r-none" }));
  assert.equal(seen(), "none");
});

test("an agent whose CLI left no claude.json has null model, tokens and cost on its record, never 0", async () => {
  const fixtureDir = join(tmp, "fx");
  mkdirSync(fixtureDir, { recursive: true });
  const p = place();
  await mockEnv().run(agentNode, agentTask(replayingConfig(fixtureDir), p));
  const raw = JSON.parse(readFileSync(join(p.runDir, "nodes", "A-x", "1", "rerun-0", "attempt-1.json"), "utf8")) as Record<string, unknown>;
  assert.equal(raw.outcome, "done");
  assert.deepEqual([raw.model, raw.tokens, raw.costUsd], [null, null, null]);
});

test("a claude.json with only the top-level usage gives its tokens and no model; one that is not JSON gives nulls", async () => {
  const fixtureDir = join(tmp, "fx");
  mkdirSync(fixtureDir, { recursive: true });
  const config = replayingConfig(fixtureDir);
  const p = place();
  const { modelUsage: _drop, ...flat } = CLAUDE_JSON;
  writeFileSync(join(fixtureDir, "claude.json"), JSON.stringify(flat));
  await mockEnv().run(agentNode, agentTask(config, p));
  const a = attemptAt(p.runDir, "A-x", 1, "rerun-0/attempt-1.json");
  assert.equal(a.model, null);
  assert.deepEqual(a.tokens, { input: 12, output: 800, cacheRead: 40000, cacheWrite: 3000 });
  assert.equal(a.costUsd, 0.4321);

  writeFileSync(join(fixtureDir, "claude.json"), "claude crashed: not json");
  await mockEnv(2).run(agentNode, agentTask(config, p));
  const b = attemptAt(p.runDir, "A-x", 1, "rerun-0/attempt-2.json");
  assert.deepEqual([b.model, b.tokens, b.costUsd], [null, null, null]);
});

test("a retry does not read the claude.json an earlier attempt left as its own", async () => {
  const fixtureDir = join(tmp, "fx");
  mkdirSync(fixtureDir, { recursive: true });
  const config = replayingConfig(fixtureDir);
  const p = place();
  writeFileSync(join(fixtureDir, "claude.json"), JSON.stringify(CLAUDE_JSON));
  await mockEnv(1).run(agentNode, agentTask(config, p));
  rmSync(join(fixtureDir, "claude.json"));
  await mockEnv(2).run(agentNode, agentTask(config, p));
  assert.equal(attemptAt(p.runDir, "A-x", 1, "rerun-0/attempt-1.json").costUsd, 0.4321);
  const second = attemptAt(p.runDir, "A-x", 1, "rerun-0/attempt-2.json");
  assert.deepEqual([second.model, second.tokens, second.costUsd], [null, null, null]);
});

test("a retry and a rerun keep the struggles and crosstalk each earlier attempt left, and the run-dir reader returns every attempt's, in the order they ran", async () => {
  const fixtureDir = join(tmp, "fx");
  mkdirSync(fixtureDir, { recursive: true });
  const replay = join(tmp, "side-replay.mjs");
  writeFileSync(
    replay,
    [
      'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "export const replayAgent = (binding) => ({",
      "  async run(req) {",
      '    const tag = readFileSync(join(binding.fixtureDir, "tag.txt"), "utf8");',
      '    const dir = join(req.outDir, "notes");',
      "    mkdirSync(dir, { recursive: true });",
      '    writeFileSync(join(dir, "note.md"), tag);',
      '    writeFileSync(join(dir, "questions.json"), "[]");',
      '    writeFileSync(join(dir, "struggles.json"), JSON.stringify([{ category: "docs", where: tag, moment: "m", needed: "n", skip: "s" }]));',
      '    writeFileSync(join(dir, "crosstalk.jsonl"), JSON.stringify({ at: "2026-10-25T00:00:00.000Z", to: "S2", session: "x", text: tag }) + "\\n");',
      '    return { status: "done", files: { notes: [join(dir, "note.md")] } };',
      "  },",
      "});",
    ].join("\n")
  );
  const config = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir, replay }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
  const p = place();
  const runAs = async (tag: string, attempt: number, rerun: number) => {
    writeFileSync(join(fixtureDir, "tag.txt"), tag);
    await mockEnv(attempt).run(agentNode, agentTask(config, p, { runId: "r-side", rerun }));
  };
  await runAs("first", 1, 0);
  await runAs("retry", 2, 0);
  await runAs("rerun", 1, 1);

  const node = join(p.runDir, "nodes", "A-x", "1");
  assert.deepEqual(readdirSync(join(node, "rerun-0", "attempt-1", "out", "notes")).sort(), ["crosstalk.jsonl", "struggles.json"], "questions.json is routed, not kept");
  assert.deepEqual(readdirSync(join(node, "out", "notes")).sort(), ["crosstalk.jsonl", "note.md", "questions.json", "struggles.json"], "the output folder holds the last attempt's files only");
  assert.equal(existsSync(join(node, "rerun-1", "attempt-1", "out")), false, "the last attempt's side files stay in the output folder");

  const data = readRunDir(p.runDir);
  assert.deepEqual(data.problems, []);
  assert.deepEqual(data.struggles.map((s) => [s.key, (s.raw as { where: string }[])[0]!.where]), [["nodes/A-x/1", "first"], ["nodes/A-x/1", "retry"], ["nodes/A-x/1", "rerun"]]);
  assert.deepEqual(data.crosstalk.map((c) => [c.key, c.file]), [
    ["nodes/A-x/1", "nodes/A-x/1/rerun-0/attempt-1/out/notes/crosstalk.jsonl"],
    ["nodes/A-x/1", "nodes/A-x/1/rerun-0/attempt-2/out/notes/crosstalk.jsonl"],
    ["nodes/A-x/1", "nodes/A-x/1/out/notes/crosstalk.jsonl"],
  ]);
  assert.deepEqual(statsReport([data]).crosstalk.map((c) => c.firstLine), ["first", "retry", "rerun"]);
});

// ---- attempt keys ----

test("a retry, a rerun and a rerun on an operator's answer each keep their own attempt record, and a needs-operator attempt says so", async () => {
  const fixtureDir = join(tmp, "fx");
  mkdirSync(join(fixtureDir, "writer", "notes"), { recursive: true });
  writeFileSync(join(fixtureDir, "writer", "notes", "note.md"), "x\n");
  const config = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir, ask: "Which?" }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
  const p = place();
  const asked = (await mockEnv(1).run(agentNode, agentTask(config, p))) as NodeOutcome;
  assert.equal(asked.status, "needs-operator");
  // The workflow reruns the node on the answer with rerun + 1; a schema rerun does the same.
  await mockEnv(1).run(agentNode, agentTask(config, p, { answers: ["this one"], rerun: 1 }));
  await mockEnv(2).run(agentNode, agentTask(config, p, { answers: ["this one"], rerun: 1 }));
  await mockEnv(1).run(agentNode, agentTask(config, p, { answers: ["this one"], rerun: 2 }));
  assert.deepEqual(attemptFiles(p.runDir, "A-x", 1), ["rerun-0/attempt-1.json", "rerun-1/attempt-1.json", "rerun-1/attempt-2.json", "rerun-2/attempt-1.json"]);
  const seen = attemptFiles(p.runDir, "A-x", 1).map((f) => attemptAt(p.runDir, "A-x", 1, f));
  assert.deepEqual(seen.map((r) => [r.rerun, r.attempt]), [[0, 1], [1, 1], [1, 2], [2, 1]]);
  assert.deepEqual(seen.map((r) => r.outcome), ["needs-operator", "done", "done", "done"]);
});

test("a fan-out item's attempt records sit under its own folder, apart from every other item's", async () => {
  const fixtureDir = join(tmp, "fx");
  mkdirSync(fixtureDir, { recursive: true });
  const config = replayingConfig(fixtureDir);
  const p = place();
  await mockEnv().run(agentNode, agentTask(config, p, { instance: "P1" }));
  await mockEnv().run(agentNode, agentTask(config, p, { instance: "P2" }));
  for (const item of ["P1", "P2"]) {
    const a = parseAttemptRecord(JSON.parse(readFileSync(join(p.runDir, "nodes", "A-x", "1", item, "rerun-0", "attempt-1.json"), "utf8")));
    assert.equal(a.instance, item);
  }
});

test("an attempt that throws leaves a closed record marked failed,", async () => {
  const fixtureDir = join(tmp, "fx-missing");
  const config = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
  const p = place();
  await assert.rejects(mockEnv().run(agentNode, agentTask(config, p)));
  const a = attemptAt(p.runDir, "A-x", 1, "rerun-0/attempt-1.json");
  assert.equal(a.outcome, "failed");
  assert.ok(a.endedAt !== undefined && Date.parse(a.endedAt) >= Date.parse(a.startedAt));
});

test("an agent marked failOpen fails open as a classifier does: on an error no retry would help, or its last attempt, it ends done with no outputs and the error; before that it throws for a retry", async () => {
  const opens: NodeDef = { ...agentDef, failOpen: true };
  const missing = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir: join(tmp, "fx-missing") }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
  const out = (await mockEnv(1).run(agentNode, agentTask(missing, place(), { node: opens }))) as NodeOutcome;
  assert.equal(out.status, "done");
  assert.deepEqual(out.status === "done" ? [out.outputs, /no fixture folder/.test(out.failedOpen ?? "")] : [], [{}, true], "a missing output is a ContractError: no retry would help");

  const flaky = join(tmp, "flaky.mjs");
  writeFileSync(flaky, 'export const replayAgent = () => ({ async run() { throw new Error("the CLI exited 1"); } });\n');
  const breaks = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir: tmp, replay: flaky }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
  await assert.rejects(mockEnv(1).run(agentNode, agentTask(breaks, place(), { node: opens, runId: "r-flaky" })), /the CLI exited 1/, "attempt 1 is retried");
  const last = (await mockEnv(2).run(agentNode, agentTask(breaks, place(), { node: opens, runId: "r-flaky" }))) as NodeOutcome;
  assert.deepEqual(last.status === "done" ? [last.outputs, last.failedOpen] : [], [{}, "the CLI exited 1"]);
  await assert.rejects(mockEnv(2).run(agentNode, agentTask(breaks, place(), { runId: "r-flaky-2" })), /the CLI exited 1/, "an agent not marked failOpen fails");
});

// ---- classifier node: exploration and fail-open ----

const verifierNode: NodeDef = { ...toy.nodes.find((n) => n.id === "needs-review")!, role: "completeness" };
const gate = { classifier: "needs-review", answer: "yes" };
const inputs: DataValues = { brief: { schema: "text", text: "Add a flag." }, "size-report": { schema: "text", text: '{"counted": 500}' } };

function classifierConfig(real: boolean): RunConfig {
  return parseRunConfig(
    {
      graph: "pipelines/build.ts",
      agent: real ? { adapter: "claude", plugin: "agent-build" } : { adapter: "stub", fixtureDir: join(tmp, "fx") },
      check: { adapter: "stub", default: "pass" },
      roles: { completeness: { classifier: { adapter: "jev", setup: "classifiers/completeness.json" } } },
    },
    graphDir
  ).config;
}

const classifierTask = (config: RunConfig, runId: string, over: Partial<NodeTask> = {}): NodeTask => ({
  runId,
  node: verifierNode,
  iteration: 0,
  inputs,
  answers: [],
  place: { runDir: join(tmp, "run"), worktree: join(tmp, "repo"), branch: "main", baseSha: "0" },
  config,
  ...over,
});

const jevAnswers = (level: number) => ({
  answers: {
    deliverables_listed: { type: "score", score: level * 4 },
    sweep_or_removal: { type: "noul", noul: level },
    parts_listed: { type: "score", score: level * 4 },
  },
});
const serve = (body: unknown): void => {
  process.env.TYPESAFE_API_KEY = "key-test";
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof globalThis.fetch;
};
const unreachable = (): void => {
  process.env.TYPESAFE_API_KEY = "key-test";
  globalThis.fetch = (async () => {
    throw new Error("provider is down");
  }) as typeof globalThis.fetch;
};
const verdictOf = async (task: NodeTask, attempt = 1) => {
  const out = (await mockEnv(attempt).run(classifierNode, task)) as NodeOutcome;
  assert.equal(out.status, "done");
  const v = out.status === "done" ? out.outputs[verdictOutputId()] : undefined;
  assert.equal(v?.schema, "verdict");
  return v as Extract<NonNullable<typeof v>, { schema: "verdict" }>;
};
const verdictOutputId = (): string => verifierNode.outputs[0]!;

const runWhere = (explored: boolean): string => {
  for (let i = 0; ; i++) if (explores(`g-run-${i}`, verifierNode.id, 0, EXPLORE_RATE) === explored) return `g-run-${i}`;
};

test("an initial setup's no in a real run, on a run whose coin falls under the rate, is explored: the decision says so, the verdict stays no, and the gate opens", async () => {
  serve(jevAnswers(0));
  const v = await verdictOf(classifierTask(classifierConfig(true), runWhere(true)));
  assert.equal(v.answer, "no");
  assert.equal(v.p, 0);
  assert.equal(v.decision?.explored, true);
  assert.equal(v.decision?.error, undefined);
  assert.equal(gateFails(toy, gate, { "review-call": v }), null);
});

test("a no on a run whose coin falls over the rate is not explored and keeps its gate shut", async () => {
  serve(jevAnswers(0));
  const v = await verdictOf(classifierTask(classifierConfig(true), runWhere(false)));
  assert.equal(v.answer, "no");
  assert.equal("explored" in (v.decision ?? {}), false);
  assert.match(gateFails(toy, gate, { "review-call": v }) ?? "", /answered no, not yes/);
});

test("the run that explores in a real run never explores as a mock, every agent binding being a stub", async () => {
  serve(jevAnswers(0));
  const v = await verdictOf(classifierTask(classifierConfig(false), runWhere(true)));
  assert.equal(v.answer, "no");
  assert.equal("explored" in (v.decision ?? {}), false);
  assert.match(gateFails(toy, gate, { "review-call": v }) ?? "", /answered no, not yes/);
});

test("a yes is never marked explored, on a run whose coin would explore a no", async () => {
  serve(jevAnswers(1));
  const v = await verdictOf(classifierTask(classifierConfig(true), runWhere(true)));
  assert.equal(v.answer, "yes");
  assert.equal("explored" in (v.decision ?? {}), false);
});

test("a call that fails on the first attempt is thrown for a retry, and its attempt record is marked failed", async () => {
  unreachable();
  const task = classifierTask(classifierConfig(true), runWhere(true));
  await assert.rejects(mockEnv(1).run(classifierNode, task), /provider is down/);
  assert.equal(attemptAt(join(tmp, "run"), "needs-review", 0, "rerun-0/attempt-1.json").outcome, "failed");
});

test("a call that fails on the last attempt answers yes at the cut-off with the error on the decision, so the reader runs", async () => {
  unreachable();
  const v = await verdictOf(classifierTask(classifierConfig(true), runWhere(true)), 2);
  assert.equal(v.answer, "yes");
  assert.equal(v.p, 0.5, "p is the setup's cut-off, so answer and p agree");
  assert.match(v.decision?.error ?? "", /provider is down/);
  assert.equal(v.decision?.node, "needs-review");
  assert.equal("explored" in (v.decision ?? {}), false);
  assert.equal(gateFails(toy, gate, { "review-call": v }), null);
  assert.equal(attemptAt(join(tmp, "run"), "needs-review", 0, "rerun-0/attempt-2.json").outcome, "done");
});

test("a RunError fails open on the first attempt, as no retry would help", async () => {
  // No key: the Jev adapter refuses with a RunError, which Temporal never retries.
  delete process.env.TYPESAFE_API_KEY;
  const v = await verdictOf(classifierTask(classifierConfig(true), "g-run-0"), 1);
  assert.equal(v.answer, "yes");
  assert.equal(v.p, 0.5);
  assert.match(v.decision?.error ?? "", /TYPESAFE_API_KEY is not set/);
});

test("a cancel during the call is rethrown, never turned into a yes, even on the last attempt", async () => {
  process.env.TYPESAFE_API_KEY = "key-test";
  let called!: () => void;
  const started = new Promise<void>((resolve) => (called = resolve));
  globalThis.fetch = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      called();
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")), { once: true });
    })) as unknown as typeof globalThis.fetch;
  const env = mockEnv(2);
  const running = env.run(classifierNode, classifierTask(classifierConfig(true), "g-run-0"));
  const settled = assert.rejects(running);
  await started;
  env.cancel();
  await settled;
  assert.ok(existsSync(join(tmp, "run", "nodes", "needs-review", "0", "rerun-0", "attempt-2.json")));
  assert.notEqual(attemptAt(join(tmp, "run"), "needs-review", 0, "rerun-0/attempt-2.json").outcome, "done");
});

// ---- a writer's retry ----

test("a writing agent's second attempt, after a first that failed, starts from the commit attempt 1 recorded: its stray work is gone, and the run tree is untouched though it moved since", async () => {
  const replay = join(tmp, "flaky-writer.mjs");
  writeFileSync(
    replay,
    [
      'import { execFileSync } from "node:child_process";',
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "export const replayAgent = () => ({",
      "  async run(req) {",
      "    if (req.attempt === 1) {",
      '      writeFileSync(join(req.worktree, "half-made.txt"), "attempt 1\\n");',
      '      execFileSync("git", ["add", "half-made.txt"], { cwd: req.worktree });',
      '      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "half-made"], { cwd: req.worktree });',
      '      throw new Error("the CLI crashed");',
      "    }",
      '    const f = join(req.outDir, "notes", "note.md");',
      '    mkdirSync(join(req.outDir, "notes"), { recursive: true });',
      '    writeFileSync(f, "x\\n");',
      '    return { status: "done", files: { notes: [f] } };',
      "  },",
      "});",
    ].join("\n")
  );
  const config = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir: tmp, replay }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
  const writer: NodeDef = { id: "A-fix", kind: "agent", role: "writer", inputs: [], outputs: ["notes", "commit"], writes: true, timeCapMs: 600_000 };
  const p = place();
  const task = agentTask(config, p, { node: writer, schemas: { notes: "files", commit: "ref" } });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  const start = git(p.worktree, "rev-parse", "HEAD");
  await assert.rejects(mockEnv(1).run(agentNode, task), /the CLI crashed/);
  const own = join(p.runDir, "worktrees", "A-fix");
  assert.notEqual(git(own, "rev-parse", "HEAD"), start, "attempt 1 left its commit");
  // Another node's merge lands on the run tree between the attempts, and a sibling's work is uncommitted there.
  git(p.worktree, "commit", "-q", "--allow-empty", "-m", "another node merged");
  writeFileSync(join(p.worktree, "sibling.txt"), "another node's uncommitted work\n");
  const moved = git(p.worktree, "rev-parse", "HEAD");
  const out = (await mockEnv(2).run(agentNode, task)) as NodeOutcome;
  assert.equal(out.status, "done");
  const ref = out.status === "done" ? out.outputs.commit : undefined;
  assert.deepEqual(ref, { schema: "ref", kind: "commit", id: start }, "attempt 2 starts at attempt 1's recorded start, not the run tree's new head");
  assert.equal(existsSync(join(own, "half-made.txt")), false, "the failed attempt's stray file is gone");
  assert.equal(git(p.worktree, "rev-parse", "HEAD"), moved, "the run tree keeps its head");
  assert.equal(readFileSync(join(p.worktree, "sibling.txt"), "utf8"), "another node's uncommitted work\n", "and its uncommitted work");
});

test("a fresh writer rerun records the moved run head once, while an ordinary rerun keeps its first start", async () => {
  const replay = join(tmp, "writer-replay.mjs");
  writeFileSync(
    replay,
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "export const replayAgent = () => ({",
      "  async run(req) {",
      '    writeFileSync(join(req.worktree, "writer.txt"), `attempt ${req.attempt}\\n`);',
      '    const note = join(req.outDir, "notes", "note.md");',
      '    mkdirSync(join(req.outDir, "notes"), { recursive: true });',
      '    writeFileSync(note, "x\\n");',
      '    return { status: "done", files: { notes: [note] } };',
      "  },",
      "});",
    ].join("\n")
  );
  const config = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir: tmp, replay }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
  const writer: NodeDef = { id: "A-fresh", kind: "agent", role: "writer", inputs: [], outputs: ["notes", "commit"], writes: true, timeCapMs: 600_000 };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  const commitId = (out: NodeOutcome): string => {
    assert.equal(out.status, "done");
    const commit = out.status === "done" ? out.outputs.commit : undefined;
    assert.deepEqual(commit?.schema, "ref");
    return commit?.schema === "ref" ? commit.id : "";
  };

  const freshPlace = place();
  const initialFreshHead = git(freshPlace.worktree, "rev-parse", "HEAD");
  await mockEnv(1).run(agentNode, agentTask(config, freshPlace, { node: writer, schemas: { notes: "files", commit: "ref" } }));
  git(freshPlace.worktree, "commit", "-q", "--allow-empty", "-m", "merge before fresh writer");
  const freshHead = git(freshPlace.worktree, "rev-parse", "HEAD");
  const freshTask = agentTask(config, freshPlace, { node: writer, schemas: { notes: "files", commit: "ref" }, rerun: 1, fresh: true });
  const freshFirst = commitId((await mockEnv(1).run(agentNode, freshTask)) as NodeOutcome);
  assert.equal(git(freshPlace.worktree, "show", "-s", "--format=%P", freshFirst), freshHead);
  assert.deepEqual(JSON.parse(readFileSync(join(freshPlace.runDir, "nodes", "A-fresh", "1", "start-sha.json"), "utf8")), { sha: freshHead });
  assert.notEqual(initialFreshHead, freshHead);
  git(freshPlace.worktree, "commit", "-q", "--allow-empty", "-m", "merge after fresh writer");
  const newestHead = git(freshPlace.worktree, "rev-parse", "HEAD");
  const freshRetry = commitId((await mockEnv(2).run(agentNode, freshTask)) as NodeOutcome);
  assert.equal(git(freshPlace.worktree, "show", "-s", "--format=%P", freshRetry), freshHead);
  assert.notEqual(freshHead, newestHead);

  const ordinaryPlace = place();
  const initialHead = git(ordinaryPlace.worktree, "rev-parse", "HEAD");
  const ordinaryTask = agentTask(config, ordinaryPlace, { node: { ...writer, id: "A-ordinary" }, schemas: { notes: "files", commit: "ref" } });
  await mockEnv(1).run(agentNode, ordinaryTask);
  git(ordinaryPlace.worktree, "commit", "-q", "--allow-empty", "-m", "merge before ordinary rerun");
  const ordinaryRerun = commitId((await mockEnv(1).run(agentNode, { ...ordinaryTask, rerun: 1 })) as NodeOutcome);
  assert.equal(git(ordinaryPlace.worktree, "show", "-s", "--format=%P", ordinaryRerun), initialHead);
});

/** What a restarted writer leaves in its worktree, as shell-free git steps its replay stub runs. */
const RESTART_LEAVES = {
  nothing: [],
  "an empty commit": ['git(w, "commit", "-q", "--allow-empty", "-m", "empty")'],
  "a merge it left unresolved": ['try { git(w, "merge", "--no-edit", c); } catch {}'],
  "its own commit off an older head": ['git(w, "reset", "-q", "--hard", "HEAD~1")', 'writeFileSync(join(w, "own.txt"), "own\\n")', 'git(w, "add", "own.txt")', 'git(w, "commit", "-qm", "own")'],
  "the merge, resolved": ['try { git(w, "merge", "--no-edit", c); } catch {}', 'writeFileSync(join(w, "shared.txt"), "both\\n")', 'git(w, "add", "shared.txt")', 'git(w, "commit", "-qm", "resolved")'],
  "the merge, resolved to the new head's side": ['try { git(w, "merge", "--no-edit", c); } catch {}', 'git(w, "checkout", "--ours", "shared.txt")', 'git(w, "add", "shared.txt")', 'git(w, "commit", "-q", "--no-edit")'],
  "its own commit on the new head": ['writeFileSync(join(w, "own.txt"), "own\\n")', 'git(w, "add", "own.txt")', 'git(w, "commit", "-qm", "own")'],
} as const;

test("a writer's fresh run after a conflict hands on its head only when it holds the conflicted commit or adds a change on the head it began at; else the conflicted commit, and unmerged leftovers are never committed", async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const writer: NodeDef = { id: "A-restart", kind: "agent", role: "writer", inputs: [], outputs: ["notes", "commit"], writes: true, timeCapMs: 600_000 };
  for (const [leaves, steps] of Object.entries(RESTART_LEAVES)) {
    const root = join(tmp, leaves.replaceAll(" ", "-"));
    const worktree = join(root, "repo");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "shared.txt"), "base\n");
    git(worktree, "init", "-q", "-b", "main");
    git(worktree, "add", ".");
    git(worktree, "commit", "-qm", "base");
    const baseSha = git(worktree, "rev-parse", "HEAD");
    git(worktree, "switch", "-qc", "side");
    writeFileSync(join(worktree, "shared.txt"), "side\n");
    git(worktree, "commit", "-qam", "the writer's first commit");
    const conflicted = git(worktree, "rev-parse", "HEAD");
    git(worktree, "switch", "-q", "main");
    writeFileSync(join(worktree, "shared.txt"), "main\n");
    git(worktree, "commit", "-qam", "another writer's merge");
    const head = git(worktree, "rev-parse", "HEAD");
    const replay = join(root, "restarted.mjs");
    writeFileSync(
      replay,
      [
        'import { execFileSync } from "node:child_process";',
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });',
        "export const replayAgent = () => ({",
        "  async run(req) {",
        "    const w = req.worktree;",
        "    const c = req.conflict.commit;",
        ...steps.map((s) => `    ${s};`),
        '    const note = join(req.outDir, "notes", "note.md");',
        '    mkdirSync(join(req.outDir, "notes"), { recursive: true });',
        '    writeFileSync(note, "x\\n");',
        '    return { status: "done", files: { notes: [note] } };',
        "  },",
        "});",
      ].join("\n")
    );
    const config = parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir: root, replay }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
    const p: RunPlace = { runDir: join(root, "run"), worktree, branch: "main", baseSha };
    const conflict = { commit: conflicted, paths: ["shared.txt"], restart: 1 };
    const out = (await mockEnv(1).run(agentNode, agentTask(config, p, { node: writer, schemas: { notes: "files", commit: "ref" }, rerun: 1, fresh: true, conflict }))) as NodeOutcome;
    assert.equal(out.status, "done", leaves);
    const ref = out.status === "done" ? out.outputs.commit : undefined;
    const own = join(p.runDir, "worktrees", "A-restart");
    const ownHead = git(own, "rev-parse", "HEAD");
    const handsOn = leaves.startsWith("the merge, resolved") || leaves === "its own commit on the new head";
    assert.deepEqual(ref, { schema: "ref", kind: "commit", id: handsOn ? ownHead : conflicted }, leaves);
    if (handsOn) assert.notEqual(ownHead, head, `${leaves}: a new commit`);
    if (leaves === "a merge it left unresolved") assert.equal(ownHead, head, "the conflict markers are not committed");
  }
});

// ---- cancel and the run's end kill process groups ----

/** Whether any process whose command line holds `needle` is alive (`pgrep -f`). */
const running = (needle: string): boolean => {
  try {
    execFileSync("pgrep", ["-f", needle], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Poll until `until()` holds or `ms` pass; returns whether it held. */
async function within(ms: number, until: () => boolean): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (until()) return true;
  return until();
}

/** A stub agent that runs `sh -c "sleep <seconds>"` through `runProcess`, as every adapter child runs. */
function sleepingAgentConfig(seconds: number): RunConfig {
  const replay = join(tmp, "sleeper.mjs");
  const processModule = pathToFileURL(join(graphDir, "adapters", "process.ts")).href;
  writeFileSync(
    replay,
    [
      `import { runProcess } from ${JSON.stringify(processModule)};`,
      "export const replayAgent = () => ({",
      "  async run(req) {",
      `    await runProcess("sh", ["-c", "sleep ${seconds}"], { cwd: req.worktree, signal: req.signal });`,
      '    return { status: "done", files: {} };',
      "  },",
      "});",
    ].join("\n")
  );
  return parseRunConfig({ graph: "pipelines/build.ts", agent: { adapter: "stub", fixtureDir: tmp, replay }, check: { adapter: "stub", default: "pass" } }, graphDir).config;
}

test("a cancelled agent activity leaves no child of its command alive: the whole process group is killed, shell and sleep", async () => {
  // A number nothing else on the machine sleeps for, so pgrep sees only this test's child.
  const seconds = 600 + (process.pid % 300) + 1;
  const needle = `sleep ${seconds}`;
  const env = mockEnv();
  const pending = env.run(agentNode, agentTask(sleepingAgentConfig(seconds), place()));
  const settled = assert.rejects(pending);
  assert.ok(await within(5000, () => running(needle)), "the child started");
  env.cancel();
  await settled;
  assert.ok(await within(5000, () => !running(needle)), `\`${needle}\` is still alive after the cancel`);
  const a = attemptAt(join(tmp, "run"), "A-x", 1, "rerun-0/attempt-1.json");
  assert.equal(a.outcome, "aborted", "the attempt record says the cancel cut it short");
  assert.ok(a.endedAt !== undefined);
});

/** A `sleep <seconds>` in a process group of its own, as an agent CLI runs; resolves once started. */
async function sleepingGroup(seconds: number): Promise<number> {
  const child = spawn("sleep", [String(seconds)], { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
  return child.pid!;
}

const pgidRecord = (runDir: string, where: string, pid: number | null): void => {
  mkdirSync(join(runDir, "nodes", where), { recursive: true });
  writeFileSync(join(runDir, "nodes", where, "pgid.json"), JSON.stringify({ pid }));
};

test("recording the run kills every process group a nodes/**/pgid.json still names alive, in a node's or a fan-out item's folder", async () => {
  const runDir = join(tmp, "run");
  const top = await sleepingGroup(700 + (process.pid % 200));
  const item = await sleepingGroup(701 + (process.pid % 200));
  const bystander = await sleepingGroup(702 + (process.pid % 200));
  try {
    pgidRecord(runDir, join("A-builder", "1"), top);
    pgidRecord(runDir, join("A-builder", "2", "P1"), item);
    pgidRecord(runDir, join("A-fixer", "1"), null);
    const history = { runId: "r", graph: toy, phase: "cancelled", nodes: [], loops: [], asking: [], data: {} } as RunHistory;
    await recordRun({ runDir, history });
    assert.equal(groupAlive(top), false, "the node's group is gone");
    assert.equal(groupAlive(item), false, "the item's group is gone");
    assert.equal(groupAlive(bystander), true, "a group no record names, and a record cleared by its attempt, are left alone");
    assert.equal((JSON.parse(readFileSync(join(runDir, "history.json"), "utf8")) as RunHistory).phase, "cancelled");
    assert.ok(existsSync(join(runDir, "graph.mmd")));
  } finally {
    for (const pid of [top, item, bystander]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  }
});

test("recording the run past a pgid record it cannot read: the other groups are still killed, the history is still written and says which record, and a pgid.json in an output folder is no record", async () => {
  const runDir = join(tmp, "run");
  const live = await sleepingGroup(704 + (process.pid % 200));
  const inOutput = await sleepingGroup(705 + (process.pid % 200));
  try {
    mkdirSync(join(runDir, "nodes", "A-fixer", "1"), { recursive: true });
    writeFileSync(join(runDir, "nodes", "A-fixer", "1", "pgid.json"), "");
    pgidRecord(runDir, join("A-builder", "1"), live);
    pgidRecord(runDir, join("A-builder", "1", "out", "notes"), inOutput);
    pgidRecord(runDir, join("A-builder", "1", "out"), inOutput);
    const history = { runId: "r", graph: toy, phase: "cancelled", nodes: [], loops: [], asking: [], data: {} } as RunHistory;
    const missed = await mockEnv().run(recordRun, { runDir, history });
    assert.equal(groupAlive(live), false, "the readable record's group is killed");
    assert.equal(groupAlive(inOutput), true, "a pgid.json an agent wrote into its output folder is not a record");
    const written = JSON.parse(readFileSync(join(runDir, "history.json"), "utf8")) as RunHistory;
    assert.equal(written.phase, "cancelled");
    assert.match(written.error ?? "", /the process group sweep missed nodes\/A-fixer\/1\/pgid\.json: /);
    assert.equal(missed, written.error, "the workflow is handed the same text");
    assert.ok(existsSync(join(runDir, "graph.mmd")));
  } finally {
    for (const pid of [live, inOutput]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  }
});

test("recording the run whose nodes/ cannot be listed still writes the history, saying so after the error it had", async () => {
  const runDir = join(tmp, "run");
  mkdirSync(join(runDir, "nodes", "A-builder"), { recursive: true });
  chmodSync(join(runDir, "nodes", "A-builder"), 0o000);
  try {
    const history = { runId: "r", graph: toy, phase: "failed", nodes: [], loops: [], asking: [], data: {}, error: "the setup failed" } as RunHistory;
    await mockEnv().run(recordRun, { runDir, history });
    const written = JSON.parse(readFileSync(join(runDir, "history.json"), "utf8")) as RunHistory;
    assert.match(written.error ?? "", /^the setup failed; the process group sweep missed nodes\/ could not be listed: EACCES/);
  } finally {
    chmodSync(join(runDir, "nodes", "A-builder"), 0o755);
  }
});

test("recording a run whose pgid records name groups already gone, or that has no nodes folder at all, just writes the history", async () => {
  const runDir = join(tmp, "run");
  const gone = await sleepingGroup(703 + (process.pid % 200));
  process.kill(-gone, "SIGKILL");
  await within(3000, () => !groupAlive(gone));
  const history = { runId: "r", graph: toy, phase: "done", nodes: [], loops: [], asking: [], data: {} } as RunHistory;
  mkdirSync(runDir, { recursive: true });
  await recordRun({ runDir, history });
  assert.equal((JSON.parse(readFileSync(join(runDir, "history.json"), "utf8")) as RunHistory).phase, "done");
  pgidRecord(runDir, join("A-builder", "1"), gone);
  await recordRun({ runDir, history });
  assert.ok(existsSync(join(runDir, "history.json")));
});
