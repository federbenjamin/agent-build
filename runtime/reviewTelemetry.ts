/**
 * CLI + helpers: review telemetry for the `/build` review — per-run rows appended to the gitignored
 * `.claude/run-state/review-telemetry.jsonl` of the repo under build (cwd; its main working tree when
 * cwd is a linked worktree). Every number is counted HERE, from the run dir's files — never by an LLM.
 *
 *   --ingest <run-dir> --pipeline build --ref <r> --run-id <id> --class R<n> [--file <jsonl>]
 *   --report [--since YYYY-MM-DD] [--file <jsonl>]
 *
 * One run is: `ship.md` (the ledger), `table.json` (the review table), every reader file of the wave
 * and of each `stage-<stage>/` folder, the `fix-<round>.txt` files, and an optional
 * `extra-sources.json` carrying the counts of the agents that write no finding block. Each run writes
 * one `schema: 2` run row (the rounds, the open set, the leftovers, the models) and one `schema: 2`
 * source row per reader per stage (findings per kind, and how many survived). The builder's and each
 * fixer's agent type, and the model it really ran, come from the spawn's `agent-<id>.meta.json` under
 * the Claude projects dir; a mismatch with the ledger is printed, never fatal. A `build:` line with
 * `parts=` records each part (`build.parts`), its agents held to the part's own model.
 *
 * Every full model id an agent ran (`claude-sonnet-5-5`) is read from its transcript and recorded as
 * `modelIds` beside the family: on the build, each part, each fix round, and each reader's source row.
 * The read lines name no agent, so a reader's agents are found by `agentType` and the reader file its
 * prompt names (`metaLookup`). An agent that ran more than one model prints a note naming the ids.
 * `--report` shows the ids per run and per source, and splits a source whose fires ran different
 * models; rows written before `modelIds` read as `?`.
 *
 * A run dir the old flow wrote (`round.json`, no `table.json`) is refused with the `flow: 2` message,
 * exit 1. `--report` reads schema-2 rows, and prints the rows older runs wrote in a legacy section.
 *
 * Exit: 0 written (or already ingested) · 1 an old-flow run dir · 2 usage or unreadable input.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { isMain } from "./lib/isMain.ts";
import { FLOW_CHANGED, type Ledger } from "./lib/ledger.ts";
import { fixOfRound } from "./lib/owed.ts";
import { isRiskClass, RISK_CLASS_READERS, type RiskClass } from "./lib/riskClass.ts";
import { readerFiles } from "./lib/runDir.ts";
import {
  type FixFile,
  type FixRound,
  type Finding,
  isFixRound,
  type Kind,
  KINDS,
  parseFixFile,
  parseReaderFile,
  parseStageFile,
  parseStageKey,
  type RoundId,
  roundOrder,
  type Stage,
  STAGES,
  type TableJson,
} from "./lib/runFiles.ts";
import { appendJsonl, readJsonl, resolveRunStateDir } from "./lib/runState.ts";
import { Shape } from "./lib/shape.ts";
import { roundIntake } from "./lib/table.ts";
import { readLedger, readTable, UsageError } from "./reviewTable.ts";
import { DEFAULTS, loadThresholds } from "./thresholds.ts";

/** The reader floor: a source earns its place at `perFire` findings per fire after `minFires`
 *  fires. The repo's thresholds file may move it (`READER_FLOOR_*`). */
export interface ReaderFloor {
  minFires: number;
  perFire: number;
}

export const DEFAULT_FLOOR: ReaderFloor = {
  minFires: DEFAULTS.READER_FLOOR_MIN_FIRES,
  perFire: DEFAULTS.READER_FLOOR_FINDINGS_PER_FIRE,
};

/** The one pipeline that ingests a run. */
export const PIPELINES = ["build"] as const;
export type Pipeline = (typeof PIPELINES)[number];

/** A run dir the old flow wrote. The CLI exits 1 on it with the `flow: 2` message. */
export class FlowChangedError extends Error {
  constructor() {
    super(FLOW_CHANGED);
    this.name = "FlowChangedError";
  }
}

// ── Extra sources ────────────────────────────────────────────────────────────────────────────

/** Agents that write no finding block but must still earn their keep by findings per fire. The
 * session counts them into `extra-sources.json` (`/build` §CLOSE names what each counts). */
export const EXTRA_SOURCE_NAMES = ["prior-art", "test-author"] as const;
export type ExtraSourceName = (typeof EXTRA_SOURCE_NAMES)[number];
export const EXTRA_SOURCES_FILE = "extra-sources.json";

export type ExtraSources = Map<ExtraSourceName, { emitted: number; survived: number }>;

/** Read `extra-sources.json` when present. Absent → none fired. */
export function readExtraSources(runDir: string): ExtraSources {
  const path = join(runDir, EXTRA_SOURCES_FILE);
  if (!existsSync(path)) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError(`${path}: not valid JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`${path}: expected an object`);
  }
  return parseExtraSources(raw as Record<string, unknown>, path);
}

/** Validate the parsed `extra-sources.json` object; `path` only labels errors. A key outside
 * `EXTRA_SOURCE_NAMES`, a non-integer count, or `survived > emitted` throws. */
export function parseExtraSources(r: Record<string, unknown>, path: string): ExtraSources {
  const s = new Shape(path);
  const out: ExtraSources = new Map();
  for (const [name, value] of Object.entries(r)) {
    if (!(EXTRA_SOURCE_NAMES as readonly string[]).includes(name)) {
      throw new UsageError(`${path}: \`${name}\` is not one of ${EXTRA_SOURCE_NAMES.join(", ")}`);
    }
    const v = s.obj(value, name) ?? {};
    out.set(name as ExtraSourceName, { emitted: s.int(v.emitted, `${name}.emitted`), survived: s.int(v.survived, `${name}.survived`) });
  }
  const issues = s.issues();
  if (issues.length > 0) throw new UsageError(issues.map((i) => i.message).join("\n"));
  for (const [name, { emitted, survived }] of out) {
    if (survived > emitted) {
      throw new UsageError(`${path}: \`${name}\` survived ${survived} exceeds emitted ${emitted}`);
    }
  }
  return out;
}

// ── Reader files, per stage ──────────────────────────────────────────────────────────────────

/** One stage's readers: reader → its findings (a split read's slices merged), and reader → the
 *  paths of the files they came from (one per slice; one per drift group's folder). */
