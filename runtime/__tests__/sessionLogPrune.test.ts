/** sessionLogPrune: what moves at a merge, what never moves, the merged line, and the exit codes. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  compactSessionLog,
  findLogsByBranch,
  pruneSessionLog,
  type CompactOptions,
  type PruneOptions,
} from "../sessionLogPrune.ts";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";
import { TSX_BIN } from "./helpers/tsxBin.ts";

const SCRIPT = fileURLToPath(new URL("../sessionLogPrune.ts", import.meta.url));
const B = "quick/x";
const OPTS: PruneOptions = {
  branch: B,
  pr: 42,
  sha: "4f1c2a9",
  sessionId: "sid-1",
  now: new Date("2026-09-28T14:05:00Z"),
};

function logOf(work: string[], todo: string[], decisions: string[]): string {
  return [
    "# Session log — sid-1",
    "",
    "Started: 2026-09-28 · Worktree: /w · Origin: build x",
    "",
    "## Work log",
    "",
    ...work,
    "",
    "## Todo",
    "",
    ...todo,
    "",
    "## Decisions",
    "",
    ...decisions,
    "",
  ].join("\n");
}

function prune(log: string, archive: string | null = null, opts: PruneOptions = OPTS) {
  const r = pruneSessionLog(log, archive, opts);
  assert.ok(r.ok, "expected the log to parse");
  return r;
}

const has = (text: string | null, line: string): boolean => (text ?? "").split("\n").includes(line);

test("the branch's Work-log lines and its [x] Todo lines move; other branches and [ ] lines stay", () => {
  const log = logOf(
    ["- 14:02Z [quick/x] fix-1 merged (4f1c2a9)", "- 14:03Z [quick/y] other build", "- untagged fact"],
    ["- [x] [quick/x] hand test H1", "- [ ] [quick/x] hand test H2 on the sim", "- [x] [quick/y] other"],
    []
  );
  const r = prune(log);
  assert.equal(r.moved, 2);
  for (const gone of ["- 14:02Z [quick/x] fix-1 merged (4f1c2a9)", "- [x] [quick/x] hand test H1"]) {
    assert.ok(!has(r.log, gone), `still in log: ${gone}`);
    assert.ok(has(r.archive, gone), `not in archive: ${gone}`);
  }
  for (const kept of ["- 14:03Z [quick/y] other build", "- untagged fact", "- [ ] [quick/x] hand test H2 on the sim", "- [x] [quick/y] other"])
    assert.ok(has(r.log, kept), `moved: ${kept}`);
});

test("an open question: Todo and a Work-log question: line never move; an answered [x] question moves with its branch", () => {
  const open = "- [ ] [quick/x] question: CODEX.1 — keep the retry?";
  const answered = "- [x] [quick/x] question: CODEX.2 — keep the cache? (answered)";
  const work = "- 14:04Z [quick/x] question: SIMP.2 — banked";
  const r = prune(logOf([work], [open, answered], []));
  assert.equal(r.moved, 1);
  assert.ok(has(r.log, open) && has(r.log, work));
  assert.ok(!has(r.log, answered) && has(r.archive, answered));
});

test("the last tunable: line per key never moves, even when a later line replaces it", () => {
  const first = '- tunable: subagent_max=5 (was 4) — operator';
  const last = '- tunable: subagent_max=6 (was 5) — operator, replaces: "subagent_max=5 (was 4)"';
  const other = "- tunable: builder_tier=big-boy (was little-man)";
  const tries = '- operator: drop the override — replaces: "subagent_max=6 (was 5)"';
  const r = prune(logOf([], [], [first, last, other, tries]));
  assert.ok(!has(r.log, first) && has(r.archive, first), "the superseded tunable line should move");
  assert.ok(has(r.log, last), "the last tunable line for subagent_max moved");
  assert.ok(has(r.log, other), "the only tunable line for builder_tier moved");
});

test("the batch Todo line stays while open or while another branch merges, and moves once done at its own merge", () => {
  const open = "- [ ] [quick/batch-1] batch: ship quick/batch-1 — docs/build/briefs/quick-batch-1.md";
  const done = "- [x] [quick/batch-1] batch: ship quick/batch-1 — docs/build/briefs/quick-batch-1.md";
  assert.equal(prune(logOf([], [open], []), null, { ...OPTS, branch: "quick/batch-1" }).moved, 0);
  assert.equal(prune(logOf([], [done], [])).moved, 0, "another branch's merge leaves it");
  const r = prune(logOf([], [done], []), null, { ...OPTS, branch: "quick/batch-1" });
  assert.equal(r.moved, 1);
  assert.ok(!has(r.log, done) && has(r.archive, done));
});

test("a replaces: pair moves the old line only; a quote that is ambiguous or unmatched moves nothing", () => {
  const old = "- Operator: classes are R0/R0/R1.";
  const replacing = '- Operator: B3 is R2 — replaces: "classes are R0/R0/R1"';
  const bystander = "- Operator: no new deferred tickets.";
  const r = prune(logOf([], [], [old, bystander, replacing]));
  assert.equal(r.moved, 1);
  assert.ok(!has(r.log, old) && has(r.archive, old));
  assert.ok(has(r.log, replacing) && has(r.log, bystander));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(prune(r.log, r.archive).warnings, [], "a quote whose line is already archived is no warning");

  const twin = logOf([], [], ["- use Sonnet for A", "- use Sonnet for B", '- use Opus — replaces: "use Sonnet"', '- x — replaces: "nothing like this"']);
  const amb = prune(twin);
  assert.equal(amb.moved, 0);
  assert.match(amb.warnings[0]!, /matches 2 earlier Decisions lines — none moved/);
  assert.match(amb.warnings[1]!, /matches no earlier Decisions line — none moved/);
});

test("a later line only replaces an EARLIER one, and a replacing line's own quote does not match it", () => {
  const a = '- keep A — replaces: "use Z"';
  const later = "- use Z";
  const r = prune(logOf([], [], [a, later]));
  assert.equal(r.moved, 0);
});

test("the merged line is appended at the end of the Work log, once, and never moves", () => {
  const log = logOf(["- 14:02Z [quick/x] built"], [], []);
  const r = prune(log);
  const lines = r.log.split("\n");
  const at = lines.indexOf("- 14:05Z [quick/x] merged #42 (4f1c2a9)");
  assert.ok(at > lines.indexOf("## Work log") && at < lines.indexOf("## Todo"), r.log);
  const again = prune(r.log, r.archive);
  assert.equal(again.moved, 0);
  assert.equal(again.log.split("\n").filter((l) => l.endsWith("merged #42 (4f1c2a9)")).length, 1);
});

test("every line that leaves the log lands in the archive under its own section, after what was there", () => {
  const prior = pruneSessionLog(logOf(["- 13:00Z [quick/w] old build"], [], []), null, { ...OPTS, branch: "quick/w", pr: 41 });
  assert.ok(prior.ok);
  const log = logOf(["- 14:02Z [quick/x] built"], ["- [x] [quick/x] done"], ["- a", '- b — replaces: "a"']);
  const r = prune(log, prior.archive);
  const before = new Set(log.split("\n"));
  const after = new Set(r.log.split("\n"));
  const left = [...before].filter((l) => !after.has(l));
  assert.deepEqual(left.sort(), ["- 14:02Z [quick/x] built", "- [x] [quick/x] done", "- a"].sort());
  const arch = r.archive!.split("\n");
  const sec = (l: string) => {
    const i = arch.indexOf(l);
    return arch.slice(0, i).reverse().find((h) => h.startsWith("## "));
  };
  assert.equal(sec("- 13:00Z [quick/w] old build"), "## Work log");
  assert.equal(sec("- 14:02Z [quick/x] built"), "## Work log");
  assert.ok(arch.indexOf("- 13:00Z [quick/w] old build") < arch.indexOf("- 14:02Z [quick/x] built"));
  assert.equal(sec("- [x] [quick/x] done"), "## Todo");
  assert.equal(sec("- a"), "## Decisions");
});

test("a log without the three sections is refused", () => {
  const r = pruneSessionLog("# Session log\n\n## Work log\n\n- x\n", null, OPTS);
  assert.deepEqual(r, { ok: false, missing: ["Todo", "Decisions"] });
});

test("CLI: exit 0 writes both files and prints the count; exit 1 on a log without sections; exit 2 on usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "slp-"));
  try {
    const log = join(dir, "sid-9.md");
    writeFileSync(log, logOf(["- 14:02Z [quick/x] built"], ["- [x] [quick/x] done", "- [ ] [quick/x] open"], []));
    const ok = spawnSmoke(TSX_BIN, [SCRIPT, log, "--branch", B, "--pr", "7", "--sha", "abc1234"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), `pruned 2 lines → ${join(dir, "sid-9.archive.md")}`);
    assert.ok(existsSync(join(dir, "sid-9.archive.md")));
    const text = readFileSync(log, "utf8");
    assert.match(text, /^- \d{2}:\d{2}Z \[quick\/x\] merged #7 \(abc1234\)$/m);
    assert.ok(has(text, "- [ ] [quick/x] open"));

    const bare = join(dir, "bare.md");
    writeFileSync(bare, "# log\n\n## Work log\n");
    const one = spawnSmoke(TSX_BIN, [SCRIPT, bare, "--branch", B, "--pr", "7", "--sha", "abc1234"]);
    assert.equal(one.status, 1, one.stderr);
    assert.match(one.stderr, /no ## Todo, ## Decisions section/);

    for (const argv of [
      [log, "--branch", B, "--pr", "7"],
      [log, "--branch", B, "--pr", "x7", "--sha", "abc1234"],
      [log, "--branch", B, "--pr", "7", "--sha", "abc1234", "--dry"],
      [join(dir, "missing.md"), "--branch", B, "--pr", "7", "--sha", "abc1234"],
      [log, "--compact", "--branch", B],
      ["--compact"],
    ]) {
      const bad = spawnSmoke(TSX_BIN, [SCRIPT, ...argv]);
      assert.equal(bad.status, 2, `${argv.join(" ")}: ${bad.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const C: CompactOptions = { sessionId: "sid-1", now: new Date("2026-09-28T16:00:00Z") };
const MARK = "- 15:00Z [session] compacted";

test("--compact: a [session] Work-log line above the previous marker moves; lines after it, and every [branch] line, stay", () => {
  const log = logOf(
    ["- 14:00Z [session] old audit", "- 14:10Z [quick/x] built", MARK, "- 15:30Z [session] recent measurement", "- 15:40Z [quick/x] merged #7 (abc1234)"],
    [],
    []
  );
  const r = compactSessionLog(log, null, C);
  assert.ok(r.ok);
  assert.equal(r.moved, 1);
  assert.ok(!has(r.log, "- 14:00Z [session] old audit") && has(r.archive, "- 14:00Z [session] old audit"));
  for (const kept of ["- 14:10Z [quick/x] built", MARK, "- 15:30Z [session] recent measurement", "- 15:40Z [quick/x] merged #7 (abc1234)"])
    assert.ok(has(r.log, kept), `moved: ${kept}`);
});

test("--compact appends a new marker at the end of the Work log, and an older marker moves like any [session] line", () => {
  const older = "- 13:00Z [session] compacted";
  const r = compactSessionLog(logOf([older, "- 13:30Z [session] between", MARK, "- 15:30Z [session] after"], [], []), null, C);
  assert.ok(r.ok);
  assert.equal(r.moved, 2);
  assert.ok(!has(r.log, older) && !has(r.log, "- 13:30Z [session] between"));
  const work = r.log.split("## Todo")[0]!.trim().split("\n");
  assert.equal(work[work.length - 1], "- 16:00Z [session] compacted");
  assert.ok(has(r.log, MARK), "the previous marker stays as the next run's anchor");
});

test("--compact with no previous marker moves no Work-log line, but every [x] [session] Todo moves (answered questions too); [ ], open questions, Decisions never do", () => {
  const log = logOf(
    ["- 14:00Z [session] first fact"],
    [
      "- [x] [session] answered Q1",
      "- [ ] [session] still open",
      "- [ ] [session] question: Q3 — banked",
      "- [x] [session] question: Q2 — answered",
      "- [x] [quick/x] branch task",
    ],
    ['- 2026-09-28 [agent] a separate hook over a second print — principle 15', '- 2026-09-28 [user] "yes"']
  );
  const r = compactSessionLog(log, null, C);
  assert.ok(r.ok);
  assert.equal(r.moved, 2);
  assert.ok(has(r.log, "- 14:00Z [session] first fact"));
  for (const gone of ["- [x] [session] answered Q1", "- [x] [session] question: Q2 — answered"])
    assert.ok(!has(r.log, gone) && has(r.archive, gone), `stayed: ${gone}`);
  for (const kept of [
    "- [ ] [session] still open",
    "- [ ] [session] question: Q3 — banked",
    "- [x] [quick/x] branch task",
    "- 2026-09-28 [agent] a separate hook over a second print — principle 15",
    '- 2026-09-28 [user] "yes"',
  ])
    assert.ok(has(r.log, kept), `moved: ${kept}`);
});

test("--compact warns on an [agent] Decisions line that names no principle or rule, and moves none", () => {
  const good = "- 2026-10-01 [agent] same section over a new one — principle 15";
  const alsoGood = "- [agent] stop tuning now, rule 2";
  const bad = "- 2026-10-01 [agent] picked (a) over (b) because it felt simpler";
  const user = '- 2026-10-01 [user] "yes"';
  const r = compactSessionLog(logOf([], [], [good, alsoGood, bad, user]), null, C);
  assert.ok(r.ok);
  assert.equal(r.moved, 0);
  assert.deepEqual(r.warnings, [`[agent] line names no principle or rule: ${bad}`]);
  for (const kept of [good, alsoGood, bad, user]) assert.ok(has(r.log, kept));
});

test("without <log>, a merge prune hits every log that carries the branch (a handoff splits one); none → exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "slp-"));
  try {
    const a = join(dir, "sid-a.md");
    const b = join(dir, "sid-b.md");
    writeFileSync(join(dir, "TEMPLATE.md"), logOf(["- 14:00Z [quick/x] template never counts"], [], []));
    writeFileSync(a, logOf(["- 14:00Z [quick/x] built in a"], [], []));
    writeFileSync(b, logOf(["- 14:00Z [other/y] built in b"], [], []));
    const handedOff = join(dir, "sid-c.md");
    writeFileSync(handedOff, logOf(["- 15:00Z [quick/x] continued in c after a handoff"], [], []));
    assert.deepEqual(findLogsByBranch(dir, B).sort(), [a, handedOff].sort());
    assert.deepEqual(findLogsByBranch(dir, "nope/z"), []);
    const ok = spawnSmoke(TSX_BIN, [SCRIPT, "--branch", B, "--pr", "7", "--sha", "abc1234"], {
      env: { ...process.env, SESSION_LOGS_DIR: dir },
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(readFileSync(a, "utf8"), /\[quick\/x\] merged #7 \(abc1234\)/);
    assert.match(readFileSync(handedOff, "utf8"), /\[quick\/x\] merged #7 \(abc1234\)/);
    assert.equal(ok.stdout.trim().split("\n").length, 2, "one result line per pruned log");
    assert.ok(!/merged #7/.test(readFileSync(b, "utf8")));
    const none = spawnSmoke(TSX_BIN, [SCRIPT, "--branch", "nope/z", "--pr", "7", "--sha", "abc1234"], {
      env: { ...process.env, SESSION_LOGS_DIR: dir },
    });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no session log under .* carries a \[nope\/z\] line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
