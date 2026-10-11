# Changelog

## Unreleased

- A brief goes in the store unless the repo's build notes name a briefs dir in the repo, so a run no longer commits `docs/build/briefs/` into a repo that never asked for it. The first run that needs the store makes it a local git repo (`repoId.ts --init-store`); SHIP pushes it only when it has a remote.
- A finished run leaves the repo as it found it: after the session's last merge it removes the worktree `/build` entered and deletes the harness's `worktree-<name>` branch and each merged run branch. Review telemetry moves from `.claude/run-state/` in the checkout to `.git/agent-build/`; an old file is moved over on first use.

## v0.1.0 (2026-10-10)

First release.

- The `/build` skill with its four stops: BRIEF, BUILD, CLOSE, SHIP.
- Twelve agents: brief-writer, prior-art, builder, test-author, review-cursory, simplifier, security-review, gate-silent-failure-hunter, build-verifier, fixer, hand-tester, gate-warden.
- The runtime scripts the steps run, and a guard that keeps a subagent from pushing.
- A per-repo steps file, `.claude/build-steps.toml`, that maps install, checks, tests and push to the repo's own commands.
- README with a hero picture of one staged run, agent roles, risk classes, and design notes under `docs/`.
