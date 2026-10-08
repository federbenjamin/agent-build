/** owed: what a run owes and the facts the session did not write (build-spec §1.9), over real
 *  throwaway repos with a fake signals arm. */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { summariseBrief } from "../lib/brief.ts";
import { parseLedger } from "../lib/ledger.ts";
import type { RoundId } from "../lib/runFiles.ts";
import { rebuildCommand } from "../lib/tableReplay.ts";
import {
  ArmEnvError,
  buildPartsFailures,
  claimStates,
  owedFacts,
  owedModel,
  planStage,
  runContext,
} from "../lib/owed.ts";
import {
  ALL_ROUNDS,
  blk,
  BRIEF_PATH,
  briefedHead,
  briefText,
  EXIT_CHECKS,
  finalRound,
  round,
  row,
  type Run,
  stageFile,
  STORE_BRIEF,
  STORE_BRIEF_PATH,
  TWO_CLAIMS,
  waveFiles,
  withRun,
} from "./helpers/owedRun.ts";

const DEPS = { hunterMinLines: 20 };
const HEAD_LINES = "class: R1 — operator, 2026-09-28\nflow: 2\n";

async function facts(run: Run) {
  const ledger = parseLedger(readFileSync(join(run.runDir, "ship.md"), "utf8"));
  return owedFacts(ledger, run.runDir, run.repo, "main", DEPS);
}

async function context(run: Run, ledgerLines: string[]) {
  run.ledger(ledgerLines);
  return runContext(parseLedger(`${ledgerLines.join("\n")}\n`), run.runDir, run.repo, "main", DEPS);
}

/** A run whose wave found nothing and whose one claim passed at the wave head. */
function noFindingsRun(run: Run, cls = "R1"): void {
  waveFiles(run);
  run.handTest(1, `H1 · pass · ${run.wave} — hand-test-1/H1.out\n`);
  run.build(ALL_ROUNDS, run.wave);
  run.ledger([
    ...briefedHead(cls, run.wave),
    `verifier: CLEAN | sha=${run.wave}`,
    `hand-test-1: 1/1 | sha=${run.wave}`,
    `ship: https://example.test/pr/1 | sha=${run.wave}`,
  ]);
}

/** A run whose wave found CURSORY.1 (behavior), fixed at the returned sha `s1`, confirmed by
 *  `stage-confirm-1/review-cursory.md`, with every round built from those files. */
function oneRowRun(
  run: Run,
  opts: { fixLine?: (s1: string) => string; status?: string[]; head?: (s1: string) => string } = {}
): string {
  waveFiles(run, [blk("CURSORY.1", "behavior")]);
  run.build(["1"], run.wave);
  const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix(close): round 1 — 1 rows");
  run.write("fix-1.txt", `${opts.fixLine?.(s1) ?? `CURSORY.1 · fixed · ${s1} — a is 3`}\n${EXIT_CHECKS}\n`);
  run.write("stage-confirm-1/review-cursory.md", stageFile(opts.status ?? ["- CURSORY.1 · resolved"]));
  run.handTest(1, `H1 · pass · ${s1} — hand-test-1/H1.out\n`);
  run.build(["2", "3", "escalate", "final"], opts.head?.(s1) ?? s1);
  return s1;
}

/** The ledger for `oneRowRun`. */
function oneRowLines(run: Run, s1: string): string[] {
  return [
    ...briefedHead("R1", run.wave),
    `verifier: CLEAN | sha=${run.wave}`,
    `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`,
    `confirm-1: review-cursory (codex failed: exit 1) | sha=${s1}`,
    `hand-test-1: 1/1 | sha=${s1}`,
    `ship: https://example.test/pr/1 | sha=${s1}`,
  ];
}

test("a no-findings ledger owes no fix and no confirm, and passes", async () => {
  await withRun(async (run) => {
    noFindingsRun(run);
    const f = await facts(run);
    assert.deepEqual(f.failures, []);
    assert.ok(!f.lines.includes("fix-1") && !f.lines.includes("confirm-1"), f.lines.join(", "));
    assert.deepEqual(f.markerChecks, ["freshen", "wave", "hand-test", "verifier"]);
    assert.deepEqual(f.claims, ["H1"]);
    assert.equal(f.claimsAtFirst, 1);
    assert.deepEqual(f.targets, ["src/app.ts"]);
    assert.equal(f.model, "sonnet");
  });
});

test("a round with rows owes its fix line and confirm-1; a Codex stand-in passes; a missing stage file fails", async () => {
  await withRun(async (run) => {
    const s1 = oneRowRun(run);
    const lines = oneRowLines(run, s1);
    run.ledger(lines);
    const f = await facts(run);
    assert.deepEqual(f.failures, []);
    assert.ok(f.lines.includes("fix-1") && f.lines.includes("confirm-1"));
    assert.deepEqual(f.markerChecks, ["freshen", "wave", "fix", "confirm", "hand-test", "verifier"]);
    assert.deepEqual(
      f.readers["confirm-1"]?.map((r) => r.reader),
      ["review-cursory-codex"],
      "R1, 1 counted line, no await: the hunter sits out"
    );

    run.ledger(lines.map((l) => (l.startsWith("confirm-1:") ? `confirm-1: review-cursory-codex | sha=${s1}` : l)));
    const missing = await facts(run);
    assert.deepEqual(missing.failures, [
      "confirm-1: names review-cursory-codex — no stage-confirm-1/review-cursory-codex.md",
    ]);

    run.ledger(lines.filter((l) => !l.startsWith("confirm-1:")));
    assert.ok((await facts(run)).failures.includes("missing line: confirm-1:"));
  });
});

test("CURSORY.1: a stage file that arrives after its round was built makes that round and every later one stale", async () => {
  await withRun(async (run) => {
    const s1 = oneRowRun(run);
    run.ledger(oneRowLines(run, s1));
    assert.deepEqual((await facts(run)).failures, []);
    run.write("stage-confirm-1/security-review.md", stageFile([], [blk("SEC.101", "security", "src/auth.ts:1")]));
    const f = await facts(run);
    assert.ok(
      f.failures.includes("table.json round 2 is stale against the run dir (rows, consumed differ) — a file changed or arrived after it was built"),
      f.failures.join("\n")
    );
    const heads = ["2", "3", "escalate", "final"].map((r) => `\`${rebuildCommand(run.runDir, r as RoundId, s1)}\``);
    assert.ok(
      f.failures.includes(`re-build rounds 2, 3, escalate, final in order, each at the head table.json holds for it: ${heads.join("; ")}`),
      f.failures.join("\n")
    );
    run.build(["2"], s1);
    const again = (await facts(run)).failures;
    assert.ok(!again.some((l) => l.startsWith("table.json round 2 is stale")), again.join("\n"));
    assert.ok(again.some((l) => l.startsWith("table.json round 3 cannot be re-built from the run dir (fix-2.txt is missing")), again.join("\n"));
  });
});

test("CURSORY.1: a hand test written after final makes only final stale", async () => {
  await withRun(async (run) => {
    noFindingsRun(run);
    run.handTest(2, `H1 · pass · ${run.wave} — hand-test-2/H1.out\n`);
    run.ledger([...briefedHead("R1", run.wave), `verifier: CLEAN | sha=${run.wave}`, `hand-test-1: 1/1 | sha=${run.wave}`, `hand-test-2: 1/1 | sha=${run.wave}`, `ship: x | sha=${run.wave}`]);
    assert.deepEqual((await facts(run)).failures, [
      "table.json round final is stale against the run dir (consumed differ) — a file changed or arrived after it was built",
      `re-build rounds final in order, each at the head table.json holds for it: \`${rebuildCommand(run.runDir, "final", run.wave)}\``,
    ]);
  });
});

