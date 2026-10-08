/**
 * The run dir's file grammars, one owner for each: the finding block and its locator, `session.md`,
 * the stage file (`stage-<stage>/<reader>.md`), the fix file (`fix-<round>.txt`), the hand-test file
 * (`hand-test-<n>.txt`), and `table.json`. The ledger lives in `./ledger.ts`; which files in a run
 * dir are reader files lives in `./runDir.ts`. Pure: callers pass text, nothing here reads a file.
 *
 * Every parser throws a `RunFileError` holding every problem it found, each with its line, so the
 * table script's `check` can print them all and a reader can fix its file in one pass.
 */

import { Shape, type ShapeIssue } from "./shape.ts";

// ── Errors ───────────────────────────────────────────────────────────────────────────────────

export type RunFileIssue = ShapeIssue;

export class RunFileError extends Error {
  readonly issues: readonly RunFileIssue[];
  constructor(issues: readonly RunFileIssue[]) {
    super(issues.map(formatIssue).join("\n"));
    this.name = "RunFileError";
    this.issues = issues;
  }
}

function formatIssue(i: RunFileIssue): string {
  return i.line === undefined ? i.message : `line ${i.line}: ${i.message}`;
}

function throwIfAny(issues: RunFileIssue[]): void {
  if (issues.length > 0) throw new RunFileError(issues);
}

// ── Kinds, stages, rounds ────────────────────────────────────────────────────────────────────

export const KINDS = [
  "behavior",
  "security",
  "missing",
  "structure",
  "test-app",
  "test-tool",
  "dev-tool",
  "text",
] as const;
export type Kind = (typeof KINDS)[number];

/** Higher wins when two readers give one row different kinds; equal rank keeps the first. */
export const KIND_RANK: Readonly<Record<Kind, number>> = {
  security: 5,
  missing: 4,
  behavior: 3,
  structure: 2,
  "test-app": 2,
  "test-tool": 1,
  "dev-tool": 1,
  text: 1,
};

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

/** The rounds a fixer runs, by name. `drift` names every drift group's round: group `n` is round
 *  `drift-<n>` (`DriftRound`), so a second group never overwrites the first. `final` is a table
 *  round with no fixer. */
export const FIX_ROUNDS = ["1", "2", "3", "escalate", "drift"] as const;
export type FixRoundName = (typeof FIX_ROUNDS)[number];

/** Drift group `n`'s round, `n` ≥ 1. */
export type DriftRound = `drift-${number}`;
export type FixRound = Exclude<FixRoundName, "drift"> | DriftRound;
export type RoundId = FixRound | "final";

/** The rounds that are not a drift group's, in build order. */
export const FIXED_ROUND_IDS = ["1", "2", "3", "escalate"] as const;

const DRIFT_ROUND_RE = /^drift-([1-9]\d*)$/;

export function driftRound(group: number): DriftRound {
  return `drift-${group}`;
}

/** The drift group a round id belongs to, or null for a round that is not a drift group's. */
export function driftGroupOf(round: string): number | null {
  const m = DRIFT_ROUND_RE.exec(round);
  return m ? Number(m[1]) : null;
}

export function isRoundId(value: string): value is RoundId {
  return (FIXED_ROUND_IDS as readonly string[]).includes(value) || value === "final" || driftGroupOf(value) !== null;
}

export function isFixRound(value: string): value is FixRound {
  return isRoundId(value) && value !== "final";
}

/** A fix round's name: `drift` for every drift group's round. */
export function fixRoundName(round: FixRound): FixRoundName {
  return driftGroupOf(round) !== null ? "drift" : (round as FixRoundName);
}

/** Round ids in build order: 1, 2, 3, escalate, drift-1, drift-2, …, final. */
export function roundOrder(a: RoundId, b: RoundId): number {
  const rank = (r: RoundId): number => {
    const g = driftGroupOf(r);
    if (g !== null) return 10 + g;
    return r === "final" ? Number.MAX_SAFE_INTEGER : (FIXED_ROUND_IDS as readonly string[]).indexOf(r);
  };
  return rank(a) - rank(b);
}

const URGENT: readonly Kind[] = ["behavior", "security", "missing"];

/** The kinds each fix round fixes; every other kind goes to the leftovers at that round. */
export const STAGES_FIXING: Readonly<Record<FixRoundName, readonly Kind[]>> = {
  "1": KINDS,
  "2": [...URGENT, "structure", "test-app"],
  "3": URGENT,
  escalate: URGENT,
  drift: URGENT,
};

export function isFixedAt(kind: Kind, round: FixRound): boolean {
  return STAGES_FIXING[fixRoundName(round)].includes(kind);
}

/** The reads. A finding raised at a stage takes an id number in `stageIdRange(stage)`. */
export const STAGES = [
  "wave",
  "confirm-1",
  "confirm-2",
  "last",
  "escalate",
  "drift",
  "drift-confirm",
] as const;
export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/** `wave` 0–99, `confirm-1` 100–199, … `drift-confirm` 600–699. */
export function stageIdRange(stage: Stage): { min: number; max: number } {
  const index = STAGES.indexOf(stage);
  return { min: 100 * index, max: 100 * index + 99 };
}

/** The stage a `session.md` block names — every stage, so no SESSION block is dropped unread. */
export const SESSION_STAGES: readonly Stage[] = STAGES;

/**
 * A stage folder's key: the stage's name, except that each drift group reads into its own folders,
 * `drift-<n>` and `drift-confirm-<n>`. The folder is `stage-<key>`.
 */
export interface StageKey {
  stage: Stage;
  /** The drift group, for `drift` and `drift-confirm`; null for every other stage. */
  group: number | null;
  key: string;
  folder: string;
}

export function stageKey(stage: Stage, group: number | null = null): StageKey {
  const isDrift = stage === "drift" || stage === "drift-confirm";
  if (isDrift && group === null) throw new Error(`stage ${stage} needs its drift group: ${stage}-<n>`);
  if (!isDrift && group !== null) throw new Error(`stage ${stage} has no drift group`);
  const key = group === null ? stage : `${stage}-${group}`;
  return { stage, group, key, folder: `stage-${key}` };
}

