/**
 * The per-repo run-state dir and the JSONL primitives its ledgers share — `reviewTelemetry.ts`'s
 * review log. The dir belongs to the repo under build, never to this runtime's own checkout: it is
 * `agent-build/` inside the repo's git common dir, so `git status` never shows it, no ignore line is
 * needed, and removing a worktree never drops it.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export type GitCommonDirResolver = () => string;

const gitCommonDir: GitCommonDirResolver = () =>
  execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

// The git common dir is the same from every worktree of the repo. The cwd-relative fallback (git
// absent) is LOUD, never silent.
function resolveRunStateDir(
  resolveCommonGitDir: GitCommonDirResolver = gitCommonDir
): string {
  const scriptRelative = join(process.cwd(), ".claude", "run-state");
  const warnFallback = (cause: string) =>
    console.error(
      `runState: ${cause}; anchoring run state to ${scriptRelative} — from a linked ` +
        "worktree `git worktree remove` drops this dir, so runs logged here can be lost"
    );
  try {
    const commonGitDir = resolveCommonGitDir();
    if (commonGitDir) return join(commonGitDir, "agent-build");
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

/** `<run-state dir>/<name>`, after appending the file of that name from the main working tree's
 *  `.claude/run-state/`, where 0.1.0 wrote it, and deleting that copy (and its dir, once empty). */
export function runStateFile(
  name: string,
  resolveCommonGitDir: GitCommonDirResolver = gitCommonDir
): string {
  const file = join(resolveRunStateDir(resolveCommonGitDir), name);
  let legacyDir: string;
  try {
    legacyDir = join(dirname(resolveCommonGitDir()), ".claude", "run-state");
  } catch {
    return file;
  }
  const legacy = join(legacyDir, name);
  if (legacy === file || !existsSync(legacy)) return file;
  const text = readFileSync(legacy, "utf8");
  mkdirSync(dirname(file), { recursive: true });
  if (text.trim().length > 0) appendFileSync(file, text.endsWith("\n") ? text : text + "\n");
  unlinkSync(legacy);
  try {
    rmdirSync(legacyDir);
  } catch {
    // not empty: something else still lives there
  }
  console.error(`runState: moved ${legacy} into ${file}`);
  return file;
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