test("a session.md block for a later stage (CLOSE 4e) never makes an earlier round stale; one for the round's own stage does", async () => {
  await withRun(async (run) => {
    const s1 = oneRowRun(run);
    run.ledger(oneRowLines(run, s1));
    assert.deepEqual((await facts(run)).failures, []);
    // Every round was built before session.md existed. A 4e block at stage `last` feeds `escalate`
    // only: rounds 1, 2, and 3 take none of it, so they stay as built; `escalate` really is stale.
    run.write("session.md", blk("SESSION.1", "behavior").replace("- kind: behavior", "- kind: behavior\n- stage: last"));
    const later = (await facts(run)).failures.filter((l) => l.includes("stale") || l.startsWith("re-build"));
    assert.deepEqual(later, [
      "table.json round escalate is stale against the run dir (rows, consumed differ) — a file changed or arrived after it was built",
      `re-build rounds escalate, final in order, each at the head table.json holds for it: ${["escalate", "final"].map((r) => `\`${rebuildCommand(run.runDir, r as RoundId, s1)}\``).join("; ")}`,
    ]);
    // The same block at the wave's stage is round 1's: round 1 is stale.
    run.write("session.md", blk("SESSION.1", "behavior").replace("- kind: behavior", "- kind: behavior\n- stage: wave"));
    const own = (await facts(run)).failures;
    assert.ok(own.includes("table.json round 1 is stale against the run dir (rows, consumed differ) — a file changed or arrived after it was built"), own.join("\n"));
  });
});

test("fix4: an `amend brief:` is never a change to the PR's code, even when the target list names the brief", async () => {
  await withRun(
    async (run) => {
      noFindingsRun(run);
      const amend = run.commit({ [BRIEF_PATH]: `${briefText().replace("- src/app.ts", `- src/app.ts\n- ${BRIEF_PATH}`)}\n` }, "amend brief: reword H1");
      run.ledger([...briefedHead("R1", run.wave), `verifier: CLEAN | sha=${run.wave}`, `hand-test-1: 1/1 | sha=${run.wave}`, `ship: x | sha=${amend}`]);
      const f = await facts(run);
      assert.deepEqual(f.failures, [], "the claim stays fresh and final is not behind: the brief is no code");
      assert.ok(f.targets.includes(BRIEF_PATH), "the brief is still listed; only the runtime ignores it");
    },
    { brief: briefText().replace("- src/app.ts", `- src/app.ts\n- ${BRIEF_PATH}`) }
  );
});

test("CODEX.1: a reader the wave line names with no file fails", async () => {
  await withRun(async (run) => {
    noFindingsRun(run);
    const lines = readFileSync(join(run.runDir, "ship.md"), "utf8").trimEnd().split("\n");
    run.ledger(lines.map((l) => (l.startsWith("wave:") ? l.replace("build-verifier", "build-verifier, gate-silent-failure-hunter") : l)));
    assert.deepEqual((await facts(run)).failures, [
      "wave: names gate-silent-failure-hunter — no gate-silent-failure-hunter.md in the run dir; re-spawn it, or record why it left none",
    ]);
  });
});

test("CURSORY.7: a repo reader's file the wave line does not name, and a misnamed file, fail", async () => {
  await withRun(async (run) => {
    noFindingsRun(run);
    run.write("comment-reader.md", "NO FINDINGS\n");
    run.write("security_review.md", "NO FINDINGS\n");
    assert.deepEqual((await facts(run)).failures, [
      "comment-reader.md: in the run dir, but it is no reader's file — name its repo reader on `wave: … | repo: <agent>`, or rename it",
      "security_review.md: in the run dir, but it is no reader's file — name its repo reader on `wave: … | repo: <agent>`, or rename it",
    ]);
  });
});

test("CODEX.2: a fixer's decision row banked in table.json fails with no `banked:` line", async () => {
  await withRun(async (run) => {
    const s1 = oneRowRun(run, { fixLine: () => "CURSORY.1 · decision — product — which answer does the app give?", status: [] });
    run.ledger(oneRowLines(run, s1).map((l) => (l.startsWith("fix-1:") ? l.replace("1/1", "0/1") : l)));
    const f = await facts(run);
    assert.ok(
      f.failures.includes("table.json round 2 banked CURSORY.1 — a fixer's decision row does not ship; answer the question first"),
      f.failures.join("\n")
    );
    assert.equal(f.failures.filter((l) => / banked CURSORY\.1 /.test(l)).length, 1, "`final` gathers the row; the gate names it once");
  });
});

test("answered: a decision row the session answered itself clears its table row once its SESSION block entered a round", async () => {
  await withRun(async (run) => {
    // The session's answer, a SESSION block at the next read's stage; a `text` kind so round 2 leaves it.
    run.write("session.md", blk("SESSION.1", "text", "README.md:1").replace("- kind: text", "- kind: text\n- stage: confirm-1"));
    const s1 = oneRowRun(run, { fixLine: () => "CURSORY.1 · decision — design-entry — which name does the export take?", status: [] });
    const lines = [
      ...oneRowLines(run, s1).map((l) => (l.startsWith("fix-1:") ? l.replace("1/1", "0/1") : l)),
      "leftovers: pr-body | rows=1 | scope=plan-QRK-5",
    ];
    run.ledger([...lines, "answered: CURSORY.1 | by=SESSION.1"]);
    assert.deepEqual((await facts(run)).failures, []);
    // A `leftovers:` line written before `scope=` existed: the gate still reads the ledger and passes it.
    run.ledger([...lines.map((l) => (l.startsWith("leftovers:") ? "leftovers: pr-body | rows=1" : l)), "answered: CURSORY.1 | by=SESSION.1"]);
    assert.deepEqual((await facts(run)).failures, []);

    run.ledger([...lines, "answered: CURSORY.1 | by=SESSION.9", "answered: CURSORY.2 | by=SESSION.1"]);
    const f = await facts(run);
    assert.ok(f.failures.includes("answered: CURSORY.1 | by=SESSION.9 — no round of table.json holds SESSION.9; write the answer as a SESSION block at the next read's stage and build that round"), f.failures.join("\n"));
    assert.ok(f.failures.includes("answered: CURSORY.2 — no round banked it; name a row a fixer's `decision` line holds"), f.failures.join("\n"));
    assert.ok(f.failures.some((l) => / banked CURSORY\.1 /.test(l)), "an answer no round took leaves the decision banked");
  });
});

test("unbank: a decision row the operator answered clears its table row and its `banked:` id; the plan owes one cursory read over from..sha", async () => {
  await withRun(async (run) => {
    const s1 = oneRowRun(run, { fixLine: () => "CURSORY.1 · decision — product — which answer does the app give?", status: [] });
    const fix = run.commit({ "src/app.ts": "export const a = 7;\n" }, "fix(unbank): CURSORY.1");
    run.write("unbank/review-cursory.md", "NO FINDINGS — the answer is carried out\n");
    const lines = [
      ...oneRowLines(run, s1).map((l) => (l.startsWith("fix-1:") ? l.replace("1/1", "0/1") : l.startsWith("ship:") ? `ship: x | sha=${fix}` : l)),
      "banked: CURSORY.1 (awaiting operator)",
      `unbank: CURSORY.1 | from=${s1} | sha=${fix}`,
      `unbank-read: review-cursory | sha=${fix}`,
    ];
    run.ledger(lines);
    const f = await facts(run);
    assert.deepEqual(f.failures, []);
    assert.deepEqual(f.readers.unbank?.map((r) => r.reader), ["review-cursory"]);
    const plan = planStage(await context(run, lines), "unbank");
    assert.deepEqual([plan.owed, plan.range, plan.move], [true, { from: s1, to: fix }, "unbank-read"]);
  });
});

test("CODEX.3 / CURSORY.5: a read at another head than its range's end fails", async () => {
  await withRun(async (run) => {
    const s1 = oneRowRun(run);
    run.ledger(oneRowLines(run, s1).map((l) => (l.startsWith("confirm-1:") ? l.replace(`sha=${s1}`, `sha=${run.wave}`) : l)));
    assert.deepEqual((await facts(run)).failures, [
      `confirm-1: sha=${run.wave} — the read covers ${run.wave.slice(0, 9)}..${s1}, so it names ${s1}; a read at another head read other code — run it again over that range`,
    ]);
  });
});

test("CURSORY.5 / dry-run 2: a session commit before a round with no rows owes that round's read over it", async () => {
  await withRun(async (run) => {
    let s2 = "";
    const s1 = oneRowRun(run, {
      head: () => (s2 = run.commit({ "src/app.ts": "export const a = 30;\n" }, "fix a red check")),
    });
    const lines = oneRowLines(run, s1).map((l) => (l.startsWith("ship:") ? `ship: x | sha=${s2}` : l));
    run.ledger(lines);
    const f = await facts(run);
    assert.ok(f.failures.includes("missing line: confirm-2:"), f.failures.join("\n"));
    assert.ok(!f.failures.some((l) => l.includes("with no read")), "the owed read, not a dead end, is the route");
    assert.deepEqual(f.readers["confirm-2"]?.map((r) => r.reader), ["review-cursory-codex"]);

    const plan = planStage(await context(run, lines), "confirm-2");
    assert.equal(plan.owed, true);
    assert.deepEqual(plan.range, { from: s1, to: s2 });
    assert.equal(plan.why, `no fixer ran, and the PR's code changed after fix-1's sha ${s1.slice(0, 9)} (src/app.ts) — the read covers the session's commit`);

    // The session runs that read before round 3's table, and the claim again on the new head.
    run.write("stage-confirm-2/review-cursory.md", stageFile([]));
    run.handTest(2, `H1 · pass · ${s2} — hand-test-2/H1.out\n`);
    run.build(["3", "escalate", "final"], s2);
    run.ledger([
      ...lines.filter((l) => !l.startsWith("ship:")),
      `confirm-2: review-cursory (codex failed: exit 1) | sha=${s2}`,
      `hand-test-2: 1/1 | sha=${s2}`,
      `ship: x | sha=${s2}`,
    ]);
    assert.deepEqual((await facts(run)).failures, []);
  });
});

/** Dry run B2b's shape: fix-1 at `s1`; the session's `amend brief:` at `sa`, which round 2's table
 *  saw; round 2's one row fixed at `s2`; confirm-2 read by a Codex stand-in and the verifier. */
function sessionAmendRun(run: Run): { s1: string; sa: string; s2: string } {
  waveFiles(run, [blk("CURSORY.1", "behavior")]);
  run.build(["1"], run.wave);
  const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix(close): round 1 — 1 rows");
  run.write("fix-1.txt", `CURSORY.1 · fixed · ${s1} — a is 3\n${EXIT_CHECKS}\n`);
  run.write("stage-confirm-1/review-cursory.md", stageFile(["- CURSORY.1 · resolved"], [blk("CURSORY.101", "behavior")]));
  run.handTest(1, `H1 · pass · ${s1} — hand-test-1/H1.out\n`);
  const sa = run.commit({ "src/app.ts": "export const a = 30;\n", [BRIEF_PATH]: briefText().replace("1. app answers", "1. app answers 30") }, "amend brief: a is 30");
  run.build(["2"], sa);
  const s2 = run.commit({ "src/app.ts": "export const a = 31;\n" }, "fix(close): round 2 — 1 rows");
  run.write("fix-2.txt", `CURSORY.101 · fixed · ${s2} — a is 31\n${EXIT_CHECKS}\n`);
  run.write("stage-confirm-2/review-cursory.md", stageFile(["- CURSORY.101 · resolved"]));
  run.write("stage-confirm-2/build-verifier.md", `${stageFile([])}VERDICT: CLEAN\n`);
  run.handTest(2, `H1 · pass · ${s2} — hand-test-2/H1.out\n`);
  run.build(["3", "escalate", "final"], s2);
  return { s1, sa, s2 };
}

