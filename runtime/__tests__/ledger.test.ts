/** The ship ledger's grammar (`lib/ledger.ts`): every §1.8 line form, and every refusal. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PINNED_CLASS_LINE_RE } from "../lib/brief.ts";
import {
  FLOW_CHANGED,
  LEDGER_MOVES,
  ledgerMoveOf,
  parseLedger,
  READ_MOVE_FOLDER,
  readMoveFolder,
  runBranchError,
} from "../lib/ledger.ts";

const A = "aaaaaaa";
const B = "bbbbbbb";
const C = "ccccccc";
const HEAD = "class: R2 — operator, 2026-09-28 | measured-at=1111111\nflow: 2\n";

/** A ledger: the class and flow lines, then `lines`. */
const ledger = (...lines: string[]) => HEAD + lines.join("\n") + "\n";

const FULL = ledger(
  "brief: docs/build/briefs/x.md",
  "steps: .claude/build-steps.toml | fallback: none | none: none",
  `build: model=opus | agent=a1b2c3 | sha=${A}`,
  `freshen: ${A} | base=origin/main | sha=${A}`,
  `wave: review-cursory, gate-silent-failure-hunter, build-verifier, security-review | skipped: simplifier — 40 < 100 | codex: review-cursory | repo: comment-reader | sha=${A}`,
  `verifier: CLEAN | sha=${A}`,
  `fix-1: 3/4 | model=opus | agent=f1 | from=${A} | sha=${B}`,
  `confirm-1: review-cursory-codex, gate-silent-failure-hunter, security-review | sha=${B}`,
  `hand-test-1: 2/3 | sha=${B}`,
  `fix-2: 1/1 | model=opus | agent=f2,f3 | from=${B} | sha=${C}`,
  `confirm-2: review-cursory (codex failed: exit 2: no out file) | sha=${C}`,
  `hand-test-2: 3/3 | sha=${C}`,
  "leftovers: QRK-12 | rows=2 | scope=plan-QRK-5",
  `ship: https://github.com/o/r/pull/9 | sha=${C}`
);

test("a whole flow-2 ledger parses into its typed lines", () => {
  const l = parseLedger(FULL);
  assert.equal(l.cls, "R2");
  assert.equal(l.pinned, true);
  assert.equal(l.measuredAt, "1111111");
  assert.equal(l.brief, "docs/build/briefs/x.md");
  assert.equal(l.fromBranch, null);
  assert.deepEqual(l.build, { model: "opus", agents: ["a1b2c3"], sha: A });
  assert.equal(l.base, "origin/main");
  assert.equal(l.branch, null);
  assert.deepEqual(l.waveReaders, ["review-cursory", "gate-silent-failure-hunter", "build-verifier", "security-review"]);
  assert.deepEqual(l.waveRepoReaders, ["comment-reader"]);
  assert.deepEqual(l.verifier, { verdict: "CLEAN", sha: A });
  assert.deepEqual(l.fixes.get("fix-1"), { fixed: 3, rows: 4, model: "opus", agents: ["f1"], from: A, sha: B });
  assert.deepEqual(l.reads.get("confirm-1")?.readers.map((r) => r.reader), [
    "review-cursory-codex",
    "gate-silent-failure-hunter",
    "security-review",
  ]);
  assert.deepEqual(l.handTests, [
    { n: 1, skipped: false, pass: 2, ran: 3, sha: B },
    { n: 2, skipped: false, pass: 3, ran: 3, sha: C },
  ]);
  assert.deepEqual(l.leftovers, { to: "QRK-12", rows: 2, scope: "plan-QRK-5" });
  assert.equal(l.lines.get("ship")?.fields.sha, C);
  assert.deepEqual(l.lines.get("ship")?.text, ["https://github.com/o/r/pull/9"]);
});

// ── A.5: names with digits parse; unknown names and repeats throw ──────────────────────────

