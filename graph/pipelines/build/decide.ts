/**
 * The build pipeline's decisions, as pure functions: the fixer's model for a round, what a fix
 * round owes once merged, whether the close loop goes again, which claims a hand test owes, and
 * whether the PR merges or waits on the operator. The checks and operations around them only read and
 * write files.
 */

import { type Kind, URGENT_KINDS } from "../../../runtime/lib/runFiles.ts";
import { OPERATOR_ABANDON, OPERATOR_MERGE } from "../../constants.ts";

const isUrgent = (k: Kind): boolean => URGENT_KINDS.includes(k);

/** The fixer rounds a run gets (map §8 point 2): the third is Opus, urgent kinds only. */
export const FIX_ROUND_IDS = ["1", "2", "3"] as const;
export type FixRoundId = (typeof FIX_ROUND_IDS)[number];

/** The fixer's model for a round: Opus on the last round, or when the round holds an urgent row and
 *  the brief's header is opus; else Sonnet. */
export function roundModel(round: FixRoundId, kinds: readonly Kind[], briefModel: string | null): "opus" | "sonnet" {
  if (round === FIX_ROUND_IDS[FIX_ROUND_IDS.length - 1]) return "opus";
  return kinds.some(isUrgent) && briefModel === "opus" ? "opus" : "sonnet";
}

/** One claim's results over the run, oldest first. */
export type ClaimHistory = Record<string, ("pass" | "fail")[]>;

/** The claims a hand test owes after a fix: those never run, or whose last run failed. */
export function claimsOwed(claims: readonly string[], history: ClaimHistory): string[] {
  return claims.filter((c) => {
    const runs = history[c];
    return runs === undefined || runs.length === 0 || runs[runs.length - 1] === "fail";
  });
}

export interface FixOutcome {
  /** Each row the round held: its kind, and what the fixer did to it. */
  rows: { id: string; kind: Kind; action: "fixed" | "dropped" | "relabel" | "decision" | "blocked" | "none" }[];
  /** An `amend brief:` commit landed in the fix's range, and whether it changed graded content. */
  amend: { any: boolean; graded: boolean };
  /** The claims the hand test owes after this fix. */
  claimsOwed: readonly string[];
}

export interface Owed {
  /** Ask C-review-fix: the round fixed an urgent row. */
  reviewFixCall: boolean;
  /** A-review-fix without asking: the round dropped or relabelled an urgent row. */
  reviewFix: boolean;
  manifestFix: boolean;
  completenessFix: boolean;
  securityFix: boolean;
  handTestFix: boolean;
}

/**
 * What a merged fix round owes (map §1, D-merge-fix's edges): C-review-fix when it fixed an urgent row;
 * A-review-fix unasked when it dropped or relabelled one (else such a row closes unread); A-completeness-fix on a
 * graded `amend brief:` in the range; K-manifest-fix on an amend that changes no graded content; A-security-fix
 * after a `security` row was fixed; A-hand-test-fix when a claim was never run or last failed.
 */
export function owedAfterFix(f: FixOutcome): Owed {
  const urgent = f.rows.filter((r) => isUrgent(r.kind));
  return {
    reviewFixCall: urgent.some((r) => r.action === "fixed"),
    reviewFix: urgent.some((r) => r.action === "dropped" || r.action === "relabel"),
    completenessFix: f.amend.graded,
    manifestFix: f.amend.any && !f.amend.graded,
    securityFix: f.rows.some((r) => r.kind === "security" && r.action === "fixed"),
    handTestFix: f.claimsOwed.length > 0,
  };
}

export interface CloseState {
  fixOwed: boolean;
  /** The fixer ran and its commit merged this iteration. */
  fixMerged: boolean;
  nothingOpen: boolean;
  /** K-main-moved's answer this iteration: pass when main is in the branch, fail when main moved (a merge is owed); null not run. */
  mainMoved: "pass" | "fail" | null;
  /** D-pull-main-drift merged main this iteration (false when it failed, as on a conflict). */
  driftMerged: boolean;
  /** K-pre-push's answer this iteration; null not run. */
  prePush: "pass" | "fail" | null;
}

/**
 * Whether the close loop is done (K-loop-done): `again` while a fix round merged, a drift merge waits
 * for its read, or a red pre-push check left rows for the table; `done` only once the checks are
 * green, with rows left open (banked, or past the last fixer round) or none. A red check never ends
 * the loop: its rows reach a fixer, or, with no round left to take them, the final round, and the
 * loop runs to its cap. After a capped loop K-pre-push-ship runs the checks once more, and a red or
 * missing answer pushes the PR as a draft that waits on the operator (`draftReasons`). Throws when
 * the loop cannot go on: a fix was owed and no fix merged, or main moved and its merge did not land
 * (the merge node's failure names the conflict).
 */
