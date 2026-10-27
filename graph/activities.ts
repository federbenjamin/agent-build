/**
 * The activities: one per node kind, each dispatching to the adapter its role is bound to, plus the
 * run's bookkeeping (prepare the worktree, notify the operator, merge a service writer's commit,
 * write a node's answers, record the history). All of the run's I/O happens here; the workflow does
 * none.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { Context, log } from "@temporalio/activity";

import { clearAgentUsage, filesUnder, readAgentUsage } from "./adapters/agentIo.ts";
import { agentRolesMissing, agentRunnerFor, checkRunnerFor, classifierFor, classifierKeysMissing, forgeFor, pipelineFor, trackerFor } from "./adapters/bind.ts";
import { DECISION_FILE, decisionFileText, decisionRecord, failedOpenVerdict, isExplored } from "./adapters/decision.ts";
import { fileRunStore } from "./adapters/fileRunStore.ts";
import type { RunStore } from "./adapters/types.ts";
import {
  type Answer,
  type AttemptOutcome,
  type AttemptRecord,
  bindingFor,
  ContractError,
  type DataValues,
  type GraphDef,
  isDataOp,
  type MergeConflict,
  type NodeOutcome,
  type NodeTask,
  parseAnswerFile,
  type Refusal,
  NON_RETRYABLE_ERROR_TYPES,
  RunError,
  type RunConfig,
  type RunHistory,
  runKindOf,
  type RunPlace,
  type VerdictValue,
} from "./contracts.ts";
import { groupAlive, terminateGroup } from "./adapters/process.ts";
import { HEARTBEAT_INTERVAL_MS, KEPT_SIDE_FILES, NODE_MAX_ATTEMPTS } from "./constants.ts";
import { mergeIntoRunTree, runDataOp } from "./dataOps.ts";
import { opensOnFailure } from "./define.ts";
import { renderMermaid } from "./mermaid.ts";
import { type AttemptAt, attemptAt, attemptBefore, attemptKey, attemptOutKey, keySegment, nodeKey, outKey, pgidKey, pgidOwner } from "./runKeys.ts";
import type { FinishedOutcome } from "../runtime/lib/buildEvents.ts";
import { localAbortMs, withRunError } from "./schedule.ts";
import { type BlockedEvent, type EventRun, fireBlockedEvent, fireFinishedEvent } from "./notify.ts";
import { addNodeWorktree, addRunWorktree, commitLeftovers, headSha, isGitRepo, type MergeOutcome, resetWorktree, restartCommit, runBranch, runLeftovers, unmergedPaths, withRunTree } from "./worktree.ts";

/**
 * Run `fn` while heartbeating. Its signal aborts when the server cancels the attempt or when the
 * attempt's own time cap passes here: the server's timeout reaches the worker only on a later
 * heartbeat, and a hung attempt still editing the worktree must not overlap anything after it. The
 * local abort fires early by `CAP_ABORT_LEAD_MS`, so the attempt's processes are gone before the
 * server's own timeout. A cap hit fails the attempt with a `RunError`, whatever `fn` threw on the
 * abort: an attempt that ran out its cap would run it out again, so it is never retried.
 */
async function heartbeating<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctx = Context.current();
  const stop = new AbortController();
  const cancelled = () => stop.abort(ctx.cancellationSignal.reason);
  ctx.cancellationSignal.addEventListener("abort", cancelled, { once: true });
  const cap = ctx.info.startToCloseTimeoutMs;
  const capHit = new RunError(`time cap of ${cap} ms reached`);
  const capTimer = setTimeout(() => stop.abort(capHit), localAbortMs(cap));
  ctx.heartbeat();
  const timer = setInterval(() => ctx.heartbeat(), HEARTBEAT_INTERVAL_MS);
  try {
    return await fn(stop.signal);
  } catch (e) {
    throw stop.signal.reason === capHit ? capHit : e;
  } finally {
    clearInterval(timer);
    clearTimeout(capTimer);
    ctx.cancellationSignal.removeEventListener("abort", cancelled);
  }
}

