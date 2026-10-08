// The watch's transcript reader: each flag at its limit and not one below, per-segment counters,
// acks, the finished state, and the look it prints. Fixtures are built record by record in the shape
// Claude Code writes (`~/.claude/projects/<p>/<session>/subagents/agent-<id>.jsonl`).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULTS } from "../thresholds.ts";
import {
  describeCall,
  evaluate,
  finishedState,
  formatFlags,
  lastSegmentStart,
  main,
  parseAck,
  parseLines,
  readFinished,
  segmentStats,
  type ScanContext,
  type WatchedAgent,
} from "../watchScan.ts";

type Rec = Record<string, unknown>;
const T0 = Date.parse("2026-09-28T10:00:00Z");
const MIN = 60_000;
const at = (min: number): string => new Date(T0 + min * MIN).toISOString();

let ids = 0;
const prompt = (min: number, text = "Build part 1."): Rec => ({ type: "user", timestamp: at(min), message: { role: "user", content: text } });
const meta = (min: number, text: string, origin?: string): Rec => ({
  type: "user",
  isMeta: true,
  ...(origin === undefined ? {} : { origin: { kind: origin } }),
  timestamp: at(min),
  message: { role: "user", content: [{ type: "text", text }] },
});
const resume = (min: number): Rec => meta(min, "The coordinator sent a message while you were working: go on.", "coordinator");
const done = (min: number, stop = "end_turn"): Rec => ({
  type: "assistant",
  timestamp: at(min),
  message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text: "done" }] },
});
const attachment = (min: number): Rec => ({ type: "attachment", timestamp: at(min), attachment: { type: "total_tokens_reminder" } });
const compact = (min: number): Rec[] => [
  { type: "system", subtype: "compact_boundary", timestamp: at(min) },
  { type: "user", isCompactSummary: true, timestamp: at(min), message: { role: "user", content: "This session is being continued…" } },
];

/** One tool call and its result; `refusal` makes the result an is_error refusal with that text. */
function call(min: number, tool: string, input: Rec, result: { text?: string; error?: boolean } = {}): Rec[] {
  const id = `toolu_${++ids}`;
  return [
    { type: "assistant", timestamp: at(min), message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id, name: tool, input }] } },
    {
      type: "user",
      timestamp: at(min),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result.text ?? "ok", ...(result.error ? { is_error: true } : {}) }] },
    },
  ];
}
const read = (min: number, path = "/r/a.ts", offset?: number, limit?: number): Rec[] =>
  call(min, "Read", { file_path: path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) });
const bash = (min: number, command: string, result: { text?: string; error?: boolean } = {}): Rec[] => call(min, "Bash", { command }, result);
const edit = (min: number, path = "/r/a.ts"): Rec[] => call(min, "Edit", { file_path: path, old_string: "a", new_string: "b" });
const refused = (min: number, command = "git -C /other log"): Rec[] =>
  bash(min, command, { error: true, text: "PreToolUse:Bash hook error: [~/.claude/hooks/bash-guard.sh]: bash-guard blocked this command" });
const times = <T>(n: number, f: (i: number) => T[]): T[] => Array.from({ length: n }, (_, i) => f(i)).flat();

function agent(recs: Rec[], agentType: string | null = "builder", lastWriteMin?: number): WatchedAgent {
  const last = lastWriteMin ?? Math.max(...recs.map((r) => (Date.parse(String(r.timestamp)) - T0) / MIN));
  return { name: "a1", agentType, recs, lastWriteMs: T0 + last * MIN };
}
function ctx(nowMin: number, acks: Record<string, number> = {}, armedAtMin = 0): ScanContext {
  return { nowMs: T0 + nowMin * MIN, armedAtMs: T0 + armedAtMin * MIN, limits: DEFAULTS, acks: new Map(Object.entries(acks)) };
}
const flags = (a: WatchedAgent, c: ScanContext): string[] => evaluate(a, c).map((f) => `${f.flag}=${f.count}`);

// --- each flag at its limit and not one below --------------------------------------------------

