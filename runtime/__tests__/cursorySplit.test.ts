/** cursorySplit: the per-folder counts and the cut for a split `review-cursory` wave read (fix4 item 5). */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bestCut, folderCounts, main, splitPatch } from "../cursorySplit.ts";

const file = (path: string, added: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${added} @@\n${Array.from({ length: added }, (_, i) => `+line ${i}`).join("\n")}\n`;

test("splitPatch keys each file's patch by its path; a deletion by its old path", () => {
  const del = "diff --git a/old/x.ts b/old/x.ts\ndeleted file mode 100644\n--- a/old/x.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
  assert.deepEqual(
    splitPatch(file("a/b.ts", 2) + del).map((f) => f.path),
    ["a/b.ts", "old/x.ts"]
  );
});

test("folderCounts sums every folder at every depth; bestCut takes the one nearest half, the shallower on a tie", () => {
  const folders = folderCounts(new Map([["apps/s/functions/chat/a.ts", 60], ["apps/s/functions/b.ts", 10], ["apps/s/dev/c.ts", 20], ["scripts/d.ts", 10], ["root.ts", 0]]));
  assert.deepEqual(Object.fromEntries(folders), {
    "apps/": 90,
    "apps/s/": 90,
    "apps/s/functions/": 70,
    "apps/s/functions/chat/": 60,
    "apps/s/dev/": 20,
    "scripts/": 10,
  });
  assert.deepEqual(bestCut(folders, 100), { folder: "apps/s/functions/chat/", n: 60 }, "|60-50| beats |70-50| and |90-50|");
  assert.deepEqual(bestCut(new Map([["a/", 40], ["a/b/", 40], ["c/", 60]]), 100), { folder: "a/", n: 40 }, "a tie keeps the shallower, first");
  assert.equal(bestCut(new Map([["a/", 100]]), 100), null, "one folder holding everything is no cut");
});

test("main: runs the repo's size step once per file and prints the counts and the cut (fallback size step)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursory-split-"));
  try {
    writeFileSync(join(dir, "d.patch"), file("apps/chat/a.ts", 6) + file("apps/chat/b.ts", 2) + file("scripts/c.ts", 4) + file("apps/chat/a.test.ts", 9));
    const out: string[] = [];
    assert.equal(await main(["--diff-file", "d.patch"], dir, (l) => out.push(l)), 0);
    assert.deepEqual(out, ["total 12 counted lines · half 6", "apps/ 8", "apps/chat/ 8", "scripts/ 4", "cut: slice 1 = apps/ (8) · slice 2 = the rest (4)"]);
    assert.equal(await main([], dir, () => {}), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
