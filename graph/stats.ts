/**
 * `build-graph stats`: what the recorded runs say, as numbers to tune by. Per node, how long its
 * attempts took against its cap; per classifier, how often it fired and how its p stood against the
 * labels its readers' rows give it; per run, its wall time, cost and writer restarts; the struggles agents report
 * again and again; and the messages fixers logged sending their peers. Pure: `runDirs.ts` reads the run dirs (`RunData`) and the caller prints the text.
 *
 * A label is computed here, never written, from the routing the table recorded. A gated reader's
 * decision is labelled when its reader ran: 1 when the reader left a wave row whose kind is urgent
 * (`URGENT_KINDS`) in the last round the table holds it (a leftover counts), or that the fixer fixed
 * with an urgent `kind=` and the table closed (`fixedAsKinds`), and that the table did not close as
 * dropped with an agree (`droppedAndAgreed`), else 0. A decision that failed open has none. A decision
 * outside a loop reads the reader's rows that entered at round 1; one at a close-loop iteration reads
 * the rows its reader raised at the confirm stage of the round that iteration's fixer took (ids in
 * that stage's range, entered at the round that took the stage in), and is 1 as well when its reader
 * reported a row that fixer marked fixed as still `unresolved` and the table carried the row on with
 * an urgent kind. So C-review-fix is labelled by the confirm read's new urgent rows and the urgent
 * fixes it sent back. A decision at a close-loop iteration is counted in the population of that
 * iteration's fix round: single-slice or multi-slice, by the items the fixer's fan-out ran over at that
 * iteration (`history.fanOuts`); with no such record it is counted in neither.
 */

import {
  type FixRound,
  type Kind,
  READER_ID_PREFIX,
  type RoundId,
  roundOrder,
  splitFindingId,
  stageIdRange,
  type TableJson,
  URGENT_KINDS,
} from "../runtime/lib/runFiles.ts";
import { type FixFile } from "../runtime/lib/fixFile.ts";
import { droppedAndAgreed, fixedAsKinds } from "../runtime/lib/table.ts";
import { CLASSIFIER_YES, STRUGGLE_MIN_RUNS } from "./constants.ts";
import type { AttemptRecord, GraphDef, NodeRun, RunHistory, RunKind } from "./contracts.ts";
import { gateLeaves } from "./define.ts";
import { FIXER_NODE } from "./pipelines/build.ts";
import { parseCrosstalk } from "./pipelines/build/slices.ts";
import { confirmStage, type FixReadStatus } from "./pipelines/build/table.ts";
import { localAbortMs } from "./schedule.ts";

/** One run dir as the caller read it. `key` is the node run's folder (`nodes/<node>/<iteration>[/<item>]`). */
export interface RunData {
  name: string;
  graph: GraphDef | null;
  history: RunHistory | null;
  attempts: { key: string; record: AttemptRecord }[];
  /** The final table (D-final-table's, else the last D-build-fix-table's). */
  table: TableJson | null;
  /** The mirrored fix files, by round. */
  fixes: ReadonlyMap<FixRound, FixFile>;
  /** The status lines the fix reads the table took in gave each fix round's rows, by round. */
  fixReads: ReadonlyMap<FixRound, FixReadStatus[]>;
  /** The round the table handed its fixer at each close-loop iteration, by iteration. */
  fixerRounds: ReadonlyMap<number, RoundId>;
  /** Each `struggles.json` as parsed, by the node run that wrote it: every attempt's, earlier attempts first. */
  struggles: { key: string; file: string; raw: unknown }[];
  /** Each `crosstalk.jsonl` as text, by the node run that wrote it: every attempt's, earlier attempts first. */
  crosstalk: { key: string; file: string; text: string }[];
  /** What the caller could not read, one line each. */
  problems: string[];
}

export interface NodeStats {
  node: string;
  capMs: number | null;
  attempts: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  /** The cap less the longest attempt. */
  marginMs: number | null;
  /** Attempts aborted at the local abort (the cap less the teardown budget) or later. */
  capHits: number;
  /** Attempts that started and never ended here. */
  lost: number;
  /** Fresh runs given to this node after its commit's merge conflicted (`restartsByNode`). */
  restarts: number;
}

