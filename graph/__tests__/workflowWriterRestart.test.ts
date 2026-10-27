import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, type WorkflowBundle } from "@temporalio/worker";

import { type AttemptRecord, type DataItem, type DataValues, type GraphDef, parseAttemptRecord, type RunConfig, type RunHistory, WORKFLOW_NAME, type WorkflowInput } from "../contracts.ts";
import { defineGraph } from "../define.ts";
import { renderRecord, runRecord } from "../mock/record.ts";
import { graph as buildGraph } from "../pipelines/build.ts";
import { readRunDir } from "../runDirs.ts";
import { statsReport } from "../stats.ts";
import { createWorker, WORKFLOWS_PATH } from "../worker.ts";
import { runAnswering } from "./helpers/operator.ts";

const quiet = new DefaultLogger((process.env.GRAPH_TEST_LOG as "WARN" | undefined) ?? "ERROR");
Runtime.install({ logger: quiet });
const MIN = 60_000;
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "engine", "pipeline.ts");

function byId<T extends { id: string }>(list: readonly T[], id: string): T {
  const found = list.find((item) => item.id === id);
  if (found === undefined) throw new Error(`build graph has no ${id}`);
  return found;
}

const builder = byId(buildGraph.nodes, "A-builder");
const mergePart = byId(buildGraph.nodes, "D-merge-part");
const testWriter = byId(buildGraph.nodes, "A-write-tests");
const mergeTests = byId(buildGraph.nodes, "D-merge-tests");
const outputFormat = byId(buildGraph.nodes, "K-output-format");

const data = (ids: readonly string[]): DataItem[] => ids.map((id) => ({ ...byId(buildGraph.data, id) }));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function recordPatch(repo: string, fixtureDir: string, role: string, output: string, key: string): void {
  const dir = join(fixtureDir, role, output, `@${key}`);
  mkdirSync(dir, { recursive: true });
  git(repo, "format-patch", "-q", "-1", "-o", dir);
}

function partsBrief(): string {
  return [
    "# Writer restart",
    "",
    "class: R1 — test",
    "model: sonnet",
    "",
    "## Target files",
    "",
    "- a.ts",
    "- b.ts",
    "- tests/a.test.ts",
    "- tests/b.test.ts",
    "- tests/helpers/**",
    "",
    "## Deliverables",
    "",
    "- a",
    "- b",
    "",
    "## Parts",
    "",
    "- P1 · builds a",
    "  - model: sonnet",
    "  - files: a.ts",
    "  - test files: none",
    "  - deliverables: 1",
    "  - after: none",
    "  - tests: none",
    "",
    "- P2 · builds b",
    "  - model: sonnet",
    "  - files: b.ts",
    "  - test files: none",
    "  - deliverables: 2",
    "  - after: none",
    "  - tests: none",
    "",
    "## Hand test",
    "",
    "none — the graph fixture exercises restart behavior",
    "",
  ].join("\n");
}

function writerGraph(): GraphDef {
  return defineGraph({
    id: "writer-restart-parts",
    data: [
      { ...byId(buildGraph.data, "brief"), boundary: "input" },
      { id: "brief-parts", schema: "items", boundary: "input" },
      { ...byId(buildGraph.data, "brief-commit"), boundary: "input" },
      { ...byId(buildGraph.data, "repo-config"), boundary: "input" },
      { ...byId(buildGraph.data, "prior-art"), boundary: "input" },
      { ...byId(buildGraph.data, "stack-bindings"), boundary: "input" },
      ...data(["part-commit"]),
      ...data(["builder-report", "part-head", "parts-ok"]).map((item) => ({ ...item, boundary: "terminal" as const })),
      { id: "output-format", schema: "check" },
    ],
    nodes: [builder, mergePart, outputFormat],
    loops: [],
    fanOuts: [{ id: "parts", over: "brief-parts", nodes: [builder.id, mergePart.id], status: "parts-ok" }],
    services: { schema: "K-output-format" },
  });
}

interface WriterRun {
  history: RunHistory;
  runDir: string;
  tree: string;
}

