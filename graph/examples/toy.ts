/**
 * The toy graph the engine's tests and `build-graph start` run: an agent plans, a classifier decides
 * whether a reviewer reads the plan, a fixer (in its own worktree, its commits merged back into the run
 * tree) and a check loop until the check passes, and a data node opens the PR only when the loop ended
 * clean. It is not /build.
 */

import { defineGraph } from "../define.ts";

const MINUTE = 60_000;

export const graph = defineGraph({
  id: "toy",
  data: [
    { id: "request", schema: "text", boundary: "input" },
    { id: "plan", schema: "files" },
    { id: "review-call", schema: "verdict" },
    { id: "review", schema: "files" },
    { id: "code", schema: "files" },
    { id: "fix-commit", schema: "ref" },
    { id: "fix-head", schema: "ref" },
    { id: "test-report", schema: "check" },
    { id: "fix-outcome", schema: "outcome" },
    { id: "pr", schema: "ref", boundary: "terminal" },
  ],
  nodes: [
    {
      id: "plan",
      doc: "Reads the request and writes a plan.",
      kind: "agent",
      role: "planner",
      inputs: ["request"],
      outputs: ["plan"],
      timeCapMs: 10 * MINUTE,
    },
    {
      id: "needs-review",
      doc: "Reads the plan and says whether a reviewer reads it.",
      kind: "classifier",
      role: "needs-review",
      inputs: ["plan"],
      outputs: ["review-call"],
      timeCapMs: MINUTE,
    },
    {
      id: "review",
      doc: "Reads the plan and writes a review; runs when needs-review says yes.",
      kind: "agent",
      role: "reviewer",
      inputs: ["plan"],
      outputs: ["review"],
      gate: { classifier: "needs-review", answer: "yes" },
      timeCapMs: 10 * MINUTE,
    },
    {
      id: "fix",
      doc: "Reads the plan, with the review and the last test report when present, and writes the code and a commit in its own worktree; runs once per iteration of the fix loop.",
      kind: "agent",
      role: "fixer",
      inputs: ["plan"],
      optionalInputs: ["review", "test-report"],
      outputs: ["code", "fix-commit"],
      writes: true,
      timeCapMs: 10 * MINUTE,
    },
    {
      id: "merge-fix",
      doc: "Merges the fixer's commit into the run tree and writes the new head; runs once per iteration of the fix loop.",
      kind: "data",
      role: "merge-back",
      inputs: ["fix-commit"],
      outputs: ["fix-head"],
      timeCapMs: MINUTE,
    },
    {
      id: "tests",
      doc: "Checks the code at the merged head and writes the test report; a pass ends the fix loop, which runs at most 3 times.",
      kind: "check",
      role: "tests",
      inputs: ["code", "fix-head"],
      outputs: ["test-report"],
      timeCapMs: 5 * MINUTE,
    },
    {
      id: "open-pr",
      doc: "Opens a PR for the code; runs only when the fix loop ended clean.",
      kind: "data",
      role: "pr",
      inputs: ["code", "test-report"],
      outputs: ["pr"],
      gate: { loop: "fix-loop", answer: "clean" },
      timeCapMs: MINUTE,
    },
  ],
  loops: [{ id: "fix-loop", nodes: ["fix", "merge-fix", "tests"], until: { node: "tests", answer: "pass" }, cap: 3, carry: ["test-report"], outcome: "fix-outcome" }],
});
