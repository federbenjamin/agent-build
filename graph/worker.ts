/** The worker: the generic workflow and the node activities on the runner's task queue. */

import { fileURLToPath } from "node:url";

import { type NativeConnection, Runtime, Worker, type WorkerOptions } from "@temporalio/worker";

import * as activities from "./activities.ts";
import { TASK_QUEUE, WORKER_SHUTDOWN_SIGNALS } from "./constants.ts";

export const WORKFLOWS_PATH = fileURLToPath(new URL("./workflow.ts", import.meta.url));

export interface WorkerSetup {
  connection: NativeConnection;
  taskQueue?: string;
  /** A prebuilt bundle (`bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH })`); else the worker bundles on start. */
  workflowBundle?: WorkerOptions["workflowBundle"];
  shutdownGraceTime?: WorkerOptions["shutdownGraceTime"];
}

let runtimeInstalled = false;

/** Install the process's one Temporal runtime with `WORKER_SHUTDOWN_SIGNALS`; call it once, before
 *  the first connection or worker is made (those create a default runtime that cannot be replaced). */
export function installWorkerRuntime(): Runtime {
  if (runtimeInstalled) return Runtime.instance();
  const runtime = Runtime.install({ shutdownSignals: WORKER_SHUTDOWN_SIGNALS });
  runtimeInstalled = true;
  return runtime;
}

export function createWorker(setup: WorkerSetup): Promise<Worker> {
  return Worker.create({
    connection: setup.connection,
    taskQueue: setup.taskQueue ?? TASK_QUEUE,
    activities,
    ...(setup.workflowBundle === undefined ? { workflowsPath: WORKFLOWS_PATH } : { workflowBundle: setup.workflowBundle }),
    ...(setup.shutdownGraceTime === undefined ? {} : { shutdownGraceTime: setup.shutdownGraceTime }),
  });
}
