/**
 * K-output-format: the runner's check of every agent's outputs against the grammar its format names (the
 * table library's parsers, the brief's), and the source of the questions those outputs raise: a
 * `questions.json` an agent wrote, and each `decision` line of a fixer's fix file.
 */

import { basename, dirname, join } from "node:path";

import { type BriefSummary, matchesTarget, ownedFiles, summariseBrief } from "../../../runtime/lib/brief.ts";
import {
  isFixRound,
  parseFindingBlock,
  parseHandTestFile,
  parseReaderFile,
  parseStageFile,
  readerIdPrefix,
  type Stage,
} from "../../../runtime/lib/runFiles.ts";
import { DECISION_WHICH, parseFixFile } from "../../../runtime/lib/fixFile.ts";
import { givenRows } from "../../../runtime/lib/table.ts";
import { OUTPUT_SIDE_FILES, QUESTIONS_FILE } from "../../constants.ts";
import { parseQuestions, type Question, type QuestionType } from "../../contracts.ts";
import type { CheckRequest, CheckResult } from "../../adapters/types.ts";
import { exists, fileNamed, filesOf, readJsonFile, readText } from "./common.ts";
import { DRAFT_FILE, type DraftFile, LINKS_FILE, parseLinks, PLAN_FILE, sliceOf, type SlicePlan } from "./slices.ts";
import { confirmStage, tableJsonOf, tableStateOf } from "./table.ts";
import { changedFiles } from "../../worktree.ts";

/** A reader file's reader and slice, from its name: `review-2.md` → review, 2. */
export function readerOfFile(file: string): { reader: string; slice: number | null } {
  const m = /^(.+?)(?:-(\d+))?\.md$/.exec(basename(file));
  if (m === null) return { reader: basename(file), slice: null };
  return { reader: m[1]!, slice: m[2] === undefined ? null : Number(m[2]) };
}

type Validate = (files: string[], req: CheckRequest) => { problems: string[]; questions: Question[] };

const ok = (): { problems: string[]; questions: Question[] } => ({ problems: [], questions: [] });

function each(files: string[], pick: (f: string) => boolean, fn: (f: string) => void): string[] {
  const problems: string[] = [];
  const picked = files.filter(pick);
  if (picked.length === 0) problems.push(`no file to check among ${files.map((f) => basename(f)).join(", ") || "(none)"}`);
  for (const f of picked) {
    try {
      fn(f);
    } catch (e) {
      problems.push(`${basename(f)}: ${(e as Error).message}`);
    }
  }
  return problems;
}

const md = (f: string) => f.endsWith(".md");

const findings: Validate = (files) => ({
  problems: each(files, md, (f) => {
    const { reader, slice } = readerOfFile(f);
    parseReaderFile(readText(f), { stage: "wave", prefix: readerIdPrefix(reader, slice) });
  }),
  questions: [],
});

/** A stage file answers exactly the rows its reader was given (the fixed round's rows the fix file
 *  marked fixed, dropped or relabelled). */
const stage: Validate = (files, req) => {
  const table = req.subjectInputs?.table;
  const fix = filesOf(req.subjectInputs?.["fix-file"]).find((f) => f.endsWith(".txt"));
  if (table === undefined || fix === undefined) return { problems: ["a stage read needs the table and the fix file among its inputs"], questions: [] };
  const state = tableStateOf(table);
  if (state.round === null) return { problems: ["the table has built no round"], questions: [] };
  const round = tableJsonOf(table).rounds[state.round]!;
  const fixFile = parseFixFile(readText(fix), { rows: round.rows.map((r) => r.id) });
  const key = confirmStage(state.round);
  return {
    problems: each(files, md, (f) => {
      const { reader } = readerOfFile(f);
      parseStageFile(readText(f), { stage: key.stage as Exclude<Stage, "wave">, given: givenRows(round.rows, fixFile, reader), reader });
    }),
    questions: [],
  };
};

/** A fix file has one line per row of its slice (`sliceOf` the slice plan, by the fixer's item; the
 *  whole round when the fixer reads no plan); each `decision` line is a question. */