test("silent fires at WATCH_SILENT_MIN with no write, not a minute below", () => {
  const recs = [prompt(0), ...edit(1)];
  assert.deepEqual(flags(agent(recs, "review-cursory", 1), ctx(1 + DEFAULTS.WATCH_SILENT_MIN - 1)), []);
  assert.deepEqual(flags(agent(recs, "review-cursory", 1), ctx(1 + DEFAULTS.WATCH_SILENT_MIN)), [`silent=${DEFAULTS.WATCH_SILENT_MIN}`]);
});

test("no-edit fires on a builder at WATCH_NO_EDIT_MIN after its last edit, not a minute below", () => {
  const L = DEFAULTS.WATCH_NO_EDIT_MIN;
  const recs = [prompt(0), ...edit(2), ...times(L, (i) => bash(3 + i, `echo ${i}`))];
  const lastWrite = 2 + L; // the agent keeps writing, so silent never fires
  assert.deepEqual(flags(agent(recs, "builder", lastWrite), ctx(2 + L - 1)), []);
  assert.deepEqual(flags(agent(recs, "builder", lastWrite), ctx(2 + L)), [`no-edit=${L}`]);
});

test("no-edit counts from the segment start when the segment has no edit yet", () => {
  const L = DEFAULTS.WATCH_NO_EDIT_MIN;
  const recs = [prompt(0), ...times(L, (i) => bash(i + 0.5, "ls"))];
  assert.deepEqual(flags(agent(recs, "fixer", L), ctx(L - 1)), []);
  assert.deepEqual(flags(agent(recs, "fixer", L), ctx(L)), [`no-edit=${L}`]);
});

test("no-edit watches builder, fixer, and test-author only; a git commit is an edit", () => {
  const L = DEFAULTS.WATCH_NO_EDIT_MIN;
  const recs = [prompt(0), ...times(L, (i) => bash(i + 0.5, "ls"))];
  for (const t of ["builder", "fixer", "test-author", "plugin:builder"])
    assert.deepEqual(flags(agent(recs, t, L), ctx(L)), [`no-edit=${L}`], t);
  for (const t of ["review-cursory", "hand-tester", "Explore", "big-boy", "little-man", null])
    assert.deepEqual(flags(agent(recs, t, L), ctx(L)), [], String(t));
  const committed = [...recs, ...bash(L - 1, "git -C /r commit -F /tmp/claude/msg.txt")];
  assert.deepEqual(flags(agent(committed, "builder", L), ctx(L)), []);
});

test("same-slice fires at WATCH_SAME_SLICE_READS reads of one path+offset+limit, not one below", () => {
  const N = DEFAULTS.WATCH_SAME_SLICE_READS;
  const below = [prompt(0), ...times(N - 1, () => read(1, "/r/a.ts", 10, 40))];
  assert.deepEqual(flags(agent(below), ctx(2)), []);
  const hit = [...below, ...read(1, "/r/a.ts", 10, 40)];
  assert.deepEqual(flags(agent(hit), ctx(2)), [`same-slice=${N}`]);
});

test("same-slice keys on the slice: paging one file never fires", () => {
  const recs = [prompt(0), ...times(12, (i) => read(1, "/r/a.ts", i * 100, 100)), ...times(4, () => read(1, "/r/a.ts"))];
  assert.deepEqual(flags(agent(recs), ctx(2)), []);
});

test("same-refusal fires at WATCH_SAME_REFUSAL refusals of one tool+command, not one below", () => {
  const N = DEFAULTS.WATCH_SAME_REFUSAL;
  const below = [prompt(0), ...times(N - 1, () => refused(1))];
  assert.deepEqual(flags(agent(below), ctx(2)), []);
  assert.deepEqual(flags(agent([...below, ...refused(1)]), ctx(2)), [`same-refusal=${N}`]);
});

