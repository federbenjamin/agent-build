/**
 * The build pipeline's pure decisions (`pipelines/build/decide.ts`): the fixer's model per round,
 * which claims a hand test owes, what a merged fix round owes, and every branch of K-loop-done.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Kind } from "../../runtime/lib/runFiles.ts";
import { type CloseState, closeDecision, claimsOwed, draftReasons, type FixOutcome, FIX_ROUND_IDS, owedAfterFix, roundModel, type ShipState, shipStep, shipWaitReasons } from "../pipelines/build/decide.ts";

const NONE_OWED = { reviewFixCall: false, reviewFix: false, manifestFix: false, completenessFix: false, securityFix: false, handTestFix: false };
const row = (kind: Kind, action: FixOutcome["rows"][number]["action"]) => ({ id: `${kind}.${action}`, kind, action });
const outcome = (over: Partial<FixOutcome> = {}): FixOutcome => ({ rows: [], amend: { any: false, graded: false }, claimsOwed: [], ...over });

test("the third fixer round is Opus whatever the rows and the brief say", () => {
  assert.equal(roundModel("3", ["structure"], null), "opus");
  assert.equal(roundModel("3", [], "sonnet"), "opus");
  assert.deepEqual([...FIX_ROUND_IDS], ["1", "2", "3"]);
});

test("rounds 1 and 2 use Opus only for an urgent row under an opus brief", () => {
  for (const kind of ["behavior", "security", "missing"] as const) {
    assert.equal(roundModel("1", [kind], "opus"), "opus", kind);
    assert.equal(roundModel("2", ["structure", kind], "opus"), "opus", `${kind} among others`);
    assert.equal(roundModel("1", [kind], "sonnet"), "sonnet", `${kind}, sonnet brief`);
    assert.equal(roundModel("1", [kind], null), "sonnet", `${kind}, no brief model`);
  }
  for (const kind of ["structure", "test-app", "test-tool", "dev-tool", "text"] as const) assert.equal(roundModel("2", [kind], "opus"), "sonnet", kind);
  assert.equal(roundModel("1", [], "opus"), "sonnet", "a round with no rows");
});

test("a hand test owes a claim never run, run zero times, or whose last run failed; a later pass clears an earlier fail", () => {
  const history = { A: ["pass" as const], B: ["fail" as const], C: ["pass" as const, "fail" as const], D: ["fail" as const, "pass" as const], E: [] };
  assert.deepEqual(claimsOwed(["A", "B", "C", "D", "E", "F"], history), ["B", "C", "E", "F"]);
  assert.deepEqual(claimsOwed([], { A: ["fail"] }), []);
});

test("a fix round that changed nothing owes nothing", () => {
  assert.deepEqual(owedAfterFix(outcome()), NONE_OWED);
  assert.deepEqual(owedAfterFix(outcome({ rows: [row("structure", "fixed"), row("text", "dropped"), row("test-app", "relabel")] })), NONE_OWED, "non-urgent rows owe no read");
});

test("fixing an urgent row owes the re-review; a security fix owes the security read too", () => {
  assert.deepEqual(owedAfterFix(outcome({ rows: [row("behavior", "fixed")] })), { ...NONE_OWED, reviewFixCall: true });
  assert.deepEqual(owedAfterFix(outcome({ rows: [row("missing", "fixed")] })), { ...NONE_OWED, reviewFixCall: true });
  assert.deepEqual(owedAfterFix(outcome({ rows: [row("security", "fixed")] })), { ...NONE_OWED, reviewFixCall: true, securityFix: true });
});

test("dropping or relabelling an urgent row owes an unasked confirm, not a re-review; a decision or a blocked row owes none", () => {
  for (const action of ["dropped", "relabel"] as const) assert.deepEqual(owedAfterFix(outcome({ rows: [row("behavior", action)] })), { ...NONE_OWED, reviewFix: true }, action);
  for (const action of ["decision", "blocked", "none"] as const) assert.deepEqual(owedAfterFix(outcome({ rows: [row("security", action)] })), NONE_OWED, action);
});

test("a security row dropped, not fixed, owes the confirm but not the security read", () => {
  assert.deepEqual(owedAfterFix(outcome({ rows: [row("security", "dropped")] })), { ...NONE_OWED, reviewFix: true });
});

test("an amend that changed graded content owes the verifier; one that did not owes the manifest check; no amend owes neither", () => {
  assert.deepEqual(owedAfterFix(outcome({ amend: { any: true, graded: true } })), { ...NONE_OWED, completenessFix: true });
  assert.deepEqual(owedAfterFix(outcome({ amend: { any: true, graded: false } })), { ...NONE_OWED, manifestFix: true });
  assert.deepEqual(owedAfterFix(outcome({ amend: { any: false, graded: false } })), NONE_OWED);
});

test("graded content changed with no amend commit in range still owes the verifier, never the manifest check", () => {
  assert.deepEqual(owedAfterFix(outcome({ amend: { any: false, graded: true } })), { ...NONE_OWED, completenessFix: true });
});

test("a claim owed owes the hand test, independent of the rows", () => {
  assert.deepEqual(owedAfterFix(outcome({ claimsOwed: ["H1"] })), { ...NONE_OWED, handTestFix: true });
});

// ---- K-loop-done ----

const idle: CloseState = { fixOwed: false, fixMerged: false, nothingOpen: true, mainMoved: "pass", driftMerged: false, prePush: "pass" };

test("K-loop-done stops when a fix was owed and none merged, even when the checks are green", () => {
  assert.throws(() => closeDecision({ ...idle, fixOwed: true, fixMerged: false }), /fix round was owed and no fix merged/);
});

test("K-loop-done goes again after a fix merged, before it reads drift or the checks", () => {
  const d = closeDecision({ ...idle, fixOwed: true, fixMerged: true, mainMoved: "fail", driftMerged: false, prePush: null });
  assert.equal(d.done, false);
  assert.match(d.why, /fix round merged/);
});

test("K-loop-done goes again when main moved and the drift merge landed, and stops when it did not", () => {
  const d = closeDecision({ ...idle, mainMoved: "fail", driftMerged: true });
  assert.equal(d.done, false);
  assert.match(d.why, /main moved/);
  assert.throws(() => closeDecision({ ...idle, mainMoved: "fail", driftMerged: false }), /drift merge did not land/);
});

test("K-loop-done with no fix owed and no drift needs the checks to have run", () => {
  assert.throws(() => closeDecision({ ...idle, prePush: null }), /pre-push checks did not run/);
  assert.throws(() => closeDecision({ ...idle, mainMoved: null, prePush: null }), /did not run/);
});

test("K-loop-done treats drift that did not run (null) as no drift and reads the checks", () => {
  assert.equal(closeDecision({ ...idle, mainMoved: null }).done, true);
});

test("K-loop-done ends only on green checks: red goes again with rows open or not; green ends with rows open or not", () => {
  for (const nothingOpen of [true, false]) {
    assert.equal(closeDecision({ ...idle, nothingOpen, prePush: "fail" }).done, false, `red, nothingOpen ${nothingOpen}`);
    assert.equal(closeDecision({ ...idle, nothingOpen, prePush: "pass" }).done, true, `green, nothingOpen ${nothingOpen}`);
  }
  assert.match(closeDecision({ ...idle, nothingOpen: false }).why, /rows are left open/);
  assert.match(closeDecision({ ...idle, nothingOpen: true }).why, /nothing to fix/);
});

// ---- the wait after D-open-pr ----

const pass = { answer: "pass", detail: "ok" } as const;
const fail = (detail: string) => ({ answer: "fail", detail }) as const;
const ship = (over: Partial<ShipState> = {}): ShipState => ({ finalClean: pass, shipGate: pass, capped: false, hold: false, reply: null, ...over });

test("nothing holds the run: the ship step merges at once, not by the operator, and no reason is listed", () => {
  assert.deepEqual(shipWaitReasons(ship()), []);
  assert.deepEqual(shipStep(ship()), { do: "merge" });
  assert.deepEqual(shipStep(ship({ prePushShip: pass })), { do: "merge" }, "green ship checks hold nothing");
});

test("a final round that is not clean, red ship checks, a red gate and the start's hold each make the run ask, with the check's own detail", () => {
  const step = (over: Partial<ShipState>) => shipStep(ship(over));
  const ask = (s: ReturnType<typeof shipStep>) => (s.do === "ask" ? s.why : assert.fail(`expected an ask, got ${JSON.stringify(s)}`));
  assert.match(ask(step({ finalClean: fail("2 rows open") })).join("\n"), /final round is not clean: 2 rows open/);
  assert.match(ask(step({ prePushShip: fail("checks: red") })).join("\n"), /pre-push checks are red: checks: red/);
  assert.match(ask(step({ shipGate: fail("node X failed") })).join("\n"), /gate is red: node X failed/);
  assert.deepEqual(ask(step({ hold: true })), ["the start holds the run before its merge"]);
});

test("a check that never answered is a reason to ask, for final-clean and the gate; a missing ship check is not after a clean loop, which never runs it", () => {
  assert.deepEqual(shipWaitReasons({ finalClean: undefined, shipGate: pass, capped: false, hold: false }), ["final-clean did not answer"]);
  assert.deepEqual(shipWaitReasons({ finalClean: pass, shipGate: undefined, capped: false, hold: false }), ["the gate did not answer"]);
  assert.deepEqual(shipWaitReasons({ finalClean: pass, shipGate: pass, prePushShip: undefined, capped: false, hold: false }), []);
});

test("after a capped loop the ship checks owe an answer: none makes the PR a draft and the run wait, though the final round is clean", () => {
  const unanswered = { finalClean: pass, prePushShip: undefined, capped: true };
  assert.deepEqual(draftReasons(unanswered), ["the pre-push checks did not answer after the capped close loop"]);
  assert.deepEqual(shipWaitReasons({ ...unanswered, shipGate: pass, hold: false }), ["the pre-push checks did not answer after the capped close loop"]);
  assert.deepEqual(draftReasons({ ...unanswered, prePushShip: pass }), [], "a green answer after a capped loop holds nothing");
  assert.deepEqual(draftReasons({ ...unanswered, capped: false }), [], "a clean loop owes no ship checks");
  assert.match(draftReasons({ ...unanswered, prePushShip: fail("checks: red") }).join(), /pre-push checks are red: checks: red/);
});

test("the draft's reasons are the wait's first reasons: a PR waits whenever it opened as a draft", () => {
  for (const finalClean of [pass, fail("rows"), undefined])
    for (const prePushShip of [pass, fail("red"), undefined])
      for (const capped of [true, false]) {
        const s = { finalClean, prePushShip, capped, shipGate: pass, hold: false };
        assert.deepEqual(shipWaitReasons(s), draftReasons(s), JSON.stringify(s));
      }
});

test("every reason is listed together, in the order the operator reads them", () => {
  const why = shipWaitReasons({ finalClean: fail("a"), prePushShip: fail("b"), shipGate: fail("c"), capped: true, hold: true });
  assert.equal(why.length, 4);
  assert.deepEqual(why.map((w) => w.split(":")[0]), ["the final round is not clean", "the pre-push checks are red", "the gate is red", "the start holds the run before its merge"]);
});

test("the reply merge merges whatever held the run, any case and padding; the step says the operator did", () => {
  const held = { finalClean: fail("rows"), prePushShip: fail("red"), shipGate: fail("red"), hold: true };
  for (const reply of ["merge", "  Merge\n", "MERGE"]) assert.deepEqual(shipStep(ship({ ...held, reply })), { do: "merge" }, reply);
});

test("the reply abandon abandons, even when nothing held the run", () => {
  assert.deepEqual(shipStep(ship({ reply: "abandon" })), { do: "abandon" });
  assert.deepEqual(shipStep(ship({ reply: " ABANDON " })), { do: "abandon" });
});

test("any other reply asks again, naming merge and abandon and quoting the reply; a near miss is not a merge", () => {
  for (const reply of ["", "ok", "merged", "merge it", "yes, abandon"]) {
    const s = shipStep(ship({ reply }));
    assert.equal(s.do, "ask", JSON.stringify(reply));
    if (s.do === "ask") {
      assert.equal(s.why.length, 1);
      assert.match(s.why[0]!, /is neither merge nor abandon/);
      assert.ok(s.why[0]!.includes(JSON.stringify(reply.trim())), "quotes the reply");
    }
  }
});
