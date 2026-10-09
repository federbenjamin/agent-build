# /build — BRIEF

## Small work

A change you size below `SMALL_WORK_BELOW_BUCKET` is **small**: the class moment's own `size` estimate (step 4), read against the `<size>` step's buckets. Route it by the first of these that holds, in this order:

- **It unblocks something now** — another session's blocker, a live security hole → its own unit, as any other.
- **An open unit of this session has not reached its wave (CLOSE step 2), and the change would not raise that unit's class** → it joins that unit: an `amend brief:` commit adds a part (§Parts and test slices), a deliverable at the end of both lists, its target files, and a hand-test claim when one applies; then that part is built (BUILD).
- **Otherwise** → the batch.

Who writes a small part is the floor check's call (step 1): a `session` part when you could write its whole diff into the brief, else a builder on the part's model (step 7).

**The batch.**

- One open batch per session. Its branch is `chore/batch-<first 8 characters of the session id>-<n>`, `n` from 1, one higher after each batch ships. Cut it from `origin/main` in a run tree (CLOSE §Trees: the launch tree when no run holds it, else a run tree of its own).
- Its brief, `<briefs-dir>/chore-batch-<session8>-<n>.md`, is its first commit, and the first change rides in that commit as its first part. The header is `class: R1 — batch rule, <date>`: this rule sets the class, so the class moment picks none. `model:` is the strongest part's (step 7).
- Each later change is an `amend brief:` commit — a part, a deliverable at the end of both lists, its target files, its claim — then its code: your own commit for a `session` part, a builder's merge for any other.
- When you cut the branch and a session log is configured, add `- [ ] [<batch branch>] batch: ship <batch branch> — <brief path>` to its Todo, so a later session can finish it; that line flips to `[x]` when the batch merges (SHIP step 5), and the log prune then moves it. With none, nothing is written: the branch is the record, and after a compaction the open batch is the highest-`<n>` branch `git branch --list 'chore/batch-<session8>-*'` prints whose PR has not merged.
- **It ships at the first of these events:** (1) a change lands and the size of `git diff origin/main...<batch branch>` reaches `BATCH_SHIP_BUCKET` (write that diff to a file in the batch's tree, then `<size> --diff-file <that file> --class R1`: the bucket on its size line); (2) the session's last other open unit leaves CLOSE; (3) the operator says ship. A change that lands while no other unit is open does not fire (2): it waits for (1), (3), or the next unit to leave CLOSE. Then CLOSE and SHIP run once, as for any R1 run.
- A change that would raise the batch to R2 ships alone, as its own unit.
- Under `/loop`, `/build-ticket` runs one ticket per run, so no other unit is open when a small ticket lands: it waits for the next ticket's unit to leave CLOSE, or for (1) or (3).

## The steps

1. **Floor check.** If you could write the complete diff into the brief — every file and final edit nameable without investigation — do NOT spawn: make the edits directly and say why ("below the build floor"), then run the builder's exit checks yourself (the `<exit_checks>` step — the `builder` agent's §Before handing off) before CLOSE — a direct edit skips the builder, not its checks. The brief is still written and committed first, with every section below, and its header says `model: session`; the ledger's build line is `build: model=session | agent=none | sha=<head after your edits>`, with no `parts=`. Spawn only when real building remains. **The check applies per part** (§Parts and test slices): a part whose whole diff you could write into the brief is a `model: session` part, which you write in the run's tree and no builder builds; the other parts are built.

