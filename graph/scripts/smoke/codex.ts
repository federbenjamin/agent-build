/**
 * Live smoke for the Codex agent runner: one `codex exec` of a read-only role defined by a toml in a
 * throwaway tree. Its inputs file and the request file it names both sit outside the worktree, as a
 * graph run's do, so the reply shows whether a read-only role can read them (`read`). Not run in CI.
 * CODEX_SMOKE_MODEL overrides the model.
 *
 *   node graph/scripts/smoke/codex.ts
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexAgent } from "../../adapters/codexAgent.ts";

const root = mkdtempSync(join(tmpdir(), "graph-smoke-codex-"));
const worktree = join(root, "worktree");
execFileSync("git", ["init", "-q", worktree]);
mkdirSync(join(worktree, ".codex", "agents"), { recursive: true });
writeFileSync(
  join(worktree, ".codex", "agents", "smoke.toml"),
  [
    `model = ${JSON.stringify(process.env.CODEX_SMOKE_MODEL ?? "gpt-5.6-terra")}`,
    'model_reasoning_effort = "low"',
    'sandbox_mode = "read-only"',
    `developer_instructions = ${JSON.stringify("Read your input file, then answer in one short line.")}`,
    "",
  ].join("\n")
);

const WORD = "plover";
const request = join(root, "inputs", "request.md");
mkdirSync(join(root, "inputs"), { recursive: true });
writeFileSync(request, `Reply with the single word ${WORD}.\n`);

const started = Date.now();
const result = await codexAgent({ adapter: "codex" }).run({
  runId: "smoke",
  nodeId: "A-smoke",
  role: "smoke",
  inputs: { request: { schema: "files", files: [request] } },
  answers: [],
  outputs: ["reply"],
  outDir: join(root, "nodes", "smoke", "0", "out"),
  worktree,
  writes: false,
  attempt: 1,
  iteration: 0,
  signal: AbortSignal.timeout(180_000),
});
const content = result.status === "done" ? Object.values(result.files).flat().map((f) => readFileSync(f, "utf8")) : null;
console.log(JSON.stringify({ result, content, read: content?.some((c) => c.toLowerCase().includes(WORD)) ?? false, ms: Date.now() - started }, null, 2));
rmSync(root, { recursive: true, force: true });
