import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fileForge, fileTracker } from "../adapters/fileFakes.ts";
import { fileRunStore } from "../adapters/fileRunStore.ts";
import { inputsFile } from "../adapters/agentIo.ts";
import { fixtureKey, stubAgent } from "../adapters/stubAgent.ts";
import { stubAnswer, stubCheck, stubClassifier } from "../adapters/stubAnswers.ts";
import { ContractError, type DataValues, RunError, type RunPlace } from "../contracts.ts";
import { bundleText, runDataOp } from "../dataOps.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "graph-adapters-"));
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const signal = new AbortController().signal;

// ---- stubAnswer ----

test("a role absent from the map gets the default, including a name like 'toString'", () => {
  const b = { adapter: "stub" as const, answers: { a: "x" }, default: "dflt" };
  assert.equal(stubAnswer(b, "other", 1), "dflt");
  assert.equal(stubAnswer(b, "toString", 1), "dflt");
});

test("a fixed answer is the same on every iteration", () => {
  const b = { adapter: "stub" as const, answers: { a: "x" }, default: "d" };
  for (const i of [0, 1, 5]) assert.equal(stubAnswer(b, "a", i), "x");
});

test("a list is read by 1-based iteration, iteration 0 reads the first, and the last entry repeats", () => {
  const b = { adapter: "stub" as const, answers: { a: ["one", "two", "three"] }, default: "d" };
  assert.deepEqual([0, 1, 2, 3, 4, 99].map((i) => stubAnswer(b, "a", i)), ["one", "one", "two", "three", "three", "three"]);
});

test("an empty list falls back to the default", () => {
  assert.equal(stubAnswer({ adapter: "stub", answers: { a: [] as string[] }, default: "d" }, "a", 1), "d");
});

test("the stub classifier answers by its question and iteration, and callers cannot mutate the binding through it", async () => {
  const binding = { adapter: "stub" as const, answers: { q: [{ answer: "no", p: 0.1 }, { answer: "yes", p: 0.9 }] }, default: { answer: "dflt", p: 1 } };
  const c = stubClassifier(binding);
  assert.deepEqual(await c.classify({ question: "q", state: {}, iteration: 2, signal }), { answer: "yes", p: 0.9 });
  assert.deepEqual(await c.classify({ question: "zz", state: {}, iteration: 1, signal }), { answer: "dflt", p: 1 });
  const got = await c.classify({ question: "q", state: {}, iteration: 1, signal });
  got.answer = "changed";
  assert.equal(binding.answers.q[0]!.answer, "no");
});

test("the stub check answers by role and iteration and says so in its detail", async () => {
  const c = stubCheck({ adapter: "stub", answers: { tests: ["fail", "pass"] }, default: "pass" });
  const signal = new AbortController().signal;
  const place = { runDir: "/r", worktree: "/w", branch: "b", baseSha: "s" };
  const checkReq = { inputs: {}, worktree: "/w", baseSha: "0", signal, outputs: [], outDir: "/r/o", place, formats: {}, nodeId: "n" };
  assert.deepEqual(await c.run({ ...checkReq, role: "tests", iteration: 1 }), { answer: "fail", detail: "stub check tests: fail on iteration 1" });
  assert.equal((await c.run({ ...checkReq, role: "tests", iteration: 2 })).answer, "pass");
  assert.equal((await c.run({ ...checkReq, role: "lint", iteration: 1 })).answer, "pass");
});

// ---- fileRunStore ----

test("the run store round-trips a record, nests keys, and reads a missing key as undefined", () => {
  const dir = tmp();
  const store = fileRunStore(dir);
  store.write("a", { n: 1 });
  store.write("nodes/plan.1", [1, 2]);
  assert.deepEqual(store.read("a"), { n: 1 });
  assert.deepEqual(store.read("nodes/plan.1"), [1, 2]);
  assert.equal(store.read("nope"), undefined);
  assert.equal(store.path("out/plan"), join(dir, "out/plan"));
  assert.ok(existsSync(join(dir, "a.json")));
  rmSync(dir, { recursive: true });
});

