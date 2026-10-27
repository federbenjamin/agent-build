/** The build pipeline module a run config names (`"pipeline"`): its checks and data operations. */

import type { Pipeline } from "../../adapters/types.ts";
import { CHECKS } from "./checks.ts";
import { OPS } from "./ops.ts";

export const pipeline: Pipeline = { checks: CHECKS, ops: OPS };
