/**
 * The run config file and the runner's state dir. A config file is JSON: `graph` (the module that
 * exports the graph, relative to the file), `pipeline` (the module implementing the graph's own data
 * operations and checks), and the bindings of `RunConfig` (parsed in `bindings.ts`). Relative paths in
 * it are read from the file's folder.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Shape } from "../runtime/lib/shape.ts";
import { abs, agentBinding, checkBinding, classifierBinding, forgeBinding, trackerBinding } from "./bindings.ts";
import type { RoleBindings, RunConfig } from "./contracts.ts";

/** `AGENT_BUILD_GRAPH_DIR` (made absolute from the cwd) when set and non-empty, else `~/.local/state/agent-build/graph`: runs,
 *  drawn graphs, and the dev server's database. */
export function graphStateDir(env: Record<string, string | undefined> = process.env): string {
  const set = env.AGENT_BUILD_GRAPH_DIR;
  return set !== undefined && set !== "" ? resolve(set) : join(homedir(), ".local", "state", "agent-build", "graph");
}

export interface LoadedConfig {
  /** Absolute path of the module whose `graph` export the run walks. */
  graphModule: string;
  config: RunConfig;
}

/** Parse a config file's JSON, its relative paths read from `baseDir`. Throws naming every bad path. */
export function parseRunConfig(raw: unknown, baseDir: string): LoadedConfig {
  const s = new Shape("config");
  const o = s.obj(raw, "(root)") ?? {};
  const known = new Set(["graph", "pipeline", "agent", "classifier", "check", "tracker", "forge", "roles"]);
  for (const key of Object.keys(o)) if (!known.has(key)) s.bad(key, `no key ${key}`);
  const roles: Record<string, RoleBindings> = {};
  for (const [role, b] of Object.entries(s.obj(o.roles ?? {}, "roles") ?? {})) {
    const rb = s.obj(b, `roles.${role}`) ?? {};
    roles[role] = {
      ...(rb.agent === undefined ? {} : { agent: agentBinding(s, rb.agent, `roles.${role}.agent`, baseDir) }),
      ...(rb.classifier === undefined ? {} : { classifier: classifierBinding(s, rb.classifier, `roles.${role}.classifier`, baseDir) }),
      ...(rb.check === undefined ? {} : { check: checkBinding(s, rb.check, `roles.${role}.check`) }),
    };
  }
  const pipeline = s.optStr(o, "pipeline", "(root)");
  const loaded: LoadedConfig = {
    graphModule: abs(baseDir, s.str(o.graph, "graph")),
    config: {
      ...(pipeline === undefined ? {} : { pipeline: abs(baseDir, pipeline) }),
      agent: agentBinding(s, o.agent, "agent", baseDir),
      ...(o.classifier === undefined ? {} : { classifier: classifierBinding(s, o.classifier, "classifier", baseDir) }),
      check: checkBinding(s, o.check, "check"),
      tracker: trackerBinding(s, o.tracker, "tracker", baseDir),
      forge: forgeBinding(s, o.forge, "forge", baseDir),
      roles,
    },
  };
  const issues = s.issues();
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join("\n"));
  return loaded;
}
