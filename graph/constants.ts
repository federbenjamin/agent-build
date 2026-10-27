/** The graph runner's numbers and names. Pure: the workflow bundle imports it. */

export const TASK_QUEUE = "agent-build-graph";
export const DEFAULT_TEMPORAL_ADDRESS = "localhost:7233";

/** How often a running activity heartbeats, and how long the server waits for one before it calls
 *  the worker dead. The heartbeat only catches a dead worker; a hung CLI under a live worker is
 *  caught by the node's own time cap. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;

/** A node runs at most twice: the first attempt and one retry. */
export const NODE_MAX_ATTEMPTS = 2;
export const RETRY_INITIAL_INTERVAL_MS = 1_000;

/** How many fresh runs a writer gets when its commit's merge into the run tree conflicts, before the
 *  merge node fails. A fresh run conflicts again only when another merge landed meanwhile, so one
 *  writer's restarts are bounded by the items merged beside it: two side-by-side items need at most
 *  one, three at most two. This stops a pile-up of four or more on one file, and a writer whose new
 *  commit does not descend from the head it was given. */
export const WRITER_RESTART_CAP = 2;

/** The cap on the run's own bookkeeping activities (prepare, notify, record). */
export const SERVICE_ACTIVITY_CAP_MS = 60_000;

/** How long `build-graph dev` waits for a dev server it started to accept connections. */
export const DEV_SERVER_READY_MS = 30_000;
export const DEV_SERVER_POLL_MS = 250;

/** The identity on the snapshot commits a writing agent's worktree gets at each attempt's start. */
export const SNAPSHOT_AUTHOR = "build-graph";
export const SNAPSHOT_EMAIL = "build-graph@localhost";

/** `build-graph dev`: how long one probe of the server waits, and the UI's port above the server's. */
export const DEV_CONNECT_TIMEOUT_MS = 1_000;
export const DEV_UI_PORT_OFFSET = 1_000;

/** The questions' routing: the reply that applies a brief change the resolver proposed (trimmed, any
 *  case), and the source a blocked asker's rerun is told its own question came from. */
export const OPERATOR_APPROVE = "approve";
/** The replies to the build graph's merge wait (D-merge-pr): run the repo's merge step, or end the run
 *  abandoned (trimmed, any case). */
export const OPERATOR_MERGE = "merge";
export const OPERATOR_ABANDON = "abandon";
export const BLOCKED_SOURCE = "your last run";

/** What a classifier says: its answer is `CLASSIFIER_YES` when its p reaches the node's cut-off. */
export const CLASSIFIER_YES = "yes";
export const CLASSIFIER_NO = "no";
/** Every classifier's answers, whatever adapter it binds: a gate or loop waiting on another word
 *  would never fire. */
export const CLASSIFIER_ANSWERS: readonly string[] = [CLASSIFIER_YES, CLASSIFIER_NO];
/** The share of an `initial` setup's `no` verdicts in a real run whose gated reader runs anyway, so
 *  the skipped side of the gate earns labels too. */
export const EXPLORE_RATE = 0.3;

/** A child process: how long it gets between SIGTERM and SIGKILL when cancelled, how often the
 *  group is polled for survivors, and how much of each output stream is kept (the tail). */
export const PROCESS_KILL_GRACE_MS = 5_000;
export const PROCESS_KILL_POLL_MS = 25;
/** After the SIGKILL: how long to wait for the group to be reaped before giving up. */
export const PROCESS_KILL_WAIT_MS = 2_000;
export const PROCESS_OUTPUT_KEEP_CHARS = 1024 * 1024;
/** The signals that shut the worker down, which cancels its running activities and so kills their
 *  agents' process groups. The SDK's own default leaves out SIGHUP, which a closed terminal window
 *  sends. */
