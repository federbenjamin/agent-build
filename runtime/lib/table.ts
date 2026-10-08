/**
 * The review table's pure core: one round of `table.json` from the round's input files. Which files
 * a round reads (`ROUND_INTAKE`), how a prior row routes on its fixer line and its stage answers, the
 * merge rule, the two kind rules, and the refusals all live here, so `reviewTable.ts build` only
 * gathers files and writes the result. Pure: callers pass text, nothing here reads a file or runs git.
 *
 * Every grammar is `./runFiles.ts`'s; this module never re-parses a file its own way.
 */

import { BEHAVIOR_MD_RES } from "../reviewLensSelect.ts";
import {
  type Advice,
  type DriftRound,
  driftGroupOf,
  driftRound,
  type FinalRound,
  type Finding,
  type FixFile,
  type FixLine,
  type FixRound,
  type GivenRow,
  type HandTestLine,
  isFixedAt,
  type Kind,
  KIND_RANK,
  KINDS,
  type Leftover,
  type Locator,
  normaliseLocator,
  parseFixFile,
  parseHandTestFile,
  parseReaderFile,
  parseSessionFile,
  parseStageFile,
  READER_ID_PREFIX,
  readerIdPrefix,
  type Round,
  type RoundId,
  roundOrder,
  type Row,
  type RowOrigin,
  type RowText,
  RunFileError,
  type Stage,
  type StageKey,
  stageKey,
  type StatusWord,
  splitFindingId,
  type TableJson,
} from "./runFiles.ts";

// ── Errors ───────────────────────────────────────────────────────────────────────────────────

/** Input the table cannot be built from: a prior round missing, a fix file missing or malformed.
 *  The CLI exits 2 on it and writes nothing. A reader file that fails its grammar is not this: it
 *  goes to the round's `refused` list and the rest of the round is built. */
export class TableInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableInputError";
  }
}

// ── What each round reads ────────────────────────────────────────────────────────────────────

/** Prior rows one round routes: the rows of round `from`, answered by `fix-<fix>.txt` and the stage
 *  folder `stage-<key>/` (`StageKey`). */
export interface Carry {
  from: RoundId;
  fix: FixRound;
  stage: StageKey;
}

export interface RoundIntake {
  /** Rounds that must already be in `table.json`. */
  needs: RoundId[];
  /** Round 1 reads the wave's reader files. */
  wave: boolean;
  carry: Carry[];
  /** Stage folders whose `## New` findings enter this round. */
  newStages: StageKey[];
  /** `session.md` blocks whose `stage:` is one of these enter this round. A `drift` block enters the
   *  first drift round built that no other drift round already holds it in. */
  sessionStages: Stage[];
  /** Reads every `hand-test-<n>.txt` no other round consumed. */
  handTests: boolean;
}

function carry(from: FixRound, stage: StageKey): Carry {
  return { from, fix: from, stage };
}

/** The drift rounds `table.json` holds, by group. */
export function driftRoundsIn(table: TableJson): DriftRound[] {
  return (Object.keys(table.rounds) as RoundId[])
    .filter((r): r is DriftRound => driftGroupOf(r) !== null)
    .sort(roundOrder) as DriftRound[];
}

/**
 * §1.7's intake table, with R.2 (`final` reads `session.md` stages `escalate` and `drift-confirm`).
 * Drift group `n` is round `drift-<n>`: it reads `stage-drift-<n>/`, and `final` carries every drift
 * round `table` holds, each answered by `fix-drift-<n>.txt` and `stage-drift-confirm-<n>/`.
 */