2. **Assemble the brief.** The `brief-writer` agent writes it, in the §Brief format below. Spawn it with no `model:`: its frontmatter pins the model, and a passed one would override the pin. You write the brief yourself only when step 1 makes every part `session`.

   - **Before the spawn.** When item 3 below calls for a `prior-art` run, run it first and keep its report at `<run-dir>/prior-art.txt`: `brief-writer` cannot spawn. For plan-driven work, save the ticket body to `<inputs-dir>/ticket-<id>.md`.
   - **The dispatch** names the work (that file, or the request text, and the unit to brief), the read root (the run's tree), prior art (the report path, `plan`, or `none`), the brief path (step 6's path), the class-moment path (`<run-dir>/class-moment.txt`), the inputs dir (`<inputs-dir>`), and the date.
   - **Its report** brings back open questions (the ones it could not answer; to the operator at once, step 3), ticket corrections (for the work-start comment), and doubts. Each doubt either changed the brief or names a sweep you owe. Read each one; when you disagree, spawn it again with a fix note.

   From here through step 7, "you" is whoever writes the brief. Sending the class moment (step 4) and committing the brief (step 6) stay yours.

   **Plan-driven work** (a unit ticket): the ticket body carries the unit's plan sections verbatim and the full plan as an attachment — read the ticket, never a plan file on disk. **Ad-hoc work**: the brief comes from the request and your own read of the code.

   A ticket more than about a week old is unreliable: check each of its claims (mechanism, counts, named sites, fix direction) against today's code and the repo's locked-decisions doc (the notes name it) before it enters the brief, and put the corrections in the ticket's one work-start comment (SKILL §Tickets), never a comment of their own.

   The brief also carries what no spec states: the **branch contract** (default: a new `<type>/<slug>`, the type being the unit's commit type: `feat`, `fix`, `docs`, `chore`, `refactor`; commits on it, NO push and NO PR — builders cannot push; you push at SHIP); **DB-touching work** (the `<db_gate>` step and the notes' stack and type-regeneration procedure); the exact error or log line, grep anchors, and the precise before→after behavior including edge cases.

   **Brief format** — mandatory; the self-critique, the class moment, the table script, the ship gate, and `build-verifier` all read it:
   1. Two header lines: `class: R<n> — <who>, <date>` (written at step 4, in that one form: `<who>` is `agent (unconfirmed)`, or `operator` once the operator has vetoed the class; the `<manifest>` step's `--brief-file` mode, when the repo has one, fails a brief without it, so its step-3 run fails the header and step 6's run is the first that must pass it), and directly under it `model: <opus|sonnet|session> — <why>` (written now, by step 7's rule: the strongest part's model). Until step 4 pins the class, the `model:` line is the first header line.
   2. The spec, verbatim — every section the unit rests on.
   3. A `## Prior art` block — MANDATORY when the diff adds a new module, component, or exported API: a verdict per new artifact (**reuse** / **generalize** / **consolidate** / **justified-new**) with the existing implementation's path and the evidence. **A stamped plan is not swept again.** When the work's Prior-art section opens with a `Prior-art stamp:` line (the `prior-art` agent's §Stamp) and its `components:` list names every new artifact this brief adds, copy the section verbatim, stamp included, and spawn nothing. An artifact the stamp does not name (a section added to the plan after the sweep) gets a full sweep on that artifact alone; paste its verdicts and its own stamp line under the first. With no stamp, spawn `prior-art`: the light check over an unstamped plan section, the full sweep when there is none.
   4. A `## Design` block — for a design-bearing brief only (a new module/API, or a structural choice between real options): the chosen shape, the 2 rejected alternatives one line each, the assumptions. When the choice lands in production code and reaches more than one feature, run `/greenfield` quick tier first.
   5. A `## Locked decisions` block when the repo's locked-decisions doc names one the unit touches.
   6. A `## Substrate sweep` block when the unit DROPS, RENAMES, or RETYPES a column, symbol, function, trigger, or index: every hit of the name across the repo's source, migrations, and scripts as `path:line — role`, and a deliverable naming each site.
   7. A `## Public surface` block — MANDATORY whenever the build needs tests: the file paths, exported symbols, and signatures the diff will create or change, exact enough that a test written against them compiles unchanged. The builder may not rename or move what this block names — a needed rename is a STOP back to you. Name functions, not state (a module owns its data).
   8. A `## Target files` section — MANDATORY (§The three new parts).
   9. A `## Parts` section — optional; required when the unit needs more than one builder, or holds a `session` part beside a builder part (§Parts and test slices). Without it the brief is one part.
   10. A `## Test slices` section — required when a part's `tests:` names a slice, absent otherwise (§Parts and test slices).
   11. A `## Hand test` section — MANDATORY, before `## Deliverables` (§The three new parts).
   12. A `## Deliverables` section — one bullet per concrete artifact, each tagged with its source (`(spec)`, `(§Section)`, `(AGENTS.md §X)`, `(<rules file>)`), each a claim about the finished diff with its before and after, never a task. **Whenever the brief carries the yaml block below, that block's `deliverables:` array is THE deliverables list** — these prose bullets restate those same entries in the same order and add nothing the array omits. The two lists pair by position (a part's `deliverables:` and a slice's `covers:` name positions), so **an `amend brief:` adds a deliverable only at the end of both lists**, never in the middle and never reordered: an insert shifts every position after it. Never write a prose bullet the array does not carry: two lists drift, and the one a reader walks is then not the one the gate scores. A deliverable no assertion block can bind declares `covered_by: [judgment]` — an honest "a reader grades this one" (`build-verifier` is that reader) beats padding `covered_by` with a block that does not bind it.
   13. An optional fenced `yaml` assertions block valid against the repo's `<manifest>` step (its schema and assertion kinds are the notes' to name), plus the REQUIRED `deliverables:`. A repo with no `<manifest>` step still writes `deliverables:`; the verifier grades every entry by judgment. When the notes name server surfaces, the block's `exercise:` is MANDATORY for a unit that touches one; the notes give the cheapest binding shape. A block with `exercise:` owes a `## Hand test` claim that runs the `<manifest>` step on the brief with the exercise: the verifier runs the step without exercises, and the hand tester runs them on the session's stack.
   14. A literal last line `--- brief complete ---`.

