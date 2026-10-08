#!/usr/bin/env node
// The `size` step's fallback for a repo that maps none: the same three verdict lines a repo's own
// size command prints, from a plain count. Counted lines = added + removed lines outside tests,
// prose docs, and lockfiles (behavior markdown counts: it is logic). The bucket and the simplifier
// floor come from the repo's thresholds, and so do the codex pair rule's floors
// (CODEX_PAIR_MIN_SIZE, CODEX_PAIR_MIN_CLASS) unless a flag passes the session contract's. With no
// `codex_role` step (Codex is not on PATH) the pair is skipped whatever the class and size.
//   node size.ts [--diff-file <patch> | --base <ref>] [--class R<n>]
//                [--pair-min-size <bucket>] [--pair-min-class R<n>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { isMain } from "./lib/isMain.ts";
import { isRiskClass, RISK_CLASSES, type RiskClass } from "./lib/riskClass.ts";
import { BEHAVIOR_MD_RES } from "./reviewLensSelect.ts";
import { stepCommand } from "./steps.ts";
import { bucketFor, bucketRank, loadThresholds, type SizeBucket } from "./thresholds.ts";

const TEST_RES = [/(^|\/)__tests__\//, /(^|\/)tests?\//, /\.(test|spec)\.[a-z]+$/, /_test\.[a-z]+$/];
const PROSE_RES = [/^docs\//, /\.mdx?$/, /\.txt$/, /(^|\/)(README|CHANGELOG|LICENSE)(\.[a-z]+)?$/i];
const LOCK_RES = [/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/];

/** A path that never counts: tests, prose docs (behavior markdown excepted), lockfiles. */
export function isUncounted(path: string): boolean {
  if (BEHAVIOR_MD_RES.some((re) => re.test(path))) return false;
  return [...TEST_RES, ...PROSE_RES, ...LOCK_RES].some((re) => re.test(path));
}

export type Size = { counted: number; byDir: Record<string, number> };

/** Count a unified diff's changed lines per top-level dir. Pure. */
export function measure(diff: string): Size {
  const byDir: Record<string, number> = {};
  let path: string | null = null;
  let counted = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      path = m ? m[1]! : null;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (path === null || isUncounted(path)) continue;
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("\\")) {
      counted += 1;
      const dir = path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
      byDir[dir] = (byDir[dir] ?? 0) + 1;
    }
  }
  return { counted, byDir };
}

export type Verdicts = { size: string; simplifier: string; pair: string };

export function verdicts(
  s: Size,
  buckets: readonly SizeBucket[],
  simplifierMin: string,
  cls: RiskClass | null,
  pairMinSize: string,
  pairMinClass: RiskClass,
  codexRole: boolean
): Verdicts {
  const bucket = bucketFor(s.counted, buckets);
  const dirs = Object.entries(s.byDir)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d} ${n}`)
    .join(" · ");
  const floor = buckets[bucketRank(simplifierMin, buckets)]!.min;
  const fires = s.counted >= floor;
  const pair = !codexRole
    ? "codex pair: skipped (no codex_role step)"
    : cls === null
      ? "codex pair: undecided — pass --class R<n>"
      : bucketRank(bucket, buckets) >= bucketRank(pairMinSize, buckets) &&
          RISK_CLASSES.indexOf(cls) >= RISK_CLASSES.indexOf(pairMinClass)
        ? `codex pair: fires (${cls}, ${bucket})`
        : `codex pair: skipped (${cls}, ${bucket} — needs ≥ ${pairMinClass} and ≥ ${pairMinSize})`;
  return {
    size: `[${bucket}] ${s.counted} counted lines${dirs ? ` · ${dirs}` : ""}`,
    simplifier: `simplifier: ${fires ? "fires" : "sits out"} (${s.counted} ${fires ? "≥" : "<"} ${floor})`,
    pair,
  };
}

function defaultBase(): string {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/HEAD"], { stdio: "ignore" });
    return "origin/HEAD";
  } catch {
    return "origin/main";
  }
}

if (isMain(import.meta.url)) {
  let rest = process.argv.slice(2);
  const take = (flag: string) => {
    const r = takeValue(rest, flag);
    rest = r.rest;
    return r.value;
  };
  const diffFile = take("--diff-file");
  const base = take("--base");
  const cls = take("--class");
  const pairMinSizeFlag = take("--pair-min-size");
  const pairMinClassFlag = take("--pair-min-class");
  assertKnownFlags(rest, []);
  if (cls !== undefined && !isRiskClass(cls)) throw new Error(`--class must be R0-R2, got ${cls}`);
  const t = (await loadThresholds(process.cwd())).values;
  const pairMinSize = pairMinSizeFlag ?? t.CODEX_PAIR_MIN_SIZE;
  const pairMinClass = pairMinClassFlag ?? t.CODEX_PAIR_MIN_CLASS;
  if (!isRiskClass(pairMinClass)) throw new Error(`--pair-min-class must be R0-R2, got ${pairMinClass}`);
  const diff =
    diffFile !== undefined
      ? readFileSync(diffFile, "utf8")
      : execFileSync("git", ["diff", `${base ?? defaultBase()}...HEAD`], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
  const v = verdicts(
    measure(diff),
    t.PR_SIZE_BUCKETS,
    t.SIMPLIFIER_TRIGGER_MIN_BUCKET,
    cls ?? null,
    pairMinSize,
    pairMinClass,
    stepCommand(process.cwd(), "codex_role") !== null
  );
  console.log(v.size);
  console.log(v.simplifier);
  console.log(v.pair);
}
