# Configuration

## Build steps

A repo maps each step the flow names to its own command in `.claude/build-steps.toml`;
`node ~/.agent-build/runtime/steps.ts <repo>` prints the resolved table, and
`node ~/.agent-build/runtime/steps.ts --template <name>` prints the file a new repo starts from
(every step commented out, so each stays on its fallback until the repo fills it in).

A repo with no steps file runs on the fallbacks alone. Its `tests` and `checks` steps run
`npm test` when its `package.json` has a test script (`npm init`'s placeholder does not count), and
nothing otherwise. Its `install` step runs `pnpm install --frozen-lockfile` with a `pnpm-lock.yaml`,
`npm ci` with a `package-lock.json`, and nothing otherwise (a yarn or bun repo names its own). The PR opens as a draft with the title and body the run writes. Once the ship
gate passes, the PR is marked ready and set to auto-merge, or merged at once where the repo does not
allow auto-merge (a new GitHub repo does not). A repo's own `merge` step replaces all of that.

## Where files go

| variable | what lives there | default |
| --- | --- | --- |
| `AGENT_BUILD_STORE` | the build steps, notes, and briefs of a repo whose `git config agents.profile` is `public`, at `<store>/<owner>/<name>/`; a repo without that key keeps them in its own `.claude/` and never reads the store | `~/.local/state/agent-build/store` |
| `AGENT_BUILD_RUN_ROOT` | each run's dir: its ledger, reader findings, fix tables, hand-test files | `~/.local/state/agent-build/runs` |
| `SESSION_LOGS_DIR` | session logs, when you keep them; a run writes to one only when it is set | none |

`node ~/.agent-build/runtime/lib/repoId.ts .` prints the store and the run root as resolved.

## Codex (optional)

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