/** Run `graph` on `inputs` with stub agents reading `fixtures` (a sibling of the run's `repo`), through the build pipeline's checks. */
async function startRun(runId: string, graph: GraphDef, inputs: DataValues, fixtures: string): Promise<WriterRun> {
  const root = dirname(fixtures);
  const runDir = join(root, "run");
  const config: RunConfig = {
    pipeline: join(process.cwd(), "pipelines", "build", "pipeline.ts"),
    agent: { adapter: "stub", fixtureDir: fixtures },
    classifier: { adapter: "stub", answers: {}, default: { answer: "no", p: 0 } },
    check: { adapter: "pipeline" },
    tracker: { adapter: "file" },
    forge: { adapter: "file" },
    roles: {},
  };
  const workflow: WorkflowInput = { runId, repo: join(root, "repo"), runDir, graph, inputs, config };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: runId, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: runId, workflowId: runId, args: [workflow] });
  const history = await worker.runUntil(runAnswering(handle, []));
  return { history, runDir, tree: join(runDir, "worktree") };
}

/** The brief's inputs a writer's lane check reads, written under `root`. */
function briefInputs(root: string, repo: string, brief: string, base: string): DataValues {
  const configFile = put(join(root, "input", "repo-config.json"), JSON.stringify({ tree: repo, stepsFile: "", steps: {}, notes: {}, briefsDir: null, baseRef: "main", thresholds: {} }));
  return {
    brief: { schema: "files", files: [put(join(root, "input", "brief.md"), brief)] },
    "brief-commit": { schema: "ref", kind: "commit", id: base },
    "repo-config": { schema: "files", files: [configFile] },
    "prior-art": { schema: "files", files: [put(join(root, "input", "prior-art.md"), "reuse: none\n")] },
    "stack-bindings": { schema: "files", files: [put(join(root, "input", "stack-bindings.json"), "{}\n")] },
  };
}

/**
 * What a part's fresh run does: `resolves` brings its commit onto the other part's and keeps both
 * edits of `shared.ts`; `nothing` commits nothing at all; `stale` re-applies its first run's patch,
 * which does not apply on the other part's edit.
 */
type Restart = "resolves" | "nothing" | "stale";

/** Two parts side by side whose builders edit the same line of `shared.ts`, a file no part lists; a
 *  part's fresh run `n` does what `restarts[n - 1]` says. */