test("same-refusal counts refusals only: a failing command and a different command do not add up", () => {
  const N = DEFAULTS.WATCH_SAME_REFUSAL;
  const failing = [prompt(0), ...times(N + 2, () => bash(1, "pnpm test", { error: true, text: "Exit code 1\nFAIL" }))];
  assert.deepEqual(flags(agent(failing), ctx(2)), []);
  const varied = [prompt(0), ...times(N + 2, (i) => refused(1, `git -C /other log -${i}`))];
  assert.deepEqual(flags(agent(varied), ctx(2)), []);
  const worktree = [prompt(0), ...times(N, () => bash(1, "cd /x && git status", { error: true, text: "This agent is isolated in the worktree /r, but …" }))];
  assert.deepEqual(flags(agent(worktree), ctx(2)), [`same-refusal=${N}`]);
});

test("compactions fires at WATCH_COMPACTIONS compact boundaries in one segment, not one below", () => {
  const N = DEFAULTS.WATCH_COMPACTIONS;
  const below = [prompt(0), ...times(N - 1, (i) => [...edit(1 + i), ...compact(1 + i)])];
  assert.deepEqual(flags(agent(below), ctx(2)), []);
  assert.deepEqual(flags(agent([...below, ...compact(2)]), ctx(3)), [`compactions=${N}`]);
});

// --- off-part (landing 2 §1.7) -----------------------------------------------------------------

const CWD = "/w/agent-a1";
const PART = ["src/a.ts", "src/b.ts", "tests/a.test.ts"];
/** One file-changing call made from `cwd` (the assistant record carries it, as Claude Code writes). */
function editIn(min: number, rel: string, tool = "Edit", cwd = CWD): Rec[] {
  const path = rel.startsWith("/") ? rel : `${cwd}/${rel}`;
  const [use, result] = call(min, tool, tool === "NotebookEdit" ? { notebook_path: path } : { file_path: path });
  return [{ ...use, cwd }, result!];
}
const withPart = (recs: Rec[], part: readonly string[] = PART): WatchedAgent => ({ ...agent(recs), partFiles: part });

test("off-part fires at WATCH_OFF_PART_FILES distinct off-part paths, not one below", () => {
  const N = DEFAULTS.WATCH_OFF_PART_FILES;
  assert.equal(N, 3);
  const own = [prompt(0), ...editIn(1, "src/a.ts"), ...editIn(1, "tests/a.test.ts")];
  const two = [...own, ...editIn(1, "src/x.ts", "Write"), ...editIn(1, "docs/y.md", "MultiEdit")];
  assert.deepEqual(flags(withPart(two), ctx(2)), []);
  const three = [...two, ...editIn(1, "nb/z.ipynb", "NotebookEdit")];
  assert.deepEqual(flags(withPart(three), ctx(2)), [`off-part=${N}`]);
});

test("off-part never counts run state, a path outside cwd, or a path a glob entry matches", () => {
  const recs = [
    prompt(0),
    ...editIn(1, ".claude/run-state/ledger.md"),
    ...editIn(1, "/tmp/claude/build-r1/notes.txt", "Write"),
    ...editIn(1, "/w/other-tree/src/q.ts"),
    ...editIn(1, "/Users/me/.claude/agent-memory/builder/x.md", "Write"),
    ...editIn(1, "lib/deep/one.ts"),
    ...editIn(1, "lib/two.ts"),
    ...editIn(1, "src/x.ts"),
    ...editIn(1, "src/y.ts"),
  ];
  assert.deepEqual(flags(withPart(recs, [...PART, "lib/**"]), ctx(2)), []);
  // the same edits without the glob: the two lib files now count, and the flag fires
  assert.deepEqual(flags(withPart(recs), ctx(2)), ["off-part=4"]);
});

test("off-part counts one file edited five times once", () => {
  const recs = [prompt(0), ...times(5, () => editIn(1, "src/x.ts")), ...editIn(1, "src/y.ts")];
  assert.deepEqual(flags(withPart(recs), ctx(2)), []);
});

