/**
 * A repo's build steps and notes as the run's base commit holds them, never as the run's worktree
 * does: an agent can edit `.claude/build-steps.toml` there (`checks = "true"`) and turn a gate green.
 * A public repo keeps both in the store, outside any worktree, so those are read where they are.
 * Every git call runs without the adapters' API keys.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { gitTry } from "../../runtime/lib/gitOps.ts";
import { repoProfile } from "../../runtime/lib/repoId.ts";
import { STEPS_FILE, stepCommand } from "../../runtime/steps.ts";
import { REPO_READERS_NOTES_SECTION } from "../constants.ts";
import { RunError } from "../contracts.ts";
import { childEnv } from "./process.ts";

/** The files `steps.ts` reads from a private repo's tree: the steps file, and the package files its
 *  `tests`, `checks` and `install` fallbacks look at. */
const STEP_FILES = [STEPS_FILE, "package.json", "pnpm-lock.yaml", "package-lock.json"];

const gitEnv = (): NodeJS.ProcessEnv => childEnv(process.env);

/** `path` as commit `base` holds it, or null when it holds none. */
export function fileAtBase(worktree: string, base: string, path: string): string | null {
  return gitTry(["show", `${base}:${path}`], { cwd: worktree, env: gitEnv() });
}

/** The command of `step` for the repo at `worktree`, as of `base`; null when the repo maps none. */
export function stepAtBase(worktree: string, base: string, step: string): string | null {
  const env = gitEnv();
  if (repoProfile(worktree, { env }) === "public") return stepCommand(worktree, step, { env });
  const scratch = mkdtempSync(join(tmpdir(), "graph-steps-"));
  try {
    for (const file of STEP_FILES) {
      const text = fileAtBase(worktree, base, file);
      if (text === null) continue;
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      writeFileSync(join(scratch, file), text);
    }
    return stepCommand(scratch, step, { env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The repo's build notes as of `base`, with where they came from; null when it maps none. A path
 *  inside the repo is read at `base`; an absolute one (the store of a public repo) where it is. A
 *  notes file the steps name and `base` does not hold is a `RunError`: the run cannot read the repo's
 *  rules. */
export function notesAtBase(worktree: string, base: string): { path: string; text: string } | null {
  const named = stepAtBase(worktree, base, "notes");
  if (named === null) return null;
  const missing = (where: string) => new RunError(`the notes file ${named}, which the repo's build steps name, is not ${where}`);
  if (isAbsolute(named)) {
    if (!existsSync(named)) throw missing("there");
    return { path: named, text: readFileSync(named, "utf8") };
  }
  const text = fileAtBase(worktree, base, named);
  if (text === null) throw missing(`in commit ${base.slice(0, 12)}`);
  return { path: resolve(worktree, named), text };
}

/** The build notes' sections, by heading (lower case), each body trimmed: the one reader of a notes
 *  section, for the run's start check, the tracker's target and K-load-config's config alike. */
export function noteSections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let head: string | null = null;
  const body: string[] = [];
  const flush = () => {
    if (head !== null) out[head] = body.join("\n").trim();
    body.length = 0;
  };
  for (const line of text.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      head = m[1]!.toLowerCase();
    } else if (head !== null) body.push(line);
  }
  flush();
  return out;
}

/** The agents the notes' `## repo readers` section names (`noteSections`): one `- <agent name>` line
 *  each; text after the name says when it reads and is not the name. */
export function repoReaders(sections: Record<string, string>): string[] {
  return (sections[REPO_READERS_NOTES_SECTION] ?? "")
    .split("\n")
    .map((l) => /^-\s+([\w-]+)(?:\s.*)?$/.exec(l.trim())?.[1])
    .filter((r): r is string => r !== undefined);
}

/** Each repo reader the repo's notes name as of `base` that has no project agent there
 *  (`.claude/agents/<name>.md` in commit `base`). */
export function repoReadersMissing(worktree: string, base: string): string[] {
  const notes = notesAtBase(worktree, base);
  if (notes === null) return [];
  return repoReaders(noteSections(notes.text))
    .filter((r) => fileAtBase(worktree, base, `.claude/agents/${r}.md`) === null)
    .map((r) => `repo reader ${r}, which ${notes.path} names, has no agent: no .claude/agents/${r}.md in commit ${base.slice(0, 12)}`);
}
