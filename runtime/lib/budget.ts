/**
 * The wall budget: elapsed time since the ledger's `build: … | started=` against the brief's
 * `budget: <n>h` line, and the one `budget:` line `reviewTable.ts build` and `stagePlan.ts` print
 * before CLOSE spawns a fixer or a reader (CLOSE.md §The budget stop). Pure: no fs, no git.
 */

export type BudgetVerdict =
  | { state: "ok" | "over"; elapsedHours: number; budgetHours: number }
  | { state: "unenforced"; why: "no started=" | "no budget: line" };

const MS_PER_HOUR = 3_600_000;

/** `started` is the ledger's `started=` (UTC ISO) or null; `budgetHours` the brief's `budget:` or null.
 *  Throws when `started` is not a date, or is later than `now` (a negative elapsed time never reaches
 *  the budget). */
export function budgetVerdict(started: string | null, budgetHours: number | null, now: Date): BudgetVerdict {
  if (started === null) return { state: "unenforced", why: "no started=" };
  if (budgetHours === null) return { state: "unenforced", why: "no budget: line" };
  const startedMs = Date.parse(started);
  if (Number.isNaN(startedMs)) throw new Error(`budgetVerdict: started=${started} is not a date`);
  if (startedMs > now.getTime()) {
    throw new Error(`budgetVerdict: started=${started} is later than now (${now.toISOString()}); fix the build: line's started=`);
  }
  const elapsedHours = (now.getTime() - startedMs) / MS_PER_HOUR;
  return { state: elapsedHours >= budgetHours ? "over" : "ok", elapsedHours, budgetHours };
}

/** `budget: 1.4h of 3h — ok` · `budget: 3.2h of 3h — over: spawn nothing` · `budget: unenforced (no started=)` ·
 *  `budget: unenforced (no budget: line)`; a reader keys on the `budget: unenforced` prefix. */
export function formatBudget(v: BudgetVerdict): string {
  if (v.state === "unenforced") return `budget: unenforced (${v.why})`;
  const head = `budget: ${floorTenths(v.elapsedHours)}h of ${v.budgetHours}h`;
  return v.state === "over" ? `${head} — over: spawn nothing` : `${head} — ok`;
}

// The largest one-decimal value not above `hours`, so an `ok` line never prints the budget reached.
// `hours * 10` rounds up onto the next tenth for a value just under it (0.8999999999999999 * 10 is 9).
function floorTenths(hours: number): string {
  let tenths = Math.floor(hours * 10);
  if (tenths / 10 > hours) tenths -= 1;
  return (tenths / 10).toFixed(1);
}
