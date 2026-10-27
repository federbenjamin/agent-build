/**
 * The GitHub forge: the repo's own `push`, `pr_open` and `merge` steps, read as the run's base commit
 * holds them (`stepAtBase`), on `runtime/steps.ts`'s fallbacks where the repo maps none. Each step
 * runs with `sh -c` in the run's worktree, with the PR's title, body file, number, branch and risk
 * class in its environment under the names `PR_STEP_ENV` holds, as far as the operation knows them. Each runs once
 * (the activity never retries them). Whether a PR may merge is the caller's to decide (the `merge`
 * data op refuses a red gate); the forge merges what it is asked to. A merge queue or auto-merge accepts the request and merges
 * later, so the PR is read until it is MERGED (or closed, or the wait runs out): a merge is never
 * reported before it happened.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FALLBACKS, PR_STEP_ENV, STEPS_FILE } from "../../runtime/steps.ts";
import { MERGE_POLL_CAP_MS, MERGE_POLL_INTERVAL_MS, PR_BODY_TMP_PREFIX } from "../constants.ts";
import { RunError } from "../contracts.ts";
import { tail } from "./agentIo.ts";
import { stepAtBase } from "./baseSteps.ts";
import { type ProcessRunner, runProcess } from "./process.ts";
import type { Forge } from "./types.ts";

export interface GithubDeps {
  run?: ProcessRunner;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** The step's command for the repo at `worktree` as of `base`, or null when the repo has none. */
  stepCommand?: (worktree: string, base: string, step: string) => string | null;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

const PR_URL = /https?:\/\/\S+\/pull\/(\d+)/;

/** The `pr_open` command to run: a repo's own as it is (it reads the title and body from the
 *  environment and decides the draft itself); the fallback, which gh refuses without a title and
 *  body, given them from the environment, and its `--draft` only for a draft. */
export function prOpenCommand(command: string, draft: boolean): string {
  if (command !== FALLBACKS.pr_open) return command;
  const base = draft ? command : command.replace(/\s+--draft\b/, "");
  return `${base} --title "$${PR_STEP_ENV.title}" --body-file "$${PR_STEP_ENV.bodyFile}"`;
}

/** The class's env entry, none when the brief has no class (the step sees it unset, not empty). */
const classEnv = (riskClass: string | undefined): Record<string, string> => (riskClass === undefined || riskClass === "" ? {} : { [PR_STEP_ENV.riskClass]: riskClass });

/** The forge for a run cut at `baseSha`: its steps are read at that commit. */
export function githubForge(baseSha: string, deps: GithubDeps = {}): Forge {
  const run = deps.run ?? runProcess;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const commandOf = deps.stepCommand ?? stepAtBase;

  /** stdout of `cmd args`; a failure names `label` and its exit on the first line, and carries the end
   *  of stderr below it. */
  async function must(label: string, cmd: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    const r = await run(cmd, args, { cwd, signal });
    if (r.code !== 0) throw new Error(`${label} exited ${r.code ?? "on a signal"}\n${tail(r.stderr || r.stdout)}`);
    return r.stdout;
  }

  /** The repo's command for `name`; one it maps to nothing or to a blank command (`sh -c ""` exits 0
   *  having done nothing), or a steps file that does not parse, is a `RunError`. */
  function command(name: "push" | "pr_open" | "merge", worktree: string): string {
    let c: string | null;
    try {
      c = commandOf(worktree, baseSha, name);
    } catch (e) {
      throw new RunError(`forge ${name}: ${(e as Error).message}`);
    }
    if (c === null || c.trim() === "") {
      throw new RunError(`forge: the repo maps ${c === null ? "no" : "a blank"} ${name} step in its build steps file (${STEPS_FILE}, or build-steps.toml in a public repo's store dir)`);
    }
    return c;
  }

  /** Run a step's command with the PR's env; its output (both streams), or an error whose first line
   *  names the step, its command and its exit, with the end of the output below it. */
  async function step(name: string, cmd: string, worktree: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
    // Only what this operation knows reaches the step: a PR name the worker's own env holds does not.
    const base = { ...process.env };
    for (const name of Object.values(PR_STEP_ENV)) delete base[name];
    const r = await run("sh", ["-c", cmd], { cwd: worktree, env: { ...base, ...env }, signal });
    if (r.code !== 0) throw new Error(`the ${name} step \`${cmd}\` exited ${r.code ?? "on a signal"}\n${tail(r.output)}`);
    return r.output;
  }

  async function prState(pr: string, cwd: string, signal: AbortSignal): Promise<string> {
    const out = await must("gh pr view", "gh", ["pr", "view", pr, "--json", "state"], cwd, signal);
    let state: unknown;
    try {
      state = (JSON.parse(out) as { state?: unknown }).state;
    } catch {
      state = undefined;
    }
    if (typeof state !== "string") throw new Error(`gh pr view printed no state\n${tail(out, 200)}`);
    return state;
  }

  return {
    async push({ worktree, branch, signal }) {
      await step("push", command("push", worktree), worktree, { [PR_STEP_ENV.branch]: branch }, signal);
      const sha = (await must("git rev-parse", "git", ["rev-parse", "HEAD"], worktree, signal)).trim();
      return { schema: "ref", kind: "commit", id: sha };
    },

    async openPr({ worktree, branch, title, body, draft, riskClass, signal }) {
      const cmd = prOpenCommand(command("pr_open", worktree), draft === true);
      const dir = mkdtempSync(join(tmpdir(), PR_BODY_TMP_PREFIX));
      try {
        const bodyFile = join(dir, "body.md");
        writeFileSync(bodyFile, `${body}\n`);
        const env = { [PR_STEP_ENV.title]: title, [PR_STEP_ENV.bodyFile]: bodyFile, [PR_STEP_ENV.branch]: branch, ...classEnv(riskClass) };
        const out = await step("pr_open", cmd, worktree, env, signal);
        // A repo's step may print no URL; the PR the branch opened is then read back.
        const m = PR_URL.exec(out) ?? PR_URL.exec(await must("gh pr view", "gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], worktree, signal));
        if (m === null) throw new Error(`the pr_open step printed no pull request URL, and gh pr view ${branch} found none\n${tail(out, 200)}`);
        return { schema: "ref", kind: "pr", id: m[1]!, url: m[0] };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async merge({ worktree, pr, branch, riskClass, signal }) {
      if (!/^\d+$/.test(pr)) throw new RunError(`github forge: ${JSON.stringify(pr)} is not a PR number`);
      await step("merge", command("merge", worktree), worktree, { [PR_STEP_ENV.number]: pr, ...(branch === undefined ? {} : { [PR_STEP_ENV.branch]: branch }), ...classEnv(riskClass) }, signal);
      const deadline = now() + MERGE_POLL_CAP_MS;
      for (;;) {
        const state = await prState(pr, worktree, signal);
        if (state === "MERGED") return { schema: "ref", kind: "merge", id: pr };
        if (state === "CLOSED") throw new Error(`PR ${pr} was closed without being merged`);
        if (now() >= deadline) throw new Error(`PR ${pr} is ${state}, queued but not merged after ${MERGE_POLL_CAP_MS / 1000} s`);
        await sleep(MERGE_POLL_INTERVAL_MS, signal);
      }
    },

    async prState({ worktree, pr, signal }) {
      if (!/^\d+$/.test(pr)) throw new RunError(`github forge: ${JSON.stringify(pr)} is not a PR number`);
      return prState(pr, worktree, signal);
    },
  };
}
