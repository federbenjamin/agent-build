/**
 * Does `table.json` still say what the run dir says? The gate's check that no reader file, stage
 * answer, `session.md` block, or hand-test line reached the run dir after the round that should have
 * read it was built (§1.9 item 3). Each stored round is re-built with the pure `buildRound` from the
 * files the table script itself would read (`gatherRound`), over the stored table, at the stored
 * head; any difference is a stale round. Then every reader file the run dir holds must be one a
 * round read, and every reader the `wave:` line names must have left a file.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExecFn } from "./gitOps.ts";
import type { Ledger } from "./ledger.ts";
import { gatherRound, readerFiles, resolveTargets } from "./runDir.ts";
import {
  type FinalRound,
  parseSessionFile,
  parseStageKey,
  type Round,
  type RoundId,
  roundOrder,
  serialiseTableJson,
  type TableJson,
} from "./runFiles.ts";
import { buildRound, type InputFile, type MergeLimits, roundIntake, roundStages } from "./table.ts";

export interface ReplayInputs {
  runDir: string;
  repo: string;
  ledger: Ledger;
  table: TableJson;
  merge: MergeLimits;
  exec?: ExecFn;
}

/** The fields of a round the replay compares; `head` is the replay's input. */
const COMPARED = ["rows", "leftovers", "banked", "closed", "consumed", "refused", "open"] as const;

