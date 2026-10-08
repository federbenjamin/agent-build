---
name: build
description: >-
  Take one unit of work from a request or a ticket to a merged PR through four stops: BRIEF (the
  oracle, the risk class and the decisions the brief rests on, the model, the hand-test
  claims), BUILD (one builder per part, plus the test writers, each in its own worktree),
  CLOSE (one parallel read by the class's readers, then fix rounds by a fresh fixer from a table
  a script builds, each checked by a fresh read and by the hand tester running the brief's
  claims), SHIP (checks, push, draft PR, marker, gate, merge). Every repo command is a step from
  the repo's .claude/build-steps.toml; a repo without one runs on stated fallbacks and says so in
  the ledger. Starts in its own worktree of the target repo, which whoever launches it sets up;
  `/build --from-branch <name>` runs CLOSE and SHIP over a branch nobody briefed.
argument-hint: "<what to build>"
disable-model-invocation: true
---

# /build — one unit, four stops

**Keep your context small, at every stop.** Read a script's output, never the files it reads (rows, tables, dispatches, reader files); `grep -c` answers a count. Build a dispatch with `cat <header> <rows> > <new file>`. Cut long output at the call. A check across several files goes to a subagent that reports one line.

You own everything around the agents: the brief, the class, the worktrees, the spawns, the merges, the ledger. The `brief-writer` writes the brief (BRIEF step 2), the `builder` builds, the readers read, the `fixer` fixes, the `hand-tester` runs the brief's claims, and a script sorts the findings into rounds; every judgment call left is yours (a builder's doubt, a `decision` row, ask or decide, which claims a fix reaches, a conflict hunk), made at the code, never from belief. You never read the builder's whole diff or a reader file, never build a fix table by hand, never write a fix, and never run a hand-test claim (CLOSE, top). Four stops, in order: **BRIEF · BUILD · CLOSE · SHIP**. Nothing between them is a separate skill.

**Each stop's steps live in its own file beside this one: `BRIEF.md`, `BUILD.md`, `CLOSE.md`, `SHIP.md`; and, read only when their case fires, `FROM-BRANCH.md`, `UNBANK.md`, `DRIFT.md` (main drift at SHIP).** Read a stop's file in full as you enter that stop: a stop run from memory runs without its rules. The files' `§` names are their headings (`CLOSE §Trees` is that heading in `CLOSE.md`).

**One unit = one brief = one PR.** For plan-driven work the PLAN defines the units and the unit list is authoritative: nobody here splits or merges a unit. No unit is too big for one PR: the brief cuts it into parts (BRIEF §Parts and test slices).

**Spawn names.** This skill names its agents bare (`builder`, `review-cursory`); the Agent tool knows them only as `agent-build:<name>`, the plugin's prefix, and refuses the bare form. **Models.** The builder and the fixer are spawned with `model:` passed; neither agent pins one, so a spawn without it is refused. Each part's `model:` picks its builder's, and the brief's header `model:` line, the strongest part, picks the fixer's (BRIEF step 7).

**Look it up before you decide.** Search the doc corpus the notes name first, then open and cite the files a hit names. `LSP` for callers and definitions, ast-grep for structure, context7 for a library's current docs.

