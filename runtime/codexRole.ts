/**
 * The one entrypoint that runs a build role on Codex (the `codex_role` step; its fallback is this
 * file) — no skill spawns `codex exec` on its own line.
 *
 * A role resolves from the first of three places: `<tree>/.codex/agents/<role>.toml` (a repo's own
 * pin), `~/.codex/agents/<role>.toml` (the user's), then this repo's `agents.json` row and
 * `agents/<role>.md` (`roleFromRepo`). A role toml writes every value as a JSON string, so each
 * right-hand side parses with `JSON.parse` and no TOML dependency is needed.
 *
 *   node codexRole.ts <role> --tree <abs-dir> --dispatch <file> --out <file> [--log <file>] [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { isMain } from "./lib/isMain.ts";

const KNOWN_FLAGS = ["--tree", "--dispatch", "--out", "--log", "--dry-run"];

// Through realpath: `~/.agent-build/runtime` is a link, and `agents.json` sits at the checkout's root.
const REPO_ROOT = join(realpathSync(dirname(fileURLToPath(import.meta.url))), "..");

export const CODEX_PREAMBLE =
  "# Codex runtime\n\nYou run on Codex, not Claude Code. Search with `rg` or ast-grep, edit with `apply_patch`; " +
  "`Read`, `Write`, `Edit`, `LSP`, `Agent`, `SendMessage`, and the other Claude-only tools do not exist here — " +
  "a step that names one means its Codex equivalent.";

/** The separator between the role's projected prompt and the run's dispatch. */
const PROMPT_SEPARATOR = "\n\n---\n\n";

export interface RolePins {
  model: string;
  effort: string;
  instructions: string;
  /** `project_doc_max_bytes = 0` in the toml: a brief-only role that starts without the project AGENTS.md. */
  projectDocs: boolean;
}

export function parseRoleToml(text: string): RolePins {
  const find = (key: string): string | null => {
    const m = new RegExp(`^${key} = (.*)$`, "m").exec(text);
    return m === null ? null : m[1]!;
  };
  const read = (key: string): string => {
    const raw = find(key);
    if (raw === null) throw new Error(`codexRole: ${key} missing in role toml`);
    return JSON.parse(raw) as string;
  };
  return {
    model: read("model"),
    effort: read("model_reasoning_effort"),
    instructions: read("developer_instructions"),
    projectDocs: find("project_doc_max_bytes") !== "0",
  };
}

type AgentRow = {
  name: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  context?: { claudeMd?: boolean };
};

/** The role from `agents.json` (`codexModel`, `codexReasoningEffort`, `context.claudeMd`) and
 *  `agents/<role>.md`'s body after its frontmatter, prefixed by CODEX_PREAMBLE; null when the
 *  repo declares no such agent. Throws when the row lacks `codexModel` or `codexReasoningEffort`. */
export function roleFromRepo(role: string, repoRoot: string): RolePins | null {
  const { agents } = JSON.parse(readFileSync(join(repoRoot, "agents.json"), "utf8")) as { agents: AgentRow[] };
  const row = agents.find((a) => a.name === role);
  if (row === undefined) return null;
  if (!row.codexModel || !row.codexReasoningEffort)
    throw new Error(`codexRole: agents.json's ${role} row lacks codexModel or codexReasoningEffort`);
  const lines = readFileSync(join(repoRoot, "agents", `${role}.md`), "utf8").split("\n");
  const close = lines.findIndex((l, i) => i > 0 && l === "---");
  if (lines[0] !== "---" || close < 0) throw new Error(`codexRole: agents/${role}.md has no frontmatter`);
  const body = lines.slice(close + 1).join("\n").replace(/^\n+/, "");
  return {
    model: row.codexModel,
    effort: row.codexReasoningEffort,
    instructions: `${CODEX_PREAMBLE}\n\n${body}`,
    projectDocs: row.context?.claudeMd !== false,
  };
}

/** Roles that author and prove tests edit their disposable tree; every reader role reads. */
export function defaultSandbox(role: string): "workspace-write" | "read-only" {
  return role === "test-author" ? "workspace-write" : "read-only";
}

export interface CodexArgsOpts {
  tree: string;
  sandbox: string;
  model: string;
  effort: string;
  out: string;
  /** False drops the project AGENTS.md from the Codex context; `~/.codex/AGENTS.md` still loads. */
  projectDocs: boolean;
}

export function codexArgs(opts: CodexArgsOpts): string[] {
  return [
    "exec",
    "-C",
    opts.tree,
    "-s",
    opts.sandbox,
    // tsx binds an AF_UNIX IPC socket under $TMPDIR; Seatbelt denies the bind while the network is
    // restricted, and `codex exec` has no per-path socket allowance — so a writing role gets the network.
    ...(opts.sandbox === "workspace-write"
      ? ["-c", "sandbox_workspace_write.network_access=true"]
      : []),
    ...(opts.projectDocs ? [] : ["-c", "project_doc_max_bytes=0"]),
    "-c",
    "approval_policy=never",
    "-m",
    opts.model,
    "-c",
    `model_reasoning_effort=${opts.effort}`,
    "--skip-git-repo-check",
    "-o",
    opts.out,
    "-",
  ];
}

