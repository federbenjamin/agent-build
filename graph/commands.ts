/** The CLI's pure parts: argv to a command, a run's id, and a run's status as text. */

import { assertKnownFlags, takeValue } from "../runtime/lib/cliArgs.ts";
import { isEnded, type RunHistory } from "./contracts.ts";
import { restartsNote } from "./schedule.ts";

export const USAGE = `usage:
  build-graph start "<request>" --repo <path> [--config <file>]
  build-graph answer <run> "<text>"
  build-graph cancel <run>
  build-graph status <run>
  build-graph draw <run|graph module>
  build-graph export <graph module>
  build-graph stats [state dir]
  build-graph dev`;

export type Command =
  | { cmd: "start"; request: string; repo: string; config?: string }
  | { cmd: "answer"; run: string; text: string }
  | { cmd: "cancel"; run: string }
  | { cmd: "status"; run: string }
  | { cmd: "draw"; target: string }
  | { cmd: "export"; module: string }
  | { cmd: "stats"; stateDir?: string }
  | { cmd: "dev" };

function positionals(rest: string[], n: number, what: string): string[] {
  assertKnownFlags(rest, []);
  if (rest.length !== n) throw new Error(`${what} takes ${n} argument${n === 1 ? "" : "s"}, got ${rest.length}`);
  return rest;
}

/** argv (after the program) as a command; throws with the reason on a usage error. */
export function parseCommand(argv: string[]): Command {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "start": {
      assertKnownFlags(rest, ["--repo", "--config"]);
      const repo = takeValue(rest, "--repo");
      const config = takeValue(repo.rest, "--config");
      const [request] = positionals(config.rest, 1, "start");
      if (repo.value === undefined) throw new Error("start needs --repo <path>");
      if (request!.trim() === "") throw new Error("start needs a non-empty request");
      return { cmd, request: request!, repo: repo.value, ...(config.value === undefined ? {} : { config: config.value }) };
    }
    case "answer": {
      const [run, text] = positionals(rest, 2, "answer");
      return { cmd, run: run!, text: text! };
    }
    case "cancel":
    case "status":
      return { cmd, run: positionals(rest, 1, cmd)[0]! };
    case "draw":
      return { cmd, target: positionals(rest, 1, "draw")[0]! };
    case "export":
      return { cmd, module: positionals(rest, 1, "export")[0]! };
    case "stats": {
      assertKnownFlags(rest, []);
      if (rest.length > 1) throw new Error(`stats takes at most 1 argument, got ${rest.length}`);
      return { cmd, ...(rest[0] === undefined ? {} : { stateDir: rest[0] }) };
    }
    case "dev":
      positionals(rest, 0, "dev");
      return { cmd };
    default:
      throw new Error(`unknown command ${JSON.stringify(cmd ?? "")}`);
  }
}

/** `g-<UTC yyyymmdd-HHMMSS>-<hex>`: sortable, and free of whitespace and `=` (it is a build event's unit id). */
export function newRunId(now: Date, randomHex: string): string {
  const t = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `g-${t}-${randomHex}`;
}

/** What `cancel` does with run `run`, by its status: an ended run is only reported (nothing is sent),
 *  any other is cancelled, named with the phase it was in. A status that could not be read (the run
 *  has no record yet and no worker answers its query) is still cancelled: the server keeps the
 *  request, and the run stops once a worker runs it. */
export function cancelPlan(run: string, h: Pick<RunHistory, "phase"> | { unread: string }): { send: boolean; line: string } {
  if ("unread" in h) return { send: true, line: `cancelled ${run}, whose status could not be read (${h.unread}): the run stops once its worker runs (build-graph dev)` };
  if (isEnded(h.phase)) return { send: false, line: `run ${run} already ended: ${h.phase}; nothing sent` };
  return { send: true, line: `cancelled ${run}, which was ${h.phase}: build-graph status ${run} shows it once it has stopped` };
}

export function formatStatus(h: RunHistory): string {
  const lines = [`run ${h.runId} (graph ${h.graph.id}): ${h.phase}`];
  if (h.error !== undefined) lines.push(`  error: ${h.error}`);
  const width = Math.max(...h.nodes.map((n) => n.node.length + (n.iteration > 0 ? String(n.iteration).length + 2 : 0)), 4);
  for (const n of h.nodes) {
    const name = n.iteration > 0 ? `${n.node} #${n.iteration}` : n.node;
    const attempt = n.attempt !== undefined && n.attempt > 1 ? ` (attempt ${n.attempt})` : "";
    const why = n.reason === undefined || n.status === "waiting" ? "" : `: ${n.reason}`;
    const answer = n.answer === undefined ? "" : `: ${n.answer}`;
    lines.push(`  ${name.padEnd(width)}  ${n.status}${answer}${attempt}${restartsNote(n.restarts)}${why}`);
  }
  for (const l of h.loops) lines.push(`  loop ${l.loop}: ${l.iterations} iteration${l.iterations === 1 ? "" : "s"}${l.outcome === undefined ? "" : `, ${l.outcome}`}`);
  if (h.asking.length > 0) {
    lines.push("waiting on the operator; the next answer goes to the first question:");
    for (const a of h.asking) lines.push(`  ${a.node}${a.iteration > 0 ? ` #${a.iteration}` : ""} asks: ${a.question}`);
    lines.push(`  reply: build-graph answer ${h.runId} "<text>"`);
  }
  return `${lines.join("\n")}\n`;
}
