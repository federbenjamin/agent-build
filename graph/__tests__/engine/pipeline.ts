/**
 * The checks of the engine's service tests (`../services.test.ts`): a brief parser, a check that asks
 * a brief question while the brief is v1 (and, on the request `dirty`, leaves a local edit in the run
 * tree that the amend's merge would overwrite), a check that reports what it read, and a fan-out's
 * list and work; and an operation that waits on the operator and can end the run abandoned.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DataValue } from "../../contracts.ts";
import type { Pipeline } from "../../adapters/types.ts";

const firstLine = (v: DataValue | undefined): string => (v?.schema === "files" ? readFileSync(v.files[0]!, "utf8").split("\n")[0]! : "");
const textOf = (v: DataValue | undefined): string => (v?.schema === "text" ? v.text : "");

export const pipeline: Pipeline = {
  checks: {
    async parse(req) {
      const head = firstLine(req.inputs.brief);
      return { answer: head.startsWith("bad") ? "fail" : "pass", detail: `parsed ${head}`, outputs: { "brief-head": { schema: "text", text: head } } };
    },
    async ask(req) {
      if (!textOf(req.inputs["brief-head"]).startsWith("v1")) return { answer: "pass", detail: "the brief settles it" };
      if (textOf(req.inputs.request) === "dirty") writeFileSync(join(req.place.worktree, "README.md"), "a local edit the amend's merge would overwrite\n");
      return { answer: "pass", detail: "asks", questions: [{ id: "Q1", type: "brief", text: "which version?", searched: [{ source: "brief", said: "v1" }] }] };
    },
    async after(req) {
      return { answer: "pass", detail: `brief ${firstLine(req.inputs.brief)}; head ${textOf(req.inputs["brief-head"])}` };
    },
    async list() {
      const items = [
        { id: "P1", after: [] },
        { id: "P2", after: ["P1"] },
        { id: "P3", after: ["P2"] },
      ];
      return { answer: "pass", detail: "three items", outputs: { items: { schema: "items", items } } };
    },
    async work(req) {
      if (req.instance === "P1") throw new Error("P1 breaks");
      return { answer: "pass", detail: `worked ${req.instance}` };
    },
  },
  ops: {
    /** Asks the operator, with a waiting reason that holds more than the question, then ends the run
     *  on `abandon`, or passes with any other reply. */
    async wait(ctx) {
      const reply = ctx.answers.at(-1);
      if (reply === undefined) return { status: "needs-operator", question: "merge or abandon?", reason: "merge or abandon?\nwhat a step printed, which stays in the worker" };
      if (reply === "abandon") return { status: "abandon", reason: "the operator abandoned the run" };
      return { status: "done", outputs: { waited: { schema: "check", answer: "pass", detail: reply } } };
    },
  },
};
