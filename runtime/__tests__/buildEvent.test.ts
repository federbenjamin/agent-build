import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { BUILD_EVENT_CMD, runBuildEvent } from "../buildEvent.ts";
import { BUILD_EVENT_FIELDS, BUILD_EVENT_NAMES, readBuildEvent } from "../lib/buildEvents.ts";
import type { ExecFn, RunOpts } from "../lib/gitOps.ts";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";
import { TSX_BIN } from "./helpers/tsxBin.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "buildEvent.ts");
const NOW = new Date("2026-10-06T12:00:00.000Z");
const PLAN_ARGV = ["plan", "--runid", "build-7", "--unit", "unit-1=Install"];
const PLAN_WIRE =
  '{"schema":1,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"plan","units":[{"id":"unit-1","title":"Install"}]}\n';

function deps(overrides: Partial<Parameters<typeof runBuildEvent>[1]> = {}) {
  return { env: {}, now: () => NOW, timeoutMs: 4321, ...overrides };
}

test("runBuildEvent: an unset consumer command exits successfully without running a process", () => {
  let calls = 0;
  const result = runBuildEvent(PLAN_ARGV, deps({ exec: () => (calls++, "") }));

  assert.deepEqual(result, { exit: 0, stderr: [] });
  assert.equal(calls, 0);
});

test("runBuildEvent: a configured consumer receives split argv, the event wire form, and the configured timeout", () => {
  let call: { cmd: string; args: string[]; opts: RunOpts } | undefined;
  const exec: ExecFn = (cmd, args, opts) => {
    call = { cmd, args, opts };
    return "consumer output ignored";
  };

  const result = runBuildEvent(
    PLAN_ARGV,
    deps({ env: { [BUILD_EVENT_CMD]: "consumer --mode record" }, exec })
  );

  assert.deepEqual(result, { exit: 0, stderr: [] });
  assert.ok(call);
  assert.equal(call.cmd, "consumer");
  assert.deepEqual(call.args, ["--mode", "record"]);
  assert.equal(call.opts.input, PLAN_WIRE);
  assert.equal(call.opts.timeout, 4321);
});

test("runBuildEvent: a consumer failure warns but does not fail the build, preferring captured stderr", () => {
  const plainFailure: ExecFn = () => {
    throw new Error("consumer unavailable");
  };
  const stderrFailure: ExecFn = () => {
    throw Object.assign(new Error("consumer unavailable"), { stderr: "consumer wrote this" });
  };

  const plain = runBuildEvent(PLAN_ARGV, deps({ env: { [BUILD_EVENT_CMD]: "consumer" }, exec: plainFailure }));
  const captured = runBuildEvent(PLAN_ARGV, deps({ env: { [BUILD_EVENT_CMD]: "consumer" }, exec: stderrFailure }));

  assert.equal(plain.exit, 0);
  assert.equal(plain.stderr.length, 1);
  assert.match(plain.stderr[0]!, /consumer unavailable/);
  assert.equal(captured.exit, 0);
  assert.equal(captured.stderr.length, 1);
  assert.match(captured.stderr[0]!, /consumer wrote this/);
});

test("runBuildEvent: usage and event-validation errors exit 2 before invoking a consumer", () => {
  let calls = 0;
  const exec: ExecFn = () => (calls++, "");

  const usage = runBuildEvent(["unknown", "--runid", "build-7"], deps({ env: { [BUILD_EVENT_CMD]: "consumer" }, exec }));
  const invalid = runBuildEvent(["plan", "--runid", "build-7"], deps({ env: { [BUILD_EVENT_CMD]: "consumer" }, exec }));

  assert.equal(usage.exit, 2);
  assert.ok(usage.stderr.length > 0);
  assert.equal(invalid.exit, 2);
  assert.equal(invalid.stderr.length, 1);
  assert.equal(calls, 0);
});