export function closeDecision(s: CloseState): { done: boolean; why: string } {
  if (s.fixOwed) {
    if (!s.fixMerged) throw new Error("a fix round was owed and no fix merged: the fixer or its merge failed");
    return { done: false, why: "a fix round merged; the next table reads what it did" };
  }
  if (s.mainMoved === "fail") {
    if (!s.driftMerged) throw new Error("main moved and the drift merge did not land: D-pull-main-drift failed, and its reason names the conflict");
    return { done: false, why: "main moved: the drift merge, and its read when it touched the branch's files, go to the next table" };
  }
  if (s.prePush === null) throw new Error("no fix was owed and the pre-push checks did not run");
  if (s.prePush === "fail") return { done: false, why: "the pre-push checks are red; their rows go to the next table" };
  if (!s.nothingOpen) return { done: true, why: "rows are left open (banked, or past the last fixer round); the pre-push checks are green for the draft" };
  return { done: true, why: "nothing to fix, no drift, the pre-push checks are green" };
}

/** Whether a drift merge owes a read (D-pull-main-drift's `drift-first`): it touched a file the branch
 *  changed, and the run has had no drift group yet (the map allows one). */
export function driftReadOwed(overlap: readonly string[], driftGroups: number): { owed: boolean; why: string } {
  if (overlap.length === 0) return { owed: false, why: "main touched none of the branch's files: no read owed" };
  if (driftGroups > 0) return { owed: false, why: `main touched the branch's ${overlap.join(", ")}, but the run had its one drift group: no read owed` };
  return { owed: true, why: `main touched the branch's ${overlap.join(", ")}` };
}

/** A check's answer and detail, as D-merge-pr reads its gates. */
type Gated = { answer: "pass" | "fail"; detail: string } | undefined;

export interface ShipState {
  finalClean: Gated;
  /** K-pre-push-ship's answer, which a capped loop owes. */
  prePushShip?: Gated;
  /** The close loop ended at its cap, so K-pre-push-ship ran (or was due) for it. */
  capped: boolean;
  shipGate: Gated;
  /** The start holds the run before its merge. */
  hold: boolean;
  /** The operator's last reply to D-merge-pr's question; null before it asked. */
  reply: string | null;
}

const red = (what: string, c: Gated): string[] => (c === undefined || c.answer === "pass" ? [] : [`${what}: ${c.detail}`]);

/** Why D-open-pr opens the PR as a draft: an urgent row still open, or the ship checks red or, after a
 *  capped loop, not answered. Empty: it opens ready for review. */
export function draftReasons(s: Pick<ShipState, "finalClean" | "prePushShip" | "capped">): string[] {
  return [
    ...(s.finalClean === undefined ? ["final-clean did not answer"] : red("the final round is not clean", s.finalClean)),
    ...(s.prePushShip === undefined && s.capped ? ["the pre-push checks did not answer after the capped close loop"] : red("the pre-push checks are red", s.prePushShip)),
  ];
}

/** Why D-merge-pr waits on the operator rather than merging: why the PR is a draft, the run record's
 *  gate red, or the start's hold. Empty: it merges at once. */
export function shipWaitReasons(s: Omit<ShipState, "reply">): string[] {
  return [
    ...draftReasons(s),
    ...(s.shipGate === undefined ? ["the gate did not answer"] : red("the gate is red", s.shipGate)),
    ...(s.hold ? ["the start holds the run before its merge"] : []),
  ];
}

/** What D-merge-pr does: before any reply, merge at once or ask why it waits; after one, the reply
 *  (trimmed, any case) merges or abandons the run, and any other text is asked again. */
export type ShipStep = { do: "merge" } | { do: "ask"; why: string[] } | { do: "abandon" };

export function shipStep(s: ShipState): ShipStep {
  if (s.reply === null) {
    const why = shipWaitReasons(s);
    return why.length === 0 ? { do: "merge" } : { do: "ask", why };
  }
  const word = s.reply.trim().toLowerCase();
  if (word === OPERATOR_MERGE) return { do: "merge" };
  if (word === OPERATOR_ABANDON) return { do: "abandon" };
  return { do: "ask", why: [`the reply ${JSON.stringify(s.reply.trim())} is neither ${OPERATOR_MERGE} nor ${OPERATOR_ABANDON}`] };
}