test("off-part acked at 3 fires again at 6, not at 5", () => {
  const off = (n: number): Rec[] => [prompt(0), ...times(n, (i) => editIn(1, `other/f${i}.ts`))];
  const acks = { "a1:off-part": 3 };
  assert.deepEqual(flags(withPart(off(5)), ctx(2, acks)), []);
  assert.deepEqual(flags(withPart(off(6)), ctx(2, acks)), ["off-part=6"]);
});

test("scan refuses a --part-files name that no --agent carries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watchscan-test-"));
  const errs: string[] = [];
  const orig = console.error;
  let code = -1;
  try {
    writeFileSync(join(dir, "p.files"), "src/a.ts\n");
    console.error = (m: unknown) => void errs.push(String(m));
    await main(["scan", "--repo", dir, "--part-files", `ghost=${join(dir, "p.files")}`], (c) => (code = c));
  } finally {
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(code, 2);
  assert.match(errs.join("\n"), /--part-files names no --agent: ghost/);
});

test("an agent with no part files never gets off-part", () => {
  const recs = [prompt(0), ...times(6, (i) => editIn(1, `other/f${i}.ts`))];
  assert.deepEqual(flags(agent(recs), ctx(2)), []);
  assert.deepEqual(parseAck("a1:off-part:3"), { key: "a1:off-part", count: 3 });
});

// --- segments ------------------------------------------------------------------------------

test("counters reset when a resume starts a new segment", () => {
  const recs = [
    prompt(0),
    ...times(4, () => read(1)),
    ...compact(1),
    ...times(3, () => refused(1)),
    done(2),
    resume(40),
    ...times(4, () => read(41)),
    ...compact(41),
    ...times(3, () => refused(41)),
  ];
  const s = segmentStats(recs);
  assert.deepEqual([...s.reads.values()], [4]);
  assert.equal(s.compactions, 1);
  assert.deepEqual([...s.refusals.values()], [3]);
  assert.deepEqual(flags(agent(recs), ctx(42)), []);
  // the idle wait between turns is not a no-edit gap: the new segment starts its clock at the resume
  assert.equal(s.startMs, T0 + 40 * MIN);
});

test("a message from the coordinator inside a turn starts a new segment", () => {
  const recs = [prompt(0), ...times(4, () => read(1)), resume(2), ...times(4, () => read(3))];
  assert.equal(recs[lastSegmentStart(recs)], recs[9]);
  assert.deepEqual(flags(agent(recs), ctx(4)), []);
});

test("a harness record inside a turn (an image, a skill's text) does not reset the counters", () => {
  const recs = [
    prompt(0),
    ...times(3, () => read(1)),
    meta(1, "[Image: original 800x600, displayed at 800x600.]"),
    ...read(2),
    meta(2, "Base directory for this skill: /x"),
    ...read(2),
  ];
  assert.equal(lastSegmentStart(recs), 0);
  assert.deepEqual(flags(agent(recs), ctx(3)), [`same-slice=${DEFAULTS.WATCH_SAME_SLICE_READS}`]);
});

test("a compaction summary does not start a segment", () => {
  const recs = [prompt(0), ...read(1), ...compact(2), ...read(3)];
  assert.equal(lastSegmentStart(recs), 0);
});

// --- acks --------------------------------------------------------------------------------------

test("an acked count flag stays quiet until count + limit", () => {
  const N = DEFAULTS.WATCH_SAME_SLICE_READS;
  const base = [prompt(0), ...times(N, () => read(1))];
  const acks = { "a1:same-slice": N };
  assert.deepEqual(flags(agent([...base, ...times(N - 1, () => read(1))]), ctx(2, acks)), []);
  assert.deepEqual(flags(agent([...base, ...times(N, () => read(1))]), ctx(2, acks)), [`same-slice=${2 * N}`]);
  // the ack is per agent and flag: another agent's ack changes nothing
  assert.deepEqual(flags(agent(base), ctx(2, { "a2:same-slice": N })), [`same-slice=${N}`]);
});