**Never end a turn to wait on a spawned agent.** A completion notification can be dropped. Wait by disk fact — the file the agent was told to write, its commits — and watch every agent you spawn. At each spawn, arm `~/.agent-build/runtime/agent-watchdog.sh --flags <each spawn's .output path>… [--part-files <.output path>=<file>]… [--codex <log>:<out>]…` via Bash `run_in_background` (a Codex run passes its `--log` and `--out` files; `--part-files` gives a builder part or DB writer its files list, BUILD step 8). Exit 0: every watched agent finished. Exit 1: an agent's transcript is missing, went stale, or passed a `--deadline`: look at it the same way. Exit 3: one agent is flagged — `FLAG <agent> <flag> count=<n> limit=<m>`, then its last 8 tool calls. Look at that one agent, then either re-arm with the same paths plus the `ack:` flag it printed (`--ack <agent>:<flag>:<n>`), or stop it and start a fresh agent with a note of what is done and what is left (a stopped fixer: CLOSE 4d). Any other exit — 144, a kill, a signal — is the watch dying, not a verdict on any agent: re-arm it with the same paths, and check each watched agent's output file (and a fixer's commits) before concluding anything about it. The limits are the `WATCH_*` numbers.

`<run-root>` is the `run-root:` line `node ~/.agent-build/runtime/lib/repoId.ts .` prints ($AGENT_BUILD_RUN_ROOT, else `~/.local/state/agent-build/runs`); **`<run-dir>` = `<run-root>/<worktree>-<branch>/build-<runid>/`** (`<worktree>` = checkout dir basename, `<branch>` with `/` replaced by `-`). **`<branch-slug>`** is the same rule on any branch name: every `/` becomes `-` (`fix/draft-keep` → `fix-draft-keep`); the brief and the `--from-branch` hand-test file are named by it. Every reader writes its findings file there; the ledger `ship.md`, `session.md`, the stage folders, the fixer's and the hand tester's files, and the table `table.json` live there (CLOSE §The run files). Durable by design — it is the merge record and outlives the worktree. Never under `/tmp`. Script outputs (`diff.patch`, dispatch files, Codex logs) go in `<inputs-dir>` = `/tmp/claude/build-<runid>/`. Mint `<runid>` once per unit with `mktemp -d /tmp/claude/build-$(date +%s)-XXXXXX`, which makes the unit's `<inputs-dir>` and prints it; `<runid>` is its name after `build-`. `mktemp` never reuses a dir, so no two units share a `<runid>`.

## Setup — the repo's steps, numbers, and notes

Every script this skill names lives in `~/.agent-build/runtime` and runs as `node ~/.agent-build/runtime/<script>` from the run's tree. Type the path out; a shell variable in its place is refused in a worktree session. In a `buildEvent.ts` line every value goes in single quotes, each `'` in it typed `'\''`: in double quotes, a `$(…)` or a backtick in a title, branch, or `needs` would run.

**You start in place.** /build starts in its own worktree of the target repo; whoever launches it sets that up. That worktree is the launch tree (CLOSE §Trees).

0. **A repo that still carries its own `/build`.** If `.claude/skills/build/SKILL.md` exists at the repo root (the top folder of the tree you are in) and is not this file, the repo has not moved to this skill yet: Read that file and follow it instead, and stop reading this one. The personal skill shadows the project one by name, so this line is what keeps an unmigrated branch on its own flow.
1. **Steps.** `node ~/.agent-build/runtime/steps.ts .` prints the resolved table: each step, `repo` or `fallback`, and its command or `(none)`. This skill names steps, never commands — `<size>`, `<checks>`, `<push>` below mean "the command that table resolves". A `(none)` step is skipped and the skip is said on its ledger line; `codex_role` is `(none)` when `codex` is not on PATH: Codex is optional (BUILD step 8, CLOSE step 2); a step whose command exits non-zero is a STOP with the command echoed, never a silent skip. `node ~/.agent-build/runtime/steps.ts . --get <step>` prints one command.
2. **Numbers.** `node ~/.agent-build/runtime/thresholds.ts .` prints every threshold this skill names (`PART_MAX_LINES`, `TEST_SLICE_MAX_FUNCTIONS`, `SMALL_WORK_BELOW_BUCKET`, `BATCH_SHIP_BUCKET`, and the CLOSE ones) with `repo` or `default` beside it. `SUBAGENT_MAX`, `CODEX_MAX`, `CODEX_PAIR_MIN_SIZE`, and `CODEX_PAIR_MIN_CLASS` come from this table too; a session contract that sets `subagent_max`, `codex_max`, `codex_pair_min_size`, or `codex_pair_min_class` (a session override included) wins over it. `builder_model` is the contract's alone, `auto` without one.
3. **Notes.** `node ~/.agent-build/runtime/steps.ts . --get notes` names the repo's build notes. Read its `## build` section now; it is part of this skill for this repo — the repo's brief and decision docs, its doc corpus, its DB and stack procedures, its exercise and hand-test commands, its freshen additions, its ticket tracker and PR-open flags. `(none)` means this skill runs on its generic text alone.
4. **The ledger's `steps:` line** is written at freshen and owed on every run (`shipGate.ts` fails a ledger without it): `steps: .claude/build-steps.toml | fallback: <steps on their fallback> | none: <steps with no command>`, or `steps: absent — every step on its fallback | none: <…>` for a repo with no file. The line is how a run on a weakened step set is never silent.

## Multi-unit plans — stack, never idle

Never wait on a push gate, CI, or a merge while dependent work could start. Unit N's builder starts as soon as unit N-1's code is final, which means after N-1's final table (CLOSE step 12). It does not wait for N-1's push, CI, or merge. It is cut from N-1's head (the run tree's HEAD): N's own run tree is `git worktree add <path> -b <branch> <N-1 head>` (CLOSE §Trees, with N-1's head in place of `origin/main`), N's brief is its first commit there, and the brief says it stacks on an unmerged PR. Units that do not depend on each other each open their own run tree and build side by side.

