import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentDirs, inputsFile } from "../adapters/agentIo.ts";
import { claudeAgent, claudeAgentArgs, claudeRoleMissing } from "../adapters/claudeAgent.ts";
import type { ProcessOptions, ProcessResult } from "../adapters/process.ts";
import type { AgentRequest } from "../adapters/types.ts";
import { AGENT_DOCS_DIR, AGENT_QUESTION_FILE } from "../constants.ts";
import { CLAUDE_RESULT_FILE } from "../constants.ts";
import { ContractError } from "../contracts.ts";
import { sessionName } from "../runKeys.ts";

const ok = (stdout = JSON.stringify({ type: "result", is_error: false, result: "done" })): ProcessResult => ({ code: 0, stdout, stderr: "", output: stdout });

function setup(over: Partial<AgentRequest> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graph-claude-"));
  const outDir = join(dir, "nodes", "writer", "0", "out");
  const req: AgentRequest = {
    runId: "r",
    nodeId: "A-writer",
    role: "writer",
    inputs: { brief: { schema: "text", text: "Write a haiku" } },
    answers: [],
    outputs: ["poem"],
    outDir,
    worktree: join(dir, "worktree"),
    writes: true,
    attempt: 1,
    iteration: 0,
    signal: new AbortController().signal,
    ...over,
  };
  mkdirSync(req.worktree, { recursive: true });
  return { dir, req, done: () => rmSync(dir, { recursive: true }) };
}

type Call = { cmd: string; args: string[]; opts: ProcessOptions };

/** A runner that records its call and, like the agent, leaves `write` in the out dir. */
function fakeClaude(write: (outDir: string) => void, result: ProcessResult = ok()) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> => {
    calls.push({ cmd, args, opts });
    write(join(args[args.indexOf("--add-dir") + 1]!, "out"));
    return result;
  };
  return { calls, run };
}

const writePoem = (outDir: string) => {
  mkdirSync(join(outDir, "poem"), { recursive: true });
  writeFileSync(join(outDir, "poem", "haiku.md"), "old pond\n");
};

/** The node run an argv is built for. */
const RUN = { runId: "build-17-ab", nodeId: "A-builder", iteration: 0, inputs: {} };

test("the argv names the plugin agent, blocks git push and gh pr, and lets the agent write its node folder", () => {
  const args = claudeAgentArgs({ adapter: "claude", plugin: "agent-build" }, { ...RUN, role: "builder", outDir: "/run/nodes/b/1/out", worktree: "/run/worktrees/b", writes: true });
  assert.deepEqual(args.slice(0, 5), ["-p", "-n", "build-17-ab-A-builder-0", "--agent", "agent-build:builder"]);
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  const denied = args[args.indexOf("--disallowedTools") + 1]!.split(",");
  for (const rule of ["Bash(git push:*)", "Bash(gh pr:*)", "Bash(git -C * push*)", "Bash(gh -R * pr*)"]) assert.ok(denied.includes(rule), rule);
  assert.ok(denied.every((r) => /^Bash\((git|gh) /.test(r)), "only git and gh rules");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/run/nodes/b/1");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!args.includes("--model"));
});

test("the agent reaches its attempt folder, the folder of every input file and the installed docs, once each, through --add-dir", () => {
  const home = mkdtempSync(join(tmpdir(), "graph-home-"));
  const docs = join(home, ...AGENT_DOCS_DIR);
  mkdirSync(join(home, "checkout", "docs"), { recursive: true });
  mkdirSync(join(home, ".agent-build"));
  symlinkSync(join(home, "checkout", "docs"), docs);
  const inputs = {
    table: { schema: "files" as const, files: ["/run/store/table/table-1.md", "/run/store/table/fix-1.txt"] },
    brief: { schema: "text" as const, text: "inline" },
    drafts: { schema: "files" as const, files: ["/run/nodes/d/1/out/draft-slices/draft-slices.json"] },
  };
  assert.deepEqual(agentDirs({ outDir: "/run/nodes/s/1/out", inputs }, home), ["/run/nodes/s/1", "/run/store/table", "/run/nodes/d/1/out/draft-slices", docs, realpathSync(join(home, "checkout", "docs"))]);
  const args = claudeAgentArgs({ adapter: "claude", plugin: "agent-build" }, { ...RUN, inputs, role: "link-slices", outDir: "/run/nodes/s/1/out", worktree: "/run/worktrees/s", writes: false });
  const added = args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]!] : []));
  assert.deepEqual(added, agentDirs({ outDir: "/run/nodes/s/1/out", inputs }), "the argv passes every folder agentDirs names, in its order");
  assert.equal(added[0], "/run/nodes/s/1", "the attempt folder stays first: the adapter's tests and the CLI's out dir read it there");
  assert.ok(added.includes("/run/store/table") && added.includes("/run/nodes/d/1/out/draft-slices"), "each input file's folder");
  assert.equal(added.filter((d) => d === "/run/store/table").length, 1, "two files in one folder add it once");
  assert.ok(added.includes(join(homedir(), ...AGENT_DOCS_DIR)), "the installed docs, where every agent file sends a graph agent");
  rmSync(home, { recursive: true });
});

