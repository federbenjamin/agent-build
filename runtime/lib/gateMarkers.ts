/**
 * Shared, pure primitives for the durable PR-marker artifacts `/build` SHIP posts, and for the
 * per-check PASS/N-A lines a gate-CLEAN comment carries alongside them. No fs/process — this
 * module is imported by `emitMarker.ts` (the writer), `checkMergeEligibility.ts`
 * (the reader), and their self-tests, so writer and parser can never drift.
 *
 * A **check line** is a `<name>: PASS|N/A` line inside the gate-CLEAN comment, recording one
 * CLOSE move's outcome. The run's risk class rides its own `class:` line.
 */

import type { RiskClass } from "./riskClass.ts";

/** The durable marker SHIP posts as a PR comment when the ship gate clears. */
export const GATE_CLEAN_MARKER = "## ship gate: CLEAN";

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A marker must be a WHOLE line — start-anchored (how the gate posts it: a bare H2) AND
 * end-anchored (`[ \t]*$`) — so both a mid-prose/quoted forge and a trailing-text forge
 * ("## ship gate: CLEANUP notes", "…CLEAN — RETRACTED") are rejected.
 * `m` makes `^`/`$` match per line within a comment body.
 */
export function wholeLineHeadingRe(marker: string): RegExp {
  return new RegExp(`^${escapeRegExp(marker)}[ \t]*$`, "m");
}

/** The `provenance:` companion line a gate-CLEAN artifact must carry in the same comment body. */
export const PROVENANCE_LINE_RE = /^provenance:/m;
/** The `gated-sha:` companion line a gate-CLEAN artifact must carry in the same comment body. */
export const GATED_SHA_LINE_RE = /^gated-sha:[ \t]*([0-9a-f]{7,40})[ \t]*$/im;

// Minimum length for a short-SHA prefix match. 7 is git's default abbreviation floor; anything
// shorter is too forgeable/collidable to bind an autonomous merge to.
export const MIN_SHA_PREFIX = 7;

/**
 * Remove fenced code blocks (``` or ~~~, any info string) from a markdown body, so a marker
 * QUOTED inside a fence can never read as a real artifact. An unclosed fence strips to the end
 * of the body (fail-closed: quoted content never leaks back into matching).
 */
export function stripFencedBlocks(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (open) {
        fence = open[1]![0]!; // fence char: ` or ~
        continue;
      }
      kept.push(line);
    } else if (open && open[1]![0]! === fence) {
      fence = null; // closing fence line — dropped
    }
    // lines inside a fence are dropped
  }
  return kept.join("\n");
}

/**
 * The named CHECK LINES a gate-CLEAN comment can record as PASS/N-A, one per CLOSE move. The
 * required subset is derived per run (`owed.ts` `markerChecksOf`, read by `shipGate.ts
 * --print-checks` and `checkMergeEligibility --ledger`), never fixed: a run with no findings owes
 * no `fix` or `confirm`, and a brief with no claims owes no `hand-test`.
 */
export const MARKER_CHECK_NAMES = ["freshen", "wave", "fix", "confirm", "hand-test", "verifier"] as const;
export type MarkerCheckName = (typeof MARKER_CHECK_NAMES)[number];
export type MarkerCheckValue = "PASS" | "N/A";

/** The old flow's check names. A marker flag naming one comes from a run the old flow started. */
export const RETIRED_CHECK_NAMES = ["apply", "explain"] as const;

// Per-line, non-global: tested against ONE line at a time by `parseCheckLines`, so `^`/`$` bind to
// that line's start/end without needing the `m` flag. Trailing text after the value, or a
// mid-prose mention, therefore never matches (only a bare "verifier: PASS"-shaped line does).
export const CHECK_LINE_RE = new RegExp(
  `^(${MARKER_CHECK_NAMES.join("|")}):[ \\t]*(PASS|N\\/A)[ \\t]*$`
);

/**
 * Collect every check line in a (fence-stripped) comment body, grouped by check name. A check
 * with no line in the body gets an empty array — callers can distinguish "missing" from "N/A".
 * Duplicate lines for the same check collect every value, in order.
 */
export function parseCheckLines(body: string): Record<MarkerCheckName, MarkerCheckValue[]> {
  const result = {} as Record<MarkerCheckName, MarkerCheckValue[]>;
  for (const name of MARKER_CHECK_NAMES) result[name] = [];
  for (const line of body.split("\n")) {
    const match = CHECK_LINE_RE.exec(line);
    if (!match) continue;
    result[match[1] as MarkerCheckName].push(match[2] as MarkerCheckValue);
  }
  return result;
}

// ── Durable-marker body builders ─────────────────────────────────────────────────────────────
// One builder per marker, co-located with the constants/grammar they emit — `emitMarker.ts`
// is a thin CLI shell over these; every output round-trips through this same module's parsers
// (`parseCheckLines`, `PROVENANCE_LINE_RE`, `GATED_SHA_LINE_RE`) plus `checkMergeEligibility`'s
// `mergeEligibility`.

export interface GateCleanBodyOptions {
  /** Full 40-char (or ≥7-char short) head SHA the gate verified. */
  sha: string;
  /** `<agent>@<prompt-short-sha>/<model>/<effort>` tokens, e.g. `builder@f00ba12/sonnet/high · build-verifier@…`. */
  provenance: string;
  /** The operator's declared risk class. */
  cls: RiskClass;
  /** The security disposition (its outcome, or its named no-match skip). */
  security: string;
  /** Optional per-check PASS/N-A lines, same-comment locality with the heading above. */
  checks?: Partial<Record<MarkerCheckName, MarkerCheckValue>>;
}

/** Render a complete gate-CLEAN comment body. Every line this emits is exactly what
 * `mergeEligibility` (durability + staleness + check-line checks) and `parseCheckLines` expect. */
export function buildGateCleanBody(opts: GateCleanBodyOptions): string {
  const lines = [
    GATE_CLEAN_MARKER,
    `gated-sha: ${opts.sha}`,
    `provenance: ${opts.provenance}`,
    `class: ${opts.cls}`,
    `security: ${opts.security}`,
  ];
  for (const check of MARKER_CHECK_NAMES) {
    const value = opts.checks?.[check];
    if (value) lines.push(`${check}: ${value}`);
  }
  return lines.join("\n");
}