test("an acked clock flag fires again a full limit after the later of the ack and the last write", () => {
  const L = DEFAULTS.WATCH_SILENT_MIN;
  const recs = [prompt(0), ...read(1)];
  // flagged at minute 1 + L, looked at and re-armed at minute 14 with the ack
  const acks = { "a1:silent": L };
  assert.deepEqual(flags(agent(recs, "review-cursory", 1), ctx(14 + L - 1, acks, 14)), []);
  assert.deepEqual(flags(agent(recs, "review-cursory", 1), ctx(14 + L, acks, 14)), [`silent=${13 + L}`]);
  // the agent wrote after the ack: a fresh quiet period needs its own full limit
  assert.deepEqual(flags(agent(recs, "review-cursory", 20), ctx(20 + L - 1, acks, 14)), []);
  assert.deepEqual(flags(agent(recs, "review-cursory", 20), ctx(20 + L, acks, 14)), [`silent=${L}`]);
});

test("parseAck reads <agent>:<flag>:<count> and refuses an unknown flag", () => {
  assert.deepEqual(parseAck("a1:same-slice:5"), { key: "a1:same-slice", count: 5 });
  assert.deepEqual(parseAck("x:y:no-edit:16"), { key: "x:y:no-edit", count: 16 });
  assert.throws(() => parseAck("a1:stale:3"), /--ack wants/);
  assert.throws(() => parseAck("a1:silent"), /--ack wants/);
});

// --- finished state -----------------------------------------------------------------------------

test("finished: end_turn or stop_sequence, even with attachment records after it", () => {
  assert.equal(finishedState([prompt(0), ...read(1), done(2)]), "finished");
  assert.equal(finishedState([prompt(0), done(2), attachment(2), attachment(2)]), "finished");
  assert.equal(finishedState([prompt(0), done(2, "stop_sequence")]), "finished");
  assert.equal(finishedState([prompt(0), ...read(1)]), "running");
  assert.equal(finishedState([prompt(0), done(2), resume(3)]), "running");
  assert.equal(finishedState([]), "running");
});

/** A helper's last call: `SubagentHandback` and the harness's result, as Claude Code writes them
 *  from 2026-09-30. `error` makes the result a refusal: the report did not reach the caller. */
const DELIVERED = '{"success":true,"message":"Report delivered to your caller."}';
const handback = (min: number, error = false): Rec[] =>
  call(min, "SubagentHandback", { report: "2 findings, file written" }, error ? { error: true, text: "refused" } : { text: DELIVERED });

test("finished: a delivered SubagentHandback ends the run, even with attachment records after it", () => {
  assert.equal(finishedState([prompt(0), ...read(1), ...handback(2)]), "finished");
  assert.equal(finishedState([prompt(0), ...read(1), ...handback(2), attachment(2), attachment(2)]), "finished");
  assert.equal(finishedState([prompt(0), ...read(1), ...handback(2, true)]), "running", "a refused handback: the agent goes on");
  assert.equal(finishedState([prompt(0), ...handback(1).slice(0, 1)]), "running", "the call with no result yet");
  assert.equal(finishedState([prompt(0), ...handback(1), resume(2)]), "running", "a resume after it is a new turn");
  assert.equal(finishedState([prompt(0), ...handback(1), ...read(2)]), "running", "a call after it: the run went on");
});

test("finished: a handback sent beside another call ends the run, whichever result lands last", () => {
  const [writeCall, writeResult] = call(1, "Write", { file_path: "/r/out.md", content: "x" });
  const [handCall, handResult] = handback(1);
  assert.equal(finishedState([prompt(0), writeCall!, handCall!, writeResult!, handResult!]), "finished");
  assert.equal(finishedState([prompt(0), writeCall!, handCall!, handResult!, writeResult!]), "finished");
  assert.equal(finishedState([prompt(0), writeCall!, writeResult!]), "running");
});

