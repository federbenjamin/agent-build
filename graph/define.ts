/**
 * One pipeline's graph: the typed builder (`defineGraph`), its validation (`validateGraph`), and the
 * structural lookups the scheduler and the diagram share. Pure; the workflow bundle imports it.
 */

import {
  CHECK_ANSWERS,
  type DataItem,
  type DataSchema,
  DATA_OPS,
  DATA_SCHEMAS,
  type DataValue,
  type DataValues,
  type NodeRun,
  type FanOutDef,
  type Gate,
  type GraphDef,
  LOOP_OUTCOMES,
  type LoopDef,
  type NodeDef,
  NODE_KINDS,
  type NodeKind,
  type OpSpec,
  opSpec,
  type Services,
  VERDICT_SCHEMA_OF,
} from "./contracts.ts";
import { CLASSIFIER_ANSWERS, CLASSIFIER_YES } from "./constants.ts";

/** Every problem `validateGraph` found, one per line. */
export class GraphError extends Error {
  readonly problems: readonly string[];
  constructor(graphId: string, problems: readonly string[]) {
    super(`graph ${graphId} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "GraphError";
    this.problems = problems;
  }
}

export type GateSpec<D extends string, N extends string> =
  | { classifier: N; answer: string }
  | { loop: string; answer: string }
  | { on: D; answer: string }
  | { anyOf: GateSpec<D, N>[] }
  | { allOf: GateSpec<D, N>[] };

export interface GraphSpec<D extends string, N extends string> {
  id: string;
  data: { id: D; schema: DataSchema; boundary?: "input" | "terminal"; format?: string }[];
  nodes: {
    id: N;
    doc?: string;
    kind: NodeKind;
    role: string;
    inputs: NoInfer<D>[];
    optionalInputs?: NoInfer<D>[];
    outputs: NoInfer<D>[];
    gate?: GateSpec<NoInfer<D>, NoInfer<N>>;
    writes?: boolean;
    answers?: NoInfer<D>;
    modelFrom?: NoInfer<D>;
    readsRecord?: boolean;
    failOpen?: true;
    timeCapMs: number;
  }[];
  loops?: {
    id: string;
    nodes: NoInfer<N>[];
    until: { node: NoInfer<N>; answer: string };
    cap: number;
    carry?: NoInfer<D>[];
    outcome?: NoInfer<D>;
  }[];
  fanOuts?: { id: string; over: NoInfer<D>; nodes: NoInfer<N>[]; status?: NoInfer<D> }[];
  services?: { [K in keyof Services]?: NoInfer<N> };
  amended?: { output: NoInfer<D>; replaces: NoInfer<D>; reparse?: NoInfer<N> };
  ops?: Record<string, OpSpec>;
}

function copyGate(g: Gate): Gate {
  if ("anyOf" in g) return { anyOf: g.anyOf.map(copyGate) };
  if ("allOf" in g) return { allOf: g.allOf.map(copyGate) };
  return { ...g };
}

/** A validated graph. Data and node ids are checked at compile time: an input, output, gate, or loop
 *  member naming an id the spec does not declare is a type error. Throws `GraphError`. */
export function defineGraph<const D extends string, const N extends string>(spec: GraphSpec<D, N>): GraphDef {
  const graph: GraphDef = {
    id: spec.id,
    data: spec.data.map((d) => ({ ...d })),
    nodes: spec.nodes.map((n) => ({
      ...n,
      inputs: [...n.inputs],
      ...(n.optionalInputs === undefined ? {} : { optionalInputs: [...n.optionalInputs] }),
      outputs: [...n.outputs],
      ...(n.gate === undefined ? {} : { gate: copyGate(n.gate as Gate) }),
    })),
    loops: (spec.loops ?? []).map((l) => ({
      ...l,
      nodes: [...l.nodes],
      until: { ...l.until },
      ...(l.carry === undefined ? {} : { carry: [...l.carry] }),
    })),
    ...(spec.fanOuts === undefined ? {} : { fanOuts: spec.fanOuts.map((f) => ({ ...f, nodes: [...f.nodes] })) }),
    ...(spec.services === undefined ? {} : { services: { ...spec.services } }),
    ...(spec.amended === undefined ? {} : { amended: { ...spec.amended } }),
    ...(spec.ops === undefined ? {} : { ops: Object.fromEntries(Object.entries(spec.ops).map(([k, v]) => [k, { ...v }])) }),
  };
  assertValidGraph(graph);
  return graph;
}

export function assertValidGraph(graph: GraphDef): void {
  const problems = validateGraph(graph);
  if (problems.length > 0) throw new GraphError(graph.id, problems);
}

// ---- structural lookups ----

export const allInputs = (node: NodeDef): string[] => [...node.inputs, ...(node.optionalInputs ?? [])];

/** The node that writes each data id (the first, when validation would refuse two). A loop's outcome
 *  item has no producer node: `sourceOf` names its loop. */
export function producers(graph: GraphDef): Map<string, NodeDef> {
  const out = new Map<string, NodeDef>();
  for (const node of graph.nodes) for (const id of node.outputs) if (!out.has(id)) out.set(id, node);
  return out;
}

export function nodeById(graph: GraphDef, id: string): NodeDef | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function loopOf(graph: GraphDef, nodeId: string): LoopDef | undefined {
  return graph.loops.find((l) => l.nodes.includes(nodeId));
}

export function fanOutOf(graph: GraphDef, nodeId: string): FanOutDef | undefined {
  return (graph.fanOuts ?? []).find((f) => f.nodes.includes(nodeId));
}

/** A body a node runs in: a loop's or a fan-out's. Top-level nodes have none. A fan-out may sit inside
 *  a loop (every one of its nodes is in that loop); a loop sits only at the top. */
export type ScopeRef = { kind: "loop" | "fan"; id: string };

/** The innermost body a node runs in: its fan-out, else its loop. */
export function scopeOf(graph: GraphDef, nodeId: string): ScopeRef | undefined {
  const fan = fanOutOf(graph, nodeId);
  if (fan !== undefined) return { kind: "fan", id: fan.id };
  const loop = loopOf(graph, nodeId);
  return loop === undefined ? undefined : { kind: "loop", id: loop.id };
}

export const scopeKey = (s: ScopeRef | null): string => (s === null ? "top" : `${s.kind}:${s.id}`);

/** The body a body sits in: a fan-out's loop, when its nodes are in one; null for the top level. */
export function parentScope(graph: GraphDef, scope: ScopeRef): ScopeRef | null {
  if (scope.kind === "loop") return null;
  const first = (graph.fanOuts ?? []).find((f) => f.id === scope.id)?.nodes[0];
  const loop = first === undefined ? undefined : loopOf(graph, first);
  return loop === undefined ? null : { kind: "loop", id: loop.id };
}

/** The bodies around a source, outermost first: a node's loop and fan-out, a fan-out's loop. */
function scopesAround(graph: GraphDef, src: Source): ScopeRef[] {
  const inner = src.kind === "node" ? scopeOf(graph, src.id) : src.kind === "fan" ? parentScope(graph, { kind: "fan", id: src.id }) : null;
  if (inner === undefined || inner === null) return [];
  const outer = parentScope(graph, inner);
  return outer === null ? [inner] : [outer, inner];
}

/** What `scope` (null: the top level) runs that holds `src`: the node, loop or fan-out itself, or the
 *  loop or fan-out nested in `scope` around it; undefined when `src` is outside `scope`. */
export function unitIn(graph: GraphDef, src: Source, scope: ScopeRef | null): Source | undefined {
  const around = scopesAround(graph, src);
  const at = scope === null ? -1 : around.findIndex((s) => scopeKey(s) === scopeKey(scope));
  if (scope !== null && at < 0) return undefined;
  const next = around[at + 1];
  return next === undefined ? src : { kind: next.kind, id: next.id };
}

export const unitKey = (u: Source): string => `${u.kind}:${u.id}`;

/** What one scope schedules (null: the top level): each node whose innermost body it is, every
 *  service aside, and each loop or fan-out nested directly in it. */
export function scopeUnits(graph: GraphDef, scope: ScopeRef | null): Source[] {
  const services = serviceIds(graph);
  const here = scopeKey(scope);
  return [
    ...graph.nodes.filter((n) => !services.has(n.id) && scopeKey(scopeOf(graph, n.id) ?? null) === here).map((n): Source => ({ kind: "node", id: n.id })),
    ...(scope === null ? graph.loops.map((l): Source => ({ kind: "loop", id: l.id })) : []),
    ...(graph.fanOuts ?? []).filter((f) => scopeKey(parentScope(graph, { kind: "fan", id: f.id })) === here).map((f): Source => ({ kind: "fan", id: f.id })),
  ];
}

/** The ids of the runner's service nodes (`graph.services`): run on an event, never scheduled. */
export function serviceIds(graph: GraphDef): Set<string> {
  return new Set(Object.values(graph.services ?? {}).filter((v): v is string => typeof v === "string"));
}

/** Whether a node's failure leaves the run going (`NodeDef.failOpen`): every classifier, and an agent
 *  marked so. */
export const opensOnFailure = (node: NodeDef): boolean => node.kind === "classifier" || node.failOpen === true;

/** The verdict output of a classifier or check node: the data id its gate or loop reads. */
export function verdictOutput(node: NodeDef): string | undefined {
  return VERDICT_SCHEMA_OF[node.kind] === undefined ? undefined : node.outputs[0];
}

/** What a node run records of its verdict output: a check's or classifier's answer, and a
 *  classifier's p, the cut-off it was decided at, and whether it was explored or failed open. */
export function runAnswer(said: DataValue | undefined): Pick<NodeRun, "answer" | "p" | "cutoff" | "explored" | "error"> {
  if (said?.schema === "check") return { answer: said.answer };
  if (said?.schema !== "verdict") return {};
  const d = said.decision;
  return {
    answer: said.answer,
    p: said.p,
    ...(d?.cutoff === undefined ? {} : { cutoff: d.cutoff }),
    ...(d?.explored === true ? { explored: true as const } : {}),
    ...(d?.error === undefined ? {} : { error: d.error }),
  };
}

/** What writes data `id`: a node, the loop whose outcome it is, or the fan-out whose status it is. */
export type Source = { kind: "node" | "loop" | "fan"; id: string };

export function sourceOf(graph: GraphDef, id: string): Source | undefined {
  const node = producers(graph).get(id);
  if (node !== undefined) return { kind: "node", id: node.id };
  const loop = graph.loops.find((l) => l.outcome === id);
  if (loop !== undefined) return { kind: "loop", id: loop.id };
  const fan = (graph.fanOuts ?? []).find((f) => f.status === id);
  return fan === undefined ? undefined : { kind: "fan", id: fan.id };
}

/** Each simple condition of a gate (any nesting flattened): what it reads and the answer it wants. */
export type GateLeaf = { classifier: string; answer: string } | { loop: string; answer: string } | { on: string; answer: string };

export function gateLeaves(gate: Gate): GateLeaf[] {
  if ("anyOf" in gate) return gate.anyOf.flatMap(gateLeaves);
  if ("allOf" in gate) return gate.allOf.flatMap(gateLeaves);
  return [gate];
}

/** The node or loop a gate condition waits on. */
export function leafSource(graph: GraphDef, leaf: GateLeaf): Source | undefined {
  if ("classifier" in leaf) return { kind: "node", id: leaf.classifier };
  if ("loop" in leaf) return { kind: "loop", id: leaf.loop };
  return sourceOf(graph, leaf.on);
}

/** The data item a gate condition reads: the classifier's verdict, the loop's outcome, or the item. */
export function leafData(graph: GraphDef, leaf: GateLeaf): string | undefined {
  if ("classifier" in leaf) {
    const c = nodeById(graph, leaf.classifier);
    return c === undefined ? undefined : verdictOutput(c);
  }
  if ("loop" in leaf) return graph.loops.find((l) => l.id === leaf.loop)?.outcome;
  return leaf.on;
}

const leafName = (leaf: GateLeaf): string => ("classifier" in leaf ? leaf.classifier : "loop" in leaf ? `loop ${leaf.loop}` : leaf.on);

/** Null when `gate` holds over `data`, else why not. */
export function gateFails(graph: GraphDef, gate: Gate, data: DataValues): string | null {
  if ("anyOf" in gate) {
    const why = gate.anyOf.map((g) => gateFails(graph, g, data));
    return why.some((w) => w === null) ? null : `none of: ${why.join("; ")}`;
  }
  if ("allOf" in gate) {
    for (const g of gate.allOf) {
      const why = gateFails(graph, g, data);
      if (why !== null) return why;
    }
    return null;
  }
  const out = leafData(graph, gate);
  const v = out === undefined ? undefined : data[out];
  const name = leafName(gate);
  if (v === undefined || (v.schema !== "verdict" && v.schema !== "outcome" && v.schema !== "check")) return `gate ${name} did not answer`;
  // An explored `no` runs the reader its `yes` would have: the verdict stays as it was decided.
  const opens = v.schema === "verdict" && v.decision?.explored === true && gate.answer === CLASSIFIER_YES;
  if (v.answer !== gate.answer && !opens) return `gate ${name} answered ${v.answer}, not ${gate.answer}`;
  return null;
}

// ---- carried reads ----

/**
 * Which inputs of each loop node are last iteration's values: a carried id read on a back edge (its
 * reader is its producer, or comes before it in the body). A carried id read after its producer in the
 * same iteration is this iteration's value. Edges are classified in a fixed order: a carried edge is
 * forward when its reader does not already reach its producer; every other is a back edge.
 */
export function carriedReads(graph: GraphDef, loop: LoopDef): Map<string, Set<string>> {
  const carry = new Set(loop.carry ?? []);
  const body = new Set(loop.nodes);
  const edges = new Map<string, Set<string>>();
  const pending: { from: string; to: string; id: string }[] = [];
  for (const id of loop.nodes) {
    const node = nodeById(graph, id);
    if (node === undefined) continue;
    const reads = allInputs(node).map((d) => ({ d, src: sourceOf(graph, d) }));
    if (node.gate !== undefined) for (const leaf of gateLeaves(node.gate)) reads.push({ d: "", src: leafSource(graph, leaf) });
    for (const { d, src } of reads) {
      if (src?.kind !== "node" || !body.has(src.id)) continue;
      if (carry.has(d)) pending.push({ from: src.id, to: id, id: d });
      else addEdge(edges, src.id, id);
    }
  }
  const reaches = (a: string, b: string): boolean => {
    const seen = new Set<string>();
    const stack = [a];
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (x === b) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of edges.get(x) ?? []) stack.push(y);
    }
    return false;
  };
  const out = new Map<string, Set<string>>();
  for (const e of pending) {
    if (e.from !== e.to && !reaches(e.to, e.from)) addEdge(edges, e.from, e.to);
    else out.set(e.to, (out.get(e.to) ?? new Set<string>()).add(e.id));
  }
  return out;
}

// ---- validation ----

const ID = /^[A-Za-z0-9][\w.-]*$/;
const aKind = (kind: NodeKind): string => (kind === "agent" ? "an agent" : `a ${kind}`);

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/** The cycle through `edges` among `units`, as a list of unit ids, or null. */
function findCycle(units: readonly string[], edges: ReadonlyMap<string, ReadonlySet<string>>): string[] | null {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (u: string): string[] | null => {
    state.set(u, "open");
    stack.push(u);
    for (const v of edges.get(u) ?? []) {
      if (state.get(v) === "open") return [...stack.slice(stack.indexOf(v)), v];
      if (state.get(v) === undefined) {
        const found = visit(v);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(u, "done");
    return null;
  };
  for (const u of units) {
    if (state.get(u) !== undefined) continue;
    const found = visit(u);
    if (found) return found;
  }
  return null;
}

function addEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
  edges.set(from, (edges.get(from) ?? new Set<string>()).add(to));
}

/** Every problem with `graph`, in a stable order; empty when it is valid. */
export function validateGraph(graph: GraphDef): string[] {
  const problems: string[] = [];
  const say = (p: string) => problems.push(p);
  const fanOuts = graph.fanOuts ?? [];
  const services = serviceIds(graph);

  for (const id of [
    graph.id,
    ...graph.data.map((d) => d.id),
    ...graph.nodes.map((n) => n.id),
    ...graph.loops.map((l) => l.id),
    ...fanOuts.map((f) => f.id),
  ]) {
    if (!ID.test(id)) say(`id ${JSON.stringify(id)} must match ${ID}`);
  }
  for (const id of duplicates(graph.data.map((d) => d.id))) say(`duplicate data id ${id}`);
  for (const id of duplicates([...graph.nodes.map((n) => n.id), ...graph.loops.map((l) => l.id), ...fanOuts.map((f) => f.id)])) {
    say(`duplicate node, loop or fan-out id ${id}`);
  }

  for (const item of graph.data) {
    if (!(DATA_SCHEMAS as readonly string[]).includes(item.schema)) say(`data ${item.id} has schema ${item.schema}, not one of ${DATA_SCHEMAS.join(", ")}`);
    if (item.boundary !== undefined && item.boundary !== "input" && item.boundary !== "terminal") {
      say(`data ${item.id} has boundary ${item.boundary}, not input or terminal`);
    }
    if (item.format !== undefined && item.schema !== "files") say(`data ${item.id} has a format but schema ${item.schema}; only files have one`);
  }

  const items = new Map<string, DataItem>(graph.data.map((d) => [d.id, d]));
  const nodes = new Map<string, NodeDef>(graph.nodes.map((n) => [n.id, n]));
  const loops = new Map<string, LoopDef>(graph.loops.map((l) => [l.id, l]));
  const producedBy = new Map<string, string[]>();
  const consumed = new Set<string>();
  const memberOf = new Map<string, string>();
  for (const loop of graph.loops) for (const id of loop.nodes) if (!memberOf.has(id)) memberOf.set(id, loop.id);
  const fanOf = new Map<string, string>();
  for (const fan of fanOuts) for (const id of fan.nodes) if (!fanOf.has(id)) fanOf.set(id, fan.id);
  /** Data a writer's merge must reach: each writer's ref output, by data id. */
  const writerRefs = new Map<string, string>();
  const mergedRefs = new Set<string>();

  for (const node of graph.nodes) {
    const where = `node ${node.id}`;
    if (!(NODE_KINDS as readonly string[]).includes(node.kind)) {
      say(`${where} has kind ${node.kind}, not one of ${NODE_KINDS.join(", ")}`);
      continue;
    }
    for (const id of [...allInputs(node), ...node.outputs]) {
      if (!items.has(id)) say(`${where} names data ${id}, which is not declared`);
    }
    for (const id of duplicates(allInputs(node))) say(`${where} reads ${id} twice`);
    for (const id of node.outputs) producedBy.set(id, [...(producedBy.get(id) ?? []), `node ${node.id}`]);
    for (const id of allInputs(node)) consumed.add(id);
    if (!Number.isInteger(node.timeCapMs) || node.timeCapMs <= 0) say(`${where} needs a time cap of a positive whole number of ms`);
    if (node.writes !== undefined && node.kind !== "agent") say(`${where} is ${aKind(node.kind)}: only an agent writes to a worktree`);
    if (node.answers !== undefined && node.kind !== "agent") say(`${where} is ${aKind(node.kind)}: only an agent's outputs raise answered questions`);
    if (node.failOpen !== undefined) {
      if (node.kind !== "agent" || node.writes === true) say(`${where} fails open: only an agent that does not write does (a classifier fails open on its own)`);
      for (const reader of graph.nodes) {
        const need = reader.inputs.filter((id) => node.outputs.includes(id));
        if (need.length > 0) say(`node ${reader.id} reads ${need.join(", ")} as required, which ${node.id} leaves out when it fails open: an optional input`);
      }
    }
    if (node.answers !== undefined && (!node.outputs.includes(node.answers) || items.get(node.answers)?.schema !== "files")) {
      say(`${where} takes its answers in ${node.answers}, which must be one of its files outputs`);
    }
    if (node.modelFrom !== undefined && node.kind !== "agent") say(`${where} is ${aKind(node.kind)}: only an agent runs on a model`);
    if (node.modelFrom !== undefined && (!allInputs(node).includes(node.modelFrom) || items.get(node.modelFrom)?.schema !== "text")) {
      say(`${where} takes its model from ${node.modelFrom}, which must be one of its text inputs`);
    }

    const verdict = VERDICT_SCHEMA_OF[node.kind];
    const extraOk = (id: string): boolean => {
      const schema = items.get(id)?.schema;
      return schema === undefined || schema === "files" || schema === "check" || schema === "items" || schema === "text";
    };
    if (verdict !== undefined) {
      if (node.kind === "classifier" && (node.outputs.length !== 1 || items.get(node.outputs[0]!)?.schema !== verdict)) {
        say(`${where} is a classifier: it writes exactly one verdict output`);
      }
      if (node.kind === "check") {
        if (node.outputs.length === 0 || items.get(node.outputs[0]!)?.schema !== "check") say(`${where} is a check: its first output is its check answer`);
        // A check's answer is the run record's even when no node reads it.
        else consumed.add(node.outputs[0]!);
        for (const id of node.outputs.slice(1)) if (!extraOk(id)) say(`${where} is a check: output ${id} is ${items.get(id)?.schema}, not files, check, items or text`);
      }
    } else if (node.kind === "data") {
      const op = opSpec(graph, node.role);
      if (op === undefined) {
        say(`${where} is a data node: its role is one of ${[...Object.keys(DATA_OPS), ...Object.keys(graph.ops ?? {})].join(", ")}, got ${node.role}`);
      } else {
        if (node.outputs.length === 0 || items.get(node.outputs[0]!)?.schema !== op.output) say(`${where} (${node.role}) writes one ${op.output} output first`);
        for (const id of node.outputs.slice(1)) if (!extraOk(id)) say(`${where} (${node.role}): output ${id} is ${items.get(id)?.schema}, not files, check, items or text`);
        if (op.needs !== null && !node.inputs.some((id) => items.get(id)?.schema === op.needs)) {
          say(`${where} (${node.role}) needs a required ${op.needs} input`);
        }
        if (op.merges === true) for (const id of node.inputs) if (items.get(id)?.schema === "ref") mergedRefs.add(id);
        if (op.gated === true && !node.inputs.some((id) => items.get(id)?.schema === "check")) {
          say(`${where} (${node.role}) needs a required check input: the gate`);
        }
      }
    } else {
      const refs = node.outputs.filter((id) => items.get(id)?.schema === "ref");
      for (const id of node.outputs) {
        const schema = items.get(id)?.schema;
        if (schema !== undefined && schema !== "files" && schema !== "ref") say(`${where} is an agent: output ${id} is ${schema}, not files`);
      }
      if (node.writes === true) {
        if (refs.length !== 1) say(`${where} writes: it declares exactly one ref output, its head commit`);
        else writerRefs.set(refs[0]!, node.id);
      } else if (refs.length > 0) say(`${where} is an agent that does not write: output ${refs[0]} is a ref`);
      if (node.outputs.length === 0) say(`${where} is an agent with no output`);
    }

    if (node.gate !== undefined) {
      for (const leaf of gateLeaves(node.gate)) {
        if ("classifier" in leaf) {
          const c = nodes.get(leaf.classifier);
          if (c === undefined) say(`${where} is gated on ${leaf.classifier}, which is not a node`);
          else if (c.kind !== "classifier") say(`${where} is gated on ${c.id}, ${aKind(c.kind)}, not a classifier`);
          else if (c.outputs[0] !== undefined) consumed.add(c.outputs[0]);
          if (!CLASSIFIER_ANSWERS.includes(leaf.answer)) say(`${where} is gated on classifier ${leaf.classifier} = ${leaf.answer}; a classifier answers ${CLASSIFIER_ANSWERS.join(" or ")}`);
          if (leaf.classifier === node.id) say(`${where} gates itself`);
        } else if ("loop" in leaf) {
          const l = loops.get(leaf.loop);
          if (l === undefined) say(`${where} is gated on loop ${leaf.loop}, which is not a loop`);
          else if (l.outcome === undefined) say(`${where} is gated on loop ${l.id}, which declares no outcome`);
          else consumed.add(l.outcome);
          if (memberOf.get(node.id) === leaf.loop) say(`${where} is gated on its own loop ${leaf.loop}`);
          if (!(LOOP_OUTCOMES as readonly string[]).includes(leaf.answer)) {
            say(`${where} is gated on loop ${leaf.loop} = ${leaf.answer}; a loop ends ${LOOP_OUTCOMES.join(", ")}`);
          }
        } else {
          const item = items.get(leaf.on);
          if (item === undefined) say(`${where} is gated on data ${leaf.on}, which is not declared`);
          else if (item.schema !== "check" && item.schema !== "verdict" && item.schema !== "outcome") {
            say(`${where} is gated on data ${leaf.on}, which is ${item.schema}, not a check, verdict or outcome`);
          } else {
            consumed.add(leaf.on);
            if (item.schema === "check" && !(CHECK_ANSWERS as readonly string[]).includes(leaf.answer)) {
              say(`${where} is gated on check ${leaf.on} = ${leaf.answer}; a check answers ${CHECK_ANSWERS.join(" or ")}`);
            }
          }
          if (node.outputs.includes(leaf.on)) say(`${where} gates itself`);
        }
      }
    }
  }

  for (const [ref, writer] of writerRefs) {
    if (!mergedRefs.has(ref) && !services.has(writer)) say(`node ${writer} writes, but no data node merges its ref ${ref} into the run tree`);
  }

  // Services: kinds, and never scheduled (no gate, outside loops and fan-outs).
  const want: Record<string, NodeKind> = { schema: "check", route: "check", resolver: "agent", operator: "data", amend: "agent" };
  for (const [role, id] of Object.entries(graph.services ?? {})) {
    if (id === undefined) continue;
    const n = nodes.get(id);
    if (n === undefined) {
      say(`service ${role} names node ${id}, which is not declared`);
      continue;
    }
    if (n.kind !== want[role]) say(`service ${role} is node ${id}, ${aKind(n.kind)}; it must be ${aKind(want[role]!)}`);
    if (n.gate !== undefined || memberOf.has(id) || fanOf.has(id)) say(`service node ${id} runs on an event: no gate, loop or fan-out`);
    if (role === "amend" && n.writes !== true) say(`service amend is node ${id}, which does not write`);
    // A service node's outputs flow by the service protocol, not to a reader.
    for (const out of n.outputs) consumed.add(out);
  }
  if (graph.services?.resolver !== undefined && graph.services.route === undefined) say("service resolver needs a route service");
  if (graph.amended !== undefined) {
    const { output, replaces, reparse } = graph.amended;
    const amend = graph.services?.amend === undefined ? undefined : nodes.get(graph.services.amend);
    if (amend === undefined) say("amended needs an amend service");
    else if (!amend.outputs.includes(output)) say(`amended: ${output} is not an output of the amend service ${amend.id}`);
    const [from, to] = [items.get(output), items.get(replaces)];
    if (to === undefined) say(`amended replaces ${replaces}, which is not declared`);
    else if (from !== undefined && from.schema !== to.schema) say(`amended: ${output} is ${from.schema} and ${replaces} is ${to.schema}`);
    if (reparse !== undefined) {
      const n = nodes.get(reparse);
      if (n === undefined) say(`amended reparses with ${reparse}, which is not declared`);
      else if (n.kind !== "check" || services.has(reparse) || memberOf.has(reparse) || fanOf.has(reparse) || !allInputs(n).includes(replaces)) {
        say(`amended reparses with ${reparse}: a top-level check node that reads ${replaces}`);
      }
    }
  }

  // Fan-outs: membership and the list they run over.
  const seenFan = new Set<string>();
  for (const fan of fanOuts) {
    const where = `fan-out ${fan.id}`;
    if (fan.nodes.length === 0) say(`${where} has no nodes`);
    const over = items.get(fan.over);
    if (over === undefined) say(`${where} runs over ${fan.over}, which is not declared`);
    else if (over.schema !== "items") say(`${where} runs over ${fan.over}, which is ${over.schema}, not items`);
    consumed.add(fan.over);
    const inLoops = [...new Set(fan.nodes.map((id) => memberOf.get(id) ?? "(none)"))];
    if (inLoops.length > 1) say(`${where} has nodes in ${inLoops.map((l) => (l === "(none)" ? "no loop" : `loop ${l}`)).join(" and ")}: a fan-out sits wholly inside one loop or outside every loop`);
    for (const id of fan.nodes) {
      if (!nodes.has(id)) say(`${where} names node ${id}, which is not declared`);
      else if (seenFan.has(id)) say(`node ${id} is in two fan-outs; fan-outs do not nest or share`);
      else if (graph.loops.some((l) => l.until.node === id)) say(`node ${id} is in fan-out ${fan.id} and stops loop ${memberOf.get(id)}: the stop node runs once an iteration`);
      seenFan.add(id);
      if (nodes.get(id)?.outputs.includes(fan.over)) say(`node ${id} writes the list its own fan-out ${fan.id} runs over`);
      for (const out of nodes.get(id)?.outputs ?? []) if (items.get(out)?.schema === "items" || items.get(out)?.schema === "verdict") {
        say(`node ${id} in fan-out ${fan.id} writes ${out}, a ${items.get(out)?.schema}: one value per instance cannot leave the group`);
      }
    }
    if (fan.status !== undefined) {
      const item = items.get(fan.status);
      if (item === undefined) say(`${where} writes its status to ${fan.status}, which is not declared`);
      else if (item.schema !== "check") say(`${where} writes its status to ${fan.status}, which is ${item.schema}, not check`);
      producedBy.set(fan.status, [...(producedBy.get(fan.status) ?? []), where]);
      for (const id of fan.nodes) {
        const n = nodes.get(id);
        if (n !== undefined && (allInputs(n).includes(fan.status) || (n.gate !== undefined && gateLeaves(n.gate).some((l) => "on" in l && l.on === fan.status)))) {
          say(`node ${id} reads the status of its own fan-out ${fan.id}`);
        }
      }
    }
  }

  // Loops: membership, stop condition, carry, outcome.
  const seenMember = new Set<string>();
  for (const loop of graph.loops) {
    const where = `loop ${loop.id}`;
    if (loop.nodes.length === 0) say(`${where} has no nodes`);
    for (const id of loop.nodes) {
      if (!nodes.has(id)) say(`${where} names node ${id}, which is not declared`);
      else if (seenMember.has(id)) say(`node ${id} is in loops ${memberOf.get(id)} and ${loop.id}; loops do not nest or share`);
      seenMember.add(id);
    }
    if (!Number.isInteger(loop.cap) || loop.cap < 1) say(`${where} needs a cap of a whole number ≥ 1`);
    const until = nodes.get(loop.until.node);
    if (until === undefined || !loop.nodes.includes(until.id)) say(`${where} stops on ${loop.until.node}, which is not in the loop`);
    else if (until.kind !== "check" && until.kind !== "classifier") say(`${where} stops on ${until.id}, ${aKind(until.kind)}: a check or classifier decides`);
    else {
      if (until.gate !== undefined) say(`${where} stops on ${until.id}, which is gated: the stop node runs every iteration`);
      if (until.kind === "check" && !(CHECK_ANSWERS as readonly string[]).includes(loop.until.answer)) {
        say(`${where} stops when check ${until.id} answers ${loop.until.answer}; a check answers ${CHECK_ANSWERS.join(" or ")}`);
      }
      if (until.kind === "classifier" && !CLASSIFIER_ANSWERS.includes(loop.until.answer)) {
        say(`${where} stops when classifier ${until.id} answers ${loop.until.answer}; a classifier answers ${CLASSIFIER_ANSWERS.join(" or ")}`);
      }
      if (until.outputs[0] !== undefined) consumed.add(until.outputs[0]);
    }
    const back = carriedReads(graph, loop);
    for (const id of loop.carry ?? []) {
      const by = producers(graph).get(id);
      if (by === undefined || !loop.nodes.includes(by.id)) say(`${where} carries ${id}, which no node in the loop produces`);
      for (const n of loop.nodes) {
        const reader = nodes.get(n);
        if (reader?.inputs.includes(id) && back.get(n)?.has(id) === true) say(`node ${n} reads carried ${id} as required; iteration 1 has none, so it is optional`);
      }
    }
    if (loop.outcome !== undefined) {
      const item = items.get(loop.outcome);
      if (item === undefined) say(`${where} writes its outcome to ${loop.outcome}, which is not declared`);
      else if (item.schema !== "outcome") say(`${where} writes its outcome to ${loop.outcome}, which is ${item.schema}, not outcome`);
      producedBy.set(loop.outcome, [...(producedBy.get(loop.outcome) ?? []), where]);
      for (const n of loop.nodes) {
        if (nodes.get(n) !== undefined && allInputs(nodes.get(n)!).includes(loop.outcome)) say(`node ${n} reads the outcome of its own loop ${loop.id}`);
      }
    }
  }

  for (const [id, by] of producedBy) if (by.length > 1) say(`data ${id} has more than one producer: ${by.join(", ")}`);
  for (const item of graph.data) {
    const produced = producedBy.has(item.id);
    if (item.boundary === "input" && produced) say(`data ${item.id} is a run input but ${producedBy.get(item.id)![0]} writes it`);
    if (item.boundary !== "input" && !produced && consumed.has(item.id)) say(`data ${item.id} is read but nothing produces it`);
    if (item.boundary === "terminal" && !produced) say(`data ${item.id} is terminal but nothing produces it`);
    if (produced && !consumed.has(item.id) && item.boundary !== "terminal") {
      say(`data ${item.id} is produced but nothing reads it; mark it terminal if it leaves the run`);
    }
    if (!produced && !consumed.has(item.id) && item.boundary !== "terminal") say(`data ${item.id} is declared but unused`);
  }
  for (const id of services) {
    for (const input of nodes.get(id)?.inputs ?? []) {
      const by = producers(graph).get(input);
      if (by !== undefined && scopeOf(graph, by.id) !== undefined) say(`service node ${id} reads ${input}, which a loop or fan-out writes; a service reads top-level data`);
    }
  }

  if (problems.length > 0) return problems;

  // Cycles: in every scope (the top level, each loop, each fan-out), over the units it runs, a nested
  // loop or fan-out as one unit; a body's edges leave out its carry edges.
  const scopes: (ScopeRef | null)[] = [null, ...graph.loops.map((l): ScopeRef => ({ kind: "loop", id: l.id })), ...fanOuts.map((f): ScopeRef => ({ kind: "fan", id: f.id }))];
  const unitName = (u: Source): string => (u.kind === "node" ? u.id : `${u.kind} ${u.id}`);
  const edges = new Map<string, Map<string, Set<string>>>(scopes.map((s) => [scopeKey(s), new Map()]));
  for (const node of graph.nodes) {
    if (services.has(node.id)) continue;
    const loop = memberOf.get(node.id);
    const carried = loop === undefined ? new Set<string>() : (carriedReads(graph, loops.get(loop)!).get(node.id) ?? new Set<string>());
    const deps = allInputs(node).map((id) => ({ from: sourceOf(graph, id), carry: carried.has(id) }));
    if (node.gate !== undefined) for (const leaf of gateLeaves(node.gate)) deps.push({ from: leafSource(graph, leaf), carry: false });
    const fan = fanOf.get(node.id);
    if (fan !== undefined) deps.push({ from: sourceOf(graph, fanOuts.find((f) => f.id === fan)!.over), carry: false });
    const self: Source = { kind: "node", id: node.id };
    for (const dep of deps) {
      if (dep.from === undefined) continue;
      for (const scope of scopes) {
        const [a, b] = [unitIn(graph, dep.from, scope), unitIn(graph, self, scope)];
        if (a === undefined || b === undefined || (scope !== null && dep.carry)) continue;
        // A nested body reading its own output is that body's edge, not this scope's.
        if (unitKey(a) === unitKey(b) && a.kind !== "node") continue;
        addEdge(edges.get(scopeKey(scope))!, unitName(a), unitName(b));
      }
    }
  }
  for (const scope of scopes) {
    const cycle = findCycle(scopeUnits(graph, scope).map(unitName), edges.get(scopeKey(scope))!);
    if (cycle) say(scope === null ? `cycle outside a loop: ${cycle.join(" → ")}` : `cycle inside ${scope.kind} ${scope.id} not broken by a carry: ${cycle.join(" → ")}`);
  }
  return problems;
}
