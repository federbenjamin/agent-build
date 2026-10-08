#!/usr/bin/env bash
# Delete local branches that are merged.
#   ~/.agent-build/runtime/git-delete-merged.sh [-C <dir>] <branch>...
# A branch goes only when main holds its tip, or the head of a merged PR of a branch you named
# does. So name a run's branch and its part branches together. Anything else is kept.
# `git branch -d` is no substitute: it refuses after a squash merge, and it deletes a branch that
# was only pushed.
set -euo pipefail

if [ "${1:-}" = -C ]; then
  cd "${2:?-C needs a dir}"
  shift 2
fi
[ $# -gt 0 ] || { sed -n '3p' "$0" | sed 's/^# *//'; exit 2; }

# origin's default branch as last fetched; a repo with no origin has only HEAD to ask.
holders=$(git rev-parse --verify --quiet refs/remotes/origin/HEAD ||
  git rev-parse --verify --quiet refs/remotes/origin/main || git rev-parse HEAD)
# A squash merge leaves a branch's commits out of main; its merged PR's head is the proof.
for b in "$@"; do
  holders+=" $(gh pr list --head "$b" --state merged --json headRefOid --jq '.[].headRefOid' 2>/dev/null || true)"
done

held() {
  local h
  for h in $holders; do
    ! git merge-base --is-ancestor "$1" "$h" 2>/dev/null || return 0
  done
  return 1
}

kept=0
for b in "$@"; do
  if ! tip=$(git rev-parse --verify --quiet "refs/heads/$b"); then
    echo "$b: no such local branch"
    kept=1
  elif ! held "$tip"; then
    echo "$b: kept — neither main nor a merged PR of the named branches holds its tip ${tip:0:7}"
    kept=1
  elif git branch -D "$b" >/dev/null; then
    echo "$b: deleted"
  else
    kept=1
  fi
done
exit "$kept"