export interface ClassifierStats {
  node: string;
  /** The fix rounds' population the row counts (`slicePopulation`); null for decisions with none. */
  population: Population | null;
  decisions: number;
  fired: number;
  explored: number;
  errors: number;
  labelled: number;
  positive: number;
  meanPPositive: number | null;
  meanPNegative: number | null;
}

export interface RunStats {
  run: string;
  kind: RunKind | "unknown";
  phase: string;
  wallMs: number | null;
  costUsd: number;
  /** Some agent attempt reported no cost (Codex, or a CLI that printed nothing): the cost is a floor. */
  costIsFloor: boolean;
  /** Fresh runs given to its writers after their commits' merges conflicted (`restartsByNode`). */
  restarts: number;
}

export interface Fingerprint {
  fingerprint: string;
  runs: string[];
}

/** A message a fixer logged sending a peer: where it was sent from (the fix round its iteration took,
 *  the iteration when no round is recorded for it, the slice), the peer's item and the first line of the
 *  text. With no attempt record for its node run, only `nodeRun` says where. */
export interface CrosstalkLine {
  run: string;
  nodeRun: string;
  iteration: number | null;
  round: RoundId | null;
  slice: string | null;
  to: string;
  firstLine: string;
}

export interface StatsReport {
  /** The kind the aggregates are over: real runs when there are any, else mock runs. */
  kind: RunKind | null;
  counted: number;
  leftOut: number;
  runs: RunStats[];
  nodes: NodeStats[];
  classifiers: ClassifierStats[];
  struggles: Fingerprint[];
  crosstalk: CrosstalkLine[];
  problems: string[];
}

const ms = (a: string, b: string): number => Date.parse(b) - Date.parse(a);

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

const graphOf = (r: RunData): GraphDef | null => r.graph ?? r.history?.graph ?? null;

/** The fresh runs a writer was given after its merge conflicted, by node: one per node run and
 *  `conflict.restart` (a fresh run's retries and schema reruns share its number). */
function restartsByNode(r: RunData): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const { key, record } of r.attempts) {
    const n = record.conflict?.restart;
    if (n === undefined || seen.has(`${key}\0${n}`)) continue;
    seen.add(`${key}\0${n}`);
    out.set(record.node, (out.get(record.node) ?? 0) + 1);
  }
  return out;
}

function runStats(r: RunData): RunStats {
  const starts = r.attempts.map((a) => Date.parse(a.record.startedAt));
  const ends = r.attempts.flatMap((a) => (a.record.endedAt === undefined ? [] : [Date.parse(a.record.endedAt)]));
  const agents = r.attempts.filter((a) => a.record.costUsd !== undefined || a.record.tokens !== undefined || a.record.model !== undefined);
  return {
    run: r.history?.runId ?? r.name,
    kind: r.history?.runKind ?? "unknown",
    phase: r.history?.phase ?? "unrecorded",
    wallMs: starts.length === 0 || ends.length === 0 ? null : Math.max(...ends) - Math.min(...starts),
    costUsd: agents.reduce((sum, a) => sum + (a.record.costUsd ?? 0), 0),
    costIsFloor: agents.some((a) => a.record.costUsd === null),
    restarts: [...restartsByNode(r).values()].reduce((a, b) => a + b, 0),
  };
}