async function runWriters(runId: string, restarts: readonly Restart[]): Promise<WriterRun> {
  const root = join(tmp, runId);
  const repo = join(root, "repo");
  const fixtures = join(root, "fixtures");
  mkdirSync(repo, { recursive: true });
  put(join(repo, "a.ts"), "a base\n");
  put(join(repo, "b.ts"), "b base\n");
  put(join(repo, "shared.ts"), "shared: base\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  const role = "builder";
  const output = "part-commit";
  const report = "builder-report";
  const own = (id: string) => (id === "P1" ? "a.ts" : "b.ts");
  const shared = "shared.ts";
  const ids = ["P1", "P2"] as const;
  for (const id of ids) {
    git(repo, "switch", "-q", "-c", id);
    writeFileSync(join(repo, own(id)), `${id} initial\n`);
    writeFileSync(join(repo, shared), `shared: ${id}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `${id} initial`);
    recordPatch(repo, fixtures, role, output, id);
    put(join(fixtures, role, report, `@${id}`, "report.md"), `${id} report\n`);
    git(repo, "switch", "-q", "main");
  }

  restarts.forEach((does, i) => {
    const n = i + 1;
    for (const [id, other] of [[ids[0], ids[1]], [ids[1], ids[0]]] as const) {
      const key = `${id}@restart-${n}`;
      put(join(fixtures, role, report, `@${key}`, "report.md"), `${id} restart ${n} report\n`);
      if (does === "nothing") {
        mkdirSync(join(fixtures, role, output, `@${key}`), { recursive: true });
        continue;
      }
      git(repo, "switch", "-q", "-c", `${id}-restart-${n}`, does === "stale" ? id : other);
      if (does === "resolves") {
        writeFileSync(join(repo, own(id)), `${id} initial\n`);
        writeFileSync(join(repo, shared), "shared: both\n");
        git(repo, "add", own(id), shared);
        git(repo, "commit", "-q", "-m", `${id} resolves shared`);
      }
      recordPatch(repo, fixtures, role, output, key);
      git(repo, "switch", "-q", "main");
    }
  });
  const inputs: DataValues = { ...briefInputs(root, repo, partsBrief(), base), "brief-parts": { schema: "items", items: ids.map((id) => ({ id, after: [] })) } };
  return startRun(runId, writerGraph(), inputs, fixtures);
}

function mixedBrief(): string {
  return [
    "# Builder and test writer restart",
    "",
    "class: R1 — test",
    "model: sonnet",
    "",
    "## Target files",
    "",
    "- a.ts",
    "- tests/a.test.ts",
    "- tests/helpers/shared.ts",
    "",
    "## Deliverables",
    "",
    "- build a",
    "- test a",
    "",
    "## Test slices",
    "",
    "- W1 · plain · tests a",
    "  - files: tests/a.test.ts, tests/helpers/shared.ts",
    "  - covers: 2",
    "  - under test: a",
    "",
    "## Parts",
    "",
    "- P1 · builds a",
    "  - model: sonnet",
    "  - files: a.ts",
    "  - test files: none",
    "  - deliverables: 1, 2",
    "  - after: none",
    "  - tests: W1",
    "",
    "## Hand test",
    "",
    "none — the graph fixture exercises restart behavior",
    "",
  ].join("\n");
}

function mixedWriterGraph(): GraphDef {
  return defineGraph({
    id: "builder-test-writer-restart",
    data: [
      { ...byId(buildGraph.data, "brief"), boundary: "input" },
      { id: "brief-parts", schema: "items", boundary: "input" },
      { id: "brief-slices", schema: "items", boundary: "input" },
      { ...byId(buildGraph.data, "brief-commit"), boundary: "input" },
      { ...byId(buildGraph.data, "repo-config"), boundary: "input" },
      { ...byId(buildGraph.data, "prior-art"), boundary: "input" },
      { ...byId(buildGraph.data, "stack-bindings"), boundary: "input" },
      ...data(["part-commit", "tests-commit"]),
      ...data(["builder-report", "part-head", "parts-ok", "tests-authored", "tests-head", "tests-ok"])
        .map((item) => ({ ...item, boundary: "terminal" as const })),
      { id: "output-format", schema: "check" },
    ],
    nodes: [builder, mergePart, testWriter, mergeTests, outputFormat],
    loops: [],
    fanOuts: [
      { id: "parts", over: "brief-parts", nodes: [builder.id, mergePart.id], status: "parts-ok" },
      { id: "write-tests", over: "brief-slices", nodes: [testWriter.id, mergeTests.id], status: "tests-ok" },
    ],
    services: { schema: "K-output-format" },
  });
}

async function runMixedWriters(): Promise<WriterRun> {
  const root = join(tmp, "builder-test-writer");
  const repo = join(root, "repo");
  const fixtures = join(root, "fixtures");
  mkdirSync(repo, { recursive: true });
  put(join(repo, "a.ts"), "a base\n");
  put(join(repo, "tests/helpers/shared.ts"), "shared: base\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-q", "-c", "P1");
  put(join(repo, "a.ts"), "P1 initial\n");
  put(join(repo, "tests/helpers/shared.ts"), "shared: P1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "P1 initial");
  recordPatch(repo, fixtures, "builder", "part-commit", "P1");
  put(join(fixtures, "builder", "builder-report", "@P1", "report.md"), "P1 report\n");
  git(repo, "switch", "-q", "main");

  git(repo, "switch", "-q", "-c", "W1");
  put(join(repo, "tests/a.test.ts"), "W1 initial\n");
  put(join(repo, "tests/helpers/shared.ts"), "shared: W1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "W1 initial");
  recordPatch(repo, fixtures, "write-tests", "tests-commit", "W1");
  put(join(fixtures, "write-tests", "tests-authored", "@W1", "tests-authored.md"), "W1 tests\n");
  git(repo, "switch", "-q", "main");

  git(repo, "switch", "-q", "-c", "P1-restart", "W1");
  put(join(repo, "a.ts"), "P1 initial\n");
  put(join(repo, "tests/helpers/shared.ts"), "shared: both\n");
  git(repo, "add", "a.ts", "tests/helpers/shared.ts");
  git(repo, "commit", "-q", "-m", "P1 resolves shared");
  recordPatch(repo, fixtures, "builder", "part-commit", "P1@restart-1");
  put(join(fixtures, "builder", "builder-report", "@P1@restart-1", "report.md"), "P1 restart report\n");
  git(repo, "switch", "-q", "main");

  git(repo, "switch", "-q", "-c", "W1-restart", "P1");
  put(join(repo, "tests/a.test.ts"), "W1 initial\n");
  put(join(repo, "tests/helpers/shared.ts"), "shared: both\n");
  git(repo, "add", "tests/a.test.ts", "tests/helpers/shared.ts");
  git(repo, "commit", "-q", "-m", "W1 resolves shared");
  recordPatch(repo, fixtures, "write-tests", "tests-commit", "W1@restart-1");
  put(join(fixtures, "write-tests", "tests-authored", "@W1@restart-1", "tests-authored.md"), "W1 restart tests\n");
  git(repo, "switch", "-q", "main");

  const inputs: DataValues = {
    ...briefInputs(root, repo, mixedBrief(), base),
    "brief-parts": { schema: "items", items: [{ id: "P1", after: [] }] },
    "brief-slices": { schema: "items", items: [{ id: "W1", after: [] }] },
  };
  return startRun("builder-test-writer", mixedWriterGraph(), inputs, fixtures);
}

/** A fan-out item's writer and the merge node that merges its commit. */
interface Candidate {
  writer: string;
  merger: string;
  item: string;
}

/** An attempt record the workflow wrote, read through the parser `stats` reads it with. */
const attemptOf = (run: Pick<WriterRun, "runDir">, node: string, item: string, rerun: number): AttemptRecord | undefined => {
  const file = join(run.runDir, "nodes", node, "0", item, `rerun-${rerun}`, "attempt-1.json");
  return existsSync(file) ? parseAttemptRecord(JSON.parse(readFileSync(file, "utf8")), file) : undefined;
};

/** The restarts `build-graph stats` counts over the run dir: the run's, and `node`'s. */
function statsRestarts(runDir: string, node: string): { run: number | undefined; node: number | undefined; problems: string[] } {
  const report = statsReport([readRunDir(runDir)]);
  return { run: report.runs[0]?.restarts, node: report.nodes.find((n) => n.node === node)?.restarts, problems: report.problems };
}

/** The candidates whose first merge conflicted. */
const conflicted = (run: WriterRun, candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter(({ merger, item }) => attemptOf(run, merger, item, 0)?.outcome === "merge-conflict");

/**
 * The run ended done with no node failed, every candidate's merge done and `shared` holding both
 * writers' edits; exactly one candidate's first merge conflicted, its writer finished each of its
 * `restarts` fresh runs, its merge conflicted again after each but the last and landed on the last,
 * and the schema check passed its writer. Returns that candidate.
 */
function assertRestarted(run: WriterRun, candidates: readonly Candidate[], shared: string, restarts = 1): Candidate {
  assert.equal(run.history.phase, "done");
  assert.deepEqual(run.history.nodes.filter((node) => node.status === "failed"), []);
  for (const { merger, item } of candidates) assert.equal(run.history.nodes.find((n) => n.node === merger && n.instance === item)?.status, "done");
  assert.equal(readFileSync(join(run.tree, shared), "utf8"), "shared: both\n");
  const restarted = conflicted(run, candidates);
  assert.equal(restarted.length, 1, "exactly one merge loses the race for the shared file");
  const one = restarted[0]!;
  const history = JSON.parse(readFileSync(join(run.runDir, "history.json"), "utf8")) as RunHistory;
  const historyNode = (node: string, item: string) => history.nodes.find((r) => r.node === node && r.instance === item);
  assert.equal(historyNode(one.writer, one.item)?.status, "done", "the restarted writer ends done in persisted history");
  assert.deepEqual(historyNode(one.writer, one.item)?.restarts, restarts, "the restarted writer's persisted history says how many fresh runs it needed");
  assert.equal(historyNode(one.merger, one.item)?.status, "done", "the merge node ends done in persisted history");
  assert.equal(historyNode(one.merger, one.item)?.restarts, undefined, "the merge node itself did not restart");
  for (let n = 1; n <= restarts; n++) {
    assert.equal(attemptOf(run, one.writer, one.item, n)?.outcome, "done", `${one.writer} fresh run ${n}`);
    assert.equal(attemptOf(run, one.merger, one.item, n)?.outcome, n === restarts ? "done" : "merge-conflict", `${one.merger} merge ${n}`);
    const merge = attemptOf(run, one.merger, one.item, n - 1);
    const commit = merge?.conflict?.commit;
    assert.equal(typeof commit, "string", `${one.merger} merge ${n - 1} records its conflicted commit`);
    assert.deepEqual(merge?.conflict, { commit, paths: [shared] }, `${one.merger} merge ${n - 1} records only the merge conflict`);
    assert.deepEqual(attemptOf(run, one.writer, one.item, n)?.conflict, { commit, paths: [shared], restart: n }, `${one.writer} fresh run ${n} receives that conflict and its restart number`);
  }
  assert.equal(attemptOf(run, one.merger, one.item, restarts + 1), undefined);
  assert.deepEqual(statsRestarts(run.runDir, one.writer), { run: restarts, node: restarts, problems: [] }, "stats counts the writer's fresh runs from the records the workflow wrote");
  assert.equal(run.history.nodes.find((node) => node.node === "K-output-format" && node.instance === `${one.writer}@${one.item}`)?.status, "done");
  const writerLine = renderRecord(runRecord(history.graph, history)).split("\n").find((line) => line.startsWith(`| ${one.writer} |`));
  assert.ok(writerLine?.includes(`-@${one.item} done (${restarts} restart${restarts === 1 ? "" : "s"})`), "the mock record renders the writer's restart count");
  for (const candidate of candidates.filter((candidate) => candidate !== one)) {
    assert.equal(historyNode(candidate.writer, candidate.item)?.restarts, undefined, `${candidate.writer}@${candidate.item} never restarted`);
    assert.equal(historyNode(candidate.merger, candidate.item)?.restarts, undefined, `${candidate.merger}@${candidate.item} never restarted`);
    assert.equal(attemptOf(run, candidate.writer, candidate.item, 0)?.conflict, undefined, `${candidate.writer}@${candidate.item}'s original attempt has no conflict`);
    assert.equal(attemptOf(run, candidate.merger, candidate.item, 0)?.conflict, undefined, `${candidate.merger}@${candidate.item}'s merge has no conflict`);
  }
  return one;
}

const parts: Candidate[] = [
  { writer: "A-builder", merger: "D-merge-part", item: "P1" },
  { writer: "A-builder", merger: "D-merge-part", item: "P2" },
];

const partsOk = (run: WriterRun): string | undefined => {
  const v = run.history.data["parts-ok"];
  return v?.schema === "check" ? v.answer : undefined;
};

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let tmp: string;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "graph-writer-restart-"));
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet });
});

