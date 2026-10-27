/**
 * The one place the graph fires a build event: `blocked` when a node waits on the operator, and
 * `finished` once when a run ends. Each is handed to the consumer the run carries (`events`, the
 * `BUILD_EVENT_CMD` of the process that started it, never the worker's) by the runtime's own emitter
 * (`runtime/buildEvent.ts`, docs/build-events.md), run as a child process the worker awaits, so a
 * slow consumer never stalls the worker's other activities or their heartbeats.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BUILD_EVENT_CMD, type BUILD_EVENT_FIELDS, consumerLine, eventFlag, type FinishedOutcome } from "../runtime/lib/buildEvents.ts";
import { RunError } from "./contracts.ts";

const EMITTER = fileURLToPath(new URL("../runtime/buildEvent.ts", import.meta.url));

/** The run an event is about: its id, and the repo under build (the emitter reads its thresholds there). */
export interface EventRun {
  runId: string;
  repo: string;
  /** The consumer command line the run carries (`WorkflowInput.events`); absent or blank, nothing fires. */
  events?: string;
}

export interface BlockedEvent extends EventRun {
  node: string;
  question: string;
}

export interface FinishedEvent extends EventRun {
  outcome: FinishedOutcome;
  pr?: number;
  branch?: string;
  /** The worktrees the run left on disk. */
  worktrees: string[];
}

/** The `needs` text of the event: who asks, what, and how to answer. */
export const blockedNeeds = (e: BlockedEvent): string =>
  `node ${e.node} asks: ${e.question} (reply: build-graph answer ${e.runId} "<text>")`;

type Fields<K extends keyof typeof BUILD_EVENT_FIELDS> = Partial<Record<(typeof BUILD_EVENT_FIELDS)[K][number], string | number | readonly string[]>>;

/** Fire `kind` for `run` with its fields as the emitter's flags (a list repeats its flag, an empty
 *  one is left out); resolves to the emitter's warnings (a failed consumer is a warning, never a
 *  failure), or to none, spawning nothing, when the run carries no consumer or a blank one. An event the emitter
 *  refuses is a `RunError`. */
export async function fireBuildEvent<K extends "blocked" | "finished">(kind: K, run: EventRun, fields: Fields<K>): Promise<string[]> {
  const events = consumerLine({ [BUILD_EVENT_CMD]: run.events });
  if (events === "") return [];
  const flags = Object.entries(fields).flatMap(([field, v]) =>
    v === undefined ? [] : (Array.isArray(v) ? (v as readonly string[]) : [String(v)]).flatMap((x) => [eventFlag(field), x])
  );
  const args = [EMITTER, kind, "--runid", run.runId, ...flags];
  try {
    const { stderr } = await promisify(execFile)(process.execPath, args, { cwd: run.repo, env: { ...process.env, [BUILD_EVENT_CMD]: events }, encoding: "utf8" });
    return stderr.split("\n").filter((l) => l.trim() !== "");
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    throw new RunError(`${kind} event refused: ${stderr || (err as Error).message}`);
  }
}

export const fireBlockedEvent = (e: BlockedEvent): Promise<string[]> =>
  fireBuildEvent("blocked", e, { id: e.runId, needs: blockedNeeds(e) });

export const fireFinishedEvent = (e: FinishedEvent): Promise<string[]> =>
  fireBuildEvent("finished", e, { outcome: e.outcome, pr: e.pr, branch: e.branch, worktrees: e.worktrees });
