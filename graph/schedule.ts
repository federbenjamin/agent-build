/**
 * The interpreter's decisions, as pure functions over a graph and what has finished: which units
 * start, which nodes skip and why, whether a loop goes again, and each node's activity options. The
 * workflow only applies them, so they test without a Temporal runtime.
 */

import {
  type Answer,
  bindingFor,
  ContractError,
  type CheckValue,
  type DataValue,
  type DataValues,
  type FanOutDef,
  type GraphDef,
  type HaikuBinding,
  type JevBinding,
  type LoopDef,
  type LoopOutcome,
  type LoopRun,
  type MergeConflict,
  type NodeDef,
  type NodeRun,
  NON_RETRYABLE_ERROR_TYPES,
  opSpec,
  parseDataValue,
  type Question,
  type Refusal,
  type Route,
  type RunConfig,
  type RunHistory,
  searchedText,
  type WriterConflict,
} from "./contracts.ts";
import type { FinishedOutcome } from "../runtime/lib/buildEvents.ts";
import { BLOCKED_SOURCE, CAP_ABORT_LEAD_MS, CHECK_STEPS, CLASSIFIER_ANSWERS, HEARTBEAT_TIMEOUT_MS, NODE_MAX_ATTEMPTS, OPERATOR_APPROVE, OUTPUT_SIDE_FILES, QUESTIONS_FILE, RETRY_INITIAL_INTERVAL_MS } from "./constants.ts";
import {
  allInputs,
  carriedReads,
  fanOutOf,
  gateFails,
  gateLeaves,
  leafSource,
  nodeById,
  type ScopeRef,
  scopeUnits,
  type Source,
  sourceOf,
  unitIn,
  unitKey,
} from "./define.ts";

/** One thing a scope schedules (`scopeUnits`): a node, or a whole loop or fan-out nested in it. */
export type Unit = Source;

/** Every node of a body, a nested fan-out's among a loop's. */
export function bodyNodes(graph: GraphDef, scope: ScopeRef): string[] {
  return scope.kind === "loop" ? requireLoop(graph, scope.id).nodes : requireFan(graph, scope.id).nodes;
}

function requireLoop(graph: GraphDef, loopId: string): LoopDef {
  const loop = graph.loops.find((l) => l.id === loopId);
  if (loop === undefined) throw new Error(`graph ${graph.id} has no loop ${loopId}`);
  return loop;
}

function requireFan(graph: GraphDef, fanId: string): FanOutDef {
  const fan = (graph.fanOuts ?? []).find((f) => f.id === fanId);
  if (fan === undefined) throw new Error(`graph ${graph.id} has no fan-out ${fanId}`);
  return fan;
}

function requireNode(graph: GraphDef, nodeId: string): NodeDef {
  const node = nodeById(graph, nodeId);
  if (node === undefined) throw new Error(`graph ${graph.id} has no node ${nodeId}`);
  return node;
}

/**
 * The unit keys `unit` waits for in its scope (null: the top level): the unit of that scope (`unitIn`)
 * that writes each input of its nodes, answers one of their gates, or writes the list a fan-out among
 * them runs over. A unit waits for nothing outside its scope, whose data it already sees, nor for
 * itself; in a loop, a carried input is last iteration's, so no wait.
 */
export function unitDeps(graph: GraphDef, unit: Unit, scope: ScopeRef | null): string[] {
  const members = unit.kind === "node" ? [unit.id] : bodyNodes(graph, { kind: unit.kind, id: unit.id });
  const carried = scope?.kind === "loop" ? carriedReads(graph, requireLoop(graph, scope.id)) : undefined;
  const deps = new Set<string>();
  for (const member of members) {
    const node = requireNode(graph, member);
    const sources: { from: Source | undefined; id: string }[] = allInputs(node).map((id) => ({ from: sourceOf(graph, id), id }));
    if (node.gate !== undefined) for (const leaf of gateLeaves(node.gate)) sources.push({ from: leafSource(graph, leaf), id: "" });
    const fan = fanOutOf(graph, member);
    if (fan !== undefined) sources.push({ from: sourceOf(graph, fan.over), id: fan.over });
    for (const { from, id } of sources) {
      if (from === undefined || carried?.get(member)?.has(id) === true) continue;
      const u = unitIn(graph, from, scope);
      if (u !== undefined && unitKey(u) !== unitKey(unit)) deps.add(unitKey(u));
    }
  }
  return [...deps];
}

