import assert from "node:assert/strict";

import { RunFileError } from "../../lib/runFiles.ts";

/** Assert `fn` throws a RunFileError whose message matches `re`. */
export function refuses(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof RunFileError, `expected RunFileError, got ${String(e)}`);
    assert.match(e.message, re);
    return true;
  });
}
