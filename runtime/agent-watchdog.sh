#!/usr/bin/env bash
# agent-watchdog.sh — the watch on background subagents and Codex runs.
#
# Completion notifications are dropped when several background agents finish close together
# (claude-code#21165); this exits once every watched agent has finished, gone stale, or hit the
# deadline. With --flags it also exits at the first flag, naming the one agent to look at.
#
# Usage:
#   agent-watchdog.sh [--poll S] [--stale S] [--deadline S] [--flags]
#                     [--codex <log>:<out>]... [--ack <agent>:<flag>:<count>]...
#                     [--part-files <path>=<file>]... <path>...
#     <path>   a task .output path (symlink) or the agent-*.jsonl it points to
#     --codex  a Codex run, named by <out>'s basename: finished when <out> is non-empty;
#              its last write is <log>'s mtime
#     --part-files  (--flags only) <path> is one of the <path> arguments, as typed; <file> holds
#              `briefCheck.ts --files <P<k>|W<k>>`'s output. That agent alone gets the off-part
#              flag: WATCH_OFF_PART_FILES distinct files edited in its cwd that no entry matches.
#   Defaults: --poll 20  --stale 900  --deadline 7200
#   --flags  limits from thresholds.ts (WATCH_*) in the cwd's repo; a full scan (watchScan.ts)
#            at arming and every WATCH_SCAN_MIN minutes; no stale check unless --stale is given;
#            no deadline unless --deadline is given. On a flag it prints FLAG, LAST (the last 8
#            tool calls), and an `ack:` line; re-arm with that --ack to quiet the flag until its
#            count grows by the limit again.
# Exit: 0 = all agents finished cleanly; 1 = at least one stale/missing/deadline; 2 = usage;
#       3 = a flag (--flags only).

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
POLL=20; STALE=900; DEADLINE=7200; STALE_SET=0; DEADLINE_SET=0; FLAGS=0
need_int() { case "${2:-}" in ''|*[!0-9]*) echo "WATCHDOG error: $1 needs an integer" >&2; exit 2 ;; esac; }
need_val() { [ -n "${2:-}" ] || { echo "WATCHDOG error: $1 needs a value" >&2; exit 2; }; }
PATHS=(); ACKS=(); CODEX_LOGS=(); CODEX_OUTS=(); PF_KEYS=(); PF_FILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --poll) need_int --poll "${2:-}"; POLL=$2; shift 2 ;;
    --stale) need_int --stale "${2:-}"; STALE=$2; STALE_SET=1; shift 2 ;;
    --deadline) need_int --deadline "${2:-}"; DEADLINE=$2; DEADLINE_SET=1; shift 2 ;;
    --flags) FLAGS=1; shift ;;
    --ack) need_val --ack "${2:-}"; ACKS+=("--ack" "$2"); shift 2 ;;
    --part-files)
      need_val --part-files "${2:-}"
      case "$2" in
        ?*=?*) PF_KEYS+=("${2%%=*}"); PF_FILES+=("${2#*=}") ;;
        *) echo "WATCHDOG error: --part-files needs <path>=<file>" >&2; exit 2 ;;
      esac
      [ -r "${PF_FILES[${#PF_FILES[@]}-1]}" ] || { echo "WATCHDOG error: --part-files file not readable: ${PF_FILES[${#PF_FILES[@]}-1]}" >&2; exit 2; }
      shift 2 ;;
    --codex)
      need_val --codex "${2:-}"
      case "$2" in
        ?*:?*) CODEX_LOGS+=("${2%%:*}"); CODEX_OUTS+=("${2#*:}") ;;
        *) echo "WATCHDOG error: --codex needs <log>:<out>" >&2; exit 2 ;;
      esac
      shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done
