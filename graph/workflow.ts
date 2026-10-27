/**
 * The one generic workflow: it walks any validated graph. It starts every unit whose dependencies
 * finished (in parallel), skips what a gate or a missing input rules out, runs each loop until its
 * stop node says so or its cap, runs each fan-out once per item of its list, checks every agent's
 * outputs through the schema service, routes the questions a node's outputs raise, and waits on the
 * `answer` signal when a question needs the operator. A cancel (`build-graph cancel`), or an
 * operation that ends the run on the operator's word (`abandon`), stops every node at once; the run is
 * recorded and its one `finished` event fired out of reach of the cancel. The decisions are
 * `schedule.ts`'s; this file only applies them. No I/O: every effect is an activity.
 */

import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  CancelledFailure,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  TemporalFailure,
} from "@temporalio/workflow";

import type * as activities from "./activities.ts";
import {
  ACTIVITY_OF,
  type Answer,
  type CheckValue,
  ContractError,
  type DataValues,
  type FanOutDef,
  type LoopDef,
  type LoopRun,
  type MergeConflict,
  type NodeDef,
  type NodeOutcome,
  type NodeRun,
  type NodeTask,
  NON_RETRYABLE_ERROR_TYPES,
  parseOutputs,
  QUERY_STATUS,
  type Question,
  type RunHistory,
  runKindOf,
  type RunPlace,
  SIGNAL_ANSWER,
  type WorkflowInput,
  type WriterConflict,
} from "./contracts.ts";
import { NODE_MAX_ATTEMPTS, QUESTIONS_FILE, SERVICE_ACTIVITY_CAP_MS, WRITER_RESTART_CAP } from "./constants.ts";
import { carriedReads, nodeById, runAnswer, type ScopeRef, scopeUnits, sourceOf, unitKey, validateGraph, verdictOutput } from "./define.ts";
import {
  activityOptions,
  answerText,
  blockedText,
  carryForward,
  checkRunConfig,
  checkRunInputs,
  conflictStep,
  conflictText,
  conflictWriter,
  decide,
  finishedOutcome,
  fanOutExports,
  fanOutProblems,
  fanStatus,
  finalPhase,
  itemBlocker,
  loopExports,
  loopStep,
  nodeInputs,
  operatorAsk,
  questionsOnly,
  readyItems,
  replyAnswer,
  restartText,
  routeQuestion,
  type Unit,
  withRunError,
} from "./schedule.ts";
import type { MergeOutcome } from "./worktree.ts";

export const answerSignal = defineSignal<[string]>(SIGNAL_ANSWER);
export const statusQuery = defineQuery<RunHistory>(QUERY_STATUS);

const service = proxyActivities<typeof activities>({
  startToCloseTimeout: SERVICE_ACTIVITY_CAP_MS,
  retry: { maximumAttempts: NODE_MAX_ATTEMPTS, nonRetryableErrorTypes: [...NON_RETRYABLE_ERROR_TYPES] },
});

