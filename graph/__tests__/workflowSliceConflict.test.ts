import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, type WorkflowBundle } from "@temporalio/worker";

import { EXIT_CHECKS } from "../../runtime/lib/fixFile.ts";
import { type DataItem, type GraphDef, type RunConfig, type RunHistory, type WorkflowInput, WORKFLOW_NAME } from "../contracts.ts";
import { defineGraph } from "../define.ts";
import { OPS } from "../pipelines/build/ops.ts";
import { CONFLICT_FILE, type SliceConflict } from "../pipelines/build/slices.ts";
import { graph as buildGraph } from "../pipelines/build.ts";
import { createWorker, WORKFLOWS_PATH } from "../worker.ts";
import { runAnswering } from "./helpers/operator.ts";

const quiet = new DefaultLogger((process.env.GRAPH_TEST_LOG as "WARN" | undefined) ?? "ERROR");
Runtime.install({ logger: quiet });
const MIN = 60_000;

function byId<T extends { id: string }>(list: readonly T[], id: string): T {
  const found = list.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`build graph has no ${id}`);
  return found;
}

const mergeSlice = byId(buildGraph.nodes, "D-merge-slice");
const mergeFix = byId(buildGraph.nodes, "D-merge-fix");

const data = (boundary: DataItem["boundary"], ids: readonly string[]): DataItem[] =>
  ids.map((id) => (boundary === undefined ? byId(buildGraph.data, id) : { ...byId(buildGraph.data, id), boundary }));

const graph: GraphDef = defineGraph<string, string>({
  id: "slice-conflict",
  data: [
    ...data("input", ["fix-slices", "slice-plan", "table", "brief", "repo-config"]),
    ...data(undefined, ["fix-commit", "slice-fix", "slice-conflict", "slices-ok"]),
    ...data("terminal", mergeFix.outputs),
  ],
  nodes: [
    {
      id: "A-fixer",
      kind: "agent",
      role: "fixer",
      inputs: ["table", "brief", "slice-plan"],
      outputs: ["fix-commit", "slice-fix"],
      writes: true,
      timeCapMs: MIN,
    },
    mergeSlice,
    mergeFix,
  ],
  loops: [],
  fanOuts: [{ id: "fix-slices", over: "fix-slices", nodes: ["A-fixer", "D-merge-slice"], status: "slices-ok" }],
  ops: {
    "merge-slice": buildGraph.ops!["merge-slice"]!,
    "merge-fix": buildGraph.ops!["merge-fix"]!,
  },
});

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let tmp: string;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const ancestorOf = (cwd: string, ancestor: string, descendant: string): boolean => {
  try {
    git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch {
    return false;
  }
};

function put(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function writePatch(repo: string, fixtureDir: string, slice: "S1" | "S2", file: string, content: string): void {
  git(repo, "switch", "-q", "-c", slice);
  writeFileSync(join(repo, file), content);
  writeFileSync(join(repo, "shared.test.ts"), `shared from ${slice}\n`);
  git(repo, "add", file, "shared.test.ts");
  git(repo, "commit", "-q", "-m", `${slice} fixes its row`);
  const patches = join(fixtureDir, "fixer", "fix-commit", `@${slice}`);
  mkdirSync(patches, { recursive: true });
  git(repo, "format-patch", "-q", "-1", "-o", patches);
  git(repo, "switch", "-q", "main");
  git(repo, "branch", "-q", "-D", slice);
}

function fixText(row: string, sha: string, what: string): string {
  return [`${row} · fixed · ${sha} — ${what}`, "", "exit checks:", ...EXIT_CHECKS.map((check) => `${check}: fixed`), ""].join("\n");
}

function inputFile(dir: string, name: string, content: string): string {
  return put(join(dir, name), content);
}

async function run(): Promise<{ history: RunHistory; repo: string; lines: Record<string, string> }> {
  const root = join(tmp, "case");
  const repo = join(root, "repo");
  const fixtures = join(root, "fixtures");
  const input = join(root, "input");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "a base\n");
  writeFileSync(join(repo, "b.ts"), "b base\n");
  writeFileSync(join(repo, "shared.test.ts"), "shared base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writePatch(repo, fixtures, "S1", "a.ts", "a from S1\n");
  writePatch(repo, fixtures, "S2", "b.ts", "b from S2\n");

  const fixFiles = {
    S1: fixText("FIX.1", "a11ce11", "updated a.ts"),
    S2: fixText("FIX.2", "b22ce22", "updated b.ts"),
  };
  const lines = {
    S1: fixFiles.S1.split("\n", 1)[0]!,
    S2: fixFiles.S2.split("\n", 1)[0]!,
  };
  inputFile(join(fixtures, "fixer", "slice-fix", "@S1"), "fix-1.txt", fixFiles.S1);
  inputFile(join(fixtures, "fixer", "slice-fix", "@S2"), "fix-1.txt", fixFiles.S2);

  const plan = {
    round: "1",
    slices: [
      { id: "S1", drafts: ["D1"], rows: ["FIX.1"], files: ["a.ts"], peers: [] },
      { id: "S2", drafts: ["D2"], rows: ["FIX.2"], files: ["b.ts"], peers: [] },
    ],
  };
  const table = {
    schema: 2,
    rounds: {
      "1": {
        head: base,
        rows: [
          { id: "FIX.1", also: [], kind: "behavior", locators: [], texts: [], origin: "reader", enteredAt: "1", history: [] },
          { id: "FIX.2", also: [], kind: "behavior", locators: [], texts: [], origin: "reader", enteredAt: "1", history: [] },
        ],
        leftovers: [],
        banked: [],
        closed: [],
        consumed: [],
        refused: [],
      },
    },
  };
  const state = { round: "1", rows: [{ id: "FIX.1", kind: "behavior" }, { id: "FIX.2", kind: "behavior" }], fixed: [], driftGroups: 0, session: [], claims: {}, stranded: [], answered: [], carriedDrift: [], seen: [] };
  const config = { tree: repo, stepsFile: "", steps: {}, notes: {}, briefsDir: null, baseRef: "main", thresholds: {} };
  const inputs: WorkflowInput["inputs"] = {
    "fix-slices": { schema: "items", items: [{ id: "S1", after: [] }, { id: "S2", after: [] }] },
    "slice-plan": { schema: "files", files: [inputFile(input, "slices.json", `${JSON.stringify(plan)}\n`)] },
    table: { schema: "files", files: [inputFile(input, "table.json", `${JSON.stringify(table)}\n`), inputFile(input, "state.json", `${JSON.stringify(state)}\n`)] },
    brief: {
      schema: "files",
      files: [
        inputFile(
          input,
          "brief.md",
          [
            "# Fix conflict",
            "class: R1 — test, 2026-10-24",
            "model: sonnet — exercise the merge-fix operation",
            "",
            "## Target files",
            "",
            "- a.ts",
            "- b.ts",
            "- shared.test.ts",
            "",
            "## Hand test",
            "",
            "none — the workflow test covers the merge outcome",
            "",
          ].join("\n")
        ),
      ],
    },
    "repo-config": { schema: "files", files: [inputFile(input, "repo-config.json", `${JSON.stringify(config)}\n`)] },
  };
  const runId = "slice-conflict";
  const configForRun: RunConfig = {
    pipeline: join(process.cwd(), "pipelines", "build", "pipeline.ts"),
    agent: { adapter: "stub", fixtureDir: fixtures },
    classifier: { adapter: "stub", answers: {}, default: { answer: "no", p: 0 } },
    check: { adapter: "pipeline" },
    tracker: { adapter: "file" },
    forge: { adapter: "file" },
    roles: {},
  };
  const workflowInput: WorkflowInput = { runId, repo, runDir: join(root, "run"), graph, inputs, config: configForRun };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: runId, workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: runId, workflowId: runId, args: [workflowInput] });
  return { history: await worker.runUntil(runAnswering(handle, [])), repo, lines };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "graph-slice-conflict-"));
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet });
});