after(async () => {
  await env?.teardown();
  rmSync(tmp, { recursive: true, force: true });
});

test("two builders touching an unlisted file restart one writer on the new head", async () => {
  const run = await runWriters("writer-parts", ["resolves"]);
  assertRestarted(run, parts, "shared.ts");
  for (const path of ["a.ts", "b.ts"]) assert.match(readFileSync(join(run.tree, path), "utf8"), /initial/);
  const reports = run.history.data["builder-report"];
  assert.equal(reports?.schema === "files" ? reports.files.filter((file) => file.endsWith("report.md")).length : 0, 2);
});

test("a builder and test writer restart exactly one writer after colliding on a slice helper", async () => {
  // Test slices are exclusive, so only a builder and its test writer can collide on this slice-owned helper.
  const run = await runMixedWriters();
  const candidates: Candidate[] = [
    { writer: "A-builder", merger: "D-merge-part", item: "P1" },
    { writer: "A-write-tests", merger: "D-merge-tests", item: "W1" },
  ];
  assertRestarted(run, candidates, "tests/helpers/shared.ts");
  assert.equal(readFileSync(join(run.tree, "a.ts"), "utf8"), "P1 initial\n");
  assert.equal(readFileSync(join(run.tree, "tests/a.test.ts"), "utf8"), "W1 initial\n");
});

