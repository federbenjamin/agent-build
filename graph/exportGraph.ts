/** `build-graph export`: a graph as the JSON a reader outside this package parses (`GraphExport`). Pure. */

import { type ExportedEdge, type ExportedNode, type GraphDef, type GraphExport, opSpec } from "./contracts.ts";
import { fanOutOf, loopOf, producers, serviceIds } from "./define.ts";

/** Each node with its doc and where it sits, every data item, loop, fan-out and service, and one edge
 *  per input a node reads from the node that writes it. Throws naming every node with no doc. */
export function exportGraph(graph: GraphDef): GraphExport {
  const undocumented = graph.nodes.filter((n) => (n.doc ?? "").trim() === "").map((n) => n.id);
  if (undocumented.length > 0) throw new Error(`graph ${graph.id}: no doc on ${undocumented.join(", ")}`);
  const services = serviceIds(graph);
  const nodes = graph.nodes.map(
    (n): ExportedNode => ({
      id: n.id,
      doc: n.doc!,
      kind: n.kind,
      role: n.role,
      inputs: [...n.inputs],
      optionalInputs: [...(n.optionalInputs ?? [])],
      outputs: [...n.outputs],
      gate: n.gate === undefined ? null : structuredClone(n.gate),
      writes: n.writes === true,
      capMin: n.timeCapMs ? Math.round(n.timeCapMs / 60_000) : null,
      loop: loopOf(graph, n.id)?.id ?? null,
      fanOut: fanOutOf(graph, n.id)?.id ?? null,
      service: services.has(n.id),
      readsRecord: n.readsRecord === true,
      answers: n.answers ?? null,
      runsOnce: n.kind === "data" && opSpec(graph, n.role)?.idempotent === false,
    }),
  );
  const writer = producers(graph);
  const edges: ExportedEdge[] = graph.nodes.flatMap((n) =>
    [...n.inputs, ...(n.optionalInputs ?? [])].flatMap((item) => {
      const from = writer.get(item);
      return from === undefined ? [] : [{ from: from.id, to: n.id, item, optional: !n.inputs.includes(item) }];
    }),
  );
  return {
    id: graph.id,
    nodes,
    data: structuredClone(graph.data),
    amended: graph.amended === undefined ? null : structuredClone(graph.amended),
    loops: structuredClone(graph.loops),
    fanOuts: structuredClone(graph.fanOuts ?? []),
    services: graph.services === undefined ? null : structuredClone(graph.services),
    edges,
  };
}