test("the run store refuses keys that could leave its folder, on read, write and path", () => {
  const dir = tmp();
  const store = fileRunStore(dir);
  for (const key of ["../x", "a/../../x", "/abs", "a//b", "", ".", "a/./b", "a b", "a\\b", "a/"]) {
    assert.throws(() => store.write(key, 1), /plain names/, `write ${JSON.stringify(key)}`);
    assert.throws(() => store.read(key), /plain names/, `read ${JSON.stringify(key)}`);
    assert.throws(() => store.path(key), /plain names/, `path ${JSON.stringify(key)}`);
  }
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true });
});

// ---- stubAgent ----

const request = (over: Record<string, unknown> = {}) => {
  const root = tmp();
  const fixtureDir = join(root, "fx");
  const outDir = join(root, "out");
  const worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-q", worktree]);
  mkdirSync(join(fixtureDir, "planner", "plan", "sub"), { recursive: true });
  writeFileSync(join(fixtureDir, "planner", "plan", "a.md"), "A");
  writeFileSync(join(fixtureDir, "planner", "plan", "sub", "b.md"), "B");
  return {
    root,
    fixtureDir,
    outDir,
    worktree,
    req: { runId: "r", nodeId: "A-plan", role: "planner", inputs: {}, answers: [], outputs: ["plan"], outDir, worktree, writes: true, attempt: 1, iteration: 0, signal: new AbortController().signal, ...over },
  };
};

test("the stub agent copies the role's fixture folder into each output and lists the files, sorted", async () => {
  const t = request();
  const res = await stubAgent({ adapter: "stub", fixtureDir: t.fixtureDir }).run(t.req);
  assert.deepEqual(res, { status: "done", files: { plan: [join(t.outDir, "plan", "a.md"), join(t.outDir, "plan", "sub", "b.md")] } });
  assert.equal(readFileSync(join(t.outDir, "plan", "sub", "b.md"), "utf8"), "B");
  rmSync(t.root, { recursive: true });
});

test("a missing fixture folder is a ContractError naming the role, output and path", async () => {
  const t = request({ outputs: ["plan", "ghost"] });
  await assert.rejects(stubAgent({ adapter: "stub", fixtureDir: t.fixtureDir }).run(t.req), (e: unknown) => {
    assert.ok(e instanceof ContractError);
    assert.match(e.message, /stub agent planner/);
    assert.match(e.message, /ghost/);
    assert.match(e.message, new RegExp(join(t.fixtureDir, "planner", "ghost").replaceAll("/", "\\/")));
    return true;
  });
  rmSync(t.root, { recursive: true });
});

test("a fixture that is a file, not a folder, is refused too", async () => {
  const t = request();
  writeFileSync(join(t.fixtureDir, "planner", "flat"), "x");
  await assert.rejects(stubAgent({ adapter: "stub", fixtureDir: t.fixtureDir }).run({ ...t.req, outputs: ["flat"] }), ContractError);
  rmSync(t.root, { recursive: true });
});

test("with ask the agent asks until the node holds an answer, then runs", async () => {
  const t = request();
  const agent = stubAgent({ adapter: "stub", fixtureDir: t.fixtureDir, ask: "which db?" });
  assert.deepEqual(await agent.run(t.req), { status: "needs-operator", question: "which db?" });
  assert.equal(existsSync(t.outDir), false, "asking writes no output");
  assert.equal((await agent.run({ ...t.req, answers: ["sqlite"] })).status, "done");
  rmSync(t.root, { recursive: true });
});