/** `confirm-1` → confirm-1; `drift-2` → drift, group 2; `drift-confirm-2` → drift-confirm, group 2.
 *  Null for anything else, and for a bare `drift` or `drift-confirm` (a folder needs its group). */
export function parseStageKey(key: string): StageKey | null {
  const m = /^(drift|drift-confirm)-([1-9]\d*)$/.exec(key);
  if (m) return stageKey(m[1] as Stage, Number(m[2]));
  if (!isStage(key) || key === "wave" || key === "drift" || key === "drift-confirm") return null;
  return stageKey(key);
}

// ── Finding ids ──────────────────────────────────────────────────────────────────────────────

const ID_SRC = "[A-Z][A-Z0-9-]*\\.\\d+";
const ID_RE = new RegExp(`^${ID_SRC}$`);

/** `CURSORY-2.3` → prefix `CURSORY-2`, reader prefix `CURSORY`, slice 2, number 3. Slice `k` of a
 *  split read writes `<PREFIX>-<k>`, so two slices never collide and both map to one reader. */
export function splitFindingId(id: string): {
  prefix: string;
  readerPrefix: string;
  slice?: number;
  number: number;
} {
  const dot = id.lastIndexOf(".");
  const prefix = id.slice(0, dot);
  const number = Number(id.slice(dot + 1));
  const slice = /^(.+)-(\d+)$/.exec(prefix);
  return slice
    ? { prefix, readerPrefix: slice[1]!, slice: Number(slice[2]), number }
    : { prefix, readerPrefix: prefix, number };
}

export function isFindingId(value: string): boolean {
  return ID_RE.test(value);
}

/** Each global reader's id prefix — the one table CLOSE §The readers → Id prefixes prints and each
 *  reader's agent file names. The table gives a stage row back to the reader whose prefix it holds,
 *  so a reader writing another prefix never re-reads its own rows. A repo reader's prefix is its own
 *  and is never given rows at a stage (repo readers read the wave only). */
export const READER_ID_PREFIX: Readonly<Record<string, string>> = {
  "review-cursory": "CURSORY",
  "review-cursory-codex": "CODEX",
  "gate-silent-failure-hunter": "HUNTER",
  "security-review": "SEC",
  "build-verifier": "VERIFIER",
  simplifier: "SIMP",
};

/** The prefix a global reader's file must use: its own, with `-<k>` for slice `k` from the second
 *  on. Null for a repo reader, whose prefix is its own. */
export function readerIdPrefix(reader: string, slice: number | null = null): string | null {
  const prefix = READER_ID_PREFIX[reader];
  if (prefix === undefined) return null;
  return slice !== null && slice >= 2 ? `${prefix}-${slice}` : prefix;
}

// ── Locator ──────────────────────────────────────────────────────────────────────────────────

/** `start`/`end` 0 = the whole file. An unparsed locator keeps the raw text as `path` and never
 *  merges. */
export interface Locator {
  path: string;
  start: number;
  end: number;
  parsed: boolean;
}

const PATH_CHARS = "[\\w@.~+$/\\[\\]-]";
const LINE_LOC_RE = new RegExp(`(${PATH_CHARS}*):(\\d+)(?:\\s*[-–]\\s*(\\d+))?`, "g");
const PATH_TOKEN_RE = new RegExp(`^${PATH_CHARS}+$`);

function looksLikePath(s: string): boolean {
  return PATH_TOKEN_RE.test(s) && (s.includes("/") || /\.[A-Za-z]\w*$/.test(s));
}

/** Every `path:N` or `path:N-M` in a locator value. A bare `:N` takes the path before it. A value
 *  of bare paths is whole files (`0-0`). Anything else is one unparsed locator. */
export function normaliseLocator(raw: string): Locator[] {
  const text = raw.replace(/`/g, "").trim();
  const out: Locator[] = [];
  let lastPath: string | undefined;
  for (const m of text.matchAll(LINE_LOC_RE)) {
    const before = m.index === 0 ? "" : text[m.index - 1]!;
    let path = m[1]!;
    if (path === "") {
      // A bare `:N` only after a separator, so `a.ts:42:7` (line:column) is one locator.
      if (lastPath === undefined || !(before === "" || /[\s,(;]/.test(before))) continue;
      path = lastPath;
    } else if (!looksLikePath(path)) {
      continue;
    }
    lastPath = path;
    const a = Number(m[2]);
    const b = m[3] === undefined ? a : Number(m[3]);
    push(out, { path, start: Math.min(a, b), end: Math.max(a, b), parsed: true });
  }
  if (out.length > 0) return out;
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every(looksLikePath)) {
    for (const path of tokens) push(out, { path, start: 0, end: 0, parsed: true });
    return out;
  }
  return [{ path: raw.trim(), start: 0, end: 0, parsed: false }];
}

function push(out: Locator[], loc: Locator): void {
  if (!out.some((l) => l.path === loc.path && l.start === loc.start && l.end === loc.end)) {
    out.push(loc);
  }
}

// ── Kind normalisation ───────────────────────────────────────────────────────────────────────

/** Lower-case, fold the spelled-out aliases, take the first token. Returns the raw token when it
 *  is not a kind, so the caller's refusal can name it. */
export function normaliseKind(raw: string): { kind?: Kind; token: string } {
  let v = raw.replace(/`/g, "").trim().toLowerCase();
  v = v.replace(/\b(dev|test)[\s_]+(tool|app)\b/g, "$1-$2");
  const token = (v.split(/\s+/)[0] ?? "").replace(/[,;.:]+$/, "");
  const folded = token === "behaviour" ? "behavior" : token;
  return isKind(folded) ? { kind: folded, token } : { token };
}

// ── The finding block ────────────────────────────────────────────────────────────────────────

export interface Finding {
  id: string;
  title: string;
  /** 1-based line of the head. */
  line: number;
  locator: string;
  locators: Locator[];
  kind: Kind;
  finding: string;
  after: string;
  invariant?: string;
  vacuity?: string;
}

