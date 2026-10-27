import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentDirs, readAgentUsage } from "../adapters/agentIo.ts";
import { codexAgent, codexRoleMissing } from "../adapters/codexAgent.ts";
import type { ProcessOptions, ProcessResult } from "../adapters/process.ts";
import type { AgentRequest } from "../adapters/types.ts";
import { CODEX_RESULT_FILE } from "../constants.ts";
import { ContractError, RunError } from "../contracts.ts";

const roleToml = (sandbox: string): string =>
  [
    'model = "gpt-test"',
    'model_reasoning_effort = "low"',
    `developer_instructions = ${JSON.stringify("You review code.")}`,
    ...(sandbox === "" ? [] : [`sandbox_mode = "${sandbox}"`]),
  ].join("\n");

function setup(over: Partial<AgentRequest> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graph-codex-"));
  const req: AgentRequest = {
    runId: "r",
    nodeId: "A-reviewer",
    role: "reviewer",
    inputs: { diff: { schema: "text", text: "+ a line" } },
    answers: [],
    outputs: ["review"],
    outDir: join(dir, "nodes", "reviewer", "0", "out"),
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

/** A fake `codex`: records the call, then runs `act` as Codex would (writing -o, or files). */
function fakeCodex(act: (args: string[]) => void, result: ProcessResult = { code: 0, stdout: "", stderr: "", output: "" }) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> => {
    calls.push({ cmd, args, opts });
    act(args);
    return result;
  };
  return { calls, run };
}

const lastMessageFile = (args: string[]): string => args[args.indexOf("-o") + 1]!;

test("a read-only role runs codex exec in the worktree with the role's instructions, and its final message is the one output", async () => {
  const { req, done } = setup();
  const { calls, run } = fakeCodex((args) => writeFileSync(lastMessageFile(args), "NO FINDINGS\n"));
  const result = await codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("read-only") } }).run(req);

  const report = join(req.outDir, "review", "report.md");
  assert.deepEqual(result, { status: "done", files: { review: [report] } });
  assert.equal(readFileSync(report, "utf8"), "NO FINDINGS\n");
  const [call] = calls;
  assert.equal(call!.cmd, "codex");
  assert.equal(call!.args[0], "exec");
  assert.equal(call!.args[call!.args.indexOf("-C") + 1], req.worktree);
  assert.equal(call!.args[call!.args.indexOf("-s") + 1], "read-only");
  assert.equal(call!.args.at(-1), "-");
  assert.ok(!call!.args.includes("--add-dir"), "a read-only run gets no extra writable folder");
  assert.equal(call!.opts.cwd, req.worktree);
  assert.equal(call!.opts.signal, req.signal);
  assert.equal(call!.opts.env!.DO_NOT_TRACK, "1");
  assert.match(call!.opts.input!, /^You review code\.\n\n---\n\n/);
  assert.match(call!.opts.input!, /Your final message is your output \(review\)/);
  done();
});

test("a role with no sandbox of its own falls back to read-only", async () => {
  const { req, done } = setup();
  const { calls, run } = fakeCodex((args) => writeFileSync(lastMessageFile(args), "ok"));
  await codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("") } }).run(req);
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf("-s") + 1], "read-only");
  done();
});

test("the request's onSpawn reaches the process runner", async () => {
  const onSpawn = () => {};
  const { req, done } = setup({ onSpawn });
  const { calls, run } = fakeCodex((args) => writeFileSync(lastMessageFile(args), "NO FINDINGS\n"));
  await codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("read-only") } }).run(req);
  assert.equal(calls[0]!.opts.onSpawn, onSpawn);
  done();
});