test("hangOnAttempts hangs only the listed attempts, leaves a stray file, and ends when aborted", async () => {
  const t = request();
  const agent = stubAgent({ adapter: "stub", fixtureDir: t.fixtureDir, hangOnAttempts: [1] });
  const ac = new AbortController();
  const pending = agent.run({ ...t.req, attempt: 1, iteration: 0, signal: ac.signal });
  let settled = false;
  pending.then(() => (settled = true), () => (settled = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, "still hanging");
  assert.equal(readFileSync(join(t.worktree, ".stub-planner-attempt-1"), "utf8"), "left by a hung attempt\n");
  const committed = execFileSync("git", ["show", "--name-only", "--format=%s", "HEAD"], { cwd: t.worktree, encoding: "utf8" });
  assert.match(committed, /half-made work of attempt 1\n\n\.stub-planner-attempt-1/, "the hung attempt committed its half-made work");
  ac.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.equal((await agent.run({ ...t.req, attempt: 2 })).status, "done");
  assert.equal(existsSync(join(t.worktree, ".stub-planner-attempt-2")), false);
  rmSync(t.root, { recursive: true });
});

test("a hang with an already-aborted signal rejects at once", async () => {
  const t = request();
  const ac = new AbortController();
  ac.abort(new Error("early"));
  await assert.rejects(stubAgent({ adapter: "stub", fixtureDir: t.fixtureDir, hangOnAttempts: [1] }).run({ ...t.req, signal: ac.signal }), /early/);
  rmSync(t.root, { recursive: true });
});

test("an agent dispatch carries a writer conflict only when the workflow handed it one", () => {
  const t = request();
  const conflict = { commit: "123456789abcdef", paths: ["graph/a.ts"], restart: 1 };
  assert.deepEqual(inputsFile({ ...t.req, conflict }).conflict, conflict);
  assert.equal("conflict" in inputsFile(t.req), false);
  rmSync(t.root, { recursive: true });
});

test("fixture keys isolate each writer and service fresh run from its earlier fixture", () => {
  const conflict = (restart: number) => ({ commit: "123456789abcdef", paths: ["graph/a.ts"], restart });
  const question = { id: "Q1", type: "brief" as const, text: "Which head?", searched: [] };
  assert.equal(fixtureKey({ instance: "P2", iteration: 0, conflict: conflict(1) }), "P2@restart-1");
  assert.equal(fixtureKey({ iteration: 0, question, conflict: conflict(2) }), "Q1@restart-2");
  assert.equal(fixtureKey({ iteration: 1, conflict: conflict(1) }), "1@restart-1");
  assert.equal(fixtureKey({ instance: "P2", iteration: 0 }), "P2");
  assert.equal(fixtureKey({ iteration: 0, question }), "Q1");
  assert.equal(fixtureKey({ iteration: 1 }), "1");
  assert.equal(fixtureKey({ iteration: 0 }), undefined);
});

// ---- file tracker and forge ----

test("the file tracker files numbered tickets as JSON and returns refs with file URLs", async () => {
  const dir = tmp();
  const tracker = fileTracker(dir);
  const a = await tracker.file({ title: "t1", body: "b1" }, signal);
  const b = await tracker.file({ title: "t2", body: "b2" }, signal);
  assert.equal(a.kind, "ticket");
  assert.deepEqual([a.id, b.id], ["T-1", "T-2"]);
  assert.match(a.url!, /^file:\/\/.*1\.json$/);
  assert.deepEqual(json(join(dir, "filed", "2.json")), { title: "t2", body: "b2" });
  rmSync(dir, { recursive: true });
});

test("the file tracker ingests a seeded ticket, defaults missing fields to empty, and refuses a missing or path-like id", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "tickets"));
  writeFileSync(join(dir, "tickets", "ABC-1.json"), JSON.stringify({ title: "T", body: "B" }));
  writeFileSync(join(dir, "tickets", "bare.json"), "{}");
  const tracker = fileTracker(dir);
  assert.deepEqual(await tracker.ingest("ABC-1", signal), { id: "ABC-1", title: "T", body: "B" });
  assert.deepEqual(await tracker.ingest("bare", signal), { id: "bare", title: "", body: "" });
  await assert.rejects(tracker.ingest("NOPE-9", signal), /no .*NOPE-9\.json/);
  for (const bad of ["../secret", "a/b", "", "a b"]) await assert.rejects(tracker.ingest(bad, signal), /not a ticket id/);
  rmSync(dir, { recursive: true });
});

