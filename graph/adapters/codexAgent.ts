/**
 * The Codex agent runner: `codex exec -C <worktree> -s <sandbox> -o <out> -` with the role's
 * instructions on stdin. The role, its sandbox, and the argv come from `runtime/codexRole.ts`, the
 * one launcher of a role on Codex. A writing role writes its outputs as files, as a Claude agent
 * does. A read-only role cannot write them, so its final message is its one output. The run's
 * `--json` events give its token counts, kept with the role's model in `codex.json` beside `out/`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codexEnv, codexPrompt, planCodexRole } from "../../runtime/codexRole.ts";
import { CODEX_LAST_MESSAGE_FILE, CODEX_REPORT_FILE } from "../constants.ts";
import { type CodexAgentBinding, ContractError, RunError } from "../contracts.ts";
import { agentDirs, agentEnv, agentPrompt, attemptDir, collectOutputs, filesUnder, tail, writeCodexUsage, writeInputsFile } from "./agentIo.ts";
import { type ProcessRunner, runProcess } from "./process.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "./types.ts";

export interface CodexAgentDeps {
  run?: ProcessRunner;
  /** Where roles resolve from (`planCodexRole`'s seams). */
  roles?: Parameters<typeof planCodexRole>[2];
  env?: NodeJS.ProcessEnv;
}

/** Why `role` cannot run on Codex from `repo`, or null when its Codex role resolves. */
export function codexRoleMissing(binding: CodexAgentBinding, role: string, repo: string, roles?: CodexAgentDeps["roles"]): string | null {
  const name = binding.role ?? role;
  if (planCodexRole(name, { tree: repo, out: join(repo, CODEX_LAST_MESSAGE_FILE) }, roles) !== null) return null;
  return `role ${role} runs the Codex role ${name}, which does not resolve: no .codex/agents/${name}.toml in the repo or the home directory, and no ${name} row in this package's agents.json`;
}

export function codexAgent(binding: CodexAgentBinding, deps: CodexAgentDeps = {}): AgentRunner {
  const run = deps.run ?? runProcess;
  return {
    async run(req: AgentRequest): Promise<AgentResult> {
      mkdirSync(req.outDir, { recursive: true });
      const lastMessage = join(attemptDir(req), CODEX_LAST_MESSAGE_FILE);
      rmSync(lastMessage, { force: true });
      const name = binding.role ?? req.role;
      const plan = planCodexRole(name, { tree: req.worktree, out: lastMessage, addDirs: agentDirs(req), json: true }, deps.roles);
      if (plan === null) throw new RunError(`codex: unknown role ${name}`);
      const mode = plan.sandbox === "read-only" ? "last-message" : "files";
      if (mode === "last-message" && req.outputs.length !== 1) {
        throw new ContractError([{ message: `codex role ${name} is read-only, so its final message is its one output; the node declares ${req.outputs.length}` }]);
      }
      const inputs = writeInputsFile(req);
      const r = await run("codex", plan.args, {
        cwd: req.worktree,
        input: codexPrompt(plan.pins.instructions, agentPrompt(req, inputs, mode)),
        env: codexEnv(agentEnv(req, deps.env ?? process.env)),
        signal: req.signal,
        ...(req.onSpawn === undefined ? {} : { onSpawn: req.onSpawn }),
      });
      writeCodexUsage(attemptDir(req), plan.pins.model, r.stdout);
      if (r.code !== 0) throw new Error(`codex exited ${r.code ?? "on a signal"}: ${tail(r.stderr || r.stdout)}`);
      if (mode === "files") return collectOutputs(req);

      const text = existsSync(lastMessage) ? readFileSync(lastMessage, "utf8").trim() : "";
      if (text === "") throw new ContractError([{ message: `codex role ${name} wrote no final message to ${lastMessage}` }]);
      const id = req.outputs[0]!;
      mkdirSync(join(req.outDir, id), { recursive: true });
      writeFileSync(join(req.outDir, id, CODEX_REPORT_FILE), `${text}\n`);
      return { status: "done", files: { [id]: filesUnder(join(req.outDir, id)) } };
    },
  };
}
