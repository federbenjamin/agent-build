/**
 * Shared strict-argv helper: fail loud on an unknown `--flag`. Every strict CLI entry
 * point in `scripts/` uses this guard (diffReviewArgs, reviewTelemetry,
 * shipGate, prReady) — a typo'd flag must never
 * silently parse as a positional/path and yield a wrong-but-exit-0 result.
 */

export function assertKnownFlags(argv: string[], known: ReadonlySet<string> | string[]): void {
  const knownSet = known instanceof Set ? known : new Set(known);
  const unknown = argv.filter((a) => a.startsWith("--") && !knownSet.has(a));
  if (unknown.length > 0) {
    throw new Error(`unknown flag(s): ${unknown.join(", ")} — known: ${[...knownSet].join(", ")}`);
  }
}

/** Consume `--flag <value>` out of argv; fail loud on a missing value (a flag silently
 * swallowed as a positional would yield wrong-but-exit-0 behavior). Shared by the strict
 * CLI entry points (reviewTelemetry, shipGate). */
export function takeValue(argv: string[], flag: string): { value?: string; rest: string[] } {
  const i = argv.indexOf(flag);
  if (i === -1) return { rest: argv };
  const raw = argv[i + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`${flag} requires a value, got ${raw ?? "(missing)"}`);
  }
  return { value: raw, rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

/** Every `--flag <value>` occurrence, in argv order; each value must be present and not start with `--`
 *  (the same refusal as `takeValue`). `values` is empty when the flag is absent. */
export function takeValues(argv: string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  let rest = argv;
  for (;;) {
    const { value, rest: next } = takeValue(rest, flag);
    if (value === undefined) return { values, rest };
    values.push(value);
    rest = next;
  }
}
