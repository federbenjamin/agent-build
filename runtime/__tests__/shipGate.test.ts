/**
 * shipGate.ts over the flow-2 ledger (build-spec §3 G4): each test a fixture ledger plus a run dir
 * in a throwaway repo with a fake signals arm (`helpers/owedRun.ts`). The owed facts themselves are
 * `owed.test.ts`'s; these pin what the gate adds (the wave's readers, the notes, the exit codes,
 * `--print-checks`) and the G4 fixture list end to end.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { FLOW_CHANGED, parseLedger } from "../lib/ledger.ts";
import type { OwedFacts } from "../lib/owed.ts";
import type { RiskClass } from "../lib/riskClass.ts";
import type { RoundId } from "../lib/runFiles.ts";
import * as shipGate from "../shipGate.ts";
import { checkFlags, gate, main, waveFailures } from "../shipGate.ts";
import {
  ALL_ROUNDS,
  blk,
  briefedHead,
  briefText,
  EXIT_CHECKS,
  type Run,
  stageFile,
  STORE_BRIEF,
  withRun,
} from "./helpers/owedRun.ts";

const DEPS = { hunterMinLines: 20 };

const WAVE_READERS: Record<RiskClass, string> = {
  R0: "review-cursory, build-verifier",
  R1: "review-cursory, gate-silent-failure-hunter, build-verifier",
  R2: "review-cursory, gate-silent-failure-hunter, build-verifier, security-review",
};

/** A briefed run's head lines, its wave naming the class's reader set. */
function head(run: Run, cls: RiskClass): string[] {
  return briefedHead(cls, run.wave).map((l) => (l.startsWith("wave:") ? `wave: ${WAVE_READERS[cls]} | sha=${run.wave}` : l));
}

interface Cli {
  code: number;
  out: string[];
  err: string[];
}

/** Runs the gate's CLI over the run's `ship.md`, with the repo as cwd, capturing its output. */
async function cli(run: Run, extra: string[] = []): Promise<Cli> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  let code = -1;
  try {
    await main(["--ledger", join(run.runDir, "ship.md"), ...extra], (c) => (code = c), { cwd: run.repo, deps: DEPS });
  } finally {
    console.log = log;
    console.error = error;
  }
  return { code, out, err };
}

/** The failure lines a failing CLI run printed. */
const failures = (r: Cli) => r.err.filter((l) => l.startsWith("  - ")).map((l) => l.slice(4));

/** The wave's reader files for class `cls`: the cursory read holds `blocks`; the rest are clean. */
function wave(run: Run, cls: RiskClass, blocks: string[] = []): void {
  run.write("review-cursory.md", blocks.length === 0 ? "NO FINDINGS\n" : blocks.join("\n"));
  run.write("build-verifier.md", "NO FINDINGS\nVERDICT: CLEAN\n");
  if (cls !== "R0") run.write("gate-silent-failure-hunter.md", "NO FINDINGS\n");
  if (cls === "R2") run.write("security-review.md", "NO FINDINGS\n");
}

/** A run whose wave found nothing: every round empty, the verifier clean, the one claim passed. */
function noFindings(run: Run, cls: RiskClass = "R1"): string[] {
  wave(run, cls);
  run.handTest(1, `H1 · pass · ${run.wave} — hand-test-1/H1.out\n`);
  run.build(ALL_ROUNDS, run.wave);
  return [...head(run, cls), `verifier: CLEAN | sha=${run.wave}`, `hand-test-1: 1/1 | sha=${run.wave}`];
}

/**
 * G4 fixture 1: a wave with two findings, fix round 1, confirm-1 leaves one open and hand test 1
 * fails on code at round 1's head (row HAND.1), fix round 2, confirm-2 closes both, and hand test 2
 * passes at round 2's head. `codexFailed` has the Sonnet stand-in answer confirm-1 beside a refused
 * Codex file. Returns the ledger without its `ship:` line, and round 2's head.
 */
