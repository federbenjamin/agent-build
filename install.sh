#!/bin/sh
# Links this repo into ~/.agent-build, the one path the skill, its agents, and its runtime name the
# build system by, then registers this checkout as a Claude Code plugin marketplace and enables
# the plugin from it in place. The three links:
#   ~/.agent-build/runtime -> <this repo>/runtime
#   ~/.agent-build/skills  -> <this repo>/skills
#   ~/.agent-build/agents  -> <this repo>/agents
# A path that exists and is not a symlink is refused, and then no link is made or changed.
#
#   install.sh          make the links; each is reported linked, unchanged, or repointed; then the
#                       plugin: already installed, registered and enabled, repointed at this
#                       checkout, enabled, or (no `claude` on PATH) the two commands to run later.
#                       It exits 1 when a `claude` command fails, or when `claude plugin list
#                       --json` does not then show the plugin enabled and read from this checkout.
#   install.sh --check  change nothing; print each link's state (ok, missing, points at <x>,
#                       not a symlink); exit 1 unless all three are ok
set -eu

case "${1-}" in
  "") check=0 ;;
  --check) check=1 ;;
  *) echo "usage: install.sh [--check]" >&2; exit 2 ;;
esac

repo=$(cd "$(dirname "$0")" && pwd -P)
dest="$HOME/.agent-build"
names="runtime skills agents"

# True when the link at $1 already reaches $2: by its text, or by the folder it resolves to.
aims_at() {
  [ "$(readlink "$1")" = "$2" ] && return 0
  [ -d "$1" ] && [ "$(cd "$1" && pwd -P)" = "$2" ]
}

if [ "$check" = 1 ]; then
  bad=0
  for name in $names; do
    link="$dest/$name"
    if [ -L "$link" ]; then
      if aims_at "$link" "$repo/$name"; then state=ok; else state="points at $(readlink "$link")"; bad=1; fi
    elif [ -e "$link" ]; then
      state="not a symlink"; bad=1
    else
      state=missing; bad=1
    fi
    echo "$link: $state"
  done
  exit "$bad"
fi

# Refuse before changing anything, so a refusal leaves every link as it was.
refused=0
for name in $names; do
  link="$dest/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "install.sh: $link exists and is not a symlink; move it aside, then re-run" >&2
    refused=1
  fi
done
[ "$refused" = 0 ] || exit 1

mkdir -p "$dest"
for name in $names; do
  link="$dest/$name"
  target="$repo/$name"
  if [ -L "$link" ]; then
    if aims_at "$link" "$target"; then
      echo "$link: unchanged"
      continue
    fi
    was=$(readlink "$link")
    ln -sfn "$target" "$link"
    echo "$link: repointed (was $was)"
  else
    ln -s "$target" "$link"
    echo "$link: linked"
  fi
done

plugin=agent-build@agent-build
if ! command -v claude >/dev/null 2>&1; then
  echo "plugin: run later: claude plugin marketplace add $repo && claude plugin install $plugin"
  exit 0
fi
# Each `claude` call's output is shown only when it fails.
claude_or_exit() {
  if ! out=$(claude "$@" 2>&1); then
    printf '%s\n' "$out" >&2
    echo "install.sh: claude $* failed; the links are made" >&2
    exit 1
  fi
}
# Sets state to the user-scope install of the plugin, "<enabled> <the folder it reads from>",
# or to nothing when it is not installed.
read_state() {
  claude_or_exit plugin list --json
  state=$(printf '%s' "$out" | node -e '
    const p = JSON.parse(require("fs").readFileSync(0, "utf8"))
      .find((x) => x.id === process.argv[1] && x.scope === "user");
    if (p) console.log(`${p.enabled === true} ${p.readFromFolder ?? ""}`);
  ' "$plugin") || {
    echo "install.sh: could not read \`claude plugin list --json\`; the links are made" >&2
    exit 1
  }
}

# Every call that changes the plugin names user scope, the one read_state reads: `plugin enable`
# auto-detects its scope, so a same-id project or local install would take the change instead.
read_state
[ "$state" = "true $repo" ] && { echo "plugin: already installed"; exit 0; }
if [ -z "$state" ]; then
  claude_or_exit plugin marketplace add --scope user "$repo"
  claude_or_exit plugin install --scope user "$plugin"
  report="plugin: registered and enabled"
else
  # A marketplace add of this checkout under the same name repoints the installed plugin at it.
  report=
  from=${state#* }
  if [ "$from" != "$repo" ]; then
    claude_or_exit plugin marketplace add --scope user "$repo"
    report="plugin: repointed (was ${from:-the plugin cache})"
  fi
  if [ "${state%% *}" != true ]; then
    claude_or_exit plugin enable --scope user "$plugin"
    report="${report:+$report
}plugin: enabled (was disabled)"
  fi
fi
read_state
if [ "$state" != "true $repo" ]; then
  now="enabled=${state%% *}, reads from ${state#* }"
  [ -n "$state" ] || now="not installed"
  echo "install.sh: $plugin is not enabled from $repo after the install ($now); the links are made" >&2
  exit 1
fi
echo "$report"
