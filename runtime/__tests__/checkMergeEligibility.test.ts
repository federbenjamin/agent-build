/**
 * Self-tests for checkMergeEligibility.ts — the autonomous-merge gate-artifact reader.
 * A unit is merge-eligible only when its DURABLE gate-CLEAN PR comment is present, complete
 * (provenance + gated-sha), and bound to the PR's CURRENT head; orchestrator self-narration,
 * quoted/fenced markers, trailing-text headings, and stale-SHA markers are never gate signals.
 *
 * `main()` is not exported and shells out to `gh` — its argv-parsing PRELUDE (before any `gh`
 * call) is exercised by real spawn below; the rest of this suite drives the pure exports
 * in-process.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  GATE_CLEAN_MARKER,
  deriveRequiredChecks,
  hasGateCleanArtifact,
  mergeEligibility,
  parseAllowStaleShaFlag,
  parsePrComments,
  parsePrView,
  parseRequireFlag,
  resolveRequiredChecks,
} from "../checkMergeEligibility.ts";
import * as checkMergeEligibility from "../checkMergeEligibility.ts";
import { runGateClean } from "../emitMarker.ts";
import { FLOW_CHANGED } from "../lib/ledger.ts";
import { checkFlags } from "../shipGate.ts";
import {
  briefedHead,
  briefText,
  emptyRounds,
  EXIT_CHECKS,
  finalRound,
  round,
  row,
  type Run,
  withRun,
} from "./helpers/owedRun.ts";
import { TSX_BIN } from "./helpers/tsxBin.ts";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "checkMergeEligibility.ts");

const HEAD = "9c486f77908b054d9acf74d655e0a6695da1df89";

/** A fully valid artifact comment at the given sha (defaults to HEAD). */
const validArtifact = (sha: string = HEAD): string =>
  `${GATE_CLEAN_MARKER}\n\nsecurity disposition: no-match skip\ngated-sha: ${sha}\nprovenance: builder@abc1234/opus/high`;

test("parsePrView: extracts bodies and headRefOid", () => {
  const json = JSON.stringify({
    comments: [{ body: "first" }, { body: "second" }],
    headRefOid: HEAD,
  });
  assert.deepEqual(parsePrView(json), {
    bodies: ["first", "second"],
    headSha: HEAD,
  });
});

test("parsePrComments: extracts comment bodies from gh JSON", () => {
  const json = JSON.stringify({
    comments: [{ body: "first" }, { body: "second" }],
  });
  assert.deepEqual(parsePrComments(json), ["first", "second"]);
});

test("parsePrComments: missing comments key → empty array", () => {
  assert.deepEqual(parsePrComments(JSON.stringify({})), []);
});

test("parsePrComments: a comment with no body → empty string", () => {
  assert.deepEqual(parsePrComments(JSON.stringify({ comments: [{}, { body: "x" }] })), ["", "x"]);
});

test("valid artifact at head → eligible", () => {
  const v = mergeEligibility([validArtifact()], HEAD);
  assert.deepEqual(v, { eligible: true });
  assert.equal(hasGateCleanArtifact([validArtifact()], HEAD), true);
});

test("valid artifact with a short (≥7 char) gated-sha prefix → eligible", () => {
  const v = mergeEligibility([validArtifact(HEAD.slice(0, 12))], HEAD);
  assert.equal(v.eligible, true);
});

test("a too-short gated-sha prefix (<7 chars) → ineligible", () => {
  const v = mergeEligibility([validArtifact(HEAD.slice(0, 6))], HEAD);
  assert.equal(v.eligible, false);
});

test("marker as its own heading inside a larger valid comment → eligible", () => {
  const body = `build log…\n\n${validArtifact()}\n\ntrailing notes`;
  assert.equal(mergeEligibility([body], HEAD).eligible, true);
});

