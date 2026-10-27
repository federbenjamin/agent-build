/**
 * The stub agent runner: copies `<fixtureDir>/<role>/<output id>/` into each declared output. A
 * fixture folder holding `@<key>` folders is keyed: the run takes `@<key>`, its key being the
 * question id for a service run, else `<instance>`, `<iteration>`, or `<instance>@<iteration>`; a
 * writer's fresh run after its merge conflicted adds `@restart-<n>` (`@P2@restart-1`). A writer
 * applies its recorded commits, `<fixtureDir>/<role>/<commits id>/[@<key>/]*.patch`, with `git am` in
 * its worktree; an unkeyed writer fixture on a restart re-applies the first run's patches, which fail
 * on the new head as any patch that does not apply does. With `ask` it first asks the operator; with `hangOnAttempts` it leaves a
 * stray file in the worktree, commits it, and hangs until cancelled, as a hung CLI would. With
 * `replay` it hands each run to the named module's `replayAgent`, which a mock uses to bend the
 * recording (`mock/replay.ts`).
 */

import { cpSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { gitOut, gitTry } from "../../runtime/lib/gitOps.ts";
import { ContractError, type StubAgentBinding } from "../contracts.ts";
import { SNAPSHOT_AUTHOR, SNAPSHOT_EMAIL } from "../constants.ts";
import { snapshotWorktree } from "../worktree.ts";
import { filesUnder } from "./agentIo.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "./types.ts";

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The fixture key of a run: its question for a service, else its item and iteration; then its restart. */
export function fixtureKey(req: Pick<AgentRequest, "instance" | "iteration" | "question" | "conflict">): string | undefined {
  const parts =
    req.question !== undefined ? [req.question.id] : [...(req.instance === undefined ? [] : [req.instance]), ...(req.iteration > 0 ? [String(req.iteration)] : [])];
  if (req.conflict !== undefined) parts.push(`restart-${req.conflict.restart}`);
  return parts.length === 0 ? undefined : parts.join("@");
}

/** The folder a run copies from: `base` itself, or its `@<key>` folder when `base` is keyed. */
export function fixtureFolder(base: string, key: string | undefined, what: string): string {
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new ContractError([{ message: `${what}: no fixture folder ${base}` }]);
  if (!readdirSync(base).some((n) => n.startsWith("@"))) return base;
  const dir = join(base, `@${key ?? ""}`);
  if (key === undefined || !existsSync(dir)) throw new ContractError([{ message: `${what}: ${base} is keyed and has no @${key ?? "(no key)"}` }]);
  return dir;
}

/** Apply a writer's recorded commits, in name order, on its worktree. */
function applyCommits(dir: string, worktree: string, what: string): void {
  const patches = readdirSync(dir).filter((f) => f.endsWith(".patch")).sort().map((f) => join(dir, f));
  if (patches.length === 0) return;
  const ident = ["-c", `user.name=${SNAPSHOT_AUTHOR}`, "-c", `user.email=${SNAPSHOT_EMAIL}`];
  if (gitTry([...ident, "am", "-q", "--keep-cr", "--empty=keep", "--committer-date-is-author-date", ...patches], { cwd: worktree }) === null) {
    gitTry(["am", "--abort"], { cwd: worktree });
    throw new ContractError([{ message: `${what}: its recorded commits in ${dir} do not apply at ${gitOut(["rev-parse", "--short", "HEAD"], { cwd: worktree }).trim()}` }]);
  }
}

const replays = new Map<string, Promise<{ replayAgent?: (b: StubAgentBinding) => AgentRunner }>>();

export function stubAgent(binding: StubAgentBinding): AgentRunner {
  return {
    async run(req: AgentRequest): Promise<AgentResult> {
      if (binding.replay !== undefined) {
        let m = replays.get(binding.replay);
        if (m === undefined) replays.set(binding.replay, (m = import(pathToFileURL(binding.replay).href)));
        const replayAgent = (await m).replayAgent;
        if (replayAgent === undefined) throw new ContractError([{ message: `${binding.replay} exports no replayAgent` }]);
        return replayAgent(binding).run(req);
      }
      if (binding.hangOnAttempts?.includes(req.attempt)) {
        writeFileSync(join(req.worktree, `.stub-${req.role}-attempt-${req.attempt}`), "left by a hung attempt\n");
        snapshotWorktree(req.worktree, `stub ${req.role}: half-made work of attempt ${req.attempt}`);
        return untilAborted(req.signal);
      }
      if (binding.ask !== undefined && req.answers.length === 0) return { status: "needs-operator", question: binding.ask };
      const key = fixtureKey(req);
      const what = `stub agent ${req.role}`;
      if (req.commits !== undefined) {
        const base = join(binding.fixtureDir, req.role, req.commits);
        if (existsSync(base)) applyCommits(fixtureFolder(base, key, what), req.worktree, what);
      }
      const files: Record<string, string[]> = {};
      for (const id of req.outputs) {
        const src = fixtureFolder(join(binding.fixtureDir, req.role, id), key, `${what} output ${id}`);
        const dest = join(req.outDir, id);
        cpSync(src, dest, { recursive: true });
        files[id] = filesUnder(dest);
      }
      return { status: "done", files };
    },
  };
}
