/**
 * The Claude Code agent runner: `claude -p --agent <plugin>:<role> --output-format json` in the
 * node's worktree. The agent reads the inputs file and writes its outputs; this adapter checks
 * that they exist. `git push` and `gh pr` are denied by flag, since the plugin's no-push guard
 * passes a main session. The activity heartbeats around the call; an abort kills the process.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLAUDE_DEFAULT_PERMISSION_MODE, CLAUDE_DISALLOWED_TOOLS, CLAUDE_RESULT_FILE } from "../constants.ts";
import { type ClaudeAgentBinding, RunError } from "../contracts.ts";
import { sessionName } from "../runKeys.ts";
import { agentDirs, agentEnv, agentPrompt, attemptDir, collectOutputs, realOrGiven, tail, writeInputsFile } from "./agentIo.ts";
import { type ProcessRunner, runProcess } from "./process.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "./types.ts";

export interface ClaudeAgentDeps {
  run?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
}

/** The edit tools a reader may not use inside its worktree (the real path: a rule matches it). Its
 *  out dir stays writable, and Bash is not covered; the worktree being the reader's own is what keeps
 *  its writes out of the run. */
function readerDenials(worktree: string): string[] {
  const real = realOrGiven(worktree);
  return ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(/${real}/**)`);
}

/** The `--agent` a run spawns: the role in the binding's plugin, or with `agentFromItem` the fan-out
 *  item, a project agent the repo names. */
function agentName(binding: ClaudeAgentBinding, req: Pick<AgentRequest, "role" | "instance">): string {
  if (binding.agentFromItem === true) {
    if (req.instance === undefined) throw new RunError(`role ${req.role} takes its agent from the fan-out item, and this run has none`);
    return req.instance;
  }
  return binding.plugin === undefined ? req.role : `${binding.plugin}:${req.role}`;
}

/** The argv of one agent run (the prompt goes in on stdin). The session takes the node run's name
 *  (`sessionName`), so a peer can message it. The agent reaches its attempt folder, its input files'
 *  folders and the plugin's docs (`agentDirs`) through `--add-dir`; without one, the CLI refuses every
 *  read outside the worktree. */
export function claudeAgentArgs(binding: ClaudeAgentBinding, req: Pick<AgentRequest, "runId" | "nodeId" | "iteration" | "role" | "instance" | "inputs" | "outDir" | "worktree" | "writes" | "model">): string[] {
  const agent = agentName(binding, req);
  const model = req.model ?? binding.model;
  return [
    "-p",
    "-n",
    sessionName(req.runId, req.nodeId, req.iteration, req.instance),
    "--agent",
    agent,
    "--output-format",
    "json",
    "--permission-mode",
    binding.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
    "--disallowedTools",
    [...CLAUDE_DISALLOWED_TOOLS, ...(req.writes ? [] : readerDenials(req.worktree))].join(","),
    ...agentDirs(req).flatMap((d) => ["--add-dir", d]),
    ...(model === undefined ? [] : ["--model", model]),
  ];
}

/** The plugin this graph package ships in: the checkout above `graph/`. */
const PLUGIN_ROOT = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "..");

/** Why `role` cannot run as a Claude agent from `repo`, or null when its agent exists: in a plugin,
 *  only the plugin this package ships in can be checked (its `agents/<role>.md`); without one, a
 *  project or user agent (`.claude/agents/<role>.md`). */
export function claudeRoleMissing(binding: ClaudeAgentBinding, role: string, repo: string, where: { pluginRoot: string; home: string } = { pluginRoot: PLUGIN_ROOT, home: homedir() }): string | null {
  if (binding.plugin === undefined) {
    const dirs = [join(repo, ".claude", "agents"), join(where.home, ".claude", "agents")];
    return dirs.some((d) => existsSync(join(d, `${role}.md`))) ? null : `role ${role} has no Claude agent: no ${role}.md in ${dirs.join(" or ")}`;
  }
  let shipped: string | undefined;
  try {
    shipped = (JSON.parse(readFileSync(join(where.pluginRoot, ".claude-plugin", "plugin.json"), "utf8")) as { name?: string }).name;
  } catch {
    shipped = undefined;
  }
  if (shipped !== binding.plugin) return `role ${role} is bound to the Claude plugin ${binding.plugin}, which is not the plugin this graph ships in (${shipped ?? "none"}), so its agents cannot be checked`;
  return existsSync(join(where.pluginRoot, "agents", `${role}.md`)) ? null : `role ${role} has no agent in the Claude plugin ${binding.plugin}: no agents/${role}.md`;
}

/** The CLI's JSON result, or why it is not one. */
function parseResult(stdout: string): { is_error?: boolean; result?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude printed no JSON result: ${tail(stdout, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`claude printed no JSON result object: ${tail(stdout, 200)}`);
  return parsed as { is_error?: boolean; result?: unknown };
}

export function claudeAgent(binding: ClaudeAgentBinding, deps: ClaudeAgentDeps = {}): AgentRunner {
  const run = deps.run ?? runProcess;
  return {
    async run(req: AgentRequest): Promise<AgentResult> {
      mkdirSync(req.outDir, { recursive: true });
      const inputs = writeInputsFile(req);
      const r = await run("claude", claudeAgentArgs(binding, req), {
        cwd: req.worktree,
        input: agentPrompt(req, inputs, "files"),
        env: agentEnv(req, deps.env ?? process.env),
        signal: req.signal,
        ...(req.onSpawn === undefined ? {} : { onSpawn: req.onSpawn }),
      });
      writeFileSync(join(attemptDir(req), CLAUDE_RESULT_FILE), r.stdout);
      if (r.code !== 0) throw new Error(`claude exited ${r.code ?? "on a signal"}: ${tail(r.stderr || r.stdout)}`);
      const result = parseResult(r.stdout);
      if (result.is_error === true) throw new Error(`claude reported an error: ${tail(String(result.result ?? ""))}`);
      return collectOutputs(req);
    },
  };
}