test("no marker anywhere → ineligible with the no-artifact reason", () => {
  const v = mergeEligibility(["LGTM", "verifier ran, all good"], HEAD);
  assert.equal(v.eligible, false);
  assert.equal(v.reasons.length, 1);
  assert.ok(v.reasons[0].includes(GATE_CLEAN_MARKER));
});

test("marker inlined mid-prose → ineligible (forge closed)", () => {
  const v = mergeEligibility(
    [`before I post ${GATE_CLEAN_MARKER} let me check\ngated-sha: ${HEAD}\nprovenance: x`],
    HEAD
  );
  assert.equal(v.eligible, false);
});

test("backtick-quoted marker → ineligible (forge closed)", () => {
  const v = mergeEligibility([`see the \`${GATE_CLEAN_MARKER}\` heading`], HEAD);
  assert.equal(v.eligible, false);
});

test("heading with TRAILING TEXT → ineligible (prefix forge closed)", () => {
  for (const forged of [
    `${GATE_CLEAN_MARKER} pending re-run`,
    `${GATE_CLEAN_MARKER}UP required — gate FAILED, do not merge`,
    `${GATE_CLEAN_MARKER} — RETRACTED, new commits pushed`,
  ]) {
    const v = mergeEligibility([`${forged}\ngated-sha: ${HEAD}\nprovenance: x`], HEAD);
    assert.equal(v.eligible, false, `should reject: ${forged}`);
  }
});

test("marker only inside a fenced code block → ineligible with the fence reason", () => {
  const body = `discussing the gate spec:\n\`\`\`\n${validArtifact()}\n\`\`\``;
  const v = mergeEligibility([body], HEAD);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes("fenced code block")));
});

test("marker missing its provenance: line → ineligible with the INCOMPLETE reason", () => {
  const body = `${GATE_CLEAN_MARKER}\ngated-sha: ${HEAD}`;
  const v = mergeEligibility([body], HEAD);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes("provenance")));
});

test("marker missing its gated-sha: line → ineligible with the unbound reason", () => {
  const body = `${GATE_CLEAN_MARKER}\nprovenance: builder@abc1234/opus/high`;
  const v = mergeEligibility([body], HEAD);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes("gated-sha")));
});

test("STALE marker (gated-sha ≠ current head) → ineligible with the stale reason", () => {
  const old = "1111111222222233333334444444555555566666";
  const v = mergeEligibility([validArtifact(old)], HEAD);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes("STALE")));
});

test("a stale marker followed by a fresh re-gate marker at head → eligible", () => {
  const old = "1111111222222233333334444444555555566666";
  const v = mergeEligibility([validArtifact(old), validArtifact()], HEAD);
  assert.equal(v.eligible, true);
});

// ── relaxed mode (`allowStaleSha`) — the operator-merge currency check, never the autonomous
// close-out path, which always stays strict (default options) ───────────────────────────────

test("relaxed mode: a well-formed required-check-PASS marker with a non-matching gated-sha → eligible", () => {
  const old = "1111111222222233333334444444555555566666";
  const body = `${validArtifact(old)}\nverifier: PASS`;
  const v = mergeEligibility([body], HEAD, ["verifier"], { allowStaleSha: true });
  assert.equal(v.eligible, true);
});

test("strict mode (default options): the SAME stale-but-otherwise-valid marker → ineligible", () => {
  const old = "1111111222222233333334444444555555566666";
  const body = `${validArtifact(old)}\nverifier: PASS`;
  const v = mergeEligibility([body], HEAD, ["verifier"]);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes("STALE")));
});

test("relaxed mode: a marker MISSING the gated-sha line → still ineligible (presence still required)", () => {
  const body = `${GATE_CLEAN_MARKER}\nprovenance: builder@abc1234/opus/high`;
  const v = mergeEligibility([body], HEAD, [], { allowStaleSha: true });
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes("gated-sha")));
});

