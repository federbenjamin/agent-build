import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";
import { TSX_BIN } from "./helpers/tsxBin.ts";

const BUILD_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

test("a build script run through a symlinked directory still runs its CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "ismain-"));
  try {
    const link = join(dir, "build");
    symlinkSync(BUILD_DIR, link, "dir");
    const empty = mkdtempSync(join(dir, "repo-"));
    const r = spawnSmoke(TSX_BIN, [join(link, "steps.ts"), empty, "--get", "notes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "(none)\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
