import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runtime } from "@temporalio/worker";

import { WORKER_SHUTDOWN_SIGNALS } from "../constants.ts";
import { installWorkerRuntime } from "../worker.ts";

test("the worker's runtime shuts down on SIGHUP as well as the SDK's defaults, and installing twice returns the same runtime", () => {
  const runtime = installWorkerRuntime();
  assert.deepEqual(runtime.options.shutdownSignals, WORKER_SHUTDOWN_SIGNALS);
  for (const sig of ["SIGINT", "SIGTERM", "SIGQUIT", "SIGUSR2", "SIGHUP"]) assert.ok(runtime.options.shutdownSignals.includes(sig as NodeJS.Signals), sig);
  assert.equal(installWorkerRuntime(), runtime);
  assert.equal(Runtime.instance(), runtime);
});
