/** The run-dir reader (`runDirs.ts`): what it finds under a node run's output folder. */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { FIXER_NODE } from "../pipelines/build.ts";
import { readRunDir } from "../runDirs.ts";

test("a fixer's crosstalk.jsonl is found where the fixer writes it and keyed by its node run", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-rundirs-"));
  try {
    const put = (rel: string, body: string): void => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    const log = '{"at":"t","to":"S2","session":"x","text":"hi"}\n';
    put(`nodes/${FIXER_NODE}/2/S1/out/slice-fix/crosstalk.jsonl`, log);
    // Deeper than an output folder's own files: not the fixer's log.
    put(`nodes/${FIXER_NODE}/2/S1/out/slice-fix/deep/crosstalk.jsonl`, "ignored\n");
    put(`nodes/${FIXER_NODE}/2/S1/rerun-0/attempt-1.json`, JSON.stringify({ node: FIXER_NODE, iteration: 2, instance: "S1", rerun: 0, attempt: 1, startedAt: "2026-10-20T10:00:00.000Z" }));
    const data = readRunDir(dir);
    assert.deepEqual(data.crosstalk, [{ key: `nodes/${FIXER_NODE}/2/S1`, file: `nodes/${FIXER_NODE}/2/S1/out/slice-fix/crosstalk.jsonl`, text: log }]);
    assert.equal(data.attempts.length, 1);
    assert.deepEqual(data.problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run dir with no crosstalk file reads an empty list", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-rundirs-"));
  try {
    assert.deepEqual(readRunDir(dir).crosstalk, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