export const WORKER_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGUSR2", "SIGHUP"];
/** How long one process group's kill can take: the grace period, then the wait after the SIGKILL. */
export const PROCESS_TEARDOWN_BUDGET_MS = PROCESS_KILL_GRACE_MS + PROCESS_KILL_WAIT_MS;
/** A node's time cap is split so its processes are gone, and its attempt has failed here, before the
 *  server's own timeout: the local abort fires this long (at most half the cap) before the cap, twice
 *  the teardown budget, since a node can have a group to kill and the activity to wind down after it. */
export const CAP_ABORT_LEAD_MS = 2 * PROCESS_TEARDOWN_BUDGET_MS;
/** The adapters' own API keys: no child process (an agent, a check, `git`, `gh`) inherits them. */
export const ADAPTER_SECRET_ENV = ["TYPESAFE_API_KEY", "LINEAR_API_KEY"];

/** A check's recorded detail keeps this much of the end of the step's output. */
export const CHECK_DETAIL_CHARS = 4_000;

/** Claude Code as an agent: `git push` and `gh pr` are denied by flag, because the plugin's no-push
 *  guard passes a `claude -p` main session (it matches subagents only). A rule matches the command
 *  text, so each also covers the forms with options before the subcommand (`git -C <dir> push`,
 *  `git -c k=v push`, `gh -R <repo> pr create`); measured on Claude Code 2.1.307. `gh api` and a
 *  push through a script are not covered. The permission mode lets the agent write its outputs
 *  unattended. */
export const CLAUDE_DISALLOWED_TOOLS = [
  "Bash(git push:*)",
  "Bash(git * push:*)",
  "Bash(git -C * push*)",
  "Bash(git --* push*)",
  "Bash(gh pr:*)",
  "Bash(gh * pr:*)",
  "Bash(gh -R * pr*)",
  "Bash(gh --* pr*)",
];
export const CLAUDE_DEFAULT_PERMISSION_MODE = "acceptEdits";

/** What keeps an agent process from pushing or opening a PR, below the tool layer: a push URL no
 *  transport handles on every remote of the agent's own worktree, no forge token in its environment,
 *  and a `gh` config folder that is empty (so no stored login). */
export const UNUSABLE_PUSH_URL = "build-graph-agents-cannot-push://blocked";
export const AGENT_STRIPPED_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
export const AGENT_GH_CONFIG_DIR = "gh-config";

/** The CLIs' own result files, in the node's attempt folder. */
export const CLAUDE_RESULT_FILE = "claude.json";
/** What a Codex attempt reported, from its `--json` events: its model and token counts. */
export const CODEX_RESULT_FILE = "codex.json";
export const CODEX_LAST_MESSAGE_FILE = "codex-last-message.md";

/** The temp folder prefix of a PR body file. */
export const PR_BODY_TMP_PREFIX = "graph-pr-";
/** After the merge step, how often the PR is read and how long to wait for it to be merged (a merge
 *  queue or auto-merge merges later). */
export const MERGE_POLL_INTERVAL_MS = 5_000;
export const MERGE_POLL_CAP_MS = 10 * 60_000;

/** The build steps a shell check may run: verification only. Pushing, opening and merging belong to
 *  the forge, which gates them. */
export const CHECK_STEPS = ["checks", "exit_checks", "fix_checks", "tests", "mutation_proof", "db_gate", "size"];

/** The file an agent writes in its out dir to ask the operator a question instead of finishing. */
export const AGENT_QUESTION_FILE = "question.md";
/** The file an agent writes in an output folder for the questions its outputs raise (`parseQuestions`);
 *  an output folder holding nothing else is an agent that stopped on them. */
export const QUESTIONS_FILE = "questions.json";
/** The inputs file's name (`InputsFile`), in the node's attempt folder beside `out/`. */
export const AGENT_INPUTS_FILE = "inputs.json";
/** The installed plugin's docs, under the home folder (`install.sh`'s `~/.agent-build/docs` link). Every
 *  agent file sends a graph agent to `graph-agents.md` there, so every agent run may read that folder. */