export function roundIntake(round: RoundId, table: TableJson): RoundIntake {
  const group = driftGroupOf(round);
  if (group !== null) {
    return {
      needs: group > 1 ? [driftRound(group - 1)] : [],
      wave: false,
      carry: [],
      newStages: [stageKey("drift", group)],
      sessionStages: ["drift"],
      handTests: false,
    };
  }
  switch (round) {
    case "1":
      return { needs: [], wave: true, carry: [], newStages: [], sessionStages: ["wave"], handTests: false };
    case "2":
    case "3":
    case "escalate": {
      const prior = round === "2" ? "1" : round === "3" ? "2" : "3";
      const stage = stageKey(round === "2" ? "confirm-1" : round === "3" ? "confirm-2" : "last");
      return { needs: [prior], wave: false, carry: [carry(prior, stage)], newStages: [stage], sessionStages: [stage.stage], handTests: true };
    }
    case "final": {
      const drifts = driftRoundsIn(table).map((d) => carry(d, stageKey("drift-confirm", driftGroupOf(d))));
      const escalate = carry("escalate", stageKey("escalate"));
      return {
        needs: ["1", "2", "3", "escalate"],
        wave: false,
        carry: [escalate, ...drifts],
        newStages: [escalate.stage, ...drifts.map((c) => c.stage)],
        sessionStages: ["escalate", "drift-confirm"],
        handTests: true,
      };
    }
  }
  throw new TableInputError(`not a round: ${round}`);
}

/** Every stage folder a round reads: its carries' folders and its new-finding folders. */
export function roundStages(round: RoundId, table: TableJson): StageKey[] {
  const i = roundIntake(round, table);
  const out = new Map<string, StageKey>();
  for (const s of [...i.carry.map((c) => c.stage), ...i.newStages]) out.set(s.key, s);
  return [...out.values()];
}

/** The carry a stage folder's `## Status` answers — the round whose rows its readers were given and
 *  the fix file that says what the fixer did to them. Null for `wave` and `drift-<n>` (no rows given). */
export function stageCarry(stage: StageKey): Carry | null {
  switch (stage.stage) {
    case "confirm-1":
      return carry("1", stage);
    case "confirm-2":
      return carry("2", stage);
    case "last":
      return carry("3", stage);
    case "escalate":
      return carry("escalate", stage);
    case "drift-confirm":
      return carry(driftRound(stage.group!), stage);
    default:
      return null;
  }
}

/** The kinds that become rows at a round; `null` for `final`, which has no fixer. */
function fixedKinds(round: RoundId): readonly Kind[] | null {
  return round === "final" ? null : KINDS.filter((k) => isFixedAt(k, round));
}

const URGENT: readonly Kind[] = ["behavior", "security", "missing"];

// ── Readers ──────────────────────────────────────────────────────────────────────────────────

/** Merge order: these readers first, in this order; then repo readers by name; then `SESSION`. */
const READER_ORDER = [
  "review-cursory",
  "review-cursory-codex",
  "gate-silent-failure-hunter",
  "security-review",
  "build-verifier",
  "simplifier",
];

/** At a stage, `review-cursory.md` is the Sonnet read that stood in for a failed Codex run, so it is
 *  given Codex's rows. */
const CODEX_ROLE = new Set(["review-cursory-codex", "review-cursory"]);

/**
 * The rows one reader must answer at a stage (§1.13 `dispatch`): for `review-cursory-codex` or its
 * Sonnet stand-in, every row the fixer marked `fixed`, `dropped`, or `relabel`; for another reader,
 * those of them holding one of its ids. A `decision` row is banked and never given; a `blocked` row
 * was not changed, so it is never given either and stays open.
 */
