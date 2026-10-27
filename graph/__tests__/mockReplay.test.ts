/** The mock replay's fitting of a recorded fixer file and a recorded stage read to the rows a run with
 *  real classifiers hands them. */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { fitFixFile, fitStageFile } from "../mock/replay.ts";

test("a recorded fix file keeps its rows of this table, gives a row with no line the line that names it, else drops it", () => {
  const recorded = [
    "CURSORY.1 · fixed · abc — the test now covers it",
    "HUNTER.1 · fixed · abc — guard added; COMMENT.7 asked the same",
    "SIMP.2 · dropped — a matter of taste",
    "",
    "exit checks:",
    "vacuity: CURSORY.1 — mutated, red",
  ].join("\n");
  const { text, changes } = fitFixFile(recorded, ["CURSORY.1", "COMMENT.7", "VERIFIER.2"]);
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 3), [
    "CURSORY.1 · fixed · abc — the test now covers it",
    "COMMENT.7 · fixed · abc — guard added; COMMENT.7 asked the same",
    "VERIFIER.2 · dropped — mock replay: the recorded fixer answered this row inside a row of a reader the classifiers skipped (HUNTER.1, SIMP.2)",
  ]);
  assert.deepEqual(lines.slice(3), ["", "exit checks:", "vacuity: CURSORY.1 — mutated, red"], "the exit checks stay as recorded");
  assert.deepEqual(changes, [
    "HUNTER.1: line dropped, not a row of this round's table",
    "SIMP.2: line dropped, not a row of this round's table",
    "COMMENT.7: takes HUNTER.1's line, which names it",
    "VERIFIER.2: dropped, no recorded line names it",
  ]);
  assert.deepEqual(fitFixFile(recorded, ["CURSORY.1", "HUNTER.1", "SIMP.2"]).changes, [], "a file that matches the table is left alone");
});

test("a recorded stage read gets a status line for each given row it does not answer, under the rows it does", () => {
  const recorded = ["## Status", "- CURSORY.1 · resolved", "", "## New", "", "NO FINDINGS"].join("\n");
  const given = [{ id: "CURSORY.1", line: "fixed" }, { id: "SESSION.1", line: "fixed" }, { id: "VERIFIER.2", line: "dropped" }, { id: "COMMENT.7", also: ["HUNTER.1"], line: "fixed" }];
  const answered = `${recorded.replace("- CURSORY.1 · resolved", "- CURSORY.1 · resolved\n- HUNTER.1 · resolved")}`;
  const { text, added } = fitStageFile(answered, given);
  assert.deepEqual(added, ["SESSION.1", "VERIFIER.2"], "a row answered under a merged id counts as answered");
  assert.deepEqual(text.split("\n"), [
    "## Status",
    "- CURSORY.1 · resolved",
    "- HUNTER.1 · resolved",
    "- SESSION.1 · resolved — mock replay: the recorded read was not given this row",
    "- VERIFIER.2 · agree — mock replay: the recorded read was not given this row",
    "",
    "## New",
    "",
    "NO FINDINGS",
  ]);
  const none = fitStageFile(["## Status", "- none", "", "## New", "NO FINDINGS"].join("\n"), [{ id: "SESSION.1", line: "fixed" }]);
  assert.equal(none.text, ["## Status", "- SESSION.1 · resolved — mock replay: the recorded read was not given this row", "", "## New", "NO FINDINGS"].join("\n"), "a `- none` placeholder gives way");
  assert.deepEqual(fitStageFile(recorded, [{ id: "CURSORY.1", line: "fixed" }]), { text: recorded, added: [] });
});
