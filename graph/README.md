# graph: the build as a graph, run by Temporal

An engine that runs a pipeline written as a graph of four kinds of node: **agents**, **classifiers**,
deterministic **checks**, and **data** nodes (tickets, pushes, PRs, merges). A data item flows from the
one node that produces it to every node that reads it. One generic Temporal workflow walks any
validated graph, and the same definition draws the graph as Mermaid, so the picture and the run cannot
drift apart.

This package holds the engine (G1), the real adapters for its seams (G2: Claude Code, Codex, Jev, Haiku,
shell, Linear, GitHub), a toy graph, and `/build` itself as a graph ([`pipelines/build.ts`](pipelines/build.ts))
with the checks and operations it runs ([`pipelines/build/`](pipelines/build/)), plus the mock tools ([`mock/`](mock/README.md))
that replay recorded runs on it (the recorded fixtures stay in the private repo). `/build` does not use this package yet.

**Retirement bar.** The graph replaces the `/build` skill once 5 real runs of the build graph have
merged with no close loop that hit its cap and no operator rescue (an operator's `merge` or `abandon`
at the merge wait, a by-hand fix, a restarted run).

It has its own `package.json` (the Temporal SDK) so the plugin's root runtime stays free of
dependencies, and the root `pnpm test` does not run its tests.

## Install