/** A round as `serialiseTableJson` prints it, so a stored and a re-built round compare by value. */
function canonical(id: RoundId, round: Round | FinalRound): Record<string, unknown> {
  return (JSON.parse(serialiseTableJson({ schema: 2, rounds: { [id]: round } })) as { rounds: Record<string, Record<string, unknown>> })
    .rounds[id]!;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW_TABLE = join(HERE, "..", "reviewTable.ts");
const quoted = (s: string): string => (/^[\w./~@+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** The command that re-builds round `id` at `head`, spelled out for the operator to run as printed. */
export function rebuildCommand(runDir: string, id: RoundId, head: string): string {
  return `node ${quoted(REVIEW_TABLE)} build --run-dir ${quoted(runDir)} --round ${id} --head ${head}`;
}

/** Does round `id` take any block of `session.md`? A file that fails its grammar counts as taken:
 *  which round it feeds is unknown, and the round that re-builds over it refuses it. */
function takesSession(id: RoundId, table: TableJson, session: InputFile | null): boolean {
  if (session === null) return false;
  const stages = roundIntake(id, table).sessionStages;
  try {
    return parseSessionFile(session.text).some((b) => stages.includes(b.stage));
  } catch {
    return true;
  }
}

const withoutSession = (consumed: unknown): unknown => (consumed as string[]).filter((f) => f !== "session.md");

/**
 * Each stored round that the run dir no longer re-builds to, one failure line each, then one line
 * naming the command for each round to re-build, in order, at the head `table.json` holds for it. A
 * round reads only the `session.md` blocks of its own stages, so a block written for a later stage
 * (CLOSE 4e) never makes an earlier round stale: when the round takes no block, whether `session.md`
 * existed when it was built is no difference.
 */
export function staleRounds(inp: ReplayInputs): string[] {
  const out: string[] = [];
  const ids = (Object.keys(inp.table.rounds) as RoundId[]).sort(roundOrder);
  // A hand-test file no stored round consumed belongs to the latest round that reads hand tests (a
  // SHIP re-run after `final` is `final`'s): only that round re-builds differently for it.
  const lastHandRound = ids.filter((id) => roundIntake(id, inp.table).handTests).at(-1);
  const consumedByAny = new Set(ids.flatMap((id) => inp.table.rounds[id]!.consumed));
  let firstStale: number | null = null;
  for (const id of ids) {
    const stored = inp.table.rounds[id]!;
    let rebuilt: Round | FinalRound;
    let session = false;
    try {
      const isTarget = resolveTargets(inp.ledger, inp.repo, stored.head, inp.exec ? { exec: inp.exec } : {});
      const files = gatherRound(inp.runDir, id, inp.ledger, inp.table);
      if (id !== lastHandRound) files.handTests = files.handTests.filter((h) => consumedByAny.has(h.file));
      session = takesSession(id, inp.table, files.session);
      rebuilt = buildRound({
        round: id,
        head: stored.head,
        table: inp.table,
        isTarget,
        merge: inp.merge,
        ...files,
      }).round;
    } catch (err) {
      out.push(`table.json round ${id} cannot be re-built from the run dir (${(err as Error).message.split("\n")[0]})`);
      continue;
    }
    const a = canonical(id, stored);
    const b = canonical(id, rebuilt);
    if (!session) {
      a.consumed = withoutSession(a.consumed);
      b.consumed = withoutSession(b.consumed);
    }
    const differ = COMPARED.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (differ.length > 0) {
      firstStale ??= ids.indexOf(id);
      out.push(`table.json round ${id} is stale against the run dir (${differ.join(", ")} differ) — a file changed or arrived after it was built`);
    }
  }
  if (firstStale !== null) {
    const redo = ids.slice(firstStale);
    out.push(
      `re-build rounds ${redo.join(", ")} in order, each at the head table.json holds for it: ${redo
        .map((id) => `\`${rebuildCommand(inp.runDir, id, inp.table.rounds[id]!.head)}\``)
        .join("; ")}`
    );
  }
  return out;
}

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
const CODEX_PAIRED = /^codex:\s*review-cursory\s*$/;

/**
 * Reader files no round reads, and wave readers with no file: a `*.md` in the run dir that is no
 * reader's file (a repo reader the `wave:` line does not name, a misspelt name), a stage folder no
 * round of the table reads, a `*.md` in a stage folder that is no reader's, and a reader the `wave:`
 * line names (a class reader, a `repo:` reader, or the paired Codex read) that left no file.
 */
export function unreadFiles(inp: ReplayInputs): string[] {
  const out: string[] = [];
  const { runDir, ledger, table } = inp;
  if (!isDir(runDir)) return out;
  const root = readerFiles(runDir, ledger.waveRepoReaders);
  const known = new Set(root.map((f) => f.name));
  for (const name of readdirSync(runDir).sort()) {
    if (!name.endsWith(".md") || name === "ship.md" || /^table-.+\.md$/.test(name) || known.has(name)) continue;
    if (!statSync(join(runDir, name)).isFile()) continue;
    out.push(`${name}: in the run dir, but it is no reader's file — name its repo reader on \`wave: … | repo: <agent>\`, or rename it`);
  }
  const wave = ledger.lines.get("wave");
  const named = [...ledger.waveReaders, ...ledger.waveRepoReaders];
  if (wave?.text.some((s) => CODEX_PAIRED.test(s))) named.push("review-cursory-codex");
  for (const reader of named) {
    if (!root.some((f) => f.reader === reader)) {
      out.push(`wave: names ${reader} — no ${reader}.md in the run dir; re-spawn it, or record why it left none`);
    }
  }
  const read = new Set<string>();
  for (const id of Object.keys(table.rounds) as RoundId[]) for (const s of roundStages(id, table)) read.add(s.folder);
  for (const name of readdirSync(runDir).sort()) {
    if (!name.startsWith("stage-") || !isDir(join(runDir, name))) continue;
    if (parseStageKey(name.slice("stage-".length)) === null || !read.has(name)) {
      out.push(`${name}/: no round of table.json reads this folder — a drift group reads stage-drift-<n>/ and stage-drift-confirm-<n>/`);
      continue;
    }
    const files = new Set(readerFiles(join(runDir, name)).map((f) => f.name));
    for (const f of readdirSync(join(runDir, name)).sort()) {
      if (f.endsWith(".md") && !files.has(f)) out.push(`${name}/${f}: no reader's file name (<reader>.md) — no round reads it; rename it`);
    }
  }
  return out;
}