/** A `session.md` block: a finding plus the stage whose round takes it. */
export interface SessionFinding extends Finding {
  stage: Stage;
}

const BLOCK_HEAD_RE = new RegExp(`^#{2,4} (${ID_SRC}) — (.+)$`);
/** A line that means to be a head but is not in the head grammar (wrong dash, no title). */
const LOOSE_HEAD_RE = new RegExp(`^#{2,4}\\s+(${ID_SRC})\\b`);
const LOOSE_HEAD_SEP_RE = new RegExp(`^#{2,4}\\s+(${ID_SRC})\\s+[—–-]+\\s+(.+)$`);
const FIELD_RE = /^- ([A-Za-z][A-Za-z_-]*):\s*(.*)$/;
const CONTINUATION_RE = /^ {2,}\S/;

interface RawBlock {
  id: string;
  title: string;
  line: number;
  fields: Map<string, string>;
}

/** Cut `text` into raw blocks. A block runs from its head to the next `#` heading. A line that
 *  follows a field line and starts with two or more spaces is appended to that field. */
function rawBlocks(text: string, lineOffset: number, issues: RunFileIssue[]): RawBlock[] {
  const out: RawBlock[] = [];
  let cur: RawBlock | null = null;
  let lastField: string | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const lineNo = i + 1 + lineOffset;
    let head = BLOCK_HEAD_RE.exec(line);
    if (!head && LOOSE_HEAD_RE.test(line)) {
      head = LOOSE_HEAD_SEP_RE.exec(line);
      if (!head) {
        issues.push({ line: lineNo, message: `head must be \`### <ID> — <title>\`, got \`${line}\`` });
      }
    }
    if (head) {
      cur = { id: head[1]!, title: head[2]!.trim(), line: lineNo, fields: new Map() };
      out.push(cur);
      lastField = null;
      continue;
    }
    if (/^#/.test(line)) {
      cur = null;
      lastField = null;
      continue;
    }
    if (!cur) continue;
    const field = FIELD_RE.exec(line);
    if (field) {
      const key = field[1]!.toLowerCase().replace(/_/g, "-");
      if (!cur.fields.has(key)) {
        cur.fields.set(key, field[2]!.trim());
        lastField = key;
      } else {
        lastField = null;
      }
      continue;
    }
    if (lastField && CONTINUATION_RE.test(line)) {
      const prev = cur.fields.get(lastField)!;
      cur.fields.set(lastField, `${prev} ${line.trim()}`.trim());
      continue;
    }
    lastField = null;
  }
  return out;
}

export interface ParseFindingOptions {
  /** Refuse an id whose number is outside this stage's range (`stageIdRange`). */
  stage?: Stage;
  /** Line number of the text's first line minus one, when the text is a slice of a file. */
  lineOffset?: number;
  /** Refuse an id whose prefix is not this (`readerIdPrefix`: the file's reader and slice). */
  prefix?: string | null;
}

function toFinding(b: RawBlock, opts: ParseFindingOptions, issues: RunFileIssue[]): Finding | null {
  const errs: string[] = [];
  const get = (key: string): string | undefined => {
    const v = b.fields.get(key);
    return v === undefined || v === "" ? undefined : v;
  };
  const locator = get("locator");
  const kindRaw = get("kind");
  const finding = get("finding");
  const after = get("after") ?? get("fix");
  if (locator === undefined) errs.push("missing `locator`");
  if (kindRaw === undefined) errs.push("missing `kind`");
  if (finding === undefined) errs.push("missing `finding`");
  if (after === undefined) errs.push("missing `after`");
  let kind: Kind | undefined;
  if (kindRaw !== undefined) {
    const n = normaliseKind(kindRaw);
    if (!n.kind) errs.push(`\`kind\` must be one of ${KINDS.join(" | ")}, got \`${n.token}\``);
    kind = n.kind;
  }
  const { prefix, readerPrefix, number } = splitFindingId(b.id);
  if (kind === "missing" && readerPrefix !== "VERIFIER") {
    errs.push("`kind: missing` is legal only on a VERIFIER id");
  }
  if (opts.prefix && prefix !== opts.prefix) {
    errs.push(`this reader's ids are \`${opts.prefix}.<n>\` (CLOSE §The readers → Id prefixes), got \`${prefix}\``);
  }
  if (opts.stage) {
    const { min, max } = stageIdRange(opts.stage);
    if (number < min || number > max) {
      errs.push(`id number ${number} is outside stage ${opts.stage}'s range ${min}–${max}`);
    }
  }
  for (const e of errs) issues.push({ line: b.line, message: `finding ${b.id}: ${e}` });
  if (errs.length > 0) return null;
  const invariant = get("invariant");
  const vacuity = get("vacuity");
  return {
    id: b.id,
    title: b.title,
    line: b.line,
    locator: locator!,
    locators: normaliseLocator(locator!),
    kind: kind!,
    finding: finding!,
    after: after!,
    ...(invariant === undefined ? {} : { invariant }),
    ...(vacuity === undefined ? {} : { vacuity }),
  };
}

function duplicateIds(blocks: readonly RawBlock[], issues: RunFileIssue[]): void {
  const seen = new Set<string>();
  for (const b of blocks) {
    if (seen.has(b.id)) issues.push({ line: b.line, message: `finding ${b.id}: id used twice` });
    seen.add(b.id);
  }
}

/**
 * Every `### <ID> — <title>` block and its `- key: value` lines. Required: `locator`, `kind`,
 * `finding`, `after` (`fix:` is read as `after:`). Optional: `invariant`, `vacuity`. Every other
 * field (`tier`, `relevance`, `surface`, `fires`, `ease`, …) is tolerated and ignored. Throws a
 * `RunFileError` naming each bad block.
 */
