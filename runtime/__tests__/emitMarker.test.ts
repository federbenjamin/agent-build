/**
 * Self-tests for emitMarker.ts — the durable-marker body emitter for `/build`'s SHIP
 * step. The point is the ROUND-TRIP: every emitted body must parse back through
 * lib/gateMarkers.ts's own parsers (`parseCheckLines`) and through
 * `checkMergeEligibility`'s `mergeEligibility`, and the refusal matrix must fire on every
 * documented missing/invalid field — including the new `--class R<n>` requirement that
 * replaces `--rung` (pipeline-a §U6: the `rung:` line is gone from the body, `--rung` is now an
 * unknown flag).
 *
 * `main()` itself is not exported (unlike the `main(argv, exit)` shape some other gate scripts
 * use) — it reads `process.argv` and calls `process.exit` directly, so the subcommand check
 * (including the "unknown subcommand" refusal) can only be exercised through a real subprocess.
 * The pure runner `runGateClean` covers everything else in-process.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  deriveSecurityVerdict,
  hasBuilderToken,
  parseCheckFlag,
  resolveProvenanceFlag,
  runGateClean,
} from "../emitMarker.ts";
import { mergeEligibility } from "../checkMergeEligibility.ts";
import { GATE_CLEAN_MARKER, MARKER_CHECK_NAMES, parseCheckLines } from "../lib/gateMarkers.ts";
import { FLOW_CHANGED } from "../lib/ledger.ts";
import { TSX_BIN } from "./helpers/tsxBin.ts";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "emitMarker.ts");

const FULL_SHA = "a".repeat(40);
const PROVENANCE = "builder@f00ba12/sonnet/high · verifier@a1b2c3d/opus/high";
const CLASS = "R2";

// ── parseCheckFlag / hasBuilderToken ───────────────────────────────────────────────────────

test("parseCheckFlag: accepts every declared check name (freshen/wave/fix/confirm/hand-test/verifier) with PASS or N/A", () => {
  assert.deepEqual([...MARKER_CHECK_NAMES], ["freshen", "wave", "fix", "confirm", "hand-test", "verifier"]);
  for (const name of MARKER_CHECK_NAMES) {
    assert.deepEqual(parseCheckFlag(`${name}=PASS`), { name, value: "PASS" });
    assert.deepEqual(parseCheckFlag(`${name}=N/A`), { name, value: "N/A" });
  }
});

test("parseCheckFlag: the old flow's apply= and explain= refuse with the flow-changed message", () => {
  for (const raw of ["apply=PASS", "explain=N/A"]) {
    assert.throws(
      () => parseCheckFlag(raw),
      (err: unknown) => {
        assert.equal((err as Error).message, `--check ${raw.split("=")[0]}= is the old flow's check — ${FLOW_CHANGED}`);
        return true;
      },
      raw
    );
  }
});

test("parseCheckFlag: rejects a value outside PASS|N/A", () => {
  assert.throws(() => parseCheckFlag("verifier=FAIL"), /must be PASS or N\/A/);
});

test("parseCheckFlag: rejects an unknown check name — including the retired diff-review/ui-smoke names", () => {
  assert.throws(() => parseCheckFlag("bogus=PASS"), /unknown check name/);
  assert.throws(() => parseCheckFlag("ui-smoke=PASS"), /unknown check name/);
  assert.throws(() => parseCheckFlag("diff-review=PASS"), /unknown check name/);
});

test("parseCheckFlag: rejects a malformed (no '=') raw value", () => {
  assert.throws(() => parseCheckFlag("verifier"), /requires a/);
  assert.throws(() => parseCheckFlag(undefined), /requires a/);
});

test("hasBuilderToken: true for a builder@ token anywhere in the provenance string", () => {
  assert.equal(hasBuilderToken("builder@f00ba12/sonnet/high"), true);
  assert.equal(hasBuilderToken("verifier@abc/opus/high · builder@def/sonnet/high"), true);
});

test("hasBuilderToken: true for the spawn-type-prefixed form (little-man-builder@) — role token, not exact literal", () => {
  assert.equal(hasBuilderToken("little-man-builder@54403ff1/opus/high"), true);
});

test("hasBuilderToken: false with no builder@ token", () => {
  assert.equal(hasBuilderToken("verifier@abc/opus/high · sf-hunter@def/opus/high"), false);
  assert.equal(hasBuilderToken(""), false);
});

test("hasBuilderToken: true for the session form (builder@session/<model>/<effort>) — a session has no agent-definition sha to name (F10)", () => {
  assert.equal(hasBuilderToken("builder@session/opus-5/high"), true);
});

test("gate-clean refusal: the no-builder-token message names the session form as a legal shape, not just the sha form (F10)", () => {
  assert.throws(
    () =>
      runGateClean([
        "--sha",
        FULL_SHA,
        "--provenance",
        "verifier@abc/opus/high",
        "--class",
        CLASS,
        "--security",
        "x",
      ]),
    /builder@session\/<model>\/<effort>/
  );
});

// ── resolveProvenanceFlag: the flag simplified down to plain --provenance ──────────────────

test("resolveProvenanceFlag: returns the --provenance value", () => {
  assert.equal(resolveProvenanceFlag(["--provenance", PROVENANCE], "gate-clean"), PROVENANCE);
});

test("resolveProvenanceFlag: refuses when --provenance is absent", () => {
  assert.throws(() => resolveProvenanceFlag([], "gate-clean"), /requires --provenance/);
});

// ── gate-clean: round-trip + refusal matrix ─────────────────────────────────────────────────

test("gate-clean: round-trips through mergeEligibility (eligible, matching head SHA)", () => {
  const body = runGateClean([
    "--sha",
    FULL_SHA,
    "--provenance",
    PROVENANCE,
    "--class",
    CLASS,
    "--security",
    "security-review: no match — no auth/migration/RLS/O1/Storage touch",
  ]);
  assert.ok(body.startsWith(GATE_CLEAN_MARKER));
  assert.ok(body.includes(`class: ${CLASS}`));
  const verdict = mergeEligibility([body], FULL_SHA);
  assert.deepEqual(verdict, { eligible: true });
});

test("gate-clean: --check lines round-trip through parseCheckLines and satisfy mergeEligibility's required-check check", () => {
  const body = runGateClean([
    "--sha",
    FULL_SHA,
    "--provenance",
    PROVENANCE,
    "--class",
    CLASS,
    "--security",
    "no match",
    "--check",
    "verifier=PASS",
    "--check",
    "hand-test=N/A",
    "--check",
    "wave=PASS",
  ]);
  const checks = parseCheckLines(body);
  assert.deepEqual(checks.verifier, ["PASS"]);
  assert.deepEqual(checks["hand-test"], ["N/A"]);
  assert.deepEqual(checks.wave, ["PASS"]);
  assert.deepEqual(checks.freshen, []); // never supplied
  const verdict = mergeEligibility([body], FULL_SHA, ["verifier"]);
  assert.deepEqual(verdict, { eligible: true });
  const failed = mergeEligibility([body], FULL_SHA, ["hand-test"]);
  assert.equal(failed.eligible, false);
});

test("gate-clean: --dispositions-file supplies security when --security is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "emit-marker-"));
  try {
    const file = join(dir, "dispositions.json");
    writeFileSync(file, JSON.stringify({ security: "from-file security" }));
    const body = runGateClean([
      "--sha",
      FULL_SHA,
      "--provenance",
      PROVENANCE,
      "--class",
      CLASS,
      "--dispositions-file",
      file,
    ]);
    assert.ok(body.includes("security: from-file security"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate-clean refusal: missing --sha", () => {
  assert.throws(
    () => runGateClean(["--provenance", PROVENANCE, "--class", CLASS, "--security", "x"]),
    /--sha/
  );
});

test("gate-clean refusal: missing --provenance", () => {
  assert.throws(
    () => runGateClean(["--sha", FULL_SHA, "--class", CLASS, "--security", "x"]),
    /--provenance/
  );
});

test("gate-clean refusal: --provenance with no builder token", () => {
  assert.throws(
    () =>
      runGateClean([
        "--sha",
        FULL_SHA,
        "--provenance",
        "verifier@abc/opus/high",
        "--class",
        CLASS,
        "--security",
        "x",
      ]),
    /no builder token/
  );
});

test("gate-clean refusal: missing --class", () => {
  assert.throws(
    () => runGateClean(["--sha", FULL_SHA, "--provenance", PROVENANCE, "--security", "x"]),
    /--class/
  );
});

test("gate-clean refusal: a --class value outside R0-R2", () => {
  assert.throws(
    () =>
      runGateClean([
        "--sha",
        FULL_SHA,
        "--provenance",
        PROVENANCE,
        "--class",
        "R9",
        "--security",
        "x",
      ]),
    /--class/
  );
});

test("gate-clean refusal: --rung is retired — refuses naming --class as the replacement", () => {
  assert.throws(
    () =>
      runGateClean([
        "--sha",
        FULL_SHA,
        "--provenance",
        PROVENANCE,
        "--rung",
        "M · 42 counted lines",
        "--security",
        "x",
      ]),
    (err: unknown) => {
      assert.equal(
        (err as Error).message,
        "--rung is retired (2026-08-29) \u2014 pass --class R<n>, the operator's declared class"
      );
      return true;
    }
  );
});

test("gate-clean refusal: missing --security", () => {
  assert.throws(
    () => runGateClean(["--sha", FULL_SHA, "--provenance", PROVENANCE, "--class", CLASS]),
    /--security/
  );
});

test("gate-clean refusal: a --check value outside PASS|N/A", () => {
  assert.throws(
    () =>
      runGateClean([
        "--sha",
        FULL_SHA,
        "--provenance",
        PROVENANCE,
        "--class",
        CLASS,
        "--security",
        "x",
        "--check",
        "verifier=MAYBE",
      ]),
    /must be PASS or N\/A/
  );
});

test("gate-clean refusal: a --check naming an unknown check", () => {
  assert.throws(
    () =>
      runGateClean([
        "--sha",
        FULL_SHA,
        "--provenance",
        PROVENANCE,
        "--class",
        CLASS,
        "--security",
        "x",
        "--check",
        "bogus=PASS",
      ]),
    /unknown check name/
  );
});

// ── gate-clean: the security disposition is DERIVED from the security-review lens's findings
// file, not typed ─────────────────────────────────────────────────────────────────────────────

/** A `### SEC.<n> — title` block in the shape parseFindingBlock (`lib/runFiles.ts`) requires; the
 *  old tier fields ride along, as a reader that still writes them does. */
