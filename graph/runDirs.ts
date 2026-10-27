/**
 * `stats`'s reader: each run dir under a state dir as `RunData`. Every path comes from the module
 * that writes it: the attempt records and output folders from `runKeys.ts`, the table and the
 * mirrored fix files from the build pipeline's table module. What does not parse becomes a problem
 * line, never a stop.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { type FixRound, parseTableJson, type RoundId } from "../runtime/lib/runFiles.ts";
import { type FixFile, parseFixFile } from "../runtime/lib/fixFile.ts";
import { fixRoundsIn } from "../runtime/lib/table.ts";
import { filesUnder } from "./adapters/agentIo.ts";
import { fileRunStore } from "./adapters/fileRunStore.ts";
import { CROSSTALK_FILE, STRUGGLES_FILE } from "./constants.ts";
import { type GraphDef, parseAttemptRecord, type RunHistory } from "./contracts.ts";
import { type FixReadStatus, fixerRounds, fixFileName, fixReadStatuses, mirrorDir, runTableFile } from "./pipelines/build/table.ts";
import { attemptOwner, outKey, outputFileOwner } from "./runKeys.ts";
import type { RunData } from "./stats.ts";

const RECORD = /\.json$/;

export function readRunDir(dir: string): RunData {
  const problems: string[] = [];
  const store = fileRunStore(dir);
  const read = <T>(what: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      problems.push(`${what}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const record = (key: string): unknown => read(`${key}.json`, () => store.read(key));
  const history = (record("history") as RunHistory | undefined) ?? null;
  const graph = (record("graph") as GraphDef | undefined) ?? null;

  const attempts: RunData["attempts"] = [];
  const struggles: RunData["struggles"] = [];
  const crosstalk: RunData["crosstalk"] = [];
  const nodes = join(dir, "nodes");
  for (const path of existsSync(nodes) ? filesUnder(nodes).map((f) => relative(dir, f)) : []) {
    const key = path.replace(RECORD, "");
    const owner = RECORD.test(path) ? attemptOwner(key) : null;
    if (owner !== null) {
      const raw = record(key);
      try {
        if (raw !== undefined) attempts.push({ key: owner, record: parseAttemptRecord(raw, path) });
      } catch (e) {
        problems.push((e as Error).message);
      }
      continue;
    }
    const out = outputFileOwner(path);
    if (out?.name === STRUGGLES_FILE) struggles.push({ key: out.nodeRun, file: path, raw: read(path, () => JSON.parse(readFileSync(join(dir, path), "utf8"))) });
    if (out?.name === CROSSTALK_FILE) {
      const text = read(path, () => readFileSync(join(dir, path), "utf8"));
      if (text !== undefined) crosstalk.push({ key: out.nodeRun, file: path, text });
    }
  }
  // A node run's side files in the order its attempts ran: those kept from earlier attempts, then the last one's.
  const ran = (a: { key: string; file: string }, b: { key: string; file: string }): number => {
    const last = { rerun: Number.MAX_SAFE_INTEGER, attempt: Number.MAX_SAFE_INTEGER };
    const [x, y] = [outputFileOwner(a.file)?.kept ?? last, outputFileOwner(b.file)?.kept ?? last];
    const text = (s: string, t: string): number => (s < t ? -1 : s > t ? 1 : 0);
    return text(a.key, b.key) || x.rerun - y.rerun || x.attempt - y.attempt || text(a.file, b.file);
  };
  struggles.sort(ran);
  crosstalk.sort(ran);

  // The history names files where the run dir was; a moved state dir holds them at the same place below it.
  const here = (f: string): string => (f.includes("/nodes/") ? join(dir, f.slice(f.indexOf("/nodes/") + 1)) : f);
  const named = history === null ? undefined : runTableFile(history.data);
  const tableFile = named === undefined ? undefined : here(named);
  const table = tableFile !== undefined && existsSync(tableFile) ? (read(relative(dir, tableFile), () => parseTableJson(readFileSync(tableFile, "utf8"))) ?? null) : null;

  const fixes = new Map<FixRound, FixFile>();
  const mirror = mirrorDir(dir);
  for (const r of table === null ? [] : fixRoundsIn(table)) {
    const file = join(mirror, fixFileName(r));
    if (!existsSync(file)) continue;
    const rows = table!.rounds[r]!.rows.map((x) => x.id);
    const parsed = read(relative(dir, file), () => parseFixFile(readFileSync(file, "utf8"), { rows, round: r }));
    if (parsed !== undefined) fixes.set(r, parsed);
  }
  const rounds =
    history === null ? undefined : read("the close loop's table states", () => fixerRounds(history, (node, iteration) => store.path(outKey({ node: { id: node }, iteration }))));
  const fixReads = table === null ? undefined : read("the fix reads' status lines", () => fixReadStatuses(mirror, table, fixes));
  return {
    name: basename(dir),
    graph,
    history,
    attempts,
    table,
    fixes,
    fixReads: fixReads ?? new Map<FixRound, FixReadStatus[]>(),
    fixerRounds: rounds ?? new Map<number, RoundId>(),
    struggles,
    crosstalk,
    problems,
  };
}

/** Every run dir under the state dir's `runs/`. */
export function readRunDirs(stateDir: string): RunData[] {
  const runs = join(stateDir, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .sort()
    .map((name) => join(runs, name))
    .filter((d) => statSync(d).isDirectory())
    .map(readRunDir);
}
