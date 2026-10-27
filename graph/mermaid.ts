/**
 * A graph as a Mermaid flowchart, styled by kind: agents as boxes, classifiers as diamonds, checks
 * as subroutines, data nodes as parallelograms and data items as cylinders. Given a run's history it
 * marks each node with its worst status (ran, skipped, failed, cancelled, or still running or waiting) and each
 * loop with its iterations and outcome. Pure.
 */

import type { FanOutDef, FanOutRun, GraphDef, NodeDef, NodeRun, NodeStatus, RunHistory } from "./contracts.ts";
import { carriedReads, gateLeaves, leafData, loopOf, parentScope, producers, scopeKey, scopeOf, serviceIds } from "./define.ts";

/** The class each node status draws with; `done` reads `ran`. */
export const STATUS_CLASS: Record<NodeStatus, string> = {
  done: "ran",
  skipped: "skipped",
  failed: "failed",
  running: "live",
  waiting: "live",
  cancelled: "cancelled",
};
const STATUS_WORD: Record<NodeStatus, string> = { done: "ran", skipped: "skipped", failed: "failed", running: "running", waiting: "waiting", cancelled: "cancelled" };

const CLASS_DEFS = [
  "classDef agent fill:#dbeafe,stroke:#1e40af,color:#0f172a",
  "classDef classifier fill:#fef3c7,stroke:#b45309,color:#0f172a",
  "classDef check fill:#dcfce7,stroke:#15803d,color:#0f172a",
  "classDef data fill:#f3e8ff,stroke:#7e22ce,color:#0f172a",
  "classDef ran stroke:#16a34a,stroke-width:3px",
  "classDef skipped stroke-dasharray:5 5,opacity:0.55",
  "classDef failed stroke:#dc2626,stroke-width:3px",
  "classDef live stroke:#2563eb,stroke-width:3px",
  "classDef cancelled stroke:#6b7280,stroke-width:3px,stroke-dasharray:2 2",
];

