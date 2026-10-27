import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { ContractError, isPathUnder, parseAttemptRecord, parseDataValue, parseOutputs } from "../contracts.ts";
import { graph as toy } from "../examples/toy.ts";

const issuesOf = (f: () => unknown): string[] => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof ContractError, `expected ContractError, got ${String(e)}`);
    return e.issues.map((i) => i.message);
  }
  assert.fail("did not throw");
};

test("each schema accepts its well-formed value and returns it", () => {
  assert.deepEqual(parseDataValue({ schema: "text", text: "hi" }, "text", "t"), { schema: "text", text: "hi" });
  assert.deepEqual(parseDataValue({ schema: "files", files: ["/a", "/b"] }, "files", "f"), { schema: "files", files: ["/a", "/b"] });
  assert.deepEqual(parseDataValue({ schema: "verdict", answer: "yes", p: 0.5 }, "verdict", "v"), { schema: "verdict", answer: "yes", p: 0.5 });
  assert.deepEqual(parseDataValue({ schema: "check", answer: "fail", detail: "d" }, "check", "c"), { schema: "check", answer: "fail", detail: "d" });
  assert.deepEqual(parseDataValue({ schema: "ref", kind: "pr", id: "1", url: "u" }, "ref", "r"), { schema: "ref", kind: "pr", id: "1", url: "u" });
});

test("a ref without a url has no url key; extra keys are dropped", () => {
  const v = parseDataValue({ schema: "ref", kind: "ticket", id: "T-1", junk: 1 }, "ref", "r");
  assert.deepEqual(v, { schema: "ref", kind: "ticket", id: "T-1" });
  assert.ok(!("url" in v));
});

test("a value tagged with another schema than declared is refused", () => {
  assert.deepEqual(issuesOf(() => parseDataValue({ schema: "files", files: [] }, "text", "plan")), ["data plan schema: expected text", "data plan text: expected a string"]);
});

test("verdict p is bounded to [0, 1] inclusive and must be a number", () => {
  for (const p of [0, 1]) parseDataValue({ schema: "verdict", answer: "a", p }, "verdict", "v");
  for (const p of [-0.1, 1.1, "0.5", null, Number.NaN]) {
    assert.deepEqual(issuesOf(() => parseDataValue({ schema: "verdict", answer: "a", p }, "verdict", "v")), ["data v p: expected a number in [0, 1]"]);
  }
});

test("check answer must be pass or fail; ref kind must be a known kind", () => {
  assert.match(issuesOf(() => parseDataValue({ schema: "check", answer: "maybe", detail: "" }, "check", "c"))[0]!, /answer: expected one of pass \| fail/);
  assert.match(issuesOf(() => parseDataValue({ schema: "ref", kind: "branch", id: "x" }, "ref", "r"))[0]!, /kind: expected one of ticket \| commit \| pr \| merge/);
});

test("files must be an array of strings, naming the bad index", () => {
  assert.deepEqual(issuesOf(() => parseDataValue({ schema: "files", files: ["/a", 2] }, "files", "f")), ["data f files[1]: expected a string"]);
  assert.deepEqual(issuesOf(() => parseDataValue({ schema: "files", files: "/a" }, "files", "f")), ["data f files: expected an array"]);
});

test("a non-object value is refused, and a non-string url is too", () => {
  assert.match(issuesOf(() => parseDataValue("text", "text", "t"))[0]!, /\(root\): expected an object/);
  assert.match(issuesOf(() => parseDataValue(null, "text", "t"))[0]!, /\(root\): expected an object/);
  assert.match(issuesOf(() => parseDataValue({ schema: "ref", kind: "pr", id: "1", url: 3 }, "ref", "r"))[0]!, /url: expected a string/);
});

test("every bad field is reported at once", () => {
  assert.equal(issuesOf(() => parseDataValue({ schema: "check", answer: "x", detail: 1 }, "check", "c")).length, 2);
});

const plan = { schema: "files", files: ["/p"] };

test("parseOutputs validates each declared output against the graph's schema for it", () => {
  const node = toy.nodes.find((n) => n.id === "plan")!;
  assert.deepEqual(parseOutputs(toy, node, { plan }), { plan });
});

test("parseOutputs refuses an output the node did not write", () => {
  const node = toy.nodes.find((n) => n.id === "plan")!;
  assert.deepEqual(issuesOf(() => parseOutputs(toy, node, {})), ["node plan: did not write plan"]);
});

test("parseOutputs refuses an undeclared output even when the declared one is fine", () => {
  const node = toy.nodes.find((n) => n.id === "plan")!;
  assert.deepEqual(issuesOf(() => parseOutputs(toy, node, { plan, extra: plan })), ["node plan: wrote extra, which it does not declare"]);
});