function fullRun(run: Run, opts: { codexFailed?: string } = {}) {
  wave(run, "R1", [blk("CURSORY.1", "behavior"), blk("CURSORY.2", "test-app", "test/app.test.ts:1")]);
  run.build(["1"], run.wave);
  const s1 = run.commit({ "src/app.ts": "export const a = 3;\n", "test/app.test.ts": "// pinned\n" }, "fix(close): round 1 — 2 rows");
  run.write("fix-1.txt", `CURSORY.1 · fixed · ${s1} — a is 3\nCURSORY.2 · fixed · ${s1} — pinned\n${EXIT_CHECKS}\n`);
  const confirm1 = stageFile(["- CURSORY.1 · unresolved — a is still wrong", "- CURSORY.2 · resolved"]);
  if (opts.codexFailed === undefined) run.write("stage-confirm-1/review-cursory-codex.md", confirm1);
  else {
    run.write("stage-confirm-1/review-cursory.md", confirm1);
    run.write("stage-confirm-1/review-cursory-codex.refused.txt", "### CODEX.101 — no kind\n- locator: src/app.ts:1\n");
  }
  run.handTest(1, `H1 · fail (code) · ${s1} — hand-test-1/H1.out — no answer came back\n`);
  run.build(["2"], s1);
  const s2 = run.commit({ "src/app.ts": "export const a = 4;\n" }, "fix(close): round 2 — 2 rows");
  run.write("fix-2.txt", `CURSORY.1 · fixed · ${s2} — a is 4\nHAND.1 · fixed · ${s2} — it answers\n${EXIT_CHECKS}\n`);
  run.write("stage-confirm-2/review-cursory-codex.md", stageFile(["- CURSORY.1 · resolved", "- HAND.1 · resolved"]));
  run.handTest(2, `H1 · pass · ${s2} — hand-test-2/H1.out\n`);
  run.build(["3", "escalate", "final"], s2);
  const lines = [
    ...head(run, "R1"),
    `verifier: CLEAN | sha=${run.wave}`,
    `fix-1: 2/2 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`,
    `confirm-1: ${opts.codexFailed === undefined ? "review-cursory-codex" : `review-cursory (codex failed: ${opts.codexFailed})`} | sha=${s1}`,
    `hand-test-1: 0/1 | sha=${s1}`,
    `fix-2: 2/2 | model=sonnet | agent=f2 | from=${s1} | sha=${s2}`,
    `confirm-2: review-cursory-codex | sha=${s2}`,
    `hand-test-2: 1/1 | sha=${s2}`,
  ];
  return { lines, s2 };
}

// ── The G4 fixture list (build-spec §3 G4, tests 1–8) ───────────────────────────────────────

test("1. wave, confirm, re-confirm, and two hand tests: passes, and the marker owes every check", async () => {
  await withRun(async (run) => {
    const { lines, s2 } = fullRun(run);
    run.ledger([...lines, `ship: https://example.test/pr/1 | sha=${s2}`]);
    const r = await cli(run);
    assert.equal(r.code, 0, r.err.join("\n"));
    assert.deepEqual(r.err, []);
    assert.equal(
      r.out.at(-1),
      "ship:gate PASS — class R1, flow, brief, steps, build, freshen, wave, verifier, fix-1, confirm-1, hand-test-1, fix-2, confirm-2, hand-test-2, ship reported; the marker owes freshen, wave, fix, confirm, hand-test, verifier"
    );
    const flags = await cli(run, ["--print-checks"]);
    assert.equal(flags.code, 0);
    assert.deepEqual(flags.out, [
      "--check freshen=PASS --check wave=PASS --check fix=PASS --check confirm=PASS --check hand-test=PASS --check verifier=PASS",
    ]);
  });
});

test("2. no findings (wave, hand test, no fix, no confirm): passes; fix and confirm print N/A", async () => {
  await withRun(async (run) => {
    run.ledger([...noFindings(run), `ship: x | sha=${run.wave}`]);
    const r = await cli(run);
    assert.equal(r.code, 0, r.err.join("\n"));
    const flags = await cli(run, ["--print-checks"]);
    assert.deepEqual(flags.out, [
      "--check freshen=PASS --check wave=PASS --check fix=N/A --check confirm=N/A --check hand-test=PASS --check verifier=PASS",
    ]);
  });
});

test("branch=: the run's own branch passes; a tree on another branch is exit 2 with the message, never a verdict", async () => {
  await withRun(async (run) => {
    const lines = [...noFindings(run), `ship: x | sha=${run.wave}`];
    const withBranch = (b: string) => lines.map((l) => (l.startsWith("freshen:") ? `freshen: merged | base=main | branch=${b} | sha=${run.wave}` : l));
    run.ledger(withBranch("quick/x"));
    const own = await cli(run);
    assert.equal(own.code, 0, own.err.join("\n"));
    run.ledger(withBranch("quick/other"));
    const other = await cli(run);
    assert.deepEqual([other.code, other.out, other.err], [
      2,
      [],
      ["ship:gate: run run is on quick/other; this tree is on quick/x — enter the run's tree first"],
    ]);
  });
});

