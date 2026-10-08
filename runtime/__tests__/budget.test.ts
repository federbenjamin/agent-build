import assert from "node:assert/strict";
import { test } from "node:test";

import { budgetVerdict, formatBudget } from "../lib/budget.ts";

const STARTED = "2026-10-06T00:00:00Z";

test("a budget with 1.4 elapsed hours remaining is ok", () => {
  assert.deepEqual(budgetVerdict(STARTED, 3, new Date("2026-10-06T01:24:00Z")), {
    state: "ok",
    elapsedHours: 1.4,
    budgetHours: 3,
  });
});

test("a budget exactly at its limit is over", () => {
  assert.deepEqual(budgetVerdict(STARTED, 3, new Date("2026-10-06T03:00:00Z")), {
    state: "over",
    elapsedHours: 3,
    budgetHours: 3,
  });
});

test("a budget past its limit is over", () => {
  assert.deepEqual(budgetVerdict(STARTED, 3, new Date("2026-10-06T03:12:00Z")), {
    state: "over",
    elapsedHours: 3.2,
    budgetHours: 3,
  });
});

test("a missing build start leaves the budget unenforced", () => {
  assert.deepEqual(budgetVerdict(null, 3, new Date("2026-10-06T03:12:00Z")), {
    state: "unenforced",
    why: "no started=",
  });
});

test("a missing brief budget leaves the budget unenforced", () => {
  assert.deepEqual(budgetVerdict(STARTED, null, new Date("2026-10-06T03:12:00Z")), {
    state: "unenforced",
    why: "no budget: line",
  });
});

test("budget output distinguishes ok, over, and unenforced verdicts", () => {
  assert.equal(formatBudget({ state: "ok", elapsedHours: 1.4, budgetHours: 3 }), "budget: 1.4h of 3h — ok");
  assert.equal(
    formatBudget({ state: "over", elapsedHours: 3.2, budgetHours: 3 }),
    "budget: 3.2h of 3h — over: spawn nothing"
  );
  assert.equal(formatBudget({ state: "unenforced", why: "no started=" }), "budget: unenforced (no started=)");
  assert.equal(formatBudget({ state: "unenforced", why: "no budget: line" }), "budget: unenforced (no budget: line)");
});

test("budget output uses one decimal for elapsed time without rounding the budget", () => {
  assert.equal(formatBudget({ state: "ok", elapsedHours: 1.44, budgetHours: 2.5 }), "budget: 1.4h of 2.5h — ok");
  assert.equal(formatBudget({ state: "ok", elapsedHours: 0.04, budgetHours: 0.1 }), "budget: 0.0h of 0.1h — ok");
});

test("elapsed hours are rounded down, so an ok line never prints the budget reached", () => {
  assert.equal(formatBudget({ state: "ok", elapsedHours: 2.96, budgetHours: 3 }), "budget: 2.9h of 3h — ok");
  assert.equal(formatBudget({ state: "ok", elapsedHours: 0.0999, budgetHours: 0.1 }), "budget: 0.0h of 0.1h — ok");
  assert.equal(formatBudget({ state: "over", elapsedHours: 3.27, budgetHours: 3 }), "budget: 3.2h of 3h — over: spawn nothing");
  // One step under 0.9 in floating point: `* 10` lands on 9 exactly.
  assert.equal(formatBudget({ state: "ok", elapsedHours: 0.8999999999999999, budgetHours: 0.9 }), "budget: 0.8h of 0.9h — ok");
});

test("a verdict from a real start prints its tenths rounded down, a whole tenth as itself", () => {
  const at = (ms: number) => formatBudget(budgetVerdict(STARTED, 3, new Date(Date.parse(STARTED) + ms)));
  assert.equal(at(18 * 60_000), "budget: 0.3h of 3h — ok");
  assert.equal(at(84 * 60_000), "budget: 1.4h of 3h — ok");
  assert.equal(at(2.96 * 3_600_000), "budget: 2.9h of 3h — ok");
  assert.equal(at(3 * 3_600_000 - 1), "budget: 2.9h of 3h — ok");
});

test("for every elapsed millisecond count, the printed hours are its whole tenths and an ok line stays under the budget", () => {
  const budgetHours = 3;
  const counts: number[] = [];
  for (let ms = 0; ms <= 4 * 3_600_000; ms += 997) counts.push(ms);
  for (let tenth = 1; tenth <= 40; tenth++) counts.push(tenth * 360_000, tenth * 360_000 - 1);
  for (const ms of counts) {
    const v = budgetVerdict(STARTED, budgetHours, new Date(Date.parse(STARTED) + ms));
    const printed = /^budget: (\d+)\.(\d)h of /.exec(formatBudget(v));
    assert.ok(printed, `${ms} ms`);
    assert.equal(Number(printed[1]) * 10 + Number(printed[2]), Math.floor(ms / 360_000), `${ms} ms`);
    if (v.state === "ok") assert.ok(Number(`${printed[1]}.${printed[2]}`) < budgetHours, `${ms} ms`);
  }
});

test("a start later than now is refused, never an ok verdict", () => {
  assert.throws(
    () => budgetVerdict("2027-10-06T00:00:00Z", 3, new Date("2026-10-06T03:12:00Z")),
    /budgetVerdict: started=2027-10-06T00:00:00Z is later than now \(2026-10-06T03:12:00\.000Z\)/
  );
  assert.deepEqual(budgetVerdict(STARTED, 3, new Date(STARTED)), { state: "ok", elapsedHours: 0, budgetHours: 3 });
});
