/** `/build` as a graph (`pipelines/build.ts`): it validates, and its gates, bindings and runs hold. */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { prepareRun } from "../activities.ts";
import { agentRolesMissing, classifierKeysMissing } from "../adapters/bind.ts";
import { buildState, featureSum } from "../adapters/classifierState.ts";
import { parseRunConfig } from "../config.ts";
import { BUILD_RUN_CONFIG, CLASSIFIER_YES } from "../constants.ts";
import { bindingFor, type DataValues, isDataOp, opSpec, RunError } from "../contracts.ts";
import { validateGraph } from "../define.ts";
import { mockConfig, operatorReplies } from "../mock/mock.ts";
import { graph } from "../pipelines/build.ts";
import { checkRunConfig } from "../schedule.ts";
import { FIXTURES, NO_FIXTURES } from "./helpers/fixtures.ts";

const graphDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the build graph validates", () => {
  assert.deepEqual(validateGraph(graph), []);
});

test("an agent's role is the first node that runs it, and its agent file is agents/<role>.md", () => {
  const file = join(graphDir, BUILD_RUN_CONFIG);
  const { config } = parseRunConfig(JSON.parse(readFileSync(file, "utf8")), dirname(file));
  const first = new Map<string, string>();
  for (const n of graph.nodes) if (n.kind === "agent" && !first.has(n.role)) first.set(n.role, n.id);
  for (const [role, id] of first) {
    assert.equal(role, id.slice(2), `${id} runs ${role}`);
    const b = bindingFor(config, "agent", role);
    if (b?.adapter === "claude" && b.agentFromItem === true) continue;
    const agent = b?.adapter === "codex" ? (b.role ?? role) : role;
    assert.ok(existsSync(join(graphDir, "..", "agents", `${agent}.md`)), `${id}: agents/${agent}.md`);
  }
});

test("no node's doc names a reader by its name from before the agents took their nodes' names", () => {
  const retired = /review-cursory|silent-failure hunter|gate-silent-failure-hunter|build-verifier|security-review|test-author|hand-tester|brief-writer/;
  const stale = graph.nodes.filter((n) => retired.test(n.doc ?? "")).map((n) => `${n.id}: ${n.doc}`);
  assert.deepEqual(stale, []);
});

test("roles and items read like their nodes: a graph-only role, a check's verdict, a classifier's call and setup, a reader's findings and an owed gate take the node's own words", () => {
  const MOMENT = /-(fix|drift|ship)$/;
  const bare = (id: string) => id.slice(2);
  const file = join(graphDir, BUILD_RUN_CONFIG);
  const { config } = parseRunConfig(JSON.parse(readFileSync(file, "utf8")), dirname(file));
  const format = (id: string) => graph.data.find((d) => d.id === id)?.format;
  for (const n of graph.nodes) {
    if (n.kind !== "agent" && !(n.kind === "data" && isDataOp(n.role))) {
      const first = MOMENT.test(n.id) ? graph.nodes.find((m) => m.id === n.id.replace(MOMENT, "")) : undefined;
      assert.ok(n.role === bare(n.id) || first?.role === n.role, `${n.id}: role ${n.role}`);
    }
    if (n.kind === "check") assert.equal(n.outputs[0], bare(n.id), `${n.id}'s verdict`);
    if (n.kind === "classifier") {
      assert.equal(n.outputs[0], `${n.role}-call`, `${n.id}'s call`);
      const b = bindingFor(config, "classifier", n.role);
      assert.equal(b?.adapter === "jev" ? b.setup.name : null, n.role, `${n.id}'s setup is classifiers/${n.role}.json`);
    }
    const out = format(n.outputs[0]!);
    if (n.kind === "agent" && (out === "findings" || out === "stage")) assert.equal(n.outputs[0], `findings-${bare(n.id)}`, `${n.id}'s findings`);
  }
  for (const d of graph.data.filter((x) => x.id.startsWith("owed-"))) {
    const gated = graph.nodes.filter((n) => n.gate !== undefined && JSON.stringify(n.gate).includes(`"${d.id}"`));
    assert.ok(gated.length > 0, `${d.id} gates a node`);
    for (const n of gated) assert.ok([`owed-${bare(n.id)}`, `owed-${bare(n.id)}-call`].includes(d.id), `${d.id} gates ${n.id}`);
  }
});

test("the fixer runs on the model D-build-fix-table picks: A-fixer takes it from D-build-fix-table's fixer-model text output", () => {
  const fixer = graph.nodes.find((n) => n.id === "A-fixer")!;
  assert.equal(fixer.modelFrom, "fixer-model");
  assert.ok(fixer.inputs.includes("fixer-model"));
  assert.ok(graph.nodes.find((n) => n.id === "D-build-fix-table")!.outputs.includes("fixer-model"));
  assert.equal(graph.data.find((d) => d.id === "fixer-model")?.schema, "text");
});