export interface CodexRoleDeps {
  spawn?(cmd: string, args: string[], input: string, log: string | null): number | null;
  readRole?(role: string, tree: string): string | null;
  repoRole?(role: string): RolePins | null;
}

/** The env every Codex run gets. `DO_NOT_TRACK=1` stops CLIs (the Supabase CLI among them) writing
 *  telemetry under `$HOME`, which the Codex sandbox refuses — without it a repo's env loader fails. */
export function codexEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, DO_NOT_TRACK: "1" };
}

function defaultSpawn(
  cmd: string,
  args: string[],
  input: string,
  log: string | null
): number | null {
  const fd = log === null ? null : openSync(log, "a");
  try {
    const sink = fd === null ? "inherit" : fd;
    const r = spawnSync(cmd, args, { input, stdio: ["pipe", sink, sink], env: codexEnv(process.env) });
    if (r.error) throw r.error;
    return r.status;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function roleTomlPath(role: string, tree: string): string | null {
  for (const dir of [join(tree, ".codex", "agents"), join(homedir(), ".codex", "agents")]) {
    const path = join(dir, `${role}.toml`);
    if (existsSync(path)) return path;
  }
  return null;
}

function defaultReadRole(role: string, tree: string): string | null {
  const path = roleTomlPath(role, tree);
  return path === null ? null : readFileSync(path, "utf8");
}

const USAGE =
  "usage: codexRole.ts <role> --tree <abs-dir> --dispatch <file> --out <file> [--log <file>] [--dry-run]";

function usage(message: string): number {
  console.error(`codexRole: ${message} — ${USAGE}`);
  return 2;
}

export function main(argv: string[], deps: CodexRoleDeps = {}): number {
  const spawn = deps.spawn ?? defaultSpawn;
  const readRole = deps.readRole ?? defaultReadRole;
  const repoRole = deps.repoRole ?? ((role: string) => roleFromRepo(role, REPO_ROOT));

  let tree: string | undefined;
  let dispatch: string | undefined;
  let out: string | undefined;
  let log: string | undefined;
  let rest: string[];
  const dryRun = argv.includes("--dry-run");
  try {
    assertKnownFlags(argv, KNOWN_FLAGS);
    let cur = argv.filter((a) => a !== "--dry-run");
    ({ value: tree, rest: cur } = takeValue(cur, "--tree"));
    ({ value: dispatch, rest: cur } = takeValue(cur, "--dispatch"));
    ({ value: out, rest: cur } = takeValue(cur, "--out"));
    ({ value: log, rest: cur } = takeValue(cur, "--log"));
    rest = cur;
  } catch (e) {
    return usage((e as Error).message);
  }

  const role = rest[0];
  if (role === undefined) return usage("no role given");
  if (rest.length > 1) return usage(`unexpected arguments: ${rest.slice(1).join(", ")}`);
  if (tree === undefined) return usage("--tree is required");
  if (dispatch === undefined) return usage("--dispatch is required");
  if (out === undefined) return usage("--out is required");
  if (!isAbsolute(tree)) return usage(`--tree must be absolute, got ${tree}`);
  if (!existsSync(tree)) return usage(`--tree does not exist: ${tree}`);
  if (!existsSync(dirname(out))) return usage(`--out directory does not exist: ${dirname(out)}`);
  if (!existsSync(dispatch)) return usage(`--dispatch does not exist: ${dispatch}`);
  if (log !== undefined && !existsSync(dirname(log)))
    return usage(`--log directory does not exist: ${dirname(log)}`);

  const toml = readRole(role, tree);
  const pins = toml !== null ? parseRoleToml(toml) : repoRole(role);
  if (pins === null) return usage(`unknown role: ${role}`);

  const sandbox = defaultSandbox(role);
  const args = codexArgs({ tree, sandbox, model: pins.model, effort: pins.effort, out, projectDocs: pins.projectDocs });
  if (dryRun) {
    const from =
      toml === null
        ? `agents.json + agents/${role}.md`
        : deps.readRole === undefined
          ? roleTomlPath(role, tree)
          : "the readRole seam";
    console.log(`role: ${from}`);
    console.log(`model: ${pins.model}`);
    console.log(`effort: ${pins.effort}`);
    console.log(`sandbox: ${sandbox}`);
    console.log(`project docs: ${pins.projectDocs ? "yes" : "no"}`);
    console.log(`codex: ${args.join(" ")}`);
    return 0;
  }
  const prompt = pins.instructions + PROMPT_SEPARATOR + readFileSync(dispatch, "utf8");
  try {
    return spawn("codex", args, prompt, log ?? null) ?? 1;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT" || !err.syscall?.startsWith("spawn")) throw e;
    console.error("codexRole: codex is not on PATH — install Codex or map a codex_role step");
    return 2;
  }
}

if (isMain(import.meta.url)) {
  exitWhenFlushed(main(process.argv.slice(2)));
}