test("`fix-2:` parses and is not ignored", () => {
  const l = parseLedger(FULL);
  assert.deepEqual(l.fixes.get("fix-2"), { fixed: 1, rows: 1, model: "opus", agents: ["f2", "f3"], from: B, sha: C });
  assert.ok(l.lines.has("fix-2"));
});

test("an unknown move throws, the old flow's moves included", () => {
  for (const line of [`apply: 3/4 | sha=${A}`, `confirm: 3/3 | sha=${A}`, `fix-4: 1/1 | sha=${A}`, "hand-test: ran | ok", "note: prose with a colon"]) {
    assert.throws(() => parseLedger(ledger(line)), /is not a ledger move/, line);
  }
});

test("every move appears at most once", () => {
  assert.throws(
    () => parseLedger(ledger(`fix-1: 1/1 | model=opus | agent=f | from=${A} | sha=${B}`, `fix-1: 1/1 | model=opus | agent=f | from=${B} | sha=${C}`)),
    /two `fix-1:` lines/
  );
  assert.throws(() => parseLedger(ledger(`hand-test-2: 1/1 | sha=${A}`, `hand-test-2: 1/1 | sha=${B}`)), /two `hand-test-2:` lines/);
  assert.throws(() => parseLedger(ledger("flow: 2")), /two `flow:` lines/);
  assert.throws(() => parseLedger(ledger("class: R1 — operator, 2026-09-28")), /second `class:` line/);
});

// ── A.18: the flow line ─────────────────────────────────────────────────────────────────────

test("a ledger without `flow: 2` throws with the restart message", () => {
  const old = `class: R1 — operator, 2026-09-28 | measured-at=1111111\nfreshen: ${A} | sha=${A}\napply: 1/1 | sha=${A}\n`;
  assert.throws(() => parseLedger(old), (e: Error) => e.message === FLOW_CHANGED);
  assert.equal(FLOW_CHANGED, "the build flow changed; re-read ~/.agent-build/skills/build/CLOSE.md and restart the review from the wave");
  assert.throws(() => parseLedger("class: R1 — operator, 2026-09-28\nflow: 1\n"), (e: Error) => e.message === FLOW_CHANGED);
  assert.throws(
    () => parseLedger(`class: R1 — operator, 2026-09-28\nsteps: absent\nflow: 2\n`),
    /`flow: 2` must be the ledger's second line/
  );
});

// ── R.7: reader lists split on `,` only; the Codex stand-in token ─────────────────────────

test("a read line's readers split on `,` only, and the Codex stand-in keeps a why with a colon and spaces", () => {
  const l = parseLedger(ledger(`confirm-1: review-cursory (codex failed: exit 1: check refused line 4), security-review | sha=${A}`));
  assert.deepEqual(l.reads.get("confirm-1")?.readers, [
    { reader: "review-cursory", codexFailed: "exit 1: check refused line 4" },
    { reader: "security-review", codexFailed: null },
  ]);
  assert.throws(
    () => parseLedger(ledger(`confirm-1: review-cursory-codex security-review | sha=${A}`)),
    /`review-cursory-codex security-review` is not a reader/
  );
  assert.throws(
    () => parseLedger(ledger(`confirm-1: review-cursory (codex failed: exit 1, no file) | sha=${A}`)),
    /no `,` or `\|` in <why>/
  );
  assert.throws(() => parseLedger(ledger(`last-read: fixer | sha=${A}`)), /`fixer` is not a reader/);
  assert.throws(() => parseLedger(ledger(`confirm-1: security-review, security-review | sha=${A}`)), /names one reader twice/);
});