export function parseFindingBlock(text: string, opts: ParseFindingOptions = {}): Finding[] {
  const issues: RunFileIssue[] = [];
  const blocks = rawBlocks(text, opts.lineOffset ?? 0, issues);
  duplicateIds(blocks, issues);
  const out = blocks
    .map((b) => toFinding(b, opts, issues))
    .filter((f): f is Finding => f !== null);
  throwIfAny(issues);
  return out;
}

const NO_FINDINGS_RE = /^NO FINDINGS\b/m;

/** One `## Prose drift (advisory)` line: `path:line · what it says · what is true now`. */
export interface Advice {
  locator: string;
  text: string;
}

/** A prose-drift line that reports nothing: `none`, `None noticed …`, `N/A`, `nothing to flag`. A line
 *  that goes on to name something (`None of the docs name the flag`) is a finding and stays. */
const NO_DRIFT_RE =
  /^(?:none|nothing|n\/a|no (?:prose )?drift)(?:[.!]?$|[.,;:!)]\s|\s+(?:noticed|found|seen|spotted|to (?:flag|report|note))\b)/i;

function proseDrift(text: string): Advice[] {
  const out: Advice[] = [];
  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^#/.test(line)) {
      inSection = /^#{2,4}\s+Prose drift\b/i.test(line);
      continue;
    }
    if (!inSection || line.trim() === "") continue;
    const body = line.replace(/^\s*[-*]\s+/, "").trim();
    const cut = body.indexOf(" · ");
    if (NO_DRIFT_RE.test((cut < 0 ? body : body.slice(0, cut)).replace(/^[*_`]+|[*_`]+$/g, ""))) continue;
    out.push(
      cut < 0
        ? { locator: "", text: body }
        : { locator: body.slice(0, cut).replace(/`/g, "").trim(), text: body.slice(cut + 3).trim() }
    );
  }
  return out;
}

/** A wave reader file: its findings (ids in the wave range), its prose-drift advice, and whether it
 *  declared itself clean. No blocks and no `NO FINDINGS` line is a refusal. */
export function parseReaderFile(
  text: string,
  opts: ParseFindingOptions = { stage: "wave" }
): { findings: Finding[]; advice: Advice[] } {
  const findings = parseFindingBlock(text, opts);
  if (findings.length === 0 && !NO_FINDINGS_RE.test(text)) {
    throw new RunFileError([
      { message: "no `### <ID> — <title>` blocks and no line starting `NO FINDINGS`" },
    ]);
  }
  return { findings, advice: proseDrift(text) };
}

// ── session.md ───────────────────────────────────────────────────────────────────────────────

/** `session.md`: finding blocks with ids `SESSION.<n>`, unique, each with a `stage:` field. An
 *  empty file holds no findings. */
export function parseSessionFile(text: string): SessionFinding[] {
  const issues: RunFileIssue[] = [];
  const blocks = rawBlocks(text, 0, issues);
  duplicateIds(blocks, issues);
  const out: SessionFinding[] = [];
  for (const b of blocks) {
    const errs: string[] = [];
    if (splitFindingId(b.id).prefix !== "SESSION") errs.push("a session.md id is `SESSION.<n>`");
    const stage = b.fields.get("stage")?.split(/\s+/)[0];
    if (!stage) errs.push("missing `stage`");
    else if (!isStage(stage)) errs.push(`\`stage\` must be one of ${STAGES.join(" | ")}, got \`${stage}\``);
    for (const e of errs) issues.push({ line: b.line, message: `finding ${b.id}: ${e}` });
    const f = toFinding(b, {}, issues);
    if (f && errs.length === 0) out.push({ ...f, stage: stage as Stage });
  }
  throwIfAny(issues);
  return out;
}

// ── The fix file ─────────────────────────────────────────────────────────────────────────────

export const DECISION_WHICH = [
  "brief",
  "public-surface",
  "design-entry",
  "persisted-shape",
  "user-visible",
  "conflict",
  "product",
] as const;
export type DecisionWhich = (typeof DECISION_WHICH)[number];

export type FixLine =
  | { row: string; line: number; action: "fixed"; sha: string; kind?: Kind; what: string }
  | { row: string; line: number; action: "dropped"; reason: string }
  | { row: string; line: number; action: "relabel"; from: Kind; to: Kind; reason: string }
  | { row: string; line: number; action: "decision"; which: DecisionWhich; question: string }
  | { row: string; line: number; action: "blocked"; reason: string };

export const EXIT_CHECKS = ["vacuity", "mutation", "branches", "shared function"] as const;
export type ExitCheck = (typeof EXIT_CHECKS)[number];

export interface FixFile {
  lines: FixLine[];
  exitChecks: Record<ExitCheck, string>;
}

export interface ParseFixOptions {
  /** The rows of `table-<round>.md`: each needs one line, and no other row may appear. */
  rows?: readonly string[];
  /** The round: a `relabel` to a kind this round fixes is refused (that is `fixed · kind=`). */
  round?: FixRound;
}

const DASH = "\\s+[—–]\\s+";
const FIX_ROW_RE = new RegExp(`^(${ID_SRC})\\s+·\\s+(.*)$`);
const FIXED_RE = new RegExp(`^fixed\\s+·\\s+([0-9a-f]{7,40})(?:\\s+·\\s+kind=(\\S+))?${DASH}(.+)$`);
const FIXED_NO_SHA_RE = /^fixed\b/;
const DROPPED_RE = new RegExp(`^dropped${DASH}(.+)$`);
const RELABEL_RE = new RegExp(`^relabel\\s+(\\S+?)\\s*(?:→|->)\\s*(\\S+)${DASH}(.+)$`);
const DECISION_RE = new RegExp(`^decision${DASH}(\\S+)${DASH}(.+)$`);
const BLOCKED_RE = new RegExp(`^blocked${DASH}(.+)$`);
const EXIT_HEAD_RE = /^exit checks:\s*$/;
const EXIT_LINE_RE = /^(vacuity|mutation|branches|shared function):\s*(.*)$/;

