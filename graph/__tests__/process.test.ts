import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { childEnv, groupAlive, runProcess, terminateGroup } from "../adapters/process.ts";
import { PROCESS_OUTPUT_KEEP_CHARS } from "../constants.ts";

const live = (): AbortSignal => new AbortController().signal;

/** Poll `done` until it holds, or fail after `ms`. */
async function until(done: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(20);
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a process's exit code and both streams are captured, and the streams are also kept interleaved", async () => {
  const r = await runProcess("sh", ["-c", "echo out; echo err >&2; exit 3"], { signal: live() });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "out\n");
  assert.equal(r.stderr, "err\n");
  assert.equal(r.output.split("\n").filter((l) => l !== "").sort().join(","), "err,out");
});

test("input goes to stdin, which then closes", async () => {
  const r = await runProcess("cat", [], { input: "hello", signal: live() });
  assert.deepEqual([r.code, r.stdout], [0, "hello"]);
});

test("onSpawn is called once with the pid of the child's own live process group", async () => {
  const ctl = new AbortController();
  const pids: number[] = [];
  const running = runProcess("sleep", ["60"], { signal: ctl.signal, onSpawn: (pid) => pids.push(pid) });
  assert.equal(pids.length, 1);
  assert.ok(groupAlive(pids[0]!));
  ctl.abort(new Error("done"));
  await assert.rejects(running, /done/);
  assert.equal(groupAlive(pids[0]!), false);
});

test("terminateGroup ends a group that no runProcess holds, as the retry of a dead worker's attempt needs", async () => {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise((resolve) => child.once("spawn", resolve));
  assert.ok(groupAlive(child.pid!));
  await terminateGroup(child.pid!);
  assert.equal(groupAlive(child.pid!), false);
});

test("a program that cannot start rejects with the spawn error", async () => {
  await assert.rejects(runProcess("definitely-not-a-program-xyz", [], { signal: live() }), { code: "ENOENT" });
});

test("an abort rejects with its reason and kills the whole process group, a grandchild too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-proc-"));
  const pidFile = join(dir, "grandchild.pid");
  const ctl = new AbortController();
  const running = runProcess("sh", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], { signal: ctl.signal });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the grandchild's pid");
  const grandchild = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(alive(grandchild));
  const reason = new Error("time cap reached");
  ctl.abort(reason);
  await assert.rejects(running, (e: unknown) => e === reason);
  await until(() => !alive(grandchild), "the grandchild to die");
  rmSync(dir, { recursive: true });
});

test("a signal already aborted rejects without starting the process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-proc-"));
  const marker = join(dir, "started");
  const ctl = new AbortController();
  ctl.abort(new Error("late"));
  await assert.rejects(runProcess("sh", ["-c", `touch ${marker}`], { signal: ctl.signal }), /late/);
  assert.equal(existsSync(marker), false);
  rmSync(dir, { recursive: true });
});

test("an abort rejects only once nothing of the group is left: a child that ignores SIGTERM, and a grandchild that outlives a leader that exits on it", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-proc-"));
  const stubborn = join(dir, "stubborn.pid");
  const orphan = join(dir, "orphan.pid");
  const ctl = new AbortController();
  const ignoresTerm = runProcess("sh", ["-c", `trap '' TERM; echo $$ > ${stubborn}; while true; do sleep 1; done`], { signal: ctl.signal });
  // the leader dies on SIGTERM; the sh it started ignores it and holds no pipe the leader waits on
  const leaderDies = runProcess("sh", ["-c", `sh -c "trap '' TERM; echo \\$\\$ > ${orphan}; while true; do sleep 1; done" > /dev/null 2>&1 & wait`], { signal: ctl.signal });
  const settled = Promise.allSettled([ignoresTerm, leaderDies]);
  const pidOf = (f: string) => Number(readFileSync(f, "utf8").trim());
  await until(() => [stubborn, orphan].every((f) => existsSync(f) && readFileSync(f, "utf8").trim() !== ""), "both pids");
  const pids = [pidOf(stubborn), pidOf(orphan)];
  assert.ok(pids.every(alive));
  ctl.abort(new Error("stop"));
  const results = await settled;
  assert.deepEqual(results.map((r) => (r.status === "rejected" ? String(r.reason.message) : "resolved")), ["stop", "stop"]);
  assert.deepEqual(pids.map(alive), [false, false], "both were already dead when the rejections arrived");
  rmSync(dir, { recursive: true });
});

test("output past the kept tail is dropped from the front, and the end is intact", async () => {
  const r = await runProcess("sh", ["-c", "i=0; while [ $i -lt 40 ]; do head -c 100000 /dev/zero | tr '\\0' x; i=$((i+1)); done; echo THE-END"], { signal: live() });
  assert.ok(r.stdout.length <= PROCESS_OUTPUT_KEEP_CHARS, String(r.stdout.length));
  assert.ok(r.stdout.endsWith("xxxTHE-END\n"));
  assert.ok(r.stdout.length > PROCESS_OUTPUT_KEEP_CHARS / 2);
});

test("a child never inherits the adapters' API keys, from our environment or from the one it is given", async () => {
  const given = { PATH: process.env.PATH, KEEP: "1", TYPESAFE_API_KEY: "secret-a", LINEAR_API_KEY: "secret-b" };
  assert.deepEqual(childEnv(given), { PATH: process.env.PATH, KEEP: "1" });
  const r = await runProcess("sh", ["-c", 'echo "[$KEEP][$TYPESAFE_API_KEY][$LINEAR_API_KEY]"'], { env: given, signal: live() });
  assert.equal(r.stdout, "[1][][]\n");
  process.env.LINEAR_API_KEY = "ours";
  try {
    assert.equal((await runProcess("sh", ["-c", 'echo "[$LINEAR_API_KEY]"'], { signal: live() })).stdout, "[]\n");
  } finally {
    delete process.env.LINEAR_API_KEY;
  }
});