/** A Mermaid-safe id: letters, digits and `_`; every other character as `_<hex>_`, so two ids never meet. */
export function mermaidId(prefix: string, id: string): string {
  return `${prefix}_${id.replace(/[^A-Za-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
}

const label = (text: string): string => `"${text.replaceAll('"', "#quot;")}"`;
const nid = (id: string) => mermaidId("n", id);
const did = (id: string) => mermaidId("d", id);

function shape(node: NodeDef, text: string): string {
  const l = label(text);
  switch (node.kind) {
    case "agent":
      return `${nid(node.id)}[${l}]`;
    case "classifier":
      return `${nid(node.id)}{${l}}`;
    case "check":
      return `${nid(node.id)}[[${l}]]`;
    case "data":
      return `${nid(node.id)}[/${l}/]`;
  }
}

/** How bad each status is: a node is drawn with its worst record, so a failure in one loop iteration
 *  stays visible after a later one ran. */
const SEVERITY: Record<NodeStatus, number> = { skipped: 0, done: 1, running: 2, waiting: 3, cancelled: 4, failed: 5 };

/** The worst record of each node in the history (the later one on a tie). */
export function worstRuns(history: RunHistory | undefined): Map<string, NodeRun> {
  const out = new Map<string, NodeRun>();
  for (const r of history?.nodes ?? []) {
    const seen = out.get(r.node);
    if (seen === undefined || SEVERITY[r.status] >= SEVERITY[seen.status]) out.set(r.node, r);
  }
  return out;
}

/** How many records of a node ended each way: `ran 3, skipped 1`. */
function tally(history: RunHistory | undefined, node: string): string {
  const counts = new Map<string, number>();
  for (const r of history?.nodes ?? []) if (r.node === node) counts.set(STATUS_WORD[r.status], (counts.get(STATUS_WORD[r.status]) ?? 0) + 1);
  return [...counts].map(([w, n]) => `${w} ${n}`).join(", ");
}

export function renderMermaid(graph: GraphDef, history?: RunHistory): string {
  const runs = worstRuns(history);
  const produce = producers(graph);
  const lines = ["flowchart LR", `  %% graph ${graph.id}${history === undefined ? "" : `, run ${history.runId} (${history.phase})`}`];
  lines.push(...CLASS_DEFS.map((c) => `  ${c}`));

  const many = (id: string): boolean => (history?.nodes ?? []).filter((r) => r.node === id).length > 1;
  const nodeLine = (node: NodeDef): string => {
    const run = runs.get(node.id);
    const status =
      run === undefined
        ? ""
        : `<br/>${STATUS_WORD[run.status]}${run.iteration > 0 ? ` #${run.iteration}` : ""}${run.instance === undefined ? "" : ` @${run.instance}`}${run.answer === undefined ? "" : `: ${run.answer}`}${many(node.id) ? ` (${tally(history, node.id)})` : ""}`;
    return `${shape(node, `${node.id}<br/><i>${node.kind}: ${node.role}</i>${status}`)}:::${node.kind}`;
  };
  const itemLine = (id: string): string => {
    const item = graph.data.find((d) => d.id === id)!;
    const tag = item.boundary === undefined ? item.schema : `${item.schema}, ${item.boundary}`;
    return `${did(id)}[(${label(`${id}<br/><i>${tag}</i>`)})]:::data`;
  };
  const services = serviceIds(graph);
  const bodyOf = (id: string): string | undefined => {
    const by = produce.get(id);
    if (by === undefined) return undefined;
    if (services.has(by.id)) return "services";
    const sc = scopeOf(graph, by.id);
    return sc === undefined ? undefined : scopeKey(sc);
  };
  const top = (n: NodeDef) => scopeOf(graph, n.id) === undefined && !services.has(n.id);

  for (const node of graph.nodes) if (top(node)) lines.push(`  ${nodeLine(node)}`);
  for (const item of graph.data) if (bodyOf(item.id) === undefined) lines.push(`  ${itemLine(item.id)}`);
  const fanTitle = (fan: FanOutDef): string => {
    const runs = (history?.fanOuts ?? []).filter((f) => f.fanOut === fan.id);
    const items = (r: FanOutRun) => (r.items.length === 0 ? "no items" : r.items.join(", "));
    const ran = runs.length === 0 ? "" : parentScope(graph, { kind: "fan", id: fan.id }) === null ? `: ${items(runs[0]!)}` : `: ${runs.map((r) => `#${r.iteration} ${items(r)}`).join("; ")}`;
    return `for each ${fan.over} (${fan.id})${ran}`;
  };
  const body = (key: string, title: string, members: readonly string[], indent: string, nested: () => void = () => {}): void => {
    lines.push(`${indent}subgraph ${mermaidId("s", key)}[${label(title)}]`);
    for (const id of members) lines.push(`${indent}  ${nodeLine(graph.nodes.find((n) => n.id === id)!)}`);
    for (const item of graph.data) if (bodyOf(item.id) === key) lines.push(`${indent}  ${itemLine(item.id)}`);
    nested();
    lines.push(`${indent}end`);
  };
  const fanBody = (fan: FanOutDef, indent: string) => body(`fan:${fan.id}`, fanTitle(fan), fan.nodes, indent);
  const fansIn = (loop: string | null) => (graph.fanOuts ?? []).filter((f) => parentScope(graph, { kind: "fan", id: f.id })?.id === (loop ?? undefined));
  for (const loop of graph.loops) {
    const run = history?.loops.find((l) => l.loop === loop.id);
    const ran = run === undefined ? "" : `, ${run.iterations} iteration${run.iterations === 1 ? "" : "s"}${run.outcome === undefined ? "" : `, ${run.outcome}`}`;
    const ref = { kind: "loop" as const, id: loop.id };
    const own = loop.nodes.filter((id) => scopeKey(scopeOf(graph, id) ?? null) === scopeKey(ref));
    body(`loop:${loop.id}`, `loop ${loop.id}: until ${loop.until.node} = ${loop.until.answer}, cap ${loop.cap}${ran}`, own, "  ", () => {
      for (const fan of fansIn(loop.id)) fanBody(fan, "    ");
    });
  }
  for (const fan of fansIn(null)) fanBody(fan, "  ");
  if (services.size > 0) {
    const asked = history?.questions?.length;
    body("services", `runner services${asked === undefined ? "" : `: ${asked} question${asked === 1 ? "" : "s"}`}`, [...services], "  ");
  }

  for (const node of graph.nodes) {
    for (const id of node.outputs) lines.push(`  ${nid(node.id)} --> ${did(id)}`);
    const loop = loopOf(graph, node.id);
    const carry = loop === undefined ? new Set<string>() : (carriedReads(graph, loop).get(node.id) ?? new Set<string>());
    for (const id of node.inputs) lines.push(`  ${did(id)} --> ${nid(node.id)}`);
    for (const id of node.optionalInputs ?? []) {
      lines.push(carry.has(id) ? `  ${did(id)} -.->|next iteration| ${nid(node.id)}` : `  ${did(id)} -.-> ${nid(node.id)}`);
    }
    if (node.gate !== undefined) {
      const leaves = gateLeaves(node.gate);
      const any = "anyOf" in node.gate;
      for (const leaf of leaves) {
        const out = leafData(graph, leaf);
        if (out !== undefined) lines.push(`  ${did(out)} -.->|${label(`${any && leaves.length > 1 ? "or " : ""}gate = ${leaf.answer}`)}| ${nid(node.id)}`);
      }
    }
  }
  for (const loop of graph.loops) if (loop.outcome !== undefined) lines.push(`  ${mermaidId("s", `loop:${loop.id}`)} --> ${did(loop.outcome)}`);
  for (const fan of graph.fanOuts ?? []) lines.push(`  ${did(fan.over)} -.->|for each| ${mermaidId("s", `fan:${fan.id}`)}`);
  for (const fan of graph.fanOuts ?? []) if (fan.status !== undefined) lines.push(`  ${mermaidId("s", `fan:${fan.id}`)} --> ${did(fan.status)}`);

  for (const [node, run] of runs) lines.push(`  class ${nid(node)} ${STATUS_CLASS[run.status]}`);
  return `${lines.join("\n")}\n`;
}
