/**
 * Where a repo's build files live. A repo whose `git config agents.profile` reads `public` tracks
 * nothing private, so its build steps, build notes, and briefs live in the store, a private git
 * repo outside it: `<storeRoot>/<owner>/<name>/` (`build-steps.toml`, `briefs/<branch-slug>.md`,
 * and the notes file that steps file's `notes` line names). Any other repo keeps them in its own tree.
 *
 * The store root is `$AGENT_BUILD_STORE`, else `~/.local/state/agent-build/store`. The run root,
 * under which every build run keeps its run dir, is `$AGENT_BUILD_RUN_ROOT`, else
 * `~/.local/state/agent-build/runs`.
 *
 * This file is the only parser of `origin` and of the ledger's `store:` prefix (`briefLocation`).
 *
 *   node repoId.ts [repo-dir]
 *
 *   repo: <owner>/<name>          (`none` when origin is absent or does not parse)
 *   profile: <public|private|unset>
 *   store: <dir>                  (`none` with no origin)
 *   run-root: <dir>
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { type ExecFn, gitTry } from "./gitOps.ts";
import { isMain } from "./isMain.ts";

export interface RepoId {
  owner: string;
  name: string;
}

type Opts = { exec?: ExecFn };

const run = (repo: string, opts: Opts) => ({ cwd: repo, ...(opts.exec ? { exec: opts.exec } : {}) });

/** `owner/name` from an origin URL: `git@host:o/r.git`, `https://host/o/r[.git]`, `ssh://git@host[:port]/o/r.git`.
 *  Null for a local path, a `file://` URL, or a path of other than two parts. */
export function parseOrigin(url: string): RepoId | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?[^:/@.][^:/@]*(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(url.trim());
  const parts = m?.[1]?.split("/") ?? [];
  if (parts.length !== 2 || parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return { owner: parts[0]!, name: parts[1]! };
}

/** The repo's `owner/name` from `git remote get-url origin`; null with no origin or one that does not parse. */
export function repoId(repo: string, opts: Opts = {}): RepoId | null {
  const url = gitTry(["remote", "get-url", "origin"], run(repo, opts));
  return url === null ? null : parseOrigin(url);
}

/** `git config --get agents.profile`; null when unset or when `repo` is not a git repo. Any other
 *  value throws: a misspelt `public` read as private would put the repo's build files in its tree. */
export function repoProfile(repo: string, opts: Opts = {}): "public" | "private" | null {
  if (gitTry(["rev-parse", "--git-dir"], run(repo, opts)) === null) return null;
  const value = gitTry(["config", "--get", "agents.profile"], run(repo, opts))?.trim() ?? null;
  if (value === null || value === "") return null;
  if (value === "public" || value === "private") return value;
  throw new Error(`agents.profile is "${value}" in ${repo} — set it to public or private (git config agents.profile)`);
}

const STATE_DIR = [".local", "state", "agent-build"];

function envOr(name: string, fallback: string): string {
  const env = process.env[name];
  return env !== undefined && env !== "" ? env : join(homedir(), ...STATE_DIR, fallback);
}

/** `AGENT_BUILD_STORE` when set and non-empty, else `~/.local/state/agent-build/store`. */
export function storeRoot(): string {
  return envOr("AGENT_BUILD_STORE", "store");
}

/** `AGENT_BUILD_RUN_ROOT` when set and non-empty, else `~/.local/state/agent-build/runs`. */
export function runRoot(): string {
  return envOr("AGENT_BUILD_RUN_ROOT", "runs");
}

/** `<storeRoot>/<owner>/<name>`. Throws for a repo with no parseable origin: the store is keyed by it. */
export function storeDir(repo: string, opts: Opts = {}): string {
  const id = repoId(repo, opts);
  if (id === null) {
    throw new Error(`${repo} has no origin of the form <owner>/<name> (git remote get-url origin) — the store is keyed by it`);
  }
  return join(storeRoot(), id.owner, id.name);
}

/** `path` through realpath, a missing tail kept as written (macOS `/tmp` is `/private/tmp`). */
function real(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const up = dirname(abs);
    return up === abs ? abs : join(real(up), basename(abs));
  }
}

/** Is `path` inside `storeRoot()`? */
export function inStore(path: string): boolean {
  return real(path).startsWith(real(storeRoot()) + sep);
}

/** Is `path` inside `repo`'s own store dir (`storeDir`)? */
export function inStoreOf(path: string, repo: string, opts: Opts = {}): boolean {
  return real(path).startsWith(real(storeDir(repo, opts)) + sep);
}

const STORE = "store:";

/** Where a ledger's `brief:` or `hand-test-block:` value lives. `store:briefs/x.md` is
 *  `briefs/x.md` under `storeDir(repo)`; any other value is a path in the code repo. */
export function briefLocation(value: string, repo: string, opts: Opts = {}): { cwd: string; path: string; store: boolean } {
  if (value.startsWith(STORE)) return { cwd: storeDir(repo, opts), path: value.slice(STORE.length), store: true };
  return { cwd: repo, path: value, store: false };
}

if (isMain(import.meta.url)) {
  const repo = resolve(process.argv[2] ?? ".");
  try {
    const id = repoId(repo);
    const profile = repoProfile(repo);
    console.log(`repo: ${id === null ? "none" : `${id.owner}/${id.name}`}`);
    console.log(`profile: ${profile ?? "unset"}`);
    console.log(`store: ${id === null ? "none" : join(storeRoot(), id.owner, id.name)}`);
    console.log(`run-root: ${runRoot()}`);
  } catch (err) {
    console.error(`repoId: ${(err as Error).message}`);
    process.exit(2);
  }
}