test("a fresh run that commits nothing hands its merge the conflicted commit again, which counts against the cap, and the next fresh run lands", async () => {
  const run = await runWriters("writer-nothing-then-resolves", ["nothing", "resolves"]);
  assertRestarted(run, parts, "shared.ts", 2);
  for (const path of ["a.ts", "b.ts"]) assert.match(readFileSync(join(run.tree, path), "utf8"), /initial/);
});

test("a writer whose every fresh run commits nothing fails its merge node at the cap, naming the paths and its lost commit, and the run fails", async () => {
  const run = await runWriters("writer-cap", ["nothing", "nothing"]);
  assert.equal(run.history.phase, "failed");
  const lost = conflicted(run, parts);
  assert.equal(lost.length, 1, "one merge conflicts");
  const [one] = lost as [Candidate];
  const kept = parts.find((p) => p.item !== one.item)!;
  assert.equal(run.history.nodes.find((n) => n.node === kept.merger && n.instance === kept.item)?.status, "done");
  const merge = run.history.nodes.find((n) => n.node === one.merger && n.instance === one.item);
  assert.equal(merge?.status, "failed");
  const named = /^merging ([0-9a-f]{9}) into the run tree conflicted on shared\.ts; A-builder had its 2 fresh runs for it \(WRITER_RESTART_CAP\) and the last still conflicts$/.exec(merge?.reason ?? "");
  assert.ok(named, `the cap's reason: ${merge?.reason}`);
  const firstCommit = git(run.tree, "rev-parse", named[1]!);
  assert.equal(git(run.tree, "show", `${firstCommit}:shared.ts`), `shared: ${one.item}`, "the reason names the item's own first commit");
  for (const n of [0, 1, 2]) assert.equal(attemptOf(run, one.merger, one.item, n)?.outcome, "merge-conflict", `merge ${n}`);
  for (const n of [1, 2]) assert.equal(attemptOf(run, one.writer, one.item, n)?.outcome, "done", `fresh run ${n}`);
  assert.equal(run.history.nodes.find((node) => node.node === one.writer && node.instance === one.item)?.restarts, 2, "the capped writer records both fresh runs");
  assert.deepEqual(statsRestarts(run.runDir, one.writer), { run: 2, node: 2, problems: [] }, "stats counts both fresh runs");
  assert.equal(attemptOf(run, one.merger, one.item, 2)?.conflict?.commit, firstCommit, "the cap's final merge record keeps the full sha named in its reason");
  assert.equal(attemptOf(run, one.writer, one.item, 3), undefined, "no third fresh run");
  assert.equal(readFileSync(join(run.tree, "shared.ts"), "utf8"), `shared: ${kept.item}\n`);
  assert.equal(partsOk(run), "fail");
});

