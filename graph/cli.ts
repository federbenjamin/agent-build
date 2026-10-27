#!/usr/bin/env node
/**
 * build-graph: start a graph run, answer its question, cancel it, show its status, draw it, print a
 * graph as JSON (`export`), print what the recorded runs say (`stats`), or run the local server and
 * worker. The server is `TEMPORAL_ADDRESS` (default localhost:7233); runs and drawings live under the
 * state dir (`AGENT_BUILD_GRAPH_DIR`, default ~/.local/state/agent-build/graph).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client, Connection } from "@temporalio/client";

import { consumerLine } from "../runtime/lib/buildEvents.ts";
import { exitWhenFlushed } from "../runtime/lib/exitWhenFlushed.ts";
import { isMain } from "../runtime/lib/isMain.ts";
import { cancelPlan, formatStatus, newRunId, parseCommand, USAGE } from "./commands.ts";
import { graphStateDir, parseRunConfig } from "./config.ts";
import { DEFAULT_TEMPORAL_ADDRESS, TASK_QUEUE } from "./constants.ts";
import { type GraphDef, QUERY_STATUS, type RunHistory, SIGNAL_ANSWER, WORKFLOW_NAME, type WorkflowInput } from "./contracts.ts";
import { assertValidGraph } from "./define.ts";
import { runDev } from "./dev.ts";
import { exportGraph } from "./exportGraph.ts";
import { renderMermaid } from "./mermaid.ts";
import { readRunDirs } from "./runDirs.ts";
import { requestInputs } from "./schedule.ts";
import { formatStats, statsReport } from "./stats.ts";
import { isGitRepo } from "./worktree.ts";

const DEFAULT_CONFIG = fileURLToPath(new URL("./examples/toy.config.json", import.meta.url));

const address = (): string => process.env.TEMPORAL_ADDRESS || DEFAULT_TEMPORAL_ADDRESS;
const runDirOf = (stateDir: string, run: string): string => join(stateDir, "runs", run);

let connection: Connection | undefined;
async function client(): Promise<Client> {
  connection ??= await Connection.connect({ address: address() });
  return new Client({ connection });
}

async function loadGraph(module: string): Promise<GraphDef> {
  const mod = (await import(pathToFileURL(resolve(module)).href)) as { graph?: GraphDef };
  if (mod.graph === undefined) throw new Error(`${module} exports no graph`);
  assertValidGraph(mod.graph);
  return mod.graph;
}

/** The run's history: live from the workflow, else the copy it recorded when it finished. */
async function runHistory(stateDir: string, run: string): Promise<RunHistory> {
  try {
    return await (await client()).workflow.getHandle(run).query<RunHistory>(QUERY_STATUS);
  } catch (e) {
    const file = join(runDirOf(stateDir, run), "history.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as RunHistory;
    throw new Error(`no status for run ${run}: ${(e as Error).message}`);
  }
}

async function main(argv: string[]): Promise<number> {
  let command;
  try {
    command = parseCommand(argv);
  } catch (e) {
    console.error(`build-graph: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const stateDir = graphStateDir();
  switch (command.cmd) {
    case "start": {
      const configFile = resolve(command.config ?? DEFAULT_CONFIG);
      const { graphModule, config } = parseRunConfig(JSON.parse(readFileSync(configFile, "utf8")), dirname(configFile));
      const graph = await loadGraph(graphModule);
      const repo = resolve(command.repo);
      if (!isGitRepo(repo)) throw new Error(`--repo ${repo} is not a git repo`);
      const runId = newRunId(new Date(), randomBytes(3).toString("hex"));
      const events = consumerLine(process.env);
      const input: WorkflowInput = {
        runId,
        repo,
        runDir: runDirOf(stateDir, runId),
        graph,
        inputs: requestInputs(graph, command.request),
        config,
        ...(events === "" ? {} : { events }),
      };
      await (await client()).workflow.start(WORKFLOW_NAME, { taskQueue: TASK_QUEUE, workflowId: runId, args: [input] });
      console.log(`started ${runId} (graph ${graph.id}) in ${input.runDir}`);
      console.log(`  build-graph status ${runId}\n  build-graph draw ${runId}`);
      return 0;
    }
    case "answer": {
      const h = await runHistory(stateDir, command.run);
      const first = h.asking[0];
      if (first === undefined) {
        console.error(`build-graph: run ${command.run} has no open question (${h.phase})`);
        return 1;
      }
      await (await client()).workflow.getHandle(command.run).signal<[string]>(SIGNAL_ANSWER, command.text);
      console.log(`answered ${first.node}${first.iteration > 0 ? ` #${first.iteration}` : ""} in ${command.run}`);
      return 0;
    }
    case "cancel": {
      const plan = cancelPlan(command.run, await runHistory(stateDir, command.run).catch((e: Error) => ({ unread: e.message })));
      if (plan.send) await (await client()).workflow.getHandle(command.run).cancel();
      console.log(plan.line);
      return 0;
    }
    case "status":
      process.stdout.write(formatStatus(await runHistory(stateDir, command.run)));
      return 0;
    case "draw": {
      const isModule = /\.[cm]?[jt]s$/.test(command.target) && existsSync(command.target);
      const graph = isModule ? await loadGraph(command.target) : undefined;
      const history = isModule ? undefined : await runHistory(stateDir, command.target);
      const out = graph !== undefined ? join(stateDir, "graphs", `${graph.id}.mmd`) : join(runDirOf(stateDir, command.target), "graph.mmd");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, renderMermaid(graph ?? history!.graph, history));
      console.log(out);
      return 0;
    }
    case "export":
      process.stdout.write(`${JSON.stringify(exportGraph(await loadGraph(command.module)), null, 1)}\n`);
      return 0;
    case "stats":
      process.stdout.write(formatStats(statsReport(readRunDirs(command.stateDir === undefined ? stateDir : resolve(command.stateDir)))));
      return 0;
    case "dev":
      await runDev(address(), stateDir, (line) => console.log(line));
      return 0;
  }
}

if (isMain(import.meta.url)) {
  try {
    exitWhenFlushed(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`build-graph: ${e instanceof Error ? e.message : String(e)}`);
    exitWhenFlushed(1);
  } finally {
    await connection?.close();
  }
}
