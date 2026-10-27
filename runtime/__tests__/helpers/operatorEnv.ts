/**
 * Cuts a test process off the operator's machine: every test file in `runtime/`, `tests/` and
 * `graph/__tests__/` imports it first, and `runtime/__tests__/operatorEnv.test.ts` checks that.
 * The operator's shell exports live sinks (`BUILD_EVENT_CMD`, the store, the run root) and functions
 * that wrap its tools (`BASH_FUNC_claude%%`, which a spawned `/bin/sh` runs in place of `claude`), and its
 * `~/.gitconfig` signs commits, so the variable families that reach them go, and `HOME` becomes a
 * dir of this process's own under `<repo>/.test-home/`, where every `~` default lands unnamed.
 * `GIT_CEILING_DIRECTORIES` keeps a git command under that home from finding the checkout's `.git`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The variable family prefixes the setup deletes from `process.env`. */
export const STRIPPED_ENV_PREFIXES: readonly string[] = ["GIT_", "GH_", "GITHUB_", "HERDR_", "CLAUDE_CODE_MESSAGING_", "XDG_", "AGENT_BUILD_", "LINEAR_", "TYPESAFE_", "CODEX_", "BASH_FUNC_"];
/** The single variable names the setup deletes from `process.env`. */
export const STRIPPED_ENV_NAMES: readonly string[] = ["BUILD_EVENT_CMD", "SESSION_LOGS_DIR", "CLAUDE_CONFIG_DIR"];

for (const name of Object.keys(process.env)) {
  if (STRIPPED_ENV_NAMES.includes(name) || STRIPPED_ENV_PREFIXES.some((p) => name.startsWith(p))) delete process.env[name];
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const homes = join(root, ".test-home");
mkdirSync(homes, { recursive: true });
const home = mkdtempSync(join(homes, "home-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = test\n\temail = test@localhost\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n");
process.env.HOME = home;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CEILING_DIRECTORIES = homes;