test("fix lines take one or two agent ids; `build:` with model=session takes agent=none", () => {
  const l = parseLedger(ledger(`build: model=session | agent=none | sha=${A}`, `escalate: 0/2 | model=opus | agent=e1,e2 | from=${A} | sha=${A}`));
  assert.deepEqual(l.build, { model: "session", agents: [], sha: A });
  assert.deepEqual(l.fixes.get("escalate")?.agents, ["e1", "e2"]);
  assert.deepEqual(
    parseLedger(ledger(`build: model=opus | agent=none | sha=${A}`)).build,
    { model: "opus", agents: [], sha: A },
    "fix4: a briefed branch built before this run, entered at CLOSE, had no builder agent here"
  );
  assert.throws(() => parseLedger(ledger(`build: model=session | agent=a1 | sha=${A}`)), /write agent=none/);
  assert.throws(() => parseLedger(ledger(`drift-fix: 1/1 | model=opus | agent=none | from=${A} | sha=${A}`)), /agent=none is legal only on `build:`/);
  assert.throws(() => parseLedger(ledger(`fix-1: 1/1 | model=opus | agent=none | from=${A} | sha=${A}`)), /agent=none is legal only on `build:`/);
  assert.throws(() => parseLedger(ledger(`fix-1: 1/1 | model=opus | agent=a b | from=${A} | sha=${A}`)), /`agent=a b` holds a space/);
  assert.throws(() => parseLedger(ledger(`fix-1: 1/1 | model=opus | agent=a;b | from=${A} | sha=${A}`)), /agent=a;b is not `<id>\[,<id>\]`/);
  assert.throws(() => parseLedger(ledger(`fix-1: 1/1 | model=session | agent=a | from=${A} | sha=${A}`)), /a fixer runs on opus or sonnet/);
  assert.throws(() => parseLedger(ledger(`fix-3: 1/1 | model=opus | agent=a | sha=${A}`)), /needs a `from=` field/);
  assert.throws(() => parseLedger(ledger(`fix-3: 2/1 | model=opus | agent=a | from=${A} | sha=${A}`)), /fixed 2 is more than its 1 rows/);
});

// ── build-spec-2 §1.4: `build: … | parts=`, `freshen: … | branch=`, the branch check ──────────