const fixFile: Validate = (files, req) => {
  const table = req.subjectInputs?.table;
  if (table === undefined) return { problems: ["a fix file needs the table among the fixer's inputs"], questions: [] };
  const state = tableStateOf(table);
  const planFile = fileNamed(req.subjectInputs?.["slice-plan"], PLAN_FILE);
  let rows = state.rows.map((r) => r.id);
  if (planFile !== undefined) {
    try {
      rows = sliceOf(readJsonFile(planFile) as SlicePlan, req.subject?.instance).rows;
    } catch (e) {
      return { problems: [(e as Error).message], questions: [] };
    }
  }
  const questions: Question[] = [];
  const problems = each(
    files,
    (f) => f.endsWith(".txt"),
    (f) => {
      const parsed = parseFixFile(readText(f), { rows, ...(state.round === null || !isFixRound(state.round) ? {} : { round: state.round }) });
      for (const l of parsed.lines) {
        if (l.action !== "decision") continue;
        const type: QuestionType = (DECISION_WHICH as readonly string[]).includes(l.which) ? (l.which as QuestionType) : "product";
        questions.push({ id: l.row, type, text: l.question, searched: [] });
      }
    }
  );
  return { problems, questions };
};

/** The slicer's links (`parseLinks`), each end a draft slice of the round. */
const links: Validate = (files, req) => {
  const draftFile = fileNamed(req.subjectInputs?.["draft-slices"], DRAFT_FILE);
  const ids = draftFile === undefined ? null : new Set((readJsonFile(draftFile) as DraftFile).slices.map((s) => s.id));
  return {
    problems: each(files, (f) => basename(f) === LINKS_FILE, (f) => {
      const unknown = parseLinks(readJsonFile(f), LINKS_FILE).flatMap((l) => [l.from, l.to]).filter((id) => ids !== null && !ids.has(id));
      if (unknown.length > 0) throw new Error(`no draft slice ${[...new Set(unknown)].join(", ")}`);
    }),
    questions: [],
  };
};

/** A hand-test file's lines, and each output file it names, relative to the file's folder. */
const handTest: Validate = (files) => ({
  problems: each(
    files,
    (f) => /hand-test-\d+\.txt$/.test(f),
    (f) => {
      for (const l of parseHandTestFile(readText(f))) {
        if (!exists(join(dirname(f), l.output))) throw new Error(`${l.claim}: no output file ${l.output}`);
      }
    }
  ),
  questions: [],
});

const builderReport: Validate = (files) => ({
  problems: [
    ...each(files, (f) => basename(f) === "report.md", (f) => {
      if (readText(f).trim() === "") throw new Error("empty");
    }),
    ...files.filter((f) => basename(f) === "candidates.md").flatMap((f) => {
      try {
        parseFindingBlock(readText(f));
        return [];
      } catch (e) {
        return [`candidates.md: ${(e as Error).message}`];
      }
    }),
  ],
  questions: [],
});

/** The files a writer's commit changed (`changedFiles`, in the run tree, which the commit has not been
 *  merged into yet); null when no commit is among its outputs. */
function commitChanges(req: CheckRequest): string[] | null {
  const ref = Object.entries(req.inputs).find(([id, v]) => v.schema === "ref" && req.formats[id] === undefined)?.[1];
  if (ref?.schema !== "ref") return null;
  return changedFiles(req.place.worktree, ref.id);
}

/** What a writer's commit changed (`commitChanges`), with the brief and the fan-out item it was run for. */
function subjectChange(req: CheckRequest, who: string, item: "part" | "slice"): { summary: BriefSummary; item: string; changed: string[] } | { problems: string[] } {
  const id = req.subject?.instance;
  const briefMd = filesOf(req.subjectInputs?.brief).find(md);
  const changed = id === undefined || briefMd === undefined ? null : commitChanges(req);
  if (changed === null || id === undefined || briefMd === undefined) return { problems: [`${who} needs its commit, its ${item} and the brief`] };
  return { summary: summariseBrief(readText(briefMd)), item: id, changed };
}

/**
 * A builder's commits touch no file another part lists (builder.md §Your lane: such an edit is a
 * STOP, never a silent change; a file no part lists is an allowed out-of-lane fix). A file both parts
 * list (ordered parts may share one) is its own.
 */