test("a finished agent is never flagged, however long it has been quiet", () => {
  const recs = [prompt(0), ...times(9, () => read(1)), done(2), attachment(2)];
  assert.deepEqual(flags(agent(recs, "builder", 2), ctx(300)), []);
  const handedBack = [prompt(0), ...times(9, () => read(1)), ...handback(2), attachment(2)];
  assert.deepEqual(flags(agent(handedBack, "review-cursory", 2), ctx(300)), []);
});

test("a task notification after a delivered handback starts a new segment, as one after an end_turn does", () => {
  const recs = [prompt(0), ...times(4, () => read(1)), ...handback(2), meta(3, "<task-notification>…</task-notification>"), ...times(4, () => read(4))];
  assert.equal(recs[lastSegmentStart(recs)], recs[11]);
  const refused = [prompt(0), ...times(4, () => read(1)), ...handback(2, true), meta(3, "<task-notification>…</task-notification>"), ...read(4)];
  assert.equal(lastSegmentStart(refused), 0, "a refused handback leaves the turn open");
});

test("state reads a transcript that ends on a delivered handback as finished, past a large earlier record", async () => {
  const big = call(1, "Read", { file_path: "/r/big.ts" }, { text: "x".repeat(300_000) });
  await inTranscriptDir([prompt(0), ...big, ...handback(2), attachment(2)], async (_dir, transcript) => {
    assert.equal(readFinished(transcript), "finished");
  });
  await inTranscriptDir([prompt(0), ...big, ...handback(2, true)], async (_dir, transcript) => {
    assert.equal(readFinished(transcript), "running");
  });
});

test("state widens its window when the cut drops the handback call but keeps its result", async () => {
  const [handCall, handResult] = call(1, "SubagentHandback", { report: "r".repeat(300_000) }, { text: DELIVERED });
  await inTranscriptDir([prompt(0), handCall!, handResult!, attachment(2)], async (_dir, transcript) => {
    assert.equal(readFinished(transcript), "finished");
  });
});

test("a Codex run (no transcript) is watched for silence only", () => {
  const codex: WatchedAgent = { name: "review-cursory-codex", agentType: null, recs: null, lastWriteMs: T0 };
  assert.deepEqual(flags(codex, ctx(DEFAULTS.WATCH_SILENT_MIN - 1)), []);
  assert.deepEqual(flags(codex, ctx(60)), ["silent=60"]);
});

// --- the look ------------------------------------------------------------------------------------

test("formatFlags prints each FLAG, LAST with the last 8 tool calls, and one ack line per flag", () => {
  const recs = [prompt(0), ...times(12, (i) => bash(1, `echo step-${i}`)), ...times(5, () => read(1, "/r/a.ts", 1, 50))];
  const a = agent(recs);
  const lines = formatFlags(a, evaluate(a, ctx(2)));
  assert.deepEqual(lines, [
    "FLAG a1 same-slice count=5 limit=5",
    "LAST a1",
    "  Bash echo step-9",
    "  Bash echo step-10",
    "  Bash echo step-11",
    "  Read /r/a.ts@1:50",
    "  Read /r/a.ts@1:50",
    "  Read /r/a.ts@1:50",
    "  Read /r/a.ts@1:50",
    "  Read /r/a.ts@1:50",
    "ack: --ack a1:same-slice:5",
  ]);
});

test("describeCall keeps a target to 60 characters: a command's head, a path's tail", () => {
  const cmd = describeCall({ tool: "Bash", input: { command: `pnpm -F core test ${"x".repeat(80)}` } });
  assert.equal(cmd.length, "Bash ".length + 60);
  assert.match(cmd, /^Bash pnpm -F core test x+…$/);
  const path = describeCall({ tool: "Edit", input: { file_path: `/Users/me/${"deep/".repeat(20)}index.ts` } });
  assert.equal(path.length, "Edit ".length + 60);
  assert.match(path, /^Edit ….*\/index\.ts$/);
});

test("describeCall shows a command past its leading cd", () => {
  const d = (command: string): string => describeCall({ tool: "Bash", input: { command } });
  assert.equal(d("cd /Users/me/src/app/.claude/worktrees/agent-a1 && deno test x.ts"), "Bash deno test x.ts");
  assert.equal(d('cd "/a b" ; cd c && git status'), "Bash git status");
  assert.equal(d("cd /x"), "Bash cd /x");
});

