/**
 * A finished run's record, for a mock's report: every node (ran, skipped and why, failed and why, or
 * never reached), every gate's decision, every data item (its producer, its readers, and whether it
 * reached each reader that ran), every check's answer, and each classifier's p beside its cut-off.
 * Pure: it reads the graph and the history.
 */

import type { Gate, GraphDef, NodeDef, NodeRun, RunHistory } from "../contracts.ts";
import { restartsNote } from "../schedule.ts";

export interface NodeLine {
  node: string;
  kind: NodeDef["kind"];
  runs: { at: string; status: NodeRun["status"]; answer?: string; p?: number; cutoff?: number; reason?: string; restarts?: number }[];
  /** `ran` when any run finished, else `failed`, `skipped`, or `not reached`. */
  verdict: "ran" | "failed" | "skipped" | "not reached";
}

export interface DataLine {
  id: string;
  producers: string[];
  readers: { node: string; optional: boolean; runs: number; got: number }[];
  /** Readers that ran at least once and never got it, though it was produced. */
  missed: string[];
  produced: boolean;
}

export interface RunRecord {
  phase: RunHistory["phase"];
  error?: string;
  nodes: NodeLine[];
  gates: { node: string; gate: string; decisions: string[] }[];
  data: DataLine[];
  checks: { node: string; runs: string[] }[];
  loops: RunHistory["loops"];
  questions: string[];
  counts: Record<NodeLine["verdict"], number>;
  /** Every node run by its status (a node in a loop or a fan-out runs more than once). */
  runCounts: Record<string, number>;
}

const at = (r: NodeRun): string => `${r.iteration > 0 ? `#${r.iteration}` : "-"}${r.instance === undefined ? "" : `@${r.instance}`}`;

export function gateText(g: Gate): string {
  if ("anyOf" in g) return `any of (${g.anyOf.map(gateText).join(", ")})`;
  if ("allOf" in g) return `all of (${g.allOf.map(gateText).join(", ")})`;
  if ("classifier" in g) return `${g.classifier} = ${g.answer}`;
  if ("loop" in g) return `loop ${g.loop} = ${g.answer}`;
  return `${g.on} = ${g.answer}`;
}

function verdictOf(runs: readonly NodeRun[]): NodeLine["verdict"] {
  if (runs.some((r) => r.status === "done")) return "ran";
  if (runs.some((r) => r.status === "failed")) return "failed";
  if (runs.some((r) => r.status === "skipped")) return "skipped";
  return "not reached";
}

/** How close a classifier's call was: its p, and the cut-off it was decided at when the record has it. */
function closeness(x: NodeLine["runs"][number]): string {
  if (x.p === undefined) return "";
  const p = Number(x.p.toFixed(3));
  return x.cutoff === undefined ? ` (p ${p})` : ` (p ${p}, cut-off ${x.cutoff})`;
}

