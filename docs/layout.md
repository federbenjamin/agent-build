# Layout

| path | what it is |
| --- | --- |
| `.claude-plugin/` | `plugin.json` (the plugin `agent-build`) and `marketplace.json` (this repo is its own marketplace, `"source": "./"`) |
| `skills/build/` | the `/build` skill: `SKILL.md` and one file per stop (`BRIEF.md`, `BUILD.md`, `CLOSE.md`, `SHIP.md`, …). Only a typed `/build` runs it (`disable-model-invocation`) |
| `runtime/` | the scripts the skill runs (`steps.ts`, `reviewTable.ts`, `shipGate.ts`, …), `lib/`, and their tests in `__tests__/` |
| `agents/<name>.md` | each build agent's prompt and frontmatter; the plugin loads them as `agent-build:<name>` |
| `agents.json` | each build agent's declaration: `name`, `description`, models, Codex settings, `context` |
| `hooks/` | `hooks.json` registers `no-push-guard.sh` on every Bash call (README.md §The no-push guard) |
| `tests/` | repo-level tests: `steps.ts` resolution, `install.sh`, `agents.json` against `agents/` |
| `install.sh` | makes the `~/.agent-build` links and enables the plugin |