function secBlock(n: number): string {
  return [
    `### SEC.${n} — a security finding`,
    "- locator: apps/supabase/functions/x/index.ts:1",
    "- kind: security",
    "- surface: R2",
    "- fires: main-path",
    "- ease: ordinary",
    "- tier: BLOCK",
    "- finding: something is wrong",
    "- fix: do this instead",
  ].join("\n");
}

/** `n` blocks (n=0 → the NO FINDINGS declaration instead). */
const LENS_RETURN = (n: number) =>
  n === 0 ? "NO FINDINGS\n" : Array.from({ length: n }, (_, i) => secBlock(i + 1)).join("\n\n");

test("deriveSecurityVerdict: a NO FINDINGS return → 0 findings verdict", () => {
  assert.equal(deriveSecurityVerdict(LENS_RETURN(0)), "security-review: 0 findings");
});

test("deriveSecurityVerdict: SEC.<n> blocks are counted", () => {
  assert.equal(deriveSecurityVerdict(LENS_RETURN(2)), "security-review: 2 finding(s)");
});

test("deriveSecurityVerdict: zero blocks with no NO FINDINGS line REFUSES rather than reading as clean", () => {
  assert.throws(
    () => deriveSecurityVerdict("the reader rambled and never declared a verdict"),
    /no `### SEC\.<n>` blocks and no NO FINDINGS line — the security-review return drifted from the block format/
  );
});

