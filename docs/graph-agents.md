# Graph runs: what an agent reads and writes

The rules for an agent the graph runner (`graph/`, `/build` as a graph) dispatches. An agent knows it
is in a graph run because its dispatch is an inputs file, `inputs.json`, not prose. A dispatch in prose
is today's `/build`: these rules do not apply, and the agent's own file is the whole contract.

## Inputs

- `inputs.json` names the `role`, the `iteration` (0 outside the close loop), the fan-out `item` when
  there is one (a part, a test slice, a repo reader), and the `worktree` to work in. Its shape is
  `InputsFile` in `graph/contracts.ts`.
- `inputs` holds each data item the node reads, by data id. A files item lists absolute paths: read
  those files where the prose dispatch would have quoted or named them (the brief, the table, the fix
  file, the diff, a reader's file).
- `outputs` names, for each output, the folder to write it in.
- `answers` holds the answers to the questions an earlier run of this node raised, one line each,
  `<question id>: <answer>[ Brief change: <change>] (source: <where it came from>)`. Act on them; never
  ask the same question again. A brief change on the line is already in the brief when the amend service ran; when you are
  the one writing the brief, fold it in yourself. A line whose source is `your last run` is no answer: it is the `blocked` question your last
  run raised and what it searched, handed to this fresh run as the place to start. Still blocked, ask
  it again; the operator answers it then.
- `question` and `answer` are set only for the brief writer in amend mode and for the resolver.
- `conflict` is set only on a writer's fresh run after its earlier commit did not merge into the run
  tree: `commit` (that commit), `paths` (the files git left conflicted) and `restart` (1 on the first
  such run). Your worktree is at the run tree's head, and your earlier commit's work is not in it. Run
  `git merge <commit>`, resolve every path in `paths` keeping both sides' intent (the other side is
  another writer's merged work), finish as your own file says, run the checks, and commit. Write every
  output again in full: the runner replaces the earlier run's outputs with this run's. A run whose head
  holds neither `commit` nor a change of its own on the head it began at hands the merge `commit`
  again, which conflicts as before and counts against the cap; work git still holds unmerged is not
  committed for you.

## Outputs

- Write each output into its folder, in the format the agent's own file gives it (a findings file, a
  stage file, a fix file, a hand-test file, a report). A hand-test file is `hand-test-<n>.txt`, with
  `<n>` the inputs file's `iteration` plus 1. The runner checks every output against its
  format before anything reads it; an output that fails the check runs the agent once more, fresh.
- The final message is not read. Anything the operator or the session would have read in it goes in
  an output file.
- A writer (builder, test writers, fixer, the brief writer in amend mode) commits its work in its
  worktree. The runner reads the worktree's head and merges it into the run tree; a merge that
  conflicts runs you again, fresh, with `conflict` set (§Inputs). Never push, never open a PR, never
  move another branch.
- Before you exit, leave `struggles.json` beside `questions.json`, in the folder of your first output,
  when the run cost you a detour: a list of up to five moments where you needed something you did not
  have. Each entry says the `category` of what was missing (a word of your choosing: `docs`, `brief`,
  `tool`, `env`, `code`), `where` (the file or check it was about), what you were doing (`moment`),
  what you `needed` in one line, and what would have let you skip the detour (`skip`). No detour, no file.
  Nothing checks it; `build-graph stats` prints the ones that recur across runs. When you are run
  again (a retry, or a rerun on answers), the runner moves the last attempt's `struggles.json` and
  `crosstalk.jsonl` out of your output folder into that attempt's own folder
  (`rerun-<r>/attempt-<n>/out/<output>/`, beside its record) before you start, so write only this
  attempt's; `stats` reads every attempt's.

## Peers

A fix round may be shared out among fixers that run at once, one per fix slice (the `fix-slices`
fan-out). A fixer's slice is the one in the `slice-plan` item (`slices.json`, `SlicePlan` in
`graph/pipelines/build/slices.ts`) whose `id` is the inputs file's `item`: its `rows`, the `files` it
owns, and its `peers`. Each peer is another slice of the round: its `item`, its `session` (the name
its agent session runs under, `<run>-<node>-<iteration>-<item>`), its `nodeRun` folder, the `files`
its slice owns, and the `links` between the two slices that the round left split (what one slice's
fix will likely change that the other's files use).

- Read your peers before your first edit. A link from your slice is a promise to the peer: make the
  change it names, or tell the peer you did not. A link to your slice is a change to build on.
- Message a peer only when it is listed in your `peers` and owns the file the message is about. The
  address is the peer's `session`, sent with `SendMessage`.
- Before you message, check the peer is still running: its `nodeRun` folder's `pgid.json` holds
  `{ "pid": <n> }` while its agent runs and `{ "pid": null }` once that attempt ended, and each
  attempt's record (`rerun-<r>/attempt-<n>.json`) has an `endedAt` once it ended. A peer that has
  ended will never read the message. A record with no `endedAt` may still be a worker that died, so
  a message is never proof of delivery.
- Never wait on a reply. Send what the peer must know, then go on with your own rows; a reply that
  comes is input, not a gate.
- Append each message you send, one JSON line, `{ "at", "to", "session", "text" }` (`at` an ISO time,
  `to` the peer's item), to `crosstalk.jsonl` beside `questions.json`, in the folder of your first
  output. Only the sender writes it; a message you receive is in your peer's file. The runner's
  output check takes it as a side file, as it does `questions.json` and `struggles.json`. The line's
  shape is `CrosstalkMessage` in `graph/pipelines/build/slices.ts`; `build-graph stats` prints each
  message with its round and slice, and drops a line that does not fit.

## Questions

- A STOP, a doubt about the brief, an ambiguous surface, or a decision only someone else can make
  ends the run the same way: write `questions.json` in the folder of the agent's first output, then
  write what output you have and exit. A folder holding only `questions.json` passes the runner's
  check, and the runner runs you again on the answers; a rerun that writes only questions already
  answered fails the node.
- `questions.json` is a list. Each question is `{ "id", "type", "text", "context"?, "recommendation"?,
  "searched" }`:
  - `id` is unique in the file (a fixer's `decision` row uses its row id).
  - `type` is one of `brief`, `public-surface`, `design-entry`, `persisted-shape`, `user-visible`,
    `conflict`, `product`, `tool`, `blocked`.
  - `searched` lists each source checked and what it said, `{ "source", "said" }`: the code, the
    brief, the plan, the docs, the tracker. A question with nothing searched is not ready to ask.
- Routing is the runner's: `blocked` runs the agent once more, fresh, then goes to the operator; a
  `product` question goes to the operator; every other type goes to the resolver agent, which answers
  from what the code, the brief, the plan, the docs or the tracker say, or hands the question to the
  operator with what it searched. A brief change the resolver proposes waits for the operator's
  approval when the runner will apply it; for the brief writer's own question it reaches the brief
  writer on its answer line.
- A fixer's `decision` lines stay in its fix file; the runner reads each one as a question. A fixer
  that cannot fix the round at all writes one `blocked` question instead of a `blocked:` report.
