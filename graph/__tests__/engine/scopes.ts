/**
 * The check of the engine's question-routing test (`../workflowScopes.test.ts`): it asks Q1 on its
 * first run, Q1 again and a new Q2 on its second, and nothing after, counting its runs in the run dir.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Pipeline } from "../../adapters/types.ts";

const ask = (id: string) => ({ id, type: "brief" as const, text: `which ${id}?`, searched: [{ source: "brief", said: "unclear" }] });

export const pipeline: Pipeline = {
  checks: {
    async reask(req) {
      const file = join(req.place.runDir, "reask-count");
      const n = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
      writeFileSync(file, String(n));
      const questions = n === 1 ? [ask("Q1")] : n === 2 ? [ask("Q1"), ask("Q2")] : [];
      return { answer: "pass", detail: `run ${n}`, questions };
    },
  },
  ops: {},
};