function failureText(e: unknown): string {
  if (e instanceof ActivityFailure) return e.cause?.message ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

/** One scope's run: the body it belongs to (null at the top), its iteration, its fan-out item, and,
 *  in a loop, the carried data the iteration started with. */
interface Scope {
  ref: ScopeRef | null;
  loop: LoopDef | null;
  iteration: number;
  instance?: string;
  carried: DataValues;
}

/** `<node>#<iteration>@<instance>`: the run a service node serves. */
const runKey = (node: string, iteration: number, instance?: string): string =>
  `${node}${iteration > 0 ? `#${iteration}` : ""}${instance === undefined ? "" : `@${instance}`}`;

/** How a `runNode` call ended: the node's outputs (none when it failed), or its merge's conflict. */
type NodeEnd = { outputs: DataValues | undefined } | { conflict: MergeConflict };

/**
 * Merge, and while the merge conflicts, run the commit's writer again on the conflict and merge
 * again, up to `WRITER_RESTART_CAP` fresh runs (`conflictStep`). `writerOf` names the node that wrote
 * the commit (undefined: none of this scope did); `rerun` gives it its fresh run and says whether it
 * finished. Records nothing: each caller records its own rows. Returns the merge's value, why the
 * merge failed, or the writer whose fresh run did not finish.
 */
async function mergeWithRestarts<T>(
  merge: () => Promise<{ value: T } | { conflict: MergeConflict }>,
  writerOf: (commit: string) => string | undefined,
  rerun: (writer: string, conflict: WriterConflict) => Promise<boolean>
): Promise<{ value: T } | { failed: string } | { unfinished: string }> {
  for (let restarts = 0; ; restarts++) {
    const got = await merge();
    if (!("conflict" in got)) return got;
    const writer = writerOf(got.conflict.commit);
    if (writer === undefined) return { failed: `${conflictText(got.conflict)}, and no node of this scope wrote the commit` };
    const step = conflictStep(got.conflict, restarts, writer, WRITER_RESTART_CAP);
    if ("fail" in step) return { failed: step.fail };
    if (!(await rerun(writer, step.restart))) return { unfinished: writer };
  }
}

/** What one node run carries across `runNode` calls: the last rerun it reached, the answer lines its
 *  agent got, and the questions answered (one answered once is not asked again). */
interface NodeRunState {
  rerun: number;
  theirAnswers: string[];
  answered: Map<string, Answer>;
}

export async function graphWorkflow(input: WorkflowInput): Promise<RunHistory> {
  const { graph } = input;
  const services = graph.services ?? {};
  const formats: Record<string, string> = {};
  for (const d of graph.data) if (d.format !== undefined) formats[d.id] = d.format;
  const history: RunHistory = {
    runId: input.runId,
    graph,
    runKind: runKindOf(input.config),
    phase: "running",
    nodes: [],
    loops: [],
    fanOuts: [],
    questions: [],
    asking: [],
    data: {},
  };
  // The node that writes what an amend replaces (the brief writer) folds an answer into its own re-run;
  // the amend service is for the nodes after it.
  const amendedBy = graph.amended === undefined ? undefined : sourceOf(graph, graph.amended.replaces);
  const answers: string[] = [];
  setHandler(answerSignal, (text) => {
    if (answers.length < history.asking.length) answers.push(text);
    else log.warn("answer signal with no unanswered question; dropped");
  });
  setHandler(statusQuery, () => history);

  // Every scope still running holds its own copy of the data it sees; an amended brief goes into each,
  // so every node that starts after the amend reads it.
  const liveScopes = new Set<DataValues>();
  const publish = (values: DataValues): void => {
    for (const d of liveScopes) Object.assign(d, values);
    Object.assign(history.data, values);
  };

  const rowAt = (node: string, iteration: number, instance: string | undefined): NodeRun | undefined =>
    history.nodes.find((n) => n.node === node && n.iteration === iteration && n.instance === instance);
  // The workflow's clock is Temporal's, so the stamps replay as they were first written.
  const record = (r: NodeRun): void => {
    const i = history.nodes.findIndex((n) => n.node === r.node && n.iteration === r.iteration && n.instance === r.instance);
    const now = new Date().toISOString();
    const startedAt = (i < 0 ? undefined : history.nodes[i]!.startedAt) ?? (r.status === "skipped" ? undefined : now);
    const ended = r.status === "done" || r.status === "failed" || r.status === "cancelled";
    const stamped: NodeRun = { ...r, ...(startedAt === undefined ? {} : { startedAt }), ...(ended ? { endedAt: now } : {}) };
    if (i < 0) history.nodes.push(stamped);
    else history.nodes[i] = stamped;
  };
  const at = (iteration: number, instance: string | undefined) => ({ iteration, ...(instance === undefined ? {} : { instance }) });

  let place: RunPlace | undefined;
  // The scope every node runs in: a cancel of the run reaches it, and an operation that ends the run
  // on the operator's word cancels it alone (`abandoned`), so both end by the same path.
  const body = new CancellationScope();
  let abandoned: string | undefined;
  /** Why a node the stop reached was cancelled: the abandon's reason, or the operator's cancel. */
  const stopReason = (): string => abandoned ?? "cancelled by the operator";

  const task = (node: NodeDef, iteration: number, instance: string | undefined, inputs: DataValues, extra: Partial<NodeTask> = {}): NodeTask => ({
    runId: input.runId,
    node,
    ...at(iteration, instance),
    inputs,
    answers: [],
    place: place!,
    config: input.config,
    formats,
    schemas: Object.fromEntries(node.outputs.map((id) => [id, graph.data.find((d) => d.id === id)!.schema])),
    ...(node.readsRecord === true ? { record: history } : {}),
    ...extra,
  });

  /** Wait for the operator's answer to `question`, asked on behalf of `node`. */
  async function askOperator(node: string, iteration: number, question: string): Promise<string> {
    const ask = { node, iteration, question };
    history.asking.push(ask);
    history.phase = "waiting";
    try {
      await service.notifyOperator({ runId: input.runId, repo: input.repo, events: input.events, node, question });
    } catch (e) {
      log.warn(`notify failed for ${node}: ${failureText(e)}`);
    }
    await condition(() => history.asking[0] === ask && answers.length > 0);
    history.asking.shift();
    history.phase = history.asking.length > 0 ? "waiting" : "running";
    return answers.shift()!;
  }

  /** Run a service node's activity once (no schema check, no questions of its own); `reason` says why
   *  while it runs. */
  async function runService(id: string, iteration: number, instance: string, extra: Partial<NodeTask>, reason?: string): Promise<NodeOutcome | undefined> {
    const node = nodeById(graph, id)!;
    const acts = proxyActivities<typeof activities>(activityOptions(graph, node));
    const row = { node: id, ...at(iteration, instance), ...(extra.conflict === undefined ? {} : { restarts: extra.conflict.restart }) };
    record({ ...row, status: "running", ...(reason === undefined ? {} : { reason }) });
    try {
      const out = await acts[ACTIVITY_OF[node.kind]](task(node, iteration, instance, nodeInputs(node, history.data), extra));
      if (out.status === "done") {
        parseOutputs(graph, node, out.outputs, place!.runDir);
        const v = verdictOutput(node);
        const answer = runAnswer(v === undefined ? undefined : out.outputs[v]);
        record({ ...row, status: "done", attempt: out.attempt, ...answer });
      }
      return out;
    } catch (e) {
      if (isCancellation(e)) {
        record({ ...row, status: "cancelled", reason: stopReason() });
        throw e;
      }
      record({ ...row, status: "failed", reason: failureText(e) });
      return undefined;
    }
  }

  /**
   * Run the amend service on an answer that changes the brief, merge its commit, and publish what it
   * amended (`graph.amended`), reparsed. A commit whose merge conflicts runs the service again, fresh,
   * on the conflict (`mergeWithRestarts`). Returns why it failed, or null.
   */
  async function applyAmend(q: Question, answer: Answer, iteration: number, inst: string): Promise<string | null> {
    const amendId = services.amend!;
    const first = await runService(amendId, iteration, inst, { question: q, answer });
    if (first?.status !== "done") return `the amend service ${amendId} did not finish`;
    let last = first;
    const fail = (reason: string): string => {
      const restarts = rowAt(amendId, iteration, inst)?.restarts;
      record({ node: amendId, iteration, instance: inst, status: "failed", reason, ...(restarts === undefined ? {} : { restarts }) });
      return reason;
    };
    const end = await mergeWithRestarts<string | null>(
      async () => {
        const ref = Object.values(last.outputs).find((v) => v.schema === "ref");
        if (ref?.schema !== "ref") return { value: `the amend service ${amendId} wrote no commit` };
        let merged: MergeOutcome;
        try {
          merged = await service.mergeServiceCommit({ place: place!, sha: ref.id, label: `${amendId} for ${q.id}` });
        } catch (e) {
          if (isCancellation(e)) throw e;
          return { value: fail(`merge: ${failureText(e)}`) };
        }
        return "conflict" in merged ? merged : { value: await publishAmend(amendId, last.outputs, iteration, inst) };
      },
      () => amendId,
      async (_, conflict) => {
        const res = await runService(amendId, iteration, inst, { question: q, answer, conflict, rerun: conflict.restart, fresh: true }, restartText(conflict, amendId, WRITER_RESTART_CAP));
        if (res?.status !== "done") return false;
        last = res;
        return true;
      }
    );
    if ("value" in end) return end.value;
    if ("failed" in end) return fail(end.failed);
    return `the amend service ${amendId} did not finish`;
  }

  /** Publish what a merged amend wrote (`graph.amended`), reparsed. Returns why it failed, or null. */
  async function publishAmend(amendId: string, outputs: DataValues, iteration: number, inst: string): Promise<string | null> {
    const spec = graph.amended;
    if (spec === undefined) return null;
    const amended = outputs[spec.output];
    if (amended === undefined) return `the amend service ${amendId} wrote no ${spec.output}`;
    publish({ [spec.replaces]: amended });
    if (spec.reparse === undefined) return null;
    const out = await runService(spec.reparse, iteration, inst, {});
    const said = out?.status === "done" ? out.outputs[verdictOutput(nodeById(graph, spec.reparse)!)!] : undefined;
    if (out?.status !== "done" || said?.schema !== "check" || said.answer !== "pass") {
      return `${spec.reparse} on the amended ${spec.replaces}: ${said?.schema === "check" ? said.detail : "it did not answer"}`;
    }
    publish(out.outputs);
    return null;
  }

  /**
   * Route each question (K-route-question) and answer it through the resolver or the operator. A resolver's
   * answer that changes the brief is put to the operator first when the amend service will apply it
   * (`operatorAsk`): `approve` keeps it and runs the amend service on it, any other reply is the
   * operator's own answer and changes nothing. Returns the answers, with the blocked question that
   * sends the asker back for one fresh run when the batch holds one (the answers before it stand), or
   * why an amend failed (the asker fails with it).
   */
  async function routeAll(
    asker: NodeDef,
    iteration: number,
    instance: string | undefined,
    questions: Question[],
    retried: boolean
  ): Promise<{ answers: Answer[]; retry?: Question } | { failed: string }> {
    const answers: Answer[] = [];
    const from = { node: asker.id, ...at(iteration, instance) };
    const key = runKey(asker.id, iteration, instance);
    const ownsBrief = amendedBy?.kind === "node" && amendedBy.id === asker.id;
    const amends = services.amend !== undefined && !ownsBrief;
    for (const q of questions) {
      const qKey = `${key}:${q.id}`;
      let route = routeQuestion(q, { hasResolver: services.resolver !== undefined, retried });
      if (services.route !== undefined) record({ node: services.route, iteration, instance: qKey, status: "done", answer: route });
      if (route === "retry") {
        history.questions!.push({ from, question: q, route });
        return { answers, retry: q };
      }
      const res = route === "resolver" ? await runService(services.resolver!, iteration, qKey, { question: q }) : undefined;
      const got = res?.status === "done" ? res.answer : undefined;
      const settled = operatorAsk(got, amends);
      let answer: Answer;
      if ("answer" in settled) answer = settled.answer;
      else {
        if (route === "resolver" && (got === undefined || "needsOperator" in got)) route = "operator";
        const op = services.operator ?? asker.id;
        if (services.operator !== undefined) record({ node: op, iteration, instance: qKey, status: "waiting", reason: q.text });
        const reply = await askOperator(op, iteration, `${key} asks (${q.type}): ${q.text}${q.recommendation === undefined ? "" : ` Recommendation: ${q.recommendation}`} ${settled.ask}`.trim());
        if (services.operator !== undefined) record({ node: op, iteration, instance: qKey, status: "done" });
        answer = replyAnswer(q, got, reply);
      }
      history.questions!.push({ from, question: q, route, answer });
      if (answer.brief_change !== undefined && amends) {
        const why = await applyAmend(q, answer, iteration, qKey);
        if (why !== null) return { failed: `the amend for ${q.id} failed: ${why}` };
      }
      answers.push(answer);
    }
    return { answers };
  }

  const nodeRuns = new Map<string, NodeRunState>();

  /** Run a node to its end. A second call on the same node run (a writer run again after its merge
   *  conflicted, `conflict` set) goes on from that run's state, and starts its worktree fresh. */
  async function runNode(node: NodeDef, scope: Scope, data: DataValues, conflict?: WriterConflict): Promise<NodeEnd> {
    const { iteration, instance } = scope;
    const acts = proxyActivities<typeof activities>(activityOptions(graph, node));
    const run = acts[ACTIVITY_OF[node.kind]];
    const carryIds = scope.loop === null ? [] : [...(carriedReads(graph, scope.loop).get(node.id) ?? [])];
    const key = runKey(node.id, iteration, instance);
    const prior = nodeRuns.get(key);
    const st: NodeRunState = prior ?? { rerun: 0, theirAnswers: [], answered: new Map() };
    if (prior === undefined) nodeRuns.set(key, st);
    else st.rerun++;
    let firstPass = true;
    let schemaRetried = false;
    let retriedBlocked = false;
    let inputs: DataValues = {};
    const mark = (r: Omit<NodeRun, "node" | "iteration" | "instance">): void =>
      record({ node: node.id, ...at(iteration, instance), ...r, inputs: Object.keys(inputs).sort(), ...(conflict === undefined ? {} : { restarts: conflict.restart }) });
    /** A node that fails open (`opensOnFailure`) and broke: done, with the error and no outputs. */
    const failOpen = (error: string, attempt: number): NodeEnd => {
      mark({ status: "done", attempt, error });
      return { outputs: {} };
    };
    const failed = { outputs: undefined };
    for (;;) {
      // Read again on every pass: an answer may have amended the brief since the last one.
      inputs = nodeInputs(node, data, scope.carried, carryIds);
      mark({ status: "running" });
      const restart: Partial<NodeTask> = conflict === undefined ? {} : { conflict, ...(firstPass ? { fresh: true as const } : {}) };
      firstPass = false;
      let outcome: NodeOutcome;
      try {
        outcome = await run(task(node, iteration, instance, inputs, { answers: st.theirAnswers, rerun: st.rerun, ...restart }));
      } catch (e) {
        if (isCancellation(e)) {
          mark({ status: "cancelled", reason: stopReason() });
          throw e;
        }
        mark({ status: "failed", reason: failureText(e) });
        return failed;
      }
      if (outcome.status === "abandon") {
        mark({ status: "cancelled", reason: outcome.reason, attempt: outcome.attempt });
        abandoned = outcome.reason;
        body.cancel();
        throw new CancelledFailure(`abandoned at ${node.id}: ${outcome.reason}`);
      }
      if (outcome.status === "merge-conflict") return { conflict: { commit: outcome.commit, paths: outcome.paths } };
      if (outcome.status === "needs-operator") {
        mark({ status: "waiting", reason: outcome.reason ?? outcome.question, attempt: outcome.attempt });
        st.theirAnswers = [...st.theirAnswers, await askOperator(node.id, iteration, outcome.question)];
        st.rerun++;
        continue;
      }
      // A classifier that failed open hands on its fail-open verdict; any other node, nothing.
      if (outcome.failedOpen !== undefined && node.kind !== "classifier") return failOpen(outcome.failedOpen, outcome.attempt);
      let outputs: DataValues;
      try {
        outputs = parseOutputs(graph, node, outcome.outputs, place!.runDir);
      } catch (e) {
        if (!(e instanceof ContractError)) throw e;
        if (node.failOpen === true) return failOpen(e.message, outcome.attempt);
        mark({ status: "failed", reason: e.message, attempt: outcome.attempt });
        return failed;
      }
      const questions = [...(outcome.questions ?? [])];
      if (node.kind === "agent" && services.schema !== undefined) {
        const subject = { node: node.id, ...at(iteration, instance) };
        const res = await runService(services.schema, iteration, key, { inputs: outputs, subject, subjectInputs: inputs, rerun: st.rerun });
        const said = res?.status === "done" ? res.outputs[verdictOutput(nodeById(graph, services.schema)!)!] : undefined;
        if (said?.schema !== "check" || said.answer === "fail") {
          const why = said?.schema === "check" ? said.detail : "the schema check did not answer";
          if (!schemaRetried) {
            schemaRetried = true;
            st.rerun++;
            continue;
          }
          if (node.failOpen === true) return failOpen(`schema: ${why}`, outcome.attempt);
          mark({ status: "failed", reason: `schema: ${why}`, attempt: outcome.attempt });
          return failed;
        }
        if (res?.status === "done") questions.push(...(res.questions ?? []));
      }
      const fresh = questions.filter((q) => !st.answered.has(q.id));
      const stopped = node.kind === "agent" ? questionsOnly(node, outputs) : [];
      if (fresh.length > 0) {
        const got = await routeAll(node, iteration, instance, fresh, retriedBlocked);
        if ("failed" in got) {
          mark({ status: "failed", reason: got.failed, attempt: outcome.attempt });
          return failed;
        }
        for (const a of got.answers) st.answered.set(a.question_id, a);
        const lines = got.answers.map((a) => answerText(fresh.find((q) => q.id === a.question_id)!, a));
        if (got.retry !== undefined) {
          retriedBlocked = true;
          st.theirAnswers = [...st.theirAnswers, ...lines, blockedText(got.retry)];
          st.rerun++;
          continue;
        }
        if (node.answers === undefined || stopped.length > 0 || fresh.some((q) => q.type === "blocked")) {
          // A node with nowhere to put its answers stopped on its questions, as did one that wrote
          // only its questions, and a blocked one could not go on at all: it runs again on them.
          st.theirAnswers = [...st.theirAnswers, ...lines];
          st.rerun++;
          continue;
        }
      } else if (stopped.length > 0) {
        mark({
          status: "failed",
          reason: `${stopped.join(", ")} hold only ${QUESTIONS_FILE}, and every question in it is answered already: ${questions.map((q) => q.id).join(", ") || "(none)"}`,
          attempt: outcome.attempt,
        });
        return failed;
      }
      if (node.answers !== undefined) {
        // Every question this run raised that has an answer, from this run or an earlier one.
        const mine = [...new Set(questions.map((q) => q.id))].flatMap((id) => st.answered.get(id) ?? []);
        const file = outputs[node.answers];
        if (mine.length > 0 && file?.schema === "files") await service.writeAnswers({ file: file.files[0]!, answers: mine });
      }
      const v = verdictOutput(node);
      const answer = runAnswer(v === undefined ? undefined : outputs[v]);
      mark({ status: "done", attempt: outcome.attempt, ...answer });
      return { outputs };
    }
  }

  /**
   * Run a node, and when its merge conflicts (a `merge-back`), run the writer of the commit it read again
   * on the run tree's head, keep the writer's new outputs, and merge again, up to `WRITER_RESTART_CAP`
   * fresh runs (`mergeWithRestarts`). The writer is a node of this scope; a commit from outside it fails the merge.
   */
  async function runNodeUnit(node: NodeDef, scope: Scope, data: DataValues, keep: (values: DataValues) => void): Promise<DataValues | undefined> {
    const where = at(scope.iteration, scope.instance);
    const mark = (r: Pick<NodeRun, "status" | "reason">): void => {
      const prev = rowAt(node.id, scope.iteration, scope.instance);
      record({ node: node.id, ...where, ...r, ...(prev?.inputs === undefined ? {} : { inputs: prev.inputs }) });
    };
    const end = await mergeWithRestarts(
      async () => {
        const ran = await runNode(node, scope, data);
        return "conflict" in ran ? ran : { value: ran.outputs };
      },
      (commit) => conflictWriter(graph, scope.ref, node, data, commit),
      async (writer, conflict) => {
        mark({ status: "running", reason: restartText(conflict, writer, WRITER_RESTART_CAP) });
        const again = await runNode(nodeById(graph, writer)!, scope, data, conflict);
        if (!("outputs" in again) || again.outputs === undefined) return false;
        keep(again.outputs);
        return true;
      }
    );
    if ("value" in end) return end.value;
    if ("failed" in end) mark({ status: "failed", reason: end.failed });
    else mark({ status: "skipped", reason: `${end.unfinished} did not finish its run on the new head` });
    return undefined;
  }

  async function runLoop(loop: LoopDef, outer: DataValues): Promise<DataValues> {
    const lr: LoopRun = { loop: loop.id, iterations: 0 };
    history.loops.push(lr);
    const until = nodeById(graph, loop.until.node)!;
    let carried: DataValues = {};
    for (let i = 1; ; i++) {
      lr.iterations = i;
      const produced = await runScope({ ref: { kind: "loop", id: loop.id }, loop, iteration: i, carried }, outer);
      const out = verdictOutput(until);
      const step = loopStep(loop, i, out === undefined ? undefined : produced[out]);
      if (step !== "again") {
        lr.outcome = step;
        return loopExports(loop, produced, step);
      }
      carried = carryForward(loop, produced);
    }
  }

  /** Run a fan-out once per item of its list, in the scope it sits in (the top level, or one iteration
   *  of its loop): each item's scope keeps that iteration and the carry it started with. */
  async function runFan(fan: FanOutDef, outer: DataValues, parent: Scope): Promise<DataValues> {
    const { iteration } = parent;
    const list = outer[fan.over];
    const withStatus = (exports: DataValues, status: CheckValue): DataValues => (fan.status === undefined ? exports : { ...exports, [fan.status]: status });
    const skipAll = (reason: string): DataValues => {
      for (const id of fan.nodes) record({ node: id, iteration, status: "skipped", reason });
      return {};
    };
    if (list?.schema !== "items") return skipAll(`list ${fan.over} missing`);
    const problems = fanOutProblems(list.items);
    if (problems.length > 0) {
      for (const id of fan.nodes) record({ node: id, iteration, status: "failed", reason: `list ${fan.over}: ${problems.join("; ")}` });
      return withStatus({}, { schema: "check", answer: "fail", detail: `list ${fan.over}: ${problems.join("; ")}` });
    }
    history.fanOuts!.push({ fanOut: fan.id, iteration, items: list.items.map((it) => it.id) });
    if (list.items.length === 0) return withStatus(skipAll(`list ${fan.over} is empty`), fanStatus([], () => false));
    const started = new Set<string>();
    const finished = new Set<string>();
    const byItem = new Map<string, DataValues>();
    const running = new Map<string, Promise<void>>();
    // An item is down when one of its nodes failed, or it was skipped for an item it comes after that
    // was down: the items after it skip too, however far down the chain.
    const down = new Set<string>();
    const failedItem = (id: string): boolean => history.nodes.some((n) => n.instance === id && n.iteration === iteration && fan.nodes.includes(n.node) && n.status === "failed");
    for (;;) {
      const ready = readyItems(list.items, started, finished);
      if (ready.length === 0 && running.size === 0) break;
      for (const id of ready) {
        started.add(id);
        const blocker = itemBlocker(list.items.find((it) => it.id === id)!.after, (a) => down.has(a) || failedItem(a));
        if (blocker !== null) {
          for (const n of fan.nodes) record({ node: n, iteration, instance: id, status: "skipped", reason: `item ${blocker}, which it comes after, failed or was skipped` });
          down.add(id);
          finished.add(id);
          continue;
        }
        running.set(
          id,
          runScope({ ref: { kind: "fan", id: fan.id }, loop: parent.loop, iteration, instance: id, carried: parent.carried }, outer)
            .then((p) => void byItem.set(id, p))
            .finally(() => {
              finished.add(id);
              running.delete(id);
            })
        );
      }
      if (running.size > 0) await Promise.race(running.values());
    }
    const order = list.items.map((it) => it.id);
    return withStatus(
      fanOutExports(order, byItem),
      fanStatus(order, (id) => down.has(id) || failedItem(id))
    );
  }

  /** Run one scope to the end; returns what its units produced. */
  async function runScope(scope: Scope, visible: DataValues): Promise<DataValues> {
    const data: DataValues = { ...visible };
    liveScopes.add(data);
    try {
      return await runScopeOn(scope, data);
    } finally {
      liveScopes.delete(data);
    }
  }

  async function runScopeOn(scope: Scope, data: DataValues): Promise<DataValues> {
    const produced: DataValues = {};
    const started = new Set<string>();
    const finished = new Set<string>();
    const running = new Map<string, Promise<void>>();
    const keep = (values: DataValues | undefined): void => {
      Object.assign(data, values);
      Object.assign(produced, values);
      if (scope.ref === null) Object.assign(history.data, values);
    };
    const runUnit = async (unit: Unit): Promise<void> => {
      if (unit.kind === "node") keep(await runNodeUnit(nodeById(graph, unit.id)!, scope, data, keep));
      else if (unit.kind === "loop") keep(await runLoop(graph.loops.find((l) => l.id === unit.id)!, data));
      else keep(await runFan((graph.fanOuts ?? []).find((f) => f.id === unit.id)!, data, scope));
    };
    for (;;) {
      const d = decide(graph, scope.ref, { started, finished, data });
      for (const s of d.skip) {
        const key = unitKey({ kind: "node", id: s.node });
        started.add(key);
        finished.add(key);
        record({ node: s.node, ...at(scope.iteration, scope.instance), status: "skipped", reason: s.reason });
      }
      for (const unit of d.start) {
        const key = unitKey(unit);
        started.add(key);
        running.set(
          key,
          runUnit(unit).finally(() => {
            finished.add(key);
            running.delete(key);
          })
        );
      }
      if (d.skip.length > 0) continue;
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    const stalled = scopeUnits(graph, scope.ref).filter((u) => !finished.has(unitKey(u)));
    if (stalled.length > 0) {
      const where = scope.ref === null ? "top" : `${scope.ref.kind} ${scope.ref.id}`;
      throw ApplicationFailure.nonRetryable(`scope ${where} stalled: ${stalled.map(unitKey).join(", ")}`, "GraphError");
    }
    return produced;
  }

  let failure: unknown;
  try {
    await body.run(async () => {
      const problems = [...validateGraph(graph), ...checkRunInputs(graph, input.inputs), ...checkRunConfig(graph, input.config)];
      if (problems.length > 0) throw ApplicationFailure.nonRetryable(problems.join("\n"), "GraphError");
      history.data = { ...input.inputs };
      place = await service.prepareRun({ runId: input.runId, repo: input.repo, runDir: input.runDir, graph, inputs: input.inputs, config: input.config });
      await runScope({ ref: null, loop: null, iteration: 0, carried: {} }, input.inputs);
    });
    history.phase = finalPhase(history.nodes, history.loops);
  } catch (e) {
    failure = e;
    history.asking = [];
    if (isCancellation(e)) {
      // Every node still open was stopped with the run, whichever branch saw the cancel first.
      for (const n of history.nodes) if (n.status === "running" || n.status === "waiting") record({ ...n, status: "cancelled", reason: stopReason() });
      history.phase = abandoned === undefined ? "cancelled" : "abandoned";
    } else {
      // A failure outside any node still leaves a status that says so, live and on disk.
      history.phase = "failed";
      history.error = failureText(e);
    }
  }
  // The one finished event and the record run even when the run was cancelled; the event first, so
  // the record says when it did not reach the launcher.
  await CancellationScope.nonCancellable(async () => {
    const undelivered = (why: string): void => void (history.error = withRunError(history.error, `the finished event did not reach the launcher: ${why}`));
    try {
      const warned = await service.notifyFinished({ runId: input.runId, repo: input.repo, events: input.events, runDir: input.runDir, ...finishedOutcome(history), ...(place === undefined ? {} : { place }) });
      if (warned.length > 0) undelivered(warned.join("; "));
    } catch (e) {
      log.warn(`could not fire the finished event: ${failureText(e)}`);
      undelivered(failureText(e));
    }
    try {
      const missed = await service.recordRun({ runDir: input.runDir, history });
      if (missed !== null) history.error = withRunError(history.error, missed);
    } catch (recordError) {
      log.warn(`could not record the run: ${failureText(recordError)}`);
      if (failure === undefined) {
        failure = recordError;
        history.phase = "failed";
        history.error = withRunError(history.error, failureText(recordError));
      }
    }
  });
  if (failure === undefined || (abandoned !== undefined && isCancellation(failure))) return history;
  if (failure instanceof TemporalFailure) throw failure;
  throw ApplicationFailure.nonRetryable(failureText(failure), "GraphError");
}