/** Why `node` skips given the data visible to it, or null when it runs. */
export function skipReason(graph: GraphDef, node: NodeDef, data: DataValues): string | null {
  if (node.gate !== undefined) {
    const why = gateFails(graph, node.gate, data);
    if (why !== null) return why;
  }
  const missing = node.inputs.filter((id) => data[id] === undefined);
  if (missing.length > 0) return `input ${missing.join(", ")} missing`;
  return null;
}

export interface ScopeView {
  started: ReadonlySet<string>;
  finished: ReadonlySet<string>;
  /** The data visible in the scope: the run's inputs, what finished so far, and (in a loop) the carry. */
  data: DataValues;
}

export interface Decision {
  start: Unit[];
  skip: { node: string; reason: string }[];
}

/** The units not yet started whose dependencies have all finished: to start, or (a node) to skip. */
export function decide(graph: GraphDef, scope: ScopeRef | null, view: ScopeView): Decision {
  const out: Decision = { start: [], skip: [] };
  for (const unit of scopeUnits(graph, scope)) {
    if (view.started.has(unitKey(unit))) continue;
    if (!unitDeps(graph, unit, scope).every((d) => view.finished.has(d))) continue;
    const reason = unit.kind === "node" ? skipReason(graph, requireNode(graph, unit.id), view.data) : null;
    if (reason === null) out.start.push(unit);
    else out.skip.push({ node: unit.id, reason });
  }
  return out;
}

// ---- fan-outs ----

/** What is wrong with a fan-out's list: duplicate ids, an `after` naming no item, or a cycle. */
export function fanOutProblems(items: readonly { id: string; after: readonly string[] }[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) problems.push(`item ${it.id} is listed twice`);
    ids.add(it.id);
  }
  for (const it of items) for (const a of it.after) if (!ids.has(a)) problems.push(`item ${it.id} is after ${a}, which is not an item`);
  if (problems.length > 0) return problems;
  const done = new Set<string>();
  for (let round = 0; done.size < items.length; round++) {
    const ready = items.filter((it) => !done.has(it.id) && it.after.every((a) => done.has(a)));
    if (ready.length === 0) {
      problems.push(`items ${items.filter((it) => !done.has(it.id)).map((it) => it.id).join(", ")} wait on each other`);
      break;
    }
    for (const it of ready) done.add(it.id);
  }
  return problems;
}

/** The items to start now: not started, and every item they come after finished. */
export function readyItems(items: readonly { id: string; after: readonly string[] }[], started: ReadonlySet<string>, finished: ReadonlySet<string>): string[] {
  return items.filter((it) => !started.has(it.id) && it.after.every((a) => finished.has(a))).map((it) => it.id);
}

/** The item, among those `after` names, that is down (failed, or skipped for one that was); null when
 *  none is. An item after a down item skips. */
export function itemBlocker(after: readonly string[], isDown: (item: string) => boolean): string | null {
  return after.find(isDown) ?? null;
}

/** A fan-out's status (`FanOutDef.status`): pass when no item is down, else fail naming those that are. */
export function fanStatus(items: readonly string[], isDown: (item: string) => boolean): CheckValue {
  const down = items.filter(isDown);
  if (down.length > 0) return { schema: "check", answer: "fail", detail: `items ${down.join(", ")} failed or skipped for one that did` };
  return { schema: "check", answer: "pass", detail: items.length === 0 ? "the list is empty" : `all ${items.length} items finished` };
}

