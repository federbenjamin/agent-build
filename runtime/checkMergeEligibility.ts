/**
 * CLI + pure check: is a PR merge-eligible by its DURABLE gate artifact?
 *
 * `/build` SHIP arms auto-merge with no per-chunk human gate at R0–R2, so it must read the
 * durable per-PR `## ship gate: CLEAN` PR comment and never trust its own in-context memory — a
 * chunk with no durable comment is NOT merge-eligible. Trust boundary is durability, not
 * authorship: the marker must be a persisted PR comment a fresh `gh` re-reads, posted only
 * after every CLOSE move reported, with a whole-line heading, a `provenance:` line, and
 * `gated-sha:` equal to the PR's current head (fenced-code mentions don't count).
 *
 * `--require <csv>` demands a `<check>: PASS` line per named check in that same comment;
 * `--ledger <path>` self-derives the required-check list instead (mutually exclusive with
 * `--require`): the checks `owed.ts` `markerChecksOf` says the run owes, the same list the gate's
 * `--print-checks` marks PASS, read with the cwd as the repo. `--allow-stale-sha` relaxes the
 * gated-sha equality for operator-merged paths only, and is rejected together with `--ledger`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { ghOut } from "./lib/gitOps.ts";
import {
  GATE_CLEAN_MARKER,
  GATED_SHA_LINE_RE,
  MARKER_CHECK_NAMES,
  MIN_SHA_PREFIX,
  type MarkerCheckName,
  PROVENANCE_LINE_RE,
  parseCheckLines,
  stripFencedBlocks,
  wholeLineHeadingRe,
} from "./lib/gateMarkers.ts";
import { isMain } from "./lib/isMain.ts";
import { parseLedger } from "./lib/ledger.ts";
import { markerChecksOf, type OwedDeps, runBase, runContext } from "./lib/owed.ts";
import { Shape } from "./lib/shape.ts";

// Re-exported for back-compat: existing imports of these two names from this module keep
// compiling. Canonical home for both (plus the other marker/check-line primitives) is
// lib/gateMarkers.ts.
export { GATE_CLEAN_MARKER, stripFencedBlocks };

const GATE_CLEAN_HEADING_RE = wholeLineHeadingRe(GATE_CLEAN_MARKER);

/** Parse `gh pr view <pr> --json comments,headRefOid` output. Pure, validated at the edge: gh's own
 *  shape is an external API, so unknown keys are ignored and only the two read fields are typed. */
function validatePrView(raw: unknown): { comments?: { body?: string }[]; headRefOid?: string } {
  const s = new Shape("gh pr view output");
  const o = s.obj(raw, "(root)") ?? {};
  const headRefOid = o.headRefOid === undefined ? undefined : s.str(o.headRefOid, "headRefOid");
  const comments =
    o.comments === undefined
      ? undefined
      : s.arr(o.comments, "comments").map((c, i) => {
          const body = s.optStr(s.obj(c, `comments[${i}]`) ?? {}, "body", `comments[${i}]`);
          return body === undefined ? {} : { body };
        });
  const issues = s.issues();
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join("\n"));
  return {
    ...(comments === undefined ? {} : { comments }),
    ...(headRefOid === undefined ? {} : { headRefOid }),
  };
}

export function parsePrView(ghJson: string): { bodies: string[]; headSha: string | null } {
  const parsed = validatePrView(JSON.parse(ghJson));
  return {
    bodies: (parsed.comments ?? []).map((c) => c.body ?? ""),
    headSha: parsed.headRefOid ?? null,
  };
}

/** Back-compat helper: just the comment bodies. */
export function parsePrComments(ghJson: string): string[] {
  return parsePrView(ghJson).bodies;
}

/** True iff `markerSha` identifies `headSha`: exact, or a ≥7-char short-SHA prefix. */
function shaMatchesHead(markerSha: string, headSha: string): boolean {
  const m = markerSha.toLowerCase();
  const h = headSha.toLowerCase();
  return m.length >= MIN_SHA_PREFIX && (m === h || h.startsWith(m));
}

export type MergeEligibility =
  | { eligible: true }
  | { eligible: false; reasons: [string, ...string[]] };

/** Options for `mergeEligibility`. `allowStaleSha` defaults to `false` (strict). Set `true` only
 * for an operator-merged path — see the module docstring's "seventh, orthogonal flag" note. */