const gitRepo = (): { dir: string; sha: string } => {
  const dir = tmp();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "f"), "x");
  git("add", "f");
  git("commit", "-q", "-m", "init");
  return { dir, sha: git("rev-parse", "HEAD").trim() };
};

test("the file forge pushes the worktree's HEAD sha, records the branch, and numbers PRs from 1", async () => {
  const repo = gitRepo();
  const dir = tmp();
  const forge = fileForge(dir);
  const pushed = await forge.push({ worktree: repo.dir, branch: "feat/x", signal });
  assert.deepEqual(pushed, { schema: "ref", kind: "commit", id: repo.sha });
  assert.deepEqual(json(join(dir, "pushes", "1.json")), { branch: "feat/x", sha: repo.sha });
  const pr1 = await forge.openPr({ worktree: repo.dir, branch: "feat/x", title: "t", body: "b", signal });
  const pr2 = await forge.openPr({ worktree: repo.dir, branch: "feat/y", title: "t2", body: "b2", signal });
  assert.deepEqual([pr1.kind, pr1.id, pr2.id], ["pr", "1", "2"]);
  assert.deepEqual(json(join(dir, "prs", "2.json")), { branch: "feat/y", title: "t2", body: "b2", draft: false, merged: false });
  rmSync(dir, { recursive: true });
  rmSync(repo.dir, { recursive: true });
});

test("the file forge merges only the named PR, and refuses a non-numeric or unknown PR", async () => {
  const repo = gitRepo();
  const dir = tmp();
  const forge = fileForge(dir);
  await forge.openPr({ worktree: repo.dir, branch: "a", title: "t", body: "b", signal });
  await forge.openPr({ worktree: repo.dir, branch: "b", title: "t", body: "b", signal });
  const merged = await forge.merge({ worktree: dir, pr: "2", signal });
  assert.deepEqual([merged.kind, merged.id], ["merge", "2"]);
  assert.equal(json(join(dir, "prs", "2.json")).merged, true);
  assert.equal(json(join(dir, "prs", "1.json")).merged, false);
  await assert.rejects(forge.merge({ worktree: dir, pr: "9", signal }), /no .*9\.json/);
  for (const bad of ["../x", "1.5", "", "a1"]) await assert.rejects(forge.merge({ worktree: dir, pr: bad, signal }), /not a PR number/);
  rmSync(dir, { recursive: true });
  rmSync(repo.dir, { recursive: true });
});

test("a push from a directory that is not a repo fails", async () => {
  const dir = tmp();
  const notRepo = tmp();
  await assert.rejects(fileForge(dir).push({ worktree: notRepo, branch: "b", signal }));
  assert.equal(existsSync(join(dir, "pushes")), false, "nothing recorded for a failed push");
  rmSync(dir, { recursive: true });
  rmSync(notRepo, { recursive: true });
});

// ---- dataOps ----

test("bundleText sorts sections by id and renders each schema", () => {
  const dir = tmp();
  const f = join(dir, "a.md");
  writeFileSync(f, "file body\n\n");
  const inputs: DataValues = {
    z: { schema: "text", text: "zed" },
    verdict: { schema: "verdict", answer: "yes", p: 0.7 },
    chk: { schema: "check", answer: "fail", detail: "3 red" },
    r1: { schema: "ref", kind: "pr", id: "4", url: "http://x/4" },
    r2: { schema: "ref", kind: "ticket", id: "T-1" },
    files: { schema: "files", files: [f, f] },
    out: { schema: "outcome", answer: "clean" },
  };
  assert.equal(
    bundleText(inputs),
    ["## chk\n\nfail: 3 red", "## files\n\nfile body\n\nfile body", "## out\n\nclean", "## r1\n\npr 4 http://x/4", "## r2\n\nticket T-1", "## verdict\n\nyes (p=0.7)", "## z\n\nzed"].join("\n\n"),
  );
  assert.equal(bundleText({}), "");
  rmSync(dir, { recursive: true });
});