3. **Self-critique the brief.** Run `node ~/.agent-build/runtime/briefCheck.ts <draft>`: it prints `class:` (`none` before step 4), `model:`, `target-files: <n>`, `claims: <n> (H1, …)`, `parts: <n> (P1 sonnet, P2 opus after P1)`, and `slices: <n> (W1 db, 2 functions)`; exit 1 names the section and line that is malformed or missing — a bad `## Parts` or `## Test slices` included — and is a rewrite. A slice over the size guide is a warning on its `slices:` line, not an exit 1: cutting it again is your call. Parse the yaml block with `<manifest> --brief-file <draft>` (plus the step's parse-only flag when the notes name one) and read its `brief manifest block` line, never its exit code: a draft has no class line and no code yet, so the header and every assertion fail and the step exits 1 either way. `brief manifest block — parses against manifestSchema` passes; any other text on that line is a rewrite. With no manifest step, check the yaml parses and the `deliverables:` array exists. Placeholder scan (`TBD`, `<fill in>`, bare "handle X"). Ambiguity check (two different diffs satisfying one item → rewrite it). Size check: a part over `PART_MAX_LINES` is cut, or the brief says why it cannot be (§Parts and test slices). Outside-tool check: for each library call, config key, or tool setting the brief fixes (a release tool's config, a library's API, a plugin manifest's format), confirm it against the pinned version's current docs, through context7 or the tool's own check or `--help`, and name the source beside the choice in `## Design`. A deprecated key counts as wrong: a tool's own check that refuses deprecations fails the build later, at the cost of a builder run and a fix row. A choice no doc confirms is an open question. Answer an open question yourself first when the code, the plan docs, `docs/`, or the tracker answers it (CLOSE step 4a's rule), and write the brief by that answer; only what none of them answers goes to the operator, at once.