Each open run has its own tree, so two runs' CLOSE may overlap (CLOSE §Trees); SHIP stays in merge order, so N-1 has merged before N's SHIP starts. A stacked unit's base is N-1's head while N-1 is unmerged, and `origin/main` once it has merged. The `freshen:` line is written once (CLOSE step 1), and every script reads its `base=`:

- **N-1 merged before N's freshen:** the freshen's merge of `origin/main` brings N-1's squash in; write `base=origin/main`. The unit is then an ordinary one.
- **N-1 unmerged at N's freshen:** write `base=<N-1 head sha>`. The verifier's dispatch carries a `base: <N-1 head sha>` line (the `build-verifier` agent's §Your inputs), and every other reader's wave range uses the same base. After the freshen, merge no `origin/main` into N until SHIP. From N's SHIP on, pass `--base origin/main` to every `stagePlan.ts` and `shipGate.ts` call, `--print-checks` included (`--base` overrides the ledger's `base=`). With the old base, once main is merged in, the scripts count main's commits (N-1's squash among them) as N's code, and never see main's drift. The gate may then owe a drift group for files N-1 changed, whose merge-side patch is near empty: treat it as any drift (SHIP step 1: one drift group per run).

In either merge of `origin/main`, a conflict hunk whose main side is only N-1's content takes N's side, because N was built on that content. Any other conflict is a real conflict, and you resolve it hunk by hunk. Never delete a merged PR's head branch while a child PR targets it — GitHub closes the child and it cannot be reopened. Retarget the child to main first, then delete.

**Small work** (a hand-test finding, a CI defect, a one-line fix) joins an open unit or the session's batch branch, and gets a CLOSE of its own only when it unblocks something now (BRIEF §Small work) — CLOSE costs about the same for 15 lines as for a feature.

## Tickets

Before any change starts, search the repo's tracker (the notes name it) for an issue covering the work. On a hit: ONE comment at work start, posted once BRIEF step 2 has checked the ticket's claims — date, branch, worktree, lane `/build`, and the corrections that check found — and the tracker's closing reference in the PR body. No progress-update comments.

Before scoping a ticket, check for unmerged work on the same surface (`git branch -r`, `git log origin/main..origin/<branch>`) and the owning epic's milestone order: a ticket describes the repo as it was when filed, and a standalone-looking gap is often a scheduled unit's other half — re-point the ticket at that unit, never build a stopgap.