test("a declared file that cannot be read fails the bundle instead of publishing a placeholder", () => {
  const dir = tmp();
  const gone = join(dir, "gone.md");
  assert.throws(() => bundleText({ files: { schema: "files", files: [gone] } }), (e: unknown) => e instanceof ContractError && e.message.includes(gone));
  rmSync(dir, { recursive: true });
});

const ops = () => {
  const dir = tmp();
  const place: RunPlace = { runDir: dir, worktree: dir, branch: "g/branch", baseSha: "0" };
  const ctx = (inputs: DataValues, over: Record<string, unknown> = {}) => ({
    runId: "g-1",
    nodeId: "n",
    inputs,
    place,
    tracker: fileTracker(join(dir, "tracker")),
    forge: fileForge(join(dir, "forge")),
    signal,
    ...over,
  });
  return { dir, ctx };
};

test("ingest reads the ticket named by the text input and returns title and body as text", async () => {
  const { dir, ctx } = ops();
  mkdirSync(join(dir, "tracker", "tickets"), { recursive: true });
  writeFileSync(join(dir, "tracker", "tickets", "ABC-1.json"), JSON.stringify({ title: "Fix it", body: "Details" }));
  const out = await runDataOp("ingest", ctx({ request: { schema: "text", text: "  ABC-1\n" } }));
  assert.deepEqual(out, { schema: "text", text: "Fix it\n\nDetails" });
  rmSync(dir, { recursive: true });
});

test("ingest with no text input, or a blank one, fails naming the node", async () => {
  const { dir, ctx } = ops();
  await assert.rejects(runDataOp("ingest", ctx({})), /ingest n: no text input/);
  await assert.rejects(runDataOp("ingest", ctx({ r: { schema: "text", text: "   " } })), /ingest n: no text input/);
  await assert.rejects(runDataOp("ingest", ctx({ r: { schema: "ref", kind: "pr", id: "1" } })), /no text input/);
  rmSync(dir, { recursive: true });
});

test("ticket files the bundled inputs under a run-and-node title", async () => {
  const { dir, ctx } = ops();
  const out = await runDataOp("ticket", ctx({ b: { schema: "text", text: "B" }, a: { schema: "text", text: "A" } }));
  assert.ok(!("conflict" in out));
  assert.deepEqual([out.schema, (out as { id: string }).id], ["ref", "T-1"]);
  assert.deepEqual(json(join(dir, "tracker", "filed", "1.json")), { title: "g-1: n", body: "## a\n\nA\n\n## b\n\nB" });
  rmSync(dir, { recursive: true });
});

test("push sends the place's worktree and branch to the forge", async () => {
  const repo = gitRepo();
  const { dir, ctx } = ops();
  const out = await runDataOp("push", ctx({}, { place: { runDir: dir, worktree: repo.dir, branch: "g/branch", baseSha: "0" } }));
  assert.deepEqual(out, { schema: "ref", kind: "commit", id: repo.sha });
  assert.equal(json(join(dir, "forge", "pushes", "1.json")).branch, "g/branch");
  rmSync(dir, { recursive: true });
  rmSync(repo.dir, { recursive: true });
});

test("pr opens a PR for the place's branch with the bundled inputs as its body", async () => {
  const { dir, ctx } = ops();
  const out = await runDataOp("pr", ctx({ t: { schema: "text", text: "T" } }));
  assert.equal((out as { kind: string }).kind, "pr");
  assert.deepEqual(json(join(dir, "forge", "prs", "1.json")), { branch: "g/branch", title: "g-1: n", body: "## t\n\nT", draft: false, merged: false });
  rmSync(dir, { recursive: true });
});

