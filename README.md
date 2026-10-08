# agent-build

<p align="center"><strong>A Claude Code plugin that takes one unit of work from a request to a merged pull request.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/federbenjamin/agent-build" alt="License"></a>
  <a href=".github/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/federbenjamin/agent-build/ci.yml" alt="CI"></a>
</p>

`/build` is a [Claude Code](https://code.claude.com) skill that takes one unit of work from a request to a merged pull request:
it writes a brief, builds it with one agent per part, reviews the diff with a wave of reader agents
and up to four fix rounds, hand-tests it, and ships it. It runs in your repo through your own `git`,
`gh`, and test commands, which each repo maps once in a small steps file. This repo is the whole
system as a Claude Code plugin: the skill, its twelve agents, the runtime scripts its steps run, and
a guard that keeps a subagent from pushing.

## Install

One paste, with Claude Code installed:

```
git clone https://github.com/federbenjamin/agent-build ~/agent-build && ~/agent-build/install.sh
```

`install.sh` makes three links and then registers the clone as a plugin marketplace and enables the
plugin from it. The plugin loads from the clone in place: after a `git pull`, run `/reload-plugins`
in a session. The `owner/repo` marketplace form (`claude plugin marketplace add <owner>/<repo>`) is
not offered: Claude Code would clone a second copy into its plugin cache while `~/.agent-build`
links the first, and the skill text and the runtime would drift apart.

The links, because the skill, its agents, and the runtime name the build system by one path:

```
~/.agent-build/runtime -> <this repo>/runtime
~/.agent-build/skills  -> <this repo>/skills
~/.agent-build/agents  -> <this repo>/agents
```

It refuses a path that exists and is not a symlink, leaves a correct link `unchanged`, and repoints
one that aims elsewhere. The plugin step reads `claude plugin list --json` (with `node`) and prints
`plugin: already installed` when `agent-build@agent-build` is enabled and read from this clone,
`plugin: registered and enabled` after it adds and installs, `plugin: repointed (was <folder>)` when
the plugin was read from another clone, `plugin: enabled (was disabled)` when it was disabled, and,
with no `claude` on PATH, the two commands to run later. It reads and changes only the user-scope
install (every `claude` call that changes it passes `--scope user`), so a project or local install of
the plugin is left as it is. A failing `claude` command prints its
output and exits 1, the links already made; so does a plugin the list does not then show enabled
and read from this clone. A re-run finishes an install that stopped partway. `./install.sh --check`
changes nothing: it prints each link's state (`ok`, `missing`, `points at <x>`, `not a symlink`)
and exits non-zero unless all three are `ok`. Running builds execute the files these links reach,
so repointing them moves every running build.

The plugin brings `/build`, the twelve agents (spawned as `agent-build:<name>`; the bare name is
refused) and the no-push guard. Claude Code ignores two frontmatter fields on a plugin agent, so
neither appears in `agents/*.md`: `hooks:` (the guard is a plugin hook instead) and
`permissionMode:` (a spawn runs in the session's mode). An agent whose `agents.json` `context` row
has `claudeMd: false` carries `omitClaudeMd: true` in its own frontmatter; `buildDocPins.test.ts`
holds the row and the file together.

## Features

- **One command from a request to a merged PR.** `/build <request>` writes the brief, builds each part with its own agent, reviews the diff with a wave of readers and up to four fix rounds, hand-tests the result, and ships it through your repo's own push, PR and merge commands.
- **Your commands, mapped once.** Each repo names its install, checks, tests, push, PR and merge commands in `.claude/build-steps.toml`; a repo without one runs on stated fallbacks and says so in its ledger.
- **Twelve agents with one job each.** Brief writer, builders, reviewers, fixers, test author, hand tester and more, spawned as `agent-build:<name>`, each with its own model and context.
- **A subagent never pushes.** A hook refuses a push or a PR open, ready, edit or merge from any subagent, in the built-in `git`/`gh` forms and in your repo's own steps, and logs each refusal.
- **Codex is optional.** With the `codex` CLI on PATH, Codex writes plain test slices and pairs a second review with Claude's; without it, every job runs on Claude.
- **A launcher can follow the run.** Each milestone goes out as one JSON line through `BUILD_EVENT_CMD`, so a desk or dashboard can watch a build without the build knowing it.

## Usage

In a Claude Code session, in a worktree of the repo the work belongs to, with the request in a file (a plan, a brief, or a ticket):

```
/build <path to the request file>
```

Only a typed `/build` runs the skill. It brief-writes, builds, reviews, hand-tests and ships from that one session, and stops only for what the request and the repo's rules do not settle.

### Permission mode

/build runs `git`, `pnpm`, and `node` at every step, and its agents inherit the session's permission
mode (a plugin agent's own `permissionMode` is ignored). Run it in `auto` mode, or in `acceptEdits`
with Bash allowed. In `default` mode every command prompts.

## Configuration

### Build steps

A repo maps each step the flow names to its own command in `.claude/build-steps.toml`;
`node ~/.agent-build/runtime/steps.ts <repo>` prints the resolved table, and
`node ~/.agent-build/runtime/steps.ts --template <name>` prints the file a new repo starts from
(every step commented out, so each stays on its fallback until the repo fills it in).

### Where files go

| variable | what lives there | default |
| --- | --- | --- |
| `AGENT_BUILD_STORE` | a public repo's build steps, notes, and briefs, at `<store>/<owner>/<name>/` | `~/.local/state/agent-build/store` |
| `AGENT_BUILD_RUN_ROOT` | each run's dir: its ledger, reader findings, fix tables, hand-test files | `~/.local/state/agent-build/runs` |
| `SESSION_LOGS_DIR` | session logs, when you keep them; a run writes to one only when it is set | none |

`node ~/.agent-build/runtime/lib/repoId.ts .` prints the store and the run root as resolved.

### Codex (optional)

With the `codex` CLI on PATH, Codex does three jobs: it writes `plain` test slices, it runs the
generalist review at the reads after each fix, and it pairs a second generalist read with the
Claude one at the review wave when the change is at or above `CODEX_PAIR_MIN_SIZE` and its class at
or above `CODEX_PAIR_MIN_CLASS` (`runtime/thresholds.ts`). Without `codex`, the `codex_role` step
resolves to `(none)`, the size step prints `codex pair: skipped (no codex_role step)`, and each of
those jobs runs on Claude.

A Codex role resolves from the first of three places:

1. `<repo>/.codex/agents/<role>.toml`, a repo's own pin
2. `~/.codex/agents/<role>.toml`, yours
3. this repo's `agents.json` row (`codexModel`, `codexReasoningEffort`) and `agents/<role>.md`

The defaults in `agents.json` are `gpt-5.6-sol` and `gpt-5.6-terra`. To run a role on another
model, write `~/.codex/agents/<role>.toml`; each value is a JSON string:

```
model = "<model id>"
model_reasoning_effort = "high"
developer_instructions = "<the role's prompt>"
project_doc_max_bytes = 0
```

`project_doc_max_bytes = 0` is optional: it starts the role without the repo's AGENTS.md.
`node ~/.agent-build/runtime/codexRole.ts <role> --tree <abs-dir> --dispatch <file> --out <file> --dry-run`
prints where the role resolved from and the `codex` command it would run, and runs nothing.

### Build events

A launcher that wants to follow a build learns of its milestones through `BUILD_EVENT_CMD`; the variable, the event schema and the consumer rules are in [docs/build-events.md](docs/build-events.md).

## How it works

### What a run costs

Time, from this repo's own shipped runs (BRIEF.md's budget table: the median wall hours from the
brief commit to the PR opening, over the 20 newest): 0.35h for a small change (S), 0.70h for a
medium one (M), 2.33h for an extra-large one (XL). The budgets a brief starts from are 0.5h, 1h,
2.5h, and 4h by size.

Spawns: one builder per part of the unit, two to five readers at the review wave depending on the
risk class, then up to four fix rounds, each with a fixer, a confirming read, and a hand tester.
Tokens: the one measured sample is a test-writer slice of four functions, which peaked its writer
at 324,634 tokens of context (`TEST_SLICE_MAX_FUNCTIONS` in `runtime/thresholds.ts`); a run holds
several such agents.

### The no-push guard

`hooks/no-push-guard.sh` runs before every Bash call in a session with the plugin enabled and lets a
main session's command through at once; in a subagent (the hook input carries `agent_id`) it refuses a
push or a PR open, ready, edit or merge, in the built-in `git`/`gh` forms and in the repo's own
`push`, `pr_open` and `merge` steps (`steps.ts <cwd> --json`, called only when the built-in forms
miss and the command runs a script runner). The script's header holds the match rules, the accepted
gaps and the deliberate over-blocks. It appends one line per firing in a subagent (time,
`blocked`/`passed`, agent type, session) to
`~/.local/state/agent-build/hooks/no-push-guard.log`; read it back with
`awk '{print $2}' ~/.local/state/agent-build/hooks/no-push-guard.log | sort | uniq -c`.

### Layout

What each folder of this repo holds is in [docs/layout.md](docs/layout.md).

## Contributing

Report a problem in [issues](https://github.com/federbenjamin/agent-build/issues). PRs are welcome; see [CONTRIBUTING](https://github.com/federbenjamin/.github/blob/main/CONTRIBUTING.md) and [SECURITY](https://github.com/federbenjamin/.github/blob/main/SECURITY.md).

### Tests

```
pnpm install
pnpm -s typecheck
pnpm -s test
```

`.githooks/pre-push` runs both before a push. Turn it on once per clone:

```
git config core.hooksPath .githooks
```

### The dependency rule

The harness may depend on this repo; this repo never depends on the harness. No file here reads,
imports, or names a path under the harness's checkout, in code or in tests. Paths under
`~/.agent-build/` are this repo's own installed name and are fine. A test that needs the harness's
manifest (its other agents, `commands`, `hooks`, `scripts`) lives in the harness.

## License

MIT © Benjamin Feder