function nodeStats(runs: RunData[]): NodeStats[] {
  const by = new Map<string, { capMs: number | null; durations: number[]; capHits: number; lost: number; restarts: number }>();
  for (const r of runs) {
    const graph = graphOf(r);
    for (const { record } of r.attempts) {
      const capMs = graph?.nodes.find((n) => n.id === record.node)?.timeCapMs ?? null;
      const s = by.get(record.node) ?? { capMs, durations: [], capHits: 0, lost: 0, restarts: 0 };
      by.set(record.node, s);
      if (record.endedAt === undefined) {
        s.lost++;
        continue;
      }
      const d = ms(record.startedAt, record.endedAt);
      s.durations.push(d);
      if (record.outcome === "aborted" && capMs !== null && d >= localAbortMs(capMs)) s.capHits++;
    }
    for (const [node, n] of restartsByNode(r)) by.get(node)!.restarts += n;
  }
  return [...by.entries()]
    .map(([node, s]) => {
      const sorted = [...s.durations].sort((a, b) => a - b);
      const maxMs = sorted.at(-1) ?? 0;
      return {
        node,
        capMs: s.capMs,
        attempts: s.durations.length + s.lost,
        p50Ms: quantile(sorted, 0.5),
        p90Ms: quantile(sorted, 0.9),
        maxMs,
        marginMs: s.capMs === null || sorted.length === 0 ? null : s.capMs - maxMs,
        capHits: s.capHits,
        lost: s.lost,
        restarts: s.restarts,
      };
    })
    .sort((a, b) => a.node.localeCompare(b.node));
}

/** Each reader a classifier gates (`{ classifier, answer: yes }`), with its role and id prefix, by
 *  classifier node. */
function gatedPrefixes(graph: GraphDef): Map<string, { reader: string; role: string; prefix: string }[]> {
  const out = new Map<string, { reader: string; role: string; prefix: string }[]>();
  for (const n of graph.nodes) {
    if (n.kind !== "agent" || n.gate === undefined) continue;
    const prefix = READER_ID_PREFIX[n.role];
    if (prefix === undefined) continue;
    for (const leaf of gateLeaves(n.gate)) {
      if (!("classifier" in leaf) || leaf.answer !== CLASSIFIER_YES) continue;
      out.set(leaf.classifier, [...(out.get(leaf.classifier) ?? []), { reader: n.id, role: n.role, prefix }]);
    }
  }
  return out;
}

/** The finding ids (each row's id and its `also`) of every counted reader row that entered at round
 *  `entered`: its kind, where the table last holds it as a row or a leftover, is urgent, and the table
 *  did not close it as dropped with an agree. A fixed row the table closed counts at the higher of its
 *  kind and the fixer's `kind=`, as one the read left open does. (A row `final` leaves open was an
 *  urgent row of the round before.) `final` holds the urgent rows it takes in only in `open`, as ids,
 *  so at `final` every open id counts; one carried there from an earlier round keeps an id of an
 *  earlier stage's range. */
function countedIds(table: TableJson, fixes: RunData["fixes"], entered: RoundId): Set<string> {
  const last = new Map<string, { kind: Kind; ids: string[] }>();
  for (const id of (Object.keys(table.rounds) as RoundId[]).sort(roundOrder)) {
    const round = table.rounds[id];
    if (round === undefined) continue;
    for (const row of [...round.rows, ...round.leftovers.flatMap((l) => (l.row === undefined ? [] : [l.row]))]) {
      if (row.origin === "reader" && row.enteredAt === entered) last.set(row.id, { kind: row.kind, ids: [row.id, ...row.also] });
    }
  }
  const gone = droppedAndAgreed(table, fixes);
  const raised = fixedAsKinds(table, fixes);
  const out = new Set<string>();
  for (const [id, row] of last) {
    if (gone.has(id) || !URGENT_KINDS.includes(raised.get(id) ?? row.kind)) continue;
    for (const x of row.ids) out.add(x);
  }
  const final = table.rounds.final;
  if (entered === "final" && final !== undefined && "open" in final) for (const o of final.open) out.add(o.id);
  return out;
}

/** The kind round `round` carries row `id` on with: as a row, a leftover, or (at `final`) open. */
function carriedKind(round: TableJson["rounds"][RoundId], id: string): Kind | undefined {
  if (round === undefined) return undefined;
  const held = [...round.rows, ...round.leftovers.flatMap((l) => (l.row === undefined ? [] : [l.row]))].find((x) => x.id === id);
  return held?.kind ?? ("open" in round ? round.open.find((o) => o.id === id)?.kind : undefined);
}