test("3a. an open behavior row in final fails, named; --print-checks prints no flags", async () => {
  await withRun(async (run) => {
    stepNine(run, true);
    const r = await cli(run);
    assert.equal(r.code, 1);
    assert.deepEqual(failures(r), ["final: open CURSORY.1 behavior — the PR stays draft; the operator decides"]);
    const flags = await cli(run, ["--print-checks"]);
    assert.equal(flags.code, 1);
    assert.deepEqual(flags.out, []);
    assert.deepEqual(failures(flags), ["final: open CURSORY.1 behavior — the PR stays draft; the operator decides"]);
  });
});

test("3b. `hand-test-1: skipped` with a claim fails, named", async () => {
  await withRun(async (run) => {
    const lines = noFindings(run).filter((l) => !l.startsWith("hand-test-1:"));
    run.ledger([...lines, "hand-test-1: skipped — no claims", `ship: x | sha=${run.wave}`]);
    const r = await cli(run);
    assert.equal(r.code, 1);
    assert.ok(failures(r).includes("hand-test-1: skipped — the brief has 1 claims (H1); run them"), r.err.join("\n"));
  });
});

test("3c. a missing `confirm-1:` when round 1 had rows fails, named", async () => {
  await withRun(async (run) => {
    const { lines, s2 } = fullRun(run);
    run.ledger([...lines.filter((l) => !l.startsWith("confirm-1:")), `ship: x | sha=${s2}`]);
    const r = await cli(run);
    assert.equal(r.code, 1);
    assert.deepEqual(failures(r), ["missing line: confirm-1:"]);
  });
});

test("3d/3e. a fourth fix round (`fix-4:`) and a second `escalate:` are unreadable ledgers: exit 2, named", async () => {
  await withRun(async (run) => {
    const { lines, s2 } = fullRun(run);
    run.ledger([...lines, `fix-4: 1/1 | model=sonnet | agent=f4 | from=${s2} | sha=${s2}`, `ship: x | sha=${s2}`]);
    let r = await cli(run);
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), /`fix-4:` is not a ledger move/);
    const esc = `escalate: 0/0 | model=opus | agent=e1 | from=${s2} | sha=${s2}`;
    run.ledger([...lines, esc, esc, `ship: x | sha=${s2}`]);
    r = await cli(run);
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), /two `escalate:` lines — one line per move/);
  });
});

test("3f. an `escalate:` whose open set held only a structure row fails, named", async () => {
  await withRun(async (run) => {
    wave(run, "R1");
    run.write("simplifier.md", blk("SIMP.1", "structure"));
    run.build(["1"], run.wave);
    const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
    run.write("fix-1.txt", `SIMP.1 · fixed · ${s1} — split\n${EXIT_CHECKS}\n`);
    run.write("stage-confirm-1/review-cursory-codex.md", stageFile(["- SIMP.1 · unresolved — still two"]));
    run.build(["2"], s1);
    const s2 = run.commit({ "src/app.ts": "export const a = 4;\n" }, "fix 2");
    run.write("fix-2.txt", `SIMP.1 · fixed · ${s2} — split again\n${EXIT_CHECKS}\n`);
    run.write("stage-confirm-2/review-cursory-codex.md", stageFile(["- SIMP.1 · unresolved — still two"]));
    run.build(["3", "escalate"], s2);
    const s3 = run.commit({ "src/app.ts": "export const a = 5;\n" }, "escalate");
    run.write("stage-escalate/review-cursory-codex.md", stageFile([]));
    run.handTest(1, `H1 · pass · ${s3} — hand-test-1/H1.out\n`);
    run.build(["final"], s3);
    const rounds = JSON.parse(readFileSync(join(run.runDir, "table.json"), "utf8")).rounds;
    assert.deepEqual(rounds["3"].leftovers.map((l: { row: { id: string } }) => l.row.id), ["SIMP.1"], "round 3 does not fix structure");
    run.ledger([
      ...head(run, "R1"),
      `verifier: CLEAN | sha=${run.wave}`,
      `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`,
      `confirm-1: review-cursory-codex | sha=${s1}`,
      `fix-2: 1/1 | model=sonnet | agent=f2 | from=${s1} | sha=${s2}`,
      `confirm-2: review-cursory-codex | sha=${s2}`,
      `escalate: 1/1 | model=opus | agent=e1 | from=${s2} | sha=${s3}`,
      `escalate-read: review-cursory-codex | sha=${s3}`,
      `hand-test-1: 1/1 | sha=${s3}`,
      "leftovers: pr-body | rows=1 | scope=plan-QRK-5",
      `ship: x | sha=${s3}`,
    ]);
    let r = await cli(run);
    assert.equal(r.code, 1);
    assert.deepEqual(failures(r), ["escalate: round escalate had no rows, so no fixer ran — the line must not exist"]);

    // A table that put the structure row in the escalate round anyway is refused on its own.
    run.table({ ...rounds, escalate: { ...rounds.escalate, rows: [rounds["3"].leftovers[0].row] } });
    r = await cli(run);
    assert.equal(r.code, 1);
    assert.ok(
      failures(r).includes(
        "table.json round escalate holds SIMP.1 (structure) — round escalate does not fix that kind; re-build it with `reviewTable.ts build --round escalate`"
      ),
      r.err.join("\n")
    );
  });
});

