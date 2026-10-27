/**
 * `build-graph dev`: attach to the Temporal server at the address, or start a local dev server whose
 * history lives in `<state dir>/temporal.db`, then run the worker until interrupted. A server this
 * command started stops with it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";

import { DEV_CONNECT_TIMEOUT_MS, DEV_SERVER_POLL_MS, DEV_SERVER_READY_MS, DEV_UI_PORT_OFFSET } from "./constants.ts";
import { createWorker, installWorkerRuntime } from "./worker.ts";

/** Whether a Temporal frontend answers at `address`. */
export async function serverAnswers(address: string): Promise<boolean> {
  try {
    const c = await Connection.connect({ address, connectTimeout: DEV_CONNECT_TIMEOUT_MS });
    await c.close();
    return true;
  } catch {
    return false;
  }
}

/** The `temporal server start-dev` argv for `address` (`host:port`), its UI `DEV_UI_PORT_OFFSET` above. */
export function devServerArgs(address: string, dbFile: string): string[] {
  const m = /^(.+):(\d+)$/.exec(address);
  if (m === null) throw new Error(`TEMPORAL_ADDRESS ${address} is not <host>:<port>`);
  const port = Number(m[2]);
  return ["server", "start-dev", "--db-filename", dbFile, "--ip", m[1]!, "--port", String(port), "--ui-port", String(port + DEV_UI_PORT_OFFSET)];
}

async function startDevServer(address: string, stateDir: string): Promise<ChildProcess> {
  mkdirSync(stateDir, { recursive: true });
  const logFile = join(stateDir, "temporal-dev.log");
  const out = openSync(logFile, "a");
  const child = spawn("temporal", devServerArgs(address, join(stateDir, "temporal.db")), { stdio: ["ignore", out, out] });
  let exited: string | null = null;
  child.on("exit", (code, signal) => (exited = `exited ${code ?? signal}`));
  child.on("error", (e) => (exited = e.message));
  const deadline = Date.now() + DEV_SERVER_READY_MS;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`temporal server start-dev ${exited}; see ${logFile}`);
    if (await serverAnswers(address)) return child;
    await sleep(DEV_SERVER_POLL_MS);
  }
  child.kill();
  throw new Error(`temporal server start-dev did not answer at ${address} within ${DEV_SERVER_READY_MS} ms; see ${logFile}`);
}

export async function runDev(address: string, stateDir: string, say: (line: string) => void): Promise<void> {
  let server: ChildProcess | null = null;
  if (await serverAnswers(address)) say(`attached to the Temporal server at ${address}`);
  else {
    server = await startDevServer(address, stateDir);
    say(`started a Temporal dev server at ${address} (db ${join(stateDir, "temporal.db")}, log ${join(stateDir, "temporal-dev.log")})`);
  }
  try {
    installWorkerRuntime();
    const connection = await NativeConnection.connect({ address });
    try {
      const worker = await createWorker({ connection });
      say("worker running; Ctrl-C stops it");
      await worker.run();
    } finally {
      await connection.close();
    }
  } finally {
    if (server !== null) {
      server.kill("SIGTERM");
      say("stopped the dev server");
    }
  }
}
