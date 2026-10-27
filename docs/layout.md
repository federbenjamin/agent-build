# Layout

| path | what it is |
| --- | --- |
| `.claude-plugin/` | `plugin.json` (the plugin `agent-build`) and `marketplace.json` (this repo is its own marketplace, `"source": "./"`) |
| `skills/build/` | the `/build` skill: `SKILL.md` and one file per stop (`BRIEF.md`, `BUILD.md`, `CLOSE.md`, `SHIP.md`, …). A typed `/build` or "build X" runs it |
| `runtime/` | the scripts the skill runs (`steps.ts`, `reviewTable.ts`, `shipGate.ts`, …), `lib/`, and their tests in `__tests__/` |
| `agents/<name>.md` | each build agent's prompt and frontmatter; the plugin loads them as `agent-build:<name>` |
| `agents.json` | each build agent's declaration: `name`, `description`, models, Codex settings, `context` |
| `hooks/` | `hooks.json` registers `no-push-guard.sh` on every Bash call (README.md §The no-push guard) |
| `docs/` | the reference pages the README links (`configuration.md`, `design.md`, `build-events.md`, this file), `graph-agents.md` (what an agent reads and writes when the graph runner dispatches it), and `media/`: each diagram's Mermaid source (`.mmd`), its rendered `.svg`, and `diagrams.sh`, which renders them; `hero.png`, the README's top picture, which `hero.sh` re-takes by filming the staged run in `hero-scene.sh` |
| `graph/` | the build as a graph run by Temporal: its own package (`graph/package.json`), outside the root's tests; [graph/README.md](../graph/README.md) |
| `tests/` | repo-level tests: `steps.ts` resolution, `install.sh`, `agents.json` against `agents/` |
| `install.sh` | makes the `~/.agent-build` links and enables the plugin |
