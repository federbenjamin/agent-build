#!/usr/bin/env node
/**
 * Run a fixture as a mock: seed a throwaway stand-in repo from `<fixture>/repo/`, write the run config
 * with absolute paths and the file tracker and forge in the mock's own folder, start the run against
 * the server `build-graph dev` serves, wait for it to end, and write its record (`record.md`), its
 * history and its drawing beside it. Nothing outside the mock's folder is written.
 *
 *   node mock/mock.ts <fixture dir> [--out <dir>] [--timeout-s <n>] [--real-classifiers]
 *
 * `--real-classifiers` binds every classifier as the real-run config does (the shipped setups, all on
 * Jev), so the worker needs `TYPESAFE_API_KEY`; the agents, the tracker and the forge stay stubs.
 *
 * `<fixture>/start.json` is the run's start text; `<fixture>/operator.json`, when present, lists the
 * answers the mock gives, in order, to the questions the run puts to the operator.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { isMain } from "../../runtime/lib/isMain.ts";
import { BUILD_RUN_CONFIG } from "../constants.ts";
import { isEnded, RUN_PHASES, type RunHistory, type RunPhase } from "../contracts.ts";
import { renderRecord, runRecord } from "./record.ts";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const REPLAY_MODULE = fileURLToPath(new URL("./replay.ts", import.meta.url));
const POLL_MS = 2_000;
const IDENT = ["-c", "user.name=mock", "-c", "user.email=mock@localhost", "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false"];

const git = (cwd: string, ...args: string[]): string => execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" });

/** The stand-in repo: the base files, then main's moves (each tagged); main ends at the last seed move. */
export function seedRepo(fixture: string, repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const base = JSON.parse(readFileSync(join(fixture, "repo", "base.json"), "utf8")) as Record<string, string>;
  for (const [p, content] of Object.entries(base)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--no-verify", "-m", "base");
  git(repo, "tag", "mock/base");
  const moves = JSON.parse(readFileSync(join(fixture, "repo", "main.json"), "utf8")) as { tag: string; seed: boolean; dir: string }[];
  let seedTag = "mock/base";
  for (const m of moves) {
    const dir = join(fixture, "repo", "main", m.dir);
    const patches = readdirSync(dir).filter((f) => f.endsWith(".patch")).sort().map((f) => join(dir, f));
    git(repo, "am", "-q", "--keep-cr", ...patches);
    git(repo, "tag", m.tag);
    if (m.seed) seedTag = m.tag;
  }
  git(repo, "reset", "-q", "--hard", seedTag);
}

type Json = Record<string, unknown>;

/** The classifier bindings of the real-run config (`BUILD_RUN_CONFIG`), each setup path absolute:
 *  its default when it has one, and each role's own. */
export function realClassifierBindings(): { classifier?: unknown; roles: Record<string, unknown> } {
  const file = fileURLToPath(new URL(`../${BUILD_RUN_CONFIG}`, import.meta.url));
  const c = JSON.parse(readFileSync(file, "utf8")) as Json;
  const withAbsSetup = (b: unknown): unknown => {
    const o = b as Json;
    return typeof o.setup === "string" ? { ...o, setup: resolve(dirname(file), o.setup) } : o;
  };
  const roles: Record<string, unknown> = {};
  for (const [role, rb] of Object.entries((c.roles ?? {}) as Record<string, Json>)) if (rb.classifier !== undefined) roles[role] = withAbsSetup(rb.classifier);
  return { ...(c.classifier === undefined ? {} : { classifier: withAbsSetup(c.classifier) }), roles };
}

/** The fixture's config with every path absolute, and the tracker and forge in `mockDir`. With
 *  `realClassifiers`, the classifiers are bound as the real-run config binds them, in place of the
 *  fixture's stubs, and the stub agents replay through `replay.ts`, which bends the recording to the
 *  readers those classifiers pick; the tracker and the forge stay stubs. */
export function mockConfig(fixture: string, mockDir: string, opts: { realClassifiers?: boolean } = {}): Json {
  const c = JSON.parse(readFileSync(join(fixture, "config.json"), "utf8")) as Json;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(fixture, p));
  const agent = c.agent as { fixtureDir: string };
  const { classifier: _, roles: fixtureRoles, ...rest } = c;
  const roles = { ...((fixtureRoles ?? {}) as Record<string, Json>) };
  let classifier = c.classifier;
  if (opts.realClassifiers === true) {
    const real = realClassifierBindings();
    classifier = real.classifier;
    for (const role of Object.keys(roles)) {
      const { classifier: __, ...own } = roles[role]!;
      roles[role] = own;
    }
    for (const [role, b] of Object.entries(real.roles)) roles[role] = { ...roles[role], classifier: b };
  }
  return {
    ...rest,
    graph: abs(c.graph as string),
    pipeline: abs(c.pipeline as string),
    agent: { ...agent, fixtureDir: abs(agent.fixtureDir), ...(opts.realClassifiers === true ? { replay: REPLAY_MODULE } : {}) },
    ...(classifier === undefined ? {} : { classifier }),
    tracker: { adapter: "file", dir: join(mockDir, "tracker") },
    forge: { adapter: "file", dir: join(mockDir, "forge") },
    ...(Object.keys(roles).length === 0 ? {} : { roles }),
  };
}