/** Fixture 4: three fix rounds on one behavior row, then the escalate round and its read. */
function stepNine(run: Run, open: boolean) {
  wave(run, "R1", [blk("CURSORY.1", "behavior")]);
  run.build(["1"], run.wave);
  const steps: [RoundId, string, string][] = [
    ["2", "fix-1.txt", "stage-confirm-1"],
    ["3", "fix-2.txt", "stage-confirm-2"],
    ["escalate", "fix-3.txt", "stage-last"],
    ["final", "fix-escalate.txt", "stage-escalate"],
  ];
  const s: string[] = [];
  steps.forEach(([next, fix, stage], i) => {
    const sha = run.commit({ "src/app.ts": `export const a = ${11 + i};\n` }, `fix round ${i + 1}`);
    s.push(sha);
    run.write(fix, `CURSORY.1 · fixed · ${sha} — another try\n${EXIT_CHECKS}\n`);
    const resolved = next === "final" && !open;
    run.write(`${stage}/review-cursory-codex.md`, stageFile([resolved ? "- CURSORY.1 · resolved" : "- CURSORY.1 · unresolved — not yet"]));
    if (next === "final") run.handTest(1, `H1 · pass · ${sha} — hand-test-1/H1.out\n`);
    run.build([next], sha);
  });
  run.ledger([
    ...head(run, "R1"),
    `verifier: CLEAN | sha=${run.wave}`,
    `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s[0]}`,
    `confirm-1: review-cursory-codex | sha=${s[0]}`,
    `fix-2: 1/1 | model=sonnet | agent=f2 | from=${s[0]} | sha=${s[1]}`,
    `confirm-2: review-cursory-codex | sha=${s[1]}`,
    `fix-3: 1/1 | model=sonnet | agent=f3 | from=${s[1]} | sha=${s[2]}`,
    `last-read: review-cursory-codex | sha=${s[2]}`,
    `escalate: 1/1 | model=opus | agent=e1 | from=${s[2]} | sha=${s[3]}`,
    `escalate-read: review-cursory-codex | sha=${s[3]}`,
    `hand-test-1: 1/1 | sha=${s[3]}`,
    `ship: x | sha=${s[3]}`,
  ]);
}

test("4. step 9: three fix rounds, one escalate, one escalate-read — passes when final.open is empty, fails when not", async () => {
  await withRun(async (run) => {
    stepNine(run, false);
    const pass = await cli(run);
    assert.equal(pass.code, 0, pass.err.join("\n"));
  });
  await withRun(async (run) => {
    stepNine(run, true);
    const fail = await cli(run);
    assert.equal(fail.code, 1);
    assert.deepEqual(failures(fail), ["final: open CURSORY.1 behavior — the PR stays draft; the operator decides"]);
  });
});

// ── A banked run the operator answered (UNBANK.md) ─────────────────

/** `stepNine`'s open run, banked at its escalate head: the ledger without its `ship:` line, plus
 *  `banked:`, and that head. */
function bankedRun(run: Run): { lines: string[]; at: string } {
  stepNine(run, true);
  const lines = readFileSync(join(run.runDir, "ship.md"), "utf8").trimEnd().split("\n").filter((l) => !l.startsWith("ship:"));
  return { lines: [...lines, "banked: CURSORY.1 (awaiting operator)"], at: run.head() };
}

