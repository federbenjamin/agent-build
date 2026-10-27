/**
 * The pipeline of the blocked-question tests (`../services.test.ts`): the build graph's own K-output-format
 * reading the questions an agent's `questions.json` raises.
 */

import type { Pipeline } from "../../adapters/types.ts";
import { schemaCheck } from "../../pipelines/build/schema.ts";

export const pipeline: Pipeline = { checks: { schema: schemaCheck }, ops: {} };
