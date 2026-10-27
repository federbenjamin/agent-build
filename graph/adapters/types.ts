/**
 * The seams a node kind dispatches through. The run config binds each role to an implementation
 * (`bind.ts`): the stubs and file-backed fakes, the real adapters, or a pipeline module's own checks
 * and data operations (`Pipeline`).
 */

import type {
  Answer,
  CheckAnswer,
  ClassifierAnswer,
  DataValue,
  DataValues,
  Question,
  RefValue,
  RunHistory,
  RunPlace,
  WriterConflict,
} from "../contracts.ts";

export interface AgentRequest {
  /** The run and the node it runs as: with `iteration` and `instance`, its session's name
   *  (`sessionName`), which a peer messages it at. */
  runId: string;
  nodeId: string;
  role: string;
  inputs: DataValues;
  /** The operator's answers to this node's earlier questions, oldest first. */
  answers: string[];
  /** The data ids to write, each into `<outDir>/<id>/`. */
  outputs: string[];
  outDir: string;
  /** The agent's own worktree, its working directory: nothing it writes reaches the run's tree (a
   *  writer's commit reaches it through a merge-back). */
  worktree: string;
  /** Whether the node changes the repo; a reader gets no tools that edit its worktree. */
  writes: boolean;
  /** 1 for the first attempt, 2 for the retry. */
  attempt: number;
  /** 0 outside a loop, else the loop's iteration. */
  iteration: number;
  /** The fan-out item, or for a service the run and question it serves. */
  instance?: string;
  /** The model this dispatch runs on (the node's `modelFrom` input), over the role's binding. */
  model?: string;
  /** A writer's ref output: the runner commits its work in `worktree`, and the engine reads the head. */
  commits?: string;
  /** The resolver's and the amend service's question, and the amend service's answer. */
  question?: Question;
  answer?: Answer;
  /** A writer's fresh run after its earlier commit did not merge into the run tree. */
  conflict?: WriterConflict;
  signal: AbortSignal;
  /** Called with the pid of the CLI process the runner spawns (a runner with no process never calls it). */
  onSpawn?: (pid: number) => void;
}

export type AgentResult =
  /** Absolute paths written for each declared output. */
  | { status: "done"; files: Record<string, string[]> }
  | { status: "needs-operator"; question: string };

export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResult>;
}

export interface ClassifyRequest {
  /** The question id: the classifier node's role. */
  question: string;
  state: DataValues;
  /** 0 outside a loop, else the loop's iteration. */
  iteration: number;
  signal: AbortSignal;
}

/** A classifier's answer and, for one that calls a model, the exact state it sent: Jev's state as
 *  JSON, Haiku's user message. */
export type ClassifierResult = ClassifierAnswer & { sent?: string };

export interface Classifier {
  classify(req: ClassifyRequest): Promise<ClassifierResult>;
}

export interface CheckRequest {
  role: string;
  inputs: DataValues;
  worktree: string;
  /** The commit the run started from: a check's command is read there, not from the worktree an agent edited. */
  baseSha: string;
  iteration: number;
  signal: AbortSignal;
  /** The ids after the check's answer it must also write (files under `<outDir>/<id>/`, or checks). */
  outputs: string[];
  outDir: string;
  place: RunPlace;
  instance?: string;
  /** The graph's files items' formats, by id. */
  formats: Record<string, string>;
  /** The run so far, for a check that reads the run record. */
  record?: RunHistory;
  /** For the schema service: the node whose outputs (`inputs`) it checks, and that node's inputs. */
  subject?: { node: string; iteration: number; instance?: string };
  subjectInputs?: DataValues;
  /** The node this check runs as (a check role can stand at several positions). */
  nodeId: string;
}

export interface CheckResult {
  answer: CheckAnswer;
  detail: string;
  /** A value for each id in `outputs`. */
  outputs?: Record<string, DataValue>;
  /** Questions the checked outputs raise (the schema service). */
  questions?: Question[];
}

export interface CheckRunner {
  run(req: CheckRequest): Promise<CheckResult>;
}

/** The run store as files: JSON records by key, and folders a node writes into. */
export interface RunStore {
  readonly dir: string;
  /** The absolute path of `key` (a `/`-separated relative path) in the store. */
  path(key: string): string;
  write(key: string, value: unknown): void;
  /** The value written at `key`, or undefined when there is none. */
  read(key: string): unknown;
}

export interface Ticket {
  id: string;
  title: string;
  body: string;
}

/** The tracker; a call that writes runs once (a retry would file or comment twice), except a comment
 *  given a `key`, which is safe to retry. */
export interface Tracker {
  ingest(ref: string, signal: AbortSignal): Promise<Ticket>;
  file(ticket: { title: string; body: string }, signal: AbortSignal): Promise<RefValue>;
  /** A comment on the ticket `ref` names; resolves to a ref to that ticket, its url the comment's.
   *  With a `key`, a comment already on the ticket whose body starts with it is reused and none is
   *  posted: a retry of the caller leaves one comment. */
  comment(ref: string, body: string, signal: AbortSignal, key?: string): Promise<RefValue>;
}

/** The forge, working in the run's worktree. */
export interface Forge {
  push(req: { worktree: string; branch: string; signal: AbortSignal }): Promise<RefValue>;
  /** `riskClass`: the brief's risk class (`R1`), for a step that reads it. */
  openPr(req: { worktree: string; branch: string; title: string; body: string; draft?: boolean; riskClass?: string; signal: AbortSignal }): Promise<RefValue>;
  /** Merge what it is asked to: whether the PR may merge is its caller's to decide (the `merge` data
   *  op refuses a red gate). `branch` and `riskClass`: the PR's branch and the brief's class, for a
   *  merge step that reads them. */
  merge(req: { worktree: string; pr: string; branch?: string; riskClass?: string; signal: AbortSignal }): Promise<RefValue>;
  /** The PR's state as the forge reads it now (`MERGED`, `CLOSED`, `OPEN`). */
  prState(req: { worktree: string; pr: string; signal: AbortSignal }): Promise<string>;
}

/** What a pipeline's data operation is handed. */
export interface OpContext {
  runId: string;
  nodeId: string;
  role: string;
  inputs: DataValues;
  /** The ids after the first it must also write. */
  outputs: string[];
  outDir: string;
  place: RunPlace;
  iteration: number;
  instance?: string;
  /** The operator's replies to the questions this node asked (`needs-operator`), oldest first. */
  answers: string[];
  tracker: Tracker;
  forge: Forge;
  /** Aborts when the attempt is cancelled or reaches its time cap. */
  signal: AbortSignal;
  /** Run `fn` holding the run tree's lock. */
  withRunTree<T>(fn: () => Promise<T> | T): Promise<T>;
  /** The run so far, for an operation that reads the run record. */
  record?: RunHistory;
}

export type OpResult =
  /** A value for the node's first output and each id in `outputs`. */
  | { status: "done"; outputs: Record<string, DataValue>; questions?: Question[] }
  /** `reason`: what the node's record says while it waits, when that holds more than may leave the
   *  worker (a step's output); the question alone goes out in the `blocked` event. */
  | { status: "needs-operator"; question: string; reason?: string }
  /** The operator's reply ended the run: it ends abandoned, as a cancel does, with no cleanup. */
  | { status: "abandon"; reason: string };

/** A pipeline module (`RunConfig.pipeline`): its checks and data operations, by role. */
export interface Pipeline {
  checks: Record<string, (req: CheckRequest) => Promise<CheckResult>>;
  ops: Record<string, (ctx: OpContext) => Promise<OpResult>>;
}
