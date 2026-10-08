/**
 * emitMarker — prints a complete, structurally-valid durable PR-marker comment body to stdout.
 * NEVER posts (`gh pr comment`) — the caller redirects to a file, then posts that file ONLY on
 * exit 0. Never pipe into `gh pr comment`: a pipeline's exit status is the LAST command's, so a
 * refusal here (exit 1, empty body) would still post.
 *
 *   node ~/.agent-build/runtime/emitMarker.ts gate-clean --provenance "<tok>" --sha <head> \
 *     --class R<n> --security-return <file> <the --check flags `shipGate.ts --print-checks` prints> \
 *     > <path> && gh pr comment <n> --body-file <path>   # only on exit 0
 * Refusal matrix (exit 1, naming the field): missing `--provenance`, `--sha`, `--class`, or
 * `--security`; a flag with no value; a `--provenance` with no `builder@…` token; an unrecognized
 * `--check` name or value; the old flow's `--check apply=` or `explain=` (the flow-changed message).
 * The body builder lives in `lib/gateMarkers.ts`; writer and parser are one module, so
 * output round-trips through `checkMergeEligibility`.
 */

import { readFileSync } from "node:fs";

import { takeValue, takeValues } from "./lib/cliArgs.ts";
import {
  buildGateCleanBody,
  MARKER_CHECK_NAMES,
  type MarkerCheckName,
  type MarkerCheckValue,
  RETIRED_CHECK_NAMES,
} from "./lib/gateMarkers.ts";
import { isMain } from "./lib/isMain.ts";
import { FLOW_CHANGED } from "./lib/ledger.ts";
import { isRiskClass } from "./lib/riskClass.ts";
import { parseFindingBlock } from "./lib/runFiles.ts";

// A provenance carries a builder token: the canonical short form `builder@f00ba12/sonnet/high`
// (`fixer@f00ba12/sonnet/high` is NOT one — the token records the ROLE). `\b` accepts it with
// or without a spawn-type prefix (`x-builder@…`) while still refusing a provenance with no builder
// token at all.
//
// A chunk the interactive SESSION built writes `builder@session/<model>/<effort>` — an honest
// token, not a workaround: a session has no agent-definition sha to name.
const BUILDER_TOKEN_RE = /\bbuilder@/;

/** True iff `provenance` carries at least one `builder@…` token (any position, `·`-separated). */
export function hasBuilderToken(provenance: string): boolean {
  return BUILDER_TOKEN_RE.test(provenance);
}

/** Parse one `--check` raw value (`<name>=<value>`) into a validated pair, or throw. */
export function parseCheckFlag(raw: string | undefined): {
  name: MarkerCheckName;
  value: MarkerCheckValue;
} {
  if (raw === undefined || !raw.includes("=")) {
    throw new Error(
      `--check requires a "<name>=<value>" argument (got ${JSON.stringify(raw ?? null)}) — expected one of: ${MARKER_CHECK_NAMES.map((n) => `${n}=PASS`).join(", ")}`
    );
  }
  const eq = raw.indexOf("=");
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if ((RETIRED_CHECK_NAMES as readonly string[]).includes(name)) {
    throw new Error(`--check ${name}= is the old flow's check — ${FLOW_CHANGED}`);
  }
  if (!(MARKER_CHECK_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `--check: unknown check name "${name}" (expected one of: ${MARKER_CHECK_NAMES.join(", ")})`
    );
  }
  if (value !== "PASS" && value !== "N/A") {
    throw new Error(`--check ${name}=${value}: value must be PASS or N/A`);
  }
  return { name: name as MarkerCheckName, value: value as MarkerCheckValue };
}

interface DispositionsFile {
  security?: string;
}

/** The gate-CLEAN marker is the ONLY trust signal for the entire draft window (no CI runs on a
 * draft), and its `security:` line is what a later reader takes as "security-review cleared
 * this" — hand-typed, that line is bound to nothing. So bind it: `--security-return <path>`
 * derives the verdict from the reader's RAW persisted findings, in the one block shape
 * `parseFindingBlock` counts by. A shapeless return is a refusal, not a clean read — the caller
 * may still append its own narrative, but it can't invent the verdict. */
export function deriveSecurityVerdict(content: string): string {
  const count = parseFindingBlock(content).length;
  if (count === 0 && !/^NO FINDINGS\b/m.test(content)) {
    throw new Error(
      "--security-return: no `### SEC.<n>` blocks and no NO FINDINGS line — the security-review return drifted from the block format"
    );
  }
  return count === 0 ? "security-review: 0 findings" : `security-review: ${count} finding(s)`;
}

/** Resolve the provenance line from CLI argv. */
export function resolveProvenanceFlag(argv: string[], cmd: string): string {
  const direct = takeValue(argv, "--provenance").value;
  if (!direct) throw new Error(`${cmd} requires --provenance "<token · token>"`);
  return direct;
}

/** `emitMarker gate-clean …` — see the refusal matrix in the module docstring. */
export function runGateClean(argv: string[]): string {
  const sha = takeValue(argv, "--sha").value;
  if (!sha) throw new Error('gate-clean requires --sha "<full-sha>"');
  const provenance = resolveProvenanceFlag(argv, "gate-clean");
  if (!hasBuilderToken(provenance)) {
    throw new Error(
      'gate-clean --provenance carries no builder token — expected a "builder@<sha>/<model>/<effort>" entry, or "builder@session/<model>/<effort>" when this session built the chunk itself'
    );
  }
  if (argv.includes("--rung")) {
    throw new Error(
      "--rung is retired (2026-08-29) — pass --class R<n>, the operator's declared class"
    );
  }
  const cls = takeValue(argv, "--class").value;
  if (!cls || !isRiskClass(cls)) {
    throw new Error(
      `gate-clean requires --class R0|R1|R2 (got ${JSON.stringify(cls ?? null)}) — the class is what makes an N/A check line legible rather than a silent gap`
    );
  }

  let security = takeValue(argv, "--security").value;
  const dispositionsFile = takeValue(argv, "--dispositions-file").value;
  if (dispositionsFile) {
    const parsed = JSON.parse(readFileSync(dispositionsFile, "utf8")) as DispositionsFile;
    security = security ?? parsed.security;
  }
  // The lens's own findings file, when supplied, OUTRANKS the hand-typed string: the verdict
  // is derived, and any narrative the caller typed is kept only as a suffix.
  const securityReturn = takeValue(argv, "--security-return").value;
  if (securityReturn) {
    const verdict = deriveSecurityVerdict(readFileSync(securityReturn, "utf8"));
    security = security ? `${verdict} — ${security}` : verdict;
  }
  if (!security) {
    throw new Error(
      'gate-clean requires --security "<disposition>" (or a security field in --dispositions-file, or --security-return <security-review findings file>)'
    );
  }

  const checks: Partial<Record<MarkerCheckName, MarkerCheckValue>> = {};
  for (const raw of takeValues(argv, "--check").values) {
    const { name, value } = parseCheckFlag(raw);
    checks[name] = value;
  }

  return buildGateCleanBody({ sha, provenance, cls, security, checks });
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd !== "gate-clean") {
      throw new Error(`unknown subcommand "${cmd ?? ""}" — expected: gate-clean`);
    }
    const body = runGateClean(rest);
    process.stdout.write(`${body}\n`);
  } catch (err) {
    console.error(`emitMarker: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main();
}