test("`build:` takes parts=: each entry a part, its model, and its ids joined by + or none", () => {
  const l = parseLedger(ledger(`build: model=opus | agent=a1,a2,a3 | parts=P1:sonnet:a1,P2:opus:a2+a3,P3:session:none | sha=${A}`));
  assert.deepEqual(l.build?.parts, [
    { part: "P1", model: "sonnet", agents: ["a1"] },
    { part: "P2", model: "opus", agents: ["a2", "a3"] },
    { part: "P3", model: "session", agents: [] },
  ]);
  for (const bad of ["P1:sonnet", "P1:haiku:a1", "X1:sonnet:a1", "P1:sonnet:a1,a2", "P1:sonnet:a1+", "P0:sonnet:a1"]) {
    assert.throws(() => parseLedger(ledger(`build: model=opus | agent=a1 | parts=${bad} | sha=${A}`)), /parts= entry `[^`]*` is not/, bad);
  }
  assert.throws(() => parseLedger(ledger(`build: model=opus | agent=a1,a2 | parts=P1:opus:a1,P1:opus:a2 | sha=${A}`)), /parts= names P1 twice/);
  assert.throws(() => parseLedger(ledger(`fix-1: 1/1 | model=opus | agent=f | parts=P1:opus:f | from=${A} | sha=${A}`)), /takes no `parts=` field/);
});

test("an older ledger's `build: … | started=` still parses, to the same build; another move refuses it", () => {
  const plain = parseLedger(ledger(`build: model=opus | agent=a1 | sha=${A}`)).build;
  assert.deepEqual(parseLedger(ledger(`build: model=opus | agent=a1 | sha=${A} | started=2026-10-06T08:00:00Z`)).build, plain);
  assert.throws(() => parseLedger(ledger(`fix-1: 1/1 | model=opus | agent=f | started=2026-10-06T08:00:00Z | from=${A} | sha=${A}`)), /takes no `started=` field/);
});

test("`freshen:` takes branch=; runBranchError passes the run's branch and a ledger without it, and names both branches otherwise", () => {
  const withBranch = parseLedger(ledger(`freshen: merged | base=main | branch=quick/x | sha=${A}`));
  assert.equal(withBranch.branch, "quick/x");
  assert.equal(runBranchError(withBranch, "quick/x", "/r/build-17-4"), null);
  assert.equal(
    runBranchError(withBranch, "quick/other", "/r/build-17-4"),
    "run 17-4 is on quick/x; this tree is on quick/other — enter the run's tree first"
  );
  const without = parseLedger(ledger(`freshen: merged | base=main | sha=${A}`));
  assert.equal(without.branch, null);
  assert.equal(runBranchError(without, "quick/other", "/r/build-17-4"), null, "a run in flight at the cutover runs unchecked");
  assert.throws(() => parseLedger(ledger(`wave: review-cursory | branch=quick/x | sha=${A}`)), /takes no `branch=` field/);
});

// ── R.3 and R.4: the drift read's start and the run's base are ledger facts ───────────────

test("`drift-read:` carries from= and files= and reads with review-cursory only; `freshen:` carries base=", () => {
  const l = parseLedger(ledger(`freshen: ${A} | base=5defa1028 | sha=${A}`, `drift-read: review-cursory | from=${B} | files=3 | sha=${C}`));
  assert.equal(l.base, "5defa1028");
  assert.deepEqual(l.driftGroups[0]?.read, {
    readers: [{ reader: "review-cursory", codexFailed: null }],
    from: B,
    files: 3,
    sha: C,
  });
  assert.throws(() => parseLedger(ledger(`drift-read: review-cursory | files=3 | sha=${C}`)), /needs a `from=` field/);
  assert.throws(() => parseLedger(ledger(`drift-read: review-cursory-codex | from=${B} | files=3 | sha=${C}`)), /reads with `review-cursory` only/);
  assert.throws(
    () => parseLedger(ledger(`drift-read: review-cursory, security-review | from=${B} | files=3 | sha=${C}`)),
    /reads with `review-cursory` only/,
    "security-review reads a fix at confirm-1 and confirm-2 only"
  );
  assert.throws(() => parseLedger(ledger(`freshen: ${A} | sha=${A}`)), /`freshen:` needs a `base=` field/);
});

// ── One drift group per build; a later move of main is `drift-merge:` ──

const D = "ddddddd";
const E = "eeeeeee";
const group = (from: string, read: string, fix?: string) => [
  `drift-read: review-cursory | from=${from} | files=1 | sha=${read}`,
  ...(fix ? [`drift-fix: 1/1 | model=opus | agent=d1 | from=${read} | sha=${fix}`, `drift-confirm: review-cursory-codex | sha=${fix}`] : []),
];

test("one drift group per build: a second `drift-read:` fails, naming `drift-merge:`", () => {
  const l = parseLedger(ledger(...group(A, B, C)));
  assert.deepEqual(l.driftGroups.map((g) => [g.read.from, g.read.sha, g.fix?.sha ?? null, g.confirm?.sha ?? null]), [[A, B, C, C]]);
  assert.deepEqual(l.driftMerges, []);
  assert.throws(
    () => parseLedger(ledger(...group(A, B, C), ...group(C, D))),
    /`drift-read:` a second drift read — one drift group per build — a later move of main is `drift-merge:/
  );
  assert.throws(() => parseLedger(ledger(...group(A, B), ...group(B, C))), /a second drift read — one drift group per build/);
  assert.equal(readMoveFolder("drift-confirm", 1), "stage-drift-confirm-1");
  assert.equal(readMoveFolder("last-read"), "stage-last");
  assert.throws(() => readMoveFolder("drift-read"), /needs the drift group/);
});

