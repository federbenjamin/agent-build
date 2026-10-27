import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { cancelPlan, formatStatus, newRunId, parseCommand } from "../commands.ts";
import type { RunHistory } from "../contracts.ts";
import { graph as toy } from "../examples/toy.ts";
import { restartsNote } from "../schedule.ts";

const history = (over: Partial<RunHistory>): RunHistory => ({ runId: "g-1", graph: toy, phase: "running", nodes: [], loops: [], asking: [], data: {}, ...over });

test("start parses the request and --repo whichever side of the request the flags sit", () => {
  assert.deepEqual(parseCommand(["start", "do it", "--repo", "/r"]), { cmd: "start", request: "do it", repo: "/r" });
  assert.deepEqual(parseCommand(["start", "--repo", "/r", "--config", "c.json", "do it"]), { cmd: "start", request: "do it", repo: "/r", config: "c.json" });
});

test("start refuses a missing --repo, a blank request, a flag without a value, and a second request", () => {
  assert.throws(() => parseCommand(["start", "do it"]), /--repo/);
  assert.throws(() => parseCommand(["start", "   ", "--repo", "/r"]), /non-empty request/);
  assert.throws(() => parseCommand(["start", "--repo"]), /requires a value/);
  assert.throws(() => parseCommand(["start", "--repo", "--config", "x"]), /requires a value/);
  assert.throws(() => parseCommand(["start", "a", "b", "--repo", "/r"]), /takes 1 argument, got 2/);
  assert.throws(() => parseCommand(["start", "--repo", "/r"]), /takes 1 argument, got 0/);
});

test("a typo'd flag is an error, not a positional", () => {
  assert.throws(() => parseCommand(["start", "x", "--repo", "/r", "--confg", "c"]), /unknown flag/);
  assert.throws(() => parseCommand(["status", "--json", "g-1"]), /unknown flag/);
});

test("answer, status, draw, export and dev take exactly their positionals", () => {
  assert.deepEqual(parseCommand(["answer", "g-1", "yes please"]), { cmd: "answer", run: "g-1", text: "yes please" });
  assert.deepEqual(parseCommand(["status", "g-1"]), { cmd: "status", run: "g-1" });
  assert.deepEqual(parseCommand(["draw", "g-1"]), { cmd: "draw", target: "g-1" });
  assert.deepEqual(parseCommand(["export", "pipelines/build.ts"]), { cmd: "export", module: "pipelines/build.ts" });
  assert.deepEqual(parseCommand(["dev"]), { cmd: "dev" });
  assert.throws(() => parseCommand(["answer", "g-1"]), /answer takes 2 arguments, got 1/);
  assert.throws(() => parseCommand(["status"]), /status takes 1 argument, got 0/);
  assert.throws(() => parseCommand(["draw", "a", "b"]), /draw takes 1 argument, got 2/);
  assert.throws(() => parseCommand(["export"]), /export takes 1 argument, got 0/);
  assert.throws(() => parseCommand(["dev", "x"]), /dev takes 0 arguments, got 1/);
});

test("stats takes an optional state dir and nothing else", () => {
  assert.deepEqual(parseCommand(["stats"]), { cmd: "stats" });
  assert.deepEqual(parseCommand(["stats", "/state"]), { cmd: "stats", stateDir: "/state" });
  assert.throws(() => parseCommand(["stats", "a", "b"]), /stats takes at most 1 argument, got 2/);
  assert.throws(() => parseCommand(["stats", "--json"]), /unknown flag/);
});

test("an unknown or absent command names what was given", () => {
  assert.throws(() => parseCommand(["bogus"]), /unknown command "bogus"/);
  assert.throws(() => parseCommand([]), /unknown command ""/);
});

test("a run id is UTC, sortable, and has no whitespace or '='", () => {
  // 23:30 at -05:00 is already the next day in UTC; the id must use UTC.
  const id = newRunId(new Date("2026-03-04T23:30:05-05:00"), "ab12");
  assert.equal(id, "g-20260305-043005-ab12");
  assert.doesNotMatch(id, /[\s=]/);
  assert.ok(newRunId(new Date("2026-03-04T10:00:00Z"), "ff") < newRunId(new Date("2026-03-04T10:00:01Z"), "00"));
});