/** Whether a reader of `roles` reported a row round `fixed`'s fixer marked fixed as still
 *  `unresolved`, in a file the table took in, and round `entered` carried that row on with an urgent
 *  kind (the higher of its own and the fixer's `kind=`, as the table routes it). */
function leftUnresolved(r: RunData, table: TableJson, fixed: FixRound, entered: RoundId, roles: ReadonlySet<string>): boolean {
  const lines = r.fixes.get(fixed)?.lines ?? [];
  return (r.fixReads.get(fixed) ?? []).some((s) => {
    if (s.status !== "unresolved" || !roles.has(s.reader)) return false;
    if (lines.find((l) => l.row === s.row)?.action !== "fixed") return false;
    const kind = carriedKind(table.rounds[entered], s.row);
    return kind !== undefined && URGENT_KINDS.includes(kind);
  });
}

/** Where a decision's gated reader left its rows: outside a loop, every id that entered at round 1;
 *  at a close-loop iteration, the ids in the id range of the confirm stage of the round that
 *  iteration's fixer took (`fixed`), entered at the round whose `consumed` names that stage's folder.
 *  Null when no fixer round is known for the iteration or no round took its confirm stage in. */
function readOf(r: RunData, table: TableJson, iteration: number): { fixed: FixRound | null; entered: RoundId; holds: (n: number) => boolean } | null {
  if (iteration === 0) return { fixed: null, entered: "1", holds: () => true };
  const fixed = r.fixerRounds.get(iteration);
  if (fixed === undefined || fixed === "final") return null;
  const stage = confirmStage(fixed);
  const entered = (Object.keys(table.rounds) as RoundId[]).find((id) => table.rounds[id]!.consumed.some((f) => f.startsWith(`${stage.folder}/`)));
  if (entered === undefined) return null;
  const { min, max } = stageIdRange(stage.stage);
  return { fixed, entered, holds: (n) => n >= min && n <= max };
}

export type Population = "single-slice" | "multi-slice";

/** A fix round's population for C-review-fix's labels, from the number of fixer slices the round ran:
 *  a cut-off fitted on one population does not carry to the other. */
export function slicePopulation(slices: number): Population {
  return slices > 1 ? "multi-slice" : "single-slice";
}

/** The population of a decision at `iteration`: from the run of the fan-out holding the fixer at that
 *  close-loop iteration; null outside a loop or with no such run recorded. */
function populationAt(h: RunHistory, iteration: number): Population | null {
  if (iteration === 0) return null;
  const fan = (h.graph.fanOuts ?? []).find((f) => f.nodes.includes(FIXER_NODE));
  const ran = fan === undefined ? undefined : (h.fanOuts ?? []).find((x) => x.fanOut === fan.id && x.iteration === iteration);
  return ran === undefined ? null : slicePopulation(ran.items.length);
}

interface Decision {
  node: string;
  population: Population | null;
  p: number;
  fired: boolean;
  explored: boolean;
  error: boolean;
  label: 0 | 1 | null;
}

function decisionsOf(r: RunData): Decision[] {
  const h = r.history;
  if (h === null) return [];
  const gated = gatedPrefixes(h.graph);
  const ranReader = (reader: string, iteration: number): boolean => h.nodes.some((n) => n.node === reader && n.iteration === iteration && n.status === "done");
  const labelOf = (table: TableJson, iteration: number, readers: readonly { role: string; prefix: string }[]): 0 | 1 | null => {
    const read = readOf(r, table, iteration);
    if (read === null) return null;
    const prefixes = new Set(readers.map((x) => x.prefix));
    const left = [...countedIds(table, r.fixes, read.entered)].map(splitFindingId);
    if (left.some((x) => prefixes.has(x.readerPrefix) && read.holds(x.number))) return 1;
    return read.fixed !== null && leftUnresolved(r, table, read.fixed, read.entered, new Set(readers.map((x) => x.role))) ? 1 : 0;
  };
  return h.nodes
    .filter((n): n is NodeRun & { answer: string; p: number } => h.graph.nodes.find((g) => g.id === n.node)?.kind === "classifier" && n.status === "done" && n.answer !== undefined && n.p !== undefined)
    .map((n) => {
      const readers = gated.get(n.node) ?? [];
      const error = n.error !== undefined;
      const ran = readers.filter((x) => ranReader(x.reader, n.iteration));
      const label = error || r.table === null || ran.length === 0 ? null : labelOf(r.table, n.iteration, ran);
      return { node: n.node, population: populationAt(h, n.iteration), p: n.p, fired: n.answer === CLASSIFIER_YES, explored: n.explored === true, error, label };
    });
}