Needs `node` 22.18 or newer, `pnpm`, `git`, and the [Temporal CLI](https://docs.temporal.io/cli)
(`temporal`) for the local server.

```
cd graph && pnpm install
```

## Use

```
node cli.ts dev                                          # start (or attach to) the local server, then run the worker
node cli.ts start "<request>" --repo <path> [--config <file>]
node cli.ts status <run>
node cli.ts answer <run> "<text>"                        # answer the question a node asked
node cli.ts cancel <run>                                 # stop a run where it is, see How a run goes
node cli.ts draw <run | graph module>                    # write the .mmd and print its path
node cli.ts export <graph module>                        # print the graph as JSON, see Node docs and the export
node cli.ts stats [state dir]                            # what the recorded runs say, see Telemetry
```

`package.json` names this CLI `build-graph` (`bin`), and `pnpm build-graph <command>` runs it.

- **Server.** `TEMPORAL_ADDRESS` (default `localhost:7233`). `dev` attaches when a server already answers
  there; otherwise it runs `temporal server start-dev --db-filename <state dir>/temporal.db` (UI on the
  port plus 1000) and stops it again on Ctrl-C. Runs survive a restart of the server.
- **State dir.** `AGENT_BUILD_GRAPH_DIR` (a relative value is read from the cwd), default
  `~/.local/state/agent-build/graph`. Each run gets `runs/<run>/`: `graph.json`, `inputs.json`,
  `place.json`, a `worktree/` of the repo on branch `graph/<run>`, a `worktrees/` folder with each agent's own worktree (`<node>`, or `<node>/<item>` in a fan-out), each node's output under `nodes/<node>/<iteration>/`, the fake tracker's and forge's
  files, an attempt record for each attempt of each node with the side files a later attempt kept for it ([Telemetry](#telemetry)), and at the end `history.json` and `graph.mmd` (also written when the run fails). `draw <graph module>` writes `graphs/<id>.mmd`.
- **Config.** A JSON file: `graph` (the module exporting `graph`) and the adapter each node kind binds
  to, with per-role overrides under `roles`. Without `--config`, `start` runs
  [`examples/toy.config.json`](examples/toy.config.json) on the stubs. [Adapters](#adapters) lists the
  real bindings.
- **The operator.** When a node asks a question, the run waits on the `answer` signal and fires a
  `blocked` event through `BUILD_EVENT_CMD` (the launcher's seam, [docs/build-events.md](../docs/build-events.md)),
  as set for the process that ran `start`, which the run carries to the worker; the event goes out through `runtime/buildEvent.ts` as a child
  process. Each answer goes to one open question, oldest first; an answer with no unanswered question
  is dropped. When the run ends it fires one `finished` event the same way, with the PR's number,
  the run's branch and the worktrees it left on disk; its outcomes are in
  [docs/build-events.md](../docs/build-events.md).

## Adapters

Each seam (`adapters/types.ts`) is bound by config, per kind with a per-role override under `roles`.
`adapter` names the implementation, and a key the adapter does not have is refused, so a misspelled one
never falls back to its default. A node whose output breaks its declared schema fails without a retry.

| seam | `adapter` | what it does |
| --- | --- | --- |
| agent | `stub` | copies fixture files to the declared outputs |
| agent | `claude` | `claude -p --agent <plugin>:<role> --output-format json` in the node's worktree. Keys: `plugin` (omit it for a project agent), `model` (the role's default: a node with `modelFrom`, a text input naming the model its dispatch runs on, passes that as `--model` instead; the build graph's `A-fixer` takes the fix table's round model this way), `permissionMode` (default `acceptEdits`), `agentFromItem` (`true`: the agent is the fan-out item, a project agent the repo names, see [Repo readers](#repo-readers)) |
| agent | `codex` | `codex exec --json` with the role's instructions, resolved by `runtime/codexRole.ts` (a repo or user toml, then `agents.json`); the token counts its events report and the role's model go to `codex.json` beside `out/` |
| classifier | `stub` | answers from a fixture map |
| classifier | `jev` | the TypeSafe API, see [Jev classifiers](#jev-classifiers) |
| classifier | `haiku` | `claude -p` with the setup's system prompt and none of the user's settings, over the same state `fields`, see [Haiku classifiers](#haiku-classifiers) |
| check | `stub` | answers from a fixture map |
| check | `pipeline` | the run's pipeline module (`pipeline` in the config) runs the check of the node's role |
| check | `shell` | the check's role names a step of the target repo's `.claude/build-steps.toml` (resolved by `runtime/steps.ts`), run with `sh -c` in the run's worktree; exit 0 passes, anything else fails, and the detail keeps the end of the output. The command is read from the run's base commit, not the worktree. Only `checks`, `exit_checks`, `fix_checks`, `tests`, `mutation_proof`, `db_gate` and `size` may be named (push, PR and merge belong to the forge); a graph that binds another role to `shell` is refused at its start. A step the repo does not map is an error, not a pass |
| tracker | `file` | JSON files under the run dir |
| tracker | `linear` | the Linear GraphQL API, a personal API key in `LINEAR_API_KEY` (sent as the `Authorization` header) |
| forge | `file` | JSON files under the run dir |
| forge | `github` | the repo's `push`, `pr_open` and `merge` steps, read at the run's base commit as the shell check reads its steps, with `sh -c` in the run's worktree; a step the repo leaves out runs its fallback in `runtime/steps.ts`'s `FALLBACKS`. Each step gets the PR in its environment, under the names `PR_STEP_ENV` (in `runtime/steps.ts`) holds: `BUILD_PR_TITLE` and `BUILD_PR_BODY_FILE` (the body, in a temp file) for `pr_open`, `BUILD_PR_NUMBER` for `merge`, `BUILD_PR_BRANCH` (the run branch) for all three, and `BUILD_PR_CLASS` (the brief's risk class as the brief writes it, `R1`; unset when it has none) for `pr_open` and `merge`. On the `pr_open` fallback the forge adds `--title "$BUILD_PR_TITLE" --body-file "$BUILD_PR_BODY_FILE"` and drops `--draft` when the PR is not a draft; a repo's own `pr_open` reads them from the environment and decides itself whether the PR is a draft (its `merge` step readies a draft); the wait before `D-merge-pr` holds whichever it opened, so a ready PR from a repo's step never merges unasked. A `pr_open` that prints no PR URL has the branch's PR read back with `gh pr view`. A step the repo maps to nothing is an error |

**Agents.** The adapter writes the node's dispatch to `nodes/<node>/<iteration>/inputs.json` (the
`InputsFile` shape in `contracts.ts`: role, iteration, fan-out item, worktree, each input by data id with
a files item as absolute paths, each output's folder `out/<id>/`, the answers to the node's earlier
questions, and the amend or resolver question) and names that file in the prompt. The agent writes each
output (at least one file each) and the adapter checks they exist. An agent with graph-run rules in its
file ([`docs/graph-agents.md`](../docs/graph-agents.md)) raises questions in `questions.json`, which the
graph routes; any other agent that cannot go on writes its question to `out/question.md`, and the node
asks the operator. The agent's session runs under a name (`claude -n`, `sessionName` in `runKeys.ts`):
`<run>-<node>-<iteration>[-<item>]`, so a fixer can message a peer at the name its slice plan gives
([Peers](../docs/graph-agents.md#peers)). The activity heartbeats through the whole attempt;
an abort (the node's time cap, or a cancel) kills the process's whole group and rejects only once it is gone: the local abort fires up to 14 s (`CAP_ABORT_LEAD_MS`, twice the teardown budget) before the cap, so the group is gone before the server's own timeout. A cap hit fails the node with a `RunError`, never retried: an attempt that ran out its cap would run it out again. The agent's process group id is recorded in the run dir (`nodes/<node>/<iteration>/pgid.json`) while it runs; when a worker dies without aborting the attempt, the retry kills a group still alive there before it resets the worktree. `build-graph dev` shuts the worker down on SIGHUP (a closed terminal) as well as SIGINT, SIGTERM, SIGQUIT and SIGUSR2. No child process inherits `TYPESAFE_API_KEY` or `LINEAR_API_KEY`.

- **Pushing and PRs are blocked for every agent, Claude and Codex, in layers.** Each agent runs in its
  own worktree, detached at the run tree's HEAD, whose remotes all have a push URL no transport handles
  (`remote.<name>.pushurl`, set per worktree; this turns on `extensions.worktreeConfig` in the repo's
  config, once). Its environment has no `GH_TOKEN`, `GITHUB_TOKEN` or enterprise equivalents, and
  `GH_CONFIG_DIR` points at an empty folder, so `gh` holds no login. The run worktree, where the forge
  pushes, keeps the real URLs. A Claude agent also has `git push` and `gh pr` denied by flag
  (`CLAUDE_DISALLOWED_TOOLS`), including the forms with options before the subcommand (`git -C <dir>
  push`, `gh -R <repo> pr create`), checked on Claude Code 2.1.307. Not covered: a push to a bare URL
  with a credential helper that holds a token, `gh api`, and a push through a script.
- **Readers** (`writes` unset) work in their own worktree, so nothing they write reaches the run tree.
  A Claude reader also has `Edit`, `Write` and `NotebookEdit` denied inside that worktree.
- **Codex** hands outputs back by sandbox. A role that writes (`workspace-write`) writes its output files
  like a Claude agent, with the node's folder added as writable. A read-only role cannot, so its final
  message is its one output (`out/<id>/report.md`); a node that declares two outputs for one is refused.

**Tracker.** Ingest reads an issue by identifier. File creates one; the data node `ticket` files the
bundled inputs. Comment (the data node `comment`) adds the non-ticket inputs to the ticket ref it is given.
File and comment run once. The team and labels come from the target repo's build notes
(`steps.ts --get notes`), read as the run's base commit holds them, never from a worktree an agent
edited. A `## tracker` section is read when something is filed:

```
## tracker

- team: DEV
- labels: bug, tech-debt
```

A label the team cannot use stops the filing; every page of the label lookup is read before a label is
called missing. **Forge.** Each operation runs once, and the forge merges what it is asked to. The
refusal belongs to the generic `merge` data operation: it merges only when the check data among its
inputs is green (at least one check, all passing), and a graph whose merge node has no check input
does not validate. The build graph's merge node decides for itself (see The build graph's ship path).
After the merge step the PR is read until it is `MERGED`, since a merge queue or auto-merge merges
later; a PR still open after 10 minutes, or closed, fails the merge. One call runs the step once; the
build graph's merge node reads the PR once after any failed merge, ends merged when GitHub already
reports it `MERGED`, and otherwise asks the operator, whose `merge` runs the step again (harmless on a
PR whose auto-merge the first run armed).

### Repo readers

A repo names its own reader agents in a `## repo readers` section of its build notes, one per line: a
`- ` and the agent's name, optionally followed by text that says when it reads (the name ends at the
first space). Each is a project agent, `.claude/agents/<name>.md` in the repo.

```
## repo readers

- comment-reader (size S and up)
- api-reader
```

The build graph's `repo-readers` fan-out runs `A-repo-review` once per reader, and the real-run config
binds the `repo-review` role with `agentFromItem`, so each run spawns `--agent <name>`. At the run's
start the section is read as the base commit holds it (`steps.ts --get notes`, like `## tracker`), and
a reader whose agent file that commit does not hold refuses the run, as does a notes file the steps
name and that commit does not hold. With no section, or no notes step, the fan-out has no items.

### Jev classifiers

`POST {TYPESAFE_BASE_URL or https://api.typesafe.ai}/v1/systemone` with `{model, state, questions}`, the
key from `TYPESAFE_API_KEY` (API: https://docs.typesafe.ai/api). A binding holds:

- `model`: pinned, because an alias moves when a release ships and a cut-off is tuned for one model.
- `fields`: the state, built from the node's inputs (shared with the Haiku adapter). A field is
  `{input, optional?, cutBefore?, shape?, maxChars?, sample?, keep?, note?}`; any other key is refused,
  so a misspelled one never falls back to its default. A file input is read as it is, trailing newline
  included.
  - `input` is a data id. With `optional: true` it may be one of the node's optional inputs: when the
    run has no value for it, the field and its note are left out of the state.
  - `cutBefore` keeps the text before the first line its pattern (multiline) matches, trimmed: a tuned
    setup's cut of a longer input.
  - `shape` reduces a diff next: `production-code` drops tests, docs, config and data files, lockfiles
    and generated copies; `risky-hunks` also keeps only the hunks whose added lines handle errors, call
    out, parse, write, or await; `no-tests-docs-locks` is the hunter's round-4 filter, the file chunks
    as they are less tests, every `.md` and `.txt`, and lockfiles (config stays); `security-surface`
    is `production-code` that keeps the config a security read needs: CI workflows
    (`.github/workflows/`), `*.plist`, any path containing `auth` or `rls`, `config.toml`, and
    `.env*.example` (the other data and config files still drop).
  - `maxChars` caps the text with a sample that reaches the whole input (`adapters/sample.ts`): a
    shaped diff keeps every file (a cut one by its `diff --git` line), and a long file its first and
    last hunks (one long hunk its head and tail lines); any other text keeps every `#`/`##` section's
    heading with the head and tail of its text, and the sections `keep` names first, whole when they
    fit. What the units leave unused goes back to the cut ones, so the budget is spent on content. A
    line longer than its room keeps its start and end. Each gap starts with `…` and says what was left
    out. `sample: "head"` keeps the first `maxChars` characters instead, for a tuned setup whose
    cut-off was fitted on that cut.
  - `note` adds a second state field, `text` followed by how the input was sampled when it was.
- `questions`: `noul` and `score` questions, as the API takes them.
- `combine`: `mean` (the default) or `max`, for a question of the form "any of these".
- `features`: code-side additions to p, each `{input, pattern, weight}`: the weight is added when the
  multiline pattern matches the input's text.
- `cutoff`: p is the questions' combination (a score divided by its top level) plus the features. The
  answer is `yes` at or above the cut-off, else `no`. p is capped at 1.

A request over 32k tokens for any one question (characters / 3, the state plus that question) is refused
before it is sent. 429 and 5xx are retried with backoff, three tries in all; a `Retry-After` of a minute
or less is honoured. Other 4xx and a refused size are run errors, never retried. A run with a Jev
classifier and no `TYPESAFE_API_KEY` in the worker's environment is refused at its start.

A binding may name a `setup` file (read from the config's folder) whose keys it overrides:

```json
{ "classifier": { "adapter": "jev", "setup": "classifiers/review-fix.json" } }
```

### Haiku classifiers

`claude -p` on the setup's `model`, with the setup's `system` prompt in place of Claude Code's own,
`--setting-sources ''` and `--strict-mcp-config` (none of the user's settings, hooks, CLAUDE.md or MCP
servers, so neither the cost nor the calibration moves with them), no tools, and a JSON schema for
`{reason, p_yes}`. The user message is the setup's `prompt` with each `{{name}}` replaced by the state
field `name` (the same `fields` as Jev); a placeholder may not name an optional field or its note, since
a run without that input would have nothing to put there. `calls` (default 1, at most 5) calls run at
once and p is the mean of their `p_yes`; one failed call aborts the others and fails the decision once
they have exited. A setup's `questions`, `combine`, `features` or `question` are refused, not dropped,
and so is any key a setup does not have.

No shipped setup binds it: every classifier of the build graph runs on Jev.

### The decision record

Every classifier starts on an initial setup and is tuned from real runs, so each decision keeps what a
tuning round needs. A classifier node's verdict carries its `decision`
(`adapters/decision.ts`, the S1 map's d.decision):

- `node`, `adapter`, `model` and `cutoff`; the verdict itself holds `answer` and `p`.
- `setup`: the setup file's name and a sha256 of its bytes (`overrides` names any key the binding
  set over the file's), or `inline` and a sha256 of the binding as written.
- `stateDigest`: a sha256 of the exact state sent (Jev's state as JSON, Haiku's user message).
- `decisionFile`: `nodes/<node>/<iteration>/out/decision.json`, one file per decision, holding the
  record, the answer and p, and that state as sent.
- `explored: true`: the verdict is `no` and the exploration coin ran the gated reader anyway
  ([Exploration](#exploration-labels-and-fitting)).
- `error`: the call failed for good, and the node failed open (below).

A stub classifier sends nothing, so its record names only the node and the adapter. A node run in
`history.json` keeps the classifier's `p` and `cutoff` beside its answer, and `explored` or `error`, and a mock's `record.md`
shows them on each classifier row (`done no (p 0.12, cut-off 0.155)`), so a run's record says how
close each call was.

### The shipped setups and the real-run config

Every classifier node of the build graph has a setup in `classifiers/<role>.json`. Each records
`status` (`tuned`; `initial`: the question from the S1 map with cut-off 0.5, waiting for tuning and
explored in real runs; or `judgment`: a cut-off its report names as a cost judgment, never explored),
its `cutoff`, and the `report` it came from (named with its date; the reports live outside this repo). Read the report before relying on a cut-off: a cut-off is
set on one population and does not carry to another. The prompts and the shaping patterns
(`adapters/diffShape.ts`) are the tuned ones, copied verbatim; changing either invalidates a cut-off.

| setup | node | adapter | reads | status |
| --- | --- | --- | --- | --- |
| [`prior-art.json`](classifiers/prior-art.json) | `C-prior-art` | jev | `start`, `ticket` (optional) | judgment: cut-off 0.15; its reader writes no table rows, so no run can label it |
| [`review-codex.json`](classifiers/review-codex.json) | `C-review-codex` | jev | `diff` | initial |
| [`completeness.json`](classifiers/completeness.json) | `C-completeness` | jev, `combine: max` | `brief` (keeps Deliverables, Parts, Target files), `size-report` (feature) | initial |
| [`simplifier.json`](classifiers/simplifier.json) | `C-simplifier` | jev | `diff`, `size-report` (features) | initial |
| [`security.json`](classifiers/security.json) | `C-security` | jev, `combine: max` over four areas | `diff` (`security-surface`) | initial |
| [`silent-failures.json`](classifiers/silent-failures.json) | `C-silent-failures` | jev, five exposure questions | `risk-moment` (cut before its `size:` line), `diff` (`no-tests-docs-locks`, sampled to 75,000 characters) | tuned: cut-off 0.2228 under the cost-weighted loss; fresh holdout accuracy 0.70 against 0.65 for always running, loss $0.020 per decision below always running, AUC 0.824 |
| [`review-fix.json`](classifiers/review-fix.json) | `C-review-fix` | jev | `fix-diff`, `fix-file` (feature) | tuned: AUC 0.778 on 57 rounds, accuracy 0.79 against 0.74 for never re-reading |

[`pipelines/build.config.json`](pipelines/build.config.json) is the build graph's real-run config:
Claude agents from the `agent-build` plugin, the Codex pair on Codex as the shipped `review`
role (a Codex binding's `role` names the Codex role a graph role runs), every classifier bound to its
setup under `roles` (no default classifier, so a classifier node the config does not name is refused
at the run's start), the pipeline's checks, Linear and GitHub. At a run's start each Jev or Haiku setup
is checked against its node: it reads only the node's inputs, a field on an optional input is marked
`optional`, and no feature reads an optional input. Every agent role must resolve as the config binds
it: a Claude role to an `agents/<role>.md` of the plugin this package ships in (or, with no plugin, a
project or user agent), a Codex role as `runtime/codexRole.ts` resolves it; a role that does not stops
the run before its worktree is made. The `repo-review` role leaves that check: its agents are the
[repo readers](#repo-readers). The test slices' verify phase (`A-prove-tests`) runs the `write-tests`
agent, as `A-write-tests` does; the agent tells the phase by its output folder. A real run waits for
the operator.

### Fail-open

A classifier call that fails for good (its last attempt, or an error no retry would help, such as a
4xx or a refused size) does not fail the run: the node answers `yes` with p at the setup's cut-off,
and the decision's `error` says why. Its reader runs, and the decision gets no label. A cancel is not a
failed call.

An agent node marked `failOpen` fails open by the same path: when its last attempt fails, or its
output breaks its format twice, the node ends `done` with no outputs and its `error` in the record,
and every node that reads its output reads it as optional. Only an agent that writes no code may be
marked so. The build graph's slicer (`A-link-slices`) is the one.

### Exploration, labels and fitting

A gate's verdict stands and is recorded; separately, in a real run (any agent not a stub), an
`initial` setup's `no` is explored with probability `EXPLORE_RATE` (0.3, `constants.ts`): the coin is
the first 8 hex digits of the sha256 of `<run id>|<node>|<iteration>|explore`, over 2^32, below the
rate. An explored `no` opens the gate as a `yes` would (`gateFails`), so the skipped side of the gate
earns labels too; the threshold never moves. A mock run, a stub, and a binding whose `status` is
`tuned`, `judgment` or absent never explore; an inline binding explores when it says `status: initial`.

A decision's label is computed by `stats`, never written, from the routing the final `table.json`
recorded: when its gated reader ran, 1 if the reader left a wave row whose kind is urgent (`behavior`,
`security`, `missing`) in the last round the table holds it (a leftover counts) and that the table did
not close as dropped with the confirm read's agree (a drop or relabel the read disagreed with keeps the
row's kind), else 0. A decision that failed open has none. A decision outside a loop reads the rows
its reader raised in the wave (entered at round 1). A decision at a close-loop iteration (`C-review-fix`,
whose gated reader is `A-review-fix`) reads the rows its reader raised at the confirm stage of the round
that iteration's fixer took: ids in that stage's range, entered at the round that took the stage in
(at `final`, which keeps the urgent rows it takes in only as ids under `open`, every open id in that
range). It is 1 as well when its reader reported a row that fixer marked `fixed` as still `unresolved`,
in a stage file the table took in, and the table carried the row on with an urgent kind (the higher of
its own and the fixer's `kind=`). So a `C-review-fix` decision is 1 when the confirm read left a new
urgent row or sent an urgent fix back. The round each iteration's fixer took is the `round` in that
iteration's D-build-fix-table `state.json`; the status lines are read from the mirror's stage folder
(`close/stage-<key>/`) with the table's own parser. A cut-off fitted on rounds one fixer took does not
carry to rounds split among several, so `stats` counts each close-loop decision in its fix round's
population, `single-slice` or `multi-slice`, by the items the fixer's fan-out (`fix-slices`) ran over at
that iteration (`history.fanOuts`), one classifier row per population; a decision with no such record
(a run from before the fan-out) is counted in neither. The hunter's and the re-read's own, stricter tuning labels are
never pooled with these.

The split for fitting is fixed before any label is read: a run's decisions are in the fit half when
the first 8 hex digits of the sha256 of `<run id>|split`, as an integer, are even, and in the holdout
otherwise. Fit a gate once its fit half holds 10 explored decisions with at least 2 positive labels;
score the fitted cut-off on the holdout once, and ship it with a report and `status: tuned`.

## Telemetry

Every attempt of every node writes its record at
`nodes/<node>/<iteration>[/<item>]/rerun-<r>/attempt-<n>.json` (`AttemptRecord` in `contracts.ts`)
when it starts, and again when it ends: `startedAt`, `endedAt`, `outcome` (`done`, `needs-operator`,
`merge-conflict`, `failed`, `aborted`), and for an agent the `model`, `tokens` and `costUsd` its CLI reported, null when
it reported nothing (Claude's from `claude.json`, read when the attempt ends; Codex's tokens from its
`--json` events, with no cost). `rerun` counts the workflow's own reruns of the node (a schema
failure, a blocked question, an answer it runs again on, a fresh run after its merge conflicted), so no two attempts share a record. A record
can carry `conflict`, the merge conflict the attempt is about: on a merge node's `merge-conflict`
attempt, the writer's commit its merge could not take and the paths git left conflicted; on a
writer's fresh run, the conflict it was handed, with `restart`, which fresh run it is (1 on the first),
from its first record on, so an attempt whose worker died shows it too. A record
with no `endedAt` is an attempt whose worker died. A node run in `history.json` carries `startedAt`
and `endedAt`, and `restarts` once the writer ran again after its merge conflicted (which fresh run
the row is from), which `build-graph status` and a mock's `record.md` print after its status as
`(1 restart)`; the history carries its `runKind` (`real`, or `mock` when every agent is a stub).

`build-graph stats [state dir]` reads every `runs/*/` and prints, over the real runs (or the mock
runs when there are none): each run's wall time and cost (Claude's at list price; a cost with a Codex
or silent attempt in it is a floor) and its writers' restarts; each node's attempt durations (p50, p90, max) against its cap,
the margin, the attempts aborted at the cap, those lost, and its restarts (a restart is one fresh run
after a merge conflict, counted once over its retries from the attempt records' `conflict.restart`); each classifier's decisions, how many
fired, were explored and failed open, its labelled decisions with the mean p of the positives and the
negatives (`C-review-fix` once per fix-round population, see [labels](#exploration-labels-and-fitting)); and every struggle (`struggles.json`, in
[`docs/graph-agents.md`](../docs/graph-agents.md)) whose fingerprint (category, file or check, the
one-line cause) came up in 3 or more runs; and every message a fixer logged sending a peer
(`crosstalk.jsonl`, `CrosstalkMessage` in `pipelines/build/slices.ts`) with its run, fix round,
slice, `to` and the first line of its `text`, or `none`. The crosstalk is the sender's own record.
Every attempt empties the node run's output folder, so first it moves the struggles and crosstalk
(`KEPT_SIDE_FILES` in `constants.ts`) the attempt before it left into that attempt's own folder,
`rerun-<r>/attempt-<n>/out/<output>/`, beside its record (`attemptOutKey` in `runKeys.ts`); the last
attempt's stay in `out/`, and `stats` reads every attempt's, earlier ones first. `questions.json` is
not kept: the workflow routes it before the next attempt starts. A file or line it cannot read is
listed, never fatal.

The time caps of the build graph (`pipelines/build.ts`), one attempt each:

| nodes | cap |
| --- | --- |
| the brief writer, builders, test writers, fixer, amend writer, hand testers | 90 min |
| readers: prior art, the wave, the re-reads, repo readers, the resolver | 30 min |
| checks | 20 min |
| data nodes | 10 min |
| the PR and the merge (`D-open-pr`, `D-merge-pr`: the repo's push gate and the merge poll) | 45 min |
| classifiers | 2 min |
| the run's own bookkeeping (prepare, notify, merge a service commit, record) | 1 min |

The caps are re-fit after 12 real runs, from `stats`: each kind's cap becomes 1.5 times the longest
attempt it recorded, rounded up to 5 minutes, and never falls below the cap it has unless the
operator strikes the longest attempt as a runaway.

## How a run goes

- Every node whose inputs are ready starts, in parallel.
- A node gated on a classifier runs only when that classifier gave the gate's answer, a node gated on
  a check item (`on`) only when that check answered so, and a node gated on a loop only when the loop
  ended with that outcome (`clean`, `capped`, or `aborted`, which the loop writes to its `outcome` data
  item). `anyOf` and `allOf` combine gates. Otherwise the node is skipped, and so is anything that
  needs its output (an optional input does not).
- A fan-out runs its nodes once per item of an `items` list (a brief's parts, its test slices, the
  repo readers), each item after the items it names in `after`; its outputs join (files), take the
  last item's (a ref), or fail when any item's check failed. An item after one that failed or was
  skipped is skipped, down the whole chain. A fan-out with a `status` writes it once every item has
  ended: pass when every item finished, fail naming the items that did not, so a node gated on it
  runs only on a whole group. A fan-out may sit inside a loop (every node of it in that one loop, none
  of them the stop node): it runs once an iteration, over that iteration's list, and
  `history.json`'s `fanOuts` records each run with its iteration and items.
- A loop runs its body until its stop node (a check or classifier) gives the stop answer, or its cap.
  Data the loop `carry`s reaches the next iteration only: a node that reads it on a back edge (its
  producer comes later in the body) gets the value the iteration started with, a node after the
  producer gets this iteration's. After the loop, only its last iteration's values flow on.
- Each node is one activity: its time cap is the attempt's `startToCloseTimeout`, it heartbeats, and it
  gets one retry, except a data operation that is not idempotent (`ticket`, `push`, `pr`, `merge`),
  which runs once, and an attempt that hit its time cap, which fails the node: the retry is for a
  worker that died. An agent works in its own worktree, with pushing blocked there: a fresh run starts
  it at the run tree's head of the moment, and a retry resets it to that same commit, so the reset never
  touches another node's work. A writer's (`writes`) commits reach the run tree only through a data
  node whose operation merges (`merge-back`, or a pipeline's own), under the run tree's lock, before any
  node that reads the code. A `merge-back` whose merge conflicts runs the writer whose commit it read
  once more, fresh at the run tree's head of the moment, with the commit and the conflicted paths in
  its inputs file (`conflict`, [`docs/graph-agents.md`](../docs/graph-agents.md)); the writer brings
  that commit onto the new head, resolves it and commits, its new outputs replace the first run's, and
  the merge runs again on the new commit. A fresh run whose head holds neither that commit nor a change
  of its own on the head it began at hands the merge the conflicted commit again (`restartCommit`,
  `worktree.ts`), so the merge conflicts as before rather than landing nothing. A writer gets at most
  `WRITER_RESTART_CAP` (`constants.ts`) such runs per merge, past which the merge node fails naming the
  paths and the commit. A pipeline's own merge
  operation may report the conflict as data instead (the build graph's `D-merge-slice`), and the base
  branch's merge (`D-pull-main`) fails the node: a person resolves it.
  A node whose output breaks its declared schema fails without a retry.
- A graph may name services (`services`): the schema check runs after every agent and turns what its
  outputs ask into questions, and each question is routed in code (`routeQuestion`) to a fresh rerun,
  the operator, or the resolver; the routing rule, and what an agent reads back, are in
  [`docs/graph-agents.md`](../docs/graph-agents.md). A graph that names its amended output (`amended`)
  has the amended files published as the item they replace, for every node that reads it later, and
  its reparse check run on them. An amend whose merge conflicts runs the amend service again on the
  conflict, under the same cap; any other merge failure fails the node that asked. A node with an
  `answers` output gets its answers written there; any other node, and one that wrote only its
  questions, runs again with them.
- A pipeline module (`pipeline` in the config) implements the graph's own checks (`{ "adapter":
  "pipeline" }`) and data operations, by role.
- The run fails when a node failed in any iteration, a loop aborted, or something outside the nodes
  failed (the graph or inputs, the setup, the record); `status` shows why.
- `build-graph cancel <run>` cancels the workflow (on a run that has ended it prints how it ended and
  sends nothing; on one whose status cannot be read, as when no worker runs, it sends the cancel and
  says the run stops once `build-graph dev` runs its worker). Every node still running or waiting is marked `cancelled`; its activity aborts at its
  next heartbeat and kills its process group (every child runs in a group of its own), and the run
  ends `cancelled`. A data operation may also end the run on the operator's reply (`abandon` at the
  build graph's merge wait): it ends `abandoned` by the same path. Either way no cleanup runs, so the
  branch, the PR and the worktrees stay as they were. The record (`history.json`, after killing every
  agent group a `pgid.json` under `nodes/` still names alive) and the one `finished` event run out of
  the cancel's reach.
- The workflow does no I/O; the activities do it all.

## Node docs and the export

A node's description lives beside the node, in its graph module: `doc`, one plain sentence of what
it reads, what it writes and when it runs ("reads the fix table, writes one slice's fix commit; runs
once per slice"), stating no rule the code does not have. A change to a node (its inputs, outputs,
gate or role, or the check or operation behind its role) updates its `doc` in the same PR.
A classifier's cut-off, model and status live in its setup under `classifiers/`, never in its `doc`,
so a retune cannot leave the sentence behind.
`__tests__/exportGraph.test.ts` fails when a node of a graph under `pipelines/` or `examples/` has
none.

`build-graph export <graph module>` prints the graph as JSON, the `GraphExport` shape in
`contracts.ts`, for a reader outside this package: each node's id, `doc`, kind, role, inputs,
`optionalInputs`, outputs, gate, `writes`, its time cap in minutes (`capMin`), its loop and fan-out,
whether it is a service, `readsRecord`, `answers`, and `runsOnce` (a data operation that is not
idempotent); the data items, loops, fan-outs, services and `amended` as the graph defines them; and
one edge per input a node reads from the node that writes it, `optional` when the reader lists it as
optional. A node with no `doc` stops the export, naming it.

```
node cli.ts export pipelines/build.ts > build-graph.json
```

## The build graph's node names

A node's id says what the node does to what, in the words a person would use, and no sibling's id
could be mistaken for it at a glance:

- `<kind>-<act or object>[-<moment>]`, with the kind prefix `A-` (agent), `C-` (classifier), `K-`
  (check) or `D-` (data operation). Verb first when the node acts on something (`D-pull-main`,
  `K-parse-brief`), object first for a well-known concern (`A-prior-art`, `A-security`). Never a bare
  role noun (`setup`, `env`, `gate`).
- A node that repeats an earlier one keeps its name and adds the moment: `-fix` (on the fixed head,
  after a fixer round), `-drift` (after the close loop pulled main again, which `K-main-moved` asks
  for), `-ship` (at ship, after a capped loop). The first run has no suffix.
- One word per thing: `merge` takes an agent's commit into the run tree (`D-merge-part`,
  `D-merge-tests`, `D-merge-proofs`, `D-merge-fix`); `pull main` fetches the base branch and merges it;
  `review` is the general code reviewer at every moment (`A-review`, `A-review-fix`); `tests` is the
  repo's exit or fix checks step and `pre-push` its `checks` step.
- A classifier carries the name of the reader it switches on (`C-silent-failures` gates
  `A-silent-failures`); the question it asks lives in its setup, not its id.
- At most 20 characters, and valid as `define.ts` checks it (letters, digits, `_`, `.`, `-`).

Roles, classifier setups and data items take the node's own words, so a run folder, a decision
record or `stats` reads like the graph:

- A role only the graph knows (a check's, a classifier's, an operation of this pipeline) is the node's
  id less its kind prefix (`K-load-config` runs `load-config`, `D-install` runs `install`). A node
  that repeats an earlier one shares that node's role (`K-tests-fix` runs `tests`, `D-pull-main-drift`
  runs `pull-main`); one that does something else keeps its suffix (`K-pre-push-ship`). A
  classifier's setup is `classifiers/<role>.json` (`C-review-fix` reads `review-fix.json`).
- An agent's role is the id less its prefix of the first node that runs it, and its agent file is
  `agents/<role>.md`, the name `/build` and the fix table know the reader by (`A-review` runs
  `review`, `A-silent-failures` runs `silent-failures`, `A-answer-question` runs `answer-question`).
  Every later node that runs the same agent shares its role, a later moment (`A-review-fix` runs
  `review`) or another job (`A-prove-tests` runs `write-tests`, `A-amend-brief` runs
  `write-brief`), so one agent keeps one name. The Codex pair's role key is its node's too
  (`review-codex`), and the repo readers' role, which binds no agent file of its own, is
  `repo-review`. A reader and the classifier that gates it share the role string
  (`silent-failures`), and nothing keys on the role alone across kinds: a run folder is the node's,
  a binding sits under its kind (`roles.silent-failures.agent`, `roles.silent-failures.classifier`),
  and the fix table and `stats` read agent roles only. An engine operation or service keeps the
  engine's name (`ingest`, `ticket`, `merge-back`, the `resolver` service that `A-answer-question`
  serves).
- A check's verdict is named like its node (`parse-brief`, `main-moved`), a classifier's is
  `<role>-call`, a reader's findings or stage file is `findings-` and the node less its prefix
  (`findings-review-fix`), and a gate D-merge-fix opens is `owed-` and the node it opens
  (`owed-completeness-fix`; `owed-review-fix-call` asks `C-review-fix`). Any other item names what it
  holds, in the node's words (`pull-main-head`, `tests-commit`, `proofs-head`, `stack-bindings`).
- An output folder an agent's own file names keeps that name (`tests-authored`, `tests-verified`,
  `slice-fix`, `risk-moment`): an agent learns its job from its role and output folders, never from
  a node id.

`__tests__/buildGraph.test.ts` holds the build graph to the first three: its graph-only roles, agent
roles, setups, verdicts, calls, findings and owed gates.

## The build graph's fix round

A close-loop iteration that owes a fix shares the round out among fixers that run at once:

- `D-build-fix-table` writes the round's draft slices (`draft-slices`): rows that point at one file join, so
  no file falls in two; a row with no parsed path is a slice of its own. `can-split` passes when there
  are two or more and the repo's fixer cap (`SUBAGENT_MAX` in its thresholds) is above one.
- `A-link-slices` (the `link-slices` agent, on Haiku) reads the draft and the table and writes the links between
  draft slices: what one slice's fix will likely change that another's files use. It runs only when
  the round can split, and it fails open.
- `D-plan-slices` merges linked draft slices while the merged slice holds at most half the round's rows
  (`SLICE_MERGE_SHARE` in `constants.ts`), or the largest draft slice when that is bigger, then packs
  what is left into at most the fixer cap, the biggest first, each into the smallest so far. It writes
  the `fix-slices` list and the slice plan (`slices.json`): each slice's rows, files and peers, each
  peer with its session name, its node-run folder and the links left split between the two. No links
  (the slicer skipped or failed open) packs the draft as it is.
- The `fix-slices` fan-out runs `A-fixer` and its merge (`D-merge-slice`, the `merge-slice` operation)
  once per slice. Each fixer writes its own fix file, which the schema check holds to that slice's
  rows, and its commit, which `D-merge-slice` checks against the slice plan at its merge. A commit
  that touches a file another slice owns (a moved file counts at the path it left; a file no slice
  owns is allowed) is not merged, and one whose merge conflicts with a slice merged before it (two
  fixers edited the same lines of a file no slice owns) is aborted. Either leaves the run tree as it
  was and fails nothing: `D-merge-slice` writes the cause (`slice-conflict`), and `D-merge-fix`
  answers `blocked` the rows that slice's commit fixed, naming its full sha and the peer's files or
  the conflicted paths, and keeps the slice's `dropped`, `relabel` and `decision` lines. The commit
  stays in the repo for the next round's fixer to reuse (`agents/fixer.md` §Graph runs). A `blocked`
  row goes on as any does: a row of the next round when that round fixes its kind, else a leftover.
  Any other failure of a slice still fails the run.
- `D-merge-fix` joins the slices' fix files into the round's one `fix-file` (one line per row in table
  order, one exit checks block naming each slice), and reads what the round owes over the round's
  whole range. Every node after it reads the round as before. A round of one slice is today's round:
  its fix file passes through as written.

A round that split shows in `history.json` as a `fanOuts` entry for `fix-slices` with that
iteration and more than one item.

## The build graph's ship path

After the close loop ends, clean or at its cap, `D-final-table` writes the final round; after a capped loop
`K-pre-push-ship` runs the pre-push checks once more, and red is its answer, not a stop. `D-open-pr` pushes
and opens the PR, a draft when an urgent row is still open (`final-clean` fails) or, after a capped
loop, `K-pre-push-ship` is red or gave no answer (it failed), and `K-ship-gate` checks the run record.
`D-merge-pr` then merges at once when `final-clean`, `K-pre-push-ship` (which a capped loop owes) and
`K-ship-gate` passed and the start does not hold the run (`"hold": true` in a JSON start). Otherwise it asks the operator, through the same wait as any question, naming the
PR, why it waits and where the final round is:

- `merge` runs the repo's merge step, which readies a draft. A merge that fails (the step, the wait
  for the queue, a read of the PR) is followed by one read of the PR: one GitHub reports `MERGED`
  ends the run merged; any other is asked again with the failure's first line (the step, its command
  and exit) and the file in the node's folder that holds its whole output. The output itself never
  goes out in the `blocked` event; the node's waiting reason in `history.json` keeps its end. A step
  the repo does not map fails the node.
- `abandon` ends the run `abandoned`: a comment on the run's ticket (when it names one) lists the
  branch, the PR and the worktrees it leaves, and no cleanup runs.
- Any other reply is asked again, naming the two.

`D-remove-worktrees` runs only after a merge. So a run ends merged, failed, cancelled or abandoned, never on a
draft PR nobody was told about.

The wait after `D-open-pr` holds for a repo whose `push` step does not itself re-run the checks. A repo
whose push step refuses a red ship (a push gate) ends `failed` at `D-open-pr`: the step's output is in
`D-open-pr`'s reason in the record, and the `finished` event lists the branch and the worktrees.

## Files

| file | what it is |
| --- | --- |
| `contracts.ts` | the one shared module: node kinds, data schemas and their validator, the graph, config and activity payload types, the run history |
| `define.ts` | `defineGraph` (typed builder) and `validateGraph` |
| `schedule.ts` | the interpreter's decisions as pure functions: what starts, what skips, whether a loop goes again, activity options |
| `workflow.ts` | the one generic workflow |
| `activities.ts` | one activity per node kind, plus prepare, notify, and record |
| `bindings.ts` | the parsers of each adapter binding in a run config |
| `adapters/` | the seams (`types.ts`) and every adapter behind them; `bind.ts` picks one per role |
| `classifiers/` | one classifier setup per classifier role, see [the shipped setups](#the-shipped-setups-and-the-real-run-config) |
| `scripts/smoke/` | one live smoke script per adapter |
| `mermaid.ts` | the graph, and a run's history, as Mermaid |
| `stats.ts`, `runDirs.ts` | `build-graph stats`: durations, classifier fire rates and labels, cost, struggles, crosstalk (pure), over the run dirs `runDirs.ts` reads |
| `runKeys.ts` | the run store keys of a node run, its output folder, its agent's pgid record, its attempt records and the side files each attempt's record keeps, for the activities that write them and the readers; and a node run's session name |
| `notify.ts` | the build events the graph fires: `blocked` and `finished` |
| `cli.ts`, `commands.ts`, `dev.ts`, `worker.ts` | the `build-graph` command |
| `exportGraph.ts` | `build-graph export`: a graph as the JSON `GraphExport` (pure) |
| `pipelines/build.ts` | `/build` as a graph: 63 nodes (a step the build takes at several moments is one node per moment, see [node names](#the-build-graphs-node-names)), its loop, fan-outs (the parallel fixers among them, see [fix round](#the-build-graphs-fix-round)) and services |
| `pipelines/build.config.json` | the build graph's real-run config |
| `pipelines/build/` | the build pipeline's checks (`checks.ts`, `schema.ts`), data operations (`ops.ts`, `table.ts`), pure decisions (`decide.ts`), a fix round's slices (`slices.ts`), the base branch's upstream (`base.ts`) and where the brief is (`briefs.ts`) |
| `mock/` | the mock tools: the fixture generator, the mock driver, and a run's record ([README](mock/README.md)) |
| `fixtures/` | two recorded runs as mock fixtures; kept in the private repo only ([README](fixtures/README.md)) |
| `examples/toy.ts` | the toy graph: agent, classifier-gated agent, loop with a check, a PR gated on the loop ending clean |

## Tests

```
cd graph && pnpm typecheck && pnpm test
```

The workflow tests run the toy graph, and the build graph on the small recorded run's fixture, in
Temporal's time-skipping test environment, which downloads its test server on first use. Each
adapter's tests stub its outside boundary (the child process, or `fetch`), and `realAdapters.test.ts` runs the toy graph on the real Claude, Jev, and shell adapters with a fake
`claude` on PATH and a local HTTP server for the TypeSafe API.

Every test file's first import is the repo's setup module, `runtime/__tests__/helpers/operatorEnv.ts`:
it deletes the variables that reach the operator's sinks and gives the process a `HOME` of its own
under `<repo>/.test-home/`, with a git config of its own (an identity, no signing), so a test never
writes to the operator's state or signs with the operator's key. `runtime/__tests__/operatorEnv.test.ts`
checks the import in every file. A run fires events only to the consumer its input carries
(`WorkflowInput.events`); a test that wants them passes `recorderCmd` from
`__tests__/helpers/eventRecorder.ts` and reads them back with `recordedEvents()`. A test that calls a
pipeline's data operation builds its `OpContext` with `opContext()` from `__tests__/helpers/opContext.ts`,
passing only the fields it varies.

### Live smoke scripts

One per adapter, in `scripts/smoke/`. They call the real service, so CI does not run them. The Linear and
GitHub adapters have none: a live call would write real data.

```
TYPESAFE_API_KEY=... node scripts/smoke/jev.ts     # one Jev call, about $0.0003
node scripts/smoke/claude.ts                       # one claude -p --agent call on Haiku, about $0.007
node scripts/smoke/codex.ts                        # one codex exec with a trivial prompt
```

## Mock runs

```
node cli.ts dev                                                  # in one terminal
node mock/mock.ts fixtures/<run> [--out <dir>] [--real-classifiers] # in another
```

A run carries the `BUILD_EVENT_CMD` of the process that started it, and the worker fires the run's
`blocked` and `finished` events to that consumer alone. The mock starts its run with the variable
blank, so a mock fires nothing, whatever the worker's env.

`--real-classifiers` binds the classifiers as the real-run config does (all on Jev), so the worker that
`dev` runs needs `TYPESAFE_API_KEY`; the agents, tracker and forge stay stubs, and the stub agents
replay through `mock/replay.ts`, which fits the recording to the readers the classifiers pick.

The mock seeds a throwaway stand-in repo, runs the build graph on it with stub agents and classifiers,
the pipeline's real checks and operations, and the file tracker and forge, and writes the run's
record (`record.md`: every node, gate, data item and check), history and drawing into its folder.
[`mock/README.md`](mock/README.md) says how a mock and a fixture work; [`fixtures/README.md`](fixtures/README.md),
in the private repo, says what each fixture replays.