test("parseOutputs refuses a node whose declared output is not a data item", () => {
  const node = { ...toy.nodes.find((n) => n.id === "plan")!, outputs: ["ghost"] };
  assert.deepEqual(issuesOf(() => parseOutputs(toy, node, { ghost: plan })), ["node plan: output ghost is not a data item"]);
});

test("parseOutputs carries a wrong-schema value's issues, with the output id", () => {
  const node = toy.nodes.find((n) => n.id === "plan")!;
  const msgs = issuesOf(() => parseOutputs(toy, node, { plan: { schema: "text", text: "x" } }));
  assert.ok(msgs.every((m) => m.startsWith("data plan ")), msgs.join("\n"));
  assert.ok(msgs.length >= 1);
});

test("parseOutputs collects issues across outputs and does not throw for an inherited key name", () => {
  const node = { ...toy.nodes.find((n) => n.id === "plan")!, outputs: ["plan", "code"] };
  assert.deepEqual(issuesOf(() => parseOutputs(toy, node, { toString: plan } as Record<string, unknown>)).sort(), [
    "node plan: did not write code",
    "node plan: did not write plan",
    "node plan: wrote toString, which it does not declare",
  ]);
});

test("files: at least one, and with a run dir every path lies under it", () => {
  assert.deepEqual(issuesOf(() => parseDataValue({ schema: "files", files: [] }, "files", "plan")), ["data plan files: expected at least one file"]);
  assert.deepEqual(parseDataValue({ schema: "files", files: ["/runs/r1/nodes/a.md"] }, "files", "plan", "/runs/r1"), { schema: "files", files: ["/runs/r1/nodes/a.md"] });
  assert.deepEqual(issuesOf(() => parseDataValue({ schema: "files", files: ["/etc/passwd", "/runs/r1/../r2/x"] }, "files", "plan", "/runs/r1")), [
    "data plan files[0]: expected a path under the run dir /runs/r1, got /etc/passwd",
    "data plan files[1]: expected a path under the run dir /runs/r1, got /runs/r1/../r2/x",
  ]);
  assert.match(issuesOf(() => parseOutputs(toy, toy.nodes[0]!, { plan: { schema: "files", files: ["/elsewhere/p.md"] } }, "/runs/r1"))[0]!, /under the run dir/);
});

test("isPathUnder: a prefix that is not a folder boundary, the dir itself, and dot segments are not under", () => {
  assert.equal(isPathUnder("/runs/r1/a", "/runs/r1/"), true);
  assert.equal(isPathUnder("/runs/r10/a", "/runs/r1"), false);
  assert.equal(isPathUnder("/runs/r1", "/runs/r1"), false);
  assert.equal(isPathUnder("/runs/r1/./a", "/runs/r1"), false);
});

test("an outcome value is one of the loop outcomes", () => {
  assert.deepEqual(parseDataValue({ schema: "outcome", answer: "capped" }, "outcome", "o"), { schema: "outcome", answer: "capped" });
  assert.deepEqual(issuesOf(() => parseDataValue({ schema: "outcome", answer: "red" }, "outcome", "o")), ["data o answer: expected one of clean | capped | aborted"]);
});

const attemptRecord = { node: "A-builder", iteration: 0, rerun: 1, attempt: 1, startedAt: "2026-10-20T10:00:00.000Z" };

test("an attempt record retains a merge conflict with or without the writer restart", () => {
  assert.deepEqual(parseAttemptRecord({ ...attemptRecord, conflict: { commit: "abc123", paths: ["graph/stats.ts"], restart: 1 } }), {
    ...attemptRecord,
    conflict: { commit: "abc123", paths: ["graph/stats.ts"], restart: 1 },
  });
  assert.deepEqual(parseAttemptRecord({ ...attemptRecord, conflict: { commit: "abc123", paths: ["graph/stats.ts"] } }), {
    ...attemptRecord,
    conflict: { commit: "abc123", paths: ["graph/stats.ts"] },
  });
  assert.ok(!("conflict" in parseAttemptRecord(attemptRecord)));
});

test("an attempt record names invalid merge-conflict paths and restart values", () => {
  for (const conflict of [
    { commit: "abc123", paths: [], restart: 1 },
    { commit: "abc123", paths: ["graph/stats.ts"], restart: 0 },
    { commit: "abc123", paths: ["graph/stats.ts"], restart: "1" },
  ]) {
    const issues = issuesOf(() => parseAttemptRecord({ ...attemptRecord, conflict }));
    assert.ok(issues.some((issue) => issue.includes(conflict.paths.length === 0 ? "conflict.paths" : "conflict.restart")), issues.join("\n"));
  }
});