[ $((${#PATHS[@]} + ${#CODEX_OUTS[@]})) -gt 0 ] || { echo "WATCHDOG error: no agent paths given" >&2; exit 2; }
[ "$FLAGS" -eq 1 ] || [ ${#ACKS[@]} -eq 0 ] || { echo "WATCHDOG error: --ack needs --flags" >&2; exit 2; }
[ "$FLAGS" -eq 1 ] || [ ${#PF_KEYS[@]} -eq 0 ] || { echo "WATCHDOG error: --part-files needs --flags" >&2; exit 2; }

scan_node() { NODE_NO_WARNINGS=1 node "$HERE/watchScan.ts" "$@"; }

# Resolve .output symlinks to the underlying agent-*.jsonl; report each agent under the basename
# it was armed with (the task id the orchestrator knows). Codex runs follow the transcripts.
FILES=(); NAMES=(); KINDS=(); PARTS=()
for p in ${PATHS[@]+"${PATHS[@]}"}; do
  base=$(basename "$p"); base=${base%.output}; base=${base%.jsonl}
  part=""
  for k in ${PF_KEYS[@]+"${!PF_KEYS[@]}"}; do [ "${PF_KEYS[$k]}" = "$p" ] && part=${PF_FILES[$k]}; done
  r=$(readlink "$p" 2>/dev/null || true)
  [ -n "$r" ] && p=$r
  FILES+=("$p"); NAMES+=("$base"); KINDS+=(transcript); PARTS+=("$part")
done
for k in ${PF_KEYS[@]+"${!PF_KEYS[@]}"}; do
  hit=0
  for p in ${PATHS[@]+"${PATHS[@]}"}; do [ "$p" = "${PF_KEYS[$k]}" ] && hit=1; done
  [ "$hit" -eq 1 ] || { echo "WATCHDOG error: --part-files names no watched path: ${PF_KEYS[$k]}" >&2; exit 2; }
done
for i in ${CODEX_OUTS[@]+"${!CODEX_OUTS[@]}"}; do
  base=$(basename "${CODEX_OUTS[$i]}"); base=${base%.*}
  FILES+=("${CODEX_LOGS[$i]}"); NAMES+=("$base"); KINDS+=("codex:${CODEX_OUTS[$i]}"); PARTS+=("")
done

if [ "$FLAGS" -eq 1 ]; then
  SCAN_MIN=$(NODE_NO_WARNINGS=1 node "$HERE/thresholds.ts" . --get WATCH_SCAN_MIN) || { echo "WATCHDOG error: thresholds.ts failed" >&2; exit 2; }
  need_int WATCH_SCAN_MIN "$SCAN_MIN"
  [ "$STALE_SET" -eq 1 ] || STALE=""
  [ "$DEADLINE_SET" -eq 1 ] || DEADLINE=""
fi

START=$(date +%s)
LAST_SCAN=""
declare -a STATE  # ""=pending, else terminal status
for i in "${!FILES[@]}"; do STATE[$i]=""; done
DEGRADED=0

mtime_of() {
  # GNU stat first (-c fails cleanly on BSD; BSD -f "succeeds" with garbage on GNU).
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo "$2"
}

while :; do
  NOW=$(date +%s); PENDING=0; SCAN_ARGS=()
  for i in "${!FILES[@]}"; do
    [ -n "${STATE[$i]}" ] && continue
    f=${FILES[$i]}; name=${NAMES[$i]}; kind=${KINDS[$i]}
    if [ "$kind" = transcript ]; then
      sr=$(scan_node state "$f") || { echo "WATCHDOG error: watchScan.ts state failed on $f" >&2; exit 2; }
      mtime_fallback=$NOW
    else
      out=${kind#codex:}
      if [ -s "$out" ]; then sr=finished; else sr=running; fi
      mtime_fallback=$START  # a log not written yet counts from the arming
    fi
    if [ "$sr" = "finished" ]; then
      STATE[$i]=finished; echo "AGENT $name finished"
    elif [ "$sr" = "missing" ]; then
      STATE[$i]=stale; DEGRADED=1; echo "AGENT $name stale (transcript missing)"
    else
      mtime=$(mtime_of "$f" "$mtime_fallback")
      if [ -n "$STALE" ] && [ $((NOW - mtime)) -ge "$STALE" ]; then
        STATE[$i]=stale; DEGRADED=1; echo "AGENT $name stale (no write for $((NOW - mtime))s)"
      else
        PENDING=1
        if [ "$kind" = transcript ]; then
          SCAN_ARGS+=(--agent "$name=$f")
          [ -z "${PARTS[$i]}" ] || SCAN_ARGS+=(--part-files "$name=${PARTS[$i]}")
        else
          SCAN_ARGS+=(--codex "$name=$f")
        fi
      fi
    fi
  done
  [ "$PENDING" -eq 0 ] && break
  if [ "$FLAGS" -eq 1 ] && { [ -z "$LAST_SCAN" ] || [ $((NOW - LAST_SCAN)) -ge $((SCAN_MIN * 60)) ]; }; then
    LAST_SCAN=$NOW
    scan_node scan --armed-at "$START" ${ACKS[@]+"${ACKS[@]}"} "${SCAN_ARGS[@]}"
    rc=$?
    if [ "$rc" -eq 3 ]; then echo "WATCHDOG flagged"; exit 3; fi
    [ "$rc" -eq 0 ] || { echo "WATCHDOG error: watchScan.ts scan exited $rc" >&2; exit 2; }
  fi
  if [ -n "$DEADLINE" ] && [ $((NOW - START)) -ge "$DEADLINE" ]; then
    for i in "${!FILES[@]}"; do
      [ -z "${STATE[$i]}" ] && { echo "AGENT ${NAMES[$i]} deadline"; DEGRADED=1; }
    done
    break
  fi
  sleep "$POLL"
done

if [ "$DEGRADED" -eq 0 ]; then echo "WATCHDOG done"; exit 0; else echo "WATCHDOG degraded"; exit 1; fi