test("merge merges the PR the inputs reference, ignoring other refs, and fails with no PR input", async () => {
  const { dir, ctx } = ops();
  await runDataOp("pr", ctx({}));
  await runDataOp("pr", ctx({}));
  const out = await runDataOp("merge", ctx({ ticket: { schema: "ref", kind: "ticket", id: "1" }, pr: { schema: "ref", kind: "pr", id: "2" }, tests: { schema: "check", answer: "pass", detail: "ok" } }));
  assert.deepEqual([(out as { kind: string }).kind, (out as { id: string }).id], ["merge", "2"]);
  assert.equal(json(join(dir, "forge", "prs", "2.json")).merged, true);
  assert.equal(json(join(dir, "forge", "prs", "1.json")).merged, false);
  await assert.rejects(runDataOp("merge", ctx({ ticket: { schema: "ref", kind: "ticket", id: "1" } })), /merge n: no input is a PR/);
  await assert.rejects(runDataOp("merge", ctx({})), /no input is a PR/);
  rmSync(dir, { recursive: true });
});

test("comment adds the other inputs, bundled, to the ticket the ref input names", async () => {
  const { dir, ctx } = ops();
  const out = await runDataOp("comment", ctx({ ticket: { schema: "ref", kind: "ticket", id: "T-4" }, report: { schema: "text", text: "PR is up" } }));
  assert.deepEqual([(out as { kind: string }).kind, (out as { id: string }).id], ["ticket", "T-4"]);
  assert.deepEqual(json(join(dir, "tracker", "comments", "1.json")), { ref: "T-4", body: "## report\n\nPR is up" });
  rmSync(dir, { recursive: true });
});

test("comment fails with no ticket ref, or with nothing to say besides it", async () => {
  const { dir, ctx } = ops();
  await assert.rejects(runDataOp("comment", ctx({ pr: { schema: "ref", kind: "pr", id: "1" }, t: { schema: "text", text: "x" } })), /comment n: no input is a ticket/);
  await assert.rejects(runDataOp("comment", ctx({ ticket: { schema: "ref", kind: "ticket", id: "T-4" } })), /no input besides the ticket/);
  rmSync(dir, { recursive: true });
});

test("merge asks the forge to merge only when every check among its inputs passed, with the worktree and signal", async () => {
  const { dir, ctx } = ops();
  const seen: { worktree: string; pr: string; signal: AbortSignal }[] = [];
  const forge = { ...fileForge(join(dir, "forge")), merge: async (r: (typeof seen)[number]) => (seen.push(r), { schema: "ref" as const, kind: "merge" as const, id: r.pr }) };
  const pr = { schema: "ref" as const, kind: "pr" as const, id: "7" };
  const pass = { schema: "check" as const, answer: "pass" as const, detail: "ok" };
  const fail = { schema: "check" as const, answer: "fail" as const, detail: "red" };
  await runDataOp("merge", ctx({ pr, tests: pass, note: { schema: "text", text: "x" } }, { forge }));
  assert.deepEqual([seen.length, seen[0]!.pr, seen[0]!.worktree, seen[0]!.signal], [1, "7", dir, signal]);
  await assert.rejects(runDataOp("merge", ctx({ pr, note: { schema: "text", text: "x" } }, { forge })), (e: unknown) => e instanceof RunError && /refusing to merge PR 7: no gate data/.test(e.message));
  await assert.rejects(runDataOp("merge", ctx({ pr, tests: pass, lint: fail }, { forge })), (e: unknown) => e instanceof RunError && /refusing to merge PR 7: 1 of 2 gate checks did not pass/.test(e.message));
  assert.equal(seen.length, 1, "a red or empty gate never reaches the forge");
  rmSync(dir, { recursive: true });
});

