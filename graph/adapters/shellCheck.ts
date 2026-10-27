/**
 * The shell check runner: the check's role names a step of the target repo's
 * `.claude/build-steps.toml` as the run's base commit holds it (`baseSteps.ts`), run in the run's
 * worktree. Only verification steps may be named (`CHECK_STEPS`): push, PR and merge belong to the
 * forge. Exit 0 is a pass, any other exit a fail; the detail keeps the end of the output.
 */

import { CHECK_DETAIL_CHARS, CHECK_STEPS } from "../constants.ts";
import { RunError } from "../contracts.ts";
import { stepAtBase } from "./baseSteps.ts";
import { type ProcessRunner, runProcess } from "./process.ts";
import type { CheckRunner } from "./types.ts";

export interface ShellCheckDeps {
  run?: ProcessRunner;
  /** The step's command for the repo at `worktree` as of `base`, or null when the repo has none. */
  stepCommand?: (worktree: string, base: string, step: string) => string | null;
}

export function shellCheck(deps: ShellCheckDeps = {}): CheckRunner {
  const run = deps.run ?? runProcess;
  const commandOf = deps.stepCommand ?? stepAtBase;
  return {
    async run(req) {
      if (!CHECK_STEPS.includes(req.role)) {
        throw new RunError(`check ${req.role}: a shell check runs one of ${CHECK_STEPS.join(", ")}`);
      }
      let command: string | null;
      try {
        command = commandOf(req.worktree, req.baseSha, req.role);
      } catch (e) {
        throw new RunError(`check ${req.role}: ${(e as Error).message}`);
      }
      if (command === null) throw new RunError(`check ${req.role}: the repo maps no ${req.role} step`);
      const r = await run("sh", ["-c", command], { cwd: req.worktree, signal: req.signal });
      const output = r.output.length > CHECK_DETAIL_CHARS ? `…${r.output.slice(-CHECK_DETAIL_CHARS)}` : r.output;
      const exit = r.code === null ? "ended on a signal" : `exit ${r.code}`;
      return { answer: r.code === 0 ? "pass" : "fail", detail: `${req.role}: ${exit}\n${output}`.trimEnd() };
    },
  };
}
