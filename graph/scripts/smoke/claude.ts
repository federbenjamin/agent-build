/**
 * Live smoke for the Claude Code agent runner: one `claude -p --agent` call on Haiku, from a
 * throwaway repo with a project agent that writes one file. Not run in CI.
 *
 *   node graph/scripts/smoke/claude.ts
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeAgent } from "../../adapters/claudeAgent.ts";
import { CLAUDE_RESULT_FILE } from "../../constants.ts";

const root = mkdtempSync(join(tmpdir(), "graph-smoke-claude-"));
const worktree = join(root, "worktree");
execFileSync("git", ["init", "-q", worktree]);
mkdirSync(join(worktree, ".claude", "agents"), { recursive: true });
writeFileSync(
  join(worktree, ".claude", "agents", "smoke.md"),
  "---\nname: smoke\ndescription: Writes one greeting file for the adapter smoke test.\nmodel: haiku\n---\n\nYou write the file the task names, with the content it asks for, and nothing else. No commentary.\n"
);

const outDir = join(root, "nodes", "smoke", "0", "out");
const started = Date.now();
const result = await claudeAgent({ adapter: "claude", model: "haiku" }).run({
  runId: "smoke",
  nodeId: "A-smoke",
  role: "smoke",
  inputs: { request: { schema: "text", text: "Write the single word hello to greeting.txt in the output folder." } },
  answers: [],
  outputs: ["greeting"],
  outDir,
  worktree,
  writes: true,
  attempt: 1,
  iteration: 0,
  signal: AbortSignal.timeout(180_000),
});

const cli = JSON.parse(readFileSync(join(root, "nodes", "smoke", "0", CLAUDE_RESULT_FILE), "utf8")) as { total_cost_usd?: number; num_turns?: number; permission_denials?: unknown[] };
console.log(JSON.stringify({ result, content: result.status === "done" ? Object.values(result.files).flat().map((f) => readFileSync(f, "utf8")) : null, costUsd: cli.total_cost_usd, turns: cli.num_turns, denials: cli.permission_denials, ms: Date.now() - started }, null, 2));
rmSync(root, { recursive: true, force: true });
