/**
 * The run store keys of a node run (`nodes/<node>/<iteration>[/<item>]`), its output folder, its agent's
 * pgid record, each of its attempts' records (`<node run>/rerun-<r>/attempt-<n>`), and the folder beside
 * each record that keeps that attempt's side files once a later attempt runs (`.../attempt-<n>/out`).
 * The activities write under them; `stats`'s run-dir reader (`runDirs.ts`), the run's end sweep and a
 * fixer's peers read them back; and a node run's session name (`sessionName`). Pure, so the reader
 * takes them without the activity context.
 */

import type { NodeTask } from "./contracts.ts";

type NodeRunOf = Pick<NodeTask, "iteration" | "instance"> & { node: Pick<NodeTask["node"], "id"> };

/** A run-store key segment for a fan-out item or a service's subject (`#`, `:`, `@` become `_`). */
export const keySegment = (s: string): string => s.replace(/[^\w.-]/g, "_");

export const nodeKey = (task: NodeRunOf): string => `nodes/${task.node.id}/${task.iteration}${task.instance === undefined ? "" : `/${keySegment(task.instance)}`}`;

/** The name a node run's agent session runs under (`claude -n`), and so the address a peer messages
 *  it at: `<run>-<node>-<iteration>[-<item>]`, each part a key segment. */
export const sessionName = (runId: string, nodeId: string, iteration: number, item?: string): string =>
  [runId, nodeId, String(iteration), ...(item === undefined ? [] : [item])].map(keySegment).join("-");

/** The node run's output folder: one folder per output id below it. */
export const outKey = (task: NodeRunOf): string => `${nodeKey(task)}/out`;

/** Where an attempt's record lives: one per attempt of each run of a node, so a retry, a schema rerun
 *  and the rerun on an operator's answer each get their own. */
export const attemptKey = (task: NodeRunOf & Pick<NodeTask, "rerun">, attempt: number): string => `${nodeKey(task)}/rerun-${task.rerun ?? 0}/attempt-${attempt}`;

/** Where an attempt's side files (`KEPT_SIDE_FILES`) are kept once the next attempt of its node run
 *  empties the output folder: the same `<output id>/<file>` below it. */
export const attemptOutKey = (task: NodeRunOf & Pick<NodeTask, "rerun">, attempt: number): string => `${attemptKey(task, attempt)}/out`;

/** Where an attempt records its agent's process group: `{ pid }` while it runs, `{ pid: null }` once
 *  the attempt has ended here, so a pid the OS has since reused is never signalled. */
export const pgidKey = (task: NodeRunOf): string => `${nodeKey(task)}/pgid`;

const ATTEMPT_KEY = /^(nodes\/.+)\/rerun-(\d+)\/attempt-(\d+)$/;
// Directly in a node run's folder (`nodeKey`), never inside its output folder, which an agent writes.
const PGID_KEY = /^(nodes\/[^/]+\/\d+(?:\/(?!out\/)[\w.-]+)?)\/pgid$/;
const OUTPUT_FILE = /^(nodes\/.+)\/out\/[^/]+\/([^/]+)$/;
const KEPT_FILE = /^(nodes\/.+)\/rerun-(\d+)\/attempt-(\d+)\/out\/[^/]+\/([^/]+)$/;

/** One attempt of a node run, in the order attempts run: by rerun, then by attempt. */
export interface AttemptAt {
  rerun: number;
  attempt: number;
}

/** The node run whose attempt record `key` is (`attemptKey`), and which attempt; null for any other key. */
export function attemptAt(key: string): (AttemptAt & { nodeRun: string }) | null {
  const m = ATTEMPT_KEY.exec(key);
  return m === null ? null : { nodeRun: m[1]!, rerun: Number(m[2]), attempt: Number(m[3]) };
}

/** The node run whose attempt record `key` is (`attemptKey`); null for any other key. */
export const attemptOwner = (key: string): string | null => attemptAt(key)?.nodeRun ?? null;

/** The latest of `recorded` that ran before `current`; null when none did. */
export function attemptBefore(recorded: readonly AttemptAt[], current: AttemptAt): AttemptAt | null {
  const order = (a: AttemptAt, b: AttemptAt): number => a.rerun - b.rerun || a.attempt - b.attempt;
  return [...recorded].filter((a) => order(a, current) < 0).sort(order).at(-1) ?? null;
}

/** The node run whose pgid record `key` is (`pgidKey`); null for any other key. */
export const pgidOwner = (key: string): string | null => PGID_KEY.exec(key)?.[1] ?? null;

/** The node run and file name of a file directly in one of a node run's output folders (`outKey`), or
 *  in one an earlier attempt's side files were kept in (`attemptOutKey`), which names that attempt as
 *  `kept`; null for any other path. */
export function outputFileOwner(path: string): { nodeRun: string; name: string; kept?: AttemptAt } | null {
  const k = KEPT_FILE.exec(path);
  if (k !== null) return { nodeRun: k[1]!, name: k[4]!, kept: { rerun: Number(k[2]), attempt: Number(k[3]) } };
  const m = OUTPUT_FILE.exec(path);
  return m === null ? null : { nodeRun: m[1]!, name: m[2]! };
}