export function givenRows(rows: readonly Row[], fix: FixFile, reader: string): GivenRow[] {
  const prefix = READER_ID_PREFIX[reader];
  const out: GivenRow[] = [];
  for (const row of rows) {
    const line = fix.lines.find((l) => l.row === row.id);
    if (!line || line.action === "decision" || line.action === "blocked") continue;
    const ids = [row.id, ...row.also];
    if (!CODEX_ROLE.has(reader) && !ids.some((id) => splitFindingId(id).readerPrefix === prefix)) continue;
    out.push({ id: row.id, also: row.also, line: line.action });
  }
  return out;
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────

export interface InputFile {
  /** Relative to the run dir: `review-cursory.md`, `stage-confirm-1/review-cursory-codex.md`. */
  file: string;
  text: string;
}

export interface ReaderInput extends InputFile {
  /** From the file name (`readerFiles`, `./runDir.ts`). */
  reader: string;
  slice: number | null;
}

export interface StageInput {
  stage: StageKey;
  /** The stage folder exists. False means the read was not owed: a `fixed` row closes unasked. */
  ran: boolean;
  files: ReaderInput[];
}

export interface MergeLimits {
  /** `TABLE_MERGE_NEAR_LINES`. */
  near: number;
  /** `TABLE_MERGE_EXACT_ABOVE_LINES`. */
  exactAbove: number;
}

export interface RoundInputs {
  round: RoundId;
  head: string;
  /** `table.json` as it stands; `{ schema: 2, rounds: {} }` before round 1. */
  table: TableJson;
  /** Is a repo-relative path a target file? (`## Target files`; on `--from-branch`, every changed file.) */
  isTarget: (path: string) => boolean;
  /** Round 1: the wave's reader files, `session.md` excluded. */
  wave?: ReaderInput[];
  /** One entry per `roundStages(round, table)`. A stage with no entry did not run. */
  stages?: StageInput[];
  session?: InputFile | null;
  /** The fix files this round's carries name, keyed by their round. */
  fixes?: Partial<Record<FixRound, InputFile>>;
  /** Every `hand-test-<n>.txt` in the run dir; the round reads the ones no other round consumed. */
  handTests?: (InputFile & { n: number })[];
  merge: MergeLimits;
}

export interface RoundResult {
  table: TableJson;
  round: Round | FinalRound;
}

// ── Kind rules ───────────────────────────────────────────────────────────────────────────────

/**
 * The two kind rules the table applies so no agent has to (§1.2). A `dev-tool` or `test-tool`
 * finding whose every parsed locator is a target file is `behavior` or `test-app`. A `text` finding
 * on behaviour markdown (`BEHAVIOR_MD_RES`) is `behavior` when that path is a target, else `dev-tool`:
 * behaviour markdown is never text.
 */
export function applyKindRules(kind: Kind, locators: readonly Locator[], isTarget: (p: string) => boolean): Kind {
  const paths = locators.filter((l) => l.parsed).map((l) => cleanPath(l.path));
  if ((kind === "dev-tool" || kind === "test-tool") && paths.length > 0 && paths.every(isTarget)) {
    return kind === "dev-tool" ? "behavior" : "test-app";
  }
  if (kind === "text") {
    const md = paths.filter((p) => BEHAVIOR_MD_RES.some((re) => re.test(p)));
    if (md.length > 0) return md.some(isTarget) ? "behavior" : "dev-tool";
  }
  return kind;
}

// ── Merge ────────────────────────────────────────────────────────────────────────────────────

const cleanPath = (p: string): string => p.replace(/^\.\//, "");
const isWholeFile = (l: Locator): boolean => l.start === 0 && l.end === 0;

/** Two locators name one place: same path, and ranges that overlap or lie within `near` lines. A
 *  range longer than `exactAbove` lines, or a whole file, meets only its exact twin. */
export function locatorsMeet(a: Locator, b: Locator, lim: MergeLimits): boolean {
  if (!a.parsed || !b.parsed || cleanPath(a.path) !== cleanPath(b.path)) return false;
  const long = (l: Locator) => isWholeFile(l) || l.end - l.start + 1 > lim.exactAbove;
  if (long(a) || long(b)) return a.start === b.start && a.end === b.end;
  return Math.max(a.start, b.start) - Math.min(a.end, b.end) <= lim.near;
}

/** One finding at intake, in merge order. */
interface Candidate {
  finding: Finding;
  kind: Kind;
  origin: RowOrigin;
  /** Sort key: reader rank, reader name, slice, id number. */
  order: [number, string, number, number];
}

function readerRank(reader: string): number {
  if (reader === "session") return READER_ORDER.length + 1;
  const i = READER_ORDER.indexOf(reader);
  return i < 0 ? READER_ORDER.length : i;
}

function candidate(finding: Finding, reader: string, slice: number | null, origin: RowOrigin, isTarget: (p: string) => boolean): Candidate {
  return {
    finding,
    kind: applyKindRules(finding.kind, finding.locators, isTarget),
    origin,
    order: [readerRank(reader), reader, slice ?? 0, splitFindingId(finding.id).number],
  };
}

function compareOrder(a: Candidate, b: Candidate): number {
  for (let i = 0; i < 4; i++) {
    const x = a.order[i]!;
    const y = b.order[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function rowText(f: Finding): RowText {
  return {
    id: f.id,
    finding: `${f.title} — ${f.finding}`,
    after: f.after,
    ...(f.invariant === undefined ? {} : { invariant: f.invariant }),
    ...(f.vacuity === undefined ? {} : { vacuity: f.vacuity }),
  };
}

/**
 * Merge one round's new findings into rows (§1.7 merge rule). Two findings merge when some pair of
 * their parsed locators meets (`locatorsMeet`); merges are transitive; a `missing` finding and a
 * finding with no parsed locator never merge. The row's id is its first finding in merge order, its
 * kind the highest `KIND_RANK` (the first on a tie), and it keeps every finding's text.
 */
function mergeFindings(candidates: readonly Candidate[], lim: MergeLimits, enteredAt: RoundId): Row[] {
  const sorted = [...candidates].sort(compareOrder);
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const mergeable = (c: Candidate) => c.kind !== "missing";
  for (let i = 0; i < sorted.length; i++) {
    if (!mergeable(sorted[i]!)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      if (!mergeable(sorted[j]!)) continue;
      const meet = sorted[i]!.finding.locators.some((a) => sorted[j]!.finding.locators.some((b) => locatorsMeet(a, b, lim)));
      if (!meet) continue;
      const [ri, rj] = [find(i), find(j)];
      if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
    }
  }
  const groups = new Map<number, Candidate[]>();
  sorted.forEach((c, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), c]);
  });
  return [...groups.values()].map((group) => {
    let kind = group[0]!.kind;
    for (const c of group) if (KIND_RANK[c.kind] > KIND_RANK[kind]) kind = c.kind;
    const locators: Locator[] = [];
    for (const c of group) {
      for (const l of c.finding.locators) {
        if (!locators.some((x) => x.path === l.path && x.start === l.start && x.end === l.end && x.parsed === l.parsed)) {
          locators.push(l);
        }
      }
    }
    return {
      id: group[0]!.finding.id,
      also: group.slice(1).map((c) => c.finding.id),
      kind,
      locators,
      texts: group.map((c) => rowText(c.finding)),
      origin: group[0]!.origin,
      enteredAt,
      history: [],
    };
  });
}

// ── Routing a prior row ──────────────────────────────────────────────────────────────────────

interface Answer {
  reader: string;
  status: StatusWord;
  reason?: string;
}

/** R.16: when readers disagree about one row, `unresolved` beats `resolved` and `disagree` beats
 *  `agree`. Null when nobody answered. */
function combine(answers: readonly Answer[]): StatusWord | null {
  if (answers.length === 0) return null;
  const words = new Set(answers.map((a) => a.status));
  for (const w of ["unresolved", "disagree", "resolved", "agree"] as const) if (words.has(w)) return w;
  return null;
}

function fixLineText(fix: FixRound, l: FixLine): string {
  switch (l.action) {
    case "fixed":
      return `${fix}: fixed ${l.sha}${l.kind ? ` kind=${l.kind}` : ""} — ${l.what}`;
    case "dropped":
      return `${fix}: dropped — ${l.reason}`;
    case "relabel":
      return `${fix}: relabel ${l.from}→${l.to} — ${l.reason}`;
    case "decision":
      return `${fix}: decision — ${l.which} — ${l.question}`;
    case "blocked":
      return `${fix}: blocked — ${l.reason}`;
  }
}

function answersText(stage: string, ran: boolean, answers: readonly Answer[]): string {
  if (!ran) return `${stage}: not run`;
  if (answers.length === 0) return `${stage}: no answer`;
  return `${stage}: ${answers.map((a) => `${a.reader} ${a.status}${a.reason ? ` — ${a.reason}` : ""}`).join(", ")}`;
}

/** Where a prior row goes: closed, banked, or on with a kind (a row again, or a leftover, or open). */
type Route = { to: "closed" } | { to: "banked"; question: string } | { to: "on"; kind: Kind };

function higher(a: Kind, b: Kind): Kind {
  return KIND_RANK[b] >= KIND_RANK[a] ? b : a;
}

/**
 * One prior row at intake (§1.7 routing table). With no stage run, a `fixed` row closes and a
 * `dropped` or `relabel` row stands as agreed; the gate owes the read, so this only happens when it
 * was not owed. A stage that ran but left the row unanswered (its reader's file refused) counts as
 * `unresolved` / `disagree`. A `fixed · kind=` line routes by the higher of the old and new kinds, as
 * §1.2 settles two kinds for one row. A `relabel` the reader disagrees with keeps the row's own kind,
 * whatever old kind the fixer typed. A `blocked` row stays open with its kind: a row again when the
 * round fixes it, else a leftover, and at `final` in `open` when urgent. A `HAND` row closes only on
 * a later `pass` of its claim.
 */
function routeRow(row: Row, line: FixLine, ran: boolean, answers: readonly Answer[], handPass: boolean | null): Route {
  const said = combine(answers);
  const isHand = /^HAND\.\d+$/.test(row.id);
  switch (line.action) {
    case "decision":
      return { to: "banked", question: `${line.which} — ${line.question}` };
    case "blocked":
      return { to: "on", kind: row.kind };
    case "fixed": {
      if (isHand) return handPass === true ? { to: "closed" } : { to: "on", kind: row.kind };
      if (!ran || said === "resolved") return { to: "closed" };
      return { to: "on", kind: line.kind ? higher(row.kind, line.kind) : row.kind };
    }
    case "dropped":
      if (!ran || said === "agree") return { to: "closed" };
      return { to: "on", kind: row.kind };
    case "relabel":
      if (!ran || said === "agree") return { to: "on", kind: line.to };
      return { to: "on", kind: row.kind };
  }
}

// ── Prose drift ──────────────────────────────────────────────────────────────────────────────

/** A reader's `## Prose drift (advisory)` lines become `text` findings numbered after the reader's
 *  own, so the round-1 fixer corrects the stale prose and a stage read hands the row back to the
 *  reader that saw it. The label rules still apply: drift in behavior markdown is a `behavior` row. */
function driftFindings(advice: readonly Advice[], findings: readonly Finding[], prefix: string): Finding[] {
  let n = findings.reduce((max, f) => Math.max(max, splitFindingId(f.id).number), 0);
  return advice.map((a) => {
    const id = `${prefix}.${++n}`;
    return {
      id,
      title: `prose drift: ${a.locator || a.text}`,
      line: 0,
      locator: a.locator,
      locators: a.locator === "" ? [] : normaliseLocator(a.locator),
      kind: "text",
      finding: a.text,
      after: "the prose says what is true now",
    };
  });
}

// ── Hand tests ───────────────────────────────────────────────────────────────────────────────

function handRow(claim: string, fail: Extract<HandTestLine, { result: "fail" }>, file: string, enteredAt: RoundId): Row {
  const id = `HAND.${claim.slice(1)}`;
  return {
    id,
    also: [],
    kind: "behavior",
    locators: [],
    texts: [
      {
        id,
        finding: `hand test ${claim} failed (code) at ${fail.sha} — ${fail.differed}; output ${fail.output} (${file})`,
        after: `claim ${claim} passes when the hand tester re-runs it`,
      },
    ],
    origin: "hand-test",
    enteredAt,
    history: [],
  };
}

// ── Building one round ───────────────────────────────────────────────────────────────────────

function errorText(e: unknown): string {
  if (e instanceof RunFileError) return e.issues.map((i) => (i.line === undefined ? i.message : `line ${i.line}: ${i.message}`)).join("; ");
  return e instanceof Error ? e.message : String(e);
}

function consumedElsewhere(table: TableJson, round: RoundId): Set<string> {
  const out = new Set<string>();
  for (const [id, r] of Object.entries(table.rounds)) if (id !== round && r) for (const f of r.consumed) out.add(f);
  return out;
}

/**
 * Build round `inputs.round` and return `table.json` with that round's key set (every other round
 * kept). Throws `TableInputError` when a round it needs is missing or a fix file it needs is missing
 * or malformed. A reader, stage, session, or hand-test file that fails its grammar is left out and
 * listed in `refused`.
 */
export function buildRound(inputs: RoundInputs): RoundResult {
  const { round: roundId, table, isTarget, merge } = inputs;
  const intake = roundIntake(roundId, table);
  for (const need of intake.needs) {
    if (!table.rounds[need]) throw new TableInputError(`round ${roundId} needs round ${need} in table.json first`);
  }

  const consumed: string[] = [];
  const refused: { file: string; error: string }[] = [];
  const candidates: Candidate[] = [];
  const refuse = (file: string, e: unknown) => refused.push({ file, error: errorText(e) });
  // A finding id is one row's: a second file that uses an id another file already used is refused,
  // so one fix line and one status never answer two findings (slice k writes `<PREFIX>-<k>`).
  const idFile = new Map<string, string>();
  const clash = (file: string, findings: readonly Finding[]): boolean => {
    const hit = findings.find((x) => idFile.has(x.id));
    if (hit) {
      refuse(file, new Error(`finding ${hit.id} is also in ${idFile.get(hit.id)} — slice k from the second on writes <PREFIX>-<k>`));
      return true;
    }
    for (const x of findings) idFile.set(x.id, file);
    return false;
  };

  // The wave.
  for (const f of intake.wave ? (inputs.wave ?? []) : []) {
    try {
      const prefix = readerIdPrefix(f.reader, f.slice);
      const parsed = parseReaderFile(f.text, { stage: "wave", prefix });
      // A repo reader's prefix is its own: take it from its findings, or from its name when it
      // wrote none.
      const driftPrefix =
        prefix ?? (parsed.findings[0] ? splitFindingId(parsed.findings[0].id).prefix : f.reader.toUpperCase().replace(/[^A-Z0-9-]/g, "-"));
      const findings = [...parsed.findings, ...driftFindings(parsed.advice, parsed.findings, driftPrefix)];
      if (clash(f.file, findings)) continue;
      for (const finding of findings) candidates.push(candidate(finding, f.reader, f.slice, "reader", isTarget));
      consumed.push(f.file);
    } catch (e) {
      refuse(f.file, e);
    }
  }

  // The fix files each carry needs, parsed against the rows their fixer got.
  const fixFiles = new Map<FixRound, FixFile>();
  for (const c of intake.carry) {
    const prior = table.rounds[c.from];
    if (!prior || prior.rows.length === 0) continue;
    const input = inputs.fixes?.[c.fix];
    if (!input) {
      throw new TableInputError(
        `fix-${c.fix}.txt is missing: round ${c.from} has ${prior.rows.length} rows — a fixer that wrote nothing (a \`blocked:\` report) is re-spawned fresh from round ${c.from}'s head ${prior.head}; a row it cannot fix is a \`<ROW> · blocked — <evidence>\` line`
      );
    }
    try {
      fixFiles.set(c.fix, parseFixFile(input.text, { rows: prior.rows.map((r) => r.id), round: c.fix }));
    } catch (e) {
      throw new TableInputError(`${input.file}: ${errorText(e)}`);
    }
    consumed.push(input.file);
  }

  // Stage folders: each reader's answers to the rows it was given (keyed `<stage> <row>`), and its
  // new findings.
  const answers = new Map<string, Answer[]>();
  const ran = new Map<string, boolean>();
  for (const stage of roundStages(roundId, table)) {
    const input = inputs.stages?.find((s) => s.stage.key === stage.key);
    ran.set(stage.key, input?.ran ?? false);
    if (!input?.ran) continue;
    const carry = intake.carry.find((c) => c.stage.key === stage.key);
    const prior = carry ? table.rounds[carry.from] : undefined;
    const fix = carry ? fixFiles.get(carry.fix) : undefined;
    const takesNew = intake.newStages.some((s) => s.key === stage.key);
    for (const f of input.files) {
      const given = prior && fix ? givenRows(prior.rows, fix, f.reader) : [];
      try {
        const parsed = parseStageFile(f.text, {
          stage: stage.stage as Exclude<Stage, "wave">,
          given,
          reader: f.reader,
        });
        if (takesNew && clash(f.file, parsed.findings)) continue;
        for (const s of parsed.status) {
          const key = `${stage.key} ${s.row}`;
          answers.set(key, [...(answers.get(key) ?? []), { reader: f.reader, status: s.status, ...(s.reason ? { reason: s.reason } : {}) }]);
        }
        if (takesNew) for (const finding of parsed.findings) candidates.push(candidate(finding, f.reader, f.slice, "reader", isTarget));
        consumed.push(f.file);
      } catch (e) {
        refuse(f.file, e);
      }
    }
  }

  // session.md: the blocks whose stage feeds this round. A `drift` block another drift round holds
  // stays with that round.
  if (inputs.session) {
    try {
      const blocks = parseSessionFile(inputs.session.text);
      const heldByAnotherGroup = new Set<string>();
      if (driftGroupOf(roundId) !== null) {
        for (const d of driftRoundsIn(table)) if (d !== roundId) for (const id of heldIds(table.rounds[d]!)) heldByAnotherGroup.add(id);
      }
      for (const b of blocks) {
        if (!intake.sessionStages.includes(b.stage) || heldByAnotherGroup.has(b.id)) continue;
        candidates.push(candidate(b, "session", null, "session", isTarget));
      }
      consumed.push(inputs.session.file);
    } catch (e) {
      refuse(inputs.session.file, e);
    }
  }

  // Hand tests no other round consumed; the latest line per claim wins.
  const latest = new Map<string, { line: HandTestLine; file: string }>();
  if (intake.handTests) {
    const seen = consumedElsewhere(table, roundId);
    for (const f of [...(inputs.handTests ?? [])].sort((a, b) => a.n - b.n)) {
      if (seen.has(f.file)) continue;
      try {
        for (const line of parseHandTestFile(f.text)) latest.set(line.claim, { line, file: f.file });
        consumed.push(f.file);
      } catch (e) {
        refuse(f.file, e);
      }
    }
  }

  // Route the prior rows.
  const kinds = fixedKinds(roundId);
  const rows: Row[] = [];
  const leftovers: Leftover[] = [];
  const banked: { id: string; question: string }[] = [];
  const closed: string[] = [];
  const open: { id: string; kind: Kind }[] = [];
  const place = (row: Row, reason: string) => {
    if (kinds === null) {
      if (URGENT.includes(row.kind)) open.push({ id: row.id, kind: row.kind });
      else leftovers.push({ row, reason });
    } else if (kinds.includes(row.kind)) rows.push(row);
    else leftovers.push({ row, reason });
  };
  const notFixed = (kind: Kind) => (roundId === "final" ? `kind ${kind} is not fixed after the last round` : `kind ${kind} is not fixed at round ${roundId}`);

  const handled = new Set<string>();
  for (const c of intake.carry) {
    const prior = table.rounds[c.from];
    const fix = fixFiles.get(c.fix);
    if (!prior || !fix) continue;
    for (const row of prior.rows) {
      const line = fix.lines.find((l) => l.row === row.id)!;
      const rowAnswers = answers.get(`${c.stage.key} ${row.id}`) ?? [];
      const hand = /^HAND\.\d+$/.test(row.id) ? latest.get(`H${row.id.slice(5)}`) : undefined;
      if (hand) handled.add(hand.line.claim);
      const handPass = hand ? hand.line.result === "pass" : null;
      const stageRan = ran.get(c.stage.key) ?? false;
      const route = routeRow(row, line, stageRan, rowAnswers, handPass);
      const history = [fixLineText(c.fix, line), answersText(c.stage.key, stageRan, rowAnswers)];
      if (hand) history.push(`${hand.file}: ${hand.line.claim} ${hand.line.result === "pass" ? "pass" : `fail (${hand.line.cause})`}`);
      const carried: Row = { ...row, history: [...row.history, history.join("; ")] };
      if (route.to === "closed") closed.push(row.id);
      else if (route.to === "banked") banked.push({ id: row.id, question: route.question });
      else place({ ...carried, kind: route.kind }, notFixed(route.kind));
    }
  }

  // New findings, merged with each other and never with prior rows.
  for (const row of mergeFindings(candidates, merge, roundId)) place(row, notFixed(row.kind));

  // A hand-test `fail (code)` with no row routed above is a new `HAND` row.
  for (const [claim, { line, file }] of latest) {
    if (handled.has(claim) || line.result !== "fail" || line.cause !== "code") continue;
    place(handRow(claim, line, file, roundId), notFixed("behavior"));
  }

  const base: Round = { head: inputs.head, rows, leftovers, banked, closed, consumed, refused };
  let built: Round | FinalRound = base;
  if (roundId === "final") {
    const gathered: Leftover[] = [];
    const gatheredBanked: { id: string; question: string }[] = [];
    const earlier = (Object.keys(table.rounds) as RoundId[]).filter((id) => id !== "final").sort(roundOrder);
    for (const id of earlier) {
      gathered.push(...(table.rounds[id]?.leftovers ?? []));
      gatheredBanked.push(...(table.rounds[id]?.banked ?? []));
    }
    built = { ...base, rows: [], leftovers: [...gathered, ...leftovers], banked: [...gatheredBanked, ...banked], open };
  }
  return { table: { schema: 2, rounds: { ...table.rounds, [roundId]: built } }, round: built };
}

/** Every finding id a round holds: its rows' ids and `also`, and its leftover rows'. */
export function heldIds(round: Round): string[] {
  const rows = [...round.rows, ...round.leftovers.flatMap((l) => (l.row ? [l.row] : []))];
  return rows.flatMap((r) => [r.id, ...r.also]);
}

// ── What the CLI prints and writes ───────────────────────────────────────────────────────────

/** `path:start-end`; a whole file as `path (whole file)`; an unparsed locator as its raw text. */
export function formatLocator(l: Locator): string {
  if (!l.parsed) return `${l.path} (unparsed)`;
  if (isWholeFile(l)) return `${l.path} (whole file)`;
  return `${l.path}:${l.start}-${l.end}`;
}

/** The `build` summary: `round <r> · head <sha> · rows <n> (<kind> <k>, …) · leftovers <n> ·
 *  banked <n>`, one `refused:` line per refused file, and for `final` the `open:` line. */
export function summaryLines(roundId: RoundId, round: Round | FinalRound): string[] {
  const counts = KINDS.map((k) => [k, round.rows.filter((r) => r.kind === k).length] as const).filter(([, n]) => n > 0);
  const rows = counts.length === 0 ? `rows ${round.rows.length}` : `rows ${round.rows.length} (${counts.map(([k, n]) => `${k} ${n}`).join(", ")})`;
  const out = [`round ${roundId} · head ${round.head} · ${rows} · leftovers ${round.leftovers.length} · banked ${round.banked.length}`];
  for (const r of round.refused) out.push(`refused: ${r.file} — ${r.error}`);
  if ("open" in round) {
    out.push(`open: ${round.open.length === 0 ? "none" : round.open.map((o) => `${o.id} ${o.kind}`).join(", ")}`);
  }
  return out;
}

/** `table-<round>.md`, the fixer's view of the round's rows. */
export function renderRoundTable(roundId: Exclude<RoundId, "final">, round: Round): string {
  const out = [
    `# Fix table — round ${roundId}`,
    "",
    `head ${round.head} · ${round.rows.length} rows. Write one line per row in fix-${roundId}.txt.`,
  ];
  if (round.rows.length === 0) out.push("", "No rows: this round has no fixer.");
  for (const row of round.rows) {
    out.push("", `## ${row.id} · ${row.kind}`, "");
    if (row.also.length > 0) out.push(`- also: ${row.also.join(", ")}`);
    out.push(`- origin: ${row.origin}, entered at round ${row.enteredAt}`);
    out.push(`- locators: ${row.locators.length === 0 ? "none" : row.locators.map(formatLocator).join(", ")}`);
    for (const t of row.texts) {
      out.push(`- ${t.id}: ${t.finding}`, `  - after: ${t.after}`);
      if (t.invariant !== undefined) out.push(`  - invariant: ${t.invariant}`);
      if (t.vacuity !== undefined) out.push(`  - vacuity: ${t.vacuity}`);
    }
    for (const h of row.history) out.push(`- history: ${h}`);
  }
  return `${out.join("\n")}\n`;
}

/** §1.7's leftovers list, one line per `final.leftovers` entry, ready for the standing ticket. */
export function leftoverLines(final: FinalRound, runId: string): string[] {
  return final.leftovers.map((l) => {
    if (l.row) {
      const loc = l.row.locators[0];
      const where = loc === undefined ? "(no locator)" : loc.parsed && !isWholeFile(loc) && loc.start === loc.end ? `${loc.path}:${loc.start}` : formatLocator(loc);
      const t = l.row.texts[0]!;
      return `- ${runId} · ${l.row.id} · ${l.row.kind} · ${where} — ${t.finding} (after: ${t.after})`;
    }
    return `- ${runId} · advice · ${l.advice!.locator || "(no locator)"} — ${l.advice!.text}`;
  });
}