test("each gated reader waits on the classifier of its own name: A-silent-failures on C-silent-failures, A-review-fix on C-review-fix, the rest on theirs", () => {
  const node = (id: string) => graph.nodes.find((n) => n.id === id)!;
  assert.deepEqual(node("A-silent-failures").gate, { classifier: "C-silent-failures", answer: CLASSIFIER_YES });
  assert.deepEqual([node("C-silent-failures").kind, node("C-silent-failures").role, node("C-silent-failures").inputs], ["classifier", "silent-failures", ["diff", "brief", "risk-moment"]]);
  assert.equal(node("C-review-fix").kind, "classifier");
  assert.equal(node("C-review-fix").role, "review-fix");
  for (const [agent, classifier] of [["A-prior-art", "C-prior-art"], ["A-review-codex", "C-review-codex"], ["A-completeness", "C-completeness"], ["A-simplifier", "C-simplifier"], ["A-security", "C-security"]]) {
    assert.deepEqual(node(agent!).gate, { classifier, answer: CLASSIFIER_YES }, agent);
  }
});

test("the real-run config binds all seven classifiers to their shipped setups on Jev, each reading only its node's inputs", () => {
  const file = join(graphDir, BUILD_RUN_CONFIG);
  const { config, graphModule } = parseRunConfig(JSON.parse(readFileSync(file, "utf8")), dirname(file));
  assert.equal(graphModule, join(graphDir, "pipelines", "build.ts"));
  const classifiers = graph.nodes.filter((n) => n.kind === "classifier");
  assert.deepEqual(classifiers.map((n) => n.role).sort(), ["completeness", "prior-art", "review-codex", "review-fix", "security", "silent-failures", "simplifier"]);
  assert.equal(config.classifier, undefined, "no default: a classifier the config does not name is refused, not answered by a default");
  for (const n of classifiers) assert.equal(bindingFor(config, "classifier", n.role)?.adapter, "jev", n.role);
  assert.deepEqual(checkRunConfig(graph, config), []);
});

test("every writer's commit is merged into the run tree before a node reads the code", () => {
  const services = new Set(Object.values(graph.services ?? {}));
  for (const w of graph.nodes.filter((n) => n.writes === true && !services.has(n.id))) {
    const ref = w.outputs.find((id) => graph.data.find((d) => d.id === id)?.schema === "ref")!;
    const merger = graph.nodes.find((n) => n.kind === "data" && n.inputs.includes(ref));
    assert.equal(merger === undefined ? undefined : opSpec(graph, merger.role)?.merges, true, `${w.id}'s ${ref} is merged back`);
  }
  assert.equal(graph.nodes.find((n) => n.id === "D-merge-slice")?.role, "merge-slice");
  // The amend service writes too; the runner merges its commit when it returns.
  assert.equal(graph.nodes.find((n) => n.id === graph.services?.amend)?.writes, true);
});

test("D-merge-slice writes only its slice's conflict file, and D-merge-fix requires it", () => {
  const node = (id: string) => graph.nodes.find((n) => n.id === id)!;
  assert.deepEqual(node("D-merge-slice").outputs, ["slice-conflict"]);
  assert.deepEqual(node("D-merge-slice").inputs, ["fix-commit", "slice-plan"]);
  assert.deepEqual(opSpec(graph, "merge-slice"), { output: "files", needs: "ref", idempotent: true, merges: true });
  assert.ok(node("D-merge-fix").inputs.includes("slice-conflict"));
  assert.equal(node("D-merge-fix").optionalInputs, undefined);
  assert.equal(graph.data.some((d) => d.id === "slice-head"), false);
});

