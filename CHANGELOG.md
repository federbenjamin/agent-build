# Changelog

## Unreleased

- A writer's restart after a merge conflict is in the run's record, where before only the run folder's `rerun-<n>/` showed it. The writer's node run in `history.json` carries `restarts` (which fresh run the row is from), which `build-graph status` and a mock's `record.md` print as `(1 restart)`; the merge node's attempt record names the conflicted commit and paths (`conflict`), and the writer's fresh-run record the conflict it was handed, with its `restart`; `build-graph stats` counts restarts per run and per node, each line ending with the count. `mergeInto` returns the run tree's head or the conflict (`MergeConflict`: the commit and the paths), never both, and the two restart loops (a writer's merge node, the amend service) are one.
- The `publish` step refuses an export that cites a ticket on the operator's trackers, the way it refuses a macOS home path: outside a test file every id of a tracker key is a citation; in a test file one in a comment, a test title or directly in parentheses is, and any other is example data and passes. The refusal names each file, line and rule, where before it named the files holding a home path. The privacy rules have one home, `runtime/lib/privateText.ts`, which the fixtures' privacy test and the fixture generator read instead of spelling their own, and `runtime/lib/testPaths.ts` holds the test-path patterns the `size` step counted by. Twelve lines that cited a ticket are reworded to say why.
- A writer (a builder, a test writer, the verify phase, the amend writer) whose commit conflicts at its merge into the run tree is run again, fresh, on the run tree's new head, told the commit and the conflicted paths (`conflict` in its inputs file), and its new commit is merged, up to `WRITER_RESTART_CAP` (2) times per merge; before, the merge node failed and the run with it. A fresh run that commits neither the conflicted commit nor a change of its own hands the merge that commit again, so it conflicts and counts against the cap instead of merging nothing. Past the cap the merge node fails naming the paths and the commit. `D-merge-slice` keeps its `blocked`-rows ending and `D-pull-main` its stop for a person. `mergeInto` returns the run tree's head and the conflicted paths (null when it merged) instead of throwing, and `MergeConflict` is gone (the entry above has since made it return the head or the conflict, and reused the name `MergeConflict` for the conflict's type); attempt records gain the outcome `merge-conflict`.
- A fixer's commit that touches a file another slice owns no longer fails the fixer's output check (one rerun, then a failed run). `D-merge-slice` checks it against the slice plan at its merge and, like a commit whose merge conflicts, does not merge it: the slice's `fixed` rows come back `blocked` for the next round, the reason naming the peer slice, its files and the commit's full sha (a conflict's reason now names the full sha too). The slice's `dropped`, `relabel` and `decision` lines are kept. `agents/fixer.md` tells the next round's fixer how to reuse the unmerged commit.
- A retried or rerun graph node keeps the `struggles.json` and `crosstalk.jsonl` its earlier attempts left. Each attempt still empties the node's output folder, but first moves the attempt before it's two side files into that attempt's own folder, `nodes/<node>/<iteration>[/<item>]/rerun-<r>/attempt-<n>/out/<output>/`, beside its record. `build-graph stats` reads every attempt's, earlier ones first, where before it saw the last attempt's only. `questions.json` still goes with the emptying: the workflow routes it before the next attempt starts.
- A merge into the run tree that git refuses with no conflicted path (a dirty or untracked file in its way) fails the node again, in git's own words, instead of becoming `blocked` rows that name no path; a `git merge --abort` that fails also fails the node, naming the run tree. A fixer's lane check with no `slice-plan` input failed, naming that input, where before it passed the commit unchecked (the entry above on a fixer's commit that touches another slice's file has since moved that check to `D-merge-slice`). The unbank rule accepts a drift group's confirm sha (or its read sha, when the group fixed nothing) as the head the run banked at, so long as no PR code sits between the escalate round's end and the drift fix or after the confirm; a test now holds the first of those. The `publish` step publishes only `origin/main`: it fetches main, refuses a HEAD that is not `origin/main`, and exports that commit with `git archive`, so the files it checks for a home path are the files it pushes, whatever the working tree does meanwhile; `--dry-run` fetches and exports too. The README's top picture is retaken with the agents' new names, and `C-silent-failures`' doc names the `silent-failures` reader.
- A `publish` step (`node runtime/publish.ts`) publishes the private working repo to this public one: it commits the tracked tree less `docs/build/` and `graph/fixtures/` on a `chore/sync-<sha>` branch of the public repo's own history and opens a PR, so clones keep pulling. It refuses a dirty tree and any exported line holding a macOS home path, naming the file and line, and `--dry-run` lists what it leaves out. The no-push guard keeps a subagent from running it, as it does the `push`, `pr_open` and `merge` steps.
- A fixer in a fix round shared out among slices has its commit checked against the slice plan: a commit that touches a file another slice owns fails the fixer's output check, naming that slice, where before only `agents/fixer.md` asked it not to (the entry above on a fixer's commit that touches another slice's file has since moved that check to `D-merge-slice`, where it ends in `blocked` rows). A file no slice owns stays allowed. The lane checks of the builder, the test writer and the fixer now count a moved file at the path it left, so a rename no longer hides a file outside the writer's lane.
- Each node of a graph carries `doc`, one sentence of what it reads, what it writes and when it runs, beside the node in its graph module; every node of the build graph and the toy graph has one, and a change to a node updates its `doc` in the same PR. `build-graph export <graph module>` prints the graph as JSON (`GraphExport` in `graph/contracts.ts`): its nodes with their docs, data items, loops, fan-outs, services and edges. A node with no `doc` stops the export. See [node docs and the export](graph/README.md#node-docs-and-the-export).
- The build graph's nodes are renamed so each id says what the node does to what: 44 of its 60 ids change, and the 16 that already did (`A-prior-art`, `A-hand-test`, `D-ask-operator`, ...) stay. An id is `<kind>-<act or object>[-<moment>]`: the kind prefix stays, a node that repeats an earlier one adds `-fix`, `-drift` or `-ship`, one word means one thing (`merge` into the run tree, `pull main`, `review`, `tests`, `pre-push`), and a classifier carries the name of the reader it switches on (the rule in full: [node names](graph/README.md#the-build-graphs-node-names)). Roles, classifier setup files, the run config and data ids keep their names here; the next entry renames them. `MAP_NODE_OF`, which named each node's place in a planning doc outside the repo, is gone. A run stored before the rename keeps its old ids: it still draws itself, but `build-graph stats` counts its nodes apart from a new run's, and a run in flight across the change fails at `K-tests-build` if it has not run it yet (that id has no test step now).

  | old | new |
  | --- | --- |
  | `K-setup` | `K-load-config` |
  | `D-ticket` | `D-fetch-ticket` |
  | `D-run-tree` | `D-pin-run-tree` |
  | `A-brief` | `A-write-brief` |
  | `K-brief-check` | `K-parse-brief` |
  | `D-brief` | `D-commit-brief` |
  | `D-integration-part` | `D-merge-part` |
  | `K-env` | `K-bring-up-stack` |
  | `A-test-author` | `A-write-tests` |
  | `D-integration-author` | `D-merge-tests` |
  | `D-integration` | `D-install` |
  | `A-test-verify` | `A-prove-tests` |
  | `D-integration-verify` | `D-merge-proofs` |
  | `K-tests-build` | `K-tests` |
  | `D-freshen` | `D-pull-main` |
  | `K-size` | `K-measure-diff` |
  | `A-cursory` | `A-review` |
  | `C-hunter` | `C-silent-failures` |
  | `A-hunter` | `A-silent-failures` |
  | `C-codex-pair` | `C-review-codex` |
  | `A-codex-pair` | `A-review-codex` |
  | `C-verifier` | `C-completeness` |
  | `A-verifier` | `A-completeness` |
  | `A-repo-reader` | `A-repo-review` |
  | `D-fix-table` | `D-build-fix-table` |
  | `C-rereview` | `C-review-fix` |
  | `A-confirm` | `A-review-fix` |
  | `K-manifest` | `K-manifest-fix` |
  | `A-verifier-fix` | `A-completeness-fix` |
  | `K-drift` | `K-main-moved` |
  | `D-freshen-drift` | `D-pull-main-drift` |
  | `A-cursory-drift` | `A-review-drift` |
  | `K-checks` | `K-pre-push` |
  | `K-close` | `K-loop-done` |
  | `D-final` | `D-final-table` |
  | `K-checks-ship` | `K-pre-push-ship` |
  | `D-tickets` | `D-file-leftovers` |
  | `D-pr` | `D-open-pr` |
  | `K-gate` | `K-ship-gate` |
  | `D-cleanup` | `D-remove-worktrees` |
  | `K-schema` | `K-output-format` |
  | `K-route` | `K-route-question` |
  | `A-resolver` | `A-answer-question` |
  | `A-brief-amend` | `A-amend-brief` |
- The build graph's roles, classifier setups, data items, fan-outs and operations take the names of their nodes, so a run folder, a decision record and `build-graph stats` read like the graph (`A-review-fix` writes `findings-review-fix`, `K-bring-up-stack` runs `bring-up-stack` and writes `stack-bindings`). A role only the graph knows is its node's id less the kind prefix, shared by the node's later moments; a check's verdict is named like its node, a classifier's is `<role>-call` and its setup `classifiers/<role>.json`, a reader's findings are `findings-` and the node; the rule in full is in [node names](graph/README.md#the-build-graphs-node-names), and `graph/__tests__/buildGraph.test.ts` holds the graph to it. An agent's role stays its agent file's name (`review-cursory`, `gate-silent-failure-hunter`, `build-verifier`, `test-author`, and `review-cursory-codex` for the Codex pair), which `/build` and the fix table also use; so do the engine's operations (`ingest`, `ticket`, `merge-back`), the output folders an agent file names (`tests-authored`, `tests-verified`, `slice-fix`, `risk-moment`), the build notes' `## freshen` section and the `freshen:` merge commit subject. The setup files moved without a byte changed.

  | kind | old | new |
  | --- | --- | --- |
  | setup | `classifiers/hunter.json` | `classifiers/silent-failures.json` |
  | setup | `classifiers/codex-pair.json` | `classifiers/review-codex.json` |
  | setup | `classifiers/verifier.json` | `classifiers/completeness.json` |
  | setup | `classifiers/rereview.json` | `classifiers/review-fix.json` |
  | classifier role | `hunter`, `codex-pair`, `verifier`, `rereview` | `silent-failures`, `review-codex`, `completeness`, `review-fix` |
  | agent role | `repo-reader` | `repo-review` |
  | check role | `setup`, `brief-check`, `env`, `size`, `manifest`, `drift`, `checks`, `close`, `ship-checks`, `gate`, `schema`, `route` | `load-config`, `parse-brief`, `bring-up-stack`, `measure-diff`, `manifest-fix`, `main-moved`, `pre-push`, `loop-done`, `pre-push-ship`, `ship-gate`, `output-format`, `route-question` |
  | operation (role) | `run-tree`, `integrate`, `freshen`, `fix-table`, `slices`, `final`, `ship-pr`, `cleanup` | `pin-run-tree`, `install`, `pull-main`, `build-fix-table`, `plan-slices`, `final-table`, `open-pr`, `remove-worktrees` |
  | fan-out | `author-slices`, `verify-slices` | `write-tests`, `prove-tests` |
  | check verdict | `setup`, `brief-check`, `env`, `tests-build`, `size`, `manifest`, `drift`, `checks`, `close`, `checks-ship`, `gate`, `schema-verdict`, `route-verdict` | `load-config`, `parse-brief`, `bring-up-stack`, `tests`, `measure-diff`, `manifest-fix`, `main-moved`, `pre-push`, `loop-done`, `pre-push-ship`, `ship-gate`, `output-format`, `route-question` |
  | classifier call | `hunter-call`, `codex-pair-call`, `verifier-call`, `rereview-call` | `silent-failures-call`, `review-codex-call`, `completeness-call`, `review-fix-call` |
  | findings | `findings-cursory`, `findings-hunter`, `findings-codex`, `findings-verifier`, `findings-repo`, `findings-confirm`, `findings-verifier-fix`, `findings-drift` | `findings-review`, `findings-silent-failures`, `findings-review-codex`, `findings-completeness`, `findings-repo-review`, `findings-review-fix`, `findings-completeness-fix`, `findings-review-drift` |
  | owed gate | `owed-rereview`, `owed-confirm`, `owed-manifest`, `owed-verifier`, `owed-security`, `owed-hand-test` | `owed-review-fix-call`, `owed-review-fix`, `owed-manifest-fix`, `owed-completeness-fix`, `owed-security-fix`, `owed-hand-test-fix` |
  | other item | `needs-env`, `env-bindings`, `author-commit`, `author-head`, `authors-ok`, `integration-head`, `verify-commit`, `verify-head`, `verify-ok`, `test-rows-build`, `freshen-head`, `check-rows`, `cleanup` | `needs-stack`, `stack-bindings`, `tests-commit`, `tests-head`, `tests-ok`, `install-head`, `proofs-commit`, `proofs-head`, `proofs-ok`, `test-rows`, `pull-main-head`, `pre-push-rows`, `remove-worktrees` |

  What a run stored before the change keeps and loses: it still draws itself, and `build-graph stats` reads it as before, since stats reads each run's own stored graph, groups by node id, labels a decision by its reader's agent role and finds the table under `final` and `table`, none of which changed (checked on a mock run recorded before the change: the same classifier rows). Its decision records name the old setup (`hunter`, `codex-pair`, `verifier`, `rereview`); the sha256 beside each still matches the renamed file, so a tuning round that pools decisions by setup name maps those four names, and one that pools by hash needs nothing. A run in flight across the change fails at its next check or operation whose role was renamed, since the worker's pipeline knows only the new roles: finish or cancel a run before upgrading. A mock fixture made before the change replays only after its stub outputs and `spec.json` move to the new item names, as this change does for both shipped fixtures.
- The agents take the names of the nodes that run them, so a run folder, a decision record, the fix table and `build-graph stats` use one name per reader: an agent's role is the id less `A-` of the first node that runs it, every later node that runs it shares that role (`A-review-fix` runs `review`, `A-prove-tests` runs `write-tests`, `A-amend-brief` runs `write-brief`), and its agent file is `agents/<role>.md` (the rule in full: [node names](graph/README.md#the-build-graphs-node-names); `graph/__tests__/buildGraph.test.ts` holds the graph to it). Ten agent files are renamed, with every place that names them: `agents.json`, `/build`'s stops, the fix table's reader prefix table (`READER_ID_PREFIX`), the risk classes, the ledger's reader tokens, the run dir's reader files, the build graph and its run config, the mock fixtures, the diagrams and the README. The finding id prefixes (`CURSORY`, `HUNTER`, `VERIFIER`, `SEC`, `CODEX`) stay, so a stored table's ids still parse, and so do the engine's `resolver` service, its question route and an answer's `by: "resolver"`. A reader and the classifier that gates it now share a role string (`silent-failures`); bindings sit under their kind, and `stats` maps only agent nodes to reader prefixes.

  | old agent | new agent | node |
  | --- | --- | --- |
  | `review-cursory` | `review` | `A-review` |
  | `review-cursory-codex` (the Codex pair's role key) | `review-codex` | `A-review-codex` |
  | `gate-silent-failure-hunter` | `silent-failures` | `A-silent-failures` |
  | `build-verifier` | `completeness` | `A-completeness` |
  | `security-review` | `security` | `A-security` |
  | `test-author` | `write-tests` | `A-write-tests` |
  | `hand-tester` | `hand-test` | `A-hand-test` |
  | `brief-writer` | `write-brief` | `A-write-brief` |
  | `slicer` | `link-slices` | `A-link-slices` |
  | `resolver` | `answer-question` | `A-answer-question` |

  What a run stored before the change keeps and loses. A graph run still draws itself (`build-graph draw` draws the run's own stored graph). `build-graph stats` still reads its durations, costs and each classifier's decisions, fires and p, but labels none of the decisions of a reader whose agent was renamed: it finds a gated reader's id prefix by the reader's agent role, and the stored graph carries the old one. Checked on a mock run recorded before the change: `C-completeness`, `C-review-codex`, `C-review-fix`, `C-security` and `C-silent-failures` drop from 1 or 2 labelled decisions to 0, and `C-simplifier` keeps its label. A `/build` run dir keeps its reader files under the old names (`review-cursory.md`, `stage-confirm-1/build-verifier.md`), which `reviewTable.ts` and the ship gate no longer read, and its ledger's old reader tokens no longer parse, so a run in flight across the change, `/build` or graph, fails at its next read or gate: finish or cancel it before upgrading. Review telemetry rows ingested before the change keep the old reader names, so `reviewTelemetry.ts --report` shows them as their own sources. A mock fixture made before the change replays only after its `agents/<role>/` folders and reader files move to the new names, as this change does for both shipped fixtures. A Claude Code session or Codex config that names an old agent (`agent-build:review-cursory`, the generated Codex `review-cursory.toml`) needs the new name.
- `graph/`, a new package: a graph engine that runs a pipeline of agent, classifier, check, and data nodes on Temporal, with validation, a Mermaid drawing of each graph and run, stub adapters, a toy graph, and a `build-graph` command (`start`, `answer`, `status`, `draw`, `dev`). `/build` does not use it yet.
- `graph/` gains its real adapters: Claude Code and Codex agent runners, Jev and Haiku classifiers (with the two tuned Jev setups as config), a shell check runner over a repo's build steps, a Linear tracker, and a GitHub forge. `runtime/codexRole.ts` exports `planCodexRole` so the Codex runner reuses its role resolution.
- `/build` as a graph (`graph/pipelines/build.ts`): the whole skill, intake to merge, as one graph the engine runs, with today's fix table, the agents' inputs-file dispatch (`docs/graph-agents.md`, which `install.sh` now links), and mock tools (`graph/mock/`) that replay a recorded run on it. Today's `/build` is unchanged.
- `graph/` gains the `resolver` agent, which answers an agent's question from what the code, brief, plan, docs or tracker say and names its source, or hands it to the operator with what it searched; a brief change it proposes waits for the operator's `approve`. A repo's own reader agents (`## repo readers` in its build notes) run in the graph's repo-reader fan-out, and the test slices' verify phase runs as `test-author`.
- `graph/` runs end for their operator: `build-graph cancel <run>` stops a run where it is (nodes marked `cancelled`, every process group killed, no cleanup); the build graph opens its PR and, when the final round is not clean, the last checks are red or the start holds the run, waits for the operator's `merge` or `abandon` instead of leaving a draft; push, PR and merge run the repo's own `push`, `pr_open` and `merge` steps, with the PR in `BUILD_PR_TITLE`, `BUILD_PR_BODY_FILE`, `BUILD_PR_NUMBER`, `BUILD_PR_BRANCH` and `BUILD_PR_CLASS`; a node's time cap is raised for agents (90 min) and the ship nodes (45 min), and a cap hit is never retried. Build events move to schema 4: `finished` also ends `failed`, `cancelled` or `abandoned`, and names the run's branch and the worktrees it left. `install.sh` links `graph` and installs its dependencies, and `--check` fails while they are missing.
- The build graph's silent-failure hunter gate (`C-hunter`) runs on Jev instead of Haiku: `graph/classifiers/hunter.json` is round 5's `J5-sampled` setup (five exposure questions over the cut risk moment and the diff less tests, docs and lockfiles, their mean, cut-off 0.2228), and the node's time cap is the other classifiers' 2 minutes. A run with real classifiers no longer needs a logged-in `claude` for them; the Haiku adapter stays, with no setup bound to it.
- A brief goes in the store unless the repo's build notes name a briefs dir in the repo, so a run no longer commits `docs/build/briefs/` into a repo that never asked for it. The first run that needs the store makes it a local git repo (`repoId.ts --init-store`); SHIP pushes it only when it has a remote.
- A finished run leaves the repo as it found it: after the session's last merge it removes the worktree `/build` entered and deletes the harness's `worktree-<name>` branch and each merged run branch. Review telemetry moves from `.claude/run-state/` in the checkout to `.git/agent-build/`; an old file is moved over on first use.
- The build graph shares a fix round out among fixers that run at once: `D-build-fix-table` writes the round's draft slices (rows that point at one file, together), the new `slicer` agent (`A-link-slices`, on Haiku) finds the links between them, `D-plan-slices` merges linked slices up to half the round and packs the rest into the repo's `SUBAGENT_MAX`, and the `fix-slices` fan-out runs one fixer per slice, each told its peers (session name, node-run folder, the links left split; `docs/graph-agents.md` §Peers) and writing its own fix file, which `D-merge-fix` joins into the round's one. The engine now lets a fan-out sit inside a loop, lets a non-writing agent fail open (`failOpen`), and names each agent session `<run>-<node>-<iteration>[-<item>]` (`claude -n`). `builder`, `fixer`, `gate-silent-failure-hunter`, `hand-tester`, `review-cursory` and `security-review` gain `SendMessage`.
- A builder writes its work log and handoff note to `<run-dir>/builder-P<k>/` instead of `.claude/run-state/` in its worktree, so a `git add` in a repo that does not ignore that folder no longer commits them into the PR.
- `build-graph stats` prints the fixers' crosstalk: every message a fixer logged in `crosstalk.jsonl` when it messaged a peer, with its run, the fix round (the close-loop iteration when no round is recorded), the slice, the peer it went `to` and the first line of its `text`, or `none`. The line's shape is `CrosstalkMessage` in `graph/pipelines/build/slices.ts`; a bad line is listed under "not read" and the rest still print. The log is what the sender says it sent.
- Two parallel fixers that edit the same lines of a file no slice owns no longer fail the run. The build graph's `D-merge-slice` runs its own `merge-slice` operation: a merge that conflicts with a slice merged before it leaves the run tree as it was and writes the conflict (`slice-conflict`), and `D-merge-fix` answers that slice's rows `blocked`, naming the paths and the commit, for the next round that fixes their kind. The engine's `merge-back` (the parts, the test slices, the amend merge) still fails the node on a conflict.

## v0.1.0 (2026-10-10)

First release.

- The `/build` skill with its four stops: BRIEF, BUILD, CLOSE, SHIP.
- Twelve agents: brief-writer, prior-art, builder, test-author, review-cursory, simplifier, security-review, gate-silent-failure-hunter, build-verifier, fixer, hand-tester, gate-warden.
- The runtime scripts the steps run, and a guard that keeps a subagent from pushing.
- A per-repo steps file, `.claude/build-steps.toml`, that maps install, checks, tests and push to the repo's own commands.
- README with a hero picture of one staged run, agent roles, risk classes, and design notes under `docs/`.
