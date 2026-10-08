/**
 * Risk class — the build flow's depth selector, DECLARED by the operator at the class moment
 * (`/build`, right after the brief) and never recomputed. This module holds only the type, the
 * fixed reader set per class (the single authority the skill restates), and the class-line parse.
 * A repo's security `signals` (evidence for the operator's pick, never a class setter) are the
 * repo's own `signals` step. Pure — no fs/process/git.
 */

/** R0 nothing a user sees · R1 a user sees or loses something (wrong output, data lost, a core flow
 * blocked, a runaway bill) · R2 the change touches the security boundary (another user's data, auth,
 * access rules, encryption, secrets). R2 adds only `security-review`. A repo's AGENTS.md may name its
 * own security surfaces. */
export type RiskClass = "R0" | "R1" | "R2";

export const RISK_CLASSES: readonly RiskClass[] = ["R0", "R1", "R2"];

/** The five wave readers, every one an agent in this repo's `agents.json`. */
export type ReaderName =
  | "review-cursory"
  | "gate-silent-failure-hunter"
  | "build-verifier"
  | "simplifier"
  | "security-review";

/** The wave's reader set per class — the floor; size only lets a reader sit out (`WAVE_*`).
 * `build-verifier` reads every briefed run at every class. `simplifier` is absent at EVERY class:
 * the diff alone selects it (the size step's `simplifier:` line), because two axes deciding one reader lost a read. */
export const RISK_CLASS_READERS: Record<RiskClass, readonly ReaderName[]> = {
  R0: ["review-cursory", "build-verifier"],
  R1: ["review-cursory", "gate-silent-failure-hunter", "build-verifier"],
  R2: ["review-cursory", "gate-silent-failure-hunter", "build-verifier", "security-review"],
};

/** Every legal `wave:` reader token. */
export const READER_NAMES: readonly ReaderName[] = [
  "review-cursory",
  "gate-silent-failure-hunter",
  "build-verifier",
  "simplifier",
  "security-review",
];

/** A reader token on a stage read line (`confirm-1:` … `drift-confirm:`, `R/lib/ledger.ts`): the
 *  wave readers plus the paired Codex cursory read. */
export type StageReaderName = ReaderName | "review-cursory-codex";

export const STAGE_READER_NAMES: readonly StageReaderName[] = [...READER_NAMES, "review-cursory-codex"];

/** The flow's agents that write no finding file: never a reader token, never in `READER_NAMES`. */
export const FLOW_AGENTS = ["builder", "fixer", "hand-tester"] as const;

export type FlowAgent = (typeof FLOW_AGENTS)[number];

const REPO_READER_NAME = /^[a-z][a-z0-9-]*$/;

/** A `wave:` line's readers. `readers` is everything before its first `|` — each must be a
 *  `READER_NAMES` token, so an unrecognized one throws rather than dropping out of the owed set.
 *  `repoReaders` is the agents a `repo:` segment after it names (a size-step `reader:` line fired
 *  them; the gate owes none). A segment that starts `repo` but is not `repo: <agent>…` throws, so a
 *  typo cannot hide a reader's findings file from telemetry. */
export function parseWaveLine(waveLine: string | undefined): {
  readers: string[];
  repoReaders: string[];
} {
  if (waveLine === undefined) return { readers: [], repoReaders: [] };
  const [head, ...segments] = waveLine.split("|");
  const readers = head!
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const token of readers) {
    if (!(READER_NAMES as readonly string[]).includes(token)) {
      throw new Error(
        `wave: \`${token}\` is not a reader name — the reader list before the first | takes only: ${READER_NAMES.join(", ")}`
      );
    }
  }
  const repoReaders: string[] = [];
  for (const segment of segments.map((s) => s.trim()).filter((s) => /^repo\b/.test(s))) {
    const names = /^repo:\s*(.+)$/.exec(segment)?.[1]?.split(/[,\s]+/).filter(Boolean) ?? [];
    if (names.length === 0 || !names.every((n) => REPO_READER_NAME.test(n))) {
      throw new Error(
        `wave: \`${segment}\` is not a repo-reader segment — write \`repo: <agent>[, <agent>]\``
      );
    }
    repoReaders.push(...names);
  }
  return { readers, repoReaders };
}

export function isRiskClass(value: string): value is RiskClass {
  return (RISK_CLASSES as readonly string[]).includes(value);
}

/** Parse a pinned class line — `class: R2 — operator, 2026-08-29`, or `class: R2 — agent (unconfirmed), 2026-08-29` when the agent picked it. */
export const CLASS_LINE_RE = /^class:\s*(R[0-2])\b(.*)$/m;

export function parseClassLine(text: string): { cls: RiskClass; rest: string } | null {
  const m = CLASS_LINE_RE.exec(text);
  if (!m || !isRiskClass(m[1]!)) return null;
  return { cls: m[1], rest: m[2]!.trim() };
}

/** The refusal a caller prints when a brief or ledger still pins the retired R3, or null. R3 was
 * fused into R2, so an in-flight run re-pins rather than reading as unclassed. */
export function retiredClassReason(text: string): string | null {
  return /^class:\s*R3\b/m.test(text)
    ? "`class: R3` is retired — R3 was fused into R2; re-pin the line as `class: R2 — <who>, <YYYY-MM-DD>`"
    : null;
}
