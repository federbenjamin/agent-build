#!/usr/bin/env bash
# PreToolUse:Bash guard the agent-build plugin ships: a subagent never pushes and never opens,
# readies, edits, or merges a PR; the spawning session owns every push and PR. Commits stay allowed.
# Runs on every Bash call in a session with the plugin enabled; a call with no `agent_id` (the
# main session's) passes at once, so only a subagent's commands are ever matched.
#
#   no-push-guard.sh <plugin root>      stdin: the hook input
#
# Two matches, in order, each on a command segment's program slot:
#   1. Built-in forms: `git push` (not `git stash push`, `git help push`, nor a `git commit` whose
#      message holds the word), `gh pr create|ready|merge|edit|close|reopen|lock|unlock`,
#      `gh repo create … --push`, a `gh api` with a method or field flag.
#   2. Only when 1 misses and a segment runs a script runner (pnpm, npm, npx, yarn, bun, tsx, node):
#      the repo's own ship steps, `push`, `pr_open` and `merge` from `<root>/runtime/steps.ts <cwd>
#      --json`, each matched by its last token in a runner segment (`pnpm pr:merge`, `pnpm run
#      pr:merge`). A step whose command is a plain git/gh form is already covered by 1. A non-zero
#      exit from steps.ts (a public repo with no store dir) fails open.
# Accepted gaps: a repo script that is not a step (a `pnpm pr:ready`); a ship script run by
# path (`tsx scripts/push.ts`); variable indirection (`X=git; $X push`) and ANSI-C quoting
# (`$'\x67it' push`): the guard matches command TEXT, never evaluated values. Deliberate
# over-blocks: `git log --grep push` (a bare `push` token), `gh pr list --search create`, a
# read-only `gh api graphql -f query=…` (a field flag), `gh repo create --push=false`. A subagent
# that hits one reports to its spawning session, which runs the command itself; there is no
# escape hatch.
#
# Segments come from a small shell lexer (LEXER below, awk), so text that is only data never
# reaches a program slot:
#   1. Quotes and backslashes are removed and the pieces of a word joined, as bash does
#      (`g''i''t push` and `g\it push` both run git). Whitespace inside quotes stays inside its
#      word, so `echo "done; gh pr merge"` is one `echo` segment and `"git push"` is one word.
#   2. An unquoted `${IFS}`/`$IFS` splits words, as the shell would expand it.
#   3. Unquoted `;`, `&`, `|`, `(`, `)`, `{`, `}` and newlines end a segment; a `$(…)` or
#      backticked substitution, in or out of double quotes, is lexed as commands of its own.
#   4. A heredoc body is data: skipped whole under a quoted delimiter (`<<'EOF'`), and only its
#      substitutions are lexed under a bare one. A `#` comment is skipped.
#   5. Per segment, transparent prefixes are stripped (env, sudo, `X=1`); the script of
#      `bash -c '<script>'` or `eval <words>` is lexed again as commands. Then the tokens are
#      SCANNED: a keyword matches as its own token anywhere, never by position relative to a
#      flag, so no flag list can be incomplete (`gh -u x pr create` blocks).
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

# In a lexed segment: a quoted space or tab (QSP), a quoted newline (QNL); words are split by ' '.
QSP=$'\002'
QNL=$'\001'
NL=$'\n'
# strip_prefixes output that holds a `bash -c` / `eval` script to lex again.
INNER=$'\004'