export interface MergeEligibilityOptions {
  /** Skip the `gated-sha == head` equality check (forgery class 4). The `gated-sha:` line must
   * still be PRESENT — only the equality-to-head refusal is skipped. */
  allowStaleSha?: boolean;
}

/**
 * Merge-eligibility verdict for a PR. Eligible iff SOME single comment carries the gate-CLEAN
 * heading, a `provenance:` line, a matching `gated-sha:` line, AND a `<check>: PASS` line for
 * every `requiredChecks` entry (same-comment locality). `reasons` explains a failed verdict.
 */
export function mergeEligibility(
  commentBodies: string[],
  headSha: string,
  requiredChecks: readonly MarkerCheckName[] = [],
  options: MergeEligibilityOptions = {}
): MergeEligibility {
  const { allowStaleSha = false } = options;
  const headingRe = GATE_CLEAN_HEADING_RE;
  const reasons = new Set<string>();
  for (const raw of commentBodies) {
    const body = stripFencedBlocks(raw);
    if (!headingRe.test(body)) {
      if (headingRe.test(raw)) {
        reasons.add(
          "a gate-CLEAN heading appears only inside a fenced code block — a quoted marker is not a gate artifact"
        );
      }
      continue;
    }
    if (!PROVENANCE_LINE_RE.test(body)) {
      reasons.add(
        "gate-CLEAN marker is missing its `provenance:` line — INCOMPLETE, never trusted; re-run the gate"
      );
      continue;
    }
    const sha = GATED_SHA_LINE_RE.exec(body)?.[1];
    if (!sha) {
      reasons.add(
        "gate-CLEAN marker is missing its `gated-sha:` line — cannot bind the verdict to a commit; re-post from the gate"
      );
      continue;
    }
    if (!allowStaleSha && !shaMatchesHead(sha, headSha)) {
      reasons.add(
        `gate-CLEAN marker is STALE: gated-sha ${sha} does not match the PR head ${headSha} — commits were pushed after the gate; re-run it`
      );
      continue;
    }
    if (requiredChecks.length > 0) {
      const checkValues = parseCheckLines(body);
      let checkFailed = false;
      for (const check of requiredChecks) {
        const values = checkValues[check];
        if (values.length === 0) {
          reasons.add(
            `required check "${check}" has no check line ("${check}: PASS" or "${check}: N/A") in the gate-CLEAN comment`
          );
          checkFailed = true;
          break;
        }
        if (values.includes("N/A")) {
          reasons.add(`required check "${check}" is N/A — required to PASS before merge`);
          checkFailed = true;
          break;
        }
      }
      if (checkFailed) continue;
    }
    return { eligible: true };
  }
  if (reasons.size === 0) {
    reasons.add(
      `no durable gate-CLEAN artifact: expected a PR comment whose own line is "${GATE_CLEAN_MARKER}" (a run's self-narration is not a gate signal)`
    );
  }
  return { eligible: false, reasons: [...reasons] as [string, ...string[]] };
}

/**
 * True iff some comment body carries a full, current-head gate-CLEAN artifact.
 * Convenience wrapper over `mergeEligibility`.
 */
export function hasGateCleanArtifact(commentBodies: string[], headSha: string): boolean {
  return mergeEligibility(commentBodies, headSha).eligible;
}

/** True iff `--allow-stale-sha` is present in CLI argv (operator-merge relaxed mode). */
export function parseAllowStaleShaFlag(argv: string[]): boolean {
  return argv.includes("--allow-stale-sha");
}

/**
 * Parse a `--require <csv>` CLI flag into the checks it names. Strict: no flag → `[]` (nothing
 * required); flag present with an empty or all-blank CSV, or naming an unrecognized check,
 * throws rather than silently requiring nothing.
 */
export function parseRequireFlag(argv: string[]): MarkerCheckName[] {
  const idx = argv.indexOf("--require");
  if (idx === -1) return [];
  const raw = argv[idx + 1];
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(
      `--require given an empty check list (expected a comma-separated list from: ${MARKER_CHECK_NAMES.join(", ")})`
    );
  }
  const checks: MarkerCheckName[] = [];
  for (const part of parts) {
    if (!(MARKER_CHECK_NAMES as readonly string[]).includes(part)) {
      throw new Error(
        `--require: unknown check "${part}" (expected one of: ${MARKER_CHECK_NAMES.join(", ")})`
      );
    }
    checks.push(part as MarkerCheckName);
  }
  return checks;
}