4. **The class moment — you pick, the operator can veto.** Print `summary` and `impact`, then the five lines, then the `decisions:` block:

   ```
   summary: There is a message box at the bottom of a match chat. Today a half-written
            message is lost when the user leaves the chat. Keep the draft, and retry a
            failed send once before showing an error.
   impact:  Users stop losing what they typed, and a flaky network no longer drops a message.
   class:   R1 — the user cannot use a core flow (match chat composer)
   size:    ~180 counted lines · apps/mobile 150 · packages/core 30
   signals: none
   model:   opus — the brief carries a ## Design entry (where the draft lives)
   metrics: none
   decisions:
     - the composer keeps its draft in the chat store, not in local state (## Design)
     - a failed send retries once, then shows the inline error (## Locked decisions: send-retry)
   ```

   - `summary` — what the work is, for a reader with no context: not the brief, the ticket, or this session. Plain words, short sentences, no file or symbol names unless the operator already uses them. Introduce each thing before saying what is wrong with it ("There is a list that records X. 4 of its paths are wrong."), then say what the work does about it. Size it to the work: a few sentences for a fix, a short paragraph or numbered list for a batch of fixes, a feature, or a plan unit.
   - `impact` — what the work accomplishes once it ships: what users or developers get, and "no user sees a change" when that is true. One to three sentences.
   - `class` — one of R0–R2 with one consequence phrase: R0 nothing a user sees · R1 a user sees or loses something (wrong output, data lost, a core flow blocked, a runaway bill) · R2 the change touches the security boundary (another user's data, auth, access rules, encryption, secrets). What each class changes (its readers, the owed fixer's model): CLOSE §The readers. The repo's AGENTS.md may name its own security surfaces; its wording wins. The notes may name tooling surfaces the repo recommends at R0. Read the decision principles your instructions name, if any, before you pick: they hold how the operator weighs a class.
   - `size` — estimated from the brief's `## Target files` in the `<size>` step's currency (counted lines, per top-level dir); re-printed from the real diff at CLOSE.
   - `signals` — `<signals> --paths <file listing the brief's ## Target files entries> [--text <file holding the hunks it quotes>]`: each hit as `<predicate>: <path or needle>`, or `none`; `n/a (no signals step)` when the repo maps none. **Evidence only** — it never sets or raises the class. With a `## Parts` block, run it once per part, `--paths` over that part's `files:` entries, and print each hit after its part id (`P2 security-path: …`). A `security-path:` hit makes that part's model `opus` (step 7).
   - `model` — the brief's `model:` line and its reason, by the rule in step 7. With parts: the header model, then each part by model — `opus — P2 (design choice); P1, P3 sonnet`.
   - `metrics` — `none`, or each metric the plan wants tested and how it is judged. An agent's opinion never blocks a merge: you judge the result the way you judge the class, state it so the operator can veto, and put the numbers in the PR body.
   - `decisions` — every decision the brief rests on, one line each, copied from its `## Locked decisions` and `## Design` blocks (the chosen shape and each assumption), with the block it came from. At most 10 lines; past 10, print the 10 that most change the diff and a last line `+<n> more — see the brief`. A brief with neither block prints `decisions: none`. The operator reads these so a wrong premise is caught here, not at CLOSE.

   Then pin the class yourself and keep going; ask nothing. Send the whole block above, `summary` through `decisions:`, in one status message, so the operator can veto the class, the model, the metrics, or a decision, and write the same block, verbatim, to `<run-dir>/class-moment.txt`: SHIP copies it into the PR body (SHIP step 1 — `summary` and `impact` become `## What it does`; the `class:` line and the `decisions:` list become `## Decisions`), so the decisions the operator never vetoed are read once more, in the PR, before the merge. A veto rewrites the file along with the brief. **Pin it:** pin `class: R<n> — agent (unconfirmed), <date>` as the brief's header line; the ledger's first line repeats it. Nothing later reads, recomputes, or questions it — a scope breach found at CLOSE is reported as out-of-lane; the class stays; the ship notification names it and says `unconfirmed` — for the class, the model, and the decisions. **An operator veto**, whenever it comes, is applied as an `amend brief:` commit whose subject also carries `operator change:` — `amend brief: operator change: <what moved>`. A vetoed class is re-pinned as `class: R<n> — operator, <date>`: the brief's header line, and the ledger's one class line changed in place (the ledger never holds two; `ledgerLine.ts --replace class …`, CLOSE §The steps). A decision with no answer in the code, the plan docs, `docs/`, or the tickets is still a question: post it, park what depends on it, keep building the rest.

5. **Design pass — on the plan, never on the brief.** /build spawns no `simplifier` at BRIEF. The design pass is an optional step on an approved plan, before its first unit is briefed: the operator or the planning session spawns `simplifier` (its design-pass mandate) with the plan's design section, its prior-art section, and the files its units name, and folds the verdicts into the plan, each change tagged `[simplifier V<n>]`, under a `Design pass: <date> · <repo>@<short sha> · reviewed: <unit ids>` line, so a unit added later reads as not reviewed. A brief from such a plan carries the folded design as written; a verdict the code contradicts is a ticket correction (step 2), not a second pass. Work with no plan, or a plan without the pass, is briefed without one.

   **Where BRIEF's files go.** `prior-art` returns its report as a message; when you keep it, it is `<run-dir>/prior-art.txt`. A dispatch file you write for it or for a builder goes in `<inputs-dir>`. The ship gate refuses any `.md` in the run dir that is no reader's file.