test("`drift-merge: | from= | sha=` follows the complete drift group, may repeat, and takes no reader", () => {
  const merge = (from: string, sha: string) => `drift-merge: | from=${from} | sha=${sha}`;
  const two = parseLedger(ledger(...group(A, B, C), merge(C, D), merge(D, E)));
  assert.deepEqual(two.driftMerges, [
    { from: C, sha: D },
    { from: D, sha: E },
  ]);
  assert.deepEqual(parseLedger(ledger(...group(A, B), merge(B, C))).driftMerges, [{ from: B, sha: C }], "a group whose read found nothing is complete");
  assert.throws(() => parseLedger(ledger(merge(A, B))), /`drift-merge:` comes before any `drift-read:`/);
  assert.throws(
    () => parseLedger(ledger(group(A, B, C)[0]!, merge(B, C), ...group(A, B, C).slice(1))),
    /`drift-fix:` follows a `drift-merge:` — one drift group per build/,
    "a drift-merge before the group's fix and confirm"
  );
  assert.throws(
    () => parseLedger(ledger(...group(A, B, C).slice(0, 2), merge(C, D), group(A, B, C)[2]!)),
    /`drift-confirm:` follows a `drift-merge:`/,
    "a drift-merge before the group's confirm"
  );
  assert.throws(() => parseLedger(ledger(...group(A, B), `drift-merge: review-cursory | from=${B} | sha=${C}`)), /names no reader and no agent/);
  assert.throws(() => parseLedger(ledger(...group(A, B), `drift-merge: | sha=${C}`)), /needs a `from=` field/);
});

test("TEXT-CURSORY.5: a second `leftovers:` line (the last count stands) and a second `banked:` line (the ids add up) parse", () => {
  const l = parseLedger(
    ledger("leftovers: QRK-12 | rows=2 | scope=plan-QRK-5", "banked: CODEX.4 (awaiting operator)", ...group(A, B), "leftovers: QRK-12 | rows=3 | scope=plan-QRK-5", "banked: CURSORY.2, CODEX.4 (awaiting operator)")
  );
  assert.deepEqual(l.leftovers, { to: "QRK-12", rows: 3, scope: "plan-QRK-5" });
  assert.deepEqual(l.banked, ["CODEX.4", "CURSORY.2"]);
  assert.throws(() => parseLedger(ledger(`ship: x | sha=${A}`, `ship: y | sha=${B}`)), /two `ship:` lines/);
});