export interface CollectedStage {
  stage: Stage;
  readers: Map<string, Finding[]>;
  files?: Map<string, string[]>;
}

/** The folder a stage's reader files live in, relative to the run dir; the wave is the root. A drift
 *  stage's folders carry their group (`stage-drift-<n>`), so its name here is the pattern. */
export function stageFolder(stage: Stage): string {
  if (stage === "wave") return "";
  return stage === "drift" || stage === "drift-confirm" ? `stage-${stage}-<n>` : `stage-${stage}`;
}

/**
 * The reader files in `dir` (`readerFiles`, the one rule the table script also uses), parsed with
 * the grammar of `stage`: a wave file with `parseReaderFile`, a stage file with `parseStageFile`
 * (only its `## New` findings count). `repoReaders` are the root ledger's `repo:` readers, also at a
 * stage folder, which holds no ledger (A.8). `session.md` is never a source: the session is not a
 * reader (A.10). A file that fails its grammar throws naming it — a silent partial row would score a
 * reader as clean.
 */
export function collectWaveDir(
  dir: string,
  repoReaders: readonly string[] = [],
  stage: Stage = "wave",
  folder: string = stageFolder(stage)
): CollectedStage {
  const readers = new Map<string, Finding[]>();
  const files = new Map<string, string[]>();
  for (const f of readerFiles(dir, repoReaders)) {
    if (f.reader === "session") continue;
    files.set(f.reader, [...(files.get(f.reader) ?? []), f.path]);
    const text = readFileSync(f.path, "utf8");
    let findings: Finding[];
    try {
      findings =
        stage === "wave"
          ? parseReaderFile(text).findings
          : parseStageFile(text, { stage }).findings;
    } catch (e) {
      const where = stage === "wave" ? f.name : `${folder}/${f.name}`;
      throw new UsageError(`reader file ${where}: ${(e as Error).message}`);
    }
    readers.set(f.reader, [...(readers.get(f.reader) ?? []), ...findings]);
  }
  return { stage, readers, files };
}

/** The wave and every stage folder present, one entry per stage: each drift group's folders
 *  (`stage-drift-<n>/`, `stage-drift-confirm-<n>/`) join their stage's entry. A wave with no reader
 *  file throws. */