function sessionAmendLines(run: Run, s: { s1: string; sa: string; s2: string }, fix2From: string): string[] {
  return [
    ...briefedHead("R1", run.wave),
    `verifier: CLEAN | sha=${s.s2}`,
    `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s.s1}`,
    `confirm-1: review-cursory (codex failed: exit 1) | sha=${s.s1}`,
    `hand-test-1: 1/1 | sha=${s.s1}`,
    `fix-2: 1/1 | model=sonnet | agent=f2 | from=${fix2From} | sha=${s.s2}`,
    `confirm-2: review-cursory (codex failed: exit 1), build-verifier | sha=${s.s2}`,
    `hand-test-2: 1/1 | sha=${s.s2}`,
    `ship: x | sha=${s.s2}`,
  ];
}

test("dry-run 2 + 3: a session amend before a fix round joins its confirm by from=, and owes the verifier there", async () => {
  await withRun(async (run) => {
    const s = sessionAmendRun(run);
    run.ledger(sessionAmendLines(run, s, s.s1));
    const f = await facts(run);
    assert.deepEqual(f.failures, []);
    assert.deepEqual(
      f.readers["confirm-2"]?.map((r) => [r.reader, r.why]),
      [
        ["review-cursory-codex", "every read after a fix"],
        ["build-verifier", "an `amend brief:` commit in the range changes the deliverables or assertions"],
      ]
    );

    // The confirm that leaves the verifier out fails.
    run.ledger(sessionAmendLines(run, s, s.s1).map((l) => (l.startsWith("confirm-2:") ? l.replace(", build-verifier", "") : l)));
    assert.ok(
      (await facts(run)).failures.includes(
        "confirm-2: names no build-verifier — owed (an `amend brief:` commit in the range changes the deliverables or assertions)"
      )
    );

    // The old ledger, from= the head after the amend: the amend is read by nobody.
    run.ledger(sessionAmendLines(run, s, s.sa));
    assert.deepEqual((await facts(run)).failures, [
      `table.json round 2 was built at ${s.sa}, and the PR's code changed after fix-1's sha ${s.s1} with no read (src/app.ts) — a session commit between rounds joins the next read: write \`fix-2: … | from=${s.s1}\` so confirm-2 reads it with the fixer's commits; or revert it`,
    ]);
  });
});

test("a fix line's from= may be the round's head or the prior read's end, nothing else; a fixed line must be the fixer's", async () => {
  await withRun(async (run) => {
    const s = sessionAmendRun(run);
    run.ledger(sessionAmendLines(run, s, run.wave));
    const f = await facts(run);
    assert.ok(
      f.failures.includes(
        `fix-2: from=${run.wave} — round 2 was built at ${s.sa}; from= is the round's head, or fix-1's sha ${s.s1} when the session committed after it`
      ),
      f.failures.join("\n")
    );
    run.write("fix-2.txt", `CURSORY.101 · fixed · ${s.sa} — the amend did it\n${EXIT_CHECKS}\n`);
    run.build(["3", "escalate", "final"], s.s2);
    run.ledger(sessionAmendLines(run, s, s.s1));
    assert.ok(
      (await facts(run)).failures.includes(
        `fix-2: CURSORY.101 · fixed · ${s.sa} — not a commit in this round's range ${s.sa}..${s.s2}; a row the round did not change is \`dropped\`, which owes the read`
      )
    );
  });
});

test("the verifier line is held to the verifier's last read, not its first", async () => {
  await withRun(async (run) => {
    const s = sessionAmendRun(run);
    run.write("stage-confirm-2/build-verifier.md", `${stageFile([])}VERDICT: INCOMPLETE — the manifest exits 1\n`);
    run.build(["3", "escalate", "final"], s.s2);
    run.ledger(sessionAmendLines(run, s, s.s1));
    assert.deepEqual((await facts(run)).failures, [
      "verifier: CLEAN — stage-confirm-2/build-verifier.md ends VERDICT: INCOMPLETE — the manifest exits 1; clear it by a hand-test claim (`CLEARED | by=hand-test-<n>:H<k>`) or re-run the check",
    ]);
  });
});

test("CURSORY.3: a `fixed` line whose sha is not a commit in the round's range fails", async () => {
  await withRun(async (run) => {
    const s1 = oneRowRun(run, { fixLine: () => `CURSORY.1 · fixed · ${run.wave} — already so` });
    run.ledger(oneRowLines(run, s1));
    assert.deepEqual((await facts(run)).failures, [
      `fix-1: CURSORY.1 · fixed · ${run.wave} — not a commit in this round's range ${run.wave}..${s1}; a row the round did not change is \`dropped\`, which owes the read`,
    ]);
  });
});

test("CODEX.4: a ledger class below the brief's pinned class fails", async () => {
  await withRun(
    async (run) => {
      noFindingsRun(run, "R0");
      const f = await facts(run);
      assert.ok(
        f.failures.includes(`class: R0 — the brief ${BRIEF_PATH} pins R2; the ledger's class line repeats the pinned class`),
        f.failures.join("\n")
      );
    },
    { brief: briefText({ cls: "R2" }) }
  );
});

test("CODEX.5 / CURSORY.9: a hand-test line whose output file is missing fails", async () => {
  await withRun(async (run) => {
    noFindingsRun(run);
    rmSync(join(run.runDir, "hand-test-1", "H1.out"));
    assert.deepEqual((await facts(run)).failures, [
      "hand-test-1.txt: H1's output hand-test-1/H1.out is not in the run dir — the hand tester writes the real output there",
    ]);
  });
});

test("confirm-2 is owed on a drop with no code change, and not owed with neither", async () => {
  await withRun(async (run) => {
    const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
    const head = [...briefedHead("R1", run.wave), `fix-2: 0/1 | model=sonnet | agent=f2 | from=${s1} | sha=${s1}`];
    run.write("fix-2.txt", `CURSORY.2 · dropped — the claim is false at src/app.ts:1\n${EXIT_CHECKS}\n`);
    let plan = planStage(await context(run, head), "confirm-2");
    assert.equal(plan.owed, true);
    assert.equal(plan.why, "1 row(s) dropped or re-labelled");
    assert.deepEqual(plan.readers.filter((r) => r.verdict === "owed").map((r) => r.reader), ["review-cursory-codex"]);

    run.write("fix-2.txt", `CURSORY.2 · fixed · ${s1} — already so\n${EXIT_CHECKS}\n`);
    plan = planStage(await context(run, head), "confirm-2");
    assert.equal(plan.owed, false);
    assert.equal(plan.why, "fix-2 changed no file and dropped no row");
  });
});

test("last-read is not owed when fix-3 changed only a test, and is owed when it changed app code", async () => {
  await withRun(async (run) => {
    const t = run.commit({ "test/app.test.ts": "// test\nawait run();\n" }, "fix 3: a test");
    run.write("fix-3.txt", `CURSORY.3 · fixed · ${t} — pinned by a test\n${EXIT_CHECKS}\n`);
    const testOnly = [...briefedHead("R1", run.wave), `fix-3: 1/1 | model=sonnet | agent=f3 | from=${run.wave} | sha=${t}`];
    let plan = planStage(await context(run, testOnly), "last");
    assert.equal(plan.owed, false);
    assert.equal(plan.why, "fix-3 changed none of the PR's code and dropped no row");

    const code = run.commit({ "src/app.ts": "export const a = 4;\n" }, "fix 3: code");
    const withCode = [...briefedHead("R1", run.wave), `fix-3: 1/1 | model=sonnet | agent=f3 | from=${run.wave} | sha=${code}`];
    plan = planStage(await context(run, withCode), "last");
    assert.equal(plan.owed, true);
    assert.deepEqual(plan.prCode?.paths, ["src/app.ts"]);
  });
});

test("the hunter sits out under 20 lines, is owed on an await, and R0 never owes it", async () => {
  await withRun(async (run) => {
    const small = run.commit({ "src/app.ts": "export const a = 5;\n" }, "fix 1: small");
    const at = (cls: string, sha: string, from = run.wave) => [
      ...briefedHead(cls, run.wave),
      `fix-1: 1/1 | model=sonnet | agent=f1 | from=${from} | sha=${sha}`,
    ];
    const hunter = async (cls: string, sha: string, from?: string) =>
      planStage(await context(run, at(cls, sha, from)), "confirm-1").readers.find(
        (r) => r.reader === "gate-silent-failure-hunter"
      );
    assert.deepEqual(await hunter("R1", small), {
      reader: "gate-silent-failure-hunter",
      verdict: "sits out",
      why: "2 counted lines < 20, no catch/await/Promise",
    });
    const awaited = run.commit({ "src/app.ts": "export const a = await load();\n" }, "fix 1: await");
    assert.deepEqual(await hunter("R1", awaited, small), {
      reader: "gate-silent-failure-hunter",
      verdict: "owed",
      why: "a changed line holds `await`",
    });
    assert.deepEqual(await hunter("R0", awaited, small), {
      reader: "gate-silent-failure-hunter",
      verdict: "not owed",
      why: "R0's reader set has no hunter",
    });
    const big = run.commit(
      { "src/app.ts": Array.from({ length: 25 },(_, i) => `export const a${i} = ${i};`).join("\n") + "\n" },
      "fix 1: big"
    );
    assert.equal((await hunter("R1", big, awaited))?.verdict, "owed", "≥ 20 counted lines");
  });
});