function fixLine(
  row: string,
  rest: string,
  line: number,
  opts: ParseFixOptions,
  issues: RunFileIssue[]
): FixLine | null {
  const bad = (message: string): null => {
    issues.push({ line, message: `${row}: ${message}` });
    return null;
  };
  let m = FIXED_RE.exec(rest);
  if (m) {
    if (m[2] === undefined) return { row, line, action: "fixed", sha: m[1]!, what: m[3]!.trim() };
    const k = normaliseKind(m[2]);
    if (!k.kind) return bad(`\`kind=${m[2]}\` is not one of ${KINDS.join(" | ")}`);
    return { row, line, action: "fixed", sha: m[1]!, kind: k.kind, what: m[3]!.trim() };
  }
  if (FIXED_NO_SHA_RE.test(rest)) {
    return bad("a `fixed` line is `<ROW> · fixed · <sha> [· kind=<kind>] — <what changed>`; the sha is missing or malformed");
  }
  m = DROPPED_RE.exec(rest);
  if (m) return { row, line, action: "dropped", reason: m[1]!.trim() };
  m = RELABEL_RE.exec(rest);
  if (m) {
    const from = normaliseKind(m[1]!);
    const to = normaliseKind(m[2]!);
    if (!from.kind || !to.kind) {
      return bad(`relabel kinds must be ${KINDS.join(" | ")}, got \`${m[1]}→${m[2]}\``);
    }
    if (opts.round && isFixedAt(to.kind, opts.round)) {
      return bad(`round ${opts.round} fixes \`${to.kind}\`; fix the row and write \`fixed · <sha> · kind=${to.kind}\``);
    }
    return { row, line, action: "relabel", from: from.kind, to: to.kind, reason: m[3]!.trim() };
  }
  m = DECISION_RE.exec(rest);
  if (m) {
    const which = m[1]!;
    if (!(DECISION_WHICH as readonly string[]).includes(which)) {
      return bad(`decision \`${which}\` is not one of ${DECISION_WHICH.join(" | ")}`);
    }
    return { row, line, action: "decision", which: which as DecisionWhich, question: m[2]!.trim() };
  }
  m = BLOCKED_RE.exec(rest);
  if (m) return { row, line, action: "blocked", reason: m[1]!.trim() };
  return bad(
    "not a fix line: `fixed · <sha> — …`, `dropped — …`, `relabel <old>→<new> — …`, `decision — <which> — …`, or `blocked — <evidence>`"
  );
}

/** `fix-<round>.txt`: one line per row, then `exit checks:` and its four lines. */
export function parseFixFile(text: string, opts: ParseFixOptions = {}): FixFile {
  const issues: RunFileIssue[] = [];
  const lines: FixLine[] = [];
  const checks = new Map<ExitCheck, string>();
  let inChecks = false;
  let lastCheck: ExitCheck | null = null;
  const all = text.split("\n");
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!.replace(/\r$/, "");
    const lineNo = i + 1;
    if (line.trim() === "") {
      lastCheck = null;
      continue;
    }
    if (EXIT_HEAD_RE.test(line)) {
      if (inChecks) issues.push({ line: lineNo, message: "`exit checks:` appears twice" });
      inChecks = true;
      continue;
    }
    if (inChecks) {
      const m = EXIT_LINE_RE.exec(line);
      if (m) {
        const key = m[1] as ExitCheck;
        if (checks.has(key)) issues.push({ line: lineNo, message: `exit check \`${key}:\` appears twice` });
        else if (m[2]!.trim() === "") {
          issues.push({ line: lineNo, message: `exit check \`${key}:\` is empty — write the command and its result, or \`none\` with a reason` });
        } else checks.set(key, m[2]!.trim());
        lastCheck = key;
      } else if (lastCheck && CONTINUATION_RE.test(line)) {
        checks.set(lastCheck, `${checks.get(lastCheck)} ${line.trim()}`);
      } else {
        issues.push({ line: lineNo, message: `after \`exit checks:\` only ${EXIT_CHECKS.map((c) => `\`${c}:\``).join(", ")} lines` });
      }
      continue;
    }
    const m = FIX_ROW_RE.exec(line);
    if (!m) {
      issues.push({ line: lineNo, message: "not a fix line: `<ROW> · fixed|dropped|relabel|decision|blocked …`" });
      continue;
    }
    const row = m[1]!;
    if (lines.some((l) => l.row === row)) {
      issues.push({ line: lineNo, message: `${row}: a second line for this row` });
      continue;
    }
    if (opts.rows && !opts.rows.includes(row)) {
      issues.push({ line: lineNo, message: `${row}: not a row of this round's table` });
      continue;
    }
    const parsed = fixLine(row, m[2]!.trim(), lineNo, opts, issues);
    if (parsed) lines.push(parsed);
  }
  if (!inChecks) issues.push({ message: "missing `exit checks:` and its four lines" });
  else {
    for (const c of EXIT_CHECKS) {
      if (!checks.has(c)) issues.push({ message: `missing exit check \`${c}:\`` });
    }
  }
  for (const row of opts.rows ?? []) {
    if (!lines.some((l) => l.row === row) && !issues.some((i) => i.message.startsWith(`${row}:`))) {
      issues.push({ message: `${row}: row has no line` });
    }
  }
  throwIfAny(issues);
  return { lines, exitChecks: Object.fromEntries(checks) as Record<ExitCheck, string> };
}

// ── The stage file ───────────────────────────────────────────────────────────────────────────

export const STATUS_WORDS = ["resolved", "unresolved", "agree", "disagree"] as const;
export type StatusWord = (typeof STATUS_WORDS)[number];

/** Longest first, so `agreed` is not read as `agree` + `d`. */
const STATUS_ALIASES: readonly (readonly [string, StatusWord])[] = [
  ["fixed differently", "resolved"],
  ["resolved ✓", "resolved"],
  ["still open", "unresolved"],
  ["not fixed", "unresolved"],
  ["unresolved", "unresolved"],
  ["disagreed", "disagree"],
  ["confirmed", "resolved"],
  ["disagree", "disagree"],
  ["resolved", "resolved"],
  ["agreed", "agree"],
  ["closed", "resolved"],
  ["agree", "agree"],
  ["fixed", "resolved"],
  ["holds", "resolved"],
  ["open", "unresolved"],
];

