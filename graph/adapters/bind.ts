/** The implementation each seam's binding names, the run's pipeline module among them. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { bindingFor, type GraphDef, RunError, type RunConfig, type RunPlace } from "../contracts.ts";
import { claudeAgent, claudeRoleMissing } from "./claudeAgent.ts";
import { codexAgent, codexRoleMissing } from "./codexAgent.ts";
import { fileForge, fileTracker } from "./fileFakes.ts";
import { githubForge } from "./githubForge.ts";
import { haikuClassifier } from "./haikuClassifier.ts";
import { jevClassifier } from "./jevClassifier.ts";
import { repoReadersMissing } from "./baseSteps.ts";
import { linearTargetOf } from "./linearNotes.ts";
import { linearTracker } from "./linearTracker.ts";
import { shellCheck } from "./shellCheck.ts";
import { stubAgent } from "./stubAgent.ts";
import { stubCheck, stubClassifier } from "./stubAnswers.ts";
import type { AgentRunner, CheckRunner, Classifier, Forge, Pipeline, Tracker } from "./types.ts";

const pipelines = new Map<string, Promise<Pipeline>>();

/** The run's pipeline module (`config.pipeline`), imported once per worker. */
export function pipelineFor(config: RunConfig): Promise<Pipeline> {
  const path = config.pipeline;
  if (path === undefined) return Promise.reject(new RunError("the run config names no pipeline module"));
  let p = pipelines.get(path);
  if (p === undefined) {
    p = import(pathToFileURL(path).href).then((m: { pipeline?: Pipeline }) => {
      if (m.pipeline === undefined) throw new RunError(`${path} exports no pipeline`);
      return m.pipeline;
    });
    pipelines.set(path, p);
  }
  return p;
}

export function agentRunnerFor(config: RunConfig, role: string): AgentRunner {
  const b = bindingFor(config, "agent", role);
  switch (b.adapter) {
    case "stub":
      return stubAgent(b);
    case "claude":
      return claudeAgent(b);
    case "codex":
      return codexAgent(b);
  }
}

/** Why each agent role of `graph` cannot run as the config binds it, from `repo` at commit `base`: a
 *  run checks this at its start, so a role with no agent fails the run there and not mid-run. A stub
 *  runs any role. A role whose agent is its fan-out item runs the repo readers the notes name, each a
 *  project agent the base commit must hold. */
export function agentRolesMissing(config: RunConfig, graph: GraphDef, repo: string, base: string): string[] {
  const roles = [...new Set(graph.nodes.filter((n) => n.kind === "agent").map((n) => n.role))];
  const missing: string[] = [];
  let readers = false;
  for (const role of roles) {
    const b = bindingFor(config, "agent", role);
    if (b.adapter === "claude" && b.agentFromItem === true) readers = true;
    else {
      const why = b.adapter === "claude" ? claudeRoleMissing(b, role, repo) : b.adapter === "codex" ? codexRoleMissing(b, role, repo) : null;
      if (why !== null) missing.push(why);
    }
  }
  return readers ? [...missing, ...repoReadersMissing(repo, base)] : missing;
}

/** Why the run's Jev classifiers cannot call out: a run binding one checks its key at the start, so
 *  a missing key stops the run there and not at its first classifier. */
export function classifierKeysMissing(config: RunConfig, graph: GraphDef, env: NodeJS.ProcessEnv): string[] {
  const jev = graph.nodes.filter((n) => n.kind === "classifier" && bindingFor(config, "classifier", n.role)?.adapter === "jev").map((n) => n.id);
  if (jev.length === 0 || (env.TYPESAFE_API_KEY?.trim() ?? "") !== "") return [];
  return [`TYPESAFE_API_KEY is not set, and ${jev.join(", ")} ${jev.length === 1 ? "binds" : "bind"} the Jev classifier`];
}

export function classifierFor(config: RunConfig, role: string): Classifier {
  const b = bindingFor(config, "classifier", role);
  if (b === undefined) throw new RunError(`no classifier is bound for role ${role}: the config has no default and no roles.${role}.classifier`);
  switch (b.adapter) {
    case "stub":
      return stubClassifier(b);
    case "jev":
      return jevClassifier(b);
    case "haiku":
      return haikuClassifier(b);
  }
}

export async function checkRunnerFor(config: RunConfig, role: string): Promise<CheckRunner> {
  const b = bindingFor(config, "check", role);
  switch (b.adapter) {
    case "stub":
      return stubCheck(b);
    case "shell":
      return shellCheck();
    case "pipeline": {
      const check = (await pipelineFor(config)).checks[role];
      if (check === undefined) throw new RunError(`pipeline ${config.pipeline} has no check ${role}`);
      return { run: check };
    }
  }
}

export function trackerFor(config: RunConfig, place: RunPlace): Tracker {
  const b = config.tracker;
  return b.adapter === "linear" ? linearTracker({ target: () => linearTargetOf(place.worktree, place.baseSha) }) : fileTracker(b.dir ?? join(place.runDir, "tracker"));
}

export function forgeFor(config: RunConfig, place: RunPlace): Forge {
  const b = config.forge;
  return b.adapter === "github" ? githubForge(place.baseSha) : fileForge(b.dir ?? join(place.runDir, "forge"));
}
