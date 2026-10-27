# Mock runs: replaying a recorded /build run on the build graph

A mock replays one recorded `/build` run on [`../pipelines/build.ts`](../pipelines/build.ts): stub
agents copy the recorded agents' files, stub classifiers answer what the recorded run did, and the
pipeline's checks and operations run for real on a throwaway stand-in repo, with a file tracker and
forge. A mock touches nothing outside its own folder: its run carries no event consumer, so it fires
no build event. The fixtures themselves (`../fixtures/`) stay
in the private repo; this folder holds the tools.

| file | what it is |
| --- | --- |
| `make.ts` | makes a fixture from a recorded run |
| `mock.ts` | runs a fixture against the server `build-graph dev` serves |
| `record.ts` | a finished run's record: nodes, gates, data items, checks |
| `replay-steps.mjs` | the stand-in repo's steps script |

## Running a mock

```
node cli.ts dev                                                  # in one terminal
node mock/mock.ts fixtures/<run> [--out <dir>] [--timeout-s <n>] [--real-classifiers] # in another
```

It writes the run's record (`record.md`), history and drawing into its folder.

`--real-classifiers` binds the classifiers as the real-run config (`../pipelines/build.config.json`) does: the
shipped setups, all on Jev. The worker needs `TYPESAFE_API_KEY`. The agents, the tracker and the forge
stay stubs. Two things follow from replaying a recorded run under classifiers it did not have:

- The stand-in repo's code is synthetic, so a classifier that reads the diff judges placeholder lines,
  not the recorded change; only the start text, the ticket, the brief and the risk moment are real.
- The classifiers pick another reader set than the recording's, so the stub agents replay through
  [`replay.ts`](replay.ts) (the stub binding's `replay`), which bends the recording to it:
  - an output the recording does not hold (a reader it never ran, a fix round it never made) is
    written as "no findings" in its format: `NO FINDINGS`, a stage read that resolves or agrees with
    every row it is given, a fix file that marks every row `blocked`;
  - a recorded fix file loses its lines for rows not in the round's table; a row with no line takes
    the line of a dropped row that names it, else it is `dropped`;
  - a recorded stage read gets a status line for each given row it never saw.

  Every line it writes says `mock replay`, and each agent run lists its changes in
  `<out>/mock-replay.txt` under its node's folder (`cat <run>/nodes/*/*/out/mock-replay.txt`). With
  the replay both shipped fixtures run to the end.

## The stand-in repo

The recorded runs' repos are private, so the stand-in holds none of their code. Its files have the
recorded paths, and each recorded commit changes them by the recorded line counts: the base holds,
in every file a commit touches, a region of lines that commit deletes, between separator lines no
commit touches. A writer's patch applies, and two writers merge, in whatever order the graph runs
them. The brief is the recorded text, so its amend patches are the recorded ones. `make.ts` prints a
`note:` wherever a count could not be matched (a file created and changed again later).

The steps (`.claude/build-steps.toml`) run `replay-steps.mjs`, which replays each recorded call's
result by call number (`control/replay.json`) and moves main where the recorded run saw it move. The
notes (`.build/notes.md`) name the briefs folder (none when the store keeps the brief), the base
branch, the repo readers and the stack.

## Making a fixture

```
node mock/make.ts fixtures/<run> --source <recorded repo> --run-dir <recorded run dir> \
  [--store <brief store>] [--file <name>=<path> …] [--redact <word>=<by> …] [--ticket <prefix> …]
```

- `<run>/spec.json` says what to take: the base commit, the brief's versions, main's moves, each
  writer's commits, the recorded files, and the edits the graph needs to replay them.
- `--file` names a recorded file kept outside the run dir.
- Every copied text has home paths (absolute or `~/`), temp paths, addresses and forge or tracker
  URLs replaced by placeholders. `--redact` replaces a private name in every text and path, keeping
  its case, and `--ticket` a private tracker team's ids (`<prefix>-<n>` becomes `TEAM-<n>`); both are
  passed on the command line, so no fixture file holds them, and `<run>/redactions.json` keeps their
  hashes for the privacy test (`__tests__/fixturePrivacy.test.ts`).
- A brief kept in the run's store has no `at` in the spec: the stand-in tree holds no brief, and an
  amend is the empty `amend brief:` commit the recorded run made.
- Files the spec does not name (authored answers, edits) are left as they are.