/** Whether a failed attempt of a node that fails open (`opensOnFailure`) ends its node failed open
 *  rather than failed: on the last attempt, or on an error no retry would help. A cancel is not a
 *  failed call. */
const failsOpen = (e: unknown, attempt: number, cancelled: boolean): boolean =>
  !cancelled && (attempt >= NODE_MAX_ATTEMPTS || (e instanceof Error && NON_RETRYABLE_ERROR_TYPES.includes(e.name)));

/** What a node that failed open hands on: a classifier its `yes` at the cut-off with the error on the
 *  decision (so its reader runs), any other node no outputs (so its readers run without them). */
function failedOpen(task: NodeTask, attempt: number, e: unknown): NodeOutcome {
  const error = e instanceof Error ? e.message : String(e);
  const outputs: DataValues = task.node.kind === "classifier" ? { [firstOutput(task)]: failedOpenVerdict(task.node.id, bindingFor(task.config, "classifier", task.node.role)!, error) } : {};
  return { status: "done", outputs, attempt, failedOpen: error };
}

/**
 * One attempt of a node, heartbeating: its attempt record (`AttemptRecord`) is written when it starts
 * and again in a `finally` with its end and outcome, as the pgid record is closed. An agent's record
 * takes what its CLI left in the node's folder, read there because that file is this attempt's only
 * until the next one starts (it is cleared first). A node that fails open (`opensOnFailure`) ends
 * `failedOpen` when its attempt fails for good, so a provider outage or a broken optional reader runs
 * on instead of failing the run.
 */
async function nodeAttempt(task: NodeTask, body: (signal: AbortSignal, attempt: number) => Promise<NodeOutcome>): Promise<NodeOutcome> {
  const { attempt } = Context.current().info;
  const store = fileRunStore(task.place.runDir);
  const key = attemptKey(task, attempt);
  const agent = task.node.kind === "agent";
  const dir = store.path(nodeKey(task));
  if (agent) clearAgentUsage(dir);
  const opened: AttemptRecord = {
    node: task.node.id,
    iteration: task.iteration,
    ...(task.instance === undefined ? {} : { instance: task.instance }),
    rerun: task.rerun ?? 0,
    attempt,
    startedAt: new Date().toISOString(),
    ...(task.conflict === undefined ? {} : { conflict: { commit: task.conflict.commit, paths: [...task.conflict.paths], restart: task.conflict.restart } }),
  };
  store.write(key, opened);
  let outcome: AttemptOutcome = "failed";
  let conflicted: MergeConflict | undefined;
  let signal: AbortSignal | undefined;
  try {
    const out = await heartbeating(async (s) => {
      signal = s;
      try {
        return await body(s, attempt);
      } catch (e) {
        if (!opensOnFailure(task.node) || !failsOpen(e, attempt, Context.current().cancellationSignal.aborted)) throw e;
        return failedOpen(task, attempt, e);
      }
    });
    outcome = out.status === "abandon" ? "done" : out.status;
    if (out.status === "merge-conflict") conflicted = { commit: out.commit, paths: [...out.paths] };
    return out;
  } catch (e) {
    if (signal?.aborted === true) outcome = "aborted";
    throw e;
  } finally {
    store.write(key, { ...opened, endedAt: new Date().toISOString(), outcome, ...(conflicted === undefined ? {} : { conflict: conflicted }), ...(agent ? readAgentUsage(dir) : {}) } satisfies AttemptRecord);
  }
}

/**
 * Empty the node run's output folder for this attempt. The side files `stats` reads (`KEPT_SIDE_FILES`)
 * that the attempt before it left in an output's folder move first into that attempt's own folder
 * (`attemptOutKey`), so a retry or a rerun keeps every attempt's struggles and messages to peers.
 */
function emptyOutDir(task: NodeTask, attempt: number): string {
  const store = fileRunStore(task.place.runDir);
  const outDir = store.path(outKey(task));
  const before = existsSync(outDir) ? attemptBefore(recordedAttempts(task), { rerun: task.rerun ?? 0, attempt }) : null;
  if (before !== null) {
    const kept = store.path(attemptOutKey({ ...task, rerun: before.rerun }, before.attempt));
    for (const output of readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const name of KEPT_SIDE_FILES.filter((n) => existsSync(join(outDir, output.name, n)))) {
        mkdirSync(join(kept, output.name), { recursive: true });
        renameSync(join(outDir, output.name, name), join(kept, output.name, name));
      }
    }
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  return outDir;
}