test("a writing role gets the node folder, its input files' folders and the installed docs as writable, and its output files are checked like a Claude agent's", async () => {
  const { req, done } = setup({ role: "write-tests", outputs: ["tests"], inputs: { brief: { schema: "files", files: ["/run/store/brief/brief.md"] } } });
  const { calls, run } = fakeCodex(() => {
    mkdirSync(join(req.outDir, "tests"), { recursive: true });
    writeFileSync(join(req.outDir, "tests", "a.test.ts"), "x");
  });
  const result = await codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("workspace-write") } }).run(req);
  assert.deepEqual(result, { status: "done", files: { tests: [join(req.outDir, "tests", "a.test.ts")] } });
  const args = calls[0]!.args;
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  assert.equal(args[args.indexOf("--add-dir") + 1], join(req.outDir, ".."));
  assert.deepEqual(args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]!] : [])), agentDirs(req), "the same folders a Claude agent gets");
  assert.ok(args.includes("/run/store/brief"), "an input file's folder");
  assert.match(calls[0]!.opts.input!, /Write each output as files/);
  done();
});

test("a writing role that leaves an output out breaks the contract", async () => {
  const { req, done } = setup({ role: "write-tests", outputs: ["tests"] });
  const { run } = fakeCodex(() => {});
  await assert.rejects(codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("workspace-write") } }).run(req), ContractError);
  done();
});

test("a read-only role cannot hand back two outputs", async () => {
  const { req, done } = setup({ outputs: ["a", "b"] });
  const { calls, run } = fakeCodex(() => {});
  await assert.rejects(codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("read-only") } }).run(req), (e: unknown) => e instanceof ContractError && /one output/.test(e.message));
  assert.equal(calls.length, 0, "refused before codex ran");
  done();
});

test("an empty or missing final message breaks the contract", async () => {
  const { req, done } = setup();
  for (const act of [(args: string[]) => writeFileSync(lastMessageFile(args), "  \n"), () => {}]) {
    const { run } = fakeCodex(act);
    await assert.rejects(codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("read-only") } }).run(req), (e: unknown) => e instanceof ContractError && /no final message/.test(e.message));
  }
  assert.equal(existsSync(join(req.outDir, "review", "report.md")), false);
  done();
});

test("a role neither a toml nor agents.json knows is a run error, not a retry", async () => {
  const { req, done } = setup();
  const { run } = fakeCodex(() => {});
  await assert.rejects(codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => null, repoRole: () => null } }).run(req), RunError);
  done();
});

test("a non-zero exit fails with the end of stderr", async () => {
  const { req, done } = setup();
  const { run } = fakeCodex(() => {}, { code: 2, stdout: "", stderr: "model not found", output: "" });
  await assert.rejects(codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("read-only") } }).run(req), /codex exited 2: model not found/);
  done();
});

test("a timeout or cancel is the runner's rejection, passed through", async () => {
  const { req, done } = setup();
  const reason = new Error("cancelled");
  const run = async (): Promise<ProcessResult> => {
    throw reason;
  };
  await assert.rejects(codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("read-only") } }).run(req), (e: unknown) => e === reason);
  done();
});

test("a stale final message from an earlier attempt is never taken as this attempt's output", async () => {
  const { req, done } = setup();
  const roles = { readRole: () => roleToml("read-only") };
  const first = fakeCodex((args) => writeFileSync(lastMessageFile(args), "attempt one's message"), { code: 1, stdout: "", stderr: "died", output: "" });
  await assert.rejects(codexAgent({ adapter: "codex" }, { run: first.run, roles }).run(req), /codex exited 1/);
  const second = fakeCodex(() => {});
  await assert.rejects(codexAgent({ adapter: "codex" }, { run: second.run, roles }).run(req), (e: unknown) => e instanceof ContractError && /no final message/.test(e.message));
  assert.equal(existsSync(join(req.outDir, "review", "report.md")), false);
  done();
});