test("buildEvent entry point: no consumer command exits 0 without output", () => {
  const env = { ...process.env };
  delete env[BUILD_EVENT_CMD];
  const result = spawnSmoke(TSX_BIN, [SCRIPT, ...PLAN_ARGV], { cwd: ROOT, env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

const SAMPLE_FLAGS: Record<string, string[]> = {
  units: ["--unit", "u1=Install"],
  id: ["--id", "u1"],
  pr: ["--pr", "12"],
  needs: ["--needs", "answer Q1"],
  outcome: ["--outcome", "merged"],
};
const flagOf = (field: string) => (field === "units" ? "--unit" : `--${field}`);

test("runBuildEvent: every event takes exactly --runid and its own fields as flags, and sends each field", () => {
  const allFields = new Set<string>(Object.values(BUILD_EVENT_FIELDS).flat());
  for (const event of BUILD_EVENT_NAMES) {
    const fields: readonly string[] = BUILD_EVENT_FIELDS[event];
    const argv = [
      event,
      "--runid",
      "build-7",
      ...fields.flatMap((f) => {
        const sample = SAMPLE_FLAGS[f];
        assert.ok(sample, `no sample flag for field ${f}`);
        return sample;
      }),
    ];
    let input: string | undefined;
    const exec: ExecFn = (_cmd, _args, opts) => ((input = opts.input), "");
    const sent = runBuildEvent(argv, deps({ env: { [BUILD_EVENT_CMD]: "consumer" }, exec }));
    assert.deepEqual(sent, { exit: 0, stderr: [] }, event);
    assert.deepEqual(Object.keys(readBuildEvent(input ?? "")), ["schema", "runid", "at", "event", ...fields], event);
    for (const other of allFields) {
      if (fields.includes(other)) continue;
      const refused = runBuildEvent([...argv, ...SAMPLE_FLAGS[other]!], deps());
      assert.equal(refused.exit, 2, `${event} took ${flagOf(other)}`);
      assert.ok(refused.stderr[0]!.startsWith(`buildEvent: unknown flag(s): ${flagOf(other)} `), refused.stderr[0]);
    }
  }
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "build-event-"));
}

function repoWithThresholds(file: string, body?: string): string {
  const dir = scratch();
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude/build-steps.toml"), `thresholds = "${file}"\n`);
  if (body !== undefined) writeFileSync(join(dir, file), body);
  return dir;
}

function emit(cmd: string | undefined, cwd: string) {
  const env = { ...process.env };
  delete env[BUILD_EVENT_CMD];
  if (cmd !== undefined) env[BUILD_EVENT_CMD] = cmd;
  return spawnSmoke(TSX_BIN, [SCRIPT, ...PLAN_ARGV], { cwd, env });
}

const WARNING = `buildEvent: ${BUILD_EVENT_CMD} failed (`;
const SECRET = "secret-7f3a";

test("buildEvent entry point: a real consumer that exits non-zero is one warning naming only the program, and exit 0", () => {
  const r = emit(`false --token ${SECRET}`, scratch());

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  // `false` can exit before the event is written to its stdin; then the spawn reports EPIPE
  // instead of the exit status. Both are the same consumer failure.
  assert.match(lines[0]!, /^buildEvent: \S+ failed \(false\): (Command failed: false|spawnSync false EPIPE)/, lines[0]);
  assert.ok(!r.stderr.includes(SECRET), r.stderr);
});

test("buildEvent entry point: a consumer that does not exist is one warning naming ENOENT, and exit 0", () => {
  const r = emit(`no-such-command-${process.pid} --token ${SECRET}`, scratch());

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  assert.ok(lines[0]!.startsWith(`${WARNING}no-such-command-${process.pid}): `), lines[0]);
  assert.match(lines[0]!, /ENOENT/);
  assert.ok(!r.stderr.includes(SECRET), r.stderr);
});

test("buildEvent entry point: a real consumer reads the event's wire line on stdin, and its stdout is dropped", () => {
  const dir = scratch();
  const out = join(dir, "event.json");
  const r = emit(`tee ${out}`, dir);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  const wire = readFileSync(out, "utf8");
  assert.ok(wire.endsWith("}\n") && wire.split("\n").length === 2, wire);
  const event = readBuildEvent(wire);
  assert.deepEqual(event.event === "plan" ? event.units : event, [{ id: "unit-1", title: "Install" }]);
});

test("buildEvent entry point: the repo's BUILD_EVENT_TIMEOUT_MS kills a real consumer that hangs; one warning, exit 0", () => {
  const dir = repoWithThresholds("t.json", '{"BUILD_EVENT_TIMEOUT_MS": 300}');
  const started = Date.now();
  const r = emit("sleep 30", dir);

  assert.ok(Date.now() - started < 15_000, "the consumer was not killed at the timeout");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  assert.ok(lines[0]!.startsWith(`${WARNING}sleep): `), lines[0]);
  assert.match(lines[0]!, /ETIMEDOUT/);
});

test("buildEvent entry point: with no consumer, an unreadable thresholds file is never read; exit 0 and silence", () => {
  const r = emit(undefined, repoWithThresholds("nope.json"));

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("buildEvent entry point: with a consumer, a thresholds file the steps name but that is missing is exit 2", () => {
  const r = emit("true", repoWithThresholds("nope.json"));

  assert.equal(r.status, 2);
  assert.match(r.stderr, /^buildEvent: thresholds: build-steps\.toml names nope\.json, which does not exist/);
});

test("buildEvent entry point: a long warning reaches a pipe whole before the process exits", () => {
  const dir = scratch();
  const loud = join(dir, "loud.mjs");
  const size = 1_000_000;
  writeFileSync(loud, `process.stderr.write("x".repeat(${size})); process.exitCode = 1;\n`);
  assert.ok(!/\s/.test(process.execPath + loud), "the consumer path must hold no whitespace");
  const r = emit(`${process.execPath} ${loud}`, dir);

  assert.equal(r.status, 0);
  assert.ok(r.stderr.startsWith(WARNING), r.stderr.slice(0, 200));
  assert.ok(r.stderr.includes("x".repeat(size)), `stderr cut short at ${r.stderr.length} chars`);
});
