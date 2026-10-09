#!/bin/sh
# Renders each docs/media/*.mmd to the .svg beside it, which README.md shows.
# Edit the .mmd, then run this and commit both. Needs node; npx fetches the pinned mermaid-cli.
# Styling (font size, spacing) is in diagrams.config.json; node colours are classDefs in each .mmd.
set -eu

here=$(cd "$(dirname "$0")" && pwd -P)
config="$here/diagrams.config.json"

for src in "$here"/*.mmd; do
  out="${src%.mmd}.svg"
  npx -y @mermaid-js/mermaid-cli@12.0.0 -q -i "$src" -o "$out" -c "$config" -b white
  echo "rendered $(basename "$out")"
done