/** What a fan-out hands the rest of the graph: each output its instances wrote, together, in item
 *  order: files joined, the last item's ref or text, a check `fail` when any instance failed. */
export function fanOutExports(order: readonly string[], byItem: ReadonlyMap<string, DataValues>): DataValues {
  const out: DataValues = {};
  for (const item of order) {
    const values = byItem.get(item);
    if (values === undefined) continue;
    for (const [id, v] of Object.entries(values)) {
      const prior = out[id];
      if (prior === undefined) out[id] = v.schema === "files" ? { schema: "files", files: [...v.files] } : v;
      else if (prior.schema === "files" && v.schema === "files") prior.files.push(...v.files);
      else if (prior.schema === "check" && v.schema === "check") {
        out[id] = { schema: "check", answer: prior.answer === "fail" || v.answer === "fail" ? "fail" : "pass", detail: `${prior.detail}\n${v.detail}` };
      } else out[id] = v;
    }
  }
  return out;
}

// ---- questions ----

/**
 * K-route-question: where a question goes, in code, on its type. `blocked`: one fresh rerun of the asker, then
 * the operator. `product`: the operator. Anything else: the resolver, when the graph has one, else the
 * operator.
 */
export function routeQuestion(q: Question, opts: { hasResolver: boolean; retried: boolean }): Route {
  if (q.type === "blocked") return opts.retried ? "operator" : "retry";
  if (q.type === "product") return "operator";
  return opts.hasResolver ? "resolver" : "operator";
}

/** The text an answered question hands back to a node that re-runs on it, with the brief change the
 *  answer proposes when it has one. */
export const answerText = (q: Question, a: { answer: string; source: string; brief_change?: string }): string =>
  `${q.id}: ${a.answer}${a.brief_change === undefined ? "" : ` Brief change: ${a.brief_change}`} (source: ${a.source})`;

/** What a blocked asker's fresh rerun is handed: its own blocked question and what it searched, as
 *  evidence to start from. It is no answer: blocked again, the question goes to the operator. */
export const blockedText = (q: Question): string =>
  answerText(q, { answer: `blocked on the last run: ${q.text}${q.searched.length === 0 ? "" : ` Searched: ${searchedText(q.searched)}.`}`, source: BLOCKED_SOURCE });

/**
 * After the resolver had a question (`got`: its answer, its refusal, or undefined when it did not run
 * or did not finish): the answer that stands with no ask, or what the operator is asked. A resolver's
 * answer stands, unless it changes the brief and the graph will amend it (`amends`): then the
 * operator approves the change or answers instead. A brief change nothing will apply (no amend
 * service, or the asker writes the brief itself) stands with the answer, for the asker to read.
 */
export function operatorAsk(got: Answer | Refusal | undefined, amends: boolean): { answer: Answer } | { ask: string } {
  if (got === undefined || "needsOperator" in got) {
    const searched = got?.searched ?? [];
    return { ask: searched.length === 0 ? "" : `The resolver found no answer in: ${searchedText(searched)}.` };
  }
  if (got.brief_change === undefined || !amends) return { answer: got };
  return { ask: `The resolver answers (source: ${got.source}): ${got.answer} This changes the brief: ${got.brief_change} Reply ${OPERATOR_APPROVE} to apply it, or write the answer instead.` };
}

/** The answer the operator's reply to `operatorAsk`'s ask yields: the resolver's, when it proposed a
 *  brief change and the reply approves it (trimmed, any case); else the reply, as the operator's own. */
export function replyAnswer(q: Question, got: Answer | Refusal | undefined, reply: string): Answer {
  if (got !== undefined && !("needsOperator" in got) && got.brief_change !== undefined && reply.trim().toLowerCase() === OPERATOR_APPROVE) return got;
  return { question_id: q.id, answer: reply, source: "operator", by: "operator" };
}