6. **Commit the brief.** `<briefs-dir>/<branch-slug>.md` (`<briefs-dir>` is what the notes name; default `docs/build/briefs/`), as the branch's FIRST commit, with the `model:` line step 7 set, in the run's own tree: a unit opened while another run holds the launch tree first gets a run tree of its own, and you enter it (CLOSE §Trees). Run `node ~/.agent-build/runtime/briefCheck.ts <path>` again, and `<manifest> --brief-file <path>` when the repo has the step — it refuses a header with no pinned class line. The brief is read-only to the builder — `build-verifier` flags a later commit touching it. You may amend it when you got it wrong: a separate commit whose subject starts `amend brief:` and states the reason; when the operator moved a decision, the subject starts `amend brief: operator change:`. **A hand-test claim may be added or reworded by any `amend brief:` commit, and removed only by an `amend brief: operator change:` one** — the ship gate counts the claims at the brief's first commit and at HEAD, and fails a fall with no operator change between them.

   **Then fire the launcher's `plan` event**, once the brief is committed and `briefCheck.ts` passed: `node ~/.agent-build/runtime/buildEvent.ts plan --runid '<runid>' --unit '<id>=<title>'…` (values quoted as SKILL §Setup says), one `--unit` per unit the session will build, this one included, in plan order. `<id>` is the plan's unit id in lowercase (`u2`) for a unit of the plan; any other unit (work with no plan, the batch, a `--from-branch` run) takes its run's `<runid>` (`1791266702-k3Xq9w`), never its branch name, which may hold the `=` the flag splits at; each unit mints its own (SKILL.md: `mktemp`), so no two units of a session share an id. `<title>` is the unit's title, the brief's H1 text after `# Brief — `. A repeat after a resume is fine; the event's contract is README §Build events.

   **A public repo: the store brief.** `node ~/.agent-build/runtime/lib/repoId.ts` prints `profile:` and `store:`. When the profile is `public`, the repo tracks no brief: `<briefs-dir>` is `<store>/briefs/`, and every `<brief>` path this skill names is that absolute path. Commit the brief in the store BEFORE the run's branch gets its first commit, naming its path so another run's file never rides along: `git -C <store> add briefs/<branch-slug>.md`, then `git -C <store> commit -m "brief: <owner>/<repo> <branch-slug>" -- briefs/<branch-slug>.md`. A commit that fails on `index.lock` (another session is committing there) is run again. An amendment is a store commit of that one path with the same `amend brief:` subject. **Then record it: the run branch's first commit is an empty one that names the store commit**, `git commit --allow-empty -m "brief: store:briefs/<branch-slug>.md @ <sha>"`, `<sha>` being the 40 characters `git -C <store> log -1 --format=%H -- briefs/<branch-slug>.md` prints. The ledger names the brief `brief: store:briefs/<branch-slug>.md`. The ship gate proves the order from that record: a commit can only name a store commit that already exists, and any later store commit on the brief must be an `amend brief:` one. `briefCheck.ts <brief> --base <base>`, run from the run tree, prints `order: ok`. The store is pushed at SHIP step 5.

7. **Pick the model, per part.** Each part's `model:` names the model its builder runs on; the brief's header `model:` line is the strongest part's (`opus` over `sonnet` over `session`), and names the fixer's model (CLOSE). With no `## Parts` block the brief is one part and the header is its model. A part is `opus` when any of these holds: a `## Design` entry names one of the part's own files or deliverables; the class moment's `signals` run over the part's own `files:` printed a `security-path:` hit; one of the part's deliverables lacks its before and after. Else `sonnet` — the brief names every file and what each change must do, at any size. `session` is the floor check (step 1): you write that part, and no builder runs for it. Size, checklist length, the number of areas, and the class never decide it. The contract's `builder_model` tunable, when it is not `auto`, sets every part's model but a `session` part's, and so the header and the fixer. Write the line by this rule at step 2, because `briefCheck.ts` at step 3 refuses a draft without it. Apply the rule again once step 4's `signals` line is printed, and correct the line before the class moment prints it; step 6 commits the result.

## The three new parts