test("deriveSecurityVerdict: a block missing a required field REFUSES, naming the block id and field", () => {
  const dropKind = secBlock(1)
    .split("\n")
    .filter((l) => !l.startsWith("- kind:"))
    .join("\n");
  assert.throws(() => deriveSecurityVerdict(dropKind), /finding SEC\.1: missing `kind`/);
});

test("runGateClean: --security-return derives the verdict and outranks a typed claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "emit-marker-"));
  try {
    const ret = join(dir, "agent-1-security-review.md");
    writeFileSync(ret, LENS_RETURN(1));
    const body = runGateClean([
      "--sha",
      FULL_SHA,
      "--provenance",
      PROVENANCE,
      "--class",
      CLASS,
      // The orchestrator claims clean; the lens's findings file says otherwise. The file wins.
      "--security",
      "all clear",
      "--security-return",
      ret,
    ]);
    assert.match(body, /security-review: 1 finding\(s\) — all clear/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGateClean: --security-return alone satisfies the security requirement", () => {
  const dir = mkdtempSync(join(tmpdir(), "emit-marker-"));
  try {
    const ret = join(dir, "agent-1-security-review.md");
    writeFileSync(ret, LENS_RETURN(0));
    const body = runGateClean([
      "--sha",
      FULL_SHA,
      "--provenance",
      PROVENANCE,
      "--class",
      CLASS,
      "--security-return",
      ret,
    ]);
    assert.match(body, /security-review: 0 findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── process-boundary smoke: main()'s own switch is unreachable from imported functions ─────
// `main()` isn't exported, so only a real spawn exercises the module-bottom auto-run guard,
// argv routing, and the "unknown subcommand" default case.

test("spawn: gate-clean subcommand exits 0 and prints the marker body to stdout", () => {
  const r = spawnSmoke(
    TSX_BIN,
    [
      SCRIPT,
      "gate-clean",
      "--sha",
      FULL_SHA,
      "--provenance",
      PROVENANCE,
      "--class",
      CLASS,
      "--security",
      "no match",
    ],
    { cwd: ROOT }
  );
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.startsWith(GATE_CLEAN_MARKER));
});

test("spawn: an unrecognized subcommand exits 1 naming the valid set; the diff-review subcommands are gone", () => {
  for (const cmd of ["bogus-subcommand", "diff-review", "diff-review-fix"]) {
    const r = spawnSmoke(TSX_BIN, [SCRIPT, cmd], { cwd: ROOT });
    assert.equal(r.status, 1, cmd);
    assert.match(r.stderr, new RegExp(`unknown subcommand "${cmd}" — expected: gate-clean`));
  }
});

test("spawn: gate-clean with --check apply=PASS exits 1 with the flow-changed message", () => {
  const r = spawnSmoke(
    TSX_BIN,
    [SCRIPT, "gate-clean", "--sha", FULL_SHA, "--provenance", PROVENANCE, "--class", CLASS, "--security", "x", "--check", "apply=PASS"],
    { cwd: ROOT }
  );
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(FLOW_CHANGED), r.stderr);
  assert.equal(r.stdout, "");
});

test("spawn: gate-clean without --class exits 1 through the real process boundary", () => {
  const r = spawnSmoke(
    TSX_BIN,
    [SCRIPT, "gate-clean", "--sha", FULL_SHA, "--provenance", PROVENANCE, "--security", "x"],
    { cwd: ROOT }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--class/);
});
