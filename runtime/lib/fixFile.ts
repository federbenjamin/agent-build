/**
 * The fix file's grammar (`fix-<round>.txt`): one line per row of the round's table, then
 * `exit checks:` and its four lines; its parser, the all-`blocked` writer, and the join of a round's
 * slices. Pure: callers pass text, nothing here reads a file. A parser throws a `RunFileError`
 * holding every problem it found, each with its line.
 */

import {
  CONTINUATION_RE,
  DASH,
  ID_SRC,
  isFixedAt,
  KINDS,
  normaliseKind,
  throwIfAny,
  type FixRound,
  type Kind,
  type RunFileIssue,
} from "./runFiles.ts";

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

const textLines = (text: string): string[] => text.split("\n").map((l) => l.replace(/\r$/, ""));

/** Each parsed line's text in `text`, the file `fix` was parsed from, by row. */
function lineTexts(text: string, fix: FixFile): Map<string, string> {
  const all = textLines(text);
  return new Map(fix.lines.map((l) => [l.row, all[l.line - 1]!]));
}

/** `fix-<round>.txt`: one line per row, then `exit checks:` and its four lines. */
export function parseFixFile(text: string, opts: ParseFixOptions = {}): FixFile {
  const issues: RunFileIssue[] = [];
  const lines: FixLine[] = [];
  const checks = new Map<ExitCheck, string>();
  let inChecks = false;
  let lastCheck: ExitCheck | null = null;
  const all = textLines(text);
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
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

/**
 * The fix file of rows whose commit did not land. Without `written`: `<row> · blocked — <reason>` per row.
 * With `written` (the fixer's own fix file for these rows, parsed with `{ rows }`): each `fixed` line becomes
 * `<row> · blocked — <reason>`; each `dropped`, `relabel`, `decision` and `blocked` line is kept as written;
 * lines in `rows` order. Then a blank line, `exit checks:`, and `<check>: none — <checks>` per EXIT_CHECKS,
 * ending in "\n". Throws `RunFileError` (parseFixFile) when `written` or the result breaks the grammar, as an
 * empty or multi-line reason does.
 */
export function blockedFixFile(rows: readonly string[], reason: string, checks: string, written?: string): string {
  const blocked = (r: string): string => `${r} · blocked — ${reason}`;
  let lines: string[];
  if (written === undefined) lines = rows.map(blocked);
  else {
    const fix = parseFixFile(written, { rows });
    const kept = lineTexts(written, fix);
    const fixed = new Set(fix.lines.filter((l) => l.action === "fixed").map((l) => l.row));
    lines = rows.map((r) => (fixed.has(r) ? blocked(r) : kept.get(r)!));
  }
  const text = `${[...lines, "", "exit checks:", ...EXIT_CHECKS.map((c) => `${c}: none — ${checks}`)].join("\n")}\n`;
  parseFixFile(text, { rows });
  return text;
}

/**
 * One round's fix file from the fix files of its slices, each checked against its own rows: every row
 * line in the order of `rows` (the round's table), then one `exit checks:` block whose lines name each
 * slice's result (`<check>: <slice> — <result>; …`). A single slice's file is the round's as it is.
 * Throws `RunFileError` when a slice's file breaks the grammar, or the slices do not cover the round.
 */
export function joinFixFiles(parts: readonly { slice: string; rows: readonly string[]; text: string }[], rows: readonly string[], round?: FixRound): string {
  const parsed = parts.map((p) => ({ ...p, fix: parseFixFile(p.text, { rows: p.rows, ...(round === undefined ? {} : { round }) }) }));
  if (parsed.length === 1) {
    parseFixFile(parts[0]!.text, { rows, ...(round === undefined ? {} : { round }) });
    return parts[0]!.text;
  }
  const lineOf = new Map(parsed.flatMap((p) => [...lineTexts(p.text, p.fix)]));
  const checks = EXIT_CHECKS.map((c) => `${c}: ${parsed.map((p) => `${p.slice} — ${p.fix.exitChecks[c]}`).join("; ")}`);
  const text = `${[...rows.filter((r) => lineOf.has(r)).map((r) => lineOf.get(r)!), "exit checks:", ...checks].join("\n")}\n`;
  parseFixFile(text, { rows, ...(round === undefined ? {} : { round }) });
  return text;
}