function classifierStats(runs: RunData[]): ClassifierStats[] {
  const all = runs.flatMap(decisionsOf);
  const order = (p: Population | null): number => (p === null ? 0 : p === "single-slice" ? 1 : 2);
  const groups = [...new Map(all.map((d) => [`${d.node}\0${d.population}`, { node: d.node, population: d.population }])).values()].sort(
    (a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : order(a.population) - order(b.population))
  );
  return groups.map(({ node, population }) => {
    const ds = all.filter((d) => d.node === node && d.population === population);
    const labelled = ds.filter((d) => d.label !== null);
    return {
      node,
      population,
      decisions: ds.length,
      fired: ds.filter((d) => d.fired).length,
      explored: ds.filter((d) => d.explored).length,
      errors: ds.filter((d) => d.error).length,
      labelled: labelled.length,
      positive: labelled.filter((d) => d.label === 1).length,
      meanPPositive: mean(labelled.filter((d) => d.label === 1).map((d) => d.p)),
      meanPNegative: mean(labelled.filter((d) => d.label === 0).map((d) => d.p)),
    };
  });
}

const oneLine = (s: string): string => s.split("\n")[0]!.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.;:,]+$/, "");

/** The struggles of every node run whose last attempt ended, as fingerprints (category, the file or
 *  check, the one-line cause) with the runs each came up in; a malformed entry is a problem line. */
function struggleFingerprints(runs: RunData[], problems: string[]): Fingerprint[] {
  const seen = new Map<string, Set<string>>();
  for (const r of runs) {
    const run = r.history?.runId ?? r.name;
    for (const s of r.struggles) {
      const last = r.attempts.filter((a) => a.key === s.key).sort((a, b) => a.record.rerun - b.record.rerun || a.record.attempt - b.record.attempt).at(-1);
      if (last?.record.endedAt === undefined) continue;
      if (!Array.isArray(s.raw)) {
        problems.push(`${run}: ${s.file} is not a list; dropped`);
        continue;
      }
      s.raw.forEach((e: unknown, i) => {
        const o = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
        const [category, where, needed] = [o.category, o.where, o.needed];
        if (typeof category !== "string" || typeof where !== "string" || typeof needed !== "string" || category.trim() === "" || needed.trim() === "") {
          problems.push(`${run}: ${s.file} entry ${i + 1} lacks a category, where or needed; dropped`);
          return;
        }
        const fp = `${oneLine(category)} · ${where.trim()} · ${oneLine(needed)}`;
        seen.set(fp, (seen.get(fp) ?? new Set()).add(run));
      });
    }
  }
  return [...seen.entries()]
    .filter(([, rs]) => rs.size >= STRUGGLE_MIN_RUNS)
    .map(([fingerprint, rs]) => ({ fingerprint, runs: [...rs].sort() }))
    .sort((a, b) => b.runs.length - a.runs.length || a.fingerprint.localeCompare(b.fingerprint));
}

/** Every message the runs' fixers logged, in the order each file holds them; a bad line is a problem line. */
function crosstalkLines(runs: RunData[], problems: string[]): CrosstalkLine[] {
  return runs.flatMap((r) => {
    const run = r.history?.runId ?? r.name;
    return r.crosstalk.flatMap((c) => {
      const parsed = parseCrosstalk(c.text, c.file);
      problems.push(...parsed.problems.map((p) => `${run}: ${p}`));
      const record = r.attempts.find((a) => a.key === c.key)?.record;
      const iteration = record?.iteration ?? null;
      return parsed.messages.map((m) => ({
        run,
        nodeRun: c.key,
        iteration,
        round: iteration === null ? null : (r.fixerRounds.get(iteration) ?? null),
        slice: record?.instance ?? null,
        to: m.to,
        firstLine: m.text.split("\n")[0]!.trim(),
      }));
    });
  });
}

