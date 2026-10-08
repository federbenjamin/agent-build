# Build events

A launcher that wants to follow a build (a desk, a dashboard) learns of its milestones through
`BUILD_EVENT_CMD`. /build never names a launcher: at each milestone its stop files run
`~/.agent-build/runtime/buildEvent.ts <event> --runid <runid> [flags]`, and that script hands the event
to whatever command the variable holds.

**Who sets it.** The launcher, in the environment of the session it opens. Never the repo: whether
anyone listens depends on who launched the build, not on what is being built.

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

**The schema** (`schema: 1`). Every event is one JSON object with the keys `schema`, `runid`, `at`,
`event`, then the event's own fields, in that order. `runid` is the run's id, minted once per unit's
run, so one session's events can carry several; key on the unit `id`, never on `runid`. `at` is the
emitter's UTC ISO time. A key outside the list is refused, so a new field is a schema bump.

| `event` | fields | fired by |
| --- | --- | --- |
| `plan` | `units: [{id, title}]`, every unit the session will build, in plan order | BRIEF step 6, after the brief's commit; FROM-BRANCH, after the hand-test file's commit |
| `unit-merged` | `id`, `pr` | SHIP step 5, once the unit's PR has merged |
| `blocked` | `id` (optional), `needs`: what the operator must do | CLOSE §The launcher's events, wherever a run stops for the operator or banks, except a bank that ends the session's last unit, which fires `finished` instead |
| `finished` | `outcome`: `merged` or `unmerged`, `pr` (optional) | once per session, after its last unit: `merged` at SHIP step 5; `unmerged` when the last unit banks (CLOSE) or is held (SHIP, top) |

A unit `id` is the plan's unit id in lowercase (`u1`, `u2`) for a unit of the session's plan; any
other unit (work with no plan, a batch, a `--from-branch` run) has its run's `runid`, never its branch
name, which may hold `=`. Each unit mints its own `runid` with `mktemp`, which never hands out a name
already taken, so no two units of one session share an id. It holds no whitespace and no `=`.

**Consumers are idempotent.** After a compaction or a resume a stop may fire the same event again, so
a repeat must change nothing: key a `unit-merged` and a `blocked` on the event and the unit `id`, and
a `plan` on each listed unit's `id`, adding only the units not yet known. `finished` names no unit: it
is the session's outcome, and the last one received stands, since a run that banked on its last unit
(`finished` `unmerged`) and was later unbanked fires `finished` again, `merged`.

**Types for a consumer.** Import from `~/.agent-build/runtime/lib/buildEvents.ts`: the event types,
`readBuildEvent` (parse and validate one line), and `formatBuildEvent`. It pulls in only
`lib/shape.ts`.