/** The outputs of an agent run that hold its questions file and no file of the output's own, only side
 *  files (`OUTPUT_SIDE_FILES`): the agent stopped on its questions there instead of writing the output.
 *  The engine's own answers output is not the agent's. */
export function questionsOnly(node: NodeDef, outputs: DataValues): string[] {
  const name = (f: string): string => f.split("/").pop() ?? f;
  return node.outputs.filter((id) => {
    const v = outputs[id];
    return id !== node.answers && v?.schema === "files" && v.files.some((f) => name(f) === QUESTIONS_FILE) && v.files.every((f) => OUTPUT_SIDE_FILES.includes(name(f)));
  });
}

/** What a loop does after iteration `iteration`, given the value its stop node wrote this iteration
 *  (undefined when the stop node skipped or failed). */
export function loopStep(loop: LoopDef, iteration: number, until: DataValue | undefined): "again" | LoopOutcome {
  if (until === undefined || (until.schema !== "verdict" && until.schema !== "check")) return "aborted";
  if (until.answer === loop.until.answer) return "clean";
  return iteration >= loop.cap ? "capped" : "again";
}

/** After `writer`'s commit conflicted at its merge, with `restarts` fresh runs given for it so far: the
 *  conflict to hand its next fresh run, or, at `cap`, why the merge node fails. */
export function conflictStep(
  conflict: MergeConflict,
  restarts: number,
  writer: string,
  cap: number
): { restart: WriterConflict } | { fail: string } {
  if (restarts < cap) return { restart: { commit: conflict.commit, paths: [...conflict.paths], restart: restarts + 1 } };
  return { fail: `${conflictText(conflict)}; ${writer} had its ${cap} fresh runs for it (WRITER_RESTART_CAP) and the last still conflicts` };
}

/** How every record of one merge conflict begins: `merging <sha9> into the run tree conflicted on <paths>`. */
export function conflictText(conflict: MergeConflict): string {
  return `merging ${conflict.commit.slice(0, 9)} into the run tree conflicted on ${conflict.paths.join(", ")}`;
}

/** The merge node's reason while `writer` has the fresh run `conflictStep` gave it, out of `cap`. */
export function restartText(conflict: WriterConflict, writer: string, cap: number): string {
  return `${conflictText(conflict)}; ${writer} runs again on the run tree's head (restart ${conflict.restart} of ${cap})`;
}

/** The count a status line or a record cell shows after a restarted writer's status: ` (1 restart)`,
 *  ` (2 restarts)`; empty when the run never restarted. */
export function restartsNote(restarts: number | undefined): string {
  return restarts === undefined ? "" : ` (${restarts} restart${restarts === 1 ? "" : "s"})`;
}

/** The node to run again for merge node `node`'s conflict on `commit`: the node of `scope` that wrote
 *  the commit input `node` read (its value in `data`), or undefined when none did (a run input, or a
 *  node of another scope). */
export function conflictWriter(graph: GraphDef, scope: ScopeRef | null, node: NodeDef, data: DataValues, commit: string): string | undefined {
  const read = allInputs(node).find((id) => {
    const v = data[id];
    return v?.schema === "ref" && v.kind === "commit" && v.id === commit;
  });
  const src = read === undefined ? undefined : sourceOf(graph, read);
  if (src?.kind !== "node") return undefined;
  return scopeUnits(graph, scope).some((u) => u.kind === "node" && u.id === src.id) ? src.id : undefined;
}

/** The carried data the next iteration reads: what the loop's carry ids got in the iteration that just
 *  ended, and nothing older (a carry its producer did not write this time is absent next time). */
export function carryForward(loop: LoopDef, produced: DataValues): DataValues {
  const carried: DataValues = {};
  for (const id of loop.carry ?? []) if (produced[id] !== undefined) carried[id] = produced[id];
  return carried;
}