test("relaxed mode: a missing required check → still ineligible (check requirement unaffected)", () => {
  const old = "1111111222222233333334444444555555566666";
  const v = mergeEligibility([validArtifact(old)], HEAD, ["verifier"], { allowStaleSha: true });
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes('"verifier"')));
});

test("empty comment list → ineligible", () => {
  assert.equal(hasGateCleanArtifact([], HEAD), false);
});

test("near-miss paraphrase (not the durable string) → ineligible", () => {
  // The run narrating "gate: CLEAN" in prose is NOT the durable artifact.
  const v = mergeEligibility(["the /close-out gate came back CLEAN"], HEAD);
  assert.equal(v.eligible, false);
});

// ── required-check verification (C1) ────────────────────────────────────────────────────────

test("required check PASS in the same comment as the artifact → eligible", () => {
  const body = `${validArtifact()}\nverifier: PASS`;
  const v = mergeEligibility([body], HEAD, parseRequireFlag(["--require", "verifier"]));
  assert.equal(v.eligible, true);
});

test("required check line absent → ineligible naming the check", () => {
  const v = mergeEligibility([validArtifact()], HEAD, ["verifier"]);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes('"verifier"')));
});

test("required check N/A → ineligible", () => {
  const body = `${validArtifact()}\nverifier: N/A`;
  const v = mergeEligibility([body], HEAD, ["verifier"]);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes('"verifier"') && r.includes("N/A")));
});

test("a check PASS line only inside a fenced block → ineligible (fence-stripped, so effectively missing)", () => {
  const body = `${validArtifact()}\n\`\`\`\nverifier: PASS\n\`\`\``;
  const v = mergeEligibility([body], HEAD, ["verifier"]);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes('"verifier"') && r.includes("no check line")));
});

test("check lines in a DIFFERENT comment than the marker → ineligible (same-comment locality)", () => {
  const v = mergeEligibility([validArtifact(), "verifier: PASS"], HEAD, ["verifier"]);
  assert.equal(v.eligible, false);
});

test("PASS+N/A conflict on the same check → ineligible (fails via the N/A rule)", () => {
  const body = `${validArtifact()}\nverifier: PASS\nverifier: N/A`;
  const v = mergeEligibility([body], HEAD, ["verifier"]);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes('"verifier"') && r.includes("N/A")));
});

test("artifact with no check lines + require [] → eligible (back-compat pin)", () => {
  const v = mergeEligibility([validArtifact()], HEAD, []);
  assert.equal(v.eligible, true);
  // Also confirm the 2-arg call (no requiredChecks at all) is unaffected.
  assert.equal(mergeEligibility([validArtifact()], HEAD).eligible, true);
});

test("stale first comment + a fresh re-gate comment carrying checks → eligible", () => {
  const old = "1111111222222233333334444444555555566666";
  const fresh = `${validArtifact()}\nverifier: PASS`;
  const v = mergeEligibility([validArtifact(old), fresh], HEAD, ["verifier"]);
  assert.equal(v.eligible, true);
});

test("--require verifier,hand-test with one missing → ineligible naming exactly the missing one", () => {
  const body = `${validArtifact()}\nverifier: PASS`;
  const v = mergeEligibility([body], HEAD, parseRequireFlag(["--require", "verifier,hand-test"]));
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes('"hand-test"')));
  assert.ok(!v.reasons.some((r) => r.includes('"verifier"')));
});

test("parseRequireFlag: parses a comma-separated check list", () => {
  assert.deepEqual(parseRequireFlag(["--require", "verifier,hand-test"]), [
    "verifier",
    "hand-test",
  ]);
});

test("parseRequireFlag: no --require flag → []", () => {
  assert.deepEqual(parseRequireFlag([]), []);
  assert.deepEqual(parseRequireFlag(["some", "other", "args"]), []);
});

test("parseRequireFlag: an unknown check throws", () => {
  assert.throws(() => parseRequireFlag(["--require", "bogus"]));
  assert.throws(() => parseRequireFlag(["--require", "verifier,bogus"]));
});

