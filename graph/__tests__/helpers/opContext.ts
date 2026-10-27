/** The one builder of a test `OpContext`: a data operation's context rooted in a scratch `dir`. */

import { join } from "node:path";

import { fileForge, fileTracker } from "../../adapters/fileFakes.ts";
import type { OpContext } from "../../adapters/types.ts";
import type { RunPlace } from "../../contracts.ts";

export type OpContextFields = Pick<OpContext, "nodeId" | "role" | "inputs" | "outputs"> & Partial<Omit<OpContext, "place">> & { place?: Partial<RunPlace> };

/** A context for the node `fields` names, run `r`, at iteration 0, writing to `<dir>/out`, its run
 *  tree `dir` on branch `b`, the file tracker and forge under `<dir>/t` and `<dir>/f`, and a run-tree
 *  lock that only runs `fn`. A field given overrides its default; `place` overrides field by field. */
export function opContext(dir: string, fields: OpContextFields): OpContext {
  const { place, ...rest } = fields;
  return {
    runId: "r",
    outDir: join(dir, "out"),
    iteration: 0,
    tracker: fileTracker(join(dir, "t")),
    forge: fileForge(join(dir, "f")),
    signal: new AbortController().signal,
    answers: [],
    withRunTree: async (fn) => fn(),
    ...rest,
    place: { runDir: dir, worktree: dir, branch: "b", baseSha: "", ...place },
  };
}
