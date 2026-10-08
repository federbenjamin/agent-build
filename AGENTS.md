# agent-build

The `/build` system: the skill (`skills/build/`), its runtime scripts (`runtime/`), and its twelve agents (`agents/`, declared in `agents.json`). `README.md` has the layout.

## Rules

- **Edit on a branch in a worktree, never in the main checkout.** `~/.agent-build/*` links into the main checkout, so its files are what every running build executes; a half-made edit there changes builds in flight.
- **This repo never depends on the harness.** The harness (agent-surfaces) may depend on this repo; no file here reads, imports, or names a path under the harness's checkout, in code or in tests. A test that needs the harness's manifest (its other agents, `commands`, `hooks`, `scripts`) belongs in the harness.
- **Name a script in docs by its installed path:** `~/.agent-build/runtime/<script>`, never a path into this checkout.
- **`skills/build/SKILL.md` stays within 12,000 characters** (bytes, as `wc -c` counts them): a skills installer may refuse a larger one. Move steps into the stop files it points at. `runtime/__tests__/buildStopPins.test.ts` checks it.
- **An agent is in `agents.json` and `agents/<name>.md` together, or in neither.** `tests/agents.test.mjs` checks it.
- Run `pnpm -s typecheck` and `pnpm -s test` before you hand work over; `.githooks/pre-push` runs both (`git config core.hooksPath .githooks` once per clone).

<!-- >>> git-workflow (generated block; do not edit by hand) -->
## Git workflow

- `main` changes only through a PR, squash-merged.
- Branch names: `<type>/<slug>`, the type being the commit type (`feat`, `fix`, `docs`, `chore`, `refactor`).
<!-- <<< git-workflow -->