test("parseRequireFlag: an empty CSV throws", () => {
  assert.throws(() => parseRequireFlag(["--require", ""]));
  assert.throws(() => parseRequireFlag(["--require", " , , "]));
  assert.throws(() => parseRequireFlag(["--require"]));
});

test("parseAllowStaleShaFlag: present → true, absent → false", () => {
  assert.equal(parseAllowStaleShaFlag(["--allow-stale-sha"]), true);
  assert.equal(parseAllowStaleShaFlag(["--require", "verifier", "--allow-stale-sha"]), true);
  assert.equal(parseAllowStaleShaFlag([]), false);
  assert.equal(parseAllowStaleShaFlag(["--require", "verifier"]), false);
});

// ── ledger-derived marker checks ────────────────────────────────────────────────────────────

test("checkMergeEligibility no longer owns a class-only required-check rule", () => {
  assert.ok(!("requiredChecksForClass" in checkMergeEligibility));
});

// ── deriveRequiredChecks: self-derivation from the ship ledger's declared class ─────────────

function writeLedger(dir: string, body: string): string {
  const path = join(dir, "ship.md");
  writeFileSync(path, body, "utf8");
  return path;
}

const PINNED = "e".repeat(40);
const ledgerBody = (cls: string, wave: string, extra = "") =>
  `class: ${cls} — operator, 2026-08-29 | measured-at=${PINNED}\nwave: ${wave}\n${extra}`;

/** A run dir and repo the gate would pass: rounds per `rows`, a verifier, and one hand-test line. */
function passingRun(run: Run, opts: { cls: string; rows: boolean; claims: boolean }): string {
  const s1 = opts.rows ? run.commit({ "src/app.ts": "export const a = 3;\n" }, "fix(close): round 1") : run.wave;
  run.table(
    opts.rows
      ? { "1": round(run.wave, [row("CURSORY.1", "behavior")]), "2": round(s1), "3": round(s1), escalate: round(s1), final: finalRound(s1) }
      : emptyRounds(run.wave)
  );
  run.write("build-verifier.md", "VERDICT: CLEAN\n");
  if (opts.rows) {
    run.write("fix-1.txt", `CURSORY.1 · fixed · ${s1} — a is 3\n${EXIT_CHECKS}\n`);
    run.write("stage-confirm-1/review-cursory-codex.md", "## Status\n- CURSORY.1 · resolved\n\n## New\nNO FINDINGS\n");
  }
  if (opts.claims) run.write("hand-test-1.txt", `H1 · pass · ${s1} — hand-test-1/H1.out\n`);
  const readers = opts.cls === "R0" ? "review-cursory, build-verifier" : "review-cursory, gate-silent-failure-hunter, build-verifier";
  run.ledger([
    ...briefedHead(opts.cls, run.wave).map((l) => (l.startsWith("wave:") ? `wave: ${readers} | sha=${run.wave}` : l)),
    `verifier: CLEAN | sha=${run.wave}`,
    ...(opts.rows
      ? [`fix-1: 1/1 | model=sonnet | agent=f1 | from=${run.wave} | sha=${s1}`, `confirm-1: review-cursory-codex | sha=${s1}`]
      : []),
    opts.claims ? `hand-test-1: 1/1 | sha=${s1}` : "hand-test-1: skipped — no claims",
    `ship: x | sha=${s1}`,
  ]);
  return join(run.runDir, "ship.md");
}

const NO_CLAIMS = { brief: briefText({ claims: "none — the diff changes only a doc" }) };
const derive = (run: Run, ledger: string) => deriveRequiredChecks(ledger, { cwd: run.repo, deps: { hunterMinLines: 20 } });