The brief carries each of these. `node ~/.agent-build/runtime/briefCheck.ts` reads them (`~/.agent-build/runtime/lib/brief.ts` owns the grammar), and so do the table script and the ship gate.

**The `model:` line**, directly under the class line, with its reason after ` — `:

```
class: R1 — agent (unconfirmed), 2026-09-28
model: sonnet — the brief names every file and what each change must do
```

**`## Target files`** — the files the unit sets out to build or change, one `- <path or glob>` per line with an optional ` — <why>`; blank lines allowed; at least one entry. `**/` matches any leading folders, `*` stays inside one folder, and a trailing `/` takes the whole folder. It is the list the class moment hands `<signals> --paths`. Downstream, a reader's `dev-tool` or `test-tool` finding in a target file counts as `behavior` or `test-app` (a PR's own tool is its product), and a fix that changes logic in a target file counts as a change to the PR's code, which owes a re-read; a comment-only or blank-line change, or a rename that leaves the content identical, does not count, while a changed path string in a target file does. So list what the unit is about, never a file it touches only in passing. **The list never names the brief itself:** the brief is the spec, not the PR's code, and the runtime never counts it as either (an `amend brief:` owes the verifier only when it changes the deliverables or an assertion — in the yaml block, the value of `deliverables:` or of an assertion block (`files_exist`, `files_absent`, `files_changed`, `files_unchanged`, `exports`, `tests_assert`, `schema_parses`, `no_stub_markers`, `mutation_proved`, `command_clean`, `exercise`), never another key such as `description:`; or the `## Deliverables` list — and never a re-read of the code or a fresh hand test).

```
## Target files

- apps/mobile/src/chat/send.ts
- packages/core/src/chat/**
- .claude/build/notes.md — the hand-tester section
```

**`## Hand test`** — written now, before any code exists: each claim a user or a caller could see, the command that shows it, and what passing looks like. The `hand-tester` agent runs the claims in the session's tree during CLOSE; you never run them. A claim is a head line `- H<k> · <what a user or caller sees>`, then two-space-indented `- run:` and `- pass:` lines, exactly once each, and an optional `- needs: stack`, `sim`, or `stack, sim` (CLOSE brings each up before the hand tester starts). `run:` is the real command, resolved from the repo's steps and the notes' `## hand-tester` section (how a command gets its env, which commands need the stack, how UI claims run); an example in this skill writes a step name in its place. UI claims run as Maestro flows only. **A claim is what the tests do not already do:** it drives the live app (a Maestro flow on the simulator), queries the database, calls a live endpoint, or reads a log. A `run:` that only runs a test file or a suite — `jest`, `vitest`, a package manager's `test`, `deno test`, `node --test` (`testRunnerOf`, `~/.agent-build/runtime/lib/brief.ts`) — is no claim, because the checks and CI run tests already, and `briefCheck.ts` exits 1 on it. The same holds for the `<manifest>` step with no exercise to run (`--no-exercise`, or a brief with no `exercise:` line): the push gate runs it that way (`manifestWithoutExercise`, same file). A brief with no such claim has no hand test: its section is `none — <reason>`, and none runs. A brief whose yaml carries `exercise:` has a claim that runs the `<manifest>` step on the brief with the exercise (H2 below), because the exercise calls live endpoints and nothing else runs it:

```hand-test-block
## Hand test

- H1 · a signed-in user who sends "hi" sees the reply stream in
  - run: `curl -sN http://127.0.0.1:54321/functions/v1/chat -H "Authorization: Bearer <test user jwt>" -d '{"text":"hi"}'`
  - pass: exit 0; the output holds `"type":"delta"` before `"type":"done"`
  - needs: stack
- H2 · the brief's exercise passes on the served stack
  - run: `<manifest> --brief-file docs/build/briefs/fix-draft-keep.md`
  - pass: exit 0; `0 FAIL`, `0 BLOCKED`
  - needs: stack
```

When no claim applies, the section says why, and CLOSE writes `hand-test-1: skipped — no claims`:

```hand-test-block
## Hand test