export const AGENT_DOCS_DIR = [".agent-build", "docs"];
/** Where a read-only Codex role's final message lands in its single output folder. */
export const CODEX_REPORT_FILE = "report.md";

/** The Jev classifier: the TypeSafe API, its per-question size limit (estimated at 3 characters per
 *  token), and the retry on 429 and 5xx: at most three tries, backing off with jitter. */
export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_MAX_QUESTION_TOKENS = 32_000;
export const JEV_CHARS_PER_TOKEN = 3;
export const JEV_MAX_TRIES = 3;
export const JEV_BACKOFF_INITIAL_MS = 500;
export const JEV_BACKOFF_MAX_MS = 5_000;
export const JEV_BACKOFF_JITTER = 0.25;
export const JEV_MAX_RETRY_AFTER_MS = 60_000;
export const JEV_REQUEST_TIMEOUT_MS = 30_000;
/** A noul question needs instructions or criteria; a score question 2 to 10 levels. */
export const JEV_SCORE_LEVELS = { min: 2, max: 10 };

/** The text sent for a diff the shaping left empty; `(empty)` for the hunter's shape, as its
 *  round-4 tuning sent it. */
export const NO_PRODUCTION_CODE = "(no production code changed)";
export const NO_DIFF_LEFT = "(empty)";

/** The build graph's real-run config, relative to the graph package: Claude and Codex agents, the
 *  shipped Jev setup for every classifier, Linear and GitHub. A Jev-bound mock takes its classifier
 *  bindings from it. */
export const BUILD_RUN_CONFIG = "pipelines/build.config.json";

/** The Haiku classifier: its default model, and the most calls a setup may average. */
export const HAIKU_MODEL = "haiku";
export const HAIKU_MAX_CALLS = 5;

/** A classifier field's sampling (`adapters/sample.ts`): the least a partly kept block or line is
 *  worth showing beyond its gap. */
export const SAMPLE_MIN_PARTIAL = 80;

/** The tracker: Linear's GraphQL endpoint, how long one call gets, and the `##` section of the
 *  target repo's build notes that names its team and labels. */
export const LINEAR_API_URL = "https://api.linear.app/graphql";
export const LINEAR_REQUEST_TIMEOUT_MS = 30_000;
export const LINEAR_NOTES_SECTION = "tracker";
/** The build notes' section naming the repo's own reader agents, one `- <agent name>` line each. */
export const REPO_READERS_NOTES_SECTION = "repo readers";


/** `stats`: the file an agent leaves its struggles in (beside `questions.json`), and how many runs a
 *  struggle's fingerprint must recur in to be printed. */
export const STRUGGLES_FILE = "struggles.json";
export const STRUGGLE_MIN_RUNS = 3;
/** The file a fixer slice appends each message it sends a peer to, one JSON line each
 *  (`CrosstalkMessage`), beside `struggles.json` (`docs/graph-agents.md`); `stats` prints them. */
export const CROSSTALK_FILE = "crosstalk.jsonl";
/** The side files `stats` reads: a retry or a rerun moves the ones its earlier attempt left into that
 *  attempt's own folder (`attemptOutKey`) before it empties the output folder, so every attempt's are kept. */
export const KEPT_SIDE_FILES: readonly string[] = [STRUGGLES_FILE, CROSSTALK_FILE];
/** The files an agent may leave beside an output's own, which its format does not cover: its
 *  questions (routed, and read before the next attempt starts) and the kept side files. A folder
 *  holding `questions.json` and only these stopped on its questions. */
export const OUTPUT_SIDE_FILES: readonly string[] = [QUESTIONS_FILE, ...KEPT_SIDE_FILES];

/** The build graph's fix slices (`D-plan-slices`): two linked draft slices merge while the merged slice
 *  holds at most this share of the round's rows (or the largest draft slice, if that is bigger). */
export const SLICE_MERGE_SHARE = 0.5;