test("status shows the header, iterations, attempts, answers and reasons, aligned", () => {
  const out = formatStatus(
    history({
      phase: "waiting",
      nodes: [
        { node: "plan", iteration: 0, status: "done", attempt: 2 },
        { node: "needs-review", iteration: 0, status: "done", answer: "yes" },
        { node: "fix", iteration: 3, status: "failed", reason: "boom" },
        { node: "review", iteration: 0, status: "skipped", reason: "gate" },
        { node: "ask", iteration: 0, status: "waiting", reason: "what next?" },
      ],
    }),
  );
  assert.equal(
    out,
    [
      "run g-1 (graph toy): waiting",
      "  plan          done (attempt 2)",
      "  needs-review  done: yes",
      "  fix #3        failed: boom",
      "  review        skipped: gate",
      "  ask           waiting",
      "",
    ].join("\n"),
  );
});

test("a first attempt prints no attempt note", () => {
  assert.doesNotMatch(formatStatus(history({ nodes: [{ node: "plan", iteration: 0, status: "done", attempt: 1 }] })), /attempt/);
});

test("a restarted node's completed status distinguishes one restart and leaves an unrestarted row unchanged", () => {
  const out = formatStatus(
    history({
      nodes: [
        { node: "A-builder", iteration: 0, status: "done", restarts: 1 },
        { node: "plain", iteration: 0, status: "done" },
      ],
    }),
  );
  assert.match(out, /^  A-builder  done \(1 restart\)$/m);
  assert.match(out, /^  plain      done$/m);
  assert.doesNotMatch(out.match(/^  plain.*$/m)![0], /restart/);
});

test("a retried node prints the attempt before its plural restart count", () => {
  assert.equal(
    formatStatus(history({ nodes: [{ node: "A-builder", iteration: 0, status: "done", attempt: 2, restarts: 2 }] })),
    "run g-1 (graph toy): running\n  A-builder  done (attempt 2) (2 restarts)\n",
  );
});

test("a failed restarted node prints its restart count before the failure reason", () => {
  assert.equal(
    formatStatus(history({ nodes: [{ node: "A-builder", iteration: 0, status: "failed", restarts: 1, reason: "boom" }] })),
    "run g-1 (graph toy): running\n  A-builder  failed (1 restart): boom\n",
  );
});

test("restart notes are absent for original runs and use singular and plural labels", () => {
  assert.equal(restartsNote(undefined), "");
  assert.equal(restartsNote(1), " (1 restart)");
  assert.equal(restartsNote(2), " (2 restarts)");
});

test("status lists loops with singular and plural iterations and their outcome", () => {
  const out = formatStatus(history({ loops: [{ loop: "a", iterations: 1 }, { loop: "b", iterations: 3, outcome: "capped" }] }));
  assert.match(out, /^ {2}loop a: 1 iteration$/m);
  assert.match(out, /^ {2}loop b: 3 iterations, capped$/m);
});

test("status with open questions names each asker and the reply command", () => {
  const out = formatStatus(history({ asking: [{ node: "plan", iteration: 0, question: "which db?" }, { node: "fix", iteration: 2, question: "retry?" }] }));
  assert.match(out, /waiting on the operator/);
  assert.match(out, /^ {2}plan asks: which db\?$/m);
  assert.match(out, /^ {2}fix #2 asks: retry\?$/m);
  assert.match(out, /reply: build-graph answer g-1 "<text>"/);
  assert.doesNotMatch(formatStatus(history({})), /waiting on the operator/);
});

test("a run with no nodes still formats", () => {
  assert.equal(formatStatus(history({})), "run g-1 (graph toy): running\n");
});

test("a run that failed outside any node shows why", () => {
  assert.equal(formatStatus(history({ phase: "failed", error: "repo /x is not a git repo" })), "run g-1 (graph toy): failed\n  error: repo /x is not a git repo\n");
});

test("cancel sends to a run still going, only reports one that ended, and sends to one whose status could not be read, saying its worker must run", () => {
  assert.deepEqual(cancelPlan("g-1", { phase: "waiting" }), { send: true, line: "cancelled g-1, which was waiting: build-graph status g-1 shows it once it has stopped" });
  for (const phase of ["done", "failed", "cancelled", "abandoned"] as const) assert.deepEqual(cancelPlan("g-1", { phase }), { send: false, line: `run g-1 already ended: ${phase}; nothing sent` });
  const unread = cancelPlan("g-1", { unread: "no status for run g-1: query timed out" });
  assert.equal(unread.send, true);
  assert.match(unread.line, /whose status could not be read \(no status for run g-1: query timed out\): the run stops once its worker runs \(build-graph dev\)/);
});
