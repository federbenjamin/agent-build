/**
 * The default `exit` for a gate script's `main(deps, exit = exitWhenFlushed)` seam.
 *
 * `process.exit()` terminates before Node's async pipe writes flush, truncating a long report
 * under lefthook/CI (measured: a 201-violation report cut mid-line at 12,359 bytes). Setting
 * `process.exitCode` and letting Node exit on its own preserves the code and flushes.
 *
 * CALLER CONTRACT: unlike `process.exit`, this RETURNS — every call site must `exit(1); return;`
 * itself. FIRST CALL WINS (latched) so a later `exit(0)` in the same run can't green-wash a
 * failure. Enforced: `pnpm check:banned-patterns` (`gate-script-process-exit-default`).
 */

/**
 * Factory over the exit-code host, so the latch is exercisable without mutating the real process.
 * Production takes exactly one instance — `exitWhenFlushed` below.
 */
export const makeExitWhenFlushed = (host: {
  exitCode?: number | string | null | undefined;
}): ((code: number) => void) => {
  let decided = false;
  return (code: number): void => {
    if (decided) return;
    decided = true;
    host.exitCode = code;
  };
};

export const exitWhenFlushed = makeExitWhenFlushed(process);