# stdin: shell text. stdout: one command segment per line, its words joined by single spaces.
# shellcheck disable=SC2016
LEXER='
BEGIN { QSP = "\002"; QNL = "\001"; SEP = "\003" }
{ text = NR == 1 ? $0 : text "\n" $0 }
END { lex(text) }
function quoted(c) { return (c == " " || c == "\t") ? QSP : (c == "\n" ? QNL : c) }
function addword(seg, w) { return w == "" ? seg : (seg == "" ? w : seg " " w) }
# The ")" that closes the "(" at t[i], skipping quoted text; past the end when unclosed.
function close_paren(t, i,   n, depth, c, q) {
  n = length(t); depth = 0; q = ""
  for (; i <= n; i++) {
    c = substr(t, i, 1)
    if (q == "\047") { if (c == "\047") q = ""; continue }
    if (c == "\\") { i++; continue }
    if (q == "\"") { if (c == "\"") q = ""; continue }
    if (c == "\047" || c == "\"") q = c
    else if (c == "(") depth++
    else if (c == ")" && --depth == 0) return i
  }
  return n + 1
}
# The backtick that closes the one at t[i]; past the end when unclosed.
function close_tick(t, i,   n, c) {
  n = length(t)
  for (i++; i <= n; i++) {
    c = substr(t, i, 1)
    if (c == "\\") { i++; continue }
    if (c == "`") return i
  }
  return n + 1
}
# Lex the substitutions in s (a bare-delimiter heredoc line); the rest is data.
function subs(s,   n, i, c, e) {
  n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") { i++; continue }
    if (c == "$" && substr(s, i + 1, 1) == "(") { e = close_paren(s, i + 1); lex(substr(s, i + 2, e - i - 2)); i = e }
    else if (c == "`") { e = close_tick(s, i); lex(substr(s, i + 1, e - i - 1)); i = e }
  }
}
# Skip the bodies of the pending heredocs (pend: flags+delimiter entries) that start after the
# newline at t[i]; returns the index of the newline that ends the last delimiter line.
function heredocs(t, i, pend,   n, m, k, P, bare, strip, delim, j, line) {
  n = length(t)
  m = split(pend, P, SEP)
  for (k = 1; k <= m; k++) {
    bare = substr(P[k], 1, 1) == "0"; strip = substr(P[k], 2, 1) == "1"; delim = substr(P[k], 3)
    while (i < n) {
      j = index(substr(t, i + 1), "\n")
      line = j == 0 ? substr(t, i + 1) : substr(t, i + 1, j - 1)
      i = j == 0 ? n : i + j
      if (strip) sub(/^\t+/, "", line)
      if (line == delim) break
      if (bare) subs(line)
    }
  }
  return i
}
function lex(t,   n, i, c, d, st, w, seg, pend, e, strip, delim, hq) {
  n = length(t); st = "N"; w = ""; seg = ""; pend = ""
  for (i = 1; i <= n; i++) {
    c = substr(t, i, 1)
    if (st == "S") { if (c == "\047") st = "N"; else w = w quoted(c); continue }
    if (c == "\\") {
      d = substr(t, ++i, 1)
      if (d != "\n") w = w (st == "D" ? quoted(d) : d)
      continue
    }
    if (c == "$" && substr(t, i + 1, 1) == "(") { e = close_paren(t, i + 1); lex(substr(t, i + 2, e - i - 2)); i = e; continue }
    if (c == "`") { e = close_tick(t, i); lex(substr(t, i + 1, e - i - 1)); i = e; continue }
    if (c == "$" && (substr(t, i + 1, 5) == "{IFS}" || (substr(t, i + 1, 3) == "IFS" && substr(t, i + 4, 1) !~ /[A-Za-z0-9_]/))) {
      i += (substr(t, i + 1, 1) == "{") ? 5 : 3
      if (st == "D") w = w QSP; else { seg = addword(seg, w); w = "" }
      continue
    }
    if (st == "D") { if (c == "\"") st = "N"; else w = w quoted(c); continue }
    if (c == "\047") { st = "S"; continue }
    if (c == "\"") { st = "D"; continue }
    if (c == " " || c == "\t") { seg = addword(seg, w); w = ""; continue }
    if (c == "#" && w == "") { while (i < n && substr(t, i + 1, 1) != "\n") i++; continue }
    if (substr(t, i, 3) == "<<<") { w = w "<<<"; i += 2; continue }
    if (substr(t, i, 2) == "<<") {
      seg = addword(seg, w); w = ""
      i += 2; strip = 0; delim = ""; hq = 0
      if (substr(t, i, 1) == "-") { strip = 1; i++ }
      while (substr(t, i, 1) == " " || substr(t, i, 1) == "\t") i++
      for (; i <= n; i++) {
        d = substr(t, i, 1)
        if (d ~ /[ \t\n;&|()<>]/) break
        if (d == "\047" || d == "\"" || d == "\\") hq = 1; else delim = delim d
      }
      i--
      pend = pend (pend == "" ? "" : SEP) hq strip delim
      continue
    }
    if (c == "\n" || index(";&|(){}", c)) {
      seg = addword(seg, w); w = ""
      if (seg != "") print seg
      seg = ""
      if (c == "\n" && pend != "") { i = heredocs(t, i, pend); pend = "" }
      continue
    }
    w = w c
  }
  seg = addword(seg, w)
  if (seg != "") print seg
}
'

