/**
 * The run dir's files as the table reads them: which files in a run dir, or in one of its
 * `stage-<key>/` folders, are reader files; everything one round's intake reads (`gatherRound`,
 * `resolveTargets`); and the hand-test output files a claim names. The table script, the gate's
 * replay of each round, and telemetry all read through here, so none of them re-derives a file set.
 *
 * A reader file is `<reader>.md`, or `<reader>-<k>.md` for slice `k` of a split read, where
 * `<reader>` is a stage reader (`STAGE_READER_NAMES`) or a repo reader the ledger's `wave:` line
 * names; plus `session.md`, the findings the session itself writes. Nothing else is: a refused file
 * renamed `<name>.refused.txt`, the `fix-<round>.txt` and `hand-test-<n>.txt` files, and any file of
 * a flow agent (`FLOW_AGENTS`) stay out.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { BriefPartError, matchesTarget, parseTargetFiles } from "./brief.ts";
import { type ExecFn, gitOut } from "./gitOps.ts";
import type { Ledger } from "./ledger.ts";
import { briefLocation } from "./repoId.ts";
import { STAGE_READER_NAMES } from "./riskClass.ts";
import type { FixRound, HandTestLine, RoundId, TableJson } from "./runFiles.ts";
import { type InputFile, type ReaderInput, roundIntake, roundStages, type StageInput } from "./table.ts";

export interface ReaderFile {
  /** The file name, `review-cursory-2.md`. */
  name: string;
  path: string;
  /** The reader it belongs to; `session` for `session.md`. */
  reader: string;
  /** `k` for `<reader>-<k>.md`; null for an unsplit read. */
  slice: number | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reader files directly in `dir`, sorted by name. `repoReaders` are the `repo:` agents of the
 *  ledger's `wave:` line (`Ledger.waveRepoReaders`). A missing `dir` throws. */
export function readerFiles(dir: string, repoReaders: readonly string[] = []): ReaderFile[] {
  const patterns = [...STAGE_READER_NAMES, ...repoReaders].map((reader) => ({
    reader,
    re: new RegExp(`^${escape(reader)}(?:-(\\d+))?\\.md$`),
  }));
  const out: ReaderFile[] = [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();
  for (const name of names) {
    if (name === "session.md") {
      out.push({ name, path: join(dir, name), reader: "session", slice: null });
      continue;
    }
    for (const { reader, re } of patterns) {
      const m = re.exec(name);
      if (!m) continue;
      out.push({ name, path: join(dir, name), reader, slice: m[1] === undefined ? null : Number(m[1]) });
      break;
    }
  }
  return out;
}

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

function readerInputs(dir: string, prefix: string, repoReaders: readonly string[]): ReaderInput[] {
  return readerFiles(dir, repoReaders)
    .filter((f) => f.reader !== "session")
    .map((f) => ({ file: `${prefix}${f.name}`, reader: f.reader, slice: f.slice, text: readFileSync(f.path, "utf8") }));
}

function optionalFile(runDir: string, name: string): InputFile | null {
  const path = join(runDir, name);
  return existsSync(path) ? { file: name, text: readFileSync(path, "utf8") } : null;
}

const HAND_TEST_FILE = /^hand-test-([1-9]\d*)\.txt$/;

/** Every file round `round`'s intake (`roundIntake`) names, read from the run dir. A stage folder
 *  that does not exist is a stage that did not run. `table` is `table.json` as the round sees it. */
export function gatherRound(runDir: string, round: RoundId, ledger: Ledger, table: TableJson) {
  const intake = roundIntake(round, table);
  const wave = intake.wave ? readerInputs(runDir, "", ledger.waveRepoReaders) : undefined;
  const stages: StageInput[] = roundStages(round, table).map((stage) => {
    const dir = join(runDir, stage.folder);
    const ran = isDir(dir);
    return { stage, ran, files: ran ? readerInputs(dir, `${stage.folder}/`, []) : [] };
  });
  const fixes: Partial<Record<FixRound, InputFile>> = {};
  for (const c of intake.carry) {
    const f = optionalFile(runDir, `fix-${c.fix}.txt`);
    if (f) fixes[c.fix] = f;
  }
  const handTests = intake.handTests
    ? readdirSync(runDir)
        .map((name) => ({ name, m: HAND_TEST_FILE.exec(name) }))
        .filter((x) => x.m !== null)
        .map((x) => ({ file: x.name, n: Number(x.m![1]), text: readFileSync(join(runDir, x.name), "utf8") }))
    : [];
  return { wave, stages, fixes, handTests, session: optionalFile(runDir, "session.md") };
}

/**
 * Which repo paths are target files for a round built at `head`: the brief's `## Target files` (read
 * in the working tree of the repo that holds it, `briefLocation`), or on a `--from-branch` run every file changed from the ledger's base
 * to `head`. The brief itself, and a `--from-branch` run's hand-test file, is never a target (as
 * `prCode` never counts it). A brief written before the section existed has none; `note` is told
 * so. Throws on a brief it cannot read.
 */
export function resolveTargets(
  ledger: Ledger,
  repo: string,
  head: string,
  opts: { exec?: ExecFn; note?: (line: string) => void } = {}
): (path: string) => boolean {
  if (ledger.fromBranch !== null) {
    if (ledger.base === null) throw new Error("a --from-branch run needs `freshen: … | base=<ref>` in ship.md");
    const changed = new Set(
      gitOut(["diff", "--name-only", `${ledger.base}...${head}`], { cwd: repo, ...(opts.exec ? { exec: opts.exec } : {}) })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (ledger.handTestBlock !== null) {
      const block = briefLocation(ledger.handTestBlock, repo, opts);
      if (!block.store) changed.delete(block.path);
    }
    return (p) => changed.has(p.replace(/^\.\//, ""));
  }
  if (ledger.brief === null) return () => false;
  const loc = briefLocation(ledger.brief, repo, opts);
  const path = join(loc.cwd, loc.path);
  if (!existsSync(path)) throw new Error(`the brief ${ledger.brief} is not in ${loc.cwd}`);
  try {
    const targets = parseTargetFiles(readFileSync(path, "utf8"));
    // A brief in the store is no path of the code repo, so only a brief in the tree is left out.
    const brief = loc.store ? null : loc.path;
    return (p) => p.replace(/^\.\//, "") !== brief && matchesTarget(p, targets);
  } catch (e) {
    if (e instanceof BriefPartError && e.kind === "missing") {
      opts.note?.(`note: ${ledger.brief} has no \`## Target files\`; no file is a target`);
      return () => false;
    }
    throw new Error(`${ledger.brief}: ${(e as Error).message}`);
  }
}

/** The hand-test lines whose output file (relative to the run dir) does not exist. */
export function missingHandTestOutputs(runDir: string, lines: readonly HandTestLine[]): HandTestLine[] {
  return lines.filter((l) => !existsSync(join(runDir, l.output)));
}
