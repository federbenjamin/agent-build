#!/bin/sh
# The staged scene hero.sh films: one /build run on a fixture repo (todo-cli), stop by stop.
# Nothing here runs a build. Each line condenses a ledger line a real run writes (class, build,
# wave, verifier, fix-<n>, confirm-<n>, hand-test-<n>, ship); the request, files, counts, shas and
# PR number are the fixture's. Colours follow the diagrams: blue for agents, green for scripts and
# the repo's steps, amber for decisions.
set -eu

e=$(printf '\033')
R="${e}[0m" BOLD="${e}[1m" DIM="${e}[2m" AGENT="${e}[38;5;75m" SCRIPT="${e}[38;5;114m" DECIDE="${e}[38;5;214m"

# row <stop> <colour> <who> <what> [sha]
row() { printf ' %s%-7s%s%s%-19s%s%-66s%s%s%s\n' "$BOLD" "$1" "$R" "$2" "$3" "$R" "$4" "$DIM" "${5:-}" "$R"; }
# reader <colour> <who> <result>: one reader of a parallel read, under the row that names the read
reader() { printf ' %-26s%s%-28s%s%s\n' "" "$1" "$2" "$R" "$3"; }

printf '\033[?25l'
printf ' %stodo-cli%s  > %s\n\n' "$DIM" "$R" "/build add a --json flag to \`todo list\`"

row BRIEF "$AGENT" "prior-art" "reuse: src/format/table.ts already walks the rows"
row "" "$AGENT" "brief-writer" "brief committed before any code: 2 parts, 6 hand-test claims" 3f1c9a2
row "" "$DECIDE" "class R1" "a user would see wrong output; yours to veto"
echo
row BUILD "$AGENT" "builder P1" "--json on \`todo list\`, in its own worktree" 8b04e7d
row "" "$AGENT" "builder P2" "toJson() in src/format/, in its own worktree" c71d2a9
row "" "$AGENT" "test-author" "9 tests from its slice of the brief, not from the code"
row "" "$SCRIPT" "merge" "parts and tests merged, exit checks pass" e25b6f0
echo
row CLOSE "$SCRIPT" "wave" "five readers at once, each in its own review tree"
reader "$AGENT" "review-cursory" "4 findings"
reader "$AGENT" "review-cursory (Codex)" "2 findings"
reader "$AGENT" "gate-silent-failure-hunter" "2 findings"
reader "$AGENT" "simplifier" "1 finding"
reader "$AGENT" "build-verifier" "CLEAN"
row "" "$SCRIPT" "reviewTable.ts" "fix table 1: 9 rows (behavior 3, structure 1, text 5)"
row "" "$AGENT" "fixer, round 1" "9/9 rows fixed by a fresh agent" a90d3be
reader "$AGENT" "review-cursory (Codex)" "1 finding"
reader "$AGENT" "gate-silent-failure-hunter" "clear"
reader "$AGENT" "hand-tester" "5/6 claims pass, H4 fails on the code"
row "" "$SCRIPT" "reviewTable.ts" "fix table 2: 2 rows (behavior 2)"
row "" "$AGENT" "fixer, round 2" "2/2 rows fixed by another fresh agent" d4e81c7
reader "$AGENT" "review-cursory (Codex)" "clean"
reader "$AGENT" "hand-tester" "6/6 claims pass"
echo
row SHIP "$SCRIPT" "checks" "pnpm -s typecheck && pnpm -s test: pass"
row "" "$SCRIPT" "push, PR" "feat/todo-json pushed once, draft PR #12"
row "" "$SCRIPT" "shipGate.ts" "PASS on facts no agent wrote: brief first, every read in"
row "" "$SCRIPT" "merge" "#12 squash-merged into main" 7e3a1c5
