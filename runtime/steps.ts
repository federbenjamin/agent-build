#!/usr/bin/env node
// The build flow names steps, never commands. A repo maps each step to its own command in
// `.claude/build-steps.toml` (a public repo: `build-steps.toml` in its store dir, `lib/repoId.ts`)
// (flat `step = "command"` lines); a step the repo leaves out gets the
// fallback below, and `null` means the repo has none: the step is skipped and the skip is said.
// An unknown key is an error, never a silent fallback: a typo would quietly weaken the repo.
// Two keys name repo files, not commands: `thresholds` (read by thresholds.ts) and `notes` (the
// repo's build notes: a `## <agent or skill>` section per role that the role reads first).
// Codex is optional: `codex_role` on its fallback resolves to no command when no `codex` is on PATH.
//   node steps.ts [repo-dir] [--json | --get <step>]
//   node steps.ts --template <repo name>     the build-steps.toml a new repo starts from
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/isMain.ts";
import { repoProfile, storeDir } from "./lib/repoId.ts";

// A fallback script is this runtime's own, beside this file: a steps table resolved by one tree's
// runtime never names another tree's script (a dev tree's run printed the live copy's codexRole.ts).
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = `node ${/^[\w./~-]+$/.test(HERE) ? HERE : `'${HERE.replaceAll("'", `'\\''`)}'`}`;

export const FALLBACKS: Record<string, string | null> = {
  size: `${RUNTIME}/size.ts`, signals: null, checks: null, exit_checks: null, fix_checks: null, tests: null,
  install: null, db_gate: null, manifest: null, mutation_proof: null, push: "git push",
  pr_open: "gh pr create --draft --fill", merge: "gh pr merge --auto --squash",
  codex_role: `${RUNTIME}/codexRole.ts`, push_stats: null, thresholds: null, notes: null,
};

export type Step = { step: string; command: string | null; source: "repo" | "fallback" };

// The steps a new repo is asked about first, with the hint each line carries; every other key
// stays on its fallback until the repo names it.
const TEMPLATE_HINTS: [step: string, hint: string][] = [
  ["install", "what a fresh worktree needs before anything runs"],
  ["checks", "the whole pre-push run"],
  ["exit_checks", "what a builder passes before it reports done"],
  ["tests", ""],
  ["notes", "the build notes file each build role reads first"],
];

/** The `build-steps.toml` a repo starts from: every step commented out, so each stays on its
 *  fallback until the repo fills it in. `gh-repo-defaults` writes it for a new repo. */
export function stepsTemplate(repoName: string): string {
  const width = Math.max(...TEMPLATE_HINTS.map(([step]) => step.length));
  return [
    `# ${repoName}'s build steps: the global /build flow names a step, this file names the command.`,
    "# Reader and fallbacks: ~/.agent-build/runtime/steps.ts (`node <it> .` prints the resolved table).",
    "# A step left out runs on its fallback. Uncomment and fill in the ones this repo has.",
    ...TEMPLATE_HINTS.map(([step, hint]) => `# ${step.padEnd(width)} = ""${hint ? `   # ${hint}` : ""}`),
    "",
  ].join("\n");
}

/** Is an executable `codex` in some entry of `env.PATH`? */
export function codexOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, "codex");
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

type ResolveOpts = { env?: NodeJS.ProcessEnv };

/** The steps of `repo`: a public repo's (`agents.profile`) from its store dir (`lib/repoId.ts`),
 *  any other's from its own tree. `file` is the file that was looked at. `opts.env` (default
 *  `process.env`) feeds `codexOnPath` for the `codex_role` fallback. */
export function resolveSteps(repo: string, opts: ResolveOpts = {}): { file: string; found: boolean; steps: Step[] } {
  const tree = join(repo, ".claude/build-steps.toml");
  let file = tree;
  if (repoProfile(repo) === "public") {
    const dir = storeDir(repo);
    file = join(dir, "build-steps.toml");
    if (existsSync(tree)) {
      throw new Error(`${tree}: a public repo keeps its build steps in the store, at ${file} — move it there`);
    }
    // A missing store dir is not a repo with no steps file: every step would take its fallback
    // without a word (no checks, default thresholds). A dir with no file still means "no steps".
    if (!existsSync(dir)) {
      throw new Error(`no store dir at ${dir} for this public repo — clone the store there or set AGENT_BUILD_STORE (a repo renamed on GitHub has its store folder renamed with it)`);
    }
  }
  const found = existsSync(file);
  const mapped = new Map<string, string>();
  for (const [i, raw] of (found ? readFileSync(file, "utf8").split("\n") : []).entries()) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const [, key, quoted] = raw.match(/^\s*([a-z_]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/) ?? [];
    if (key === undefined || quoted === undefined) throw new Error(`${file}:${i + 1}: expected step = "command", got: ${raw}`);
    if (!(key in FALLBACKS)) throw new Error(`${file}:${i + 1}: unknown step "${key}"`);
    if (mapped.has(key)) throw new Error(`${file}:${i + 1}: step "${key}" mapped twice`);
    mapped.set(key, JSON.parse(quoted));
  }
  const codex = mapped.has("codex_role") || codexOnPath(opts.env ?? process.env);
  const steps = Object.entries(FALLBACKS).map(([step, fallback]): Step =>
    mapped.has(step)
      ? { step, command: mapped.get(step)!, source: "repo" }
      : { step, command: step === "codex_role" && !codex ? null : fallback, source: "fallback" });
  return { file, found, steps };
}

/** One step's command, or null when the repo has none. */
export function stepCommand(repo: string, step: string, opts: ResolveOpts = {}): string | null {
  if (!(step in FALLBACKS)) throw new Error(`unknown step "${step}"`);
  return resolveSteps(repo, opts).steps.find((s) => s.step === step)!.command;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const templateAt = args.indexOf("--template");
  if (templateAt >= 0) {
    const name = args[templateAt + 1];
    if (name === undefined || name.startsWith("-")) {
      console.error("steps: --template needs the repo's name");
      process.exit(2);
    }
    process.stdout.write(stepsTemplate(name));
    process.exit(0);
  }
  const getAt = args.indexOf("--get");
  const get = getAt >= 0 ? args[getAt + 1] : undefined;
  if (getAt >= 0 && (get === undefined || !(get in FALLBACKS))) {
    console.error(`steps: --get needs one of: ${Object.keys(FALLBACKS).join(", ")}`);
    process.exit(2);
  }
  const positional = args.filter((a, i) => a !== "--json" && (getAt < 0 || (i !== getAt && i !== getAt + 1)));
  const r = resolveSteps(resolve(positional[0] ?? "."));
  if (get !== undefined) console.log(r.steps.find((s) => s.step === get)!.command ?? "(none)");
  else if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`build-steps: ${r.file}${r.found ? "" : " (absent: every step uses its fallback)"}`);
    for (const s of r.steps) {
      const none = s.step === "codex_role" && s.source === "fallback" ? "(none: codex not on PATH)" : "(none)";
      console.log(`${s.step.padEnd(14)} ${s.source.padEnd(9)} ${s.command ?? none}`);
    }
  }
}