export function collectRun(runDir: string, repoReaders: readonly string[]): CollectedStage[] {
  const wave = collectWaveDir(runDir, repoReaders, "wave");
  if (wave.readers.size === 0) {
    throw new UsageError(`no reader files in ${runDir} — the wave writes <reader>.md per reader; see /build §CLOSE`);
  }
  const folders = readdirSync(runDir)
    .map((name) => ({ name, key: name.startsWith("stage-") ? parseStageKey(name.slice("stage-".length)) : null }))
    .filter((f) => f.key !== null && statSync(join(runDir, f.name)).isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const out = [wave];
  for (const stage of STAGES) {
    if (stage === "wave") continue;
    const readers = new Map<string, Finding[]>();
    const files = new Map<string, string[]>();
    let seen = false;
    for (const f of folders.filter((x) => x.key!.stage === stage)) {
      seen = true;
      const c = collectWaveDir(join(runDir, f.name), repoReaders, stage, f.name);
      for (const [reader, findings] of c.readers) readers.set(reader, [...(readers.get(reader) ?? []), ...findings]);
      for (const [reader, paths] of c.files!) files.set(reader, [...(files.get(reader) ?? []), ...paths]);
    }
    if (seen) out.push({ stage, readers, files });
  }
  return out;
}

// ── Agents: type and real model ──────────────────────────────────────────────────────────────

export interface AgentMeta {
  agentType: string | null;
  /** The model family the agent ran (`opus`, `sonnet`, `haiku`); null when neither `meta.json` nor
   *  the transcript beside it names one. */
  model: string | null;
  /** Every full model id the agent's transcript shows it ran (`claude-sonnet-5-5`), in the order
   *  first seen. More than one means the agent switched mid-run (a safety re-run on an older model).
   *  Absent from a lookup that reads no transcript. */
  models?: string[];
}

/** One reader agent found for a reader file: its id and the full model ids it ran, first seen first. */
export interface ReaderAgent {
  id: string;
  models: string[];
}

/**
 * An agent id → its `meta.json` facts, or null when no `meta.json` is found. `readerAgents`, when
 * present, finds the agents that wrote one reader file (the ledger's read lines carry no agent id);
 * a lookup without it records no model for any reader.
 */
export interface AgentLookup {
  (id: string): AgentMeta | null;
  readerAgents?: (reader: string, file: string) => ReaderAgent[];
}

/** A meta.json `agentType` as the build names it: a plugin agent's type carries the plugin prefix
 *  (`agent-build:review-cursory`), and the readers, builder and fixer are named bare. */
function bareAgentType(v: unknown): string | null {
  return typeof v === "string" ? v.replace(/^[\w-]+:/, "") : null;
}

/** `claude-opus-5-5` → `opus`; an unknown name stays as written. */
export function modelFamily(model: string): string {
  return /(opus|sonnet|haiku)/.exec(model)?.[1] ?? model;
}

const CHUNK_BYTES = 64 * 1024;

/** Each line of a file, read in chunks so a transcript of many megabytes is never held whole (only
 *  the line being read is). `visit` returns false to stop early. */
export function eachLine(path: string, visit: (line: string) => boolean | void): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let pending: Buffer[] = [];
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      let start = 0;
      for (let nl = buf.indexOf(10, start); nl !== -1 && nl < n; nl = buf.indexOf(10, start)) {
        const line = Buffer.concat([...pending, buf.subarray(start, nl)]).toString("utf8");
        pending = [];
        start = nl + 1;
        if (visit(line) === false) return;
      }
      // Copied: the next read reuses `buf`.
      if (start < n) pending.push(Buffer.from(buf.subarray(start, n)));
    }
    if (pending.length > 0) visit(Buffer.concat(pending).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Every full model id (`claude-…`) the transcript's assistant records carry, first seen first; []
 *  when the file is missing or names none. */
export function transcriptModels(path: string): string[] {
  if (!existsSync(path)) return [];
  const out: string[] = [];
  eachLine(path, (line) => {
    if (!line.includes('"model":"claude-')) return;
    let rec: { type?: unknown; message?: { model?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      return; // A torn last line (the agent still writing) holds no finished record.
    }
    const model = rec.message?.model;
    if (rec.type === "assistant" && typeof model === "string" && model.startsWith("claude-") && !out.includes(model)) {
      out.push(model);
    }
  });
  return out;
}

/** The text of a transcript's first user record: the prompt the agent was spawned with; "" when none. */
function transcriptPrompt(path: string): string {
  if (!existsSync(path)) return "";
  let prompt = "";
  eachLine(path, (line) => {
    let rec: { type?: unknown; message?: { content?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (rec.type !== "user") return;
    const content = rec.message?.content;
    prompt =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c: { text?: unknown } | null) => c?.text).join("\n") // join writes a missing text as ""
          : "";
    return false;
  });
  return prompt;
}

/** The Claude projects dir: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function defaultProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

/** The spellings a prompt may use for `file`: absolute as given, its real path, and each of those
 *  written from `~/`. */
function pathForms(file: string): string[] {
  const abs = resolve(file);
  const forms = [abs];
  try {
    forms.push(realpathSync(abs));
  } catch {
    // A file gone since it was collected keeps its given spelling only.
  }
  // resolve: a HOME spelled with a doubled slash would never prefix a resolved path.
  const home = resolve(homedir());
  for (const f of [...forms]) if (f.startsWith(`${home}/`)) forms.push(`~${f.slice(home.length)}`);
  return [...new Set(forms)];
}

/** Whether `text` names one of `forms` as a whole path: `a/review-cursory.md` does not name
 *  `a/review-cursory.md.refused.txt`, and a sentence's closing `.` is not part of the path. */
function namesPath(text: string, forms: readonly string[]): boolean {
  for (const form of forms) {
    for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) {
      if (!/^(?:[\w-]|\.\w)/.test(text.slice(i + form.length, i + form.length + 2))) return true;
    }
  }
  return false;
}

/**
 * Finds `<projectsDir>/<project>/<session>/subagents/agent-<id>.meta.json`. The model is the
 * `meta.json` `model` when it names a family; a spawn that passed no model (or `inherit`) leaves it
 * out, so the transcript beside it (`agent-<id>.jsonl`, which carries the real model id on every
 * message) answers instead. `models` is every full id that transcript carries.
 *
 * `readerAgents(reader, file)`: the ledger's read lines name no agent, so a reader's agents are the
 * subagents whose `meta.json` `agentType` is the reader's name and whose prompt (the transcript's
 * first user record) names `file`, the reader file itself. Every dispatch names its output file
 * (`/build` §CLOSE), so this tells the wave's read from a stage's (whose prompt names the run dir
 * too, via `--run-dir`) and one split slice from the other. Every `meta.json` is indexed once, on
 * the first call.
 */
export function metaLookup(projectsDir: string): AgentLookup {
  const cache = new Map<string, AgentMeta | null>();
  const modelsCache = new Map<string, string[]>();
  const modelsOf = (transcript: string): string[] => {
    if (!modelsCache.has(transcript)) modelsCache.set(transcript, transcriptModels(transcript));
    return modelsCache.get(transcript)!;
  };
  const dirs = (p: string): string[] =>
    existsSync(p)
      ? readdirSync(p, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(p, d.name))
          .sort()
      : [];

  const lookup: AgentLookup = (id) => {
    if (cache.has(id)) return cache.get(id)!;
    let found: AgentMeta | null = null;
    search: for (const project of dirs(projectsDir)) {
      for (const session of dirs(project)) {
        const sub = join(session, "subagents");
        const metaPath = join(sub, `agent-${id}.meta.json`);
        if (!existsSync(metaPath)) continue;
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        } catch {
          // An unreadable meta.json is the same as none: the ingest prints a note.
          continue;
        }
        const named = typeof meta.model === "string" ? modelFamily(meta.model) : null;
        const fromMeta = named !== null && /^(opus|sonnet|haiku)$/.test(named) ? named : null;
        const models = modelsOf(join(sub, `agent-${id}.jsonl`));
        found = {
          agentType: bareAgentType(meta.agentType),
          model: fromMeta ?? (models.length === 0 ? null : modelFamily(models[0]!)),
          models,
        };
        break search;
      }
    }
    cache.set(id, found);
    return found;
  };

  let index: { id: string; agentType: string | null; transcript: string }[] | null = null;
  const prompts = new Map<string, string>();
  lookup.readerAgents = (reader, file) => {
    if (index === null) {
      index = [];
      for (const project of dirs(projectsDir)) {
        for (const session of dirs(project)) {
          const sub = join(session, "subagents");
          if (!existsSync(sub)) continue;
          for (const name of readdirSync(sub).sort()) {
            const m = /^agent-(.+)\.meta\.json$/.exec(name);
            if (!m) continue;
            try {
              const meta = JSON.parse(readFileSync(join(sub, name), "utf8")) as Record<string, unknown>;
              index.push({ id: m[1]!, agentType: bareAgentType(meta.agentType), transcript: join(sub, `agent-${m[1]}.jsonl`) });
            } catch {
              // An unreadable meta.json (or a `null` one) names no reader; the reader's note says none was found.
            }
          }
        }
      }
    }
    const forms = pathForms(file);
    const out: ReaderAgent[] = [];
    for (const a of index) {
      if (a.agentType !== reader) continue;
      if (!prompts.has(a.transcript)) prompts.set(a.transcript, transcriptPrompt(a.transcript));
      if (namesPath(prompts.get(a.transcript)!, forms)) out.push({ id: a.id, models: modelsOf(a.transcript) });
    }
    return out;
  };
  return lookup;
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────

export type KindCounts = Partial<Record<Kind, number>>;

/** One fix round's outcome: its rows, what the fixer's lines said, and who fixed it. */
export interface RoundStat {
  round: FixRound;
  rows: number;
  fixed: number;
  dropped: number;
  relabelled: number;
  decisions: number;
  /** The ledger's `model=`; null when the round had no fixer. */
  model: string | null;
  /** From `meta.json`; null when the round had no fixer or no `meta.json` was found. */
  agentType: string | null;
  /** Every full model id the round's fixers ran, first seen first; [] when no transcript named one.
   *  Absent when the round had no fixer, and on rows written before it was recorded. */
  modelIds?: string[];
}

/** A run row's or source row's `modelIds` field: present only when the move had an agent to look up. */
function withIds(ids: string[] | null): { modelIds?: string[] } {
  return ids === null ? {} : { modelIds: ids };
}

/** One row per ingested run. */
export interface RunRow {
  kind: "run";
  schema: 2;
  ts: string;
  runId: string;
  pipeline: Pipeline;
  ref: string;
  runDir?: string;
  cls: RiskClass;
  /** Every reader that wrote a file at any stage, then the extra sources. */
  fired: string[];
  /** The class's readers with no wave file. */
  notFired: string[];
  rounds: RoundStat[];
  /** `final.open` per kind; `{}` when nothing is open or the run has no final round. */
  openAtEnd: KindCounts;
  /** `final.leftovers`; 0 when the run has no final round. */
  leftovers: number;
  /** `parts` is present when the ledger's `build:` line carries `parts=`: each part's brief model,
   *  and the agent type and model its agents really ran (from `meta.json`). */
  build: { model: string; agentType: string | null; modelIds?: string[]; parts?: BuildPartStat[] } | null;
}

export interface BuildPartStat {
  part: string;
  model: string;
  agentType: string | null;
  /** The model family its agents ran; null for a `session` part or when no `meta.json` names one. */
  realModel: string | null;
  /** Every full model id its agents ran, first seen first; absent for a `session` part. */
  modelIds?: string[];
}

/** One row per reader per stage (and per extra source, `stage: null`). */
export interface SrcRow {
  kind: "src";
  schema: 2;
  runId: string;
  source: string;
  stage: Stage | null;
  type: "reader";
  emitted: number;
  /** Findings whose row was not dropped by the fixer with the stage reader's `agree` (A.17). */
  survived: number;
  /** Emitted findings per kind, as the reader labelled them. */
  kinds: KindCounts;
  /** Every full model id the reader's agents at this stage ran, first seen first; [] when no agent
   *  was found. Absent for an extra source, a Codex read (no Claude transcript), a lookup that finds
   *  no readers, and rows written before it was recorded. */
  modelIds?: string[];
}

export interface RunMeta {
  runId: string;
  pipeline: Pipeline;
  ref: string;
  cls: RiskClass;
  ts?: string;
  runDir?: string;
}

/** The fix rounds `table.json` holds, in build order (a drift group's `drift-<n>` among them). */
function fixRoundsIn(table: TableJson): FixRound[] {
  return (Object.keys(table.rounds) as RoundId[]).filter(isFixRound).sort(roundOrder) as FixRound[];
}

/** The round whose intake reads fix round `r`'s rows back (round 1 → 2, … escalate and drift-<n> → final). */
function roundAfter(r: FixRound, table: TableJson): RoundId | null {
  for (const id of ["2", "3", "escalate", "final"] as const) {
    if (roundIntake(id, table).carry.some((c) => c.fix === r)) return id;
  }
  return null;
}

/**
 * Every finding id (a row's id and its `also`) whose row the fixer `dropped` and the table then
 * closed. The table closes a dropped row only on the stage's `agree` (`lib/table.ts` routing; with no
 * stage read the drop stands, and the gate refuses a run whose read was owed and missing), so this is
 * "dropped with an agree". A disagreed drop comes back as a row and its findings survive.
 */
export function droppedAndAgreed(table: TableJson, fixes: ReadonlyMap<FixRound, FixFile>): Set<string> {
  const out = new Set<string>();
  for (const r of fixRoundsIn(table)) {
    const round = table.rounds[r];
    const fix = fixes.get(r);
    const next = roundAfter(r, table);
    const closed = next === null ? undefined : table.rounds[next]?.closed;
    if (!round || !fix || !closed) continue;
    for (const row of round.rows) {
      const line = fix.lines.find((l) => l.row === row.id);
      if (line?.action === "dropped" && closed.includes(row.id)) {
        for (const id of [row.id, ...row.also]) out.add(id);
      }
    }
  }
  return out;
}

export interface RunInputs {
  collected: readonly CollectedStage[];
  table: TableJson;
  /** The parsed `fix-<round>.txt` files present. */
  fixes: ReadonlyMap<FixRound, FixFile>;
  ledger: Ledger;
  extras?: ExtraSources;
  lookup: AgentLookup;
}

function countKinds(findings: readonly Finding[]): KindCounts {
  const out: KindCounts = {};
  for (const f of findings) out[f.kind] = (out[f.kind] ?? 0) + 1;
  return out;
}

/** Append each id of `ids` not yet in `into`, keeping first-seen order. */
function addIds(into: string[], ids: readonly string[]): void {
  for (const id of ids) if (!into.includes(id)) into.push(id);
}

/** The note for an agent whose transcript holds more than one model id (a safety re-run on an older
 *  model, or a switch mid-run), naming the ids in the order first seen; none for one id or none. */
function switchNote(move: string, id: string, models: readonly string[], notes: string[]): void {
  if (models.length > 1) notes.push(`note: ${move} agent ${id}: ran more than one model — ${models.join(", ")}`);
}

/**
 * The agent types of one ledger line's agents and the full model ids they ran, and a note for each
 * agent whose `meta.json` is missing, whose real model family is not the one the ledger names, or
 * that ran more than one model. `modelIds` is null when the line names no agent (`none`).
 */
function agentFacts(
  move: string,
  ledgerModel: string,
  agents: readonly string[],
  lookup: AgentLookup,
  notes: string[]
): { agentType: string | null; realModel: string | null; modelIds: string[] | null } {
  const types: string[] = [];
  const models: string[] = [];
  let modelIds: string[] | null = null;
  for (const id of agents) {
    if (id === "none") continue;
    modelIds ??= [];
    const meta = lookup(id);
    if (meta === null) {
      notes.push(`note: ${move} agent ${id}: no meta.json found — agent type and real model unknown`);
      continue;
    }
    if (meta.agentType !== null && !types.includes(meta.agentType)) types.push(meta.agentType);
    if (meta.model !== null && !models.includes(meta.model)) models.push(meta.model);
    addIds(modelIds, meta.models ?? []);
    if (meta.model === null) {
      notes.push(`note: ${move} agent ${id}: meta.json and its transcript name no model`);
    } else if (ledgerModel !== "session" && meta.model !== ledgerModel) {
      notes.push(`note: ${move} agent ${id}: the ledger says model=${ledgerModel}, the agent ran ${meta.model}`);
    }
    switchNote(move, id, meta.models ?? [], notes);
  }
  return {
    agentType: types.length === 0 ? null : types.join(","),
    realModel: models.length === 0 ? null : models.join(","),
    modelIds,
  };
}

/** The builder's facts. With `parts=`, one entry per part, each agent held to its part's model (the
 *  header `model=` is only the strongest part's, so a sonnet part is no mismatch), and the header's
 *  `modelIds` every part's; without it, the one builder held to `model=`. */
function buildFacts(build: NonNullable<Ledger["build"]>, lookup: AgentLookup, notes: string[]): RunRow["build"] {
  if (build.parts === undefined) {
    const f = agentFacts("build", build.model, build.agents, lookup, notes);
    return { model: build.model, agentType: f.agentType, ...withIds(f.modelIds) };
  }
  let all: string[] | null = null;
  const parts = build.parts.map((p) => {
    const f = agentFacts(`build ${p.part}`, p.model, p.agents, lookup, notes);
    if (f.modelIds !== null) addIds((all ??= []), f.modelIds);
    return { part: p.part, model: p.model, agentType: f.agentType, realModel: f.realModel, ...withIds(f.modelIds) };
  });
  const types = [...new Set(parts.flatMap((p) => p.agentType?.split(",") ?? []))];
  return { model: build.model, agentType: types.length === 0 ? null : types.join(","), ...withIds(all), parts };
}

/** No Claude agent writes a Codex read's file (`codex -o` does), so no transcript can name its model. */
const CODEX_READERS: ReadonlySet<string> = new Set(["review-cursory-codex"]);

/**
 * The full model ids one reader's agents ran at one stage: every agent `readerAgents` finds for each
 * of its files. A note for a file no agent is found for, and for an agent that ran more than one
 * model. Null (no field) for a Codex read, or when the lookup cannot find readers.
 */
function readerModelIds(
  reader: string,
  files: readonly string[],
  runDir: string | undefined,
  lookup: AgentLookup,
  notes: string[]
): string[] | null {
  if (lookup.readerAgents === undefined || CODEX_READERS.has(reader)) return null;
  const ids: string[] = [];
  for (const file of files) {
    const name = runDir === undefined ? file : relative(runDir, file);
    const agents = lookup.readerAgents(reader, file);
    if (agents.length === 0) {
      notes.push(`note: reader ${name}: no ${reader} agent's prompt names this file — its model is unknown`);
    }
    for (const a of agents) {
      addIds(ids, a.models);
      switchNote(`reader ${name}`, a.id, a.models, notes);
    }
  }
  return ids;
}

/**
 * One run row + one src row per reader per stage (+ one per extra source), and the notes to print.
 * Pure over its inputs: the caller reads the files and injects the `meta.json` lookup.
 */
export function buildRunRows(
  inputs: RunInputs,
  meta: RunMeta
): { run: RunRow; srcs: SrcRow[]; notes: string[] } {
  const { collected, table, fixes, ledger, lookup } = inputs;
  const extras = inputs.extras ?? new Map();
  const notes: string[] = [];
  const gone = droppedAndAgreed(table, fixes);

  const srcs: SrcRow[] = [];
  for (const c of collected) {
    for (const [source, findings] of [...c.readers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      srcs.push({
        kind: "src",
        schema: 2,
        runId: meta.runId,
        source,
        stage: c.stage,
        type: "reader",
        emitted: findings.length,
        survived: findings.filter((f) => !gone.has(f.id)).length,
        kinds: countKinds(findings),
        ...withIds(readerModelIds(source, c.files?.get(source) ?? [], meta.runDir, lookup, notes)),
      });
    }
  }
  const extraNames = [...extras.keys()].sort();
  for (const name of extraNames) {
    srcs.push({ kind: "src", schema: 2, runId: meta.runId, source: name, stage: null, type: "reader", ...extras.get(name)!, kinds: {} });
  }

  const rounds: RoundStat[] = [];
  for (const r of fixRoundsIn(table)) {
    const round = table.rounds[r];
    if (!round) continue;
    const lines = fixes.get(r)?.lines ?? [];
    const count = (a: string) => lines.filter((l) => l.action === a).length;
    const { move, line: fixLine } = fixOfRound(ledger, r);
    const facts = fixLine ? agentFacts(move, fixLine.model, fixLine.agents, lookup, notes) : null;
    rounds.push({
      round: r,
      rows: round.rows.length,
      fixed: count("fixed"),
      dropped: count("dropped"),
      relabelled: count("relabel"),
      decisions: count("decision"),
      model: fixLine?.model ?? null,
      agentType: facts?.agentType ?? null,
      ...withIds(facts?.modelIds ?? null),
    });
  }

  const build = ledger.build ? buildFacts(ledger.build, lookup, notes) : null;

  const final = table.rounds.final;
  const openAtEnd: KindCounts = {};
  if (final && "open" in final) for (const o of final.open) openAtEnd[o.kind] = (openAtEnd[o.kind] ?? 0) + 1;
  if (!final) notes.push("note: table.json has no final round — openAtEnd and leftovers are recorded as none");

  const waveReaders = collected.find((c) => c.stage === "wave")?.readers ?? new Map();
  const fired = [...new Set(collected.flatMap((c) => [...c.readers.keys()]))].sort();
  return {
    run: {
      kind: "run",
      schema: 2,
      ts: meta.ts ?? new Date().toISOString(),
      runId: meta.runId,
      pipeline: meta.pipeline,
      ref: meta.ref,
      ...(meta.runDir !== undefined ? { runDir: meta.runDir } : {}),
      cls: meta.cls,
      fired: [...fired, ...extraNames],
      notFired: RISK_CLASS_READERS[meta.cls].filter((r) => !waveReaders.has(r)),
      rounds,
      openAtEnd,
      leftovers: final?.leftovers.length ?? 0,
      build,
    },
    srcs,
    notes,
  };
}

/** The `fix-<round>.txt` files present, each parsed against its round's rows. */
function readFixes(runDir: string, table: TableJson): Map<FixRound, FixFile> {
  const out = new Map<FixRound, FixFile>();
  for (const r of fixRoundsIn(table)) {
    const path = join(runDir, `fix-${r}.txt`);
    const round = table.rounds[r];
    if (!existsSync(path) || !round) continue;
    try {
      out.set(r, parseFixFile(readFileSync(path, "utf8"), { rows: round.rows.map((x) => x.id), round: r }));
    } catch (e) {
      throw new UsageError(`fix-${r}.txt: ${(e as Error).message}`);
    }
  }
  return out;
}

/** The run's ledger; the old flow's ledger, or an old run dir (`round.json`, no `table.json`),
 *  throws `FlowChangedError`. */
function readFlow2(runDir: string): { ledger: Ledger; table: TableJson } {
  const hasTable = existsSync(join(runDir, "table.json"));
  if (existsSync(join(runDir, "round.json")) && !hasTable) throw new FlowChangedError();
  let ledger: Ledger;
  try {
    ledger = readLedger(runDir);
  } catch (e) {
    if ((e as Error).message.endsWith(FLOW_CHANGED)) throw new FlowChangedError();
    throw e;
  }
  if (!hasTable) throw new UsageError(`${join(runDir, "table.json")} does not exist — run \`reviewTable.ts build\` first`);
  return { ledger, table: readTable(runDir) };
}

/** Ingest one run dir into the log. Idempotent by runId: a run row with the same runId already
 * present → skip without writing (a resume or re-run must never double-count). */
export function ingest(
  runDir: string,
  meta: RunMeta,
  file: string,
  lookup: AgentLookup = metaLookup(defaultProjectsDir())
): { skipped: boolean; run: RunRow; srcs: SrcRow[]; notes: string[] } {
  if (!existsSync(runDir)) throw new UsageError(`${runDir} does not exist`);
  const { ledger, table } = readFlow2(runDir);
  const rows = buildRunRows(
    {
      collected: collectRun(runDir, ledger.waveRepoReaders),
      table,
      fixes: readFixes(runDir, table),
      ledger,
      extras: readExtraSources(runDir),
      lookup,
    },
    { ...meta, runDir }
  );
  const existing = readJsonl<TelemetryRow>(file);
  if (existing.some((r) => r.kind === "run" && r.runId === meta.runId)) return { skipped: true, ...rows };
  appendJsonl(file, [rows.run, ...rows.srcs]);
  return { skipped: false, ...rows };
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────

/** A run row the old flow wrote. Read loosely: old logs hold every shape the log has ever had. */
export interface LegacyRunRow {
  kind: "run";
  schema?: undefined;
  ts?: string;
  runId?: string;
  cls?: string;
  round?: {
    applied?: number;
    unresolvedAfterRound?: number;
    regressionsAtConfirm?: { count?: number; worst?: string | null };
    revertedTrivial?: number;
  };
  [key: string]: unknown;
}

export interface LegacySrcRow {
  kind: "src";
  schema?: undefined;
  runId?: string;
  source?: string;
  type?: string;
  emitted?: number;
  survived?: number;
  tiers?: { blocker?: number; high?: number; medium?: number; low?: number };
  [key: string]: unknown;
}

export type TelemetryRow = RunRow | SrcRow | LegacyRunRow | LegacySrcRow;

const isV2Run = (r: TelemetryRow): r is RunRow => r.kind === "run" && r.schema === 2;

/** The schema-2 runs at or after `since`. */
export function reportRuns(rows: readonly TelemetryRow[], since?: string): RunRow[] {
  return rows.filter((r): r is RunRow => isV2Run(r) && (since === undefined || r.ts >= since));
}

/** The old flow's class-era runs (a `cls` is present) at or after `since`. Lane-era rows carry none. */
export function legacyRuns(rows: readonly TelemetryRow[], since?: string): LegacyRunRow[] {
  return rows.filter(
    (r): r is LegacyRunRow =>
      r.kind === "run" &&
      r.schema !== 2 &&
      typeof r.cls === "string" &&
      (since === undefined || (typeof r.ts === "string" && r.ts >= since))
  );
}

export interface SourceReport {
  source: string;
  stage: string;
  fires: number;
  emitted: number;
  survived: number;
  /** survived ÷ fires — the number the reader floor judges. */
  perFire: number;
  kinds: KindCounts;
  /** fires ≥ `READER_FLOOR_MIN_FIRES` and perFire < `READER_FLOOR_FINDINGS_PER_FIRE`. */
  belowFloor: boolean;
  /** The fires per model (`modelLabel`), first seen first. More than one entry means the numbers
   *  beside it add up fires of different models. */
  models: { model: string; fires: number }[];
}

/** The model one source row's fire ran: its full ids joined by `+` (an agent that switched, or a
 *  split read whose slices differed), or `?` when the row names none — a row written before the ids
 *  were recorded, a Codex read, an extra source, or a reader whose agent was not found. */
export function modelLabel(row: { modelIds?: readonly string[] }): string {
  return row.modelIds !== undefined && row.modelIds.length > 0 ? row.modelIds.join("+") : "?";
}

function judge<T extends { fires: number; survived: number; perFire: number; belowFloor: boolean }>(
  aggs: Iterable<T>,
  floor: ReaderFloor
): T[] {
  const out = [...aggs];
  for (const a of out) {
    a.perFire = a.fires > 0 ? a.survived / a.fires : 0;
    a.belowFloor = a.fires >= floor.minFires && a.perFire < floor.perFire;
  }
  return out;
}

/** The schema-2 source rows of `runs`, summed per source and stage, and per model too when `byModel`. */
function sumSources(
  rows: readonly TelemetryRow[],
  runs: readonly RunRow[],
  floor: ReaderFloor,
  byModel: boolean
): SourceReport[] {
  const runIds = new Set(runs.map((r) => r.runId));
  const by = new Map<string, SourceReport>();
  for (const row of rows) {
    if (row.kind !== "src" || row.schema !== 2 || !runIds.has(row.runId)) continue;
    const stage = row.stage ?? "extra";
    const model = modelLabel(row);
    const key = byModel ? `${row.source}\0${stage}\0${model}` : `${row.source}\0${stage}`;
    const agg = by.get(key) ?? {
      source: row.source,
      stage,
      fires: 0,
      emitted: 0,
      survived: 0,
      perFire: 0,
      kinds: {},
      belowFloor: false,
      models: [],
    };
    agg.fires += 1;
    agg.emitted += row.emitted;
    agg.survived += row.survived;
    for (const [k, n] of Object.entries(row.kinds) as [Kind, number][]) agg.kinds[k] = (agg.kinds[k] ?? 0) + n;
    const m = agg.models.find((x) => x.model === model);
    if (m) m.fires += 1;
    else agg.models.push({ model, fires: 1 });
    by.set(key, agg);
  }
  const stageIndex = (s: string) => (s === "extra" ? STAGES.length : STAGES.indexOf(s as Stage));
  // Split by model, a source's models keep the order first seen (the sort is stable).
  return judge(by.values(), floor).sort(
    (a, b) =>
      stageIndex(a.stage) - stageIndex(b.stage) ||
      (byModel ? a.source.localeCompare(b.source) : b.perFire - a.perFire || a.source.localeCompare(b.source))
  );
}

/** The schema-2 source rows of `runs`, per source and stage. One src row is one fire; `models` says
 *  which models those fires ran. Pure. */
export function aggregate(
  rows: readonly TelemetryRow[],
  runs: readonly RunRow[],
  floor: ReaderFloor = DEFAULT_FLOOR
): SourceReport[] {
  return sumSources(rows, runs, floor, false);
}

/** The same sums split by model, for each source and stage whose fires ran more than one model
 *  (`?` counts as one): one entry per source, stage, and model. Pure. */
export function aggregateByModel(
  rows: readonly TelemetryRow[],
  runs: readonly RunRow[],
  floor: ReaderFloor = DEFAULT_FLOOR
): SourceReport[] {
  const mixed = new Set(aggregate(rows, runs, floor).filter((s) => s.models.length > 1).map((s) => `${s.source}\0${s.stage}`));
  return sumSources(rows, runs, floor, true).filter((s) => mixed.has(`${s.source}\0${s.stage}`));
}

export interface LegacySourceReport {
  source: string;
  fires: number;
  emitted: number;
  survived: number;
  perFire: number;
  /** BLOCK / FIX / NOTE (NOTE holds the lane era's `medium` too). */
  tiers: [number, number, number];
  belowFloor: boolean;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The old rows' reader sources of `runs`. Missing fields count as 0; never throws. Pure. */
export function aggregateLegacy(
  rows: readonly TelemetryRow[],
  runs: readonly LegacyRunRow[],
  floor: ReaderFloor = DEFAULT_FLOOR
): LegacySourceReport[] {
  const runIds = new Set(runs.map((r) => r.runId));
  const by = new Map<string, LegacySourceReport>();
  for (const row of rows) {
    if (row.kind !== "src" || row.schema === 2 || row.type !== "reader" || !runIds.has(row.runId)) continue;
    const source = String(row.source ?? "?");
    const agg = by.get(source) ?? { source, fires: 0, emitted: 0, survived: 0, perFire: 0, tiers: [0, 0, 0], belowFloor: false };
    agg.fires += 1;
    agg.emitted += num(row.emitted);
    agg.survived += num(row.survived);
    const t = row.tiers ?? {};
    agg.tiers = [agg.tiers[0] + num(t.blocker), agg.tiers[1] + num(t.high), agg.tiers[2] + num(t.low) + num(t.medium)];
    by.set(source, agg);
  }
  return judge(by.values(), floor).sort((a, b) => b.perFire - a.perFire || a.source.localeCompare(b.source));
}

function classCounts(runs: readonly { cls?: string }[]): string {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.cls ?? "?", (counts.get(r.cls ?? "?") ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, n]) => `${n} ${c}`)
    .join(", ");
}

function table(header: string[], body: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  return [header, ...body].map((line) =>
    line
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd()
  );
}

function kindText(k: KindCounts): string {
  const parts = KINDS.filter((x) => (k[x] ?? 0) > 0).map((x) => `${x} ${k[x]}`);
  return parts.length === 0 ? "-" : parts.join(", ");
}

/** `<family>/<agent type>`, then the full ids in brackets when the row recorded any. */
function who(model: string | null, agentType: string | null, modelIds?: readonly string[]): string {
  const ids = modelIds !== undefined && modelIds.length > 0 ? ` (${modelIds.join(", ")})` : "";
  return `${model ?? "?"}/${agentType ?? "?"}${ids}`;
}

/** A source's fires per model: the one model alone, or each with its fire count. */
function modelsText(models: readonly { model: string; fires: number }[]): string {
  return models.length === 1 ? models[0]!.model : models.map((m) => `${m.model} (${m.fires})`).join(", ");
}

/** One line per schema-2 run: the builder, each fix round, the open set, the leftovers. */
function runLine(r: RunRow): string {
  const rounds = r.rounds.map((x) =>
    x.rows === 0
      ? `${x.round}: 0 rows`
      : `${x.round}: ${x.rows} rows, ${x.fixed} fixed, ${x.dropped} dropped, ${x.relabelled} relabelled, ${x.decisions} decisions, ${who(x.model, x.agentType, x.modelIds)}`
  );
  const open = kindText(r.openAtEnd);
  return [
    `  ${r.runId} ${r.cls}: build ${r.build ? who(r.build.model, r.build.agentType, r.build.modelIds) : "none"}`,
    ...rounds,
    `open ${open === "-" ? "none" : open}`,
    `leftovers ${r.leftovers}`,
  ].join(" · ");
}

function legacySection(rows: readonly TelemetryRow[], runs: readonly LegacyRunRow[], scope: string, floor: ReaderFloor): string[] {
  const out = [`legacy (the old flow's rows, BLOCK/FIX/NOTE tiers): ${runs.length} run(s)${scope} (${classCounts(runs)})`, ""];
  const body = aggregateLegacy(rows, runs, floor).map((s) => [
    s.source + (s.belowFloor ? " ⚠ below floor" : ""),
    String(s.fires),
    String(s.emitted),
    String(s.survived),
    s.perFire.toFixed(2),
    s.tiers.join("/"),
  ]);
  out.push(...table(["source", "fires", "emitted", "survived", "per-fire", "BLOCK/FIX/NOTE"], body));
  const rounds = runs.filter((r) => r.round && typeof r.round === "object");
  out.push("", "legacy rounds (one fix round per run — applied / unresolved / regressions at confirm):");
  if (rounds.length === 0) out.push("  none recorded — no round rows");
  for (const r of rounds) {
    const x = r.round!;
    const reg = x.regressionsAtConfirm ?? {};
    out.push(
      `  ${r.runId ?? "?"} ${r.cls ?? "?"}: applied ${num(x.applied)}, unresolved ${num(x.unresolvedAfterRound)}, regressions ${num(reg.count)}${reg.worst ? ` (worst ${reg.worst})` : ""}, reverted-trivial ${num(x.revertedTrivial)}`
    );
  }
  if (rounds.length > 0) {
    const worst = rounds.filter((r) => ["BLOCK", "FIX"].includes(String(r.round!.regressionsAtConfirm?.worst)));
    out.push(`  runs with a BLOCK/FIX regression at confirm: ${worst.length}/${rounds.length}`);
  }
  return out;
}

/** The report: the schema-2 source table and run lines, then the legacy section. Pure; never
 *  throws on an old row. */
export function formatReport(rows: readonly TelemetryRow[], since?: string, floor: ReaderFloor = DEFAULT_FLOOR): string {
  const runs = reportRuns(rows, since);
  const legacy = legacyRuns(rows, since);
  const scope = since === undefined ? "" : ` since ${since}`;
  if (runs.length === 0 && legacy.length === 0) return `reviewTelemetry: no class-era runs ingested${scope}`;
  const out: string[] = [`reviewTelemetry: ${runs.length} run(s)${scope}${runs.length > 0 ? ` (${classCounts(runs)})` : ""}`, ""];
  if (runs.length > 0) {
    const body = aggregate(rows, runs, floor).map((s) => [
      s.source + (s.belowFloor ? " ⚠ below floor" : ""),
      s.stage,
      String(s.fires),
      String(s.emitted),
      String(s.survived),
      s.perFire.toFixed(2),
      kindText(s.kinds),
      modelsText(s.models),
    ]);
    out.push(...table(["source", "stage", "fires", "emitted", "survived", "per-fire", "kinds", "models"], body));
    out.push(`\nfloor: ${floor.perFire.toFixed(1)} findings per fire after ${floor.minFires} fires, per source and stage`);
    const split = aggregateByModel(rows, runs, floor);
    if (split.length > 0) {
      out.push(
        "\nby model (each source and stage above whose fires ran more than one model, its numbers apart; ? = not recorded):",
        ...table(
          ["source", "stage", "model", "fires", "emitted", "survived", "per-fire", "kinds"],
          split.map((s) => [
            s.source,
            s.stage,
            s.models[0]!.model,
            String(s.fires),
            String(s.emitted),
            String(s.survived),
            s.perFire.toFixed(2),
            kindText(s.kinds),
          ])
        )
      );
    }
    out.push("\nruns (builder, each fix round, what stayed open, leftovers; model/agent type (full model ids)):");
    for (const r of runs) out.push(runLine(r));
  }
  if (legacy.length > 0) {
    out.push("", ...legacySection(rows, legacy, scope, floor));
  }
  return out.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export function defaultLog(): string {
  return join(resolveRunStateDir(), "review-telemetry.jsonl");
}

const USAGE =
  "usage: --ingest <run-dir> --pipeline build --ref <r> --run-id <id> --class R<n> [--file <jsonl>] | --report [--since YYYY-MM-DD] [--file <jsonl>]";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Test seam for the `meta.json` lookup. */
  lookup?: AgentLookup;
}

const STD_IO: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

/** Throws `UsageError` on bad flags and unreadable input, `FlowChangedError` on an old run dir. */
export function runIngest(argv: string[], io: Io = STD_IO): number {
  const runDir = takeValue(argv, "--ingest");
  const pipeline = takeValue(runDir.rest, "--pipeline");
  const ref = takeValue(pipeline.rest, "--ref");
  const runId = takeValue(ref.rest, "--run-id");
  const cls = takeValue(runId.rest, "--class");
  const file = takeValue(cls.rest, "--file");
  try {
    assertKnownFlags(file.rest, []);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (!runDir.value || !pipeline.value || !ref.value || !runId.value) throw new UsageError(USAGE);
  if (!(PIPELINES as readonly string[]).includes(pipeline.value)) {
    throw new UsageError(`--pipeline must be one of ${PIPELINES.join(", ")}, got \`${pipeline.value}\``);
  }
  if (cls.value === undefined || !isRiskClass(cls.value)) {
    throw new UsageError(`--class must be one of R0, R1, R2, got \`${cls.value}\``);
  }
  const out = file.value ?? defaultLog();
  const result = ingest(
    runDir.value,
    { runId: runId.value, pipeline: pipeline.value as Pipeline, ref: ref.value, cls: cls.value },
    out,
    io.lookup
  );
  for (const n of result.notes) io.out(n);
  if (result.skipped) {
    io.out(`reviewTelemetry: run-id ${runId.value} already ingested — skipped (idempotent)`);
  } else {
    io.out(
      `reviewTelemetry: ingested run ${runId.value} → ${out} (1 run row + ${result.srcs.length} src rows; fired: ${result.run.fired.join(", ")})`
    );
  }
  return 0;
}

export function runReport(argv: string[], floor: ReaderFloor = DEFAULT_FLOOR, io: Io = STD_IO): number {
  const rest = argv.filter((a) => a !== "--report");
  const since = takeValue(rest, "--since");
  const file = takeValue(since.rest, "--file");
  try {
    assertKnownFlags(file.rest, []);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (since.value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since.value)) {
    throw new UsageError(`--since must be YYYY-MM-DD, got \`${since.value}\``);
  }
  io.out(formatReport(readJsonl<TelemetryRow>(file.value ?? defaultLog()), since.value, floor));
  return 0;
}

/** Exit 0 done · 1 an old-flow run dir (the `flow: 2` message) · 2 usage or unreadable input. */
export async function main(argv: string[], io: Io = STD_IO, exit: (code: number) => void = exitWhenFlushed): Promise<void> {
  try {
    if (argv.includes("--ingest")) {
      exit(runIngest(argv, io));
    } else if (argv.includes("--report")) {
      const t = (await loadThresholds(process.cwd())).values;
      exit(runReport(argv, { minFires: t.READER_FLOOR_MIN_FIRES, perFire: t.READER_FLOOR_FINDINGS_PER_FIRE }, io));
    } else {
      io.err(USAGE);
      exit(2);
    }
  } catch (e) {
    io.err(`reviewTelemetry: ${(e as Error).message}`);
    exit(e instanceof FlowChangedError ? 1 : 2);
  }
}

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2));
}