test("C-review-fix binds the shipped Jev re-review setup by config: it reads only the node's inputs, and A-review-fix (review) runs on its yes", () => {
  const { config } = parseRunConfig(
    {
      graph: "pipelines/build.ts",
      pipeline: "pipelines/build/pipeline.ts",
      agent: { adapter: "stub", fixtureDir: "agents" },
      classifier: { adapter: "stub", default: { answer: CLASSIFIER_YES, p: 1 } },
      check: { adapter: "pipeline" },
      roles: { "review-fix": { classifier: { adapter: "jev", setup: "classifiers/review-fix.json" } } },
    },
    graphDir
  );
  const b = bindingFor(config, "classifier", "review-fix");
  assert.ok(b !== undefined && b.adapter === "jev");
  const node = graph.nodes.find((n) => n.id === "C-review-fix")!;
  for (const id of [...Object.values(b.fields).map((f) => f.input), ...b.features.map((f) => f.input)]) assert.ok(node.inputs.includes(id), `C-review-fix reads ${id}`);
  const confirmNode = graph.nodes.find((n) => n.id === "A-review-fix")!;
  assert.equal(confirmNode.kind === "agent" && confirmNode.role, "review", "one confirm read per round, on the default Claude reviewer");
  const confirm = confirmNode.gate!;
  assert.ok("anyOf" in confirm && confirm.anyOf.some((g) => "classifier" in g && g.classifier === "C-review-fix" && g.answer === CLASSIFIER_YES));

  const dir = mkdtempSync(join(tmpdir(), "graph-rereview-"));
  writeFileSync(join(dir, "fix.patch"), "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n x\n+if (y) return;\n");
  writeFileSync(join(dir, "fix-1.txt"), "F1 · fixed · abc1234 — guard\nF2 · decision — which one?\n");
  const inputs: DataValues = {
    "fix-diff": { schema: "files", files: [join(dir, "fix.patch")] },
    "fix-file": { schema: "files", files: [join(dir, "fix-1.txt")] },
    table: { schema: "files", files: [join(dir, "fix-1.txt")] },
    "fix-head": { schema: "ref", kind: "commit", id: "abc1234" },
  };
  assert.match(buildState(b.fields, inputs, node.id).fix_diff!, /\+if \(y\) return;/);
  assert.equal(featureSum(b.features, inputs, node.id), 0.4);
  rmSync(dir, { recursive: true });
});

test("the real-run config's agent roles resolve at start: the Codex pair as the shipped review, the repo readers as the agents the notes name at the base commit", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "graph-roles-"));
  const repo = join(tmp, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("commit", "-q", "--allow-empty", "-m", "init");
  const { config } = parseRunConfig(JSON.parse(readFileSync(join(graphDir, BUILD_RUN_CONFIG), "utf8")), dirname(join(graphDir, BUILD_RUN_CONFIG)));
  assert.deepEqual(bindingFor(config, "agent", "review-codex"), { adapter: "codex", role: "review" });
  assert.deepEqual(bindingFor(config, "agent", "repo-review"), { adapter: "claude", agentFromItem: true });
  const base = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.deepEqual(agentRolesMissing(config, graph, repo, base()), [], "every role has its agent; a repo with no notes names no reader");
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
  writeFileSync(join(repo, ".claude", "build-steps.toml"), 'notes = "docs/notes.md"\n');
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "notes.md"), "# notes\n\n## repo readers\n\n- api-reader\n- comment-reader (size S and up)\n\n## stack\n\n- not-a-reader\n");
  writeFileSync(join(repo, ".claude", "agents", "api-reader.md"), "---\nname: api-reader\n---\n");
  git("add", "-A");
  git("commit", "-q", "-m", "notes");
  writeFileSync(join(repo, ".claude", "agents", "comment-reader.md"), "uncommitted: the base commit does not hold it\n");
  const missing = agentRolesMissing(config, graph, repo, base());
  assert.equal(missing.length, 1);
  assert.match(missing[0]!, /^repo reader comment-reader, which \S+docs\/notes\.md names, has no agent: no \.claude\/agents\/comment-reader\.md in commit /);
  const runDir = join(tmp, "run");
  await assert.rejects(prepareRun({ runId: "r", repo, runDir, graph, inputs: {}, config }), (e: unknown) => e instanceof RunError && /^the run cannot start: repo reader comment-reader/.test(e.message));
  assert.equal(existsSync(join(runDir, "worktree")), false, "refused before the run's worktree is made");
  if (NO_FIXTURES === false) {
    const stubs = parseRunConfig(mockConfig(join(FIXTURES, "build-1792523343-EIBekQ"), tmp), tmp).config;
    assert.deepEqual(agentRolesMissing(stubs, graph, repo, base()), [], "a mock's stub agents run any role");
  }
  rmSync(tmp, { recursive: true });
});

test("a notes file the steps name and the base commit does not hold refuses the run at its start, naming the file, as a RunError the retry policy does not retry", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "graph-notes-gone-"));
  const repo = join(tmp, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "build-steps.toml"), 'notes = "docs/notes.md"\n');
  git("add", "-A");
  git("commit", "-q", "-m", "steps naming notes the commit does not hold");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "notes.md"), "## repo readers\n- api-reader\n");
  const { config } = parseRunConfig(JSON.parse(readFileSync(join(graphDir, BUILD_RUN_CONFIG), "utf8")), dirname(join(graphDir, BUILD_RUN_CONFIG)));
  const runDir = join(tmp, "run");
  await assert.rejects(prepareRun({ runId: "r", repo, runDir, graph, inputs: {}, config }), (e: unknown) => e instanceof RunError && /the notes file docs\/notes\.md, which the repo's build steps name, is not in commit/.test(e.message));
  assert.equal(existsSync(join(runDir, "worktree")), false);
  rmSync(tmp, { recursive: true });
});