test("deriveRequiredChecks: the owed checks come from the run, not the class", async () => {
  await withRun(async (run) => {
    assert.deepEqual(await derive(run, passingRun(run, { cls: "R0", rows: true, claims: true })), [
      "freshen",
      "wave",
      "fix",
      "confirm",
      "hand-test",
      "verifier",
    ]);
  }, { brief: briefText({ cls: "R0" }) });
  await withRun(async (run) => {
    assert.deepEqual(await derive(run, passingRun(run, { cls: "R2", rows: false, claims: false })), ["freshen", "wave", "verifier"]);
  }, { brief: briefText({ claims: "none — the diff changes only a doc", cls: "R2" }) });
});

test("CURSORY.10: deriveRequiredChecks fails closed when the brief cannot be read", async () => {
  await withRun(
    async (run) => {
      await assert.rejects(
        () => derive(run, passingRun(run, { cls: "R1", rows: false, claims: false })),
        /^Error: --ledger: brief: docs\/briefs\/quick-x\.md is not tracked at HEAD/
      );
    },
    { brief: null }
  );
});

test("deriveRequiredChecks: only a from-branch ledger line drops the verifier", async () => {
  const block = "docs/briefs/quick-x-hand-test.md";
  await withRun(
    async (run) => {
      run.table(emptyRounds(run.wave));
      const lines = [
        "class: R1 — operator, 2026-09-28",
        "flow: 2",
        "from-branch: quick/x",
        `hand-test-block: ${block}`,
        `freshen: merged | base=main | sha=${run.wave}`,
      ];
      run.ledger(lines);
      assert.deepEqual(await derive(run, join(run.runDir, "ship.md")), ["freshen", "wave"]);
      run.ledger([...lines.filter((l) => !l.startsWith("from-branch:") && !l.startsWith("hand-test-block:")), "verifier: N/A (from-branch, no brief)"]);
      assert.deepEqual(await derive(run, join(run.runDir, "ship.md")), ["freshen", "wave", "verifier"]);
    },
    { brief: "class: R1 — operator, 2026-09-28\n\n## Hand test\n\nnone — a refactor with no surface\n", briefPath: block }
  );
});

test("deriveRequiredChecks: throws on an unreadable ledger path", async () => {
  await assert.rejects(() => deriveRequiredChecks("/definitely/not/a/real/ship.md"), /unreadable/);
});