/** What a finished loop hands the rest of the graph: its last iteration's values only (an earlier
 *  iteration's value whose producer failed or skipped last time does not escape), and its outcome item. */
export function loopExports(loop: LoopDef, lastProduced: DataValues, outcome: LoopOutcome): DataValues {
  return { ...lastProduced, ...(loop.outcome === undefined ? {} : { [loop.outcome]: { schema: "outcome", answer: outcome } }) };
}

/**
 * The input bundle a node gets: each input and optional input present. Inside a loop, an id the node
 * reads on a back edge (`carriedReads`) is read from `carried`, the snapshot the iteration started
 * with, never from `data`, where this iteration's producer may already have written its new value.
 */
export function nodeInputs(node: NodeDef, data: DataValues, carried: DataValues = {}, carryIds: readonly string[] = []): DataValues {
  const out: DataValues = {};
  for (const id of allInputs(node)) {
    const v = carryIds.includes(id) ? carried[id] : data[id];
    if (v !== undefined) out[id] = v;
  }
  return out;
}

/** Every `boundary: "input"` item filled from the request: a graph takes its request as its one text input. */
export function requestInputs(graph: GraphDef, request: string): DataValues {
  const items = graph.data.filter((d) => d.boundary === "input");
  if (items.length !== 1 || items[0]!.schema !== "text") {
    throw new Error(`graph ${graph.id} must declare exactly one input data item, of schema text, to take a request`);
  }
  return { [items[0]!.id]: { schema: "text", text: request } };
}

/** What is wrong with the values a run is handed: each must be one of the graph's input items, valid
 *  against its schema, and every input item needs one. */
export function checkRunInputs(graph: GraphDef, inputs: DataValues): string[] {
  const problems: string[] = [];
  const items = graph.data.filter((d) => d.boundary === "input");
  for (const id of Object.keys(inputs)) {
    const item = items.find((d) => d.id === id);
    if (item === undefined) {
      problems.push(`${id} is not an input of graph ${graph.id}`);
      continue;
    }
    try {
      parseDataValue(inputs[id], item.schema, id);
    } catch (e) {
      if (!(e instanceof ContractError)) throw e;
      problems.push(...e.issues.map((i) => i.message));
    }
  }
  for (const item of items) if (!Object.hasOwn(inputs, item.id)) problems.push(`no value for input ${item.id}`);
  return problems;
}

/** What is wrong with the run's config for this graph: a check bound to the shell runner must name a
 *  verification step (`CHECK_STEPS`), never push, PR or merge; every classifier node has a binding; a
 *  classifier bound to the stub answers as a real one does (`CLASSIFIER_ANSWERS`), so a gate the graph
 *  validated can fire; a Jev or Haiku setup reads only its node's inputs, marks a field on an optional
 *  input `optional`, and puts no feature on one. */
export function checkRunConfig(graph: GraphDef, config: RunConfig): string[] {
  const shell = graph.nodes
    .filter((n) => n.kind === "check" && bindingFor(config, "check", n.role).adapter === "shell" && !CHECK_STEPS.includes(n.role))
    .map((n) => `node ${n.id} is a check bound to the shell runner: its role ${n.role} must be one of ${CHECK_STEPS.join(", ")}`);
  const classifiers = graph.nodes
    .filter((n) => n.kind === "classifier")
    .flatMap((n) => {
      const b = bindingFor(config, "classifier", n.role);
      if (b === undefined) return [`node ${n.id} has no classifier binding: the config has no default and no roles.${n.role}.classifier`];
      if (b.adapter !== "stub") return setupReads(n, b);
      const given = Object.hasOwn(b.answers, n.role) ? [b.answers[n.role]!].flat() : [b.default];
      return given.filter((a) => !CLASSIFIER_ANSWERS.includes(a.answer)).map((a) => `node ${n.id}'s stub answers ${a.answer}; a classifier answers ${CLASSIFIER_ANSWERS.join(" or ")}`);
    });
  return [...shell, ...classifiers];
}