test("a writer whose fresh run fails leaves its merge node skipped and its item down, and the run fails", async () => {
  const run = await runWriters("writer-stale", ["stale"]);
  assert.equal(run.history.phase, "failed");
  const lost = conflicted(run, parts);
  assert.equal(lost.length, 1, "one merge conflicts");
  const [one] = lost as [Candidate];
  assert.equal(run.history.nodes.find((n) => n.node === one.writer && n.instance === one.item)?.status, "failed");
  assert.equal(attemptOf(run, one.writer, one.item, 1)?.outcome, "failed");
  const merge = run.history.nodes.find((n) => n.node === one.merger && n.instance === one.item);
  assert.equal(merge?.status, "skipped");
  assert.equal(merge?.reason, "A-builder did not finish its run on the new head");
  assert.equal(attemptOf(run, one.merger, one.item, 1), undefined, "the merge does not run again");
  assert.deepEqual(statsRestarts(run.runDir, one.writer), { run: 1, node: 1, problems: [] }, "stats counts the fresh run that failed");
  assert.equal(partsOk(run), "fail");
});

test("a merge-back whose conflicted commit no node of its scope wrote fails, naming the paths, and runs nothing again", async () => {
  const root = join(tmp, "outside");
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  put(join(repo, "README.md"), "base\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "switch", "-q", "-c", "side");
  put(join(repo, "README.md"), "side\n");
  git(repo, "commit", "-q", "-am", "side");
  const side = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "main");
  put(join(repo, "README.md"), "main\n");
  git(repo, "commit", "-q", "-am", "main");
  const graph = defineGraph({
    id: "merge-outside",
    data: [
      { id: "outside-commit", schema: "ref", boundary: "input" },
      { id: "merged", schema: "ref", boundary: "terminal" },
    ],
    nodes: [{ id: "D-merge", kind: "data", role: "merge-back", inputs: ["outside-commit"], outputs: ["merged"], timeCapMs: MIN }],
    loops: [],
  });
  const run = await startRun("merge-outside", graph, { "outside-commit": { schema: "ref", kind: "commit", id: side } }, join(root, "fixtures"));
  assert.equal(run.history.phase, "failed");
  const merge = run.history.nodes.find((n) => n.node === "D-merge");
  assert.equal(merge?.status, "failed");
  assert.equal(merge?.reason, `merging ${side.slice(0, 9)} into the run tree conflicted on README.md, and no node of this scope wrote the commit`);
  assert.equal(readFileSync(join(run.tree, "README.md"), "utf8"), "main\n");
  assert.equal(existsSync(join(run.runDir, "nodes", "D-merge", "0", "rerun-0", "attempt-1.json")), true);
  assert.equal(existsSync(join(run.runDir, "nodes", "D-merge", "0", "rerun-1")), false);
});

/**
 * What the amender does on a fresh run: `resolves` merges the conflict it is handed and commits;
 * `nothing` commits nothing, so the merge conflicts again until the cap. `dirty-first` and
 * `dirty-fresh` leave an uncommitted README.md in the run tree on the first pass or on the fresh run,
 * so that pass's merge throws instead of conflicting.
 */