test("a run that binds the Jev classifier refuses to start without TYPESAFE_API_KEY, in the one refusal a missing role would share", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "graph-keys-"));
  const repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const { config } = parseRunConfig(JSON.parse(readFileSync(join(graphDir, BUILD_RUN_CONFIG), "utf8")), dirname(join(graphDir, BUILD_RUN_CONFIG)));
  const jev = graph.nodes.filter((n) => n.kind === "classifier" && bindingFor(config, "classifier", n.role)?.adapter === "jev").map((n) => n.id);
  assert.ok(jev.length > 0, "the real-run config binds Jev classifiers");
  const saved = process.env.TYPESAFE_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    const runDir = join(tmp, "run");
    await assert.rejects(prepareRun({ runId: "r", repo, runDir, graph, inputs: {}, config }), (e: unknown) => {
      assert.ok(e instanceof RunError);
      assert.match(e.message, /^the run cannot start: (role .*; )?TYPESAFE_API_KEY is not set, and /, "one refusal holds the missing roles, when any, and the key");
      for (const id of jev) assert.ok(e.message.includes(id), `names ${id}`);
      return true;
    });
    assert.equal(existsSync(join(runDir, "worktree")), false, "refused before the run's worktree is made");
    process.env.TYPESAFE_API_KEY = "   ";
    assert.equal(classifierKeysMissing(config, graph, process.env).length, 1, "a blank key is a missing key");
    process.env.TYPESAFE_API_KEY = "key";
    assert.deepEqual(classifierKeysMissing(config, graph, process.env), []);
    const stubs = NO_FIXTURES === false ? parseRunConfig(mockConfig(join(FIXTURES, "build-1792523343-EIBekQ"), tmp), tmp).config : undefined;
    if (stubs !== undefined) {
      delete process.env.TYPESAFE_API_KEY;
      assert.deepEqual(classifierKeysMissing(stubs, graph, process.env), [], "a mock binds no Jev classifier and needs no key");
    }
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
    rmSync(tmp, { recursive: true });
  }
});

test("the real-classifier mock variant binds every classifier as the real-run config does and keeps the stub agents, tracker and forge", { skip: NO_FIXTURES }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "graph-mock-real-"));
  for (const fixture of ["build-1792523343-EIBekQ", "build-1790977465-962"]) {
    const { config } = parseRunConfig(mockConfig(join(FIXTURES, fixture), tmp, { realClassifiers: true }), tmp);
    assert.equal(config.agent.adapter, "stub", fixture);
    assert.match(config.agent.adapter === "stub" ? (config.agent.replay ?? "") : "", /\/mock\/replay\.ts$/, "the stub agents replay through the mock's replay");
    assert.deepEqual([config.tracker.adapter, config.forge.adapter], ["file", "file"]);
    assert.equal(config.classifier, undefined);
    for (const n of graph.nodes.filter((x) => x.kind === "classifier")) assert.equal(bindingFor(config, "classifier", n.role)?.adapter, "jev", `${fixture} ${n.role}`);
    assert.deepEqual(checkRunConfig(graph, config), []);
    const stub = parseRunConfig(mockConfig(join(FIXTURES, fixture), tmp), tmp).config;
    assert.equal(stub.classifier?.adapter, "stub", "without the flag the fixture's stubs stay");
    assert.equal(stub.agent.adapter === "stub" ? stub.agent.replay : "?", undefined, "without the flag the stubs replay the recording as it is");
  }
  rmSync(tmp, { recursive: true });
});

test("a fixture's operator replies: the list in operator.json, none without the file, and a refusal of any other shape", () => {
  const tmp = mkdtempSync(join(tmpdir(), "graph-replies-"));
  assert.deepEqual(operatorReplies(tmp), []);
  writeFileSync(join(tmp, "operator.json"), JSON.stringify(["approve", "keep v1"]));
  assert.deepEqual(operatorReplies(tmp), ["approve", "keep v1"]);
  writeFileSync(join(tmp, "operator.json"), JSON.stringify({ Q1: "approve" }));
  assert.throws(() => operatorReplies(tmp), /operator\.json: a list of reply strings/);
  rmSync(tmp, { recursive: true });
});