none — the diff changes only a doc
```

A missing section, a claim without `run:` or `pass:`, a repeated claim id, `none` beside a claim, or a claim whose `run:` is a test runner or the `<manifest>` step with no exercise is malformed: `briefCheck.ts` exits 1.

## Parts and test slices

A **part** is one builder's share of the unit: its files, its deliverables, its model. A **slice** is one test writer's share of the tests. `node ~/.agent-build/runtime/briefCheck.ts` reads both (`~/.agent-build/runtime/lib/brief.ts` owns the grammar) and prints its `parts:` and `slices:` lines; exit 1 on either is a rewrite.

**`## Parts`** is optional. A brief without it is one part, `P1`: the header `model:`, every `## Target files` entry, every deliverable. Write the section when the unit needs more than one builder, or holds a `session` part beside a builder part. **Cut a part** when the unit's estimated counted lines pass `PART_MAX_LINES`, or when one piece needs `opus` and the rest do not (step 7). `PART_MAX_LINES` is a planning number, never a gate: a part planned above it is cut in two, or the brief says why it cannot be. Parts that share no file and use none of each other's new code carry `after: none` and are built side by side; the rest name the parts they wait for. Keep each part's reading narrow: its `files:` list is what its builder reads first, and reading, not writing, is what fills a builder.

```parts-block
## Parts

- P1 · the table script keys a merge on path and line
  - model: sonnet — the brief names each file and what each change must do
  - files: src/runtime/build/lib/table.ts
  - test files: src/runtime/build/__tests__/table.test.ts
  - deliverables: 1, 2
  - after: none
  - tests: builder
- P2 · the gate reads the part list
  - model: opus — a design choice: where the part list lives in the ledger
  - files: src/runtime/build/lib/owed.ts, src/runtime/build/lib/ledger.ts, src/runtime/build/README.md
  - test files: none
  - deliverables: 3
  - after: P1
  - tests: W1
```

- A head line `- P<k> · <what it builds>`, ids unique; under it, two-space-indented fields, each exactly once:
  - `model: opus|sonnet|session — <why>` — step 7's rule, applied to this part.
  - `files:` — paths or globs, written as `## Target files` writes them; each equals a `## Target files` entry or is matched by one. **Every doc the diff must update (a README, a rule file) is in exactly one part's `files:`**, so two side-by-side builders never both edit it.
  - `test files:` — `none`, or the part's own tests when `tests:` is `builder`. They need not be in `## Target files`.
  - `deliverables:` — the part's deliverables by position. **The prose list under `## Deliverables` and the yaml `deliverables:` array pair by position**: entry `n` of one is entry `n` of the other, because the yaml entries carry no id. A position counts the top-level items under `## Deliverables`, each a `- ` bullet or a `1. ` item, from 1. Every deliverable is in exactly one part, and the two lists hold the same count.
  - `after:` — `none`, or the parts this one waits for. No part waits for itself, and no chain of waits loops back.
  - `tests:` — `builder` (one or two tests, which the part's builder writes), `none`, or the slices that write them (`W1, W2`).
- Two parts with no `after:` path between them share no file across `files:` and `test files:`: no equal entry, no entry the other's glob matches, and no two globs where the text before one's first `*` starts the other's.
- The header `model:` line equals the strongest part's model.

**`## Test slices`** is required when a part's `tests:` names a slice, and absent otherwise. Three or more tests go to `test-author` writers (BUILD); cut them into slices of about `TEST_SLICE_MAX_FUNCTIONS` functions under test each, one lane each: `db` when the slice's tests need the run's database, `plain` when they need none.

```test-slices-block
## Test slices

- W1 · db · the write contract of the parts check
  - files: src/runtime/build/__tests__/owed.parts.test.ts
  - covers: 3
  - under test: owedFacts, parseParts
```

- A head line `- W<k> · db|plain · <what it tests>`; fields `files:` (the slice's test files — never another slice's, never a part's `files:` or `test files:`), `covers:` (deliverable positions), and `under test:` (the exported functions or components it tests), each exactly once.
- Every slice is named by exactly one part's `tests:`.
- The count of `under test:` entries is the slice's size. `briefCheck.ts` prints a slice over `TEST_SLICE_MAX_FUNCTIONS` as a warning on its `slices:` line and still exits 0.
- A writer gets its slice's excerpt, never the brief: `briefCheck.ts <brief> --slice W<k>`. `briefCheck.ts <brief> --files <P<k>|W<k>>` prints a part's or a slice's paths, one per line. BUILD writes both into `<inputs-dir>`.