// ---- stubAgent: recorded commits ----

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A writer's worktree at one commit, and a fixture holding the patches of the commits made on top of it. */
function writerWorld(makeCommits: (repo: string) => void) {
  const root = tmp();
  const source = join(root, "source");
  mkdirSync(source);
  gitIn(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "a.txt"), "a\n");
  gitIn(source, "add", "-A");
  gitIn(source, "commit", "-q", "-m", "base");
  const worktree = join(root, "wt");
  gitIn(root, "clone", "-q", source, worktree);
  makeCommits(source);
  const patches = join(root, "fx", "writer", "part-commit");
  mkdirSync(patches, { recursive: true });
  gitIn(source, "format-patch", "-q", "--no-signature", "-o", patches, "HEAD~1..HEAD");
  const req = {
    runId: "r",
    nodeId: "A-writer",
    role: "writer",
    inputs: {},
    answers: [],
    outputs: [] as string[],
    outDir: join(root, "out"),
    worktree,
    writes: true,
    attempt: 1,
    iteration: 0,
    commits: "part-commit",
    signal: new AbortController().signal,
  };
  return { root, worktree, req, fixtureDir: join(root, "fx") };
}

test("a recorded empty commit is replayed as an empty commit with its message, not refused as an empty patch", async () => {
  const w = writerWorld((source) => gitIn(source, "commit", "-q", "--allow-empty", "-m", "amend brief: say twice"));
  const before = gitIn(w.worktree, "rev-parse", "HEAD");
  const res = await stubAgent({ adapter: "stub", fixtureDir: w.fixtureDir }).run(w.req);
  assert.equal(res.status, "done");
  assert.equal(gitIn(w.worktree, "rev-list", "--count", `${before}..HEAD`), "1");
  assert.equal(gitIn(w.worktree, "log", "-1", "--format=%s"), "amend brief: say twice");
  assert.equal(gitIn(w.worktree, "diff", "--name-only", `${before}..HEAD`), "", "the commit changes no file");
  rmSync(w.root, { recursive: true });
});

test("recorded commits apply in name order, an empty one between two changes keeping its place", async () => {
  const root = tmp();
  const source = join(root, "source");
  mkdirSync(source);
  gitIn(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "a.txt"), "a\n");
  gitIn(source, "add", "-A");
  gitIn(source, "commit", "-q", "-m", "base");
  const worktree = join(root, "wt");
  gitIn(root, "clone", "-q", source, worktree);
  writeFileSync(join(source, "a.txt"), "a\nb\n");
  gitIn(source, "commit", "-q", "-am", "first");
  gitIn(source, "commit", "-q", "--allow-empty", "-m", "marker");
  writeFileSync(join(source, "a.txt"), "a\nb\nc\n");
  gitIn(source, "commit", "-q", "-am", "third");
  const patches = join(root, "fx", "writer", "part-commit");
  mkdirSync(patches, { recursive: true });
  gitIn(source, "format-patch", "-q", "--no-signature", "-o", patches, "HEAD~3..HEAD");
  const res = await stubAgent({ adapter: "stub", fixtureDir: join(root, "fx") }).run({
    runId: "r", nodeId: "A-writer", role: "writer", inputs: {}, answers: [], outputs: [], outDir: join(root, "out"), worktree, writes: true, attempt: 1, iteration: 0, commits: "part-commit", signal,
  });
  assert.equal(res.status, "done");
  assert.deepEqual(gitIn(worktree, "log", "--format=%s", "-3").split("\n"), ["third", "marker", "first"]);
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "a\nb\nc\n");
  rmSync(root, { recursive: true });
});

test("recorded commits that do not apply are a ContractError and leave the worktree as it was, no am in progress", async () => {
  const w = writerWorld((source) => {
    writeFileSync(join(source, "a.txt"), "changed\n");
    gitIn(source, "commit", "-q", "-am", "edit a");
  });
  writeFileSync(join(w.worktree, "a.txt"), "diverged\n");
  gitIn(w.worktree, "commit", "-q", "-am", "diverge");
  const head = gitIn(w.worktree, "rev-parse", "HEAD");
  await assert.rejects(stubAgent({ adapter: "stub", fixtureDir: w.fixtureDir }).run(w.req), (e: unknown) => e instanceof ContractError && /do not apply at/.test(e.message));
  assert.equal(gitIn(w.worktree, "rev-parse", "HEAD"), head);
  assert.ok(!existsSync(join(w.worktree, ".git", "rebase-apply")), "the failed am was aborted");
  rmSync(w.root, { recursive: true });
});