test("unbank: a banked run never unbanked still fails on its open row and its banked id", async () => {
  await withRun(async (run) => {
    const { lines, at } = bankedRun(run);
    run.ledger([...lines, `ship: x | sha=${at}`]);
    const r = await cli(run);
    assert.equal(r.code, 1);
    assert.deepEqual(failures(r), [
      "final: open CURSORY.1 behavior — the PR stays draft; the operator decides",
      "banked: CURSORY.1 — a banked run does not ship; answer the questions first",
    ]);
  });
});

test("unbank: the operator's answer fixed and read once passes, and the read's own fix after it owes nothing more", async () => {
  await withRun(async (run) => {
    const { lines, at } = bankedRun(run);
    const fix = run.commit({ "src/app.ts": "export const a = 99;\n" }, "fix(unbank): CURSORY.1");
    run.write("unbank/review-cursory.md", blk("CURSORY.1", "behavior"));
    const after = run.commit({ "src/app.ts": "export const a = 100;\n" }, "fix(unbank): the read's CURSORY.1");
    run.ledger([
      ...lines,
      `unbank: CURSORY.1 | from=${at} | sha=${fix} | model=sonnet | agent=u1`,
      `unbank-read: review-cursory | sha=${fix}`,
      `ship: x | sha=${after}`,
    ]);
    const r = await cli(run);
    assert.equal(r.code, 0, r.err.join("\n"));
  });
});

test("unbank: no read, a read at another head, no read file, an id never banked, a from= before the bank, and a wrong model fail, named", async () => {
  await withRun(async (run) => {
    const { lines, at } = bankedRun(run);
    const fix = run.commit({ "src/app.ts": "export const a = 99;\n" }, "fix(unbank): CURSORY.1");
    const unbank = `unbank: CURSORY.1 | from=${at} | sha=${fix}`;
    const ship = `ship: x | sha=${fix}`;
    run.ledger([...lines, unbank, ship]);
    assert.deepEqual(failures(await cli(run)), ["missing line: unbank-read:"]);
    run.ledger([...lines, unbank, `unbank-read: review-cursory | sha=${at}`, ship]);
    assert.deepEqual(failures(await cli(run)), [
      `unbank-read: sha=${at} — the read covers ${at.slice(0, 9)}..${fix}, so it names ${fix}; a read at another head read other code — run it again over that range`,
      "unbank-read: no unbank/ folder in the run dir",
    ]);
    run.write("unbank/review-cursory.md", "NO FINDINGS — the answer is carried out\n");
    const read = `unbank-read: review-cursory | sha=${fix}`;
    run.ledger([...lines, `unbank: CURSORY.1, CURSORY.7 | from=${at} | sha=${fix} | model=opus | agent=u1`, read, ship]);
    assert.deepEqual(failures(await cli(run)), [
      "unbank: CURSORY.7 was never banked — name only ids a `banked:` line holds",
      "unbank: model=opus — this run owes sonnet",
    ]);
    run.ledger([...lines, `unbank: CURSORY.1 | from=${run.wave} | sha=${fix}`, read, ship]);
    assert.deepEqual(failures(await cli(run)), [
      `unbank: from=${run.wave} — the run banked at the escalate round's end ${at}, which is not its ancestor; from= is the head the run banked at`,
    ]);
    run.ledger([...lines, read, ship]);
    const noUnbank = failures(await cli(run));
    assert.ok(noUnbank.includes("unbank-read: no `unbank:` line — the read follows the banked rows' fix"), noUnbank.join("\n"));
  });
});

test("5. `hand-test-1: skipped — no claims` at R1 with no claims: passes, and the marker owes no hand-test", async () => {
  await withRun(
    async (run) => {
      wave(run, "R1");
      run.build(ALL_ROUNDS, run.wave);
      run.ledger([...head(run, "R1"), `verifier: CLEAN | sha=${run.wave}`, "hand-test-1: skipped — no claims", `ship: x | sha=${run.wave}`]);
      const r = await cli(run);
      assert.equal(r.code, 0, r.err.join("\n"));
      assert.deepEqual((await cli(run, ["--print-checks"])).out, [
        "--check freshen=PASS --check wave=PASS --check fix=N/A --check confirm=N/A --check hand-test=N/A --check verifier=PASS",
      ]);
    },
    { brief: briefText({ claims: "none — the diff changes only a doc" }) }
  );
});