test("the session is named for its node run, the iteration and the fan-out item in it, so a peer reaches a slice of one round by name", () => {
  const args = claudeAgentArgs({ adapter: "claude", plugin: "agent-build" }, { ...RUN, nodeId: "A-fixer", iteration: 2, instance: "S3", role: "fixer", outDir: "/r/out", worktree: "/r/wt", writes: true });
  assert.equal(args[args.indexOf("-n") + 1], "build-17-ab-A-fixer-2-S3");
  assert.equal(args[args.indexOf("-n") + 1], sessionName("build-17-ab", "A-fixer", 2, "S3"), "the adapter and a peer's address are one function");
  assert.equal(sessionName("r", "A-answer-question", 1, "A-fixer#1@S2:Q1"), "r-A-answer-question-1-A-fixer_1_S2_Q1", "a service's subject is made a key segment");
});

test("a project agent has no plugin prefix, and the binding's model and permission mode are passed", () => {
  const args = claudeAgentArgs({ adapter: "claude", model: "haiku", permissionMode: "bypassPermissions" }, { ...RUN, role: "smoke", outDir: "/r/out", worktree: "/r/wt", writes: true });
  assert.equal(args[args.indexOf("--agent") + 1], "smoke");
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
});

test("a dispatch's model is passed as --model, over the binding's", () => {
  const where = { ...RUN, role: "fixer", outDir: "/r/out", worktree: "/r/wt", writes: true };
  const args = claudeAgentArgs({ adapter: "claude", plugin: "agent-build", model: "haiku" }, { ...where, model: "opus" });
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args.filter((a) => a === "--model").length, 1);
  assert.ok(!claudeAgentArgs({ adapter: "claude", plugin: "agent-build" }, where).includes("--model"), "no dispatch model and no binding model: the CLI's default");
});

test("a binding with agentFromItem spawns the fan-out item, a project agent, whatever the plugin; with no item it refuses", () => {
  const binding = { adapter: "claude", plugin: "agent-build", agentFromItem: true } as const;
  const args = claudeAgentArgs(binding, { ...RUN, role: "repo-review", instance: "comment-reader", outDir: "/r/out", worktree: "/r/wt", writes: false });
  assert.equal(args[args.indexOf("--agent") + 1], "comment-reader");
  assert.throws(() => claudeAgentArgs(binding, { ...RUN, role: "repo-review", outDir: "/r/out", worktree: "/r/wt", writes: false }), /takes its agent from the fan-out item, and this run has none/);
});