type AmendMode = "resolves" | "nothing" | "dirty-first" | "dirty-fresh";

interface AmendRun {
  history: RunHistory;
  persisted: RunHistory;
  runDir: string;
  dispatch: string;
  firstCommit: string;
}

/** An asker's answer changes the brief, and the amend service's first commit meets a commit that
 *  landed in the run tree meanwhile on README.md (`dirty-first`: the uncommitted edit in its place). */
async function runAmend(name: string, mode: AmendMode): Promise<AmendRun> {
  const root = join(tmp, name);
  const repo = join(root, "repo");
  const fixtures = join(root, "fixtures");
  const dispatch = join(root, "dispatch.json");
  const firstCommit = join(root, "first-commit.txt");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  put(join(fixtures, "briefer", "brief", "brief.md"), "v1 brief\n");
  put(join(fixtures, "resolver", "answer", "answer.json"), JSON.stringify({ answer: "use v2", source: "brief", searched: [{ source: "brief", said: "v1" }], brief_change: "say v2" }));
  const replay = join(root, "amender.mjs");
  writeFileSync(
    replay,
    [
      'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'import { execFileSync } from "node:child_process";',
      `const dispatch = ${JSON.stringify(dispatch)};`,
      `const firstCommit = ${JSON.stringify(firstCommit)};`,
      `const mode = ${JSON.stringify(mode)};`,
      'const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });',
      'export const replayAgent = () => ({ async run(req) {',
      '  const brief = join(req.outDir, "brief-amended", "brief.md");',
      '  mkdirSync(dirname(brief), { recursive: true });',
      '  writeFileSync(brief, "v2 brief\\n");',
      '  const tree = join(req.outDir, "..", "..", "..", "..", "..", "worktree");',
      '  if (req.conflict === undefined) {',
      '    writeFileSync(join(req.worktree, "README.md"), "amender\\n");',
      '    git(req.worktree, "add", "README.md");',
      '    git(req.worktree, "commit", "-qm", "amender first pass");',
      '    writeFileSync(firstCommit, git(req.worktree, "rev-parse", "HEAD").trim());',
      '    writeFileSync(join(tree, "README.md"), "run tree\\n");',
      '    if (mode !== "dirty-first") {',
      '      git(tree, "add", "README.md");',
      '      git(tree, "commit", "-qm", "another merge lands");',
      '    }',
      '  } else {',
      '    appendFileSync(dispatch, JSON.stringify(req.conflict) + "\\n");',
      '    if (mode === "nothing") return { status: "done", files: { "brief-amended": [brief] } };',
      '    let merged = true;',
      '    try { git(req.worktree, "merge", "--no-edit", req.conflict.commit); } catch { merged = false; }',
      '    const unmerged = git(req.worktree, "diff", "--name-only", "--diff-filter=U").trim();',
      '    if (merged || unmerged !== "README.md") throw new Error(`merging ${req.conflict.commit} did not conflict on README.md (unmerged: ${unmerged || "none"})`);',
      '    writeFileSync(join(req.worktree, "README.md"), "both\\n");',
      '    git(req.worktree, "add", "README.md");',
      '    git(req.worktree, "commit", "-qm", "resolve amend conflict");',
      '    if (mode === "dirty-fresh") writeFileSync(join(tree, "README.md"), "uncommitted\\n");',
      '  }',
      '  return { status: "done", files: { "brief-amended": [brief] } };',
      '} });',
      '',
    ].join("\n")
  );
  const graph = defineGraph({
    id: "amend-restart",
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
    loops: [],
    services: { route: "K-route-question", resolver: "A-answer-question", amend: "A-amend" },
    amended: { output: "brief-amended", replaces: "brief", reparse: "K-parse" },
  });
  const runDir = join(root, "run");
  const config: RunConfig = {
    pipeline: ENGINE,
    agent: { adapter: "stub", fixtureDir: fixtures },
    classifier: { adapter: "stub", answers: {}, default: { answer: "no", p: 0 } },
    check: { adapter: "pipeline" },
    tracker: { adapter: "file" },
    forge: { adapter: "file" },
    roles: { amender: { agent: { adapter: "stub", fixtureDir: fixtures, replay } } },
  };
  const workflow: WorkflowInput = { runId: name, repo, runDir, graph, inputs: { request: { schema: "text", text: "go" } }, config };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: workflow.runId, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: workflow.runId, workflowId: workflow.runId, args: [workflow] });
  const history = await worker.runUntil(runAnswering(handle, ["approve"]));
  const persisted = JSON.parse(readFileSync(join(runDir, "history.json"), "utf8")) as RunHistory;
  return { history, persisted, runDir, dispatch, firstCommit: readFileSync(firstCommit, "utf8") };
}