/** The attempts of the node run that have a record (`attemptKey`), this one's among them. */
function recordedAttempts(task: NodeTask): AttemptAt[] {
  const own = nodeKey(task);
  return filesUnder(join(task.place.runDir, own)).flatMap((f) => {
    const a = attemptAt(relative(task.place.runDir, f).replace(/\.json$/, ""));
    return a?.nodeRun === own ? [a] : [];
  });
}

function firstOutput(task: NodeTask): string {
  const id = task.node.outputs[0];
  if (id === undefined) throw new ContractError([{ message: `node ${task.node.id}: a ${task.node.kind} writes at least one output` }]);
  return id;
}

export interface PrepareRequest {
  runId: string;
  repo: string;
  runDir: string;
  graph: GraphDef;
  inputs: DataValues;
  config: RunConfig;
}

/** Make the run dir and the run's worktree (once: a repeat returns what the first made), after
 *  checking that every agent role resolves as the config binds it. */
export async function prepareRun(req: PrepareRequest): Promise<RunPlace> {
  const store = fileRunStore(req.runDir);
  const prior = store.read("place");
  if (prior !== undefined) return prior as RunPlace;
  if (!isGitRepo(req.repo)) throw new RunError(`repo ${req.repo} is not a git repo`);
  // One read of the base: the roles and readers are checked at the commit the run is cut at.
  const base = headSha(req.repo);
  const missing = [...agentRolesMissing(req.config, req.graph, req.repo, base), ...classifierKeysMissing(req.config, req.graph, process.env)];
  if (missing.length > 0) throw new RunError(`the run cannot start: ${missing.join("; ")}`);
  const branch = runBranch(req.runId);
  const worktree = store.path("worktree");
  const baseSha = addRunWorktree(req.repo, worktree, branch, base);
  const place: RunPlace = { runDir: req.runDir, worktree, branch, baseSha };
  store.write("graph", req.graph);
  store.write("inputs", req.inputs);
  store.write("place", place);
  return place;
}

/** Stop the agent process group a pgid record (`pgidKey`) names when it is still alive: one left by a
 *  worker that died without aborting the attempt (a closed terminal, a crash, a kill), which would keep
 *  editing the worktree a reset is about to clean, or one still alive when its run ended. */
async function stopOrphanedAgent(store: RunStore, key: string): Promise<void> {
  const recorded = store.read(key) as { pid: number | null } | undefined;
  if (typeof recorded?.pid === "number" && groupAlive(recorded.pid)) await terminateGroup(recorded.pid);
}

/** Every pgid record under the run dir's `nodes/` (`pgidOwner`), as run store keys; none when the
 *  folder is absent, and a folder that cannot be read throws. */
function pgidKeys(runDir: string): string[] {
  const nodes = join(runDir, "nodes");
  return existsSync(nodes) ? filesUnder(nodes).map((f) => relative(runDir, f).replace(/\.json$/, "")).filter((key) => pgidOwner(key) !== null) : [];
}

/**
 * Where an agent works: always its own worktree (`worktrees/<node>[/<item>]`), so nothing it writes
 * reaches the run's tree and pushing is blocked in it. A fresh run of the node resets it to the run
 * tree's HEAD of the moment (so it builds on every merge before it) and records that sha, as does the
 * first attempt of a `fresh` rerun (a writer run again after its merge conflicted); a retry, or any
 * other rerun the workflow asks for, resets to the recorded sha, so the reset touches only this node's work.
 * Returns the worktree and the sha it was reset to.
 */
