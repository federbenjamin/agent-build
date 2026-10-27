/**
 * The toy graph through Temporal with the real Claude, Jev and shell adapters, their outside
 * boundaries faked: a `claude` script on PATH, a local HTTP server standing in for the TypeSafe API,
 * and a build-steps file in the run's repo. It proves the wiring the unit tests cannot: the bindings
 * reach the adapters from a config file's shape, and a hung `claude` is killed when its attempt's
 * time cap passes, and the node fails there without a retry.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, type WorkflowBundle } from "@temporalio/worker";

import { parseRunConfig } from "../config.ts";
import { UNUSABLE_PUSH_URL } from "../constants.ts";
import { type GraphDef, type RunHistory, WORKFLOW_NAME, type WorkflowInput } from "../contracts.ts";
import { graph as toy } from "../examples/toy.ts";
import { requestInputs } from "../schedule.ts";
import { createWorker, WORKFLOWS_PATH } from "../worker.ts";

const quiet = new DefaultLogger((process.env.GRAPH_TEST_LOG as "WARN" | undefined) ?? "ERROR");
Runtime.install({ logger: quiet });

/** A stand-in `claude`: writes each output folder the prompt names; with a `hang-fixer` file in its
 *  state folder, the fixer hangs on its first run. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const state = process.env.FAKE_CLAUDE_STATE;
const args = process.argv.slice(2);
const agent = args[args.indexOf("--agent") + 1];
const role = agent.split(":").pop();
let prompt = "";
process.stdin.on("data", (d) => (prompt += d)).on("end", () => {
  fs.appendFileSync(path.join(state, "calls.log"), JSON.stringify({ agent, args, cwd: process.cwd(), ghToken: process.env.GH_TOKEN, apiKey: process.env.TYPESAFE_API_KEY, ghConfig: process.env.GH_CONFIG_DIR }) + "\\n");
  const hungFile = path.join(state, "fixer-hung");
  if (role === "fixer" && fs.existsSync(hungFile)) {
    let alive = true;
    try { process.kill(Number(fs.readFileSync(hungFile, "utf8")), 0); } catch { alive = false; }
    fs.writeFileSync(path.join(state, "hung-alive-at-retry"), String(alive));
  }
  if (role === "reviewer") fs.writeFileSync(path.join(process.cwd(), "stray.txt"), "a reader wrote this\\n");
  const m = /folder under (.+?): (.+?)\\. Each folder/.exec(prompt);
  const folders = m[2].split(", ");
  if (role === "fixer" && fs.existsSync(path.join(state, "hang-fixer")) && !fs.existsSync(path.join(state, "fixer-hung"))) {
    fs.writeFileSync(path.join(state, "fixer-hung"), String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  for (const f of folders) {
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, role + ".md"), "written by " + agent + "\\n");
  }
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok" }));
});
`;

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let tmp: string;
let repo: string;
let state: string;
let jevServer: Server;
let jevRequests: { auth: string | undefined; body: any }[];
const saved: Record<string, string | undefined> = {};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "graph-real-"));
  state = join(tmp, "state");
  mkdirSync(state);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);

  repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["init", "-q", "--bare", join(tmp, "origin.git")]);
  execFileSync("git", ["remote", "add", "origin", join(tmp, "origin.git")], { cwd: repo });
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "build-steps.toml"), 'tests = "test -f README.md && echo suite green"\n');
  mkdirSync(join(repo, ".claude", "agents"));
  for (const role of ["planner", "reviewer", "fixer"]) writeFileSync(join(repo, ".claude", "agents", `${role}.md`), `---\nname: ${role}\n---\n`);
  writeFileSync(join(repo, "README.md"), "toy\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo });

  jevRequests = [];
  jevServer = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      jevRequests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers: { risky: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => jevServer.listen(0, "127.0.0.1", resolve));
  const port = (jevServer.address() as { port: number }).port;

  for (const [k, v] of Object.entries({ GH_TOKEN: "gh-secret", PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_STATE: state, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quiet });
});

after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await env?.teardown();
  await new Promise((resolve) => jevServer?.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const examples = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
const realConfig = () =>
  parseRunConfig(
    {
      graph: "toy.ts",
      agent: { adapter: "claude" },
      classifier: {
        adapter: "jev",
        model: "jev-test",
        cutoff: 0.5,
        fields: { plan: { input: "plan" } },
        questions: { risky: { type: "noul", instructions: "Is the plan risky?" } },
      },
      check: { adapter: "shell" },
    },
    examples
  ).config;

test("a graph runs on the Claude, Jev and shell adapters", { timeout: 60_000 }, async () => {
  const config = realConfig();
  const input: WorkflowInput = { runId: "real-1", repo, runDir: join(tmp, "runs", "real-1"), graph: toy, inputs: requestInputs(toy, "add greet"), config };
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue: "q-real", workflowBundle: bundle, shutdownGraceTime: "1s" });
  const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: "q-real", workflowId: "real-1", args: [input] });
  const h = (await worker.runUntil(handle.result())) as RunHistory;

  assert.equal(h.phase, "done", h.error ?? JSON.stringify(h.nodes.filter((n) => n.status === "failed")));
  assert.deepEqual(h.nodes.filter((n) => n.status === "failed"), []);

  const calls = readFileSync(join(state, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { agent: string; args: string[]; cwd: string; ghToken?: string; apiKey?: string; ghConfig?: string });
  assert.deepEqual(calls.map((c) => c.agent), ["planner", "reviewer", "fixer"], "the repo's own agents, which the run checked at its start");
  assert.ok(calls.every((c) => c.args.includes("--disallowedTools") && c.args.includes("--output-format")));
  assert.ok(calls.every((c) => c.ghToken === undefined && c.apiKey === undefined && c.ghConfig !== undefined), "no forge token or API key reaches an agent, and gh has its own empty config");

  const place = JSON.parse(readFileSync(join(input.runDir, "place.json"), "utf8")) as { worktree: string };
  const reviewer = calls.find((c) => c.agent === "reviewer")!;
  assert.equal(realpathSync(reviewer.cwd), realpathSync(join(input.runDir, "worktrees", "review")), "a reader works in its own worktree");
  assert.equal(existsSync(join(place.worktree, "stray.txt")), false, "what a reader wrote never reached the run tree");
  assert.equal(existsSync(join(input.runDir, "worktrees", "review", "stray.txt")), true);
  const pushUrl = (dir: string) => execFileSync("git", ["remote", "get-url", "--push", "origin"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(pushUrl(join(input.runDir, "worktrees", "review")), UNUSABLE_PUSH_URL);
  assert.equal(pushUrl(join(input.runDir, "worktrees", "fix")), UNUSABLE_PUSH_URL);
  assert.equal(pushUrl(place.worktree), join(tmp, "origin.git"), "the run worktree, where the forge pushes, keeps the real URL");
  assert.equal(pushUrl(repo), join(tmp, "origin.git"));

  assert.equal(jevRequests.length, 1);
  assert.equal(jevRequests[0]!.auth, "Bearer test-key");
  assert.equal(jevRequests[0]!.body.model, "jev-test");
  assert.match(jevRequests[0]!.body.state.plan, /written by planner/, "the classifier read the plan file the planner wrote");
  const review = h.nodes.find((n) => n.node === "needs-review")!;
  assert.deepEqual([review.answer, review.cutoff], ["yes", 0.5], "the node run keeps the answer, p and cut-off");
  const verdict = h.data["review-call"];
  assert.ok(verdict?.schema === "verdict" && verdict.decision !== undefined);
  const d = verdict.decision;
  assert.equal(review.p, verdict.p);
  assert.deepEqual([d.node, d.adapter, d.setup?.name, d.model, d.cutoff], ["needs-review", "jev", "inline", "jev-test", 0.5]);
  assert.match(d.setup!.sha256, /^[0-9a-f]{64}$/);
  const kept = JSON.parse(readFileSync(d.decisionFile!, "utf8")) as { state: string; stateDigest: string; answer: string; p: number };
  assert.equal(realpathSync(dirname(d.decisionFile!)), realpathSync(join(input.runDir, "nodes", "needs-review", "0", "out")), "one file per decision, in the node's output folder");
  assert.deepEqual(JSON.parse(kept.state), jevRequests[0]!.body.state, "the file keeps the exact state Jev was sent");
  assert.equal(kept.stateDigest, createHash("sha256").update(kept.state).digest("hex"));
  assert.equal(d.stateDigest, kept.stateDigest);
  assert.deepEqual([kept.answer, kept.p], [verdict.answer, verdict.p]);

  const tests = h.nodes.find((n) => n.node === "tests" && n.iteration === 1);
  assert.equal(tests?.answer, "pass");
  assert.match(h.data["test-report"] ? JSON.stringify(h.data["test-report"]) : "", /suite green/);
  assert.ok(existsSync(join(input.runDir, "nodes", "fix", "1", "inputs.json")), "the inputs file sits beside the node's out dir");
});

test("a hung claude is killed at its cap, and the node fails there without a retry: a cap hit is not retried", { timeout: 60_000 }, async () => {
  const hangState = join(tmp, "hang-state");
  mkdirSync(hangState);
  writeFileSync(join(hangState, "hang-fixer"), "");
  const saved = process.env.FAKE_CLAUDE_STATE;
  process.env.FAKE_CLAUDE_STATE = hangState;
  try {
    const capped: GraphDef = { ...toy, nodes: toy.nodes.map((n) => (n.id === "fix" ? { ...n, timeCapMs: 3_000 } : n)) };
    const input: WorkflowInput = { runId: "real-hang", repo, runDir: join(tmp, "runs", "real-hang"), graph: capped, inputs: requestInputs(capped, "add greet"), config: realConfig() };
    const worker = await createWorker({ connection: env.nativeConnection, taskQueue: "q-real-hang", workflowBundle: bundle, shutdownGraceTime: "1s" });
    const handle = await env.client.workflow.start(WORKFLOW_NAME, { taskQueue: "q-real-hang", workflowId: "real-hang", args: [input] });
    const h = (await worker.runUntil(handle.result())) as RunHistory;
    assert.equal(h.phase, "failed");
    const fix = h.nodes.find((n) => n.node === "fix" && n.iteration === 1);
    assert.equal(fix?.status, "failed");
    assert.match(fix?.reason ?? "", /time cap of 3000 ms reached/);
    const calls = readFileSync(join(hangState, "calls.log"), "utf8").trim().split("\n");
    assert.equal(calls.filter((l) => l.includes('"fixer"') || l.includes(":fixer")).length, 1, "one fixer attempt, no retry");
    const hungPid = Number(readFileSync(join(hangState, "fixer-hung"), "utf8"));
    for (let i = 0; i < 100 && alive(hungPid); i++) await delay(50);
    assert.equal(alive(hungPid), false, "the hung claude was killed at its cap");
    const pgid = JSON.parse(readFileSync(join(input.runDir, "nodes", "fix", "1", "pgid.json"), "utf8")) as { pid: number | null };
    assert.equal(pgid.pid, null, "the attempt ended here, so the recorded process group is cleared");
  } finally {
    process.env.FAKE_CLAUDE_STATE = saved;
  }
});