after(async () => {
  await env?.teardown();
  rmSync(tmp, { recursive: true, force: true });
});

test("a conflicting fixer becomes a blocked row while the other slice reaches the fixed head", async () => {
  assert.ok(OPS["merge-slice"], "the build pipeline implements D-merge-slice");
  assert.equal(buildGraph.ops?.["merge-slice"]?.merges, true, "the build graph declares the writer merge operation");
  const { history, repo, lines } = await run();
  assert.equal(history.phase, "done");
  assert.deepEqual(history.nodes.filter((record) => record.status === "failed"), []);

  const conflictFiles = history.data["slice-conflict"];
  assert.equal(conflictFiles?.schema, "files");
  const conflicts = conflictFiles?.schema === "files"
    ? conflictFiles.files.filter((file) => basename(file) === CONFLICT_FILE).map((file) => JSON.parse(readFileSync(file, "utf8")) as SliceConflict)
    : [];
  assert.equal(conflicts.length, 2);
  const merged = conflicts.find((conflict) => conflict.unmerged === null);
  const blocked = conflicts.find((conflict) => conflict.unmerged !== null);
  assert.ok(merged, "one slice merged");
  assert.ok(blocked, "one slice reported the conflict");
  assert.deepEqual(blocked.unmerged, { cause: "conflict", paths: ["shared.test.ts"] });

  const fixedHead = history.data["fix-head"];
  assert.equal(fixedHead?.schema, "ref");
  if (fixedHead?.schema !== "ref") throw new Error("D-merge-fix wrote no fixed head");
  assert.equal(ancestorOf(repo, merged.commit, fixedHead.id), true, "the winning slice is in fix-head");
  assert.equal(ancestorOf(repo, blocked.commit, fixedHead.id), false, "the conflicting slice is not in fix-head");

  const fixFile = history.data["fix-file"];
  assert.equal(fixFile?.schema, "files");
  if (fixFile?.schema !== "files") throw new Error("D-merge-fix wrote no fix file");
  const fixPath = fixFile.files.find((file) => basename(file) === "fix-1.txt");
  if (fixPath === undefined) throw new Error("D-merge-fix wrote no fix-1.txt");
  const text = readFileSync(fixPath, "utf8");
  const mergedLine = lines[merged.slice];
  if (mergedLine === undefined) throw new Error(`missing expected fixer line for ${merged.slice}`);
  assert.ok(text.includes(mergedLine), "the merged slice keeps the fixer line it wrote");
  assert.match(text, new RegExp(`${blocked.slice === "S1" ? "FIX\\.1" : "FIX\\.2"} · blocked — merging slice ${blocked.slice}'s commit ${blocked.commit} conflicted on shared\\.test\\.ts with a slice merged before it; its fix is not in the run tree`));
  for (const check of EXIT_CHECKS) assert.match(text, new RegExp(`${check}: .*${blocked.slice} — none — slice ${blocked.slice}'s commit did not merge`));
});
