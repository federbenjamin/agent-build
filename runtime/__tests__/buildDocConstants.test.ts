/**
 * Every backticked UPPER_SNAKE name the /build skill text cites is a real one: a `DEFAULTS` key in
 * `thresholds.ts` (the `WATCH_*`, `TABLE_MERGE_*`, and `READER_FLOOR_*` families among them), or a
 * constant a `runtime` module exports (`RISK_CLASS_READERS`, `STAGES_FIXING`). A renamed
 * or invented tunable in the text otherwise reads as a rule nothing enforces.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULTS } from "../thresholds.ts";

const BUILD = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKILL = join(BUILD, "..", "skills", "build");

/** Every `.ts` file under `dir`, test trees left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** The names the text may cite. */
function knownNames(): Set<string> {
  const out = new Set(Object.keys(DEFAULTS));
  for (const file of sources(BUILD)) {
    for (const m of readFileSync(file, "utf8").matchAll(/^export const ([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/gm)) out.add(m[1]!);
  }
  return out;
}

/** The backticked UPPER_SNAKE names in `text` that `known` does not hold. */
function unknownNames(text: string, known: Set<string>): string[] {
  return [...new Set([...text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1]!))].filter((n) => !known.has(n)).sort();
}

test("every backticked UPPER_SNAKE name in the /build skill is a DEFAULTS key or an exported constant", () => {
  const known = knownNames();
  for (const family of ["WATCH_", "TABLE_MERGE_", "READER_FLOOR_"]) {
    assert.ok([...known].some((n) => n.startsWith(family)), `the ${family}* family is exported`);
  }
  // The check catches a name nothing defines, so its pass below is not vacuous.
  assert.deepEqual(unknownNames("the watch flags after `WATCH_IDLE_MIN` minutes; `WAVE_HUNTER_MIN_LINES` bounds it", known), ["WATCH_IDLE_MIN"]);
  const files = readdirSync(SKILL).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 5, "SKILL.md and one file per stop");
  let cited = 0;
  for (const file of files) {
    const text = readFileSync(join(SKILL, file), "utf8");
    cited += [...text.matchAll(/`[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+`/g)].length;
    assert.deepEqual(unknownNames(text, known), [], `skills/build/${file} cites a name no code defines`);
  }
  assert.ok(cited > 0, "the skill cites at least one constant");
});