// Test 6 (the merge check) lives in checkMergeEligibility.test.ts; test 7's `--check apply=` half
// in emitMarker.test.ts.

test("7. an old ledger (no `flow: 2`) fails with the flow-changed message: exit 2", async () => {
  await withRun(async (run) => {
    run.ledger([`class: R1 — operator, 2026-09-28`, `freshen: x | sha=${run.wave}`, `apply: 1/1 | sha=${run.wave}`]);
    const r = await cli(run);
    assert.equal(r.code, 2);
    assert.equal(r.err.join("\n"), `ship:gate: ${join(run.runDir, "ship.md")}: ${FLOW_CHANGED}`);
  });
});

test("8. Codex failed: a `review-cursory (codex failed: …)` read line with a colon and spaces passes; a renamed refused file is left out", async () => {
  await withRun(async (run) => {
    const { lines, s2 } = fullRun(run, { codexFailed: "exit 1: spawn timeout; no out file" });
    run.ledger([...lines, `ship: x | sha=${s2}`]);
    const r = await cli(run);
    assert.equal(r.code, 0, r.err.join("\n"));
  });
});

test("store: a public repo whose brief is in the store passes the gate; a branch whose first commit records no brief fails on order", async () => {
  const inStore = (lines: string[]) => lines.map((l) => (l.startsWith("brief:") ? `brief: ${STORE_BRIEF}` : l));
  await withRun(
    async (run) => {
      const { lines, s2 } = fullRun(run);
      run.ledger([...inStore(lines), `ship: https://example.test/pr/1 | sha=${s2}`]);
      const r = await cli(run);
      assert.equal(r.code, 0, r.err.join("\n"));
      assert.match(r.out.at(-1)!, /^ship:gate PASS — class R1, /);
      assert.deepEqual(r.out.filter((l) => l.startsWith("note:")), [], "the signals step came from the store's build-steps.toml, not a fallback");
    },
    { store: "before" }
  );
  await withRun(
    async (run) => {
      const { lines, s2 } = fullRun(run);
      run.ledger([...inStore(lines), `ship: https://example.test/pr/1 | sha=${s2}`]);
      const r = await cli(run);
      assert.equal(r.code, 1, r.err.join("\n"));
      assert.equal(failures(r).length, 1, r.err.join("\n"));
      assert.equal(
        failures(r)[0],
        `brief: ${STORE_BRIEF} is not recorded by the branch's first commit ${run.wave} — that commit is an empty one whose subject is \`brief: ${STORE_BRIEF} @ <store commit>\` (BRIEF step 6), so nothing proves it came before the work it grades`
      );
    },
    { store: "after" }
  );
});

// ── R.10, the exit codes, and what the gate adds to the owed facts ───────────────────────────

test("R.10: a doctor commit after the final table that touches only scripts/public-api-snapshot.json passes", async () => {
  await withRun(async (run) => {
    const lines = noFindings(run);
    const doctor = run.commit({ "scripts/public-api-snapshot.json": "{\"a\":1}\n" }, "tooling(repo): doctor — snapshot");
    run.ledger([...lines, `ship: x | sha=${doctor}`]);
    const r = await cli(run);
    assert.equal(r.code, 0, r.err.join("\n"));
  });
});

test("a signals arm that cannot run here is exit 2 with its line, never a verdict", async () => {
  const eperm = `console.error("Error: listen EPERM: operation not permitted /tmp/tsx-501/1.pipe"); process.exit(1);`;
  await withRun(
    async (run) => {
      const { lines, s2 } = fullRun(run);
      run.ledger([...lines, `ship: x | sha=${s2}`]);
      const r = await cli(run);
      assert.equal(r.code, 2);
      assert.deepEqual(r.out, []);
      assert.match(r.err.join("\n"), /^ship:gate: the signals arm could not run here \(.*listen EPERM.*\) — re-run outside the sandbox$/);
    },
    { arm: eperm }
  );
});

test("usage: an unknown flag, a stray argument, --json with --print-checks, and no base are exit 2", async () => {
  await withRun(async (run) => {
    const lines = [...noFindings(run), `ship: x | sha=${run.wave}`];
    run.ledger(lines);
    for (const extra of [["--bogus"], ["stray"], ["--json", "--print-checks"]]) {
      const r = await cli(run, extra);
      assert.equal(r.code, 2, extra.join(" "));
      assert.deepEqual(r.out, [], extra.join(" "));
    }
    run.ledger(lines.filter((l) => !l.startsWith("freshen:")));
    const noBase = await cli(run);
    assert.equal(noBase.code, 2);
    assert.equal(noBase.err.join("\n"), "ship:gate: no base — the ledger's `freshen:` line has no base=, and no --base was given");
  });
});

