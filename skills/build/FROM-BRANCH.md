# /build — `--from-branch <name>` — CLOSE + SHIP for a branch nobody briefed

Read this file in full, then CLOSE.md, when the run is `/build --from-branch <name>`. `§` names below are CLOSE.md's headings.

**First, the diff:** `git diff <base>...HEAD > <inputs-dir>/diff.patch` (`<base>` is `origin/main`, or the parent PR's head for a branch stacked on an unmerged one); CLOSE step 1 materializes it again after freshen. The class moment runs from that file: the `<size>` step as in CLOSE, and `<signals> --signals <inputs-dir>/diff.patch`. **No brief is ever written after the fact, so no verifier and no `decisions:` block** (the class moment still runs: BRIEF step 4's lines and its status message, with `decisions: none`; pin `class: R<n> — agent (unconfirmed), <date>` as BRIEF step 4 says, and say `unconfirmed` in the ship notification). Instead, at the class moment write `<briefs-dir>/<branch-slug>-hand-test.md` (`<branch-slug>`: SKILL.md): the pinned class line, then a `## Hand test` section by BRIEF's rules, claims written from the diff. `node ~/.agent-build/runtime/briefCheck.ts <it>` prints `class:` and `claims:` and must exit 0. Commit it as the run's first commit, in the repo's commit style (the notes name its types; a docs commit such as `docs(build): <branch-slug> — from-branch hand-test block`). In a public repo the file is written and committed in the store as a brief is (BRIEF step 6), and the ledger line is `hand-test-block: store:briefs/<branch-slug>-hand-test.md`. Its record is the run's first commit on the branch, an empty one whose subject is that ledger line and the store commit: `hand-test-block: store:briefs/<branch-slug>-hand-test.md @ <sha>`. Once it is committed, fire the `plan` event as BRIEF step 6 does, the run's `<runid>` being the unit's id and the branch its title: `node ~/.agent-build/runtime/buildEvent.ts plan --runid '<runid>' --unit '<runid>=<branch>'`. A later fix to a claim (CLOSE 5a) is an `amend brief:` commit on this file, as on a brief:

```hand-test-block
class: R1 — agent (unconfirmed), 2026-09-28

## Hand test

- H1 · a signed-out send is refused, and the refusal is logged once
  - run: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/functions/v1/chat -d '{"text":"hi"}'`
  - pass: prints `401`; the function log holds one `auth: refused` line for the call
  - needs: stack
```

Ledger: `from-branch: <name>` and `hand-test-block: <path>` where a briefed run writes `brief:` (CLOSE step 1), and `verifier: N/A (from-branch, no brief)` where it writes its verifier line, after `wave:`; no `brief:`, no `build:`. Every changed file is a target, except the hand-test file itself. The fixer is `opus` at R2 and `sonnet` below, with no handoff note. Marker `verifier=N/A`; the ship notification says completeness is unchecked. The rest is CLOSE steps 1–14, then SHIP. A banked run never comes here: it resumes by UNBANK.md.