test("at R2 with the fix trigger firing, security-review is owed at confirm-1 and confirm-2 only", async () => {
  await withRun(
    async (run) => {
      const shas = [2, 3, 4, 5].map((n) => run.commit({ "src/auth.ts": `export const token = ${n};\n` }, `fix ${n}: auth`));
      const [s1, s2, s3, s4] = shas as [string, string, string, string];
      for (const [file, sha] of [["fix-1.txt", s1], ["fix-2.txt", s2], ["fix-3.txt", s3], ["fix-escalate.txt", s4]] as const) {
        run.write(file, `CURSORY.1 · fixed · ${sha} — token moves\n${EXIT_CHECKS}\n`);
      }
      const lines = [
        ...briefedHead("R2", run.wave),
        `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`,
        `fix-2: 1/1 | model=sonnet | agent=f2 | from=${s1} | sha=${s2}`,
        `fix-3: 1/1 | model=sonnet | agent=f3 | from=${s2} | sha=${s3}`,
        `escalate: 1/1 | model=opus | agent=e1 | from=${s3} | sha=${s4}`,
      ];
      const ctx = await context(run, lines);
      const security = (stage: "confirm-1" | "confirm-2" | "last" | "escalate") => {
        const plan = planStage(ctx, stage);
        assert.equal(plan.owed, true, `${stage} is owed`);
        return [plan.readers.find((r) => r.reader === "security-review")?.verdict, plan.fixSecurity?.fires ?? null];
      };
      assert.deepEqual(security("confirm-1"), ["owed", true]);
      assert.deepEqual(security("confirm-2"), ["owed", true]);
      assert.deepEqual(security("last"), ["not owed", null]);
      assert.deepEqual(security("escalate"), ["not owed", null]);

      run.write("stage-last/review-cursory-codex.md", stageFile([]));
      run.write("stage-last/security-review.md", stageFile([]));
      run.ledger([...lines, `last-read: review-cursory-codex, security-review | sha=${s3}`]);
      const f = await facts(run);
      assert.ok(f.failures.includes("last-read: names security-review — it reads a fix at confirm-1 and confirm-2 only"), f.failures.join("\n"));
    },
    { brief: briefText({ cls: "R2" }) }
  );
});