export function runRecord(graph: GraphDef, h: RunHistory): RunRecord {
  const runsOf = (id: string) => h.nodes.filter((n) => n.node === id);
  const nodes: NodeLine[] = graph.nodes.map((n) => {
    const runs = runsOf(n.id);
    return {
      node: n.id,
      kind: n.kind,
      runs: runs.map((r) => ({
        at: at(r),
        status: r.status,
        ...(r.answer === undefined ? {} : { answer: r.answer }),
        ...(r.p === undefined ? {} : { p: r.p }),
        ...(r.cutoff === undefined ? {} : { cutoff: r.cutoff }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(r.restarts === undefined ? {} : { restarts: r.restarts }),
      })),
      verdict: verdictOf(runs),
    };
  });
  const gates = graph.nodes
    .filter((n) => n.gate !== undefined)
    .map((n) => ({
      node: n.id,
      gate: gateText(n.gate!),
      decisions: runsOf(n.id).map((r) => `${at(r)} ${r.status === "skipped" ? `closed: ${r.reason ?? ""}` : `open (${r.status})`}`),
    }));
  const data: DataLine[] = graph.data.map((d) => {
    const producers = [
      ...graph.nodes.filter((n) => n.outputs.includes(d.id)).map((n) => n.id),
      ...graph.loops.filter((l) => l.outcome === d.id).map((l) => `loop ${l.id}`),
      ...(graph.fanOuts ?? []).filter((f) => f.status === d.id).map((f) => `fan-out ${f.id}`),
    ];
    const readers = graph.nodes
      .filter((n) => n.inputs.includes(d.id) || (n.optionalInputs ?? []).includes(d.id))
      .map((n) => {
        const ran = runsOf(n.id).filter((r) => r.inputs !== undefined);
        return { node: n.id, optional: !n.inputs.includes(d.id), runs: ran.length, got: ran.filter((r) => r.inputs!.includes(d.id)).length };
      });
    const produced = h.data[d.id] !== undefined || producers.some((p) => runsOf(p).some((r) => r.status === "done"));
    return { id: d.id, producers, readers, missed: produced ? readers.filter((r) => r.runs > 0 && r.got === 0).map((r) => r.node) : [], produced };
  });
  const checks = graph.nodes
    .filter((n) => n.kind === "check")
    .map((n) => ({ node: n.id, runs: runsOf(n.id).map((r) => `${at(r)} ${r.status === "done" ? (r.answer ?? "done") : `${r.status}${r.reason === undefined ? "" : `: ${r.reason}`}`}`) }));
  const counts = { ran: 0, failed: 0, skipped: 0, "not reached": 0 };
  for (const n of nodes) counts[n.verdict]++;
  const runCounts: Record<string, number> = {};
  for (const r of h.nodes) runCounts[r.status] = (runCounts[r.status] ?? 0) + 1;
  const questions = (h.questions ?? []).map(
    (q) => `${q.from.node}${q.from.iteration > 0 ? `#${q.from.iteration}` : ""}${q.from.instance === undefined ? "" : `@${q.from.instance}`} asked ${q.question.id} (${q.question.type}) → ${q.route}${q.answer === undefined ? "" : `, answered by ${q.answer.by}${q.answer.brief_change === undefined ? "" : ", brief changed"}`}`
  );
  return { phase: h.phase, ...(h.error === undefined ? {} : { error: h.error }), nodes, gates, data, checks, loops: h.loops, questions, counts, runCounts };
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The record as Markdown. */
export function renderRecord(r: RunRecord): string {
  const out = [
    `phase: ${r.phase}${r.error === undefined ? "" : ` — ${cell(r.error)}`}`,
    `nodes: ${r.counts.ran} ran, ${r.counts.skipped} skipped, ${r.counts.failed} failed, ${r.counts["not reached"]} not reached (a node that ran once counts as ran)`,
    `node runs: ${Object.entries(r.runCounts).map(([k, n]) => `${n} ${k}`).join(", ")}`,
    `loops: ${r.loops.map((l) => `${l.loop} ${l.iterations} iterations, ${l.outcome ?? "unfinished"}`).join("; ") || "none"}`,
    "",
    "### Nodes",
    "",
    "| node | kind | verdict | runs |",
    "| --- | --- | --- | --- |",
    ...r.nodes.map((n) => `| ${n.node} | ${n.kind} | ${n.verdict} | ${cell(n.runs.map((x) => `${x.at} ${x.status}${x.answer === undefined ? "" : ` ${x.answer}`}${closeness(x)}${restartsNote(x.restarts)}${x.reason === undefined || x.status === "done" ? "" : `: ${x.reason}`}`).join("; "))} |`),
    "",
    "### Gates",
    "",
    "| node | gate | decisions |",
    "| --- | --- | --- |",
    ...r.gates.map((g) => `| ${g.node} | ${cell(g.gate)} | ${cell(g.decisions.join("; ") || "never reached")} |`),
    "",
    "### Data",
    "",
    "| item | producer | produced | readers (got/ran) | missed by |",
    "| --- | --- | --- | --- | --- |",
    ...r.data.map(
      (d) =>
        `| ${d.id} | ${d.producers.join(", ") || "(run input)"} | ${d.produced ? "yes" : "no"} | ${cell(d.readers.map((x) => `${x.node}${x.optional ? "?" : ""} ${x.got}/${x.runs}`).join(", ") || "none")} | ${d.missed.join(", ")} |`
    ),
    "",
    "### Checks",
    "",
    ...r.checks.map((c) => `- ${c.node}: ${cell(c.runs.join("; ") || "never reached")}`),
    "",
    "### Questions",
    "",
    ...(r.questions.length === 0 ? ["none"] : r.questions.map((q) => `- ${q}`)),
  ];
  return `${out.join("\n")}\n`;
}
