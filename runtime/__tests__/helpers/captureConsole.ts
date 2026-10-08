/**
 * Console capture for gate self-tests that exercise a checker's main()/report path.
 *
 * Convention (binding, enforced by checkGateTestConsole): no test under
 * scripts/__tests__/*.test.ts invokes a checker's main() without routing its
 * console output through this helper — fixture diagnostics must never land in
 * the suite's own stream. Captured lines come back for assertion; embed them in
 * assertion messages so they print only when the test fails.
 */
import { mock } from "node:test";

export interface CapturedConsole {
  /** Lines written to console.error while captured, one entry per call (args space-joined). */
  errors: string[];
  /** Lines written to console.log while captured. */
  logs: string[];
  /** Lines written to console.warn while captured. */
  warns: string[];
  /** All captured lines in call order, for embedding in an assertion message. */
  all: string[];
}

/**
 * Runs `fn` with console.error/log/warn mocked to capture instead of print,
 * restoring them before returning — including on throw. Supports async `fn`.
 * No replay on throw: exit-seam checkers throw (e.g. ExitSignal) as their NORMAL
 * rejection path, so replaying would reintroduce the fixture noise. To see a
 * wrapped checker's output, assert on the returned `captured` lines or re-run
 * its test file solo.
 */
export function withCapturedConsole<T>(fn: (captured: CapturedConsole) => T): T {
  const captured: CapturedConsole = { errors: [], logs: [], warns: [], all: [] };
  const record =
    (bucket: string[]) =>
    (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      bucket.push(line);
      captured.all.push(line);
    };
  const mocks = [
    mock.method(console, "error", record(captured.errors)),
    mock.method(console, "log", record(captured.logs)),
    mock.method(console, "warn", record(captured.warns)),
  ];
  const restore = () => {
    for (const m of mocks) m.mock.restore();
  };
  try {
    const result = fn(captured);
    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}