/** What the fixer did to a row the dispatch gave: `fixed` rows take resolved/unresolved,
 *  `dropped` and `relabel` rows take agree/disagree. */
export type GivenAnswer = "fixed" | "dropped" | "relabel";

export interface GivenRow {
  id: string;
  /** The row's other merged ids; a status line under any of them answers the row. */
  also?: readonly string[];
  line?: GivenAnswer;
}

export interface StatusLine {
  /** The given row's id when `given` was passed, else the id as written. */
  row: string;
  /** The id as the reader wrote it. */
  id: string;
  line: number;
  status: StatusWord;
  reason?: string;
}

export type Verdict = { verdict: "CLEAN" } | { verdict: "INCOMPLETE"; check: string };

export interface StageFile {
  status: StatusLine[];
  findings: Finding[];
  verdict?: Verdict;
  /** Status lines for rows the dispatch did not give; ignored. */
  warnings: string[];
}

export interface ParseStageOptions {
  /** The stage folder's stage; `## New` ids must be in its range. */
  stage: Exclude<Stage, "wave">;
  /** The rows the dispatch gave this reader. Omitted: status coverage is not checked. */
  given?: readonly GivenRow[];
  /** `build-verifier` must end with a `VERDICT:` line; a global reader's `## New` ids take its prefix. */
  reader?: string;
}

/** `- <ID> [(<gloss>)] <sep> <word>…` — readers add a parenthetical gloss after the id (B2b did). */
const STATUS_HEAD_RE = new RegExp(`^- (${ID_SRC})(?:\\s*\\(.*?\\))?\\s*(?:·|—|–|-|:|\\|)\\s*(.+)$`);
const REASON_SEP_RE = /^\s*(?:—|–|-|:|·|\|)\s*/;

/** A status bullet starts with an id; any other bullet in `## Status` is prose and is skipped. */
const STATUS_BULLET_ID_RE = new RegExp(`^- ${ID_SRC}\\b`);