export function foreignPartPaths(req: CheckRequest): string[] {
  const c = subjectChange(req, "a builder's check", "part");
  if ("problems" in c) return c.problems;
  const own = ownedFiles(c.summary, c.item);
  if (own === null) return [`part ${c.item} is not in the brief`];
  const problems: string[] = [];
  for (const other of c.summary.parts.filter((p) => p.id !== c.item)) {
    const theirs = c.changed.filter((f) => !matchesTarget(f, own) && matchesTarget(f, ownedFiles(c.summary, other.id)!));
    if (theirs.length > 0) problems.push(`part ${c.item}'s commit touches ${theirs.join(", ")}, which part ${other.id} lists: a STOP, not an edit`);
  }
  return problems;
}

/** A test writer's commit, authoring or verifying, touches only its slice's own files (write-tests.md
 *  §Your slice is exclusive: a test that needs any other change is a STOP). */
export function outsideSlicePaths(req: CheckRequest): string[] {
  const c = subjectChange(req, "a test writer's check", "slice");
  if ("problems" in c) return c.problems;
  const own = c.summary.slices.find((w) => w.id === c.item)?.files;
  if (own === undefined) return [`slice ${c.item} is not in the brief`];
  const outside = c.changed.filter((f) => !matchesTarget(f, own));
  return outside.length === 0 ? [] : [`slice ${c.item}'s commit touches ${outside.join(", ")}, which its slice does not list: a STOP, not an edit`];
}

/** The lane check of a writer's commit, by the format of its report. A fixer's is D-merge-slice's. */
const LANES: Record<string, (req: CheckRequest) => string[]> = { "builder-report": foreignPartPaths, tests: outsideSlicePaths };

const brief: Validate = (files) => ({ problems: each(files, md, (f) => void summariseBrief(readText(f))), questions: [] });

const nonEmpty: Validate = (files) => ({
  problems: each(files, () => true, (f) => {
    if (readText(f).trim() === "") throw new Error("empty");
  }),
  questions: [],
});

const VALIDATORS: Record<string, Validate> = {
  findings,
  stage,
  "fix-file": fixFile,
  links,
  "hand-test": handTest,
  "builder-report": builderReport,
  tests: nonEmpty,
  brief,
  "prior-art": nonEmpty,
  "risk-moment": nonEmpty,
};

/** K-output-format's check of one agent run: every formatted output against its grammar, plus questions. */
export async function schemaCheck(req: CheckRequest): Promise<CheckResult> {
  const problems: string[] = [];
  const questions: Question[] = [];
  const asked = new Set<string>();
  for (const [id, value] of Object.entries(req.inputs)) {
    const qf = filesOf(value).find((f) => basename(f) === QUESTIONS_FILE);
    if (qf === undefined) continue;
    try {
      const parsed = parseQuestions(readJsonFile(qf), `${id}/${QUESTIONS_FILE}`);
      if (parsed.length > 0) asked.add(id);
      questions.push(...parsed);
    } catch (e) {
      problems.push(`${id}: ${(e as Error).message}`);
    }
  }
  for (const [id, value] of Object.entries(req.inputs)) {
    const format = req.formats[id];
    if (format === undefined) continue;
    problems.push(...(LANES[format]?.(req) ?? []));
    const files = filesOf(value).filter((f) => !OUTPUT_SIDE_FILES.includes(basename(f)));
    // An agent that stopped on its questions (a STOP, a blocked fixer) wrote only questions.json:
    // they are read above and routed, and the engine runs it again on their answers.
    if (files.length === 0 && asked.has(id)) continue;
    const v = VALIDATORS[format] ?? ok;
    const r = v(files, req);
    problems.push(...r.problems.map((p) => `${id} (${format}): ${p}`));
    questions.push(...r.questions);
  }
  // A fixer's product decision is in its fix file and, with what it searched, in questions.json: the
  // questions.json one wins.
  const seen = new Set<string>();
  const unique = questions.filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)));
  const who = req.subject === undefined ? "?" : `${req.subject.node}${req.subject.iteration > 0 ? `#${req.subject.iteration}` : ""}`;
  return problems.length > 0
    ? { answer: "fail", detail: `${who}: ${problems.join("; ")}` }
    : { answer: "pass", detail: `${who}: every output parses${unique.length > 0 ? `; ${unique.length} questions` : ""}`, questions: unique };
}