test("--json prints the result with the checks the marker owes, and exits 1 on a failure", async () => {
  await withRun(async (run) => {
    run.ledger([...noFindings(run), `ship: x | sha=${run.wave}`, "banked: CURSORY.9"]);
    const r = await cli(run, ["--json"]);
    assert.equal(r.code, 1);
    const json = JSON.parse(r.out.join("\n"));
    assert.equal(json.ok, false);
    assert.equal(json.class, "R1");
    assert.deepEqual(json.markerChecks, ["freshen", "wave", "hand-test", "verifier"]);
    assert.deepEqual(json.failures, ["banked: CURSORY.9 — a banked run does not ship; answer the questions first"]);
  });
});

test("the old gate's parser, line rules, and drift edge are gone from shipGate.ts", () => {
  for (const name of ["parseLedger", "REQUIRED_LINES", "requiredLinesFor", "requiredMarkerChecks", "mainDriftSinceWave", "collectGit"]) {
    assert.ok(!(name in shipGate), name);
  }
});

// ── The wave's readers (pure) ────────────────────────────────────────────────────────────────

const L = (cls: RiskClass, wave: string, extra: string[] = []) =>
  parseLedger([`class: ${cls} — operator, 2026-09-28`, "flow: 2", ...extra, `wave: ${wave} | sha=aaaaaaa`].join("\n"));

test("wave: a briefed run owes build-verifier at every class; --from-branch is exempt", () => {
  assert.deepEqual(waveFailures(L("R0", "review-cursory")), [
    "wave: no build-verifier — the verifier reads every run that has a brief, at every class; only `--from-branch` is exempt (/build §CLOSE)",
  ]);
  assert.deepEqual(waveFailures(L("R0", "review-cursory", ["from-branch: quick/x"])), []);
});

test("wave: R2 owes security-review and never lets it sit out; the hunter sits out only through skipped:", () => {
  assert.deepEqual(waveFailures(L("R2", "review-cursory, gate-silent-failure-hunter, build-verifier | skipped: security-review — small")), [
    "wave: no security-review — R2 owes it and it never sits out (/build §CLOSE)",
  ]);
  assert.deepEqual(waveFailures(L("R1", "review-cursory, build-verifier")), [
    "wave: no gate-silent-failure-hunter — R1 owes it; name it in the reader list or in `skipped: gate-silent-failure-hunter — <threshold>` (/build §CLOSE)",
  ]);
  assert.deepEqual(waveFailures(L("R1", "review-cursory, build-verifier | skipped: gate-silent-failure-hunter — 12 < 20")), []);
});

test("gate(): the owed failures and notes pass through; unconfirmed class, from-branch, and skipped readers are notes", () => {
  const owed: OwedFacts = {
    fromBranch: true,
    briefPath: null,
    claims: [],
    claimsAtFirst: null,
    targets: "all",
    model: "sonnet",
    lines: [],
    readers: {},
    markerChecks: ["freshen", "wave"],
    failures: ["missing line: ship:"],
    notes: ["signals: fallback"],
  };
  const ledger = parseLedger(
    [
      "class: R1 (agent, unconfirmed)",
      "flow: 2",
      "from-branch: quick/x",
      "wave: review-cursory | skipped: gate-silent-failure-hunter — 3 < 20 | sha=aaaaaaa",
    ].join("\n")
  );
  assert.deepEqual(gate(ledger, owed), {
    ok: false,
    failures: ["missing line: ship:"],
    notes: [
      "class unconfirmed (agent) — the agent picked it; the ship notification says so",
      "from-branch: quick/x",
      "completeness unchecked — a from-branch run has no brief, so no verifier ran",
      "skipped: gate-silent-failure-hunter — 3 < 20",
      "signals: fallback",
    ],
    markerChecks: ["freshen", "wave"],
  });
});

test("checkFlags: PASS for each owed check, N/A for the rest, in marker order", () => {
  assert.equal(
    checkFlags(["verifier", "freshen"]),
    "--check freshen=PASS --check wave=N/A --check fix=N/A --check confirm=N/A --check hand-test=N/A --check verifier=PASS"
  );
});