test("security is owed at R2 on a fire, not at R2 when quiet, and not asked at R1", async () => {
  await withRun(async (run) => {
    const auth = run.commit({ "src/auth.ts": "export const token = 2;\n" }, "fix 1: auth");
    const at = (cls: string) => [...briefedHead(cls, run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${auth}`];
    let plan = planStage(await context(run, at("R2")), "confirm-1");
    assert.deepEqual(plan.fixSecurity?.reasons, ["path src/auth.ts"]);
    assert.deepEqual(plan.readers.find((r) => r.reader === "security-review"), {
      reader: "security-review",
      verdict: "owed",
      why: "R2; fix-security fires",
    });
    plan = planStage(await context(run, at("R1")), "confirm-1");
    assert.equal(plan.fixSecurity, null);
    assert.equal(plan.readers.find((r) => r.reader === "security-review")?.verdict, "not owed");

    const quiet = run.commit({ "src/app.ts": "export const a = 9;\n" }, "fix 1: app");
    const r2Quiet = [...briefedHead("R2", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${auth} | sha=${quiet}`];
    plan = planStage(await context(run, r2Quiet), "confirm-1");
    assert.equal(plan.readers.find((r) => r.reader === "security-review")?.why, "R2; fix-security quiet");
  });
});

test("the verifier is owed at confirm-1 on an amend brief: commit or a rename", async () => {
  await withRun(async (run) => {
    const amend = run.commit({ [BRIEF_PATH]: briefText().replace("1. app answers", "1. app answers in src/app.ts") }, "amend brief: name the file");
    const at = [...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${amend}`];
    const v = planStage(await context(run, at), "confirm-1").readers.find((r) => r.reader === "build-verifier");
    assert.deepEqual(v, { reader: "build-verifier", verdict: "owed", why: "an `amend brief:` commit changes the deliverables or assertions" });
    run.git("mv", "src/auth.ts", "src/auth2.ts");
    run.git("commit", "-q", "-m", "rename");
    const renamed = run.head();
    const at2 = [...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${amend} | sha=${renamed}`];
    const v2 = planStage(await context(run, at2), "confirm-1").readers.find((r) => r.reader === "build-verifier");
    assert.equal(v2?.why, "a renamed path");
    const at3 = [...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${run.wave}`];
    const v3 = planStage(await context(run, at3), "confirm-1").readers.find((r) => r.reader === "build-verifier");
    assert.equal(v3?.verdict, "not owed");
    assert.equal(v3?.instead, "run <manifest> --brief-file <brief> --no-exercise yourself", "TEXT-CURSORY.10");
  });
});

const MANIFEST = [
  "```yaml",
  "description: app answers",
  "tests_assert:",
  "  - test/app.test.ts",
  "files_absent:",
  "  - src/old.ts",
  "touch_only:",
  "  - src/app.ts",
  "deliverables:",
  "  - name: app answers",
  "    covered_by: [judgment]",
  "```",
  "",
].join("\n");

test("an `amend brief:` of a non-graded yaml key owes no verifier; a files_absent or deliverables: entry does", async () => {
  const brief = `${briefText()}\n${MANIFEST}`;
  await withRun(
    async (run) => {
      const verifierOver = async (from: string, to: string) => {
        const lines = [...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${from} | sha=${to}`];
        return planStage(await context(run, lines), "confirm-1").readers.find((r) => r.reader === "build-verifier");
      };
      const other = brief
        .replace("description: app answers", "description: app answers, reworded")
        .replace("touch_only:\n  - src/app.ts", "touch_only:\n  - src/app.ts\n  - src/auth.ts")
        .replace("files_absent:", "\n# gone after the fix\nfiles_absent:");
      const desc = run.commit({ [BRIEF_PATH]: other }, "amend brief: reword the description");
      assert.deepEqual(await verifierOver(run.wave, desc), {
        reader: "build-verifier",
        verdict: "not owed",
        why: "the `amend brief:` commit changes no deliverable or assertion, no rename",
        instead: "run <manifest> --brief-file <brief> --no-exercise yourself",
      });

      const absent = run.commit({ [BRIEF_PATH]: other.replace("src/old.ts", "src/older.ts") }, "amend brief: the old file is older.ts");
      assert.equal((await verifierOver(desc, absent))?.verdict, "owed", "a files_absent entry");

      const entry = run.commit(
        { [BRIEF_PATH]: other.replace("src/old.ts", "src/older.ts").replace("    covered_by: [judgment]", "    covered_by: [files_absent]") },
        "amend brief: the deliverable is bound by files_absent"
      );
      assert.equal((await verifierOver(absent, entry))?.verdict, "owed", "a deliverables: entry");
    },
    { brief }
  );
});

test("an `amend brief:` owes the verifier only when it changes a deliverable or an assertion", async () => {
  const brief = `${briefText()}\n${MANIFEST}`;
  await withRun(
    async (run) => {
      const verifierOver = async (from: string, to: string, stage: "confirm-1" | "last" = "confirm-1") => {
        const move = stage === "confirm-1" ? "fix-1" : "fix-3";
        run.write("fix-3.txt", `CURSORY.3 · fixed · ${to} — done\n${EXIT_CHECKS}\n`);
        const lines = [...briefedHead("R1", run.wave), `${move}: 1/1 | model=sonnet | agent=f1 | from=${from} | sha=${to}`];
        return planStage(await context(run, lines), stage).readers.find((r) => r.reader === "build-verifier");
      };
      const hand = run.commit(
        { [BRIEF_PATH]: brief.replace("pass: exit 0", "pass: exit 0 and prints ok").replace("- src/app.ts", "- src/app.ts\n- src/auth.ts") },
        "amend brief: H1 says what it prints; auth.ts is a target"
      );
      assert.deepEqual(await verifierOver(run.wave, hand), {
        reader: "build-verifier",
        verdict: "not owed",
        why: "the `amend brief:` commit changes no deliverable or assertion, no rename",
        instead: "run <manifest> --brief-file <brief> --no-exercise yourself",
      });
      const code = run.commit({ "src/app.ts": "export const a = 5;\n" }, "fix: a is 5");
      assert.deepEqual(await verifierOver(run.wave, code, "last"), {
        reader: "build-verifier",
        verdict: "not owed",
        why: "the `amend brief:` commit in the range changes no deliverable or assertion",
        instead: "run <manifest> --brief-file <brief> --no-exercise yourself",
      });

      const tests = run.commit({ [BRIEF_PATH]: brief.replace("test/app.test.ts", "test/app2.test.ts") }, "amend brief: the test moved");
      assert.equal((await verifierOver(code, tests))?.verdict, "owed", "a tests_assert path");
      assert.equal((await verifierOver(run.wave, tests, "last"))?.why, "an `amend brief:` commit in the range changes the deliverables or assertions");

      const entry = run.commit({ [BRIEF_PATH]: brief.replace("test/app.test.ts", "test/app2.test.ts").replace("name: app answers", "name: app answers twice") }, "amend brief: the deliverable says twice");
      assert.equal((await verifierOver(tests, entry))?.verdict, "owed", "a deliverables: entry");
    },
    { brief }
  );
});

test("a claim count that falls without an operator amend fails; with one it passes", async () => {
  await withRun(
    async (run) => {
      run.commit({ [BRIEF_PATH]: briefText() }, "amend brief: drop H2");
      const ctx = await context(run, briefedHead("R1", run.wave));
      assert.deepEqual(ctx.briefFailures, [
        `brief: ${BRIEF_PATH} held 2 hand-test claims at its first commit and 1 at HEAD — a claim may leave only by an \`amend brief: operator change:\` commit`,
      ]);
      run.commit({ [BRIEF_PATH]: `${briefText()}\n` }, "amend brief: operator change: H2 is out of scope");
      assert.deepEqual((await context(run, briefedHead("R1", run.wave))).briefFailures, []);
    },
    { brief: briefText({ claims: TWO_CLAIMS }) }
  );
});

test("order: a brief in the code repo passes as the branch's first commit and fails as its second; an empty range proves nothing", async () => {
  await withRun(async (run) => {
    assert.deepEqual((await context(run, briefedHead("R1", run.wave))).briefFailures, []);
  });
  await withRun(
    async (run) => {
      const late = run.commit({ [BRIEF_PATH]: briefText() }, "brief: quick-x, after the code");
      const ctx = await context(run, briefedHead("R1", run.wave));
      assert.deepEqual(ctx.briefFailures, [
        `brief: ${BRIEF_PATH} was first committed at ${late}, not as the branch's first commit ${run.wave}, so it post-dates the work it grades`,
      ]);
      run.ledger(briefedHead("R1", run.wave));
      const lines = briefedHead("R1", run.wave);
      const empty = await runContext(parseLedger(`${lines.join("\n")}\n`), run.runDir, run.repo, run.head(), DEPS);
      assert.deepEqual(empty.briefFailures, [], "base..HEAD is empty: no order failure");
    },
    { brief: null }
  );
});

test("order: a stacked unit read against main after its parent's squash is held to its own first commit", async () => {
  for (const late of [false, true]) {
    await withRun(
      async (run) => {
        // quick/x is the parent unit (one commit). quick/y is cut from its head; the parent is then
        // squashed onto main and main merged in, so main..HEAD still holds the parent's own commit.
        const parentHead = run.head();
        run.git("checkout", "-q", "-b", "quick/y");
        const code = () => run.commit({ "src/other.ts": "export const o = 1;\n" }, "build: other");
        const firstCode = late ? code() : null;
        const briefAt = run.commit({ [BRIEF_PATH]: briefText() }, "brief: quick-y");
        if (!late) code();
        run.git("checkout", "-q", "main");
        run.commit({ "src/app.ts": "export const a = 2;\n" }, "build: a is 2 (#1)");
        run.git("checkout", "-q", "quick/y");
        run.git("merge", "-q", "--no-edit", "main");
        const head = run.head();
        const lines = briefedHead("R1", head).map((l) => (l.startsWith("freshen:") ? `freshen: merged | base=${parentHead} | sha=${head}` : l));
        const ctx = await context(run, lines);
        assert.deepEqual(
          ctx.briefFailures,
          late ? [`brief: ${BRIEF_PATH} was first committed at ${briefAt}, not as the branch's first commit ${firstCode}, so it post-dates the work it grades`] : []
        );
      },
      { brief: null }
    );
  }
});

// ── A brief in the store (a public repo) ─────────────────────────────────────────────────────

test("store: the brief is read from the store (class, claims, targets), and its order holds by the branch's record", async () => {
  await withRun(
    async (run) => {
      const ctx = await context(run, briefedHead("R1", run.wave, "sonnet", STORE_BRIEF));
      assert.deepEqual(ctx.briefFailures, []);
      assert.equal(ctx.brief.store, true);
      assert.equal(ctx.brief.path, STORE_BRIEF_PATH);
      assert.equal(ctx.brief.cls, "R1");
      assert.deepEqual(ctx.brief.claims.map((c) => c.id), ["H1", "H2"]);
      assert.deepEqual(ctx.brief.targets, ["src/app.ts"]);
      assert.equal(ctx.brief.firstCommit, run.store!.git("log", "-1", "--format=%H", "--", `o/r/${STORE_BRIEF_PATH}`));
    },
    { store: "before", brief: briefText({ claims: TWO_CLAIMS }) }
  );
  await withRun(
    async (run) => {
      const ctx = await context(run, briefedHead("R1", run.wave, "sonnet", STORE_BRIEF));
      assert.deepEqual(ctx.briefFailures, [
        `brief: ${STORE_BRIEF} is not recorded by the branch's first commit ${run.wave} — that commit is an empty one whose subject is \`brief: ${STORE_BRIEF} @ <store commit>\` (BRIEF step 6), so nothing proves it came before the work it grades`,
      ]);
    },
    { store: "after" }
  );
});

test("store: the record picks this run's brief out of a reused path, and binds it to a store commit of the brief", async () => {
  await withRun(
    async (run) => {
      const store = run.store!;
      const oldest = store.git("log", "-1", "--format=%H", "--", `o/r/${STORE_BRIEF_PATH}`);
      const failuresOn = async (branch: string, record: string | null) => {
        run.git("checkout", "-q", "main");
        run.git("checkout", "-q", "-b", branch);
        if (record !== null) run.commit({}, `brief: ${STORE_BRIEF} @ ${record}`);
        const first = run.commit({ "src/app.ts": `export const a = "${branch}";\n` }, `build: ${branch}`);
        const ctx = await context(run, briefedHead("R1", first, "sonnet", STORE_BRIEF));
        return { ctx, first: record === null ? first : run.git("rev-parse", "HEAD~1") };
      };
      const said = (first: string, at: string, why: string) => [
        `brief: ${STORE_BRIEF} is recorded at ${at} by the branch's first commit ${first}, ${why}, so nothing proves it came before the work it grades`,
      ];

      // A later run reuses the slug: its brief overwrites the old one, and its record names that commit.
      const again = store.commit({ [STORE_BRIEF_PATH]: briefText({ claims: TWO_CLAIMS }) }, "brief: o/r quick-x, a second run");
      const reused = await failuresOn("quick/again", again);
      assert.deepEqual(reused.ctx.briefFailures, []);
      assert.equal(reused.ctx.brief.firstCommit, again, "this run's first version, not the path's oldest commit");
      assert.notEqual(again, oldest);

      // The record names a store commit that does not change the brief, or no store commit at all.
      const steps = store.git("rev-list", "--max-parents=0", "HEAD");
      const wrong = await failuresOn("quick/wrong", steps);
      assert.deepEqual(wrong.ctx.briefFailures, said(wrong.first, steps, "a store commit that does not change it"));
      const none = "0".repeat(40);
      const absent = await failuresOn("quick/absent", none);
      assert.deepEqual(absent.ctx.briefFailures, said(absent.first, none, "and the store holds no such commit"));

      // The brief is committed again after the record, with no `amend brief:` subject: it was
      // written after the work began, whatever the record says.
      const late = store.commit({ [STORE_BRIEF_PATH]: `${briefText({ claims: TWO_CLAIMS })}\n` }, "brief: o/r quick-x, rewritten");
      const rewritten = await failuresOn("quick/rewritten", again);
      assert.deepEqual(rewritten.ctx.briefFailures, said(rewritten.first, again, `and store commit ${late} changes it later with no \`amend brief:\` subject`));
    },
    { store: "before" }
  );
});

test("store: a --from-branch hand-test file is recorded by a commit on the branch, and its claims are counted from that record", async () => {
  const block = "briefs/quick-x-hand-test.md";
  const text = (claims: string) => `class: R1 — operator, 2026-09-28\n\n## Hand test\n\n${claims}\n`;
  const one = ["- H1 · the app answers", "  - run: `node src/app.ts`", "  - pass: exit 0", "  - needs: stack"].join("\n");
  await withRun(
    async (run) => {
      const store = run.store!;
      // An earlier run used the slug and held two claims; this run's file holds one.
      store.commit({ [block]: text(TWO_CLAIMS) }, "hand-test: an earlier run");
      const mine = store.commit({ [block]: text(one) }, "hand-test: quick-x");
      const lines = [
        "class: R1 — operator, 2026-09-28",
        "flow: 2",
        "from-branch: quick/x",
        `hand-test-block: store:${block}`,
        "steps: .claude/build-steps.toml",
        `freshen: merged | base=main | sha=${run.wave}`,
        `wave: review-cursory | sha=${run.wave}`,
        "verifier: N/A (from-branch, no brief)",
      ];
      assert.deepEqual((await context(run, lines)).briefFailures, [
        `hand-test-block: store:${block} is not recorded on the branch — the run's first commit is an empty one whose subject is \`hand-test-block: store:${block} @ <store commit>\` (FROM-BRANCH), so its first version cannot be told from an earlier run's`,
      ]);
      run.commit({}, `hand-test-block: store:${block} @ ${mine}`);
      const ctx = await context(run, lines);
      assert.deepEqual(ctx.briefFailures, [], "two claims at the path's oldest commit, one at this run's first: no claim left");
      assert.equal(ctx.brief.firstCommit, mine);
      assert.equal(ctx.brief.claimsAtFirst, 1);
    },
    { store: "after", brief: null }
  );
});

test("store: a claim may leave only by an `amend brief: operator change:` commit in the store", async () => {
  await withRun(
    async (run) => {
      const store = run.store!;
      const head = briefedHead("R1", run.wave, "sonnet", STORE_BRIEF);
      store.commit({ [STORE_BRIEF_PATH]: briefText() }, "amend brief: drop H2");
      const dropped = `brief: ${STORE_BRIEF} held 2 hand-test claims at its first commit and 1 at HEAD — a claim may leave only by an \`amend brief: operator change:\` commit in the store`;
      assert.deepEqual((await context(run, head)).briefFailures, [dropped]);
      run.commit({}, "amend brief: operator change: H2 is out of scope");
      assert.deepEqual((await context(run, head)).briefFailures, [dropped], "a code-repo commit never amends a store brief");
      store.commit({ [STORE_BRIEF_PATH]: `${briefText()}\n` }, "amend brief: operator change: H2 is out of scope");
      assert.deepEqual((await context(run, head)).briefFailures, []);
    },
    { store: "before", brief: briefText({ claims: TWO_CLAIMS }) }
  );
});

test("store: an amendment owes the verifier at the read whose commit times hold it — after the last code commit, the read ending at HEAD", async () => {
  const brief = `${briefText()}\n${MANIFEST}`;
  await withRun(
    async (run) => {
      const store = run.store!;
      const verifierOver = async (from: string, to: string, stage: "confirm-1" | "last") => {
        const move = stage === "confirm-1" ? "fix-1" : "fix-3";
        run.write("fix-3.txt", `CURSORY.3 · fixed · ${to} — done\n${EXIT_CHECKS}\n`);
        const lines = [...briefedHead("R1", run.wave, "sonnet", STORE_BRIEF), `${move}: 1/1 | model=sonnet | agent=f1 | from=${from} | sha=${to}`];
        return planStage(await context(run, lines), stage).readers.find((r) => r.reader === "build-verifier");
      };
      const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix: a is 3");
      assert.equal((await verifierOver(run.wave, s1, "confirm-1"))?.why, "no amend brief:, no rename");

      // Graded, after the last code commit: the read ending at HEAD holds it.
      store.commit({ [STORE_BRIEF_PATH]: brief.replace("name: app answers", "name: app answers twice") }, "amend brief: the deliverable says twice");
      assert.deepEqual(await verifierOver(run.wave, s1, "confirm-1"), {
        reader: "build-verifier",
        verdict: "owed",
        why: "an `amend brief:` commit changes the deliverables or assertions",
      });
      // A code commit after it: the range ending at s1 no longer holds it; the one over it does.
      const s2 = run.commit({ "src/app.ts": "export const a = 4;\n" }, "fix: a is 4");
      assert.equal((await verifierOver(run.wave, s1, "confirm-1"))?.verdict, "not owed");
      assert.equal((await verifierOver(s1, s2, "last"))?.why, "an `amend brief:` commit in the range changes the deliverables or assertions");

      // Ungraded: a reworded description owes nothing.
      store.commit(
        { [STORE_BRIEF_PATH]: brief.replace("name: app answers", "name: app answers twice").replace("description: app answers", "description: app answers, reworded") },
        "amend brief: reword the description"
      );
      const s3 = run.commit({ "src/app.ts": "export const a = 5;\n" }, "fix: a is 5");
      assert.deepEqual(await verifierOver(s2, s3, "last"), {
        reader: "build-verifier",
        verdict: "not owed",
        why: "the `amend brief:` commit in the range changes no deliverable or assertion",
        instead: "run <manifest> --brief-file <brief> --no-exercise yourself",
      });
    },
    { store: "before", brief }
  );
});

test("a brief from before the parts counts 0 claims at its first commit; an amend adding 2 passes (R.11)", async () => {
  await withRun(
    async (run) => {
      run.commit({ [BRIEF_PATH]: briefText({ claims: TWO_CLAIMS }) }, "amend brief: model line, target files, hand test");
      const ctx = await context(run, briefedHead("R1", run.wave));
      assert.deepEqual(ctx.briefFailures, []);
      assert.equal(ctx.brief.claimsAtFirst, 0);
      assert.deepEqual(ctx.brief.claims.map((c) => c.id), ["H1", "H2"]);
    },
    { brief: "class: R1 — operator, 2026-09-20\n\n## Deliverables\n\n1. a thing\n" }
  );
});

test("a hand-test pass holds after any later commit, PR code included; only a failed or unrun claim is owed", async () => {
  await withRun(async (run) => {
    noFindingsRun(run);
    run.commit({ "test/app.test.ts": "// more\n" }, "test only");
    run.commit({ "src/app.ts": "export const a = 7;\n" }, "code");
    run.ledger([...briefedHead("R1", run.wave), `verifier: CLEAN | sha=${run.wave}`, `hand-test-1: 1/1 | sha=${run.wave}`, `ship: x | sha=${run.head()}`]);
    assert.deepEqual((await facts(run)).failures, [], "a code commit after the pass re-owes nothing");
    const ctx = await context(run, briefedHead("R1", run.wave));
    assert.deepEqual(claimStates(ctx).map((s) => [s.id, s.passed]), [["H1", true]]);
  });
});

test("a skipped hand test with claims fails; with no claims it is the only legal line", async () => {
  await withRun(async (run) => {
    noFindingsRun(run);
    run.ledger([...briefedHead("R1", run.wave), `verifier: CLEAN | sha=${run.wave}`, "hand-test-1: skipped — no claims", `ship: x | sha=${run.wave}`]);
    const f = await facts(run);
    assert.ok(f.failures.includes("hand-test-1: skipped — the brief has 1 claims (H1); run them"), f.failures.join("\n"));
  });
  await withRun(
    async (run) => {
      waveFiles(run);
      run.build(ALL_ROUNDS, run.wave);
      run.ledger([...briefedHead("R0", run.wave), `verifier: CLEAN | sha=${run.wave}`, "hand-test-1: skipped — no claims", `ship: x | sha=${run.wave}`]);
      const f = await facts(run);
      assert.deepEqual(f.failures, []);
      assert.deepEqual(f.markerChecks, ["freshen", "wave", "verifier"]);
    },
    { brief: briefText({ claims: "none — the diff changes only a doc", cls: "R0" }) }
  );
});

// ── build-spec-2 §1.4: `build: … | parts=` against the brief's parts ────────────────────────

/** A brief with a `## Parts` section: P1 (`p1`) on src/app.ts, then P2 (`p2`, after P1) on
 *  src/auth.ts; the header is the strongest part's model. */
function partsBrief(p1 = "sonnet", p2 = "opus"): string {
  const header = [p1, p2].includes("opus") ? "opus" : [p1, p2].includes("sonnet") ? "sonnet" : "session";
  const part = (id: string, model: string, file: string, n: number, after: string) => [
    `- ${id} · ${file}`,
    `  - model: ${model} — why`,
    `  - files: ${file}`,
    "  - test files: none",
    `  - deliverables: ${n}`,
    `  - after: ${after}`,
    "  - tests: none",
  ];
  return [
    "class: R1 — operator, 2026-09-28",
    `model: ${header} — the strongest part`,
    "",
    "## Target files",
    "",
    "- src/app.ts",
    "- src/auth.ts",
    "",
    "## Hand test",
    "",
    "- H1 · the app answers",
    "  - run: `node src/app.ts`",
    "  - pass: exit 0",
    "",
    "## Deliverables",
    "",
    "- app answers",
    "- auth holds",
    "",
    "## Parts",
    "",
    ...part("P1", p1, "src/app.ts", 1, "none"),
    ...part("P2", p2, "src/auth.ts", 2, "P1"),
    "",
  ].join("\n");
}

/** `noFindingsRun` with its `build:` line swapped for `build`. */
function withBuildLine(run: Run, build: string): void {
  noFindingsRun(run);
  const lines = readFileSync(join(run.runDir, "ship.md"), "utf8").trimEnd().split("\n");
  run.ledger(lines.map((l) => (l.startsWith("build:") ? build : l)));
}

test("parts=: a two-part ledger passes; a brief with `## Parts` and no parts= fails, naming the form", async () => {
  await withRun(
    async (run) => {
      withBuildLine(run, `build: model=opus | agent=a1,a2 | parts=P1:sonnet:a1,P2:opus:a2 | sha=${run.wave}`);
      assert.deepEqual((await facts(run)).failures, []);
      withBuildLine(run, `build: model=opus | agent=a1,a2 | sha=${run.wave}`);
      assert.deepEqual((await facts(run)).failures, [
        "build: no parts= — the brief has a `## Parts` section; write parts=P1:sonnet:<id>,P2:opus:<id>",
      ]);
    },
    { brief: partsBrief() }
  );
});

test("parts=: a missing part, a model mismatch, a session part with an id, and an id not in agent= each fail with their line", () => {
  const parts = summariseBrief(partsBrief("session", "opus")).parts;
  const build = (agents: string, list: string) => parseLedger(`${HEAD_LINES}build: model=opus | agent=${agents} | parts=${list} | sha=aaaaaaa\n`).build!;
  assert.deepEqual(buildPartsFailures(build("a2", "P1:session:none,P2:opus:a2"), parts, true), []);
  assert.deepEqual(buildPartsFailures(build("a2", "P2:opus:a2"), parts, true), [
    "build: parts= has no P1 — every brief part appears once (P1 is session)",
  ]);
  assert.deepEqual(buildPartsFailures(build("a2", "P1:session:none,P2:sonnet:a2"), parts, true), [
    "build: parts=P2:sonnet — the brief says P2 is opus",
  ]);
  assert.deepEqual(buildPartsFailures(build("a1,a2", "P1:session:a1,P2:opus:a2"), parts, true), [
    "build: parts=P1:session:a1 — the session wrote P1, so no agent built it; write P1:session:none",
  ]);
  assert.deepEqual(buildPartsFailures(build("a2", "P1:session:none,P2:opus:a2+a9"), parts, true), [
    "build: parts= names agent a9 — not in agent=a2",
  ]);
  assert.deepEqual(buildPartsFailures(build("a2,a3", "P1:session:none,P2:opus:a2"), parts, true), [
    "build: agent=a3 is in no part of parts=",
  ]);
  assert.deepEqual(buildPartsFailures(build("a2", "P1:session:none,P2:opus:a2,P3:opus:none"), parts, true), [
    "build: parts=P3:opus:none — the brief has no part P3",
    "build: parts=P3:opus:none — P3 ran on opus, so it names its builder's agent id; only a session part is none",
  ]);
});

test("parts=: a brief without `## Parts` and a ledger without parts= pass; a parts= there is held to the implicit P1", () => {
  const parts = summariseBrief(briefText()).parts;
  const build = (line: string) => parseLedger(`${HEAD_LINES}${line}\n`).build!;
  assert.deepEqual(buildPartsFailures(build("build: model=sonnet | agent=a1 | sha=aaaaaaa"), parts, false), []);
  assert.deepEqual(buildPartsFailures(build("build: model=sonnet | agent=a1 | parts=P1:sonnet:a1 | sha=aaaaaaa"), parts, false), []);
  assert.deepEqual(buildPartsFailures(build("build: model=sonnet | agent=a1 | parts=P1:opus:a1 | sha=aaaaaaa"), parts, false), [
    "build: parts=P1:opus — the brief says P1 is sonnet",
  ]);
});

test("parts=: a run entered at CLOSE (agent=none) on a `## Parts` brief passes without parts= and fails with it", async () => {
  await withRun(
    async (run) => {
      withBuildLine(run, `build: model=opus | agent=none | sha=${run.wave}`);
      assert.deepEqual((await facts(run)).failures, []);
      withBuildLine(run, `build: model=opus | agent=none | parts=P1:sonnet:a1,P2:opus:a2 | sha=${run.wave}`);
      assert.deepEqual((await facts(run)).failures, [
        "build: parts= with agent=none — a floor check or a branch built before this run spawned no builder; drop parts=",
      ]);
    },
    { brief: partsBrief() }
  );
});

test("parts=: a session-only `## Parts` brief with `build: model=session | agent=none` passes", async () => {
  await withRun(
    async (run) => {
      withBuildLine(run, `build: model=session | agent=none | sha=${run.wave}`);
      assert.deepEqual((await facts(run)).failures, []);
    },
    { brief: partsBrief("session", "session") }
  );
});

test("--from-branch owes opus at R2 and sonnet below; a sonnet fixer at R2 fails", async () => {
  const fb = { fromBranch: "quick/x" } as const;
  assert.equal(owedModel({ ...parseLedger("class: R2 — o, 2026-09-28\nflow: 2\n"), ...fb }, null), "opus");
  assert.equal(owedModel({ ...parseLedger("class: R1 — o, 2026-09-28\nflow: 2\n"), ...fb }, null), "sonnet");
  assert.equal(owedModel(parseLedger("class: R2 — o, 2026-09-28\nflow: 2\n"), "session"), "opus");
  assert.equal(owedModel(parseLedger("class: R2 — o, 2026-09-28\nflow: 2\n"), "sonnet"), "sonnet");
  const block = "docs/briefs/quick-x-hand-test.md";
  await withRun(
    async (run) => {
      run.write("review-cursory.md", blk("CURSORY.1", "behavior"));
      run.write("gate-silent-failure-hunter.md", "NO FINDINGS\n");
      run.write("security-review.md", "NO FINDINGS\n");
      run.build(["1"], run.wave);
      const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
      run.write("fix-1.txt", `CURSORY.1 · fixed · ${s1} — a is 3\n${EXIT_CHECKS}\n`);
      run.write("stage-confirm-1/review-cursory-codex.md", stageFile(["- CURSORY.1 · resolved"]));
      run.write("stage-confirm-1/security-review.md", stageFile([]));
      run.build(["2", "3", "escalate", "final"], s1);
      run.ledger([
        "class: R2 — operator, 2026-09-28",
        "flow: 2",
        "from-branch: quick/x",
        `hand-test-block: ${block}`,
        "steps: .claude/build-steps.toml",
        `freshen: merged | base=main | sha=${run.wave}`,
        `wave: review-cursory, gate-silent-failure-hunter, security-review | sha=${run.wave}`,
        "verifier: N/A (from-branch, no brief)",
        `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`,
        `confirm-1: review-cursory-codex, security-review | sha=${s1}`,
        "hand-test-1: skipped — no claims",
        `ship: x | sha=${s1}`,
      ]);
      const f = await facts(run);
      assert.equal(f.model, "opus");
      assert.deepEqual(f.targets, "all");
      assert.deepEqual(f.failures, ["fix-1: model=sonnet — this run owes opus (R2, --from-branch)"]);
    },
    { brief: "class: R2 — operator, 2026-09-28\n\n## Hand test\n\nnone — a refactor with no surface\n", briefPath: block }
  );
});

test("a failed claim stays owed until a later run passes it", async () => {
  await withRun(async (run) => {
    noFindingsRun(run);
    run.handTest(2, `H1 · fail (env) · ${run.wave} — hand-test-2/H1.out — the stack was down\n`);
    const ctx = await context(run, briefedHead("R1", run.wave));
    assert.deepEqual(claimStates(ctx).map((s) => [s.passed, s.why]), [[false, "H1's last run (hand-test-2) failed (env)"]]);
    run.handTest(3, `H1 · pass · ${run.wave} — hand-test-3/H1.out\n`);
    assert.deepEqual(claimStates(ctx).map((s) => s.passed), [true]);
  });
});

test("rounds: a fix line whose counts or from disagree with the table fails; a refused file fails", async () => {
  await withRun(async (run) => {
    const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
    const r1 = round(run.wave, [row("CURSORY.1", "behavior"), row("CURSORY.2", "text", "src/auth.ts")]);
    run.table({ "1": r1, "2": { ...round(s1), refused: [{ file: "stage-confirm-1/review-cursory-codex.md", error: "line 3: bad" }] }, "3": round(s1), escalate: round(s1), final: finalRound(s1) });
    run.write("fix-1.txt", `CURSORY.1 · fixed · ${s1} — a is 3\nCURSORY.2 · dropped — not so\n${EXIT_CHECKS}\n`);
    run.ledger([...briefedHead("R1", run.wave), `fix-1: 2/3 | model=opus | agent=f1 | from=${s1} | sha=${s1}`]);
    const f = await facts(run);
    for (const want of [
      "fix-1: model=opus — this run owes sonnet (the brief's model: line)",
      "fix-1: 2/3 — round 1 holds 2 rows",
      "fix-1: 2 fixed — fix-1.txt has 1 `fixed` lines",
      `fix-1: from=${s1} — round 1 was built at ${run.wave}; from= is the round's head`,
    ]) {
      assert.ok(f.failures.includes(want), `${want}\n--- got:\n${f.failures.join("\n")}`);
    }
    assert.ok(f.failures.some((l) => l.startsWith("table.json round 2 refused stage-confirm-1/review-cursory-codex.md")));
  });
});

test("main's drift after the wave owes a drift read; the drift plan reads main's side of the merge", async () => {
  await withRun(async (run) => {
    noFindingsRun(run, "R2");
    const auth = (token: number, other: number) => `export const token = ${token};\n//\n//\n//\nexport const other = ${other};\n`;
    const pre = run.commit({ "src/auth.ts": auth(5, 1) }, "the branch edits auth line 1");
    run.git("checkout", "-q", "main");
    run.commit({ "src/app.ts": "export const a = 100;\n", "src/auth.ts": auth(1, 2) }, "main moves");
    run.git("checkout", "-q", "quick/x");
    run.git("merge", "-q", "--no-edit", "-X", "ours", "main");
    const merged = run.head();
    run.ledger([...briefedHead("R2", run.wave), `verifier: CLEAN | sha=${run.wave}`, `hand-test-1: 1/1 | sha=${run.wave}`, `ship: x | sha=${merged}`]);
    const f = await facts(run);
    assert.ok(
      f.failures.some((l) => l.startsWith("origin/main advanced on 2 of this branch's files after the wave (src/app.ts, src/auth.ts)")),
      f.failures.join("\n")
    );
    const ctx = await context(run, briefedHead("R2", run.wave));
    const plan = planStage(ctx, "drift", { from: pre });
    assert.equal(plan.owed, true);
    assert.deepEqual(plan.range, { from: pre, to: merged, files: ["src/app.ts", "src/auth.ts"] });
    assert.equal(plan.fixSecurity, null, "the drift read asks no fix trigger, though main's side changed auth");
    assert.deepEqual(plan.readers.map((r) => [r.reader, r.verdict]), [["review-cursory", "owed"], ["security-review", "not owed"]]);

    // The drift read recorded: no failure for the drift itself, and main moving again is caught.
    const withRead = [
      ...briefedHead("R2", run.wave),
      `verifier: CLEAN | sha=${run.wave}`,
      `hand-test-1: 1/1 | sha=${run.wave}`,
      `drift-read: review-cursory | from=${pre} | files=2 | sha=${merged}`,
    ];
    run.write("stage-drift-1/review-cursory.md", stageFile([]));
    run.ledger([...withRead, `ship: x | sha=${merged}`]);
    const read = await facts(run);
    assert.ok(!read.failures.some((l) => /^(?:origin\/main|main) advanced|^drift-read/.test(l)), read.failures.join("\n"));
    assert.ok(read.failures.includes("table.json has no round `drift-1` — run `reviewTable.ts build --run-dir <d> --round drift-1`"), read.failures.join("\n"));
    assert.deepEqual(read.readers["drift-1"]?.map((r) => r.reader), ["review-cursory"]);
    run.git("checkout", "-q", "main");
    run.commit({ "src/auth.ts": auth(1, 3) }, "main moves again");
    run.git("checkout", "-q", "quick/x");
    run.git("merge", "-q", "--no-edit", "main");
    run.ledger([...withRead, `ship: x | sha=${run.head()}`]);
    const again = await facts(run);
    assert.ok(
      again.failures.includes(
        `origin/main advanced again on src/auth.ts after the drift group (sha=${merged}) — merge origin/main and write \`drift-merge: | from=<the head before that merge> | sha=<the head after it>\``
      ),
      again.failures.join("\n")
    );
    run.ledger([...withRead, `drift-merge: | from=${merged} | sha=${run.head()}`, `ship: x | sha=${run.head()}`]);
    const merged2 = await facts(run);
    assert.ok(!merged2.failures.some((l) => /advanced|drift-merge/.test(l)), merged2.failures.join("\n"));
  }, { brief: briefText({ cls: "R2" }) });
});

test("the hunter counts only non-test lines: a fixer's async test alone does not owe it", async () => {
  await withRun(async (run) => {
    const s = run.commit(
      {
        "src/app.ts": "export const a = 5;\n",
        "src/__tests__/app.test.ts": "test('a', async () => {\n  await load();\n});\n",
        "test/app.test.ts": "// test\nawait run().catch(() => {});\n",
      },
      "fix 1: a is 5, pinned by async tests"
    );
    const ctx = await context(run, [...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s}`]);
    assert.deepEqual(
      planStage(ctx, "confirm-1").readers.find((r) => r.reader === "gate-silent-failure-hunter"),
      { reader: "gate-silent-failure-hunter", verdict: "sits out", why: "2 counted lines < 20, no catch/await/Promise" }
    );
  });
});

/** A run whose main moved twice under the branch: under `src/auth.ts` (the drift group: read, fix,
 *  confirm), then under `src/app.ts` (merged at `merge2`, which a `drift-merge:` clears). `lines(merges)`
 *  is the ledger up to `ship:` with those `drift-merge:` lines; `mainMoves(n)` moves main under
 *  `src/auth.ts` again and merges it. */
function oneDriftGroup(run: Run) {
  const auth = (token: number, other: number) => `export const token = ${token};\n//\n//\n//\nexport const other = ${other};\n`;
  const mainChanges = (files: Record<string, string>, msg: string) => {
    run.git("checkout", "-q", "main");
    run.commit(files, msg);
    run.git("checkout", "-q", "quick/x");
    run.git("merge", "-q", "--no-edit", "-X", "ours", "main");
    return run.head();
  };
  const mainMoves = (other: number) => mainChanges({ "src/auth.ts": auth(1, other) }, `main moves: other is ${other}`);
  waveFiles(run);
  run.build(ALL_ROUNDS, run.wave);
  const pre1 = run.commit({ "src/auth.ts": auth(5, 1) }, "the branch edits auth line 1");
  const merge1 = mainMoves(2);
  run.write("stage-drift-1/review-cursory.md", stageFile([], [blk("CURSORY.501", "behavior")]));
  run.build(["drift-1"], merge1);
  const fix1 = run.commit({ "src/app.ts": "export const a = 6;\n" }, "fix(close): drift round — 1 rows");
  run.write("fix-drift-1.txt", `CURSORY.501 · fixed · ${fix1} — a is 6\n${EXIT_CHECKS}\n`);
  run.write("stage-drift-confirm-1/review-cursory-codex.md", stageFile(["- CURSORY.501 · resolved"]));
  const merge2 = mainChanges({ "src/app.ts": "export const a = 100;\n" }, "main moves: a is 100");
  const head = run.head();
  run.handTest(1, `H1 · pass · ${head} — hand-test-1/H1.out\n`);
  run.build(["final"], merge2);
  const group1 = [
    `drift-read: review-cursory | from=${pre1} | files=1 | sha=${merge1}`,
    `drift-fix: 1/1 | model=sonnet | agent=d1 | from=${merge1} | sha=${fix1}`,
    `drift-confirm: review-cursory-codex | sha=${fix1}`,
  ];
  const lines = (merges: [string, string][]) => [
    ...briefedHead("R1", run.wave),
    `verifier: CLEAN | sha=${run.wave}`,
    ...group1,
    ...merges.map(([from, sha]) => `drift-merge: | from=${from} | sha=${sha}`),
    `hand-test-1: 1/1 | sha=${head}`,
  ];
  return { pre1, merge1, fix1, merge2, lines, mainMoves };
}

test("one drift group, then a `drift-merge:` for main's next move, passes; the group's plan measures from the wave", async () => {
  await withRun(async (run) => {
    const { pre1, merge1, fix1, merge2, lines } = oneDriftGroup(run);
    run.ledger([...lines([[fix1, merge2]]), `ship: x | sha=${run.head()}`]);
    const f = await facts(run);
    assert.deepEqual(f.failures, []);
    assert.deepEqual(f.readers["drift-1"]?.map((r) => r.reader), ["review-cursory"]);
    assert.deepEqual(f.readers["drift-confirm-1"]?.map((r) => r.reader), ["review-cursory-codex"]);
    assert.equal(f.readers["drift-2"], undefined);
    const plan = planStage(await context(run, lines([[fix1, merge2]])), "drift");
    assert.equal(plan.key, "drift-1");
    assert.deepEqual(plan.range, { from: pre1, to: merge1, files: ["src/app.ts", "src/auth.ts"] }, "main's files since the wave, up to origin/main now");
  });
});

test("one drift group: main moving after it with no `drift-merge:` fails, naming `drift-merge:`, never another drift group", async () => {
  await withRun(async (run) => {
    const { fix1, lines } = oneDriftGroup(run);
    run.ledger([...lines([]), `ship: x | sha=${run.head()}`]);
    assert.deepEqual((await facts(run)).failures, [
      `origin/main advanced again on src/app.ts after the drift group (sha=${fix1}) — merge origin/main and write \`drift-merge: | from=<the head before that merge> | sha=<the head after it>\``,
    ]);
  });
});

test("two `drift-merge:` lines pass; main moving after the last one fails from its sha", async () => {
  await withRun(async (run) => {
    const { fix1, merge2, lines, mainMoves } = oneDriftGroup(run);
    const merge3 = mainMoves(4);
    run.ledger([...lines([[fix1, merge2]]), `ship: x | sha=${merge3}`]);
    assert.deepEqual((await facts(run)).failures, [
      `origin/main advanced again on src/auth.ts after drift-merge 1 (sha=${merge2}) — merge origin/main and write \`drift-merge: | from=<the head before that merge> | sha=<the head after it>\``,
    ]);
    run.ledger([...lines([[fix1, merge2], [merge2, merge3]]), `ship: x | sha=${merge3}`]);
    assert.deepEqual((await facts(run)).failures, []);
  });
});

test("a `drift-merge:` that starts before the group's end, or whose range holds no merge, clears nothing", async () => {
  await withRun(async (run) => {
    const { pre1, fix1, merge2, lines } = oneDriftGroup(run);
    run.ledger([...lines([[pre1, merge2]]), `ship: x | sha=${run.head()}`]);
    const early = (await facts(run)).failures;
    assert.ok(
      early.includes(`drift-merge (1): from=${pre1} is not after the drift group's sha=${fix1} — a drift-merge starts at the head the last one ended at, or later`),
      early.join("\n")
    );
    assert.ok(early.some((l) => l.startsWith("origin/main advanced again on src/app.ts after the drift group")), early.join("\n"));
    run.ledger([...lines([[fix1, fix1]]), `ship: x | sha=${run.head()}`]);
    const empty = (await facts(run)).failures;
    assert.ok(empty.some((l) => l.startsWith(`drift-merge (1): ${fix1.slice(0, 9)}..${fix1} holds no merge`)), empty.join("\n"));
  });
});

test("one drift group: `--stage drift` from another head than the group's start is refused", async () => {
  await withRun(async (run) => {
    const { pre1, fix1, lines } = oneDriftGroup(run);
    const ctx = await context(run, lines([]));
    assert.equal(planStage(ctx, "drift", { from: pre1 }).key, "drift-1", "the group's own start plans it");
    assert.throws(() => planStage(ctx, "drift", { from: fix1 }), /^Error: one drift group per build — merge main, write `drift-merge:`; SHIP's pre-push checks cover it$/);
  });
});

test("CURSORY.4: the drift group is judged — its missing confirm and fix lines fail", async () => {
  await withRun(async (run) => {
    const { fix1, merge2, lines } = oneDriftGroup(run);
    const all = [...lines([[fix1, merge2]]), `ship: x | sha=${run.head()}`];
    run.ledger(all.filter((l) => !l.startsWith("drift-confirm:")));
    assert.deepEqual((await facts(run)).failures, ["missing line: drift-confirm: — drift group 1's fix changed a file"]);
    run.ledger(all.filter((l) => !l.startsWith("drift-confirm:") && !l.startsWith("drift-fix:")));
    const f = await facts(run);
    assert.ok(f.failures.includes("missing line: drift-fix: — drift group 1's round has 1 rows"), f.failures.join("\n"));
  });
});

test("CURSORY.4: final carries the drift round — its open row stays open", async () => {
  await withRun(async (run) => {
    const { fix1, merge2, lines } = oneDriftGroup(run);
    run.write("stage-drift-confirm-1/review-cursory-codex.md", stageFile(["- CURSORY.501 · open — a is still 5 on one path"]));
    run.build(["final"], run.head());
    run.ledger([...lines([[fix1, merge2]]), `ship: x | sha=${run.head()}`]);
    const f = await facts(run);
    assert.ok(f.failures.includes("final: open CURSORY.501 behavior — the PR stays draft; the operator decides"), f.failures.join("\n"));
  });
});

test("a drift round built before its group's merge fails", async () => {
  await withRun(async (run) => {
    const { pre1, merge1, fix1, merge2, lines } = oneDriftGroup(run);
    const rounds = JSON.parse(readFileSync(join(run.runDir, "table.json"), "utf8")).rounds;
    run.table({ ...rounds, "drift-1": { ...rounds["drift-1"], head: pre1 } });
    run.ledger([...lines([[fix1, merge2]]), `ship: x | sha=${run.head()}`]);
    const f = await facts(run);
    assert.ok(
      f.failures.includes(
        `table.json round drift-1 was built at ${pre1}, before drift group 1's merge ${merge1} — re-build it after the merge: \`${rebuildCommand(run.runDir, "drift-1", merge1)}\``
      ),
      f.failures.join("\n")
    );
  });
});

test("an arm that could not run here throws; an old arm's exit 2 falls back with a note", async () => {
  const eperm = `console.error("Error: listen EPERM: operation not permitted /tmp/tsx-501/1.pipe"); process.exit(1);`;
  await withRun(
    async (run) => {
      const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
      const ctx = await context(run, [...briefedHead("R2", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`]);
      assert.throws(() => planStage(ctx, "confirm-1"), (err: unknown) => {
        assert.ok(err instanceof ArmEnvError);
        assert.match(err.message, /^the signals arm could not run here \(`node .*arm\.mjs --app-code` exited 1: Error: listen EPERM: .*\) — re-run outside the sandbox$/);
        return true;
      });
    },
    { arm: eperm }
  );
  // CODEX.6: any crash is loud, not only a sandbox one.
  await withRun(
    async (run) => {
      const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
      const ctx = await context(run, [...briefedHead("R1", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`]);
      assert.throws(() => planStage(ctx, "confirm-1"), (err: unknown) => {
        assert.ok(err instanceof ArmEnvError);
        assert.match(err.message, /^the signals arm could not run here \(`node .*arm\.mjs --app-code` exited 1: .*Error: boom/);
        return true;
      });
    },
    { arm: `throw new Error("boom");` }
  );
  const old = `console.error("riskClass: unknown flag(s): " + process.argv[2]); process.exit(2);`;
  await withRun(
    async (run) => {
      const s1 = run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix 1");
      const ctx = await context(run, [...briefedHead("R2", run.wave), `fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`]);
      const plan = planStage(ctx, "confirm-1");
      assert.equal(plan.fixSecurity?.source, "fallback");
      assert.equal(plan.readers.find((r) => r.reader === "security-review")?.verdict, "owed");
      assert.ok([...ctx.notes].some((n) => /exited 2: riskClass: unknown flag/.test(n)), [...ctx.notes].join("\n"));
    },
    { arm: old }
  );
});
