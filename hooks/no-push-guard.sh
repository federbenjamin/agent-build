#!/usr/bin/env bash
# PreToolUse:Bash guard the agent-build plugin ships: a subagent never pushes and never opens,
# readies, edits, or merges a PR; the spawning session owns every push and PR. Commits stay allowed.
# Runs on every Bash call in a session with the plugin enabled; a call with no `agent_id` (the
# main session's) passes at once, so only a subagent's commands are ever matched.
#
#   no-push-guard.sh <plugin root>      stdin: the hook input
#
# Two matches, in order:
#   1. Built-in forms: `git push` (not `git stash push`, `git help push`, nor a `git commit` whose
#      message holds the word), `gh pr create|ready|merge|edit|close|reopen|lock|unlock`, a `gh api`
#      with a method or field flag.
#   2. Only when 1 misses and a segment runs a script runner (pnpm, npm, npx, yarn, bun, tsx, node):
#      the repo's own ship steps, `push`, `pr_open` and `merge` from `<root>/runtime/steps.ts <cwd>
#      --json`, each matched by its last token in a runner segment (`pnpm pr:merge`, `pnpm run
#      pr:merge`). A step whose command is a plain git/gh form is already covered by 1. A non-zero
#      exit from steps.ts (a public repo with no store dir) fails open.
# Accepted gaps: a repo script that is not a step (a `pnpm pr:ready`); a ship script run by
# path (`tsx scripts/push.ts`); variable indirection (`X=git; $X push`): the guard matches command
# TEXT, never evaluated values. Deliberate over-blocks: `git log --grep push` (a bare `push`
# token), `gh pr list --search create`, a read-only `gh api graphql -f query=…` (a field flag). A subagent that hits one reports to its spawning session,
# which runs the command itself; there is no escape hatch.
#
# Normalization, then a match per command segment, per WHOLE token:
#   1. Quote characters and backslashes are DELETED (bash's quote and escape removal join
#      fragments: `g''i''t push` and `g\it push` both run git).
#   2. Literal `${IFS}`/`$IFS` become a space, as the shell would expand them.
#   3. Delimiters and substitution syntax become segment breaks, so `git push;`, `$(git push)`,
#      a backticked, subshelled or chained form each put the real command at a segment head.
#   4. Per segment, transparent prefixes are stripped (env, sudo, `bash -c`, `X=1`), then the
#      tokens are SCANNED: a keyword matches as its own token anywhere, never by position
#      relative to a flag, so no flag list can be incomplete (`gh -u x pr create` blocks).
#
# Log: one line per firing in a subagent (time, blocked|passed, agent type, session) at
# ${NO_PUSH_GUARD_LOG:-~/.local/state/agent-build/hooks/no-push-guard.log}; read it back with
# `awk '{print $2}' <log> | sort | uniq -c`.
# Fail OPEN on garbage stdin; exit 2 + stderr blocks. Missing jq blocks one tool call rather
# than silently disabling the guard.

set -u

ROOT=${1:-}
INPUT=$(cat 2>/dev/null) || exit 0
[ -n "$INPUT" ] || exit 0
# A main session's call carries no agent_id: it passes before jq is even needed.
case "$INPUT" in *'"agent_id"'*) ;; *) exit 0 ;; esac
command -v jq >/dev/null 2>&1 || {
  echo "no-push-guard: jq is missing, so the never-pushes guard cannot evaluate this command. Install jq (the guard blocks rather than silently going inactive)." >&2
  exit 2
}

AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || exit 0
[ -n "$AGENT_ID" ] || exit 0
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0
AGENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.agent_type // "-"' 2>/dev/null)
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "-"' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || CWD=$PWD

LOG="${NO_PUSH_GUARD_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-build/hooks/no-push-guard.log}"
log() {
  { mkdir -p "$(dirname "$LOG")" && printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$AGENT_TYPE" "$SESSION" >>"$LOG"; } 2>/dev/null || true
}

NORM=$(printf '%s' "$CMD" \
  | tr -d '"' | tr -d "'" | tr -d '\\' \
  | sed -e 's/\${IFS}/ /g' -e 's/\$IFS/ /g' \
  | tr ';&|(){}`' '\n' \
  | tr '\t' ' ' | tr -s ' ')

strip_prefixes() {
  s=$(printf '%s' "$1" | sed -e 's/^ *//' -e 's/ *$//')
  while :; do
    case "$s" in *' '*) ;; *) break ;; esac
    first=${s%% *}
    rest=${s#* }
    case "$first" in
      env | command | nice | ionice | xargs | time | timeout | stdbuf | nohup | sudo | eval | exec | builtin)
        # The prefix's own flags and a bare number (`nice -n 5`, `timeout 5`, `env -i`) go with it.
        s=$rest
        while :; do
          case "$s" in *' '*) ;; *) break ;; esac
          case "${s%% *}" in -* | [0-9]*) s=${s#* } ;; *) break ;; esac
        done
        continue
        ;;
      *=*)
        s=$rest
        continue
        ;;
      bash | sh | zsh | dash | ksh)
        case "$rest" in
          -c\ * | -lc\ * | -ic\ * | -ec\ *)
            s=${rest#* }
            continue
            ;;
        esac
        ;;
    esac
    break
  done
  printf '%s' "$s"
}

