/**
 * The one way an adapter runs a child process: async (the worker keeps heartbeating while it runs),
 * killed with its whole process group when the signal aborts, output kept as a bounded tail. It is
 * the boundary the adapters' tests stub.
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { ADAPTER_SECRET_ENV, PROCESS_KILL_GRACE_MS, PROCESS_KILL_POLL_MS, PROCESS_KILL_WAIT_MS, PROCESS_OUTPUT_KEEP_CHARS } from "../constants.ts";

export interface ProcessOptions {
  cwd?: string;
  /** Written to the child's stdin, which then closes. */
  input?: string;
  /** The child's environment (default: ours), less the adapters' API keys. */
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Called once with the child's pid (its process group id) right after it spawns. */
  onSpawn?: (pid: number) => void;
}

export interface ProcessResult {
  /** The exit code; null when the child ended on a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Both streams in the order they arrived. */
  output: string;
}

/** The given environment without the adapters' API keys. */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...base };
  for (const k of ADAPTER_SECRET_ENV) delete out[k];
  return out;
}

export type ProcessRunner = (cmd: string, args: string[], opts: ProcessOptions) => Promise<ProcessResult>;

/** A tail-keeping text buffer: past twice `keep` characters it drops the oldest down to `keep`, so
 *  trimming costs a slice per `keep` characters of output, not one per chunk. */
class Tail {
  #text = "";
  readonly #keep: number;
  constructor(keep: number) {
    this.#keep = keep;
  }
  add(chunk: string): void {
    this.#text += chunk;
    if (this.#text.length > 2 * this.#keep) this.#text = this.#text.slice(-this.#keep);
  }
  get text(): string {
    return this.#text.length > this.#keep ? this.#text.slice(-this.#keep) : this.#text;
  }
}

/** Whether any process of group `pid` is left. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // the group is already gone
  }
}

/** SIGTERM the group, SIGKILL it when the grace period passes with anything still alive, and resolve
 *  once no process of it is left (or, after the SIGKILL, a short wait). The leader exiting is not
 *  the end: a descendant that ignores SIGTERM keeps the group alive. */
export async function terminateGroup(pid: number): Promise<void> {
  killGroup(pid, "SIGTERM");
  const graceEnds = Date.now() + PROCESS_KILL_GRACE_MS;
  while (groupAlive(pid) && Date.now() < graceEnds) await delay(PROCESS_KILL_POLL_MS);
  if (!groupAlive(pid)) return;
  killGroup(pid, "SIGKILL");
  const waitEnds = Date.now() + PROCESS_KILL_WAIT_MS;
  while (groupAlive(pid) && Date.now() < waitEnds) await delay(PROCESS_KILL_POLL_MS);
}

/** Run `cmd`; on abort it rejects with the signal's reason once the child's whole process group is
 *  gone, so a retry never overlaps the attempt it replaces; with the spawn error when the program
 *  cannot start. */
export const runProcess: ProcessRunner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(opts.signal.reason);
      return;
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: childEnv(opts.env ?? process.env),
      detached: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    const out = new Tail(PROCESS_OUTPUT_KEEP_CHARS);
    const err = new Tail(PROCESS_OUTPUT_KEEP_CHARS);
    const both = new Tail(PROCESS_OUTPUT_KEEP_CHARS);
    child.stdout!.setEncoding("utf8").on("data", (c: string) => (out.add(c), both.add(c)));
    child.stderr!.setEncoding("utf8").on("data", (c: string) => (err.add(c), both.add(c)));
    child.stdin?.on("error", () => {});
    if (opts.input !== undefined) child.stdin!.end(opts.input);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      const reason = opts.signal.reason;
      if (child.pid === undefined) return reject(reason);
      void terminateGroup(child.pid).then(() => reject(reason));
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => {
      opts.signal.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      if (!aborted) resolve({ code, stdout: out.text, stderr: err.text, output: both.text });
    });
  });