/** What a Jev or Haiku setup reads that its node does not hand it for sure. */
function setupReads(n: NodeDef, b: JevBinding | HaikuBinding): string[] {
  const optional = new Set(n.optionalInputs ?? []);
  const fields = Object.entries(b.fields).flatMap(([name, f]) => {
    if (n.inputs.includes(f.input)) return [];
    if (!optional.has(f.input)) return [`node ${n.id}'s classifier field ${name} reads ${f.input}, which is not an input of the node`];
    return f.optional === true ? [] : [`node ${n.id}'s classifier field ${name} reads the optional input ${f.input} and is not marked optional`];
  });
  const features = b.adapter === "jev" ? b.features.filter((f) => !n.inputs.includes(f.input)).map((f) => `node ${n.id}'s classifier feature reads ${f.input}, which is not a required input of the node`) : [];
  return [...fields, ...features];
}

/** A run's phase once its scope finished: failed when any node failed in any iteration (a later skip
 *  or success does not undo it) or any loop aborted. A cancelled or abandoned run never gets here. */
export function finalPhase(nodes: readonly NodeRun[], loops: readonly LoopRun[]): RunHistory["phase"] {
  return nodes.some((n) => n.status === "failed") || loops.some((l) => l.outcome === "aborted") ? "failed" : "done";
}

/** The run's error with `more` added after what it already says. */
export const withRunError = (error: string | undefined, more: string): string => (error === undefined || error === "" ? more : `${error}; ${more}`);

/** What an ended run's `finished` event says: `merged` once a merge ref is among its data (whatever
 *  ended it after), else its phase when it failed, was cancelled or was abandoned, else `unmerged` (a
 *  graph that merges nothing, or did not get there); with the number of the PR it opened, if any. */
export function finishedOutcome(h: Pick<RunHistory, "phase" | "data">): { outcome: FinishedOutcome; pr?: number } {
  const refs = Object.values(h.data).filter((v) => v.schema === "ref");
  const pr = refs.find((v) => v.kind === "pr" && /^\d+$/.test(v.id))?.id;
  const outcome: FinishedOutcome = refs.some((v) => v.kind === "merge")
    ? "merged"
    : h.phase === "failed" || h.phase === "cancelled" || h.phase === "abandoned"
      ? h.phase
      : "unmerged";
  return { outcome, ...(pr === undefined ? {} : { pr: Number(pr) }) };
}

/** When an attempt of cap `capMs` is aborted by its own worker: early by `CAP_ABORT_LEAD_MS` (at most
 *  half the cap), so its processes are gone and the attempt has failed before the server's timeout. */
export const localAbortMs = (capMs: number): number => capMs - Math.min(CAP_ABORT_LEAD_MS, capMs / 2);

/** A node's activity options: its time cap per attempt, a heartbeat timeout, and one retry. A
 *  contract violation or a run error is never retried, and a data operation that is not idempotent
 *  gets no retry at all. A cap no longer than the heartbeat timeout already catches a
 *  dead worker sooner, so it gets none. */
export function activityOptions(graph: GraphDef, node: NodeDef) {
  const once = node.kind === "data" && opSpec(graph, node.role)?.idempotent === false;
  return {
    startToCloseTimeout: node.timeCapMs,
    ...(node.timeCapMs > HEARTBEAT_TIMEOUT_MS ? { heartbeatTimeout: HEARTBEAT_TIMEOUT_MS } : {}),
    retry: {
      maximumAttempts: once ? 1 : NODE_MAX_ATTEMPTS,
      initialInterval: RETRY_INITIAL_INTERVAL_MS,
      nonRetryableErrorTypes: [...NON_RETRYABLE_ERROR_TYPES],
    },
  };
}