test("a drift group keeps its order: read, then fix, then confirm", () => {
  const fix = `drift-fix: 1/1 | model=opus | agent=d1 | from=${B} | sha=${C}`;
  const confirm = `drift-confirm: review-cursory-codex | sha=${C}`;
  const read = `drift-read: review-cursory | from=${A} | files=1 | sha=${B}`;
  assert.throws(() => parseLedger(ledger(fix, read)), /`drift-fix:` comes before any `drift-read:`/);
  assert.throws(() => parseLedger(ledger(read, confirm)), /`drift-confirm:` has no `drift-fix:` in its group/);
  assert.throws(() => parseLedger(ledger(read, fix, fix)), /two `drift-fix:` lines in the drift group/);
  assert.throws(() => parseLedger(ledger(read, fix, confirm, confirm)), /`drift-confirm:` follows its group's `drift-confirm:`/);
  assert.throws(() => parseLedger(ledger(read, fix, confirm, fix)), /`drift-fix:` follows its group's `drift-confirm:`/);
  assert.throws(
    () => parseLedger(ledger(read, `escalate: 1/1 | model=opus | agent=e1 | from=${A} | sha=${B}`, `escalate: 1/1 | model=opus | agent=e2 | from=${B} | sha=${C}`)),
    /two `escalate:` lines/
  );
});

test("a field the move does not take, a repeated field, or a bad value throws", () => {
  assert.throws(() => parseLedger(ledger(`confirm-1: review-cursory-codex | rows=2 | sha=${A}`)), /takes no `rows=` field/);
  assert.throws(() => parseLedger(ledger(`confirm-1: review-cursory-codex | sha=${A} | sha=${B}`)), /two `sha=` fields/);
  assert.throws(() => parseLedger(ledger("confirm-1: review-cursory-codex | sha=HEAD")), /sha=HEAD is not a git sha/);
  assert.throws(() => parseLedger(ledger("leftovers: pr-body | rows=two")), /rows=two is not a count/);
  assert.throws(() => parseLedger(ledger("confirm-1: review-cursory-codex")), /needs a `sha=` field/);
});

// ── hand-test, verifier, leftovers forms ──────────────────────────────────────────────────

test("hand-test lines: `<pass>/<ran> | sha=`, or `hand-test-1: skipped — no claims` only", () => {
  const l = parseLedger(ledger(`hand-test-2: 1/2 | sha=${B}`, "hand-test-1: skipped — no claims"));
  assert.deepEqual(l.handTests, [
    { n: 1, skipped: true },
    { n: 2, skipped: false, pass: 1, ran: 2, sha: B },
  ]);
  assert.throws(() => parseLedger(ledger("hand-test-2: skipped — no claims")), /only `hand-test-1` may say/);
  assert.throws(() => parseLedger(ledger(`hand-test-1: skipped — no claims | sha=${A}`)), /drop `sha=`/);
  assert.throws(() => parseLedger(ledger("hand-test-1: 2/2")), /needs a `sha=` field/);
  assert.throws(() => parseLedger(ledger(`hand-test-1: 3/2 | sha=${A}`)), /pass 3 is more than/);
  assert.throws(() => parseLedger(ledger(`hand-test-1: all good | sha=${A}`)), /neither `<pass>\/<ran>`/);
});

test("verifier lines: CLEAN, CLEARED by a hand-test claim, or N/A on --from-branch", () => {
  assert.deepEqual(parseLedger(ledger(`verifier: CLEAN | sha=${A}`)).verifier, { verdict: "CLEAN", sha: A });
  assert.deepEqual(parseLedger(ledger(`verifier: CLEARED | by=hand-test-2:H3 | sha=${A}`)).verifier, {
    verdict: "CLEARED",
    handTest: 2,
    claim: "H3",
    sha: A,
  });
  const fb = parseLedger(ledger("from-branch: quick/x", "hand-test-block: docs/build/briefs/quick-x-hand-test.md", "verifier: N/A (from-branch, no brief)"));
  assert.deepEqual(fb.verifier, { verdict: "N/A" });
  assert.equal(fb.fromBranch, "quick/x");
  assert.equal(fb.handTestBlock, "docs/build/briefs/quick-x-hand-test.md");
  assert.throws(() => parseLedger(ledger(`verifier: PASS | sha=${A}`)), /`PASS` is not a verdict/);
  assert.throws(() => parseLedger(ledger(`verifier: CLEARED | sha=${A}`)), /needs `by=hand-test-<n>:H<k>`/);
  assert.throws(() => parseLedger(ledger(`verifier: CLEAN | by=hand-test-1:H1 | sha=${A}`)), /`CLEAN` takes no `by=`/);
  assert.throws(() => parseLedger(ledger("verifier: CLEAN")), /needs a `sha=` field/);
});

test("fix4: a later `verifier:` line (a later read owed the verifier) parses, and the last one counts", () => {
  const l = parseLedger(ledger(`verifier: CLEAN | sha=${A}`, `fix-1: 1/1 | model=opus | agent=f1 | from=${A} | sha=${B}`, `verifier: CLEARED | by=hand-test-2:H1 | sha=${C}`));
  assert.deepEqual(l.verifier, { verdict: "CLEARED", handTest: 2, claim: "H1", sha: C });
  assert.equal(l.lines.get("verifier")?.fields.sha, C);
});

test("fix4: past the first two lines order carries no meaning — `banked:`, `verifier:`, and a SHIP-time `hand-test-<n>:` may follow `ship:`", () => {
  const body = [
    `wave: review-cursory | sha=${A}`,
    `fix-1: 1/2 | model=opus | agent=f1 | from=${A} | sha=${B}`,
    `hand-test-1: 1/1 | sha=${B}`,
    "leftovers: pr-body | rows=1 | scope=plan-QRK-5",
  ];
  const tail = ["banked: CODEX.2 (awaiting operator)", `verifier: CLEAN | sha=${B}`, `hand-test-2: 2/2 | sha=${C}`];
  const before = parseLedger(ledger(...body, ...tail, `ship: dry-run (no push) | sha=${C}`));
  const after = parseLedger(ledger(...body, `ship: dry-run (no push) | sha=${C}`, ...tail));
  for (const l of [before, after]) {
    assert.deepEqual(l.banked, ["CODEX.2"]);
    assert.deepEqual(l.verifier, { verdict: "CLEAN", sha: B });
    assert.deepEqual(l.handTests.map((h) => h.n), [1, 2]);
    assert.equal(l.lines.get("ship")?.fields.sha, C);
  }
});

test("leftovers lines name a ticket id or pr-body, a row count, and the plan or session they belong to when they name one", () => {
  assert.deepEqual(parseLedger(ledger("leftovers: pr-body | rows=4 | scope=session-1a2b3c4d")).leftovers, {
    to: "pr-body",
    rows: 4,
    scope: "session-1a2b3c4d",
  });
  assert.equal(parseLedger(ledger("leftovers: QRK-50 | scope=plan-QRK-5 | rows=1")).leftovers?.scope, "plan-QRK-5");
  assert.throws(() => parseLedger(ledger("leftovers: the standing ticket | rows=4 | scope=plan-QRK-5")), /neither a ticket id/);
  assert.throws(() => parseLedger(ledger("leftovers: QRK-12 | scope=plan-QRK-5")), /needs a `rows=` field/);
  // A line written before `scope=` existed still reads, so a run in flight across the update can resume and ship.
  assert.deepEqual(parseLedger(ledger("leftovers: pr-body | rows=2")).leftovers, { to: "pr-body", rows: 2, scope: null });
  assert.deepEqual(parseLedger(ledger("leftovers: QRK-12 | rows=2")).leftovers, { to: "QRK-12", rows: 2, scope: null });
  for (const bad of ["QRK-5", "session-1a2b3c4", "session-1A2B3C4D", "session-1a2b3c4d5", "plan-", "plan-a/b"]) {
    assert.throws(() => parseLedger(ledger(`leftovers: QRK-12 | rows=2 | scope=${bad}`)), /scope=/, bad);
  }
});

// ── kept from the old parser ──────────────────────────────────────────────────────────────

test("kept: the class line's rules, the retired step grammar, prose and bullets", () => {
  assert.throws(() => parseLedger(""), /ledger is empty/);
  assert.throws(() => parseLedger("class: R3 — operator, 2026-09-28\nflow: 2\n"), /R3` is retired/);
  assert.throws(() => parseLedger("class: R1\nflow: 2\n"), /class line is not pinned/);
  assert.throws(() => parseLedger("class: R1 — operator, 2026-09-28 | measured-at=zzz\nflow: 2\n"), /measured-at=zzz is not a git sha/);
  assert.throws(() => parseLedger(ledger("Step 3: apply")), /retired \/close-out grammar/);
  const l = parseLedger(
    "class: R1 (agent, unconfirmed)\n- flow: 2\n\n## Notes\nSome prose without a colon.\n* banked: CURSORY.1, CODEX.2 (awaiting operator)\n"
  );
  assert.equal(l.pinned, false);
  assert.deepEqual(l.banked, ["CURSORY.1", "CODEX.2"]);
});

test("the one class form: `— agent (unconfirmed), <date>` is unconfirmed to the ledger and pinned to the brief", () => {
  const afk = "class: R1 — agent (unconfirmed), 2026-09-28";
  const l = parseLedger(`${afk}\nflow: 2\n`);
  assert.equal(l.cls, "R1");
  assert.equal(l.pinned, false);
  assert.equal(parseLedger("class: R1 — operator, 2026-09-28\nflow: 2\n").pinned, true);
  assert.match(afk, PINNED_CLASS_LINE_RE);
});

test("LEDGER_MOVES names every §1.8 move; stage reads map to their folders", () => {
  assert.equal(ledgerMoveOf("hand-test-12"), "hand-test-<n>");
  assert.equal(ledgerMoveOf("hand-test-0"), null);
  assert.equal(ledgerMoveOf("hand-test-block"), "hand-test-block");
  assert.equal(ledgerMoveOf("hand-test-<n>"), null);
  assert.equal(ledgerMoveOf("apply"), null);
  assert.equal(LEDGER_MOVES.length, 29);
  assert.equal(ledgerMoveOf("drift-merge"), "drift-merge");
  assert.deepEqual(READ_MOVE_FOLDER, {
    "confirm-1": "stage-confirm-1",
    "confirm-2": "stage-confirm-2",
    "last-read": "stage-last",
    "escalate-read": "stage-escalate",
    "drift-read": "stage-drift-<n>",
    "drift-confirm": "stage-drift-confirm-<n>",
    "unbank-read": "unbank",
  });
});

test("unbank: the answered ids, from= and sha=, and a fixer's model= and agent=; `banked:` ids drop their `(awaiting operator)`", () => {
  const l = parseLedger(
    ledger(
      "banked: CURSORY.3 (awaiting operator)",
      "banked: HAND.2, SESSION.1 (awaiting operator)",
      `unbank: CURSORY.3, HAND.2 | from=${A} | sha=${B} | model=opus | agent=u1`,
      `unbank-read: review-cursory | sha=${B}`
    )
  );
  assert.deepEqual(l.banked, ["CURSORY.3", "HAND.2", "SESSION.1"]);
  assert.deepEqual(l.unbank, { ids: ["CURSORY.3", "HAND.2"], from: A, sha: B, model: "opus", agents: ["u1"] });
  assert.deepEqual(l.unbankRead, { readers: [{ reader: "review-cursory", codexFailed: null }], sha: B, from: null, files: null });
  const bySession = parseLedger(ledger(`unbank: CURSORY.3 | from=${A} | sha=${B}`));
  assert.deepEqual(bySession.unbank, { ids: ["CURSORY.3"], from: A, sha: B, model: null, agents: [] });
  assert.equal(bySession.unbankRead, null);
});

test("answered: each line names one decision row the session answered and the SESSION block that carries the answer; lines add up", () => {
  const l = parseLedger(ledger("answered: CURSORY.3 | by=SESSION.2", "answered: HAND.1 | by=SESSION.4"));
  assert.deepEqual(l.answered, [
    { id: "CURSORY.3", by: "SESSION.2" },
    { id: "HAND.1", by: "SESSION.4" },
  ]);
  assert.deepEqual(parseLedger(ledger()).answered, []);
  assert.throws(() => parseLedger(ledger("answered: CURSORY.3")), /needs a `by=` field/);
  assert.throws(() => parseLedger(ledger("answered: CURSORY.3 | by=CODEX.1")), /by=CODEX\.1 — the answer is a `SESSION\.<n>` block/);
  assert.throws(() => parseLedger(ledger("answered: CURSORY.3, CODEX.1 | by=SESSION.2")), /is not a finding id/);
});

test("unbank: refusals — a non-id, a half-named fixer, a second line, and a read by anyone but review-cursory", () => {
  assert.throws(() => parseLedger(ledger(`unbank: CURSORY.3 (awaiting operator) | from=${A} | sha=${B}`)), /is not a finding id/);
  assert.throws(() => parseLedger(ledger(`unbank: CURSORY.3 | from=${A} | sha=${B} | model=opus`)), /both `model=` and `agent=`, or by neither/);
  assert.throws(() => parseLedger(ledger(`unbank: CURSORY.3 | sha=${B}`)), /needs a `from=` field/);
  const u = `unbank: CURSORY.3 | from=${A} | sha=${B}`;
  assert.throws(() => parseLedger(ledger(u, u)), /two `unbank:` lines/);
  assert.throws(() => parseLedger(ledger(`unbank-read: review-cursory-codex | sha=${B}`)), /reads with `review-cursory` only/);
  assert.throws(() => parseLedger(ledger(`unbank-read: review-cursory, security-review | sha=${B}`)), /reads with `review-cursory` only/);
});