test("a run writes the inputs file, runs claude in the worktree with the prompt on stdin, and returns the files the agent wrote", async () => {
  const { req, done } = setup({ answers: ["use the pond"] });
  const { calls, run } = fakeClaude(writePoem);
  const result = await claudeAgent({ adapter: "claude", plugin: "p" }, { run }).run(req);

  assert.deepEqual(result, { status: "done", files: { poem: [join(req.outDir, "poem", "haiku.md")] } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, "claude");
  assert.equal(calls[0]!.opts.cwd, req.worktree);
  assert.equal(calls[0]!.opts.signal, req.signal);
  const inputsPath = join(req.outDir, "..", "inputs.json");
  assert.ok(calls[0]!.opts.input!.includes(`Your dispatch is the inputs file ${inputsPath}`));
  assert.match(calls[0]!.opts.input!, new RegExp(`${join(req.outDir, "poem")}/`));
  assert.match(calls[0]!.opts.input!, /Do not push, open or merge a pull request/);
  assert.deepEqual(JSON.parse(readFileSync(inputsPath, "utf8")), {
    role: "writer",
    iteration: 0,
    worktree: req.worktree,
    inputs: { brief: { schema: "text", text: "Write a haiku" } },
    outputs: { poem: `${join(req.outDir, "poem")}/` },
    answers: ["use the pond"],
  });
  assert.ok(existsSync(join(req.outDir, "..", CLAUDE_RESULT_FILE)), "the CLI's own result is kept beside the node's out dir");
  done();
});

test("the request's onSpawn reaches the process runner, and a request without one passes none", async () => {
  const onSpawn = () => {};
  const withHook = setup({ onSpawn });
  const a = fakeClaude(writePoem);
  await claudeAgent({ adapter: "claude", plugin: "p" }, { run: a.run }).run(withHook.req);
  assert.equal(a.calls[0]!.opts.onSpawn, onSpawn);
  withHook.done();
  const without = setup();
  const b = fakeClaude(writePoem);
  await claudeAgent({ adapter: "claude", plugin: "p" }, { run: b.run }).run(without.req);
  assert.equal("onSpawn" in b.calls[0]!.opts, false);
  without.done();
});

test("the inputs file carries the fan-out item and the amend question and answer when the request has them", () => {
  const { req, done } = setup();
  const question = { id: "Q1", type: "brief" as const, text: "Which season?", searched: [{ source: "brief", said: "nothing" }] };
  const answer = { question_id: "Q1", answer: "winter", source: "operator" as const, by: "operator" as const, brief_change: "say winter" };
  const file = inputsFile({ ...req, iteration: 2, instance: "part-1", question, answer });
  assert.equal(file.iteration, 2);
  assert.equal(file.item, "part-1");
  assert.deepEqual([file.question, file.answer], [question, answer]);
  done();
});

test("a declared output the agent did not write breaks the contract, naming it", async () => {
  const { req, done } = setup({ outputs: ["poem", "notes"] });
  const { run } = fakeClaude(writePoem);
  await assert.rejects(claudeAgent({ adapter: "claude" }, { run }).run(req), (e: unknown) => e instanceof ContractError && /did not write notes\//.test(e.message) && !/poem\//.test(e.message));
  done();
});

test("an output folder with no file in it counts as missing", async () => {
  const { req, done } = setup();
  const { run } = fakeClaude((out) => mkdirSync(join(out, "poem"), { recursive: true }));
  await assert.rejects(claudeAgent({ adapter: "claude" }, { run }).run(req), ContractError);
  done();
});

test("a question file in the out dir is returned as the agent's question, ahead of any output check", async () => {
  const { req, done } = setup();
  const { run } = fakeClaude((out) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, AGENT_QUESTION_FILE), "  Which season?\n");
  });
  assert.deepEqual(await claudeAgent({ adapter: "claude" }, { run }).run(req), { status: "needs-operator", question: "Which season?" });
  done();
});

test("a non-zero exit fails with the end of stderr", async () => {
  const { req, done } = setup();
  const { run } = fakeClaude(() => {}, { code: 1, stdout: "", stderr: "boom: not logged in", output: "" });
  await assert.rejects(claudeAgent({ adapter: "claude" }, { run }).run(req), /claude exited 1: boom: not logged in/);
  done();
});

test("output that is not JSON, or not a JSON object, fails", async () => {
  for (const stdout of ["Segmentation fault", "[1,2]", ""]) {
    const { req, done } = setup();
    const { run } = fakeClaude(writePoem, ok(stdout));
    await assert.rejects(claudeAgent({ adapter: "claude" }, { run }).run(req), /claude printed no JSON result/, JSON.stringify(stdout));
    done();
  }
});

test("a result the CLI marks as an error fails even with exit 0 and files in place", async () => {
  const { req, done } = setup();
  const { run } = fakeClaude(writePoem, ok(JSON.stringify({ type: "result", is_error: true, result: "rate limited" })));
  await assert.rejects(claudeAgent({ adapter: "claude" }, { run }).run(req), /claude reported an error: rate limited/);
  done();
});