export interface DeriveOpts {
  /** The repo (session tree) the ledger's brief is read in. Default: the process cwd. */
  cwd?: string;
  deps?: OwedDeps;
}

/**
 * Self-derivation: the checks the run owes (`owed.ts` `markerChecksOf` over the ledger, its run dir
 * — the ledger's folder — and the brief at HEAD), the one home the gate's `--print-checks` reads
 * too. Throws if the ledger or the brief is unreadable rather than guessing: an unread brief has no
 * claims, which would drop `hand-test` from the owed checks, so the last guard fails closed.
 */
export async function deriveRequiredChecks(ledgerPath: string, opts: DeriveOpts = {}): Promise<MarkerCheckName[]> {
  const repo = opts.cwd ?? process.cwd();
  const path = resolve(repo, ledgerPath);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`--ledger path is unreadable: ${ledgerPath}`);
  }
  const ledger = parseLedger(text);
  const base = runBase(ledger, undefined);
  if (base === null) throw new Error("--ledger: no base — the ledger's `freshen:` line has no base=");
  const ctx = await runContext(ledger, dirname(path), repo, base, opts.deps);
  if (ctx.briefFailures.length > 0) throw new Error(`--ledger: ${ctx.briefFailures.join("; ")}`);
  return markerChecksOf(ctx);
}

/**
 * Resolve the effective `requiredChecks` list from CLI argv (everything after the PR number):
 * `--ledger <path>` self-derivation, or `--require <csv>` manual override, or neither (`[]`).
 * Throws if BOTH are given — the two modes are mutually exclusive, never silently prioritized.
 */
export async function resolveRequiredChecks(argv: string[], opts: DeriveOpts = {}): Promise<MarkerCheckName[]> {
  const ledgerIdx = argv.indexOf("--ledger");
  if (ledgerIdx === -1) return parseRequireFlag(argv);
  const ledgerPath = argv[ledgerIdx + 1];
  if (!ledgerPath || ledgerPath.startsWith("--")) {
    throw new Error("--ledger requires a path value");
  }
  if (argv.includes("--require")) {
    throw new Error(
      "--require and --ledger are mutually exclusive — pick one (self-derivation or manual override)"
    );
  }
  if (argv.includes("--allow-stale-sha")) {
    throw new Error(
      "--allow-stale-sha is invalid with --ledger: the autonomous SHIP merge path is always strict " +
        "(gated-sha must equal head) — --allow-stale-sha is reserved for an operator-merged PR, where a " +
        "human re-reads whatever landed after the gate"
    );
  }
  return deriveRequiredChecks(ledgerPath, opts);
}

/** Shell out to `gh` and return comment bodies + head SHA for a PR. */
function fetchPrView(pr: string): { bodies: string[]; headSha: string | null } {
  const out = ghOut(["pr", "view", pr, "--json", "comments,headRefOid"]);
  return parsePrView(out);
}

async function main(): Promise<void> {
  const pr = process.argv[2];
  if (!pr) {
    console.error(
      "Usage: node ~/.agent-build/runtime/checkMergeEligibility.ts <pr-number> [--require freshen,wave] " +
        "[--allow-stale-sha] | [--ledger <run-dir>/ship.md]"
    );
    process.exit(1);
  }
  const rest = process.argv.slice(3);
  let requiredChecks: MarkerCheckName[];
  try {
    requiredChecks = await resolveRequiredChecks(rest);
  } catch (err) {
    console.error(`checkMergeEligibility: ${(err as Error).message}`);
    process.exit(1);
    return;
  }
  const allowStaleSha = parseAllowStaleShaFlag(rest);
  try {
    const { bodies, headSha } = fetchPrView(pr);
    if (!headSha) {
      console.error(
        `checkMergeEligibility: PR #${pr} — gh returned no headRefOid; cannot bind the gate artifact to a commit.`
      );
      process.exit(1);
    }
    const verdict = mergeEligibility(bodies, headSha, requiredChecks, { allowStaleSha });
    if (verdict.eligible) {
      console.log(
        `checkMergeEligibility: OK — PR #${pr} is merge-eligible (durable gate-CLEAN artifact${
          allowStaleSha ? "" : ` at head ${headSha}`
        }).`
      );
      return;
    }
    console.error(
      `checkMergeEligibility: PR #${pr} is NOT merge-eligible:\n  - ${verdict.reasons.join("\n  - ")}`
    );
    process.exit(1);
  } catch (err) {
    console.error(`checkMergeEligibility: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