// --- `last`: the look on request -----------------------------------------------------------------

/** An assistant record holding one text block (`stop_reason` null: the turn goes on). */
const said = (min: number, text: string): Rec => ({
  type: "assistant",
  timestamp: at(min),
  message: { role: "assistant", stop_reason: null, content: [{ type: "text", text }] },
});

/** A temp dir with `agent-a1.jsonl` holding `recs`; removed when `fn` settles. */
async function inTranscriptDir(recs: Rec[], fn: (dir: string, transcript: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "watchscan-last-"));
  try {
    const transcript = join(dir, "agent-a1.jsonl");
    writeFileSync(transcript, `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
    await fn(dir, transcript);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `watchScan.ts last <args>` in process: what it printed and how it exited. */
async function look(...args: string[]): Promise<{ lines: string[]; errs: string[]; code: number }> {
  const lines: string[] = [];
  const errs: string[] = [];
  const [log, err] = [console.log, console.error];
  let code = -1;
  try {
    console.log = (m: unknown) => void lines.push(String(m));
    console.error = (m: unknown) => void errs.push(String(m));
    await main(["last", ...args], (c) => (code = c));
  } finally {
    [console.log, console.error] = [log, err];
  }
  return { lines, errs, code };
}

const AGENT_LINE = /^AGENT a1 running · \d+ records · last write \d+[smh] ago$/;

test("last prints the last 8 of 12 tool calls, oldest first, and the last text the agent said", async () => {
  const recs = [prompt(0), said(1, "early"), ...times(12, (i) => bash(2 + i, `echo step-${i}`)), said(15, "late\n  thoughts   here"), ...bash(16, "echo tail")];
  await inTranscriptDir(recs, async (_dir, transcript) => {
    const r = await look(transcript);
    assert.equal(r.code, 0);
    assert.match(r.lines[0]!, /^AGENT a1 running · 29 records · last write \d+[smh] ago$/);
    assert.deepEqual(r.lines.slice(1), [
      "LAST",
      ...[5, 6, 7, 8, 9, 10, 11].map((i) => `  Bash echo step-${i}`),
      "  Bash echo tail",
      "SAID late thoughts here",
    ]);
  });
});

test("last --calls 3 prints 3 calls; 1 and 30 are accepted", async () => {
  await inTranscriptDir([prompt(0), ...times(12, (i) => bash(1 + i, `echo step-${i}`))], async (_dir, transcript) => {
    const three = await look(transcript, "--calls", "3");
    assert.deepEqual(three.lines.slice(1), ["LAST", "  Bash echo step-9", "  Bash echo step-10", "  Bash echo step-11"]);
    assert.deepEqual((await look("--calls", "1", transcript)).lines.slice(1), ["LAST", "  Bash echo step-11"]);
    const thirty = await look(transcript, "--calls", "30");
    assert.equal(thirty.code, 0);
    assert.equal(thirty.lines.length, 2 + 12);
  });
});

test("last exits 2 on --calls 0, 31, or x, and on a missing path, a second path, or an unknown flag", async () => {
  await inTranscriptDir([prompt(0), ...bash(1, "ls")], async (_dir, transcript) => {
    for (const bad of ["0", "31", "x", "-1", "2.5", ""]) {
      const r = await look(transcript, "--calls", bad);
      assert.equal(r.code, 2, `--calls ${bad}`);
      assert.deepEqual(r.lines, []);
      assert.match(r.errs.join("\n"), /--calls wants a whole number from 1 to 30/);
    }
    assert.equal((await look(transcript, "--calls")).code, 2);
    assert.equal((await look()).code, 2);
    assert.equal((await look(transcript, transcript)).code, 2);
    assert.equal((await look(transcript, "--call", "3")).code, 2);
  });
});

test("last stays within n + 3 lines of 210 characters, whatever a record holds", async () => {
  const huge = "x".repeat(100_000);
  const recs = [
    prompt(0),
    ...times(30, (i) => call(1 + i, "Bash", { command: `cd /a && ${huge}${i}`, description: huge }, { text: huge })),
    ...call(30, "Read", { file_path: `/${huge}/a.ts` }, { text: huge }),
    ...call(31, "Grep", { pattern: huge }, { text: huge }),
    ...call(32, "Custom", { blob: huge, more: [huge] }, { text: huge }),
    said(33, `${"word ".repeat(1000)}\n${huge}`),
  ];
  await inTranscriptDir(recs, async (_dir, transcript) => {
    for (const n of [undefined, 3, 30]) {
      const r = await look(transcript, ...(n === undefined ? [] : ["--calls", String(n)]));
      assert.equal(r.code, 0);
      assert.equal(r.lines.length, (n ?? 8) + 3, `n=${n}`);
      for (const l of r.lines) assert.ok(l.length <= 210, `n=${n}: a ${l.length}-character line: ${l.slice(0, 40)}`);
      assert.equal(r.lines.at(-1)!.length, "SAID ".length + 200);
      assert.match(r.lines.at(-1)!, /^SAID word word .*…$/);
    }
  });
});

test("last says (no tool calls yet) when the transcript holds none", async () => {
  await inTranscriptDir([prompt(0), said(1, "Reading the brief.")], async (_dir, transcript) => {
    const r = await look(transcript);
    assert.match(r.lines[0]!, AGENT_LINE);
    assert.deepEqual(r.lines.slice(1), ["LAST", "  (no tool calls yet)", "SAID Reading the brief."]);
  });
});

test("last leaves out SAID when no assistant record holds text", async () => {
  const blank = said(2, " \n ");
  await inTranscriptDir([prompt(0, "Say something."), ...bash(1, "ls"), blank], async (_dir, transcript) => {
    const r = await look(transcript);
    assert.deepEqual(r.lines.slice(1), ["LAST", "  Bash ls"]);
  });
});

test("last on a missing transcript prints missing and exits 0", async () => {
  const r = await look(join(tmpdir(), "watchscan-last-none", "agent-gone.jsonl"));
  assert.deepEqual(r, { lines: ["AGENT gone missing"], errs: [], code: 0 });
});

test("last reports the finished state and the age of the last write", async () => {
  await inTranscriptDir([prompt(0), ...bash(1, "ls"), done(2)], async (_dir, transcript) => {
    const ago = (s: number): Date => new Date(Date.now() - s * 1000);
    for (const [seconds, age] of [[42, /4[2-4]s/], [7 * 60 + 10, /7m/], [3 * 3600 + 300, /3h/]] as const) {
      utimesSync(transcript, ago(seconds), ago(seconds));
      const r = await look(transcript);
      assert.match(r.lines[0]!, /^AGENT a1 finished · 4 records · last write /);
      assert.match(r.lines[0]!, new RegExp(`last write ${age.source} ago$`));
    }
  });
});

test("last on a .output symlink prints what the transcript's own path prints", async () => {
  await inTranscriptDir([prompt(0), ...times(3, (i) => bash(1 + i, `echo ${i}`)), said(5, "on it")], async (dir, transcript) => {
    const old = new Date(Date.now() - 2 * 3600_000 - 60_000); // a fixed age, so the two runs print the same header
    utimesSync(transcript, old, old);
    symlinkSync(transcript, join(dir, "b5x.output"));
    symlinkSync("agent-a1.jsonl", join(dir, "rel.output"));
    const direct = await look(transcript);
    assert.equal(direct.lines[0], "AGENT a1 running · 8 records · last write 2h ago");
    assert.deepEqual(await look(join(dir, "b5x.output")), direct);
    assert.deepEqual(await look(join(dir, "rel.output")), direct);
  });
});

test("parseLines skips a torn last line", () => {
  assert.equal(parseLines(`${JSON.stringify(prompt(0))}\n{"type":"assist`).length, 1);
});