async function agentWorktree(task: NodeTask, attempt: number): Promise<{ dir: string; start: string }> {
  const store = fileRunStore(task.place.runDir);
  const dir = store.path(`worktrees/${task.node.id}${task.instance === undefined ? "" : `/${keySegment(task.instance)}`}`);
  addNodeWorktree(task.place.worktree, dir);
  await stopOrphanedAgent(store, pgidKey(task));
  const shaKey = `${nodeKey(task)}/start-sha`;
  const startsFresh = attempt === 1 && ((task.rerun ?? 0) === 0 || task.fresh === true);
  const recorded = startsFresh ? undefined : (store.read(shaKey) as { sha: string } | undefined);
  const sha = recorded?.sha ?? headSha(task.place.worktree);
  resetWorktree(dir, sha);
  if (recorded === undefined) store.write(shaKey, { sha });
  return { dir, start: sha };
}

/** The resolver's answer or refusal, from the `answer.json` among its outputs. */
function readAnswer(task: NodeTask, files: Record<string, string[]>): Answer | Refusal {
  const file = Object.values(files).flat().find((f) => basename(f) === "answer.json");
  if (file === undefined) throw new ContractError([{ message: `resolver ${task.node.id}: wrote no answer.json` }]);
  return parseAnswerFile(JSON.parse(readFileSync(file, "utf8")), task.question!);
}

/** An agent node; its output folder is emptied on every attempt, the earlier attempt's side files kept
 *  (`emptyOutDir`). A writer's ref output is its worktree's head after its leftovers are committed; on a
 *  fresh run after its merge conflicted (`conflict`), leftovers git still holds unmerged are not
 *  committed, and a head that brings neither the conflicted commit nor a change of its own hands that
 *  commit on again (`restartCommit`). Its answers output starts as `[]`. */
export const agentNode = (task: NodeTask): Promise<NodeOutcome> => nodeAttempt(task, (signal, attempt) => runAgent(task, signal, attempt));

async function runAgent(task: NodeTask, signal: AbortSignal, attempt: number): Promise<NodeOutcome> {
  const outDir = emptyOutDir(task, attempt);
  const { dir: worktree, start } = await agentWorktree(task, attempt);
  const ref = task.node.writes === true ? task.node.outputs.find((id) => task.schemas?.[id] === "ref") : undefined;
  const ownOutputs = task.node.outputs.filter((id) => id !== ref && id !== task.node.answers);
  const modelValue = task.node.modelFrom === undefined ? undefined : task.inputs[task.node.modelFrom];
  const model = modelValue?.schema === "text" ? modelValue.text.trim() : undefined;

  const runner = agentRunnerFor(task.config, task.node.role);
  const store = fileRunStore(task.place.runDir);
  const pgid = pgidKey(task);
  const result = await runner
    .run({
      runId: task.runId,
      nodeId: task.node.id,
      role: task.node.role,
      inputs: task.inputs,
      answers: task.answers,
      outputs: ownOutputs,
      outDir,
      worktree,
      writes: task.node.writes === true,
      attempt,
      iteration: task.iteration,
      ...(task.instance === undefined ? {} : { instance: task.instance }),
      ...(ref === undefined ? {} : { commits: ref }),
      ...(model === undefined ? {} : { model }),
      ...(task.question === undefined ? {} : { question: task.question }),
      ...(task.answer === undefined ? {} : { answer: task.answer }),
      ...(task.conflict === undefined ? {} : { conflict: task.conflict }),
      signal,
      onSpawn: (pid) => store.write(pgid, { pid }),
    })
    .finally(() => {
      if (store.read(pgid) !== undefined) store.write(pgid, { pid: null });
    });
  if (result.status === "needs-operator") return { ...result, attempt };
  const outputs: DataValues = {};
  for (const [id, files] of Object.entries(result.files)) outputs[id] = { schema: "files", files };
  if (ref !== undefined) {
    const { conflict } = task;
    if (conflict === undefined || unmergedPaths(worktree).length === 0) commitLeftovers(worktree, `build-graph: ${task.node.id} leaves uncommitted work`);
    outputs[ref] = { schema: "ref", kind: "commit", id: conflict === undefined ? headSha(worktree) : restartCommit(worktree, start, conflict.commit) };
  }
  if (task.node.answers !== undefined) {
    const file = join(outDir, task.node.answers, "answers.json");
    mkdirSync(join(outDir, task.node.answers), { recursive: true });
    writeFileSync(file, "[]\n");
    outputs[task.node.answers] = { schema: "files", files: [file] };
  }
  const answer = task.question !== undefined && task.answer === undefined ? { answer: readAnswer(task, result.files) } : {};
  return { status: "done", outputs, attempt, ...answer };
}

