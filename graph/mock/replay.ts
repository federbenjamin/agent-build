/**
 * The stub agent for a mock whose classifiers are real (`mock.ts --real-classifiers`). The recorded
 * run had its own reader set; real classifiers pick another, so the replay has to bend in two places:
 *
 * - **An output the recorded run never wrote** (a reader it did not run, a fixer round it did not
 *   make) is written as "no findings" in its format: a reader file that says `NO FINDINGS`, a stage
 *   file that marks every given row resolved or agreed, a fix file that marks every row of its slice
 *   `blocked`, no links, an answer with no brief change, an empty hand-test file, or a note. A writer
 *   applies no commits.
 * - **A recorded fix file** names rows of readers the classifiers skipped, and misses rows those
 *   readers' rows had absorbed. Its lines for rows not in the round's table are dropped. A row with no
 *   line takes the line of a dropped row whose text names it (the recorded fixer handled it there),
 *   else `dropped`, saying so.
 * - **A recorded stage read** (a confirm or re-read) may now be given a row it never saw: it gets a
 *   status line saying so, `resolved` for a fixed row, `agree` for a dropped or relabelled one.
 *
 * Every line or file it writes says `mock replay`, so the run's record shows what the recording did
 * not hold. Nothing here runs outside a mock.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { blockedFixFile, parseFixFile } from "../../runtime/lib/fixFile.ts";
import { givenRows } from "../../runtime/lib/table.ts";
import { filesUnder } from "../adapters/agentIo.ts";
import { stubAgent } from "../adapters/stubAgent.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "../adapters/types.ts";
import { ContractError, type StubAgentBinding } from "../contracts.ts";
import { graph } from "../pipelines/build.ts";
import { fileNamed, filesOf } from "../pipelines/build/common.ts";
import { LINKS_FILE, PLAN_FILE, sliceOf, type SlicePlan } from "../pipelines/build/slices.ts";
import { tableJsonOf, tableStateOf } from "../pipelines/build/table.ts";

const NOTE = "mock replay";

const formatOf = (id: string): string | undefined => graph.data.find((d) => d.id === id)?.format;

/** Is `e` the stub's "the recording holds no output here"? */
const noRecording = (e: unknown): boolean => e instanceof ContractError && /no fixture folder|is keyed and has no @/.test(e.message);

/** The fixer's round and the ids of its rows: its slice's, by its item, when it reads a slice plan. */
function roundRows(req: AgentRequest): { round: string; ids: string[] } {
  const state = tableStateOf(req.inputs.table);
  const plan = fileNamed(req.inputs["slice-plan"], PLAN_FILE);
  const ids = plan === undefined ? state.rows.map((r) => r.id) : sliceOf(JSON.parse(readFileSync(plan, "utf8")) as SlicePlan, req.instance).rows;
  return { round: state.round ?? "?", ids };
}

/**
 * A recorded fix file fitted to the round's table: lines for rows not in it dropped; a row with no
 * line takes the line of a dropped row whose text names it, else `dropped`. Returns the text and what
 * it changed, one entry per row.
 */
export function fitFixFile(text: string, rows: readonly string[]): { text: string; changes: string[] } {
  const lines = text.split("\n");
  const exitAt = lines.findIndex((l) => /^exit checks:\s*$/.test(l.trim()));
  const body = exitAt < 0 ? lines : lines.slice(0, exitAt);
  const tail = exitAt < 0 ? [] : lines.slice(exitAt);
  const rowOf = (l: string): string | null => /^(\S+)\s+·\s+/.exec(l)?.[1] ?? null;
  const kept: string[] = [];
  const dropped = new Map<string, string>();
  for (const l of body) {
    const row = rowOf(l);
    if (row === null) continue;
    if (rows.includes(row)) kept.push(l);
    else dropped.set(row, l);
  }
  const changes = [...dropped.keys()].map((r) => `${r}: line dropped, not a row of this round's table`);
  const named = new Set(kept.map(rowOf));
  for (const row of rows) {
    if (named.has(row)) continue;
    const host = [...dropped.entries()].find(([, l]) => new RegExp(`\\b${row.replace(".", "\\.")}\\b`).test(l));
    if (host !== undefined) {
      kept.push(`${row}${host[1].slice(host[0].length)}`);
      changes.push(`${row}: takes ${host[0]}'s line, which names it`);
    } else {
      kept.push(`${row} · dropped — ${NOTE}: the recorded fixer answered this row inside a row of a reader the classifiers skipped (${[...dropped.keys()].join(", ") || "none"})`);
      changes.push(`${row}: dropped, no recorded line names it`);
    }
  }
  return { text: [...kept, "", ...tail].join("\n").replace(/\n{3,}/g, "\n\n"), changes };
}

/** The rows a stage read of `reader` is given: the fixed round's rows its fix file marked fixed,
 *  dropped or relabelled, as the schema check computes them. */
function givenTo(req: AgentRequest, reader: string, why: string) {
  const fix = filesOf(req.inputs["fix-file"]).find((f) => f.endsWith(".txt"));
  const table = req.inputs.table;
  if (fix === undefined || table === undefined) throw new Error(`${why}, and a stage read needs the table and the fix file`);
  const state = tableStateOf(table);
  const round = tableJsonOf(table).rounds[state.round!]!;
  return givenRows(round.rows, parseFixFile(readFileSync(fix, "utf8"), { rows: round.rows.map((r) => r.id) }), reader);
}

