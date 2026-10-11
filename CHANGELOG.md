# Changelog

## v0.1.0 (2026-10-10)

First release.

- The `/build` skill with its four stops: BRIEF, BUILD, CLOSE, SHIP.
- Twelve agents: brief-writer, prior-art, builder, test-author, review-cursory, simplifier, security-review, gate-silent-failure-hunter, build-verifier, fixer, hand-tester, gate-warden.
- The runtime scripts the steps run, and a guard that keeps a subagent from pushing.
- A per-repo steps file, `.claude/build-steps.toml`, that maps install, checks, tests and push to the repo's own commands.
- README with a hero picture of one staged run, agent roles, risk classes, and design notes under `docs/`.
