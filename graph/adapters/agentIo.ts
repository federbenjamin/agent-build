/**
 * What every real agent runner does around its process: write the inputs file, say in the prompt
 * where to read and where to write, then read back what the agent left (its outputs, or a question).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { AGENT_DOCS_DIR, AGENT_GH_CONFIG_DIR, AGENT_INPUTS_FILE, AGENT_QUESTION_FILE, AGENT_STRIPPED_ENV, CLAUDE_RESULT_FILE, CODEX_RESULT_FILE } from "../constants.ts";
import { ContractError, type InputsFile, type TokenCounts } from "../contracts.ts";
import { childEnv } from "./process.ts";
import type { AgentRequest, AgentResult } from "./types.ts";

/** Every file under `dir`, absolute and sorted. */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

/** The folder beside `out/` that holds the node's attempt files (the inputs file, the CLI's own output). */
export const attemptDir = (req: Pick<AgentRequest, "outDir">): string => dirname(req.outDir);

/** `path` with its links resolved when it exists, else as given: a CLI's permission rule matches the
 *  real path. */
export function realOrGiven(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The folders outside its worktree an agent run reaches, in order and once each: its attempt folder
 *  (the inputs file, its out dir), the folder of every file its inputs name, and the installed plugin's
 *  docs (`AGENT_DOCS_DIR`), as the link and as the real folder, so a read by either path passes. */
export function agentDirs(req: Pick<AgentRequest, "outDir" | "inputs">, home = homedir()): string[] {
  const docs = join(home, ...AGENT_DOCS_DIR);
  const inputDirs = Object.values(req.inputs).flatMap((v) => (v.schema === "files" ? v.files.map((f) => dirname(f)) : []));
  return [...new Set([attemptDir(req), ...inputDirs, docs, realOrGiven(docs)])];
}

/** The environment an agent process gets: no adapter API key, no forge token, and `gh` pointed at an
 *  empty config folder, so it holds no login. Pushing is also blocked in the agent's worktree
 *  (`addNodeWorktree`); the Claude deny rules are a third layer. */
export function agentEnv(req: Pick<AgentRequest, "outDir">, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = childEnv(base);
  for (const k of AGENT_STRIPPED_ENV) delete env[k];
  const ghConfig = join(attemptDir(req), AGENT_GH_CONFIG_DIR);
  rmSync(ghConfig, { recursive: true, force: true });
  mkdirSync(ghConfig, { recursive: true });
  env.GH_CONFIG_DIR = ghConfig;
  return env;
}

/** The agent's dispatch as an inputs file (`docs/graph-agents.md`). */
export function inputsFile(req: AgentRequest): InputsFile {
  return {
    role: req.role,
    iteration: req.iteration,
    ...(req.instance === undefined ? {} : { item: req.instance }),
    worktree: req.worktree,
    inputs: req.inputs,
    outputs: Object.fromEntries(req.outputs.map((id) => [id, `${join(req.outDir, id)}/`])),
    answers: req.answers,
    ...(req.question === undefined ? {} : { question: req.question }),
    ...(req.answer === undefined ? {} : { answer: req.answer }),
    ...(req.conflict === undefined ? {} : { conflict: req.conflict }),
  };
}

/** Write the inputs file beside `out/`; returns its path. */
export function writeInputsFile(req: AgentRequest): string {
  const path = join(attemptDir(req), AGENT_INPUTS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(inputsFile(req), null, 2)}\n`);
  return path;
}

/** How the agent hands its outputs back: as files in `out/<id>/`, or as its final message. */
export type OutputMode = "files" | "last-message";

/** The task prompt: where the inputs file is, where each output goes, and the limits. Same wording
 *  for every runner. */
export function agentPrompt(req: AgentRequest, inputs: string, mode: OutputMode): string {
  const where =
    mode === "files"
      ? `Write each output as files in its own folder under ${req.outDir}: ${req.outputs.map((id) => `${join(req.outDir, id)}/`).join(", ")}. Each folder needs at least one file.\n` +
        `Raise a question the way your agent file's graph-run rules say; an agent file without them writes its question to ${join(req.outDir, AGENT_QUESTION_FILE)} and stops.`
      : `Your final message is your output (${req.outputs.join(", ")}); write nothing else.`;
  return [
    `You are the ${req.role} node of a build graph, working in ${req.worktree}.`,
    `Your dispatch is the inputs file ${inputs}; read it first.`,
    where,
    "Do not push, open or merge a pull request, or ask anyone anything mid-run.",
  ].join("\n");
}

/** What the agent left: its question when it wrote one, else every declared output folder with at
 *  least one file. A missing or empty output breaks the contract. */
export function collectOutputs(req: AgentRequest): AgentResult {
  const question = join(req.outDir, AGENT_QUESTION_FILE);
  if (existsSync(question)) {
    const text = readFileSync(question, "utf8").trim();
    if (text !== "") return { status: "needs-operator", question: text };
  }
  const files: Record<string, string[]> = {};
  const missing: string[] = [];
  for (const id of req.outputs) {
    const dir = join(req.outDir, id);
    const found = existsSync(dir) && statSync(dir).isDirectory() ? filesUnder(dir) : [];
    if (found.length === 0) missing.push(id);
    else files[id] = found;
  }
  if (missing.length > 0) {
    throw new ContractError([{ message: `agent ${req.role} did not write ${missing.map((m) => `${m}/`).join(", ")} under ${req.outDir}` }]);
  }
  return { status: "done", files };
}

/** The tail of a process's output for an error message. */
export const tail = (text: string, n = 600): string => (text.length <= n ? text : `…${text.slice(-n)}`).trim();

/** What an agent CLI reported for one attempt; null where it reported nothing. */
export interface AgentUsage {
  model: string | null;
  tokens: TokenCounts | null;
  costUsd: number | null;
}

const NO_USAGE: AgentUsage = { model: null, tokens: null, costUsd: null };
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const asObject = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** `claude -p --output-format json`'s result: tokens summed over every model it used (`modelUsage`,
 *  else the top-level `usage`), the model that cost the most, and `total_cost_usd`. */