/**
 * A classifier node: its answer and p, and its decision record on the verdict. A classifier that
 * sent a model a state leaves the record and that state in one file in its output folder. A `no` an
 * `initial` setup gives in a real run may be explored (`isExplored`), which runs its reader anyway. A
 * call that fails for good fails open (`nodeAttempt`): `yes` with the error on the decision.
 */
export const classifierNode = (task: NodeTask): Promise<NodeOutcome> => nodeAttempt(task, (signal, attempt) => runClassifier(task, signal, attempt));

async function runClassifier(task: NodeTask, signal: AbortSignal, attempt: number): Promise<NodeOutcome> {
  const out = firstOutput(task);
  const classifier = classifierFor(task.config, task.node.role);
  const binding = bindingFor(task.config, "classifier", task.node.role)!;
  const a = await classifier.classify({ question: task.node.role, state: task.inputs, iteration: task.iteration, signal });
  const explored = isExplored(binding, { runId: task.runId, kind: runKindOf(task.config) }, task.node.id, task.iteration, a.answer) ? { explored: true as const } : {};
  const sent = a.sent === undefined ? undefined : { text: a.sent, file: join(emptyOutDir(task, attempt), DECISION_FILE) };
  const decision = { ...decisionRecord(task.node.id, binding, sent), ...explored };
  if (sent !== undefined) writeFileSync(sent.file, decisionFileText(decision, a, sent.text));
  const verdict: VerdictValue = { schema: "verdict", answer: a.answer, p: a.p, decision };
  return { status: "done", outputs: { [out]: verdict }, attempt };
}

export const checkNode = (task: NodeTask): Promise<NodeOutcome> => nodeAttempt(task, (signal, attempt) => runCheck(task, signal, attempt));

async function runCheck(task: NodeTask, signal: AbortSignal, attempt: number): Promise<NodeOutcome> {
  const out = firstOutput(task);
  const check = await checkRunnerFor(task.config, task.node.role);
  const outDir = emptyOutDir(task, attempt);
  const r = await check.run({
    role: task.node.role,
    inputs: task.inputs,
    worktree: task.place.worktree,
    baseSha: task.place.baseSha,
    iteration: task.iteration,
    signal,
    outputs: task.node.outputs.slice(1),
    outDir,
    place: task.place,
    formats: task.formats ?? {},
    ...(task.instance === undefined ? {} : { instance: task.instance }),
    ...(task.record === undefined ? {} : { record: task.record }),
    ...(task.subject === undefined ? {} : { subject: task.subject }),
    ...(task.subjectInputs === undefined ? {} : { subjectInputs: task.subjectInputs }),
    nodeId: task.node.id,
  });
  return {
    status: "done",
    outputs: { ...r.outputs, [out]: { schema: "check", answer: r.answer, detail: r.detail } },
    attempt,
    ...(r.questions === undefined || r.questions.length === 0 ? {} : { questions: r.questions }),
  };
}

export const dataNode = (task: NodeTask): Promise<NodeOutcome> => nodeAttempt(task, (signal, attempt) => runData(task, signal, attempt));