# One segment's program, with transparent prefixes stripped. A `bash -c` / `eval` segment prints
# INNER followed by the script it runs, for the caller to lex again.
strip_prefixes() {
  s=$(printf '%s' "$1" | sed -e 's/^ *//' -e 's/ *$//')
  while :; do
    case "$s" in *' '*) ;; *) break ;; esac
    first=${s%% *}
    rest=${s#* }
    case "$first" in
      env | command | nice | ionice | xargs | time | timeout | stdbuf | nohup | sudo | exec | builtin)
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
      eval)
        printf '%s%s' "$INNER" "$rest"
        return
        ;;
      bash | sh | zsh | dash | ksh)
        case "$rest" in
          -c\ * | -lc\ * | -ic\ * | -ec\ *)
            s=${rest#* }
            printf '%s%s' "$INNER" "${s%% *}"
            return
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
      local after_pr=0 has_api=0 after_repo=0 repo_create=0 has_push=0
      for tok in "${ARGS[@]}"; do
        if [ "$after_pr" -eq 1 ]; then
          case "$tok" in
            create | ready | merge | edit | close | reopen | lock | unlock) return 0 ;;
          esac
        fi
        [ "$after_repo" -eq 1 ] && [ "$tok" = create ] && repo_create=1
        case "$tok" in --push | --push=*) has_push=1 ;; esac
        [ "$tok" = pr ] && after_pr=1
        [ "$tok" = repo ] && after_repo=1
        [ "$tok" = api ] && has_api=1
      done
      [ "$repo_create" -eq 1 ] && [ "$has_push" -eq 1 ] && return 0
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
        set -f
        # shellcheck disable=SC2086
        set -- $cmd
        set +f
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
  log blocked
  echo "no-push-guard: a subagent never pushes and never opens, readies, edits, or merges a PR — commit on your branch, run the local gates, and report the branch, worktree, and PR-body path; the spawner pushes and opens the PR. Blocked: $CMD" >&2
  exit 2
}

SEGMENTS=()
HAS_RUNNER=0
# Match 1 on every segment of the shell text $1, recursing into `bash -c` / `eval` scripts.
check_text() {
  local seg b
  local -a SEGTOK
  while IFS= read -r seg; do
    seg=$(strip_prefixes "$seg")
    [ -n "$seg" ] || continue
    case "$seg" in
      "$INNER"*)
        seg=${seg#"$INNER"}
        seg=${seg//$QSP/ }
        check_text "${seg//$QNL/$NL}"
        continue
        ;;
    esac
    IFS=' ' read -r -a SEGTOK <<<"$seg"
    [ ${#SEGTOK[@]} -gt 0 ] || continue
    if is_ship "${SEGTOK[@]}"; then block; fi
    b=$(bin_of "${SEGTOK[@]}") && is_runner "$b" && HAS_RUNNER=1
    SEGMENTS+=("$seg")
  done < <(printf '%s' "$1" | awk "$LEXER")
}
check_text "$CMD"

if [ "$HAS_RUNNER" -eq 1 ]; then
  TOKENS=$(step_tokens)
  if [ -n "$TOKENS" ]; then
    for seg in "${SEGMENTS[@]}"; do
      IFS=' ' read -r -a SEGTOK <<<"$seg"
      if runs_step "$TOKENS" "${SEGTOK[@]}"; then block; fi
    done
  fi
fi
log passed
exit 0
