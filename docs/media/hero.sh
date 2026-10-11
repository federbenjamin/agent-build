#!/bin/sh
# Re-takes docs/media/hero.png, the picture at the top of README.md: one /build run going from the
# request to a merged PR through BRIEF, BUILD, CLOSE and SHIP, with the parallel reader wave and two
# fix rounds. The run is staged, not run: a real /build needs a Claude login and a repo to change,
# so vhs films hero-scene.sh printing the run's stops in a terminal. That file says what it stages.
# Needs vhs (with ttyd and Chrome). Runs with a temporary HOME, a bare bash with a neutral prompt,
# and a fixture repo as the working directory, so nothing of your shell or projects is in the frame.
set -eu

here=$(cd "$(dirname "$0")" && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fixture="$tmp/todo-cli"
mkdir -p "$fixture/src/format"
printf '{ "name": "todo-cli", "private": true }\n' > "$fixture/package.json"
cp "$here/hero-scene.sh" "$fixture/.scene.sh"

# The scene command is typed while hidden; `clear` wipes its line, and `read` holds the frame
# without a prompt under it.
cat > "$tmp/hero.tape" <<EOF
Output "$tmp/hero.gif"
Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 18
Set Width 1220
Set Height 860
Set Padding 32
Set WindowBar Colorful
Hide
Type "cd '$fixture' && PS1='\$ ' && clear && sh .scene.sh && read"
Enter
Sleep 1s
Show
Sleep 500ms
Screenshot "$here/hero.png"
EOF

cd "$fixture"
HOME="$tmp" vhs "$tmp/hero.tape"
echo "wrote $here/hero.png"
