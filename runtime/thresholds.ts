#!/usr/bin/env node
// The build flow's numbers. A repo overrides any of them in the file its build-steps.toml names as
// `thresholds`: a module exporting `TOOLING` (or a default object), or a JSON object. A key the file
// leaves out keeps the default below, and every value prints with where it came from, so a repo
// never runs on a number it did not know it had. A session contract that sets subagent_max,
// codex_max, codex_pair_min_size, or codex_pair_min_class wins over the key of the same name here.
//   node thresholds.ts [repo-dir] [--json | --get <KEY>]
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isMain } from "./lib/isMain.ts";
import { stepCommand } from "./steps.ts";

export type SizeBucket = { name: string; min: number };

export const DEFAULTS = {
  /** gate-silent-failure-hunter sits out under this many counted lines when no hunk has catch/await/Promise. */
  WAVE_HUNTER_MIN_LINES: 20,
  /** review-cursory runs as two spawns with exclusive slices above this many counted lines. */
  WAVE_CURSORY_SPLIT_LINES: 800,
  /** The simplifier fires by size at or above this bucket. */
  SIMPLIFIER_TRIGGER_MIN_BUCKET: "M",
  /** PR size buckets over counted lines, ascending by `min`. */
  PR_SIZE_BUCKETS: [
    { name: "XS", min: 0 },
    { name: "S", min: 10 },
    { name: "M", min: 100 },
    { name: "L", min: 400 },
    { name: "XL", min: 1500 },
    { name: "XXL", min: 5000 },
  ] as SizeBucket[],
  /** A reader earns its place at this many findings per fire after this many fires. */
  READER_FLOOR_MIN_FIRES: 20,
  READER_FLOOR_FINDINGS_PER_FIRE: 1,
  /** The watch (`agent-watchdog.sh --flags`) flags an agent whose transcript (or Codex log) has had
   *  no write for this many minutes. */
  WATCH_SILENT_MIN: 12,
  /** It flags a builder, fixer, or test writer with no edit and no `git commit` for this many
   *  minutes of one live segment. */
  WATCH_NO_EDIT_MIN: 15,
  /** It flags one `Read` of the same path, offset, and limit this many times. */
  WATCH_SAME_SLICE_READS: 5,
  /** It flags one tool and command (or path) refused this many times. */
  WATCH_SAME_REFUSAL: 4,
  /** It flags an agent with this many compactions in one live segment. */
  WATCH_COMPACTIONS: 2,
  /** Minutes between the watch's full transcript scans. */
  WATCH_SCAN_MIN: 5,
  /** The fix table merges two findings on one path whose line ranges overlap or lie within this
   *  many lines of each other. */
  TABLE_MERGE_NEAR_LINES: 3,
  /** A finding whose range is longer than this many lines merges only on an exact range match. */
  TABLE_MERGE_EXACT_ABOVE_LINES: 30,
  /** BRIEF cuts a part planned above this many changed lines in two, unless it cannot be cut. A
   *  planning number, never a gate: U22 measured about 2,000 before reading fills a builder. */
  PART_MAX_LINES: 2000,
  /** A test slice's guide size in functions under test; `briefCheck.ts` warns above it, never fails.
   *  One measured slice of 4 peaked its Claude writer at 324,634 tokens of context, under the
   *  400,000 at which the guide drops to 2. */
  TEST_SLICE_MAX_FUNCTIONS: 4,
  /** Small work: a change the class moment sizes below this bucket joins an open unit or the batch. */
  SMALL_WORK_BELOW_BUCKET: "M",
  /** The batch ships once its diff reaches this bucket. */
  BATCH_SHIP_BUCKET: "L",
  /** The watch's `off-part` flag fires at this many distinct edited paths outside a part's files. */
  WATCH_OFF_PART_FILES: 3,
  /** The consumer `buildEvent.ts` runs is killed after this many ms, and the build goes on. */
  BUILD_EVENT_TIMEOUT_MS: 30_000,
  /** Claude subagents live at once, any flow; a session contract's `subagent_max` wins. */
  SUBAGENT_MAX: 4,
  /** Codex runs live at once; a session contract's `codex_max` wins. */
  CODEX_MAX: 4,
  /** The paired Codex read fires at or above this bucket and class; a session contract's
   *  `codex_pair_min_size` / `codex_pair_min_class` win. */
  CODEX_PAIR_MIN_SIZE: "M",
  CODEX_PAIR_MIN_CLASS: "R1",
};

export type Thresholds = typeof DEFAULTS;
export type ThresholdKey = keyof Thresholds;
export type Resolved = {
  file: string | null;
  found: boolean;
  values: Thresholds;
  source: Record<ThresholdKey, "repo" | "default">;
};

async function readOverrides(path: string): Promise<Record<string, unknown>> {
  if (path.endsWith(".json")) return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const table = (mod.TOOLING ?? mod.default) as Record<string, unknown> | undefined;
  if (table === undefined || typeof table !== "object")
    throw new Error(`thresholds: ${path} exports neither TOOLING nor a default object`);
  return table;
}

/** The repo's thresholds over the defaults. A named file that does not exist is an error: the
 *  repo said where its numbers are, and running on the defaults instead would be silent. */
export async function loadThresholds(repo: string): Promise<Resolved> {
  const named = stepCommand(repo, "thresholds");
  const file = named === null ? null : isAbsolute(named) ? named : join(repo, named);
  if (file !== null && !existsSync(file))
    throw new Error(`thresholds: build-steps.toml names ${named}, which does not exist in ${repo}`);
  const overrides = file === null ? {} : await readOverrides(file);
  const values = { ...DEFAULTS } as Record<string, unknown>;
  const source = {} as Record<ThresholdKey, "repo" | "default">;
  for (const key of Object.keys(DEFAULTS) as ThresholdKey[]) {
    const has = Object.hasOwn(overrides, key) && overrides[key] !== undefined;
    if (has) values[key] = overrides[key];
    source[key] = has ? "repo" : "default";
  }
  return { file, found: file !== null, values: values as Thresholds, source };
}

/** The bucket a counted-line total falls in. */
export function bucketFor(lines: number, buckets: readonly SizeBucket[]): string {
  let name = buckets[0]!.name;
  for (const b of buckets) if (lines >= b.min) name = b.name;
  return name;
}

/** Bucket order index, for "at or above" comparisons. */
export function bucketRank(name: string, buckets: readonly SizeBucket[]): number {
  const i = buckets.findIndex((b) => b.name === name);
  if (i < 0) throw new Error(`thresholds: unknown size bucket ${name}`);
  return i;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const getAt = args.indexOf("--get");
  const get = getAt >= 0 ? (args[getAt + 1] as ThresholdKey | undefined) : undefined;
  if (getAt >= 0 && (get === undefined || !(get in DEFAULTS))) {
    console.error(`thresholds: --get needs one of: ${Object.keys(DEFAULTS).join(", ")}`);
    process.exit(2);
  }
  const positional = args.filter((a, i) => a !== "--json" && (getAt < 0 || (i !== getAt && i !== getAt + 1)));
  const r = await loadThresholds(resolve(positional[0] ?? "."));
  if (get !== undefined) console.log(JSON.stringify(r.values[get]));
  else if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`thresholds: ${r.file ?? "(none: every value is the default)"}`);
    for (const key of Object.keys(DEFAULTS) as ThresholdKey[])
      console.log(`${key.padEnd(35)} ${r.source[key].padEnd(8)} ${JSON.stringify(r.values[key])}`);
  }
}