async function runData(task: NodeTask, signal: AbortSignal, attempt: number): Promise<NodeOutcome> {
  const out = firstOutput(task);
  const op = task.node.role;
  const tracker = trackerFor(task.config, task.place);
  const forge = forgeFor(task.config, task.place);
  if (isDataOp(op)) {
    const value = await runDataOp(op, { runId: task.runId, nodeId: task.node.id, inputs: task.inputs, place: task.place, tracker, forge, signal });
    if ("conflict" in value) return { status: "merge-conflict", ...value.conflict, attempt };
    return { status: "done", outputs: { [out]: value }, attempt };
  }
  const impl = (await pipelineFor(task.config)).ops[op];
  if (impl === undefined) throw new ContractError([{ message: `data node ${task.node.id}: pipeline ${task.config.pipeline} has no operation ${op}` }]);
  const outDir = emptyOutDir(task, attempt);
  const r = await impl({
    runId: task.runId,
    nodeId: task.node.id,
    role: op,
    inputs: task.inputs,
    outputs: task.node.outputs.slice(1),
    outDir,
    place: task.place,
    iteration: task.iteration,
    ...(task.instance === undefined ? {} : { instance: task.instance }),
    answers: task.answers,
    tracker,
    forge,
    signal,
    withRunTree: (fn) => withRunTree(task.place.worktree, fn),
    ...(task.record === undefined ? {} : { record: task.record }),
  });
  if (r.status !== "done") return { ...r, attempt };
  return {
    status: "done",
    outputs: r.outputs as DataValues,
    attempt,
    ...(r.questions === undefined || r.questions.length === 0 ? {} : { questions: r.questions }),
  };
}

/** Tell the operator a node waits on them (a `blocked` event), through the consumer the run carries. */
export async function notifyOperator(req: BlockedEvent): Promise<void> {
  for (const line of await fireBlockedEvent(req)) log.warn(line);
}

/** Merge a service writer's commit (the amend service's) into the run tree: the new head, or the conflicted paths. */
export async function mergeServiceCommit(req: { place: RunPlace; sha: string; label: string }): Promise<MergeOutcome> {
  return mergeIntoRunTree(req.place, req.sha, req.label);
}

/** Write the routed answers into a node's answers file (it exists: the node's activity made it). */
export async function writeAnswers(req: { file: string; answers: Answer[] }): Promise<void> {
  if (!existsSync(req.file)) throw new RunError(`answers file ${req.file} is gone`);
  writeFileSync(req.file, `${JSON.stringify(req.answers, null, 2)}\n`);
}

/** Tell the run's consumer the run ended (a `finished` event), with the worktrees it left on disk: the
 *  run tree and every agent worktree no cleanup removed. Resolves to the emitter's warnings (a consumer
 *  that failed), so the record can say the event did not arrive. */
export async function notifyFinished(req: EventRun & { runDir: string; outcome: FinishedOutcome; pr?: number; place?: RunPlace }): Promise<string[]> {
  const worktrees = runLeftovers(req.runDir, req.place?.worktree, (dir, e) => log.warn(`the finished event lists ${dir}, which could not be read: ${e.message}`));
  const event = {
    runId: req.runId,
    repo: req.repo,
    outcome: req.outcome,
    worktrees,
    ...(req.events === undefined ? {} : { events: req.events }),
    ...(req.pr === undefined ? {} : { pr: req.pr }),
    ...(req.place === undefined ? {} : { branch: req.place.branch }),
  };
  const warned = await fireFinishedEvent(event);
  for (const line of warned) log.warn(line);
  return warned;
}

/**
 * Write the run's history and its diagram into the run dir, after killing every agent process group
 * a pgid record still names alive (a cancel, or an attempt whose worker never ended it). A record the
 * sweep cannot read or stop, or a `nodes/` it cannot list, is logged and said in the history's error,
 * and stops neither the other kills nor the write; the text is returned for the workflow's own copy.
 */
export async function recordRun(req: { runDir: string; history: RunHistory }): Promise<string | null> {
  const store = fileRunStore(req.runDir);
  const missed: string[] = [];
  const said = (what: string) => (e: unknown) => void missed.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  let keys: string[] = [];
  try {
    keys = pgidKeys(req.runDir);
  } catch (e) {
    said("nodes/ could not be listed")(e);
  }
  await Promise.all(keys.map((key) => stopOrphanedAgent(store, key).catch(said(`${key}.json`))));
  const error = missed.length === 0 ? null : `the process group sweep missed ${missed.join("; ")}`;
  if (error !== null) log.warn(error);
  const history = error === null ? req.history : { ...req.history, error: withRunError(req.history.error, error) };
  store.write("history", history);
  writeFileSync(join(req.runDir, "graph.mmd"), renderMermaid(history.graph, history));
  return error;
}
