# Build events

A launcher that wants to follow a build (a desk, a dashboard) learns of its milestones through
`BUILD_EVENT_CMD`. /build never names a launcher: at each milestone its stop files run
`~/.agent-build/runtime/buildEvent.ts <event> --runid <runid> [flags]`, and that script hands the event
to whatever command the variable holds.

**Who sets it.** The launcher, in the environment of the session it opens. Never the repo: whether
anyone listens depends on who launched the build, not on what is being built. For a graph run, the
launcher is the process that runs `build-graph start`, and the run carries its value to the worker.

**How the command runs.** The value is split on runs of whitespace into a command and its arguments
and run directly, never through a shell, so quoting and pipes do not work and a path holding a space
cannot be named (point at a wrapper script instead). The event is one line of JSON on the command's
stdin, ending in a newline; the command's stdout is dropped. It is killed after
`BUILD_EVENT_TIMEOUT_MS` (30,000 by default; a repo's thresholds file can override it).

**A consumer never fails a build.** When the command exits non-zero, times out, or cannot start,
`buildEvent.ts` prints one warning on stderr, `buildEvent: BUILD_EVENT_CMD failed (<program>): <error>`,
and exits 0. The warning names the program and never its arguments, so a token passed as an argument
stays out of the build's transcript; the consumer's own stderr follows the error as it was written.
Its exit codes:

| exit | meaning |
| --- | --- |
| 0 | the event was handed over, nobody is listening (the variable is unset or blank), or the consumer failed (warned) |
| 2 | a usage error or an invalid event: a bug in the stop file's line, refused whether or not anyone listens |

**The schema** (`schema: 4`). Every event is one JSON object with the keys `schema`, `runid`, `at`,
`event`, then the event's own fields, in that order. `runid` is the run's id, minted once per unit's
run, so one session's events can carry several; key on the unit `id`, never on `runid` alone. The
`plan` event carries the session's first unit's `runid` and `unit-started` carries each unit's, so a
consumer that maps a `runid` to its plan learns every unit's from those two events. `at` is the
emitter's UTC ISO time. A key outside the list is refused, so a new field is a schema bump: the
emitter and the parser move to the next number together, and a consumer that checks `schema` refuses
the new events whole rather than meeting a key it does not know. Schema 2 added `plan`, `plan_path`,
and `repo` to the `plan` event; schema 3 added the `unit-started` event; schema 4 added the
`failed`, `cancelled` and `abandoned` outcomes and the `branch` and `worktrees` fields to `finished`.
A consumer must accept schema 4 (the three outcomes, the two fields) before this version is
installed: one that still checks for 3 refuses every event, and the run says so only in its own
record (a graph run puts `the finished event did not reach the launcher` in `history.json`'s `error`).

| `event` | fields | fired by |
| --- | --- | --- |
| `plan` | `plan` (optional): the plan's title; `plan_path` (optional): the plan file's path; `repo`: the repo as `owner/name`; `units: [{id, title}]`, every unit the session will build, in plan order. Work with no plan carries neither `plan` nor `plan_path` | once per session, at SKILL §Setup, as soon as the unit list is known and before the first unit's brief, under the first unit's `runid` (BRIEF §The launcher's events); FROM-BRANCH, after the hand-test file's commit |
| `unit-started` | `id`; `plan_path` (optional): the plan file's path, as the `plan` event named it; `repo`: the repo as `owner/name` | BRIEF step 6, once per unit, after its brief's commit, under the unit's own `runid` |
| `unit-merged` | `id`, `pr` | SHIP step 5, once the unit's PR has merged |
| `blocked` | `id` (optional), `needs`: what the operator must do | CLOSE §The launcher's events, wherever a run stops for the operator or banks, except a bank that ends the session's last unit, which fires `finished` instead |
| `finished` | `outcome`: `merged`, `unmerged`, `failed`, `cancelled` or `abandoned`; `pr` (optional); `branch` (optional): the run's branch; `worktrees` (optional, `--worktree` repeated): the worktrees the run left on disk | once per session, after its last unit: `merged` at SHIP step 5; `unmerged` when the last unit banks (CLOSE) or is held (SHIP, top). A graph run (`graph/`) fires it once when the run ends: `merged` once its merge node merged, `failed`, `cancelled` (`build-graph cancel`), `abandoned` (the operator's reply at the merge wait), or `unmerged` for a graph that merges nothing |

A unit `id` is the plan's unit id in lowercase (`u1`, `u2`) for a unit of the session's plan; any
other unit (work with no plan, a batch, a `--from-branch` run) has its run's `runid`, never its branch
name, which may hold `=`. Each unit mints its own `runid` with `mktemp`, which never hands out a name
already taken, so no two units of one session share an id. It holds no whitespace and no `=`.

**Consumers are idempotent.** After a compaction or a resume a stop may fire the same event again, so
a repeat must change nothing: key a `unit-started`, a `unit-merged`, and a `blocked` on the event and the unit `id`, and
a `plan` on each listed unit's `id`, adding only the units not yet known. `finished` names no unit: it
is the session's outcome, and the last one received stands, since a run that banked on its last unit
(`finished` `unmerged`) and was later unbanked fires `finished` again, `merged`.

**Types for a consumer.** Import from `~/.agent-build/runtime/lib/buildEvents.ts`: the event types,
`readBuildEvent` (parse and validate one line), and `formatBuildEvent`. It pulls in only
`lib/shape.ts`.