export function claudeUsage(text: string): AgentUsage {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asObject(JSON.parse(text));
  } catch {
    return NO_USAGE;
  }
  if (parsed === null) return NO_USAGE;
  const byModel = Object.entries(asObject(parsed.modelUsage) ?? {}).map(([model, u]) => ({ model, u: asObject(u) ?? {} }));
  const usage = asObject(parsed.usage);
  const tokens: TokenCounts | null =
    byModel.length > 0
      ? byModel.reduce<TokenCounts>(
          (t, { u }) => ({
            input: t.input + count(u.inputTokens),
            output: t.output + count(u.outputTokens),
            cacheRead: t.cacheRead + count(u.cacheReadInputTokens),
            cacheWrite: t.cacheWrite + count(u.cacheCreationInputTokens),
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        )
      : usage === null
        ? null
        : { input: count(usage.input_tokens), output: count(usage.output_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens) };
  const top = [...byModel].sort((a, b) => count(b.u.costUSD) - count(a.u.costUSD))[0];
  const cost = parsed.total_cost_usd;
  return { model: top?.model ?? null, tokens, costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null };
}

/** The token counts of `codex exec --json`'s events: every `turn.completed` usage summed (its
 *  `input_tokens` include the cached ones); null when no turn completed. */
export function codexTokens(events: string): TokenCounts | null {
  let tokens: TokenCounts | null = null;
  for (const line of events.split("\n")) {
    let e: Record<string, unknown> | null;
    try {
      e = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    const u = e?.type === "turn.completed" ? asObject(e.usage) : null;
    if (u === null) continue;
    const t: TokenCounts = tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokens = {
      input: t.input + Math.max(0, count(u.input_tokens) - count(u.cached_input_tokens)),
      output: t.output + count(u.output_tokens),
      cacheRead: t.cacheRead + count(u.cached_input_tokens),
      cacheWrite: t.cacheWrite + count(u.cache_write_input_tokens),
    };
  }
  return tokens;
}

const resultFiles = (dir: string): { claude: string; codex: string } => ({ claude: join(dir, CLAUDE_RESULT_FILE), codex: join(dir, CODEX_RESULT_FILE) });

/** Remove the CLI result files an earlier attempt left in `dir` (the node's attempt folder), so what
 *  `readAgentUsage` reads at the end is this attempt's. */
export function clearAgentUsage(dir: string): void {
  for (const f of Object.values(resultFiles(dir))) rmSync(f, { force: true });
}

/** Keep a Codex attempt's usage in `dir` (`codex.json`), which `readAgentUsage` reads back: the role's
 *  model and the token counts of its `--json` events (`codexTokens`). Codex reports no price. */
export function writeCodexUsage(dir: string, model: string, events: string): void {
  const usage: AgentUsage = { model, tokens: codexTokens(events), costUsd: null };
  writeFileSync(resultFiles(dir).codex, `${JSON.stringify(usage, null, 2)}\n`);
}

/** What the attempt's CLI left in `dir`: Claude's `claude.json`, or the `codex.json` `writeCodexUsage`
 *  kept; all null when it left neither, or left it unreadable. */
export function readAgentUsage(dir: string): AgentUsage {
  const files = resultFiles(dir);
  if (existsSync(files.claude)) return claudeUsage(readFileSync(files.claude, "utf8"));
  if (!existsSync(files.codex)) return NO_USAGE;
  try {
    return JSON.parse(readFileSync(files.codex, "utf8")) as AgentUsage;
  } catch {
    return NO_USAGE;
  }
}