const statusLine = (g: { id: string; line?: string }, why: string): string => `- ${g.id} · ${g.line === "fixed" ? "resolved" : "agree"} — ${why}`;

/** A recorded stage file fitted to the rows its read is given now: a given row it does not answer
 *  gets a status line saying so. */
export function fitStageFile(text: string, given: readonly { id: string; also?: readonly string[]; line?: string }[]): { text: string; added: string[] } {
  const lines = text.split("\n");
  const statusAt = lines.findIndex((l) => /^##\s+Status\s*$/.test(l));
  const newAt = lines.findIndex((l) => /^##\s+New\s*$/.test(l));
  if (statusAt < 0 || newAt < statusAt) return { text, added: [] };
  const answered = lines.slice(statusAt + 1, newAt).join("\n");
  const missing = given.filter((g) => ![g.id, ...(g.also ?? [])].some((id) => new RegExp(`^-\\s+${id.replace(".", "\\.")}\\b`, "m").test(answered)));
  if (missing.length === 0) return { text, added: [] };
  const why = `${NOTE}: the recorded read was not given this row`;
  const head = lines.slice(0, newAt).filter((l, i) => !(i > statusAt && /^-\s+none\s*$/i.test(l)));
  while (head.length > 0 && head[head.length - 1]!.trim() === "") head.pop();
  return { text: [...head, ...missing.map((g) => statusLine(g, why)), "", ...lines.slice(newAt)].join("\n"), added: missing.map((g) => g.id) };
}

/** The "no findings" stand-in for output `id` of a run the recording does not hold. */
function standIn(req: AgentRequest, id: string): Record<string, string> {
  const why = `${NOTE}: the recorded run has no ${req.role} output here`;
  switch (formatOf(id)) {
    case "findings":
      return { [`${req.role}.md`]: `NO FINDINGS — ${why}.\n` };
    case "stage": {
      const status = givenTo(req, req.role, why).map((g) => statusLine(g, why));
      return { [`${req.role}.md`]: ["## Status", "", ...(status.length > 0 ? status : ["- none"]), "", "## New", "", "NO FINDINGS", ""].join("\n") };
    }
    case "fix-file": {
      const { round, ids } = roundRows(req);
      return { [`fix-${round}.txt`]: blockedFixFile(ids, why, `${NOTE}: no recorded fixer output`) };
    }
    case "links":
      return { [LINKS_FILE]: `${JSON.stringify({ links: [] })}\n` };
    case "answer":
      return { "answer.json": `${JSON.stringify({ answer: `${why}: no recorded answer to this question`, source: "brief", searched: [{ source: "brief", said: why }] }, null, 2)}\n` };
    case "hand-test":
      return { [`hand-test-${req.iteration + 1}.txt`]: "" };
    default:
      return { [`${req.role}.md`]: `${why}.\n` };
  }
}

function write(dir: string, files: Record<string, string>): string[] {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return filesUnder(dir);
}

/** The stub agent (the binding's `replay` names this module), each output run on its own so one
 *  missing recording does not lose the others; a writer's commits are applied with its first. */
export function replayAgent(binding: StubAgentBinding): AgentRunner {
  const { replay: _, ...plain } = binding;
  const stub = stubAgent(plain);
  return {
    async run(req: AgentRequest): Promise<AgentResult> {
      const files: Record<string, string[]> = {};
      for (const id of req.outputs) {
        const { commits, ...rest } = req;
        const one: AgentRequest = { ...rest, outputs: [id], ...(commits !== undefined && id === req.outputs[0] ? { commits } : {}) };
        try {
          const r = await stub.run(one);
          if (r.status !== "done") return r;
          files[id] = r.files[id]!;
        } catch (e) {
          if (!noRecording(e)) throw e;
          files[id] = write(join(req.outDir, id), standIn(req, id));
          appendFileSync(join(req.outDir, "mock-replay.txt"), `${id}: no recorded output, the stand-in written\n`);
        }
        if (formatOf(id) === "stage") {
          for (const f of files[id]!.filter((p) => p.endsWith(".md"))) {
            const reader = basename(f).replace(/(-\d+)?\.md$/, "");
            const fitted = fitStageFile(readFileSync(f, "utf8"), givenTo(req, reader, `${NOTE}: ${req.role}`));
            if (fitted.added.length > 0) {
              writeFileSync(f, fitted.text);
              appendFileSync(join(req.outDir, "mock-replay.txt"), `${fitted.added.map((r) => `${r}: status added, the recorded read was not given it`).join("\n")}\n`);
            }
          }
        }
        if (formatOf(id) === "fix-file" && req.inputs.table !== undefined) {
          const f = files[id]!.find((p) => /fix-\d+\.txt$/.test(basename(p)));
          if (f !== undefined) {
            const fitted = fitFixFile(readFileSync(f, "utf8"), roundRows(req).ids);
            writeFileSync(f, fitted.text);
            if (fitted.changes.length > 0) appendFileSync(join(req.outDir, "mock-replay.txt"), `${fitted.changes.join("\n")}\n`);
            files[id] = filesUnder(join(req.outDir, id));
          }
        }
      }
      return { status: "done", files };
    },
  };
}
