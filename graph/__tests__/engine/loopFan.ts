/**
 * The checks of the fan-out-inside-a-loop test (`../workflowLoopFan.test.ts`): each iteration lists its
 * own items, an item's check fails for item A in iteration 1 only, and the loop stops on iteration 2,
 * saying what the fan-out handed it.
 */

import type { DataValue } from "../../contracts.ts";
import type { Pipeline } from "../../adapters/types.ts";

const LISTS: Record<number, { id: string; after: string[] }[]> = {
  1: [
    { id: "A", after: [] },
    { id: "B", after: [] },
  ],
  2: [
    { id: "A", after: [] },
    { id: "C", after: ["A"] },
  ],
};

const fileCount = (v: DataValue | undefined): number => (v?.schema === "files" ? v.files.length : 0);

export const pipeline: Pipeline = {
  checks: {
    async plan(req) {
      return { answer: "pass", detail: `iteration ${req.iteration}`, outputs: { items: { schema: "items", items: LISTS[req.iteration] ?? [] } } };
    },
    async each(req) {
      if (req.instance === "A" && req.iteration === 1) throw new Error("A breaks in iteration 1");
      return { answer: "pass", detail: `${req.instance}@${req.iteration}: ${fileCount(req.inputs.work)} file` };
    },
    async stop(req) {
      const status = req.inputs["fan-ok"];
      return {
        answer: req.iteration >= 2 ? "pass" : "fail",
        detail: `iteration ${req.iteration}: ${fileCount(req.inputs.work)} work files, fan ${status?.schema === "check" ? status.answer : "absent"}`,
      };
    },
  },
  ops: {},
};
