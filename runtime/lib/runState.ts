/**
 * The per-repo run-state dir and the JSONL primitives its ledgers share — `reviewTelemetry.ts`'s
 * review log. The dir belongs to the repo under build (its main working tree), never to this
 * runtime's own checkout.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GitCommonDirResolver = () => string;

const gitCommonDir: GitCommonDirResolver = () =>
  execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

// comment-ok: the worktree-deletion failure this anchoring prevents is the whole reason for it
// Anchor the logs to the MAIN working tree's `.claude/run-state/` of the repo under build (cwd) —
// from a linked worktree the cwd's own dir is gitignored and `git worktree remove` deletes it,
// silently dropping every run logged from it. `git rev-parse --git-common-dir`'s parent is
// stable across worktrees. The cwd-relative fallback (git absent) is LOUD, never silent.
export function resolveRunStateDir(
  resolveCommonGitDir: GitCommonDirResolver = gitCommonDir
): string {
  const scriptRelative = join(process.cwd(), ".claude", "run-state");
  const warnFallback = (cause: string) =>
    console.error(
      `runState: ${cause}; anchoring run state to ${scriptRelative} — from a linked ` +
        "worktree this dir is gitignored and dropped by `git worktree remove`, so runs " +
        "logged here can be lost"
    );
  try {
    const commonGitDir = resolveCommonGitDir();
    if (commonGitDir) return join(dirname(commonGitDir), ".claude", "run-state");
    warnFallback("git returned an empty common-dir");
    return scriptRelative;
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    const message = err instanceof Error ? err.message : String(err);
    warnFallback(`could not resolve the git common-dir (${stderr || message})`);
    return scriptRelative;
  }
}

/** Every row of a JSONL ledger. A missing file is an empty log; a corrupt LINE throws naming
 *  `file:lineNo` — the PHYSICAL line, so the number opens the right line in an editor. */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const rows: T[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`${file}:${i + 1}: unparseable JSONL line — log corrupted?`);
    }
  }
  return rows;
}

/** Append rows in ONE write, creating the dir. One `appendFileSync` per call is what keeps
 *  concurrent writers from interleaving a half-written row. */
export function appendJsonl(file: string, rows: readonly object[]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