test("a timeout or cancel is the runner's rejection, passed through", async () => {
  const { req, done } = setup();
  const reason = new Error("time cap of 1000 ms reached");
  const run = async (): Promise<ProcessResult> => {
    throw reason;
  };
  await assert.rejects(claudeAgent({ adapter: "claude" }, { run }).run(req), (e: unknown) => e === reason);
  done();
});

test("a writer's argv has no edit denials; a reader's denies Edit, Write and NotebookEdit in its own worktree only", () => {
  const args = (writes: boolean) => claudeAgentArgs({ adapter: "claude" }, { ...RUN, role: "r", outDir: "/run/n/out", worktree: "/run/worktrees/r-0", writes });
  const denied = (a: string[]) => a[a.indexOf("--disallowedTools") + 1]!.split(",");
  assert.ok(!denied(args(true)).some((r) => r.startsWith("Edit(") || r.startsWith("Write(") || r.startsWith("NotebookEdit(")));
  for (const tool of ["Edit", "Write", "NotebookEdit"]) assert.ok(denied(args(false)).includes(`${tool}(//run/worktrees/r-0/**)`), tool);
});

test("the agent process gets no adapter or forge token and an empty gh config folder, rebuilt on every run", async () => {
  const { req, done } = setup();
  const seen: (NodeJS.ProcessEnv | undefined)[] = [];
  const run = async (_c: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> => {
    seen.push(opts.env);
    const ghDir = opts.env!.GH_CONFIG_DIR!;
    assert.deepEqual(readdirSync(ghDir), [], "empty when the agent starts");
    writeFileSync(join(ghDir, "hosts.yml"), "github.com: {oauth_token: stolen}");
    writePoem(join(args[args.indexOf("--add-dir") + 1]!, "out"));
    return ok();
  };
  const env = { PATH: "/bin", KEEP: "1", GH_TOKEN: "a", GITHUB_TOKEN: "b", GH_ENTERPRISE_TOKEN: "c", TYPESAFE_API_KEY: "d", LINEAR_API_KEY: "e", GH_CONFIG_DIR: "/home/me/.config/gh" };
  const runner = claudeAgent({ adapter: "claude" }, { run, env });
  await runner.run(req);
  await runner.run(req);
  for (const e of seen) {
    assert.deepEqual(Object.keys(e!).sort(), ["GH_CONFIG_DIR", "KEEP", "PATH"]);
    assert.equal(e!.GH_CONFIG_DIR, join(req.outDir, "..", "gh-config"));
  }
  done();
});

test("a role resolves to a Claude agent: the shipped plugin's agents/<role>.md, else a project or user agent; another plugin cannot be checked", () => {
  const tmp = mkdtempSync(join(tmpdir(), "claude-roles-"));
  const [plugin, repo, home] = ["plugin", "repo", "home"].map((d) => join(tmp, d)) as [string, string, string];
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
  mkdirSync(join(plugin, "agents"));
  writeFileSync(join(plugin, "agents", "fixer.md"), "---\nname: fixer\n---\n");
  for (const d of [join(repo, ".claude", "agents"), join(home, ".claude", "agents")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repo, ".claude", "agents", "planner.md"), "");
  writeFileSync(join(home, ".claude", "agents", "reviewer.md"), "");
  const where = { pluginRoot: plugin, home };
  assert.equal(claudeRoleMissing({ adapter: "claude", plugin: "kit" }, "fixer", repo, where), null);
  assert.equal(claudeRoleMissing({ adapter: "claude", plugin: "kit" }, "resolver", repo, where), "role resolver has no agent in the Claude plugin kit: no agents/resolver.md");
  assert.match(claudeRoleMissing({ adapter: "claude", plugin: "other" }, "fixer", repo, where)!, /bound to the Claude plugin other, which is not the plugin this graph ships in \(kit\)/);
  assert.equal(claudeRoleMissing({ adapter: "claude" }, "planner", repo, where), null, "a project agent");
  assert.equal(claudeRoleMissing({ adapter: "claude" }, "reviewer", repo, where), null, "a user agent");
  assert.match(claudeRoleMissing({ adapter: "claude" }, "fixer", repo, where)!, /^role fixer has no Claude agent: no fixer\.md in /);
  rmSync(tmp, { recursive: true });
});
