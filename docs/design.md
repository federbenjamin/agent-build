# Why /build is built this way

Each section states a rule the skill and its agents follow, and the reason the source gives for it.
The rules live in `skills/build/` and `agents/`; this page only explains them.

## No agent grades its own work

A defect review hunts defects in the code that is there. It is a sound but incomplete oracle: a
builder that silently dropped a deliverable passes it. Five places keep the author and the judge
apart:

1. **The verifier grades against an oracle the builder did not write**: the brief, committed as the branch's first commit, so a dropped deliverable is a finding rather than a silence. It runs on Sonnet whoever wrote the code, because fresh, author-agnostic eyes are the point.
2. **Test writers hold no stake in the implementation.** Three or more tests go to `test-author`, which the session spawns beside the builder (never the builder itself) and hands only its slice of the brief. It pins the contract and the observed behavior, never the author's intent, and never edits production source.
3. **The fixer is a fresh spawn, never the builder.** Once a builder reports done, every finding goes to the fix table and a new `fixer`; a builder is never resumed for a finding, and a fixer is never resumed.
4. **Every fix is re-read by a fresh reader.** It holds nothing from the wave and answers each row the fixer marked `fixed` as `resolved` or `unresolved`. A wave reader is never resumed for this: by then it has sat idle past the prompt-cache window, and a resume re-reads its whole wave transcript at full price.
5. **The hand-test claims are written before the code**, in the brief, and run by `hand-tester`, which edits no code. The session never runs a claim, never writes a fix, and never builds a fix table by hand.

The ship gate then checks the run against facts no agent wrote (below).

## The brief predates the code

`build-verifier` first proves the brief came before the code. A path-scoped `git log` cannot prove
it: a brief written after the code, against a diff its author had already read, returns one commit
and reads clean. An oracle the code's author edited is no oracle at all, so a later edit to the
brief is legal only as a visible `amend brief:` commit that states its reason; any other later
commit to the brief is a finding.

A hand-test claim may be added or reworded by any `amend brief:` commit, and removed only by an
`amend brief: operator change:` commit. The ship gate counts the claims at the brief's first commit
and at HEAD, and fails a drop with no operator change between them.

The brief-writer is told why the brief carries this weight: nobody downstream re-reads the plan
against the code, so the brief is the last point where a wrong plan is cheap to fix. A defect
carried into the brief costs a builder run, a review round, and a fix round before anyone sees it.

## Readers are chosen by risk class

The session picks the class at the class moment, right after the brief, and sends it to the
operator, who can veto it. Nothing later reads, recomputes, or questions it. The class fixes the
wave's reader set in one table, `RISK_CLASS_READERS` in `runtime/lib/riskClass.ts`, which the skill
restates and the ship gate enforces. Size only lets a reader sit out; it never changes the class
set. The repo's security signals are evidence for the pick, never a class setter.

The `simplifier` is the exception: the diff alone selects it, at every class, because two axes
deciding one reader lost a read. The [risk-class table](../README.md#risk-classes) lists who sits.

## A finding needs a concrete trigger

Every reader writes one finding block: a locator, a kind, the finding with the input or state that
exposes it, and an `after:` line saying what must be true once fixed, never the patch; the fixer
chooses the edit. A reader that cannot state a trigger does not report; one that can reports even
without full certainty. That one rule is what separates a design finding from an opinion.

Readers never write routing sentences ("a ticket, not this fix"): the table script routes each
finding by its kind and the stage it was raised at. Work no deliverable asked for is listed for the
operator and never becomes a row, because a fixer that took it as one could remove a change the PR
needs.

## A fixer asks only typed decisions

A fixer fixes every row except one whose fix needs a choice from a fixed list:

| Decision | The fix needs |
| --- | --- |
| `brief` | a change to the brief |
| `public-surface` | a change to the brief's frozen public surface, or an exported surface the brief did not open |
| `design-entry` | a choice the brief's design section should have made |
| `persisted-shape` | a change to a stored shape: a column, a JSON schema, a file format |
| `user-visible` | a change a user sees that the brief did not describe |
| `conflict` | two rows whose `after:` lines cannot both hold |
| `product` | a product decision no code, doc, or tracker answers |

Size is never the reason, and a true `security` row is always fixed: it is never a relabel or a
decision. The session answers each decision the code, the docs, or its own brief can answer, as a
`SESSION` row the next round's fixer takes. Only a product question nothing answers is banked: the
PR stays a draft with the question under `## Open questions`, the other rows go on through every
round, and the session starts every unit that does not depend on this one. When the operator
answers, the same run resumes, fixes only the banked rows, reads that fix once, and ships.

## Subagents never push

The spawning session owns every push and PR. Builders and fixers leave commits on their own
branches; the session merges them and pushes once at SHIP, after merging main and running the
repo's `checks` step. A hook enforces it for every subagent:
[The no-push guard](../README.md#the-no-push-guard).

## One steps file per repo

The skill names steps, never commands. Each repo maps `install`, `checks`, `tests`, `push`,
`pr_open`, `merge` and the rest to its own commands in `.claude/build-steps.toml`, so every repo
command a run makes is the repo's own. An unknown key is an error, never a silent fallback, because
a typo would quietly weaken the repo. A step with no command is skipped and the skip is said; a step
whose command exits non-zero stops the run, never a silent skip. The ledger's `steps:` line, which
the ship gate requires, records which steps ran on a fallback, so a run on a weakened step set is
never silent.

## The ship gate checks facts no agent wrote

`runtime/shipGate.ts` turns the run's ledger into an exit code by checking its lines against facts
the run does not author: the brief's claims and model at its first commit and at HEAD, `table.json`
rebuilt from the fix, stage, and hand-test files, what each fix range changed in git, which readers
each read owed, whether every hand-test claim's last run passed, and main's drift since the wave.
The stage plan the session follows and the gate call the same function, so what the session is
told to spawn is what the gate later demands. The gate cannot know whether a reader's judgment was
sound, only that every owed move reported and the branch matches what they imply. Nobody merges
past a non-zero exit by reasoning about the check.