# The binary a segment runs: `npx <x>` unwraps to its first runner-or-ship token.
bin_of() {
  local IFS=$' \t\n'
  local -a ARGS=("$@")
  local bin=${ARGS[0]##*/} tok
  if [ "$bin" = npx ]; then
    for tok in "${ARGS[@]:1}"; do
      case "${tok##*/}" in
        git | gh | pnpm | npm | yarn | bun | tsx | node) printf '%s' "${tok##*/}"; return 0 ;;
      esac
    done
    return 1
  fi
  printf '%s' "$bin"
}

is_runner() {
  case "$1" in pnpm | npm | yarn | bun | tsx | node) return 0 ;; esac
  return 1
}

# Match 1: the built-in forms.
is_ship() {
  local IFS=$' \t\n'
  local -a ARGS=("$@")
  [ ${#ARGS[@]} -gt 0 ] || return 1
  local bin tok
  bin=$(bin_of "${ARGS[@]}") || return 1
  case "$bin" in
    git)
      local seen_carveout=0
      for tok in "${ARGS[@]}"; do
        case "$tok" in
          stash | help | commit) seen_carveout=1 ;;
          push) [ "$seen_carveout" -eq 1 ] || return 0 ;;
        esac
      done
      return 1
      ;;
    gh)
      local after_pr=0 has_api=0
      for tok in "${ARGS[@]}"; do
        if [ "$after_pr" -eq 1 ]; then
          case "$tok" in
            create | ready | merge | edit | close | reopen | lock | unlock) return 0 ;;
          esac
        fi
        [ "$tok" = pr ] && after_pr=1
        [ "$tok" = api ] && has_api=1
      done
      if [ "$has_api" -eq 1 ]; then
        for tok in "${ARGS[@]}"; do
          case "$tok" in
            -X | -X* | --method | --method=* | -f | -F | --field | --field=* | --raw-field | --raw-field=* | --input | --input=*) return 0 ;;
          esac
        done
      fi
      return 1
      ;;
  esac
  return 1
}

# Match 2: the last token of each runner-shaped ship step of the repo at $CWD, one per line.
# Empty when the plugin root or steps.ts is missing, or steps.ts exits non-zero (fail open).
step_tokens() {
  [ -n "$ROOT" ] && [ -f "$ROOT/runtime/steps.ts" ] || return 0
  local json cmd
  local IFS=$' \t\n'
  json=$(node "$ROOT/runtime/steps.ts" "$CWD" --json 2>/dev/null) || return 0
  printf '%s' "$json" \
    | jq -r '.steps[] | select(.step == "push" or .step == "pr_open" or .step == "merge") | .command // empty' 2>/dev/null \
    | while IFS= read -r cmd; do
        IFS=$' \t\n'
        # shellcheck disable=SC2086
        set -- $cmd
        [ $# -gt 0 ] || continue
        is_runner "${1##*/}" || continue
        while [ $# -gt 1 ]; do case "${!#}" in -*) set -- "${@:1:$(($# - 1))}" ;; *) break ;; esac; done
        printf '%s\n' "${!#}"
      done
}

# True when a runner segment's tokens hold one of the step tokens in $1 (newline-separated).
runs_step() {
  local tokens=$1; shift
  local IFS=$' \t\n'
  local -a ARGS=("$@")
  local bin tok t
  bin=$(bin_of "${ARGS[@]}") || return 1
  is_runner "$bin" || return 1
  for tok in "${ARGS[@]:1}"; do
    while IFS= read -r t; do
      [ -n "$t" ] && [ "$tok" = "$t" ] && return 0
    done <<<"$tokens"
  done
  return 1
}

block() {
  set +f
  IFS=$OLDIFS
  log blocked
  echo "no-push-guard: a subagent never pushes and never opens, readies, edits, or merges a PR — commit on your branch, run the local gates, and report the branch, worktree, and PR-body path; the spawner pushes and opens the PR. Blocked: $CMD" >&2
  exit 2
}

OLDIFS=$IFS
IFS='
'
set -f
SEGMENTS=()
HAS_RUNNER=0
for seg in $NORM; do
  seg=$(strip_prefixes "$seg")
  [ -n "$seg" ] || continue
  IFS=' '
  # Deliberate word-splitting: $seg is normalized (quotes and backslashes deleted, whitespace
  # collapsed) and this is the tokenization step.
  # shellcheck disable=SC2206
  SEGTOK=($seg)
  IFS='
'
  if is_ship "${SEGTOK[@]}"; then block; fi
  b=$(bin_of "${SEGTOK[@]}") && is_runner "$b" && HAS_RUNNER=1
  SEGMENTS+=("$seg")
done

if [ "$HAS_RUNNER" -eq 1 ]; then
  TOKENS=$(step_tokens)
  if [ -n "$TOKENS" ]; then
    for seg in "${SEGMENTS[@]}"; do
      IFS=' '
      # shellcheck disable=SC2206
      SEGTOK=($seg)
      IFS='
'
      if runs_step "$TOKENS" "${SEGTOK[@]}"; then block; fi
    done
  fi
fi
set +f
IFS=$OLDIFS
log passed
exit 0