test("deriveRequiredChecks: a retired /close-out ledger or an old-flow ledger throws — never silently defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "check-merge-eligibility-"));
  try {
    const path = writeLedger(dir, `started: 2026-08-19T10:00:00Z\nstep 2: clean | sha=deadbee\n`);
    await assert.rejects(() => deriveRequiredChecks(path), /retired \/close-out grammar/);
    const noClass = writeLedger(dir, `freshen: abc1234 | sha=abc1234\n`);
    await assert.rejects(() => deriveRequiredChecks(noClass), /first line must be `class:/);
    const oldFlow = writeLedger(dir, ledgerBody("R1", "review-cursory"));
    await assert.rejects(() => deriveRequiredChecks(oldFlow), (e: Error) => e.message === FLOW_CHANGED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveRequiredChecks: --ledger self-derivation, --require override, mutual exclusion ──

test("resolveRequiredChecks: --ledger self-derives from the run", async () => {
  await withRun(async (run) => {
    const path = passingRun(run, { cls: "R1", rows: false, claims: true });
    assert.deepEqual(await resolveRequiredChecks(["--ledger", path], { cwd: run.repo, deps: { hunterMinLines: 20 } }), [
      "freshen",
      "wave",
      "hand-test",
      "verifier",
    ]);
  });
});

test("resolveRequiredChecks: falls back to --require when no --ledger flag given", async () => {
  assert.deepEqual(await resolveRequiredChecks(["--require", "verifier,hand-test"]), ["verifier", "hand-test"]);
});

test("resolveRequiredChecks: no flags at all → []", async () => {
  assert.deepEqual(await resolveRequiredChecks([]), []);
});

test("resolveRequiredChecks: --ledger requires a path value", async () => {
  await assert.rejects(() => resolveRequiredChecks(["--ledger"]), /--ledger requires a path value/);
  await assert.rejects(() => resolveRequiredChecks(["--ledger", "--require"]), /--ledger requires a path value/);
});

test("resolveRequiredChecks: --require + --ledger together throws (mutually exclusive)", async () => {
  await assert.rejects(() => resolveRequiredChecks(["--ledger", "/x/ship.md", "--require", "verifier"]), /mutually exclusive/);
});

test("resolveRequiredChecks: --allow-stale-sha + --ledger together throws (autonomous path always strict)", async () => {
  await assert.rejects(
    () => resolveRequiredChecks(["--ledger", "/x/ship.md", "--allow-stale-sha"]),
    /--allow-stale-sha is invalid with --ledger/
  );
});

test("resolveRequiredChecks: --allow-stale-sha alone (no --ledger) is untouched by the new guard", async () => {
  assert.deepEqual(await resolveRequiredChecks(["--require", "verifier", "--allow-stale-sha"]), ["verifier"]);
});

// ── G4 test 6: the merge check over the marker the gate's --print-checks makes ───────────────

/** The marker the SHIP step posts: `--print-checks` flags fed to `emitMarker gate-clean`. */
function marker(flags: string): string {
  return runGateClean(["--sha", HEAD, "--provenance", "builder@abc1234/opus/high", "--class", "R1", "--security", "no match", ...flags.split(" ")]);
}

test("6. merge check: the R1 skip marker passes; an R0 run with a claim and hand-test: N/A fails; a full run passes", async () => {
  await withRun(async (run) => {
    const required = await derive(run, passingRun(run, { cls: "R1", rows: false, claims: false }));
    const skip = marker(checkFlags(required));
    assert.match(skip, /^hand-test: N\/A$/m);
    assert.deepEqual(mergeEligibility([skip], HEAD, required), { eligible: true });
  }, NO_CLAIMS);
  await withRun(async (run) => {
    const required = await derive(run, passingRun(run, { cls: "R0", rows: false, claims: true }));
    assert.ok(required.includes("hand-test"), "a claim owes the hand test at R0 too");
    const naHandTest = marker("--check freshen=PASS --check wave=PASS --check hand-test=N/A --check verifier=PASS");
    const verdict = mergeEligibility([naHandTest], HEAD, required);
    assert.equal(verdict.eligible, false);
    assert.ok(verdict.eligible === false && verdict.reasons.includes('required check "hand-test" is N/A — required to PASS before merge'));
  }, { brief: briefText({ cls: "R0" }) });
  await withRun(async (run) => {
    const required = await derive(run, passingRun(run, { cls: "R1", rows: true, claims: true }));
    assert.deepEqual(required, ["freshen", "wave", "fix", "confirm", "hand-test", "verifier"]);
    assert.deepEqual(mergeEligibility([marker(checkFlags(required))], HEAD, required), { eligible: true });
  });
});

// ── process-boundary smoke: main()'s argv-parsing prelude, before any `gh` call ─────────────
// `main()` isn't exported and shells out to `gh pr view`, so it can only be exercised through a
// real spawn — these two cases stay entirely inside the pre-`gh` prelude (usage error, and the
// mutually-exclusive-flags throw from resolveRequiredChecks), so no network/gh dependency.

test("spawn: no PR number → usage message on stderr, exit 1", () => {
  const r = spawnSmoke(TSX_BIN, [SCRIPT], { cwd: ROOT });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: node ~\/\.agent-build\/runtime\/checkMergeEligibility\.ts/);
});

test("spawn: --ledger + --require together exits 1 before any `gh` call", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-merge-eligibility-spawn-"));
  try {
    const path = writeLedger(dir, ledgerBody("R1", "review-cursory"));
    const r = spawnSmoke(TSX_BIN, [SCRIPT, "123", "--ledger", path, "--require", "verifier"], {
      cwd: ROOT,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutually exclusive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
