/**
 * The graph's contracts: the one module every node's inputs and outputs, the graph definition, the
 * activity payloads, and the run history are typed in. The workflow bundle imports it, so it stays
 * pure: no I/O, no Node built-ins, only `../runtime/lib/shape.ts`.
 */

import { Shape, type ShapeIssue } from "../runtime/lib/shape.ts";

export const NODE_KINDS = ["agent", "classifier", "check", "data"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const DATA_SCHEMAS = ["text", "files", "verdict", "check", "ref", "outcome", "items"] as const;
export type DataSchema = (typeof DATA_SCHEMAS)[number];

export const CHECK_ANSWERS = ["pass", "fail"] as const;
export type CheckAnswer = (typeof CHECK_ANSWERS)[number];

export const REF_KINDS = ["ticket", "commit", "pr", "merge"] as const;
export type RefKind = (typeof REF_KINDS)[number];

export const LOOP_OUTCOMES = ["clean", "capped", "aborted"] as const;
export type LoopOutcome = (typeof LOOP_OUTCOMES)[number];

export interface TextValue {
  schema: "text";
  text: string;
}
/** Absolute paths of the files a node wrote, at least one, each under its run dir. */
export interface FilesValue {
  schema: "files";
  files: string[];
}
/** A classifier's answer and its probability. */
export interface VerdictValue {
  schema: "verdict";
  answer: string;
  p: number;
  /** How a classifier node came to it, so its setup can be tuned from real runs. */
  decision?: ClassifierDecision;
}
/** A classifier's decision record (the map's d.decision), beside the verdict's `answer` and `p`: which
 *  node, which setup, and what it was shown. */
export interface ClassifierDecision {
  node: string;
  adapter: ClassifierBinding["adapter"];
  /** A Jev or Haiku setup: its file's name and a sha256 of the file, or `inline` and a sha256 of the
   *  binding as written; `overrides` names the keys the binding set over its file's. */
  setup?: SetupId;
  model?: string;
  cutoff?: number;
  /** A sha256 of the exact state sent (Jev's state as JSON, Haiku's user message), which
   *  `decisionFile` holds beside this record. */
  stateDigest?: string;
  decisionFile?: string;
  /** The verdict is `no` and the exploration coin ran the gated reader anyway (`gateFails` opens
   *  the gate): the reader's rows label this decision. */
  explored?: true;
  /** The call failed on its last attempt: the node answered `yes` at the cut-off (fail-open), and
   *  no label is read from it. */
  error?: string;
}
export interface SetupId {
  name: string;
  sha256: string;
  overrides?: string[];
}
export interface CheckValue {
  schema: "check";
  answer: CheckAnswer;
  detail: string;
}
/** Something outside the run a data node made or read: a ticket, a pushed commit, a PR, a merge. */
export interface RefValue {
  schema: "ref";
  kind: RefKind;
  id: string;
  url?: string;
}
/** How a loop ended, written by the loop itself when its `outcome` names a data item. */
export interface OutcomeValue {
  schema: "outcome";
  answer: LoopOutcome;
}
/** The list a fan-out runs one instance per item of; an item starts once every item its `after` names finished. */
export interface ItemsValue {
  schema: "items";
  items: { id: string; after: string[] }[];
}
export type DataValue = TextValue | FilesValue | VerdictValue | CheckValue | RefValue | OutcomeValue | ItemsValue;
export type DataValues = Record<string, DataValue>;

/** A data item: `input` is handed in at the run's start (no producer node); `terminal` leaves the
 *  run (a PR, a ticket) and needs no consumer. */
export interface DataItem {
  id: string;
  schema: DataSchema;
  boundary?: "input" | "terminal";
  /** The grammar of a files item's contents, which the graph's schema service (`services.schema`)
   *  checks after the agent that wrote it. The engine reads no format itself. */
  format?: string;
}

/** The gated node runs only when classifier node `classifier` answered `answer`, when loop `loop`
 *  ended with outcome `answer` (the loop declares an `outcome` data item), when data item `on` (a
 *  verdict, check, or outcome, whoever wrote it: a deterministic rule) holds `answer`, or when any or
 *  all of a list of gates hold. */
export type Gate =
  | { classifier: string; answer: string }
  | { loop: string; answer: string }
  | { on: string; answer: string }
  | { anyOf: Gate[] }
  | { allOf: Gate[] };

export interface NodeDef {
  id: string;
  /** One plain sentence: what the node reads, what it writes, and when it runs. Every node of a shipped
   *  graph has one (`__tests__/exportGraph.test.ts`), and `exportGraph` refuses a node without it. */
  doc?: string;
  kind: NodeKind;
  /** The adapter role it binds to: an agent role, a classifier's question id, a check's name, or a
   *  data node's operation (`DATA_OPS`). */
  role: string;
  /** Data ids it needs; a missing one (its producer skipped or failed) skips the node. */
  inputs: string[];
  /** Data ids it reads when present, and runs without. */
  optionalInputs?: string[];
  outputs: string[];
  gate?: Gate;
  /** An agent that changes the repo: it works in its own worktree, started at the run tree's HEAD,
   *  so a retry's reset touches only its own work. It declares one `ref` output, which the engine
   *  fills with its worktree's head commit, and a data node whose operation merges (`merge-back`)
   *  reads that ref: its commits reach the run tree before any node that reads the merged head. */
  writes?: boolean;
  /** An output id (schema files) the engine fills with the answers to the questions this node's
   *  outputs raised, routed through the graph's question services; `[]` when it raised none. */
  answers?: string;
  /** An input id (schema text) holding the model this dispatch runs on: the runner passes it as the
   *  CLI's `--model`, over the role's binding. */
  modelFrom?: string;
  /** Gets the run's history so far (the run record) in its task. */
  readsRecord?: boolean;
  /** An agent that reads and does not write, whose failure does not fail the run (a classifier always
   *  fails open, its own way): when its last attempt fails, or an error no retry would help, or its
   *  outputs break their schema twice, it ends `done` with no outputs and the error, and a node that
   *  reads its outputs (as optional inputs only) runs without them. */
  failOpen?: true;
  /** The wall cap of one attempt, ms (the activity's `startToCloseTimeout`). */
  timeCapMs: number;
}

/**
 * A subgraph that runs again until node `until.node` (a check or classifier in the loop) answers
 * `until.answer`, or `cap` iterations ran. A `carry` data id is produced in one iteration and read in
 * the next: the edge it makes is the loop's back edge, so the body without it is acyclic, and its
 * readers list it as optional (iteration 1 has none).
 */
export interface LoopDef {
  id: string;
  nodes: string[];
  until: { node: string; answer: string };
  cap: number;
  carry?: string[];
  /** A data item (schema `outcome`) the loop writes when it ends: clean, capped, or aborted. */
  outcome?: string;
}

/**
 * A subgraph run once per item of data item `over` (schema items), in parallel, an item waiting for
 * the items its `after` names. Outside the group, an output of a group node is every instance's value
 * together: files joined in item order, a ref the last item's, a check `fail` when any instance
 * failed. A group may sit inside a loop, every one of its nodes in that loop (not its stop node): each
 * iteration runs it over that iteration's list. Groups do not nest in each other or share nodes.
 */
export interface FanOutDef {
  id: string;
  over: string;
  nodes: string[];
  /** A data item (schema `check`) the engine writes when every item has ended: pass when each item's
   *  nodes all finished (an empty list passes), fail naming the items that failed or skipped for one
   *  that did. A node gated on it runs only on a whole group. */
  status?: string;
}

/**
 * The runner's own nodes, run on an event rather than when their inputs are ready, and drawn apart:
 * - `schema`: a check run after every agent node on that node's outputs (their `format`s); a fail
 *   retries the agent once from its start, then fails it. Its result may carry questions.
 * - `route`: a check recording where each question goes (`routeQuestion`, pure, in the workflow).
 * - `resolver`: an agent that answers a question from what it can search, or says the operator must.
 * - `operator`: a data node standing for the wait on `build-graph answer`.
 * - `amend`: a writing agent run when an answer changes the brief; the engine merges its commit.
 */
export interface Services {
  schema?: string;
  route?: string;
  resolver?: string;
  operator?: string;
  amend?: string;
}

/** A pipeline's own data operation, beside the engine's `DATA_OPS`; its module (`RunConfig.pipeline`)
 *  implements it. `merges`: it merges a writer's ref into the run tree; `gated`: it is refused without
 *  a required `check` input. */
export interface OpSpec {
  output: DataSchema;
  needs: DataSchema | null;
  idempotent: boolean;
  merges?: boolean;
  gated?: true;
}

/**
 * What an amend service run changes for every node that starts after it: its output `output` becomes
 * the value of data item `replaces` (the brief), and the top-level check node `reparse` runs again on
 * it, its outputs replacing the ones it wrote first (the brief's parts, slices and claims). A reparse
 * that fails, like an amend that does not merge, fails the node whose question asked for it.
 */
export interface AmendedDef {
  output: string;
  replaces: string;
  reparse?: string;
}

export interface GraphDef {
  id: string;
  data: DataItem[];
  nodes: NodeDef[];
  loops: LoopDef[];
  fanOuts?: FanOutDef[];
  services?: Services;
  amended?: AmendedDef;
  ops?: Record<string, OpSpec>;
}

/** A node as `build-graph export` prints it: its definition, with where it sits in the graph. */
export interface ExportedNode {
  id: string;
  doc: string;
  kind: NodeKind;
  role: string;
  inputs: string[];
  optionalInputs: string[];
  outputs: string[];
  gate: Gate | null;
  writes: boolean;
  /** The time cap of one attempt, in whole minutes. */
  capMin: number | null;
  loop: string | null;
  fanOut: string | null;
  service: boolean;
  readsRecord: boolean;
  answers: string | null;
  /** A data node whose operation is not idempotent, so it gets no retry. */
  runsOnce: boolean;
}

/** A data item `item` flowing from the node that writes it to a node that reads it. */
export interface ExportedEdge {
  from: string;
  to: string;
  item: string;
  /** The reader lists `item` among its optional inputs. */
  optional: boolean;
}

/** The JSON `build-graph export <graph module>` prints, for a reader outside this package. */
export interface GraphExport {
  id: string;
  nodes: ExportedNode[];
  data: DataItem[];
  amended: AmendedDef | null;
  loops: LoopDef[];
  fanOuts: FanOutDef[];
  services: Services | null;
  edges: ExportedEdge[];
}

/**
 * A data node's operation (its role): the schema of the one output it writes, the schema one of its
 * required inputs must have (`needs`), and whether running it twice is harmless. An operation that is
 * not idempotent gets no retry: a timed-out attempt may already have filed, commented, pushed, opened, or merged.
 * `gated` operations also need a required `check` input: the gate data they are refused without.
 */
export const DATA_OPS = {
  ingest: { output: "text", needs: "text", idempotent: true },
  ticket: { output: "ref", needs: null, idempotent: false },
  comment: { output: "ref", needs: "ref", idempotent: false },
  push: { output: "ref", needs: null, idempotent: false },
  pr: { output: "ref", needs: null, idempotent: false },
  merge: { output: "ref", needs: "ref", idempotent: false, gated: true },
  /** Merge a writer's commit (its ref) into the run tree; writes the run tree's new head. Merging a
   *  commit already in the tree changes nothing, so a retry is harmless. */
  "merge-back": { output: "ref", needs: "ref", idempotent: true, merges: true },
} as const satisfies Record<string, OpSpec>;
export type DataOp = keyof typeof DATA_OPS;

export function isDataOp(v: string): v is DataOp {
  return Object.hasOwn(DATA_OPS, v);
}

/** A data node's operation spec: the engine's, else the graph's own. */
export function opSpec(graph: Pick<GraphDef, "ops">, role: string): OpSpec | undefined {
  if (isDataOp(role)) return DATA_OPS[role];
  return graph.ops !== undefined && Object.hasOwn(graph.ops, role) ? graph.ops[role] : undefined;
}

// ---- questions ----

/** What a question is about (`d.question`): who can answer it depends on it (`routeQuestion`). */
export const QUESTION_TYPES = [
  "brief",
  "public-surface",
  "design-entry",
  "persisted-shape",
  "user-visible",
  "conflict",
  "product",
  "tool",
  "blocked",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** One source checked for a question, and what it said. */
export interface Searched {
  source: string;
  said: string;
}

/** What each source said, on one line. */
export const searchedText = (searched: readonly Searched[]): string => searched.map((e) => `${e.source}: ${e.said}`).join("; ");

/** A question a node's outputs raised, with what the asker searched and what each source said. */
export interface Question {
  id: string;
  type: QuestionType;
  text: string;
  context?: string;
  recommendation?: string;
  searched: Searched[];
}

/** Where a resolver's answer is written down. The operator's own answers are `operator`, which the
 *  resolver may never claim. */
export const RESOLVER_SOURCES = ["code", "plan", "docs", "tracker", "brief"] as const;
export type AnswerSource = (typeof RESOLVER_SOURCES)[number] | "operator";

export interface Answer {
  question_id: string;
  answer: string;
  source: AnswerSource;
  by: "resolver" | "operator";
  /** What the resolver read to settle it; the operator's answers have none. */
  searched?: Searched[];
  /** The change the brief takes, when the answer changes it: the amend service applies it. */
  brief_change?: string;
}

/** The resolver's refusal: nothing it searched settles the question, so the operator must answer. */
export interface Refusal {
  needsOperator: true;
  searched: Searched[];
}

/** Where a question goes. */
export type Route = "resolver" | "operator" | "retry";

/**
 * The inputs file (`inputs.json`) a real agent runner hands the agent: its whole dispatch in a graph
 * run. `docs/graph-agents.md` is the agent-facing side of this shape.
 */
export interface InputsFile {
  role: string;
  /** 0 outside a loop, else the loop's iteration. */
  iteration: number;
  /** The fan-out item (a part, a test slice, a repo reader), or for a service the question it serves. */
  item?: string;
  worktree: string;
  /** Each data item the node reads, by data id; a files item lists absolute paths. */
  inputs: DataValues;
  /** Each output's folder, by data id. */
  outputs: Record<string, string>;
  /** The answers to this node's earlier questions, `<question id>: <answer> (source: <source>)`. */
  answers: string[];
  /** Set for the brief writer in amend mode and for the resolver. */
  question?: Question;
  answer?: Answer;
  /** Set on a writer's fresh run after its earlier commit did not merge into the run tree. */
  conflict?: WriterConflict;
}

/** A writer's commit the run tree could not merge: the commit, and the paths git left conflicted (never empty). */
export interface MergeConflict {
  commit: string;
  paths: string[];
}
/** `MergeConflict` handed to that writer's fresh run (`NodeTask.conflict`, `InputsFile.conflict`). */
export interface WriterConflict extends MergeConflict {
  /** Which fresh run this is for that node run: 1 on the first restart. */
  restart: number;
}

/** The one output schema a classifier or check node writes. */
export const VERDICT_SCHEMA_OF: Partial<Record<NodeKind, DataSchema>> = { classifier: "verdict", check: "check" };

/** The activity that runs each kind. */
export const ACTIVITY_OF = {
  agent: "agentNode",
  classifier: "classifierNode",
  check: "checkNode",
  data: "dataNode",
} as const satisfies Record<NodeKind, string>;

export const WORKFLOW_NAME = "graphWorkflow";
export const SIGNAL_ANSWER = "answer";
export const QUERY_STATUS = "status";

// ---- run configuration: which adapter each role binds to ----

export interface StubAgentBinding {
  adapter: "stub";
  /** `<fixtureDir>/<role>/<output data id>` (a file or a folder) is copied to each declared output. */
  fixtureDir: string;
  /** Ask this question (a needs-operator output) until the node holds an answer. */
  ask?: string;
  /** Attempts on which the stub hangs until cancelled, after leaving a stray file in the worktree. */
  hangOnAttempts?: number[];
  /** A module (absolute path) whose `replayAgent(binding)` runs the stub's runs instead: a mock's
   *  replay that bends the recording to a run it did not have (`mock/replay.ts`). */
  replay?: string;
}
/** `claude -p --agent <plugin>:<role>` in the node's worktree. */
export interface ClaudeAgentBinding {
  adapter: "claude";
  /** The plugin the roles belong to; without one the role names a project agent. */
  plugin?: string;
  model?: string;
  permissionMode?: string;
  /** The agent is the fan-out item, a project agent the repo names (its repo readers), not the role. */
  agentFromItem?: boolean;
}
/** `codex exec` with the role's instructions, resolved as `runtime/codexRole.ts` resolves them. */
export interface CodexAgentBinding {
  adapter: "codex";
  /** The Codex role to run when it is not the node's role (the Codex pair runs `review`). */
  role?: string;
}
export type AgentBinding = StubAgentBinding | ClaudeAgentBinding | CodexAgentBinding;

export interface StubAnswers<A> {
  adapter: "stub";
  /** By role; a list is read by iteration (1-based), its last entry repeating. */
  answers: Record<string, A | A[]>;
  default: A;
}
export type ClassifierAnswer = { answer: string; p: number };
export type StubClassifierBinding = StubAnswers<ClassifierAnswer>;
export type StubCheckBinding = StubAnswers<CheckAnswer>;

export const DIFF_SHAPES = ["production-code", "risky-hunks", "no-tests-docs-locks", "security-surface"] as const;
export type DiffShape = (typeof DIFF_SHAPES)[number];

/** One field of a classifier's state, made from a data item the node reads. */
export interface StateField {
  /** The data id of one of the node's inputs. */
  input: string;
  /** The input may be absent (one of the node's optional inputs): the field and its note are then
   *  left out of the state. A field without it fails the call when its input is absent. */
  optional?: boolean;
  /** The text before the first line this pattern (multiline) matches, trimmed: a tuned setup's cut
   *  of a longer input, applied first. */
  cutBefore?: string;
  /** Applied to the input's text next (a diff). */
  shape?: DiffShape;
  /** A longer text is sampled down to this many characters, and the note says how
   *  (`adapters/sample.ts`): a shaped diff keeps every file, a long one by its first and last hunks;
   *  any other text keeps the sections `keep` names whole and the head and tail of the others. */
  maxChars?: number;
  /** `head` keeps the first `maxChars` characters instead, and the note says `first N of M
   *  characters`: a tuned setup keeps the cut its cut-off was fitted on. */
  sample?: FieldSample;
  /** Markdown section titles (`#` or `##` headings, matched from the start of the title, any case)
   *  kept whole when the text is sampled. */
  keep?: string[];
  /** A second state field beside this one: `text`, plus how the input was sampled when it was. */
  note?: { field: string; text: string };
}

export const FIELD_SAMPLES = ["whole", "head"] as const;
export type FieldSample = (typeof FIELD_SAMPLES)[number];

/** How a Jev setup's answers make p: their mean, or for a question of the form "any of these" the
 *  largest one. */
export const COMBINES = ["mean", "max"] as const;
export type Combine = (typeof COMBINES)[number];

/** A code-side feature: `weight` is added to p when `pattern` (multiline) matches the input's text. */
export interface PatternFeature {
  input: string;
  pattern: string;
  weight: number;
}

export type JevQuestion =
  | { type: "noul"; instructions?: string; criteria?: { true?: string; false?: string } }
  | { type: "score"; instructions?: string; criteria: string[] };

/** Where a setup's cut-off came from: `initial` waits for tuning and is explored in a real run,
 *  `tuned` was fitted on labelled runs, `judgment` was set by a cost judgment its report names and is
 *  never explored (its reader writes no rows to label it). */
export const SETUP_STATUSES = ["initial", "tuned", "judgment"] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

/**
 * A Jev classifier: its state, its questions, and how they combine. p is the questions' `combine`
 * (each a noul as it is, a score divided by its top level) plus the features; the answer is `yes`
 * when p reaches `cutoff`.
 */
export interface JevBinding {
  adapter: "jev";
  setup: SetupId;
  /** The setup's `status`, from its file or an inline binding's own key; only `initial` is explored. */
  status?: SetupStatus;
  /** Pinned: an alias moves when a release ships, and a cut-off is tuned for one model. */
  model: string;
  fields: Record<string, StateField>;
  questions: Record<string, JevQuestion>;
  combine: Combine;
  features: PatternFeature[];
  cutoff: number;
}
/** `claude -p` on a Haiku model with its own system prompt and none of the user's settings, a JSON
 *  schema for `p_yes`, and the same state fields as Jev's. */
export interface HaikuBinding {
  adapter: "haiku";
  setup: SetupId;
  status?: SetupStatus;
  model: string;
  fields: Record<string, StateField>;
  /** The system prompt: what to answer, the question, and its rules. */
  system: string;
  /** The user message: `{{name}}` is replaced by the state field `name` (a field or a note). */
  prompt: string;
  /** How many calls are made at once; p is the mean of their `p_yes`. */
  calls: number;
  cutoff: number;
}
export type ClassifierBinding = StubClassifierBinding | JevBinding | HaikuBinding;

/** A named step of the target repo's `.claude/build-steps.toml`, run in the run's worktree. */
export interface ShellCheckBinding {
  adapter: "shell";
}
/** A check run by the run's pipeline module (`RunConfig.pipeline`). */
export interface PipelineCheckBinding {
  adapter: "pipeline";
}
export type CheckBinding = StubCheckBinding | ShellCheckBinding | PipelineCheckBinding;

/** A file-backed fake under `dir` (default: the run dir's `tracker/` or `forge/`). */
export interface FileBinding {
  adapter: "file";
  dir?: string;
}
/** Linear through its GraphQL API, key from `LINEAR_API_KEY`; team and labels from the repo's notes. */
export interface LinearBinding {
  adapter: "linear";
}
export type TrackerBinding = FileBinding | LinearBinding;
/** The repo's `push`, `pr_open` and `merge` steps (`runtime/steps.ts`'s fallbacks: `git push`, `gh pr
 *  create`, `gh pr ready` and `gh pr merge`). */
export interface GithubBinding {
  adapter: "github";
}
export type ForgeBinding = FileBinding | GithubBinding;

export interface RoleBindings {
  agent?: AgentBinding;
  classifier?: ClassifierBinding;
  check?: CheckBinding;
}

export interface RunConfig {
  /** The module implementing the graph's own data operations and its pipeline checks (absolute path). */
  pipeline?: string;
  agent: AgentBinding;
  /** The classifiers' default. A config without one binds every classifier role under `roles`, so
   *  no classifier answers by a default it was not set up for; a run is refused at its start when a
   *  classifier node has no binding. */
  classifier?: ClassifierBinding;
  check: CheckBinding;
  tracker: TrackerBinding;
  forge: ForgeBinding;
  /** A role's own bindings, over the kind's default above. */
  roles: Record<string, RoleBindings>;
}

/** The binding for `role` of `kind`: the role's own, else the kind's default (a classifier may have
 *  neither). */
export function bindingFor<K extends keyof RoleBindings>(config: RunConfig, kind: K, role: string): K extends "classifier" ? ClassifierBinding | undefined : NonNullable<RoleBindings[K]> {
  const own = Object.hasOwn(config.roles, role) ? config.roles[role]?.[kind] : undefined;
  return (own ?? config[kind]) as K extends "classifier" ? ClassifierBinding | undefined : NonNullable<RoleBindings[K]>;
}

/** A run whose every agent binding is a stub replays recorded outputs: a mock. Any other is real. */
export type RunKind = "real" | "mock";
export function runKindOf(config: Pick<RunConfig, "agent" | "roles">): RunKind {
  const agents = [config.agent, ...Object.values(config.roles).map((r) => r.agent)];
  return agents.every((b) => b === undefined || b.adapter === "stub") ? "mock" : "real";
}

// ---- activity payloads ----

/** What prepareRun made for the run. */
export interface RunPlace {
  runDir: string;
  worktree: string;
  branch: string;
  baseSha: string;
}

export interface WorkflowInput {
  runId: string;
  /** The repo the run works on; the run gets its own worktree of it. */
  repo: string;
  runDir: string;
  graph: GraphDef;
  /** A value for each of the graph's `boundary: "input"` items. */
  inputs: DataValues;
  config: RunConfig;
  /** The consumer command line for the run's `blocked` and `finished` events, taken from
   *  `BUILD_EVENT_CMD` of the process that ran `build-graph start`; absent or blank, the run fires no event. */
  events?: string;
}

export interface NodeTask {
  runId: string;
  node: NodeDef;
  /** 0 outside a loop; 1.. inside one. */
  iteration: number;
  /** The fan-out item this run is for. */
  instance?: string;
  inputs: DataValues;
  /** The operator's answers to this node's questions, oldest first. */
  answers: string[];
  place: RunPlace;
  config: RunConfig;
  /** The graph's data items' formats, by id (the schema service reads them). */
  formats?: Record<string, string>;
  /** The schema of each of the node's outputs. */
  schemas?: Record<string, DataSchema>;
  /** Runs of this node run so far (a schema retry, a fresh run after a merge conflict): >0 resets a
   *  writer's tree to its recorded start, unless `fresh`. */
  rerun?: number;
  /** Set on every pass of a writer's fresh run after its merge conflicted. */
  conflict?: WriterConflict;
  /** Set on that fresh run's first pass only: the worktree starts at the run tree's head and records it. */
  fresh?: true;
  /** For `readsRecord` nodes: the run so far. */
  record?: RunHistory;
  /** For the schema service: the node whose outputs (`inputs`) it checks, and that node's inputs. */
  subject?: { node: string; iteration: number; instance?: string };
  subjectInputs?: DataValues;
  /** For the resolver and amend services: the question, and (amend) its answer. */
  question?: Question;
  answer?: Answer;
}

export type NodeOutcome =
  /** `answer`: the resolver service's parsed answer, or its refusal. `failedOpen`: the node failed open
   *  (`opensOnFailure`) with this error; a classifier's outputs hold its fail-open verdict, any other's
   *  are empty. */
  | { status: "done"; outputs: DataValues; attempt: number; questions?: Question[]; answer?: Answer | Refusal; failedOpen?: string }
  | { status: "needs-operator"; question: string; reason?: string; attempt: number }
  /** The operator ended the run from this node (a data operation's own call): it ends `abandoned`,
   *  by the cancel path, with no cleanup. */
  | { status: "abandon"; reason: string; attempt: number }
  /** A merge-back whose merge conflicted: the run tree is as it was; the workflow re-runs the writer. */
  | { status: "merge-conflict"; commit: string; paths: string[]; attempt: number };

// ---- run history ----

export type NodeStatus = "running" | "waiting" | "done" | "skipped" | "failed" | "cancelled";
export interface NodeRun {
  node: string;
  iteration: number;
  /** The fan-out item, or for a service node the run it serves (`<node>#<iteration>@<instance>`). */
  instance?: string;
  status: NodeStatus;
  /** Why it was skipped, failed or cancelled; the question it waits on. */
  reason?: string;
  /** The attempt that finished it. */
  attempt?: number;
  /** A finished classifier's or check's answer. */
  answer?: string;
  /** A finished classifier's p and the cut-off it was decided at. */
  p?: number;
  cutoff?: number;
  /** The input ids the run was handed (the ones present), so a report can say what reached it. */
  inputs?: string[];
  /** A finished classifier's decision was explored (`ClassifierDecision.explored`); the node failed
   *  open with this error (a classifier's `ClassifierDecision.error`, or a `failOpen` agent's). */
  explored?: true;
  error?: string;
  /** When the workflow first started it (ISO), and when it ended done, failed or cancelled; a skipped
   *  node has neither. Each attempt's own times are in its attempt record (`AttemptRecord`). */
  startedAt?: string;
  endedAt?: string;
  /** For a writer run again after its commit's merge conflicted: which fresh run this row is from
   *  (`WriterConflict.restart`); absent on a run that never restarted. */
  restarts?: number;
}
export interface LoopRun {
  loop: string;
  iterations: number;
  outcome?: LoopOutcome;
}
/** One run of a fan-out over its list: once at the top level (iteration 0), or once in each iteration
 *  of the loop it sits in. */
export interface FanOutRun {
  fanOut: string;
  iteration: number;
  items: string[];
}
/** One question and what became of it. */
export interface QuestionRun {
  from: { node: string; iteration: number; instance?: string };
  question: Question;
  route: Route;
  answer?: Answer;
}
/** Where a run is: going, waiting on the operator, or ended (`ENDED_PHASES`): done, failed, cancelled
 *  (`build-graph cancel`), or abandoned (the operator's reply to a node that offered it). */
export const RUN_PHASES = ["running", "waiting", "done", "failed", "cancelled", "abandoned"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export const ENDED_PHASES: readonly RunPhase[] = ["done", "failed", "cancelled", "abandoned"];
export const isEnded = (phase: RunPhase): boolean => ENDED_PHASES.includes(phase);

export interface RunHistory {
  runId: string;
  graph: GraphDef;
  /** Mock (every agent a stub) or real (`runKindOf`): `stats` keeps them apart. */
  runKind?: RunKind;
  phase: RunPhase;
  nodes: NodeRun[];
  loops: LoopRun[];
  fanOuts?: FanOutRun[];
  questions?: QuestionRun[];
  /** The open questions, oldest first: the next `answer` signal goes to the first. */
  asking: { node: string; iteration: number; question: string }[];
  /** Data values produced so far, by data id (a loop's last iteration's value). */
  data: DataValues;
  /** Why the run failed outside any node (an invalid graph or inputs, the run's setup or record), and
   *  what its end could not do: a `finished` event that did not reach the launcher, a process group the
   *  sweep could not stop. */
  error?: string;
}

// ---- attempt records ----

export const ATTEMPT_OUTCOMES = ["done", "needs-operator", "merge-conflict", "failed", "aborted"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** An agent CLI's token counts: `input` excludes what was read from or written to the cache. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One attempt of one node run, at `nodes/<node>/<iteration>[/<item>]/rerun-<r>/attempt-<n>.json`:
 * written when the attempt starts and again when it ends. A record with no `endedAt` is an attempt
 * that never ended here (its worker died). An agent's record also holds what its CLI reported, null
 * when it reported nothing (a stub, a kill before the CLI printed): `costUsd` is null for Codex,
 * which reports no price.
 */
export interface AttemptRecord {
  node: string;
  iteration: number;
  instance?: string;
  rerun: number;
  attempt: number;
  startedAt: string;
  endedAt?: string;
  outcome?: AttemptOutcome;
  model?: string | null;
  tokens?: TokenCounts | null;
  costUsd?: number | null;
  /** The merge conflict the attempt is about: on a `merge-conflict` outcome, the commit the merge
   *  could not take and the paths; on a writer's fresh run, the conflict it was handed, with
   *  `restart`, which fresh run it is. */
  conflict?: MergeConflict & { restart?: number };
}

/** Validate an attempt record. Throws `ContractError` naming every bad path. */
export function parseAttemptRecord(raw: unknown, label = "attempt"): AttemptRecord {
  const s = new Shape(label);
  const o = s.obj(raw, "(root)") ?? {};
  const num = (v: unknown, path: string): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : (s.bad(path, "a number of at least 0"), 0));
  const nullable = <T>(v: unknown, read: (v: unknown) => T): T | null | undefined => (v === undefined ? undefined : v === null ? null : read(v));
  const instance = s.optStr(o, "instance", "(root)");
  const endedAt = s.optStr(o, "endedAt", "(root)");
  const tokens = (v: unknown): TokenCounts => {
    const t = s.obj(v, "tokens") ?? {};
    return { input: num(t.input, "tokens.input"), output: num(t.output, "tokens.output"), cacheRead: num(t.cacheRead, "tokens.cacheRead"), cacheWrite: num(t.cacheWrite, "tokens.cacheWrite") };
  };
  const model = nullable(o.model, (v) => s.str(v, "model"));
  const counts = nullable(o.tokens, tokens);
  const costUsd = nullable(o.costUsd, (v) => num(v, "costUsd"));
  const conflict = (v: unknown): MergeConflict & { restart?: number } => {
    const c = s.obj(v, "conflict") ?? {};
    const paths = Array.isArray(c.paths) && c.paths.length > 0 ? s.strs(c.paths, "conflict.paths") : (s.bad("conflict.paths", "a non-empty list of strings"), []);
    const restart = c.restart === undefined || (Number.isInteger(c.restart) && (c.restart as number) >= 1) ? (c.restart as number | undefined) : (s.bad("conflict.restart", "an integer of at least 1"), undefined);
    return { commit: s.str(c.commit, "conflict.commit"), paths, ...(restart === undefined ? {} : { restart }) };
  };
  const out: AttemptRecord = {
    node: s.str(o.node, "node"),
    iteration: s.int(o.iteration, "iteration"),
    ...(instance === undefined ? {} : { instance }),
    rerun: s.int(o.rerun, "rerun"),
    attempt: s.int(o.attempt, "attempt"),
    startedAt: s.str(o.startedAt, "startedAt"),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(o.outcome === undefined ? {} : { outcome: s.oneOf(o.outcome, ATTEMPT_OUTCOMES, "outcome") }),
    ...(model === undefined ? {} : { model }),
    ...(counts === undefined ? {} : { tokens: counts }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(o.conflict === undefined ? {} : { conflict: conflict(o.conflict) }),
  };
  const issues = s.issues();
  if (issues.length > 0) throw new ContractError(issues);
  return out;
}

// ---- errors ----

/** The failure types never retried: an activity's thrown error reaches Temporal under its `name`. */
export const CONTRACT_ERROR_TYPE = "ContractError";
export const RUN_ERROR_TYPE = "RunError";
export const NON_RETRYABLE_ERROR_TYPES = [CONTRACT_ERROR_TYPE, RUN_ERROR_TYPE];

/** A node wrote a value its declared schema does not allow, or its adapter broke its contract. */
export class ContractError extends Error {
  readonly issues: readonly ShapeIssue[];
  constructor(issues: readonly ShapeIssue[]) {
    super(issues.map((i) => i.message).join("\n"));
    this.name = CONTRACT_ERROR_TYPE;
    this.issues = issues;
  }
}

/** The run cannot go on and a retry would not help: a repo that is not a git repo, a refused event. */
export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = RUN_ERROR_TYPE;
  }
}

// ---- data value validation ----

/** Whether `path` is an absolute path inside `dir` with no `.` or `..` segment. */
export function isPathUnder(path: string, dir: string): boolean {
  const root = dir.replace(/\/+$/, "");
  if (!path.startsWith(`${root}/`)) return false;
  return path
    .slice(root.length + 1)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

function parseDecision(s: Shape, raw: unknown, runDir: string | undefined): ClassifierDecision {
  const o = s.obj(raw, "decision") ?? {};
  const num = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : (s.bad(`decision.${k}`, "a number"), 0));
  const setupRaw = o.setup === undefined ? undefined : s.obj(o.setup, "decision.setup") ?? {};
  const setup =
    setupRaw === undefined
      ? undefined
      : {
          name: s.str(setupRaw.name, "decision.setup.name"),
          sha256: s.str(setupRaw.sha256, "decision.setup.sha256"),
          ...(setupRaw.overrides === undefined ? {} : { overrides: s.strs(setupRaw.overrides, "decision.setup.overrides") }),
        };
  const model = s.optStr(o, "model", "decision");
  const stateDigest = s.optStr(o, "stateDigest", "decision");
  const decisionFile = s.optStr(o, "decisionFile", "decision");
  if (decisionFile !== undefined && runDir !== undefined && !isPathUnder(decisionFile, runDir)) s.bad("decision.decisionFile", `a path under the run dir ${runDir}, got ${decisionFile}`);
  if (o.explored !== undefined && o.explored !== true) s.bad("decision.explored", "true, or no key");
  const error = s.optStr(o, "error", "decision");
  return {
    node: s.str(o.node, "decision.node"),
    adapter: s.oneOf(o.adapter, ["stub", "jev", "haiku"] as const, "decision.adapter"),
    ...(setup === undefined ? {} : { setup }),
    ...(model === undefined ? {} : { model }),
    ...(o.cutoff === undefined ? {} : { cutoff: num("cutoff") }),
    ...(stateDigest === undefined ? {} : { stateDigest }),
    ...(decisionFile === undefined ? {} : { decisionFile }),
    ...(o.explored === true ? { explored: true as const } : {}),
    ...(error === undefined ? {} : { error }),
  };
}

/** Validate `raw` as a value of data item `id` with schema `schema`; with `runDir`, every file must lie
 *  under it. Throws `ContractError` naming every bad path. */
export function parseDataValue(raw: unknown, schema: DataSchema, id: string, runDir?: string): DataValue {
  const s = new Shape(`data ${id}`);
  const o = s.obj(raw, "(root)") ?? {};
  if (o.schema !== schema) s.bad("schema", schema);
  let out: DataValue;
  switch (schema) {
    case "text":
      out = { schema, text: s.str(o.text, "text") };
      break;
    case "files": {
      const files = s.strs(o.files, "files");
      if (Array.isArray(o.files) && files.length === 0) s.bad("files", "at least one file");
      if (runDir !== undefined) {
        files.forEach((f, i) => {
          if (!isPathUnder(f, runDir)) s.bad(`files[${i}]`, `a path under the run dir ${runDir}, got ${f}`);
        });
      }
      out = { schema, files };
      break;
    }
    case "verdict": {
      const p = typeof o.p === "number" && o.p >= 0 && o.p <= 1 ? o.p : (s.bad("p", "a number in [0, 1]"), 0);
      const decision = o.decision === undefined ? undefined : parseDecision(s, o.decision, runDir);
      out = { schema, answer: s.str(o.answer, "answer"), p, ...(decision === undefined ? {} : { decision }) };
      break;
    }
    case "check":
      out = { schema, answer: s.oneOf(o.answer, CHECK_ANSWERS, "answer"), detail: s.str(o.detail, "detail") };
      break;
    case "ref": {
      const url = s.optStr(o, "url", "(root)");
      out = { schema, kind: s.oneOf(o.kind, REF_KINDS, "kind"), id: s.str(o.id, "id"), ...(url === undefined ? {} : { url }) };
      break;
    }
    case "outcome":
      out = { schema, answer: s.oneOf(o.answer, LOOP_OUTCOMES, "answer") };
      break;
    case "items": {
      const items = s.arr(o.items, "items").map((x, i) => {
        const it = s.obj(x, `items[${i}]`) ?? {};
        const id = s.str(it.id, `items[${i}].id`);
        if (id !== "" && !/^[A-Za-z0-9][\w.-]*$/.test(id)) s.bad(`items[${i}].id`, "a plain id");
        return { id, after: it.after === undefined ? [] : s.strs(it.after, `items[${i}].after`) };
      });
      out = { schema, items };
      break;
    }
  }
  const issues = s.issues();
  if (issues.length > 0) throw new ContractError(issues);
  return out;
}

/** Each declared output of `node`, validated against `graph`'s schema for it (files under `runDir`, when
 *  given); an undeclared or missing output throws. */
export function parseOutputs(graph: GraphDef, node: NodeDef, raw: Record<string, unknown>, runDir?: string): DataValues {
  const issues: ShapeIssue[] = [];
  const out: DataValues = {};
  for (const key of Object.keys(raw)) {
    if (!node.outputs.includes(key)) issues.push({ message: `node ${node.id}: wrote ${key}, which it does not declare` });
  }
  for (const id of node.outputs) {
    const item = graph.data.find((d) => d.id === id);
    if (item === undefined) {
      issues.push({ message: `node ${node.id}: output ${id} is not a data item` });
      continue;
    }
    if (!Object.hasOwn(raw, id)) {
      issues.push({ message: `node ${node.id}: did not write ${id}` });
      continue;
    }
    try {
      out[id] = parseDataValue(raw[id], item.schema, id, runDir);
    } catch (e) {
      if (!(e instanceof ContractError)) throw e;
      issues.push(...e.issues);
    }
  }
  if (issues.length > 0) throw new ContractError(issues);
  return out;
}

// ---- question and answer files ----

/** A `questions.json` an agent writes beside its outputs: a list of questions. Throws `ContractError`. */
export function parseQuestions(raw: unknown, label = "questions"): Question[] {
  const s = new Shape(label);
  const list = s.arr(raw, "(root)").map((x, i): Question => {
    const o = s.obj(x, `[${i}]`) ?? {};
    const context = s.optStr(o, "context", `[${i}]`);
    const recommendation = s.optStr(o, "recommendation", `[${i}]`);
    return {
      id: s.str(o.id, `[${i}].id`),
      type: s.oneOf(o.type, QUESTION_TYPES, `[${i}].type`),
      text: s.str(o.text, `[${i}].text`),
      ...(context === undefined ? {} : { context }),
      ...(recommendation === undefined ? {} : { recommendation }),
      searched: o.searched === undefined ? [] : parseSearched(s, o.searched, `[${i}].searched`),
    };
  });
  const issues = s.issues();
  if (issues.length > 0) throw new ContractError(issues);
  return list;
}

function parseSearched(s: Shape, raw: unknown, path: string): Searched[] {
  return s.arr(raw, path).map((y, j) => {
    const e = s.obj(y, `${path}[${j}]`) ?? {};
    return { source: s.str(e.source, `${path}[${j}].source`), said: s.str(e.said, `${path}[${j}].said`) };
  });
}

/**
 * The resolver's `answer.json`: `{ answer, source, searched, brief_change? }`, or `{ "needs_operator":
 * true, searched }`. Either way `searched` names at least one source: an answer says what settled it,
 * a refusal what it read before refusing. The resolver never answers as the operator.
 */
export function parseAnswerFile(raw: unknown, question: Question): Answer | Refusal {
  const s = new Shape("answer");
  const o = s.obj(raw, "(root)") ?? {};
  const searched = parseSearched(s, o.searched, "searched");
  if (Array.isArray(o.searched) && searched.length === 0) s.bad("searched", "at least one source checked");
  let out: Answer | Refusal;
  if (o.needs_operator === true) out = { needsOperator: true, searched };
  else {
    const brief = s.optStr(o, "brief_change", "(root)");
    out = {
      question_id: question.id,
      answer: s.str(o.answer, "answer"),
      source: s.oneOf(o.source, RESOLVER_SOURCES, "source"),
      by: "resolver",
      searched,
      ...(brief === undefined || brief === "" ? {} : { brief_change: brief }),
    };
  }
  const issues = s.issues();
  if (issues.length > 0) throw new ContractError(issues);
  return out;
}