test("the codex process gets no adapter or forge token and an empty gh config folder", async () => {
  const { req, done } = setup();
  let seen: NodeJS.ProcessEnv | undefined;
  const { run } = fakeCodex((args) => writeFileSync(lastMessageFile(args), "ok"));
  const spy = async (c: string, a: string[], o: ProcessOptions) => ((seen = o.env), run(c, a, o));
  const env = { PATH: "/bin", GH_TOKEN: "a", GITHUB_TOKEN: "b", TYPESAFE_API_KEY: "c", LINEAR_API_KEY: "d", GH_CONFIG_DIR: "/home/me/.config/gh" };
  await codexAgent({ adapter: "codex" }, { run: spy, roles: { readRole: () => roleToml("read-only") }, env }).run(req);
  assert.deepEqual(Object.keys(seen!).sort(), ["DO_NOT_TRACK", "GH_CONFIG_DIR", "PATH"]);
  assert.equal(seen!.GH_CONFIG_DIR, join(req.outDir, "..", "gh-config"));
  assert.deepEqual(readdirSync(seen!.GH_CONFIG_DIR!), []);
  done();
});

test("a binding's role names the Codex role a graph role runs; one that resolves nowhere is named at start", () => {
  const roles = { readRole: () => null, repoRole: (r: string) => (r === "review" ? { model: "m", effort: "high", instructions: "read", projectDocs: true, sandbox: "read-only" as const } : null) };
  assert.equal(codexRoleMissing({ adapter: "codex", role: "review" }, "review-codex", tmpdir(), roles), null);
  assert.match(codexRoleMissing({ adapter: "codex" }, "review-codex", tmpdir(), roles)!, /^role review-codex runs the Codex role review-codex, which does not resolve/);
});

const events = (...e: unknown[]): string => `${e.map((x) => JSON.stringify(x)).join("\n")}\n`;

test("codex runs with --json, and the token counts of its turns are kept with the role's model in codex.json beside out/, with no price", async () => {
  const { req, done } = setup();
  const stdout = events(
    { type: "thread.started", thread_id: "t" },
    { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } },
    "not json at all",
    { type: "item.completed", item: { type: "agent_message", text: "hi" } },
    { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 70 } }
  );
  const { calls, run } = fakeCodex((args) => writeFileSync(lastMessageFile(args), "NO FINDINGS\n"), { code: 0, stdout, stderr: "", output: stdout });
  await codexAgent({ adapter: "codex" }, { run, roles: { readRole: () => roleToml("read-only") } }).run(req);
  const args = calls[0]!.args;
  assert.ok(args.includes("--json"));
  assert.ok(args.indexOf("--json") < args.indexOf("-o"), "an option, not the trailing prompt marker");
  assert.ok(existsSync(join(req.outDir, "..", CODEX_RESULT_FILE)));
  // input_tokens include the cached ones, so input is what was not cached.
  assert.deepEqual(readAgentUsage(join(req.outDir, "..")), { model: "gpt-test", tokens: { input: 800, output: 120, cacheRead: 700, cacheWrite: 0 }, costUsd: null });
  done();
});

test("a codex run whose events held no completed turn keeps null tokens, not zeros, and a failed run keeps what it printed", async () => {
  const quiet = setup();
  const a = fakeCodex((args) => writeFileSync(lastMessageFile(args), "ok"), { code: 0, stdout: events({ type: "thread.started" }), stderr: "", output: "" });
  await codexAgent({ adapter: "codex" }, { run: a.run, roles: { readRole: () => roleToml("read-only") } }).run(quiet.req);
  assert.equal(readAgentUsage(join(quiet.req.outDir, "..")).tokens, null);
  quiet.done();

  const failed = setup();
  const stdout = events({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  const b = fakeCodex(() => {}, { code: 1, stdout, stderr: "boom", output: "" });
  await assert.rejects(codexAgent({ adapter: "codex" }, { run: b.run, roles: { readRole: () => roleToml("read-only") } }).run(failed.req), /codex exited 1/);
  assert.deepEqual(readAgentUsage(join(failed.req.outDir, "..")).tokens, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  failed.done();
});
