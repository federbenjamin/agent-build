/** `build-graph export` (`exportGraph.ts`): every shipped graph's nodes carry a doc, and the build
 *  graph's export holds the `GraphExport` shape through JSON. */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExportedEdge, ExportedNode, GraphDef, GraphExport } from "../contracts.ts";
import { defineGraph } from "../define.ts";
import { exportGraph } from "../exportGraph.ts";
import { graph as build } from "../pipelines/build.ts";

const graphDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every key of `T`, and no other: a key the type gains or loses is a compile error here. */
type Keys<T> = readonly (keyof T)[];
type Exact<T, K extends Keys<T>> = Exclude<keyof T, K[number]> extends never ? K : never;
const keysOf = <T>() => <const K extends Keys<T>>(k: Exact<T, K>): readonly string[] => [...(k as readonly string[])].sort();

const EXPORT_KEYS = keysOf<GraphExport>()(["id", "nodes", "data", "amended", "loops", "fanOuts", "services", "edges"]);
const NODE_KEYS = keysOf<ExportedNode>()([
  "id",
  "doc",
  "kind",
  "role",
  "inputs",
  "optionalInputs",
  "outputs",
  "gate",
  "writes",
  "capMin",
  "loop",
  "fanOut",
  "service",
  "readsRecord",
  "answers",
  "runsOnce",
]);
const EDGE_KEYS = keysOf<ExportedEdge>()(["from", "to", "item", "optional"]);

test("every node of every graph the package ships (pipelines/, examples/) has a doc, so each one exports", async () => {
  const modules = ["pipelines", "examples"].flatMap((dir) =>
    readdirSync(join(graphDir, dir))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(graphDir, dir, f)),
  );
  const graphs = (await Promise.all(modules.map(async (m) => ((await import(pathToFileURL(m).href)) as { graph?: GraphDef }).graph))).filter(
    (g): g is GraphDef => g !== undefined,
  );
  assert.deepEqual(graphs.map((g) => g.id).sort(), ["build", "toy"]);
  for (const g of graphs) {
    for (const n of g.nodes) assert.ok((n.doc ?? "").trim() !== "", `${g.id}: ${n.id} has no doc`);
    assert.equal(exportGraph(g).nodes.length, g.nodes.length);
  }
});

test("the build graph's export survives JSON whole and holds exactly the GraphExport keys", () => {
  const out = exportGraph(build);
  const back = JSON.parse(JSON.stringify(out)) as GraphExport;
  assert.deepEqual(back, out);
  assert.deepEqual(Object.keys(back).sort(), EXPORT_KEYS);
  for (const n of back.nodes) assert.deepEqual(Object.keys(n).sort(), NODE_KEYS, n.id);
  for (const e of back.edges) assert.deepEqual(Object.keys(e).sort(), EDGE_KEYS);
  assert.deepEqual(
    back.nodes.map((n) => [n.id, n.doc]),
    build.nodes.map((n) => [n.id, n.doc]),
  );
  const fixer = back.nodes.find((n) => n.id === "A-fixer")!;
  assert.deepEqual([fixer.loop, fixer.fanOut, fixer.capMin, fixer.answers], ["close", "fix-slices", 90, "fix-answers"]);
  assert.deepEqual(back.nodes.filter((n) => n.runsOnce).map((n) => n.id), ["D-file-leftovers", "D-open-pr", "D-merge-pr"]);
  assert.ok(back.edges.some((e) => e.from === "D-plan-slices" && e.to === "A-fixer" && e.item === "slice-plan" && !e.optional));
  assert.ok(back.edges.some((e) => e.from === "A-link-slices" && e.to === "D-plan-slices" && e.item === "links" && e.optional));
});

test("export refuses a graph with a node that has no doc, naming each such node", () => {
  const g = defineGraph({
    id: "bare",
    data: [
      { id: "in", schema: "text", boundary: "input" },
      { id: "out", schema: "files", boundary: "terminal" },
      { id: "out2", schema: "files", boundary: "terminal" },
    ],
    nodes: [
      { id: "a", doc: "Reads in and writes out.", kind: "agent", role: "r", inputs: ["in"], outputs: ["out"], timeCapMs: 60_000 },
      { id: "b", doc: "  ", kind: "agent", role: "r", inputs: ["in"], outputs: ["out2"], timeCapMs: 60_000 },
    ],
  });
  assert.throws(() => exportGraph(g), /graph bare: no doc on b$/);
  assert.throws(() => exportGraph({ ...g, nodes: g.nodes.map(({ doc: _, ...n }) => n) }), /no doc on a, b$/);
});