/** The status word at the start of `rest`, markdown emphasis (`**fixed**`) stripped. */
function statusWord(rest: string): { status: StatusWord; tail: string } | null {
  const bare = rest.replace(/^[*_]+/, "");
  const lower = bare.toLowerCase();
  for (const [alias, word] of STATUS_ALIASES) {
    if (!lower.startsWith(alias)) continue;
    const next = bare.slice(alias.length).replace(/^[*_]+/, "");
    if (next !== "" && !/^[\s—–\-:,;.|·✓(]/.test(next)) continue;
    return { status: word, tail: next.replace(/^\s*✓/, "") };
  }
  return null;
}

/** The last `VERDICT:` line: `VERDICT: CLEAN` or `VERDICT: INCOMPLETE — <check>`. Null when
 *  there is none; throws on any other form. */
export function parseVerdict(text: string): Verdict | null {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^VERDICT:/.test(lines[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const line = lines[at]!;
  if (/^VERDICT:\s*CLEAN\s*$/.test(line)) return { verdict: "CLEAN" };
  const m = /^VERDICT:\s*INCOMPLETE\s+[—–]\s+(.+)$/.exec(line);
  if (m) return { verdict: "INCOMPLETE", check: m[1]!.trim() };
  throw new RunFileError([
    { line: at + 1, message: "the verdict is `VERDICT: CLEAN` or `VERDICT: INCOMPLETE — <check>`" },
  ]);
}

/** `stage-<stage>/<reader>.md`: `## Status` (one line per row given, or `- none`), then `## New`
 *  (finding blocks in the stage's id range, or a `NO FINDINGS` line). */
export function parseStageFile(text: string, opts: ParseStageOptions): StageFile {
  const issues: RunFileIssue[] = [];
  const warnings: string[] = [];
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const statusAt = lines.findIndex((l) => /^##\s+Status\s*$/.test(l));
  const newAt = lines.findIndex((l) => /^##\s+New\s*$/.test(l));
  if (statusAt < 0) issues.push({ message: "missing `## Status` section" });
  if (newAt < 0) issues.push({ message: "missing `## New` section" });
  if (statusAt >= 0 && newAt >= 0 && newAt < statusAt) {
    issues.push({ line: newAt + 1, message: "`## New` comes after `## Status`" });
  }
  if (issues.length > 0) throw new RunFileError(issues);

  const given = opts.given;
  const rowOf = (id: string): GivenRow | undefined =>
    given?.find((g) => g.id === id || (g.also ?? []).includes(id));
  const status: StatusLine[] = [];
  let sawNone = false;
  for (let i = statusAt + 1; i < newAt; i++) {
    let line = lines[i]!;
    const lineNo = i + 1;
    if (/^#/.test(line)) break;
    if (/^-\s+none\s*$/i.test(line)) {
      sawNone = true;
      continue;
    }
    if (!/^- /.test(line)) continue;
    if (!STATUS_BULLET_ID_RE.test(line)) {
      warnings.push(`line ${lineNo}: not a status line (no row id); ignored`);
      continue;
    }
    // A wrapped status line: indented lines that follow it belong to it.
    while (i + 1 < newAt && CONTINUATION_RE.test(lines[i + 1]!)) line = `${line} ${lines[++i]!.trim()}`;
    const m = STATUS_HEAD_RE.exec(line);
    if (!m) {
      issues.push({ line: lineNo, message: "a status line is `- <ID> · <resolved|unresolved|agree|disagree>[ — <reason>]`" });
      continue;
    }
    const id = m[1]!;
    const word = statusWord(m[2]!.trim());
    if (!word) {
      issues.push({ line: lineNo, message: `${id}: unknown status \`${m[2]!.trim()}\` — use ${STATUS_WORDS.join(" | ")}` });
      continue;
    }
    const reason = word.tail.replace(REASON_SEP_RE, "").trim();
    if ((word.status === "unresolved" || word.status === "disagree") && reason === "") {
      issues.push({ line: lineNo, message: `${id}: \`${word.status}\` needs a reason after \` — \`` });
      continue;
    }
    let row = id;
    if (given) {
      const g = rowOf(id);
      if (!g) {
        warnings.push(`line ${lineNo}: ${id} was not given to this reader; ignored`);
        continue;
      }
      row = g.id;
      const wantsFixed = word.status === "resolved" || word.status === "unresolved";
      if (g.line && (g.line === "fixed") !== wantsFixed) {
        issues.push({
          line: lineNo,
          message: `${id}: the fixer's line was \`${g.line}\`, so the answer is ${g.line === "fixed" ? "resolved | unresolved" : "agree | disagree"}`,
        });
        continue;
      }
    }
    if (status.some((s) => s.row === row)) {
      issues.push({ line: lineNo, message: `${id}: a second status line for row ${row}` });
      continue;
    }
    status.push({ row, id, line: lineNo, status: word.status, ...(reason ? { reason } : {}) });
  }
  if (sawNone && status.length > 0) {
    issues.push({ line: statusAt + 1, message: "`- none` and status lines together" });
  }
  for (const g of given ?? []) {
    if (!status.some((s) => s.row === g.id)) {
      issues.push({ line: statusAt + 1, message: `${g.id}: row given and missing from \`## Status\`` });
    }
  }

  const newText = lines.slice(newAt + 1).join("\n");
  let findings: Finding[] = [];
  try {
    findings = parseFindingBlock(newText, {
      stage: opts.stage,
      lineOffset: newAt + 1,
      ...(opts.reader ? { prefix: readerIdPrefix(opts.reader) } : {}),
    });
  } catch (e) {
    if (!(e instanceof RunFileError)) throw e;
    issues.push(...e.issues);
  }
  if (findings.length === 0 && !NO_FINDINGS_RE.test(newText) && !issues.some((i) => /^finding /.test(i.message))) {
    issues.push({ line: newAt + 1, message: "`## New` holds no finding block and no line starting `NO FINDINGS`" });
  }

  let verdict: Verdict | undefined;
  try {
    verdict = parseVerdict(text) ?? undefined;
  } catch (e) {
    if (!(e instanceof RunFileError)) throw e;
    issues.push(...e.issues);
  }
  if (opts.reader === "build-verifier" && verdict === undefined && !issues.some((i) => /VERDICT/.test(i.message))) {
    issues.push({ message: "build-verifier ends with `VERDICT: CLEAN` or `VERDICT: INCOMPLETE — <check>`" });
  }
  throwIfAny(issues);
  return { status, findings, ...(verdict ? { verdict } : {}), warnings };
}

// ── The hand-test file ───────────────────────────────────────────────────────────────────────

export const FAIL_CAUSES = ["code", "claim", "env"] as const;
export type FailCause = (typeof FAIL_CAUSES)[number];

export type HandTestLine =
  | { claim: string; line: number; result: "pass"; sha: string; output: string }
  | {
      claim: string;
      line: number;
      result: "fail";
      cause: FailCause;
      sha: string;
      output: string;
      differed: string;
    };

const HT_PASS_RE = new RegExp(`^(H[1-9]\\d*)\\s+·\\s+pass\\s+·\\s+([0-9a-f]{7,40})${DASH}(\\S+)\\s*$`);
const HT_FAIL_RE = new RegExp(
  `^(H[1-9]\\d*)\\s+·\\s+fail \\((code|claim|env)\\)\\s+·\\s+([0-9a-f]{7,40})${DASH}(\\S+)${DASH}(.+)$`
);

/** `hand-test-<n>.txt`: one line per claim run. The output file is relative to the run dir. */
export function parseHandTestFile(text: string): HandTestLine[] {
  const issues: RunFileIssue[] = [];
  const out: HandTestLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const lineNo = i + 1;
    if (line.trim() === "") continue;
    let parsed: HandTestLine | null = null;
    let m = HT_PASS_RE.exec(line);
    if (m) parsed = { claim: m[1]!, line: lineNo, result: "pass", sha: m[2]!, output: m[3]! };
    m = parsed ? null : HT_FAIL_RE.exec(line);
    if (m) {
      parsed = {
        claim: m[1]!,
        line: lineNo,
        result: "fail",
        cause: m[2] as FailCause,
        sha: m[3]!,
        output: m[4]!,
        differed: m[5]!.trim(),
      };
    }
    if (!parsed) {
      issues.push({
        line: lineNo,
        message: "a hand-test line is `H<k> · pass · <sha> — <output file>` or `H<k> · fail (code|claim|env) · <sha> — <output file> — <what differed>`",
      });
      continue;
    }
    if (parsed.output.startsWith("/") || parsed.output.split("/").includes("..")) {
      issues.push({ line: lineNo, message: `${parsed.claim}: the output file is relative to the run dir, got \`${parsed.output}\`` });
      continue;
    }
    if (out.some((h) => h.claim === parsed.claim)) {
      issues.push({ line: lineNo, message: `${parsed.claim}: a second line for this claim` });
      continue;
    }
    out.push(parsed);
  }
  throwIfAny(issues);
  return out;
}

// ── table.json ───────────────────────────────────────────────────────────────────────────────

export interface RowText {
  id: string;
  finding: string;
  after: string;
  invariant?: string;
  vacuity?: string;
}

export const ROW_ORIGINS = ["reader", "session", "hand-test"] as const;
export type RowOrigin = (typeof ROW_ORIGINS)[number];

export interface Row {
  id: string;
  also: string[];
  kind: Kind;
  locators: Locator[];
  texts: RowText[];
  origin: RowOrigin;
  enteredAt: RoundId;
  history: string[];
}

export interface Leftover {
  row?: Row;
  advice?: Advice;
  reason: string;
}

export interface Round {
  head: string;
  rows: Row[];
  leftovers: Leftover[];
  banked: { id: string; question: string }[];
  closed: string[];
  consumed: string[];
  refused: { file: string; error: string }[];
}

export interface FinalRound extends Round {
  open: { id: string; kind: Kind }[];
}

export interface TableJson {
  schema: 2;
  rounds: Partial<Record<RoundId, Round | FinalRound>>;
}

const ROUND_ID_WANT = `a round id (${FIXED_ROUND_IDS.join(" | ")} | drift-<n> | final)`;

function roundId(s: Shape, v: unknown, path: string): RoundId {
  if (typeof v === "string" && isRoundId(v)) return v;
  s.bad(path, ROUND_ID_WANT);
  return "1";
}

function readLocator(s: Shape, v: unknown, path: string): Locator {
  const o = s.obj(v, path) ?? {};
  return {
    path: s.str(o.path, `${path}.path`),
    start: s.int(o.start, `${path}.start`),
    end: s.int(o.end, `${path}.end`),
    parsed: s.bool(o.parsed, `${path}.parsed`),
  };
}

function readRowText(s: Shape, v: unknown, path: string): RowText {
  const o = s.obj(v, path) ?? {};
  const invariant = s.optStr(o, "invariant", path);
  const vacuity = s.optStr(o, "vacuity", path);
  return {
    id: s.str(o.id, `${path}.id`),
    finding: s.str(o.finding, `${path}.finding`),
    after: s.str(o.after, `${path}.after`),
    ...(invariant === undefined ? {} : { invariant }),
    ...(vacuity === undefined ? {} : { vacuity }),
  };
}

function readRow(s: Shape, v: unknown, path: string): Row {
  const o = s.obj(v, path) ?? {};
  return {
    id: s.str(o.id, `${path}.id`),
    also: s.strs(o.also, `${path}.also`),
    kind: s.oneOf(o.kind, KINDS, `${path}.kind`),
    locators: s.arr(o.locators, `${path}.locators`).map((x, i) => readLocator(s, x, `${path}.locators[${i}]`)),
    texts: s.arr(o.texts, `${path}.texts`).map((x, i) => readRowText(s, x, `${path}.texts[${i}]`)),
    origin: s.oneOf(o.origin, ROW_ORIGINS, `${path}.origin`),
    enteredAt: roundId(s, o.enteredAt, `${path}.enteredAt`),
    history: s.strs(o.history, `${path}.history`),
  };
}

function readLeftover(s: Shape, v: unknown, path: string): Leftover {
  const o = s.obj(v, path) ?? {};
  let advice: Advice | undefined;
  if (o.advice !== undefined) {
    const a = s.obj(o.advice, `${path}.advice`) ?? {};
    advice = { locator: s.str(a.locator, `${path}.advice.locator`), text: s.str(a.text, `${path}.advice.text`) };
  }
  const row = o.row === undefined ? undefined : readRow(s, o.row, `${path}.row`);
  if (row === undefined && advice === undefined) s.bad(path, "a `row` or an `advice`");
  return {
    ...(row === undefined ? {} : { row }),
    ...(advice === undefined ? {} : { advice }),
    reason: s.str(o.reason, `${path}.reason`),
  };
}

function readRound(s: Shape, v: unknown, id: RoundId): Round | FinalRound {
  const path = `rounds.${id}`;
  const o = s.obj(v, path) ?? {};
  const round: Round = {
    head: s.str(o.head, `${path}.head`),
    rows: s.arr(o.rows, `${path}.rows`).map((x, i) => readRow(s, x, `${path}.rows[${i}]`)),
    leftovers: s.arr(o.leftovers, `${path}.leftovers`).map((x, i) => readLeftover(s, x, `${path}.leftovers[${i}]`)),
    banked: s.arr(o.banked, `${path}.banked`).map((x, i) => {
      const b = s.obj(x, `${path}.banked[${i}]`) ?? {};
      return { id: s.str(b.id, `${path}.banked[${i}].id`), question: s.str(b.question, `${path}.banked[${i}].question`) };
    }),
    closed: s.strs(o.closed, `${path}.closed`),
    consumed: s.strs(o.consumed, `${path}.consumed`),
    refused: s.arr(o.refused, `${path}.refused`).map((x, i) => {
      const r = s.obj(x, `${path}.refused[${i}]`) ?? {};
      return { file: s.str(r.file, `${path}.refused[${i}].file`), error: s.str(r.error, `${path}.refused[${i}].error`) };
    }),
  };
  if (id !== "final") {
    if (o.open !== undefined) s.bad(`${path}.open`, "no `open` outside round `final`");
    return round;
  }
  const open = s.arr(o.open, `${path}.open`).map((x, i) => {
    const e = s.obj(x, `${path}.open[${i}]`) ?? {};
    return { id: s.str(e.id, `${path}.open[${i}].id`), kind: s.oneOf(e.kind, KINDS, `${path}.open[${i}].kind`) };
  });
  return { ...round, open };
}

function readTable(v: unknown): TableJson {
  const s = new Shape("table.json");
  const o = s.obj(v, "(root)") ?? {};
  if (o.schema !== 2) s.bad("schema", "2");
  const roundsObj = s.obj(o.rounds, "rounds") ?? {};
  const rounds: TableJson["rounds"] = {};
  const ids: RoundId[] = [];
  for (const key of Object.keys(roundsObj)) {
    if (!isRoundId(key)) {
      s.bad(`rounds.${key}`, ROUND_ID_WANT);
      continue;
    }
    ids.push(key);
  }
  for (const id of ids.sort(roundOrder)) {
    if (roundsObj[id] !== undefined) rounds[id] = readRound(s, roundsObj[id], id);
  }
  throwIfAny(s.issues());
  return { schema: 2, rounds };
}

/** Parse and validate `table.json`. Throws a `RunFileError` naming every bad path. */
export function parseTableJson(text: string): TableJson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RunFileError([{ message: `table.json is not JSON: ${(e as Error).message}` }]);
  }
  return readTable(raw);
}

/** The one writer of `table.json`: validates, then prints rounds in round order and every object
 *  in one key order, so equal tables print equal text. */
export function serialiseTableJson(table: TableJson): string {
  const clean = readTable(table);
  return `${JSON.stringify(clean, null, 2)}\n`;
}
