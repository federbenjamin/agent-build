// Unit tests for scripts/agent-watchdog.sh — the background-subagent stall watchdog.
// Runs the REAL script against fixture transcript files in a tmpdir (no live agents).
//
// Asserted invariants:
//   - a transcript whose final record has stop_reason "end_turn" reports `finished`;
//   - a running transcript (stop_reason null) past the --stale mtime threshold reports
//     `stale`, exits 1 (degraded);
//   - a fresh running transcript at the --deadline reports `deadline`, exits 1;
//   - a missing transcript reports `stale (transcript missing)`, exits 1;
//   - a trailing partial/garbage line does not mask a preceding end_turn record;
//   - a task `.output` symlink resolves to its jsonl target;
//   - mixed fan-out (one finished, one stale) reports BOTH lines and exits degraded;
//   - an agent finishing WHILE the watchdog polls is picked up (the live-transition path);
//   - no paths → exit 2; --help → usage, exit 0.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "agent-watchdog.sh");

const RUNNING_REC = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", stop_reason: null, content: [{ type: "thinking" }] },
});
const FINISHED_REC = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text" }] },
});

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-watchdog-test-"));
}

function writeTranscript(dir: string, name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function ageFile(p: string, seconds: number): void {
  const past = new Date(Date.now() - seconds * 1000);
  utimesSync(p, past, past);
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSmoke("bash", [SCRIPT, ...args]);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("finished transcript → finished, exit 0", () => {
  const dir = makeDir();
  try {
    const p = writeTranscript(dir, "agent-a1.jsonl", [RUNNING_REC, FINISHED_REC]);
    const r = run(["--deadline", "0", p]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /AGENT agent-a1 finished/);
    assert.match(r.stdout, /WATCHDOG done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running transcript past --stale threshold → stale, exit 1", () => {
  const dir = makeDir();
  try {
    const p = writeTranscript(dir, "agent-a2.jsonl", [RUNNING_REC]);
    ageFile(p, 120);
    const r = run(["--stale", "60", "--deadline", "0", p]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /AGENT agent-a2 stale \(no write for \d+s\)/);
    assert.match(r.stdout, /WATCHDOG degraded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh running transcript at deadline → deadline, exit 1", () => {
  const dir = makeDir();
  try {
    const p = writeTranscript(dir, "agent-a3.jsonl", [RUNNING_REC]);
    const r = run(["--poll", "1", "--stale", "3600", "--deadline", "0", p]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /AGENT agent-a3 deadline/);
    assert.match(r.stdout, /WATCHDOG degraded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing transcript → stale (transcript missing), exit 1", () => {
  const dir = makeDir();
  try {
    const r = run(["--deadline", "0", join(dir, "agent-gone.jsonl")]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /AGENT agent-gone stale \(transcript missing\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trailing partial line does not mask a preceding end_turn record", () => {
  const dir = makeDir();
  try {
    const p = writeTranscript(dir, "agent-a4.jsonl", [
      FINISHED_REC,
      '{"type":"assistant","message":{"stop_re', // torn mid-write
    ]);
    const r = run(["--deadline", "0", p]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /AGENT agent-a4 finished/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task .output symlink resolves to the jsonl target", () => {
  const dir = makeDir();
  try {
    const target = writeTranscript(dir, "agent-a5.jsonl", [FINISHED_REC]);
    const link = join(dir, "a5.output");
    symlinkSync(target, link);
    const r = run(["--deadline", "0", link]);
    assert.equal(r.status, 0);
    // Named by the armed .output basename (the id the orchestrator knows), not the jsonl.
    assert.match(r.stdout, /AGENT a5 finished/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mixed fan-out: one finished + one stale → both lines, degraded", () => {
  const dir = makeDir();
  try {
    const done = writeTranscript(dir, "agent-b1.jsonl", [FINISHED_REC]);
    const hung = writeTranscript(dir, "agent-b2.jsonl", [RUNNING_REC]);
    ageFile(hung, 120);
    const r = run(["--stale", "60", "--deadline", "0", done, hung]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /AGENT agent-b1 finished/);
    assert.match(r.stdout, /AGENT agent-b2 stale/);
    assert.match(r.stdout, /WATCHDOG degraded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent finishing while the watchdog polls is picked up", async () => {
  const dir = makeDir();
  try {
    const p = writeTranscript(dir, "agent-c1.jsonl", [RUNNING_REC]);
    const child = spawn("bash", [SCRIPT, "--poll", "1", "--stale", "3600", "--deadline", "20", p]);
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    await new Promise((res) => setTimeout(res, 1500));
    appendFileSync(p, FINISHED_REC + "\n");
    const status: number | null = await new Promise((res, rej) => {
      const guard = setTimeout(() => {
        child.kill();
        rej(new Error("watchdog did not exit within 25s of the agent finishing"));
      }, 25_000);
      child.on("close", (code) => {
        clearTimeout(guard);
        res(code);
      });
    });
    assert.equal(status, 0);
    assert.match(stdout, /AGENT agent-c1 finished/);
    assert.match(stdout, /WATCHDOG done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("final record larger than the 256KB tail window is still read (widening retry)", () => {
  const dir = makeDir();
  try {
    const bigFinished = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "x".repeat(400_000) }],
      },
    });
    const p = writeTranscript(dir, "agent-big.jsonl", [RUNNING_REC, bigFinished]);
    const r = run(["--deadline", "0", p]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /AGENT agent-big finished/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-numeric flag value → exit 2 with error", () => {
  const r = run(["--poll", "abc", "/nonexistent.jsonl"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--poll needs an integer/);
});

test("no paths → exit 2 with error", () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no agent paths/);
});

test("--help prints usage and exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

// --- the --flags watch (§1.17): the old call form above is unchanged ------------------------

function readRecs(n: number, path = "/r/a.ts"): string[] {
  const now = new Date().toISOString();
  const out: string[] = [JSON.stringify({ type: "user", timestamp: now, message: { role: "user", content: "Build part 1." } })];
  for (let i = 0; i < n; i++) {
    const id = `toolu_${i}`;
    out.push(
      JSON.stringify({
        type: "assistant",
        timestamp: now,
        message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id, name: "Read", input: { file_path: path, offset: 1, limit: 40 } }] },
      }),
      JSON.stringify({
        type: "user",
        timestamp: now,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] },
      })
    );
  }
  return out;
}

function runIn(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSmoke("bash", [SCRIPT, ...args], { cwd });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("--flags: a flag exits 3 with FLAG, LAST and its 8 calls, and the ack line", () => {
  const dir = makeDir();
  try {
    const p = writeTranscript(dir, "agent-f1.jsonl", readRecs(9));
    const r = runIn(dir, ["--flags", "--poll", "1", p]);
    assert.equal(r.status, 3, r.stderr);
    const lines = r.stdout.trimEnd().split("\n");
    assert.equal(lines[0], "FLAG agent-f1 same-slice count=9 limit=5");
    assert.equal(lines[1], "LAST agent-f1");
    assert.deepEqual(lines.slice(2, 10), Array(8).fill("  Read /r/a.ts@1:40"));
    assert.equal(lines[10], "ack: --ack agent-f1:same-slice:9");
    assert.equal(lines[11], "WATCHDOG flagged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--flags --ack: the acked flag is quiet below count + limit; the deadline still ends the watch", () => {
  const dir = makeDir();
  try {
    const p = writeTranscript(dir, "agent-f2.jsonl", readRecs(9));
    const r = runIn(dir, ["--flags", "--poll", "1", "--deadline", "0", "--ack", "agent-f2:same-slice:5", p]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /FLAG/);
    assert.match(r.stdout, /AGENT agent-f2 deadline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--flags: no write for WATCH_SILENT_MIN is the silent flag, not the old stale exit", () => {
  const dir = makeDir();
  try {
    const p = writeTranscript(dir, "agent-f3.jsonl", readRecs(1));
    ageFile(p, 16 * 60); // past the old 900 s stale default too
    const r = runIn(dir, ["--flags", "--poll", "1", p]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG agent-f3 silent count=16 limit=12$/m);
    assert.doesNotMatch(r.stdout, /stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--flags: the limits come from the repo's thresholds file", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "t.json"), '{"WATCH_SAME_SLICE_READS": 2}');
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "build-steps.toml"), 'thresholds = "t.json"\n');
    const p = writeTranscript(dir, "agent-f4.jsonl", readRecs(2));
    const r = runIn(dir, ["--flags", "--poll", "1", p]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG agent-f4 same-slice count=2 limit=2$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--codex: a Codex run finishes when its out file appears", async () => {
  const dir = makeDir();
  try {
    const log = join(dir, "codex.log");
    const out = join(dir, "review-cursory-codex.md");
    writeFileSync(log, "codex exec started\n");
    writeFileSync(out, "");
    const child = spawn("bash", [SCRIPT, "--flags", "--poll", "1", "--codex", `${log}:${out}`], { cwd: dir });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(child.exitCode, null, `exited before the out file was written: ${stdout}`);
    writeFileSync(out, "## Findings\nnone\n");
    const status: number | null = await new Promise((res, rej) => {
      const guard = setTimeout(() => {
        child.kill();
        rej(new Error("watchdog did not exit within 25s of the out file appearing"));
      }, 25_000);
      child.on("close", (code) => {
        clearTimeout(guard);
        res(code);
      });
    });
    assert.equal(status, 0, stdout);
    assert.match(stdout, /AGENT review-cursory-codex finished/);
    assert.match(stdout, /WATCHDOG done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--codex: a quiet log is the silent flag, and LAST shows the log's tail", () => {
  const dir = makeDir();
  try {
    const log = join(dir, "codex.log");
    writeFileSync(log, Array.from({ length: 12 }, (_, i) => `event ${i}`).join("\n") + "\n");
    ageFile(log, 13 * 60);
    const r = runIn(dir, ["--flags", "--poll", "1", "--codex", `${log}:${join(dir, "w1.out")}`]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^FLAG w1 silent count=13 limit=12$/m);
    assert.match(r.stdout, /^ {2}log event 11$/m);
    assert.doesNotMatch(r.stdout, /event 3$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A running transcript whose agent edits each of `rels` once, from `cwd`. */
function editRecs(cwd: string, rels: string[]): string[] {
  const now = new Date().toISOString();
  const out: string[] = [JSON.stringify({ type: "user", timestamp: now, cwd, message: { role: "user", content: "Build part 1." } })];
  rels.forEach((rel, i) => {
    const id = `toolu_e${i}`;
    out.push(
      JSON.stringify({
        type: "assistant",
        timestamp: now,
        cwd,
        message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id, name: "Edit", input: { file_path: join(cwd, rel), old_string: "a", new_string: "b" } }] },
      }),
      JSON.stringify({ type: "user", timestamp: now, cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } })
    );
  });
  return out;
}

test("--flags --part-files: only the named agent is flagged off-part, at 3 files outside its part", () => {
  const dir = makeDir();
  try {
    const part = join(dir, "p1.files");
    writeFileSync(part, "src/a.ts\ntests/a.test.ts\n");
    const off = ["src/a.ts", "src/x.ts", "docs/y.md", "lib/z.ts"];
    const p1 = writeTranscript(dir, "agent-p1.jsonl", editRecs(dir, off));
    const p2 = writeTranscript(dir, "agent-p2.jsonl", editRecs(dir, off)); // no --part-files
    const p3 = writeTranscript(dir, "agent-p3.jsonl", editRecs(dir, ["src/a.ts", "tests/a.test.ts"]));
    const r = runIn(dir, ["--flags", "--poll", "1", "--deadline", "5", "--part-files", `${p1}=${part}`, "--part-files", `${p3}=${part}`, p1, p2, p3]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.deepEqual(r.stdout.match(/^FLAG .*$/gm), ["FLAG agent-p1 off-part count=3 limit=3"]);
    assert.match(r.stdout, /^ack: --ack agent-p1:off-part:3$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage: --part-files needs --flags, a watched path, and a readable file", () => {
  const dir = makeDir();
  try {
    const part = join(dir, "p.files");
    writeFileSync(part, "src/a.ts\n");
    const p = writeTranscript(dir, "agent-u1.jsonl", [RUNNING_REC]);
    const noFlags = run(["--deadline", "0", "--part-files", `${p}=${part}`, p]);
    assert.equal(noFlags.status, 2);
    assert.match(noFlags.stderr, /--part-files needs --flags/);
    const unwatched = runIn(dir, ["--flags", "--part-files", `${join(dir, "other.output")}=${part}`, p]);
    assert.equal(unwatched.status, 2);
    assert.match(unwatched.stderr, /--part-files names no watched path/);
    const unreadable = runIn(dir, ["--flags", "--part-files", `${p}=${join(dir, "missing.files")}`, p]);
    assert.equal(unreadable.status, 2);
    assert.match(unreadable.stderr, /--part-files file not readable/);
    const malformed = runIn(dir, ["--flags", "--part-files", p, p]);
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /--part-files needs <path>=<file>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage: --ack needs --flags; --codex needs <log>:<out>", () => {
  const a = run(["--ack", "a1:silent:3", "/nonexistent.jsonl"]);
  assert.equal(a.status, 2);
  assert.match(a.stderr, /--ack needs --flags/);
  const c = run(["--codex", "only-a-log"]);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /--codex needs <log>:<out>/);
});