export function statsReport(runs: RunData[]): StatsReport {
  const kindOf = (r: RunData): RunKind | null => r.history?.runKind ?? null;
  const kind: RunKind | null = runs.some((r) => kindOf(r) === "real") ? "real" : runs.length > 0 ? "mock" : null;
  const counted = runs.filter((r) => (kind === "real" ? kindOf(r) === "real" : kindOf(r) !== "real"));
  const problems = runs.flatMap((r) => r.problems.map((p) => `${r.name}: ${p}`));
  return {
    kind,
    counted: counted.length,
    leftOut: runs.length - counted.length,
    runs: counted.map(runStats),
    nodes: nodeStats(counted),
    classifiers: classifierStats(counted),
    struggles: struggleFingerprints(counted, problems),
    crosstalk: crosstalkLines(counted, problems),
    problems,
  };
}

const min = (v: number): string => (Math.abs(v) < 60_000 ? `${Math.round(v / 1000)}s` : `${(v / 60_000).toFixed(1)}m`);
const pRound = (v: number | null): string => (v === null ? "-" : v.toFixed(2));

export function formatStats(s: StatsReport): string {
  if (s.kind === null) return "no runs\n";
  const lines = [`${s.counted} ${s.kind} run${s.counted === 1 ? "" : "s"}${s.leftOut > 0 ? ` (${s.leftOut} of the other kind left out)` : ""}`, "", "runs (wall, cost: Claude at list price, Codex unpriced, restarts)"];
  for (const r of s.runs) {
    lines.push(`  ${r.run}  ${r.kind}  ${r.phase}  ${r.wallMs === null ? "-" : min(r.wallMs)}  $${r.costUsd.toFixed(2)}${r.costIsFloor ? " or more" : ""}  ${r.restarts}`);
  }
  lines.push("", "nodes (attempts, p50, p90, max, cap, margin, cap hits, lost, restarts)");
  for (const n of s.nodes) {
    lines.push(`  ${n.node}  ${n.attempts}  ${min(n.p50Ms)}  ${min(n.p90Ms)}  ${min(n.maxMs)}  ${n.capMs === null ? "-" : min(n.capMs)}  ${n.marginMs === null ? "-" : min(n.marginMs)}  ${n.capHits}  ${n.lost}  ${n.restarts}`);
  }
  lines.push("", "classifiers (decisions, fired, explored, errors; labelled, positive, mean p of positives and negatives)");
  for (const c of s.classifiers) {
    lines.push(
      `  ${c.node}${c.population === null ? "" : ` (${c.population})`}  ${c.decisions}  ${c.fired}  ${c.explored}  ${c.errors};  ${c.labelled}  ${c.positive}  ${pRound(c.meanPPositive)}  ${pRound(c.meanPNegative)}`
    );
  }
  lines.push("", `struggles seen in ${STRUGGLE_MIN_RUNS} or more runs`);
  if (s.struggles.length === 0) lines.push("  none");
  for (const f of s.struggles) lines.push(`  ${f.runs.length}  ${f.fingerprint}`);
  lines.push("", "crosstalk (run, fix round, slice, to, first line)");
  if (s.crosstalk.length === 0) lines.push("  none");
  for (const c of s.crosstalk) {
    const from = c.round !== null ? `round ${c.round}` : c.iteration !== null ? `iteration ${c.iteration}` : c.nodeRun;
    lines.push(`  ${c.run}  ${from}  ${c.slice ?? "-"}  -> ${c.to}  ${c.firstLine}`);
  }
  if (s.problems.length > 0) lines.push("", "not read", ...s.problems.map((p) => `  ${p}`));
  return `${lines.join("\n")}\n`;
}