function cli(env: NodeJS.ProcessEnv, ...args: string[]): string {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build-graph ${args[0]}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** The replies a fixture's `operator.json` lists, in order; none when it has no such file. */
export function operatorReplies(fixture: string): string[] {
  const file = join(fixture, "operator.json");
  if (!existsSync(file)) return [];
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw) || !raw.every((r) => typeof r === "string")) throw new Error(`${file}: a list of reply strings`);
  return raw;
}

/** Seed the mock's repo, tracker and config in `mockDir`, and start the fixture's run with
 *  `build-graph start` under the mock's env: its state dir in `mockDir`, and no `BUILD_EVENT_CMD`,
 *  whatever the shell's, so the run carries no consumer and fires no event. */
export function startMock(fixture: string, mockDir: string, opts: { realClassifiers?: boolean } = {}): { env: NodeJS.ProcessEnv; runId: string; runDir: string } {
  const repo = join(mockDir, "repo");
  seedRepo(fixture, repo);
  if (existsSync(join(fixture, "tracker"))) cpSync(join(fixture, "tracker"), join(mockDir, "tracker"), { recursive: true });
  const configFile = join(mockDir, "config.json");
  writeFileSync(configFile, `${JSON.stringify(mockConfig(fixture, mockDir, opts), null, 2)}\n`);
  const env = { ...process.env, AGENT_BUILD_GRAPH_DIR: join(mockDir, "state"), BUILD_EVENT_CMD: "" };
  const start = readFileSync(join(fixture, "start.json"), "utf8").trim();
  const started = cli(env, "start", start, "--repo", repo, "--config", configFile);
  const runId = /started (\S+)/.exec(started)?.[1];
  if (runId === undefined) throw new Error(`could not read the run id from: ${started}`);
  return { env, runId, runDir: join(mockDir, "state", "runs", runId) };
}

export async function runMock(fixture: string, mockDir: string, timeoutMs: number, opts: { realClassifiers?: boolean } = {}): Promise<{ runDir: string; history: RunHistory }> {
  const { env, runId, runDir } = startMock(fixture, mockDir, opts);
  console.log(`mock ${fixture}: run ${runId} in ${runDir}`);
  const answers = operatorReplies(fixture);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = cli(env, "status", runId);
    const phase = new RegExp(`: (${RUN_PHASES.join("|")})\n`).exec(status)?.[1] as RunPhase | undefined;
    if (phase !== undefined && isEnded(phase)) break;
    if (phase === "waiting") {
      const next = answers.shift();
      if (next === undefined) throw new Error(`the run waits on the operator and the fixture has no answer left:\n${status}`);
      cli(env, "answer", runId, next);
    }
    if (Date.now() > deadline) throw new Error(`the run did not end within ${timeoutMs} ms:\n${status}`);
    await sleep(POLL_MS);
  }
  for (let i = 0; i < 10 && !existsSync(join(runDir, "history.json")); i++) await sleep(500);
  const history = JSON.parse(readFileSync(join(runDir, "history.json"), "utf8")) as RunHistory;
  writeFileSync(join(mockDir, "record.md"), renderRecord(runRecord(history.graph, history)));
  cpSync(join(runDir, "graph.mmd"), join(mockDir, "graph.mmd"));
  cpSync(join(runDir, "history.json"), join(mockDir, "history.json"));
  return { runDir, history };
}

if (isMain(import.meta.url)) {
  const [fixtureArg, ...rest] = process.argv.slice(2);
  if (fixtureArg === undefined) {
    console.error("usage: mock.ts <fixture dir> [--out <dir>] [--timeout-s <n>] [--real-classifiers]");
    process.exit(2);
  }
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i < 0 ? undefined : rest[i + 1];
  };
  const out = flag("--out");
  const mockDir = out === undefined ? mkdtempSync(join(tmpdir(), "build-graph-mock-")) : resolve(out);
  mkdirSync(mockDir, { recursive: true });
  const { history } = await runMock(resolve(fixtureArg), mockDir, Number(flag("--timeout-s") ?? 600) * 1000, { realClassifiers: rest.includes("--real-classifiers") });
  console.log(`${history.phase}: record ${join(mockDir, "record.md")}, drawing ${join(mockDir, "graph.mmd")}`);
}