const amendRow = (run: AmendRun) => run.persisted.nodes.find((node) => node.node === "A-amend");

/** The run failed with its amend: the amend's persisted row is `failed` for `reason` with `restarts`
 *  (absent when undefined), and the asker failed with it. */
function assertAmendFailed(run: AmendRun, reason: RegExp, restarts: number | undefined): void {
  assert.equal(run.history.phase, "failed");
  const row = amendRow(run);
  assert.equal(row?.status, "failed");
  assert.match(row?.reason ?? "", reason);
  assert.equal(row?.restarts, restarts, "the failed amend's row says how many fresh runs it had");
  assert.equal(row !== undefined && "restarts" in row, restarts !== undefined, "a failed amend with no fresh run carries no restarts");
  const asker = run.persisted.nodes.find((node) => node.node === "K-ask");
  assert.equal(asker?.status, "failed");
  assert.match(asker?.reason ?? "", /^the amend for Q1 failed: /);
}

test("an amended brief retries the amender with the merge conflict it must resolve", async () => {
  const run = await runAmend("amend-restart", "resolves");
  const { history, runDir } = run;
  assert.equal(history.phase, "done");
  assert.deepEqual(history.nodes.filter((node) => node.status === "failed"), []);
  assert.equal(history.data.after?.schema === "check" ? history.data.after.detail : undefined, "brief v2 brief; head v2 brief");
  assert.equal(readFileSync(join(runDir, "worktree", "README.md"), "utf8"), "both\n");
  const [conflict] = readFileSync(run.dispatch, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { commit: string; paths: string[]; restart: number });
  assert.ok(conflict, "the restarted amender receives the merge conflict");
  assert.equal(conflict.commit, run.firstCommit, "the conflict names the amender's own first commit");
  assert.deepEqual(conflict.paths, ["README.md"]);
  assert.equal(conflict.restart, 1);
  for (const rerun of [0, 1]) assert.equal(attemptOf(run, "A-amend", "K-ask_Q1", rerun)?.outcome, "done");
  assert.equal(amendRow(run)?.status, "done", "the amender ends done in persisted history");
  assert.equal(amendRow(run)?.restarts, 1, "the amender's persisted history records its fresh run");
  assert.equal(attemptOf(run, "A-amend", "K-ask_Q1", 0)?.conflict, undefined, "the original amend attempt had no conflict");
  assert.deepEqual(attemptOf(run, "A-amend", "K-ask_Q1", 1)?.conflict, { commit: run.firstCommit, paths: ["README.md"], restart: 1 }, "the fresh amend attempt records the conflict it resolved");
  assert.deepEqual(statsRestarts(runDir, "A-amend"), { run: 1, node: 1, problems: [] }, "stats counts the amender's fresh run");
});

test("an amend whose fresh runs commit nothing fails at the cap, its failed row keeping both fresh runs", async () => {
  const run = await runAmend("amend-cap", "nothing");
  assertAmendFailed(run, /^merging [0-9a-f]{9} into the run tree conflicted on README\.md; A-amend had its 2 fresh runs for it \(WRITER_RESTART_CAP\) and the last still conflicts$/, 2);
  assert.equal(readFileSync(run.dispatch, "utf8").trim().split("\n").length, 2, "two fresh runs");
  assert.deepEqual(statsRestarts(run.runDir, "A-amend"), { run: 2, node: 2, problems: [] });
});

test("an amend whose merge throws after a fresh run fails, its failed row keeping that fresh run", async () => {
  const run = await runAmend("amend-throws-fresh", "dirty-fresh");
  assertAmendFailed(run, /^merge: /, 1);
  assert.deepEqual(statsRestarts(run.runDir, "A-amend"), { run: 1, node: 1, problems: [] });
});

test("an amend whose first merge throws fails with no restarts on its row", async () => {
  const run = await runAmend("amend-throws-first", "dirty-first");
  assertAmendFailed(run, /^merge: /, undefined);
  assert.equal(existsSync(run.dispatch), false, "no fresh run");
});
