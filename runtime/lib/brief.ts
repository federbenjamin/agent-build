/**
 * The brief's machine-read parts — the `model:` and `budget:` header lines, `## Target files`, `## Hand test`,
 * `## Parts`, and `## Test slices` — and the one parser each reader imports (the claim counter, the
 * gate, the stage plan, the table script). Pure: no fs, no git; callers pass the text.
 *
 * A part that is present but malformed throws a `BriefPartError` naming the part and the 1-based
 * line. A missing required part throws one too, with `kind: "missing"`, so a caller that accepts a
 * brief written before these parts existed (a first commit read with `--at`) can tell the two apart.
 * Headings and header lines inside a fenced block (``` or ~~~) are never read as parts: a brief may
 * quote an example of its own format.
 */

import { parseClassLine, type RiskClass } from "./riskClass.ts";

export type BriefPart = "class" | "model" | "budget" | "target-files" | "hand-test" | "parts" | "test-slices";

export class BriefPartError extends Error {
  readonly part: BriefPart;
  readonly kind: "missing" | "malformed";
  readonly line: number | null;
  constructor(part: BriefPart, kind: "missing" | "malformed", line: number | null, detail: string) {
    super(`${part}: ${line === null ? "" : `line ${line}: `}${detail}`);
    this.name = "BriefPartError";
    this.part = part;
    this.kind = kind;
    this.line = line;
  }
}

export const BRIEF_MODELS = ["opus", "sonnet", "session"] as const;
export type BriefModel = (typeof BRIEF_MODELS)[number];

export const MODEL_LINE_RE = /^model:\s*(opus|sonnet|session)\b(?:\s+—\s+(.+))?$/;
export const BUDGET_LINE_RE = /^budget:\s*(\d+(?:\.\d+)?)h\s*$/;
const TARGET_ENTRY_RE = /^- (\S+)(?:\s+—\s+.*)?$/;
const CLAIM_HEAD_RE = /^- (H[1-9]\d*) · (.+)$/;
const CLAIM_RUN_RE = /^ {2}- run: (.+)$/;
const CLAIM_PASS_RE = /^ {2}- pass: (.+)$/;
const CLAIM_NEEDS_RE = /^ {2}- needs: (stack|sim)(?:, (stack|sim))?$/;
const NONE_RE = /^none — (.+)$/;
const HEADING_RE = /^## (.+?)\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export type ClaimNeed = "stack" | "sim";

/** Test-runner commands a hand-test claim's `run:` may not be: the checks and CI already run tests,
 *  so a claim is only what they cannot do. `pnpm exec maestro test` is a UI flow, so the
 *  package-manager arm matches `test` only as its own command word. */
export const TEST_RUNNER_RES: readonly { name: string; re: RegExp }[] = [
  { name: "jest", re: /(?:^|[\s/])jest(?=\s|$)/ },
  { name: "vitest", re: /(?:^|[\s/])vitest(?=\s|$)/ },
  { name: "node --test", re: /(?:^|\s)node(?:\s+--?[\w-]+(?:[= ](?!--)\S+)?)*?\s+--test(?=\s|$)/ },
  { name: "deno test", re: /(?:^|\s)deno\s+(?:task\s+(?:--cwd\s+\S+\s+)?)?test(?=\s|$)/ },
  { name: "pnpm test", re: /(?:^|\s)(?:pnpm|npm|yarn)(?:\s+(?:-F|--filter|-C|--dir)\s+\S+|\s+--?[\w-]+)*\s+(?:run\s+)?test(?::\S+)?(?=\s|$)/ },
];

/** The test runner a claim's `run:` command is, or null when it is none of `TEST_RUNNER_RES`. */
export function testRunnerOf(run: string): string | null {
  return TEST_RUNNER_RES.find((r) => r.re.test(run))?.name ?? null;
}

/** Whether a claim's `run:` is the repo's `<manifest>` step with no exercise to run: `--no-exercise`,
 *  or a brief with no `exercise:` line. Only an exercise makes it a claim: it calls live endpoints,
 *  and the push gate runs the step with `--no-exercise`. */
export function manifestWithoutExercise(run: string, manifest: string | null, briefText: string): boolean {
  if (manifest === null || !run.includes(manifest)) return false;
  return /(?:^|\s)--no-exercise(?=\s|$)/.test(run) || !/^\s*exercise:/m.test(briefText);
}

/** One hand-test claim: what a user can see, the command that shows it, and what passing prints. */
export interface Claim {
  id: string;
  says: string;
  run: string;
  pass: string;
  needs: ClaimNeed[];
  /** 1-based line of the claim head in the text parsed. */
  line: number;
}

export interface HandTestBlock {
  claims: Claim[];
  /** The reason after `none — `, or null when the section lists claims. */
  none: string | null;
}

interface ScannedLine {
  text: string;
  /** 1-based. */
  line: number;
  inFence: boolean;
  /** Set on the fence's own opening and closing lines. */
  fence?: "open" | "close";
}

/** Every line, marked when it sits inside a fenced block (the fence lines themselves count as in). */
function scan(text: string): ScannedLine[] {
  let open: { char: string; len: number } | null = null;
  return text.split("\n").map((raw, i): ScannedLine => {
    const t = raw.replace(/\r$/, "");
    const fence = FENCE_RE.exec(t);
    if (open === null && fence) {
      open = { char: fence[1]![0]!, len: fence[1]!.length };
      return { text: t, line: i + 1, inFence: true, fence: "open" };
    }
    if (open !== null) {
      const o: { char: string; len: number } = open;
      const close = new RegExp(`^ {0,3}\\${o.char}{${o.len},}\\s*$`);
      if (close.test(t)) {
        open = null;
        return { text: t, line: i + 1, inFence: true, fence: "close" };
      }
      return { text: t, line: i + 1, inFence: true };
    }
    return { text: t, line: i + 1, inFence: false };
  });
}

/** The `## ` headings outside fences, in order. */
export function sectionHeadings(text: string): string[] {
  return scan(text).flatMap((l) => {
    const m = l.inFence ? null : HEADING_RE.exec(l.text);
    return m ? [m[1]!] : [];
  });
}

/** The lines of one `## <heading>` section (outside fences), up to the next `## `, or null when the
 *  brief has no such section. Two sections with that heading throw. */
function section(text: string, heading: string, part: BriefPart): ScannedLine[] | null {
  const lines = scan(text);
  const starts = lines.filter((l) => !l.inFence && HEADING_RE.exec(l.text)?.[1] === heading);
  if (starts.length === 0) return null;
  if (starts.length > 1) {
    throw new BriefPartError(part, "malformed", starts[1]!.line, `a second \`## ${heading}\` section`);
  }
  const from = starts[0]!.line; // 1-based line of the heading == 0-based index of the next line
  const body: ScannedLine[] = [];
  for (const l of lines.slice(from)) {
    if (!l.inFence && HEADING_RE.test(l.text)) break;
    body.push(l);
  }
  return body;
}

/** The brief's header: every line before its first `## ` heading, outside fences. */
function header(text: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  for (const l of scan(text)) {
    if (!l.inFence && HEADING_RE.test(l.text)) break;
    if (!l.inFence) out.push(l);
  }
  return out;
}

/** The `model:` header line: exactly one, in the header, directly under the class line when the
 *  brief has one. `session` marks a floor-check run. */
export function parseModelLine(text: string): { model: BriefModel; why: string | null; line: number } {
  const head = header(text);
  const lines = head.filter((l) => /^model:/.test(l.text));
  if (lines.length === 0) {
    throw new BriefPartError(
      "model",
      "missing",
      null,
      "no `model: <opus|sonnet|session> — <why>` line in the header"
    );
  }
  if (lines.length > 1) throw new BriefPartError("model", "malformed", lines[1]!.line, "a second `model:` line");
  const l = lines[0]!;
  const m = MODEL_LINE_RE.exec(l.text);
  if (!m) {
    throw new BriefPartError(
      "model",
      "malformed",
      l.line,
      `expected \`model: <opus|sonnet|session>[ — <why>]\`, got: ${l.text}`
    );
  }
  const classLine = head.find((h) => /^class:/.test(h.text));
  if (classLine !== undefined && classLine.line + 1 !== l.line) {
    throw new BriefPartError("model", "malformed", l.line, `must sit directly under the class line (line ${classLine.line})`);
  }
  return { model: m[1] as BriefModel, why: m[2]?.trim() ?? null, line: l.line };
}

/** The `budget: <n>h` header line: exactly one, directly under the `model:` line; `<n>` is wall hours
 *  for BUILD plus CLOSE, a positive decimal. */
export function parseBudgetLine(text: string): { hours: number; line: number } {
  const head = header(text);
  const lines = head.filter((l) => /^budget:/.test(l.text));
  if (lines.length === 0) {
    throw new BriefPartError("budget", "missing", null, "missing: no `budget: <n>h` line in the header (it sits directly under `model:`)");
  }
  if (lines.length > 1) throw new BriefPartError("budget", "malformed", lines[1]!.line, "a second `budget:` line");
  const l = lines[0]!;
  const m = BUDGET_LINE_RE.exec(l.text);
  const hours = m ? Number(m[1]) : 0;
  if (!m || !Number.isFinite(hours) || hours <= 0) {
    throw new BriefPartError("budget", "malformed", l.line, `expected \`budget: <n>h\` with <n> a finite number above 0, got: ${l.text}`);
  }
  const modelLine = head.find((h) => /^model:/.test(h.text));
  if (modelLine === undefined || modelLine.line + 1 !== l.line) {
    const where = modelLine === undefined ? "the header has no `model:` line" : `line ${modelLine.line}`;
    throw new BriefPartError("budget", "malformed", l.line, `must sit directly under the model line (${where})`);
  }
  return { hours, line: l.line };
}

/** The `budget:` hours, or null when the header has no `budget:` line; a malformed line throws as
 *  `parseBudgetLine` does. The one reader for a brief that may predate the line. */
export function budgetHoursOrNull(text: string): number | null {
  try {
    return parseBudgetLine(text).hours;
  } catch (err) {
    if (err instanceof BriefPartError && err.kind === "missing") return null;
    throw err;
  }
}

/** `## Target files`: one `- <path or glob>[ — <why>]` per line (backticks stripped), blank lines
 *  allowed, at least one entry. */
export function parseTargetFiles(text: string): string[] {
  const body = section(text, "Target files", "target-files");
  if (body === null) throw new BriefPartError("target-files", "missing", null, "no `## Target files` section");
  const out: string[] = [];
  for (const l of body) {
    if (l.inFence) {
      throw new BriefPartError("target-files", "malformed", l.line, "a fenced block inside the section");
    }
    const t = l.text.replace(/`/g, "");
    if (t.trim() === "") continue;
    const m = TARGET_ENTRY_RE.exec(t);
    if (!m) {
      throw new BriefPartError("target-files", "malformed", l.line, `expected \`- <path>[ — <why>]\`, got: ${l.text}`);
    }
    out.push(m[1]!.replace(/^\.\//, ""));
  }
  if (out.length === 0) throw new BriefPartError("target-files", "malformed", null, "the section lists no file");
  return out;
}

const globCache = new Map<string, RegExp>();

// One target entry as a matcher: `**/` any leading segments, `*` within one segment, a trailing `/`
// a directory prefix, a trailing `/**` everything below. Anything else matches the path exactly.
function targetRegExp(target: string): RegExp {
  const cached = globCache.get(target);
  if (cached) return cached;
  const t = target.replace(/^\.\//, "");
  let src = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (t.startsWith("**/", i)) {
      src += "(?:.*/)?";
      i += 2;
    } else if (t.startsWith("**", i)) {
      src += ".*";
      i += 1;
    } else if (c === "*") src += "[^/]*";
    else src += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  const re = new RegExp(`^${src}${t.endsWith("/") ? ".*" : ""}$`);
  globCache.set(target, re);
  return re;
}

/** Does a repo-relative path fall under a target entry (or any of several)? */
export function matchesTarget(path: string, targets: string | readonly string[]): boolean {
  const p = path.replace(/^\.\//, "");
  return (typeof targets === "string" ? [targets] : targets).some((t) => targetRegExp(t).test(p));
}

/** `## Hand test`: claims (`- H<k> · <says>` with `run:` and `pass:` exactly once, `needs:` at most
 *  once), or `none — <reason>` for 0 claims. */
export function parseHandTestBlock(text: string): HandTestBlock {
  const body = section(text, "Hand test", "hand-test");
  if (body === null) throw new BriefPartError("hand-test", "missing", null, "no `## Hand test` section");
  const claims: Claim[] = [];
  let none: { reason: string; line: number } | null = null;
  let cur: (Omit<Claim, "run" | "pass"> & { run?: string; pass?: string; needsSeen: boolean }) | null = null;
  const bad = (line: number, detail: string) => new BriefPartError("hand-test", "malformed", line, detail);
  const close = () => {
    if (cur === null) return;
    if (cur.run === undefined) throw bad(cur.line, `${cur.id} has no \`  - run: <command>\` line`);
    if (cur.pass === undefined) throw bad(cur.line, `${cur.id} has no \`  - pass: <what passing prints>\` line`);
    claims.push({ id: cur.id, says: cur.says, run: cur.run, pass: cur.pass, needs: cur.needs, line: cur.line });
    cur = null;
  };
  for (const l of body) {
    if (l.inFence) throw bad(l.line, "a fenced block inside the section");
    if (l.text.trim() === "") continue;
    const head = CLAIM_HEAD_RE.exec(l.text);
    if (head) {
      close();
      if (claims.some((c) => c.id === head[1])) throw bad(l.line, `claim id ${head[1]} used twice`);
      cur = { id: head[1]!, says: head[2]!.trim(), needs: [], line: l.line, needsSeen: false };
      continue;
    }
    const noneM = NONE_RE.exec(l.text);
    if (noneM) {
      if (none !== null) throw bad(l.line, "a second `none —` line");
      none = { reason: noneM[1]!.trim(), line: l.line };
      continue;
    }
    if (cur === null) {
      throw bad(l.line, `expected \`- H<k> · <what a user sees>\` or \`none — <reason>\`, got: ${l.text}`);
    }
    const c: NonNullable<typeof cur> = cur;
    const run = CLAIM_RUN_RE.exec(l.text);
    const pass = CLAIM_PASS_RE.exec(l.text);
    const needs = CLAIM_NEEDS_RE.exec(l.text);
    if (run) {
      if (c.run !== undefined) throw bad(l.line, `${c.id} has a second \`run:\` line`);
      c.run = run[1]!.trim().replace(/^`([^`]+)`$/, "$1");
    } else if (pass) {
      if (c.pass !== undefined) throw bad(l.line, `${c.id} has a second \`pass:\` line`);
      c.pass = pass[1]!.trim();
    } else if (needs) {
      if (c.needsSeen) throw bad(l.line, `${c.id} has a second \`needs:\` line`);
      if (needs[2] !== undefined && needs[2] === needs[1]) throw bad(l.line, `${c.id} names \`${needs[1]}\` twice`);
      c.needsSeen = true;
      c.needs = [needs[1] as ClaimNeed, ...(needs[2] ? [needs[2] as ClaimNeed] : [])];
    } else {
      throw bad(
        l.line,
        `under ${c.id}, expected \`  - run: …\`, \`  - pass: …\`, or \`  - needs: stack|sim[, stack|sim]\`, got: ${l.text}`
      );
    }
  }
  close();
  const n: { reason: string; line: number } | null = none;
  if (n !== null && claims.length > 0) throw bad(n.line, "`none —` and claims together");
  if (n === null && claims.length === 0) {
    throw new BriefPartError("hand-test", "malformed", null, "the section lists no claim and no `none — <reason>`");
  }
  return { claims, none: n?.reason ?? null };
}

// ── deliverable positions ─────────────────────────────────────────────────────

// A `- ` bullet or a `1. ` item: about a third of the repo's briefs number their deliverables.
const DELIVERABLE_BULLET_RE = /^(?:-|\d+\.) \S/;
const YAML_FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})\s*ya?ml\s*$/;
const YAML_DELIVERABLES_RE = /^deliverables:\s*(.*?)\s*$/;

interface Bullet {
  /** The bullet line and the indented lines under it, as written; trailing blank lines dropped. */
  lines: string[];
}

/** The top-level `- ` bullets (or `1. ` items) under `## Deliverables`, outside fences. A
 *  deliverable's position is its 1-based index here: the yaml `deliverables:` entries have no id,
 *  so position is the key. */
function deliverableBullets(text: string): Bullet[] {
  const body = section(text, "Deliverables", "parts") ?? [];
  const out: Bullet[] = [];
  let cur: Bullet | null = null;
  for (const l of body) {
    if (!l.inFence && DELIVERABLE_BULLET_RE.test(l.text)) {
      cur = { lines: [l.text] };
      out.push(cur);
    } else if (cur !== null && (l.text.trim() === "" || /^\s/.test(l.text))) {
      cur.lines.push(l.text);
    } else {
      cur = null;
    }
  }
  for (const b of out) while (b.lines.length > 1 && b.lines.at(-1)!.trim() === "") b.lines.pop();
  return out;
}

/** The brief's manifest blocks: each ```yaml fence whose body holds a top-level `deliverables:`
 *  line, with that line's index. A brief may fence other yaml (a config sample); the `deliverables:`
 *  line marks the manifest's, as the repo's `<manifest>` step finds it. */
function manifestBlocks(text: string): { body: ScannedLine[]; at: number }[] {
  const lines = scan(text);
  const out: { body: ScannedLine[]; at: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.fence !== "open" || !YAML_FENCE_RE.test(lines[i]!.text)) continue;
    const body: ScannedLine[] = [];
    for (let j = i + 1; j < lines.length && lines[j]!.inFence && lines[j]!.fence === undefined; j++) body.push(lines[j]!);
    const at = body.findIndex((l) => YAML_DELIVERABLES_RE.test(l.text));
    if (at >= 0) out.push({ body, at });
  }
  return out;
}

/** The manifest's assertion blocks: the manifest step's `ASSERTION_BLOCK_NAMES`, which a
 *  `deliverables:` entry's `covered_by` names. */
const ASSERTION_BLOCK_NAMES = [
  "files_exist",
  "files_absent",
  "files_changed",
  "files_unchanged",
  "exports",
  "tests_assert",
  "schema_parses",
  "no_stub_markers",
  "mutation_proved",
  "command_clean",
  "exercise",
] as const;

/** The top-level yaml keys whose values the verifier grades, in a fixed order. */
const GRADED_YAML_KEYS: readonly string[] = ["deliverables", ...ASSERTION_BLOCK_NAMES];
const YAML_KEY_RE = /^([A-Za-z_][\w-]*):(?:\s|$)/;

/** One manifest block's graded keys: each key's line and every line nested under it, blank and
 *  whole-line comment lines dropped. A key's value runs until the next line at the block's top
 *  level (the `deliverables:` line's indent). Any other top-level key (`description:`,
 *  `touch_only:`) is left out. */
function gradedKeys(body: readonly ScannedLine[], at: number): Record<string, string[]> {
  const indentOf = (t: string) => t.length - t.trimStart().length;
  const top = indentOf(body[at]!.text);
  const found = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const { text: t } of body) {
    if (t.trim() === "" || t.trimStart().startsWith("#")) continue;
    const lead = indentOf(t);
    if (lead > top) {
      cur?.push(t);
      continue;
    }
    const key = lead === top ? YAML_KEY_RE.exec(t.slice(top))?.[1] : undefined;
    if (key === undefined || !GRADED_YAML_KEYS.includes(key)) {
      cur = null;
      continue;
    }
    cur = found.get(key) ?? [];
    found.set(key, cur);
    cur.push(t);
  }
  return Object.fromEntries(GRADED_YAML_KEYS.flatMap((k) => (found.has(k) ? [[k, found.get(k)!]] : [])));
}

/**
 * What the verifier grades in a brief, as one comparable string: in each manifest block, the yaml
 * `deliverables:` array and the assertion blocks (`ASSERTION_BLOCK_NAMES`: `files_exist`,
 * `files_absent`, `files_changed`, `files_unchanged`, `exports`, `tests_assert`, `schema_parses`,
 * `no_stub_markers`, `mutation_proved`, `command_clean`, `exercise`), each key's full value; and the
 * `## Deliverables` list's bullets. An `amend brief:` owes the verifier only when this differs
 * across it; any other yaml key (`description:`, `touch_only:`), a blank or whole-line comment line,
 * the order of the keys, hand-test text, the target list, and design prose are not in it. Throws
 * `BriefPartError` on a second `## Deliverables`.
 */
export function gradedContent(text: string): string {
  return JSON.stringify({
    manifest: manifestBlocks(text).map((b) => gradedKeys(b.body, b.at)),
    deliverables: deliverableBullets(text).map((b) => b.lines),
  });
}

/** The length of the first yaml `deliverables:` block array (in a ```yaml fence), and its line; null
 *  when the brief has none, or writes it in flow form (`[a, b]`), which this scan does not count. */
function yamlDeliverables(text: string): { count: number; line: number } | null {
  for (const { body, at } of manifestBlocks(text)) {
    const value = YAML_DELIVERABLES_RE.exec(body[at]!.text)![1]!;
    if (value === "[]") return { count: 0, line: body[at]!.line };
    if (value !== "" && !value.startsWith("#")) return null;
    let indent: number | null = null;
    let count = 0;
    for (const l of body.slice(at + 1)) {
      const t = l.text;
      if (t.trim() === "" || t.trim().startsWith("#")) continue;
      const lead = t.length - t.trimStart().length;
      const item = /^-(\s|$)/.test(t.trimStart());
      if (indent === null) {
        if (!item) break;
        indent = lead;
      }
      if (lead < indent || (lead === indent && !item)) break;
      if (lead === indent) count++;
    }
    return { count, line: body[at]!.line };
  }
  return null;
}

// ── `## Parts` and `## Test slices` ───────────────────────────────────────────

/** A part's rank when picking the strongest: the header `model:` line is the strongest part's model. */
export const PART_MODEL_RANK: Readonly<Record<BriefModel, number>> = { session: 0, sonnet: 1, opus: 2 };

/** The strongest model among `parts` under `PART_MODEL_RANK`. */
export function strongestModel(parts: readonly { model: BriefModel }[]): BriefModel {
  if (parts.length === 0) throw new Error("strongestModel: no parts");
  return parts.reduce((best, p) => (PART_MODEL_RANK[p.model] > PART_MODEL_RANK[best] ? p.model : best), parts[0]!.model);
}

/** One builder's share of a unit (`## Parts`). A brief with no `## Parts` section has one implicit
 *  part, `P1`, built from the header `model:` line and `## Target files`. */
export interface Part {
  id: string;
  says: string;
  model: BriefModel;
  why: string | null;
  files: string[];
  /** The part's own test files; they need not match `## Target files`. */
  testFiles: string[];
  /** 1-based positions of the `## Deliverables` bullets. */
  deliverables: number[];
  after: string[];
  /** Who writes its tests: the builder, nobody, or the named slices. */
  tests: "builder" | "none" | string[];
  /** 1-based line of the part head; for the implicit P1, the `model:` line. */
  line: number;
}

/** One test writer's share (`## Test slices`). `db` needs the run's database; `plain` none. */
export interface Slice {
  id: string;
  lane: "db" | "plain";
  says: string;
  files: string[];
  covers: number[];
  /** The exported functions (or components) it tests; their count is the slice's size. */
  underTest: string[];
  line: number;
}

const PART_HEAD_RE = /^- (P[1-9]\d*) · (.+)$/;
const SLICE_HEAD_RE = /^- (W[1-9]\d*) · (db|plain) · (.+)$/;
const FIELD_RE = /^ {2}- ([a-z]+(?: [a-z]+)?): (.*)$/;
const PART_MODEL_RE = /^(opus|sonnet|session)(?:\s+—\s+(.+))?$/;
const PART_FIELDS = ["model", "files", "test files", "deliverables", "after", "tests"] as const;
const SLICE_FIELDS = ["files", "covers", "under test"] as const;
const PART_HINT = "- P<k> · <what it builds>";
const SLICE_HINT = "- W<k> · db|plain · <what it tests>";

interface Field {
  value: string;
  line: number;
}

interface Block {
  head: RegExpExecArray;
  line: number;
  fields: Map<string, Field>;
  /** The block as written, trailing blank lines dropped. */
  raw: string[];
}

/** The head-plus-fields blocks of one section, or null when the brief has no such section. Every
 *  field is present exactly once and non-empty; ids are unique; any other line is malformed. */
function readBlocks(
  text: string,
  heading: string,
  part: BriefPart,
  headRe: RegExp,
  headHint: string,
  fields: readonly string[]
): Block[] | null {
  const body = section(text, heading, part);
  if (body === null) return null;
  const bad = (line: number | null, detail: string) => new BriefPartError(part, "malformed", line, detail);
  const out: Block[] = [];
  let cur: Block | null = null;
  const close = () => {
    if (cur === null) return;
    const c: Block = cur;
    for (const f of fields) if (!c.fields.has(f)) throw bad(c.line, `${c.head[1]} has no \`  - ${f}: …\` line`);
    while (c.raw.length > 1 && c.raw.at(-1)!.trim() === "") c.raw.pop();
    out.push(c);
    cur = null;
  };
  for (const l of body) {
    if (l.inFence) throw bad(l.line, "a fenced block inside the section");
    const head = headRe.exec(l.text);
    if (head) {
      close();
      if (out.some((b) => b.head[1] === head[1])) throw bad(l.line, `${head[1]} used twice`);
      cur = { head, line: l.line, fields: new Map(), raw: [l.text] };
      continue;
    }
    const c: Block | null = cur;
    if (l.text.trim() === "") {
      c?.raw.push(l.text);
      continue;
    }
    if (c === null) throw bad(l.line, `expected \`${headHint}\`, got: ${l.text}`);
    const f = FIELD_RE.exec(l.text);
    if (!f || !fields.includes(f[1]!)) {
      throw bad(l.line, `under ${c.head[1]}, expected one of ${fields.map((x) => `\`  - ${x}: …\``).join(", ")}, got: ${l.text}`);
    }
    if (c.fields.has(f[1]!)) throw bad(l.line, `${c.head[1]} has a second \`${f[1]}:\` line`);
    if (f[2]!.trim() === "") throw bad(l.line, `${c.head[1]}'s \`${f[1]}:\` is empty`);
    c.fields.set(f[1]!, { value: f[2]!.trim(), line: l.line });
    c.raw.push(l.text);
  }
  close();
  if (out.length === 0) throw bad(headingLine(text, heading), `the section lists no \`${headHint}\``);
  return out;
}

/** 1-based line of the `## <heading>` outside fences, or null. */
function headingLine(text: string, heading: string): number | null {
  return scan(text).find((l) => !l.inFence && HEADING_RE.exec(l.text)?.[1] === heading)?.line ?? null;
}

/** A comma-separated list, each item trimmed with backticks off; empty or repeated items throw. */
function list(f: Field, owner: string, name: string, part: BriefPart, itemRe: RegExp, hint: string): string[] {
  const items = f.value.split(",").map((e) => e.trim().replace(/`/g, "").replace(/^\.\//, ""));
  for (const e of items) {
    if (!itemRe.test(e)) throw new BriefPartError(part, "malformed", f.line, `${owner}'s \`${name}:\` expected ${hint}, got: ${f.value}`);
  }
  const dup = items.find((e, i) => items.indexOf(e) !== i);
  if (dup !== undefined) throw new BriefPartError(part, "malformed", f.line, `${owner}'s \`${name}:\` names ${dup} twice`);
  return items;
}

const PATH_ITEM_RE = /^\S+$/;
const PATHS_HINT = "`<path or glob>, …`";

/** Deliverable positions: each one names a `## Deliverables` bullet. */
function positions(f: Field, owner: string, name: string, part: BriefPart, bullets: number): number[] {
  const out = list(f, owner, name, part, /^[1-9]\d*$/, "`<n>, <n>…` (1-based deliverable positions)").map(Number);
  const past = out.find((n) => n > bullets);
  if (past !== undefined) {
    throw new BriefPartError(part, "malformed", f.line, `${owner}'s \`${name}:\` names deliverable ${past}; \`## Deliverables\` has ${bullets} top-level bullet${bullets === 1 ? "" : "s"}`);
  }
  return out;
}

/** `## Test slices`: `- W<k> · db|plain · <says>` with `files:`, `covers:`, and `under test:`, or `[]`
 *  when the brief has no such section. Slice files are exclusive across slices. */
export function parseTestSlices(text: string): Slice[] {
  const blocks = readBlocks(text, "Test slices", "test-slices", SLICE_HEAD_RE, SLICE_HINT, SLICE_FIELDS);
  if (blocks === null) return [];
  const bullets = deliverableBullets(text).length;
  const slices = blocks.map((b): Slice => {
    const id = b.head[1]!;
    const field = (name: string) => b.fields.get(name)!;
    return {
      id,
      lane: b.head[2] as Slice["lane"],
      says: b.head[3]!.trim(),
      files: list(field("files"), id, "files", "test-slices", PATH_ITEM_RE, PATHS_HINT),
      covers: positions(field("covers"), id, "covers", "test-slices", bullets),
      underTest: list(field("under test"), id, "under test", "test-slices", /^\S(?:.*\S)?$/, "`<function>, …`"),
      line: b.line,
    };
  });
  for (const [i, a] of slices.entries()) {
    for (const b of slices.slice(i + 1)) {
      const hit = sharedEntry(a.files, b.files);
      if (hit) {
        throw new BriefPartError("test-slices", "malformed", blocks[slices.indexOf(b)]!.fields.get("files")!.line, `${b.id} and ${a.id} share ${hit[1]} — ${hit[0]}: a slice's files are its own`);
      }
    }
  }
  return slices;
}

const isGlob = (e: string) => e.includes("*") || e.endsWith("/");
const fixedPrefix = (e: string) => (e.includes("*") ? e.slice(0, e.indexOf("*")) : e);

/** Two entries (paths or globs) that can name one file: equal, one matched by the other, or two
 *  globs whose fixed prefixes (the text before the first `*`) are one a prefix of the other. */
function entriesOverlap(a: string, b: string): boolean {
  if (a === b || matchesTarget(a, b) || matchesTarget(b, a)) return true;
  if (!isGlob(a) || !isGlob(b)) return false;
  const [pa, pb] = [fixedPrefix(a), fixedPrefix(b)];
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** The first pair of overlapping entries across two lists, as `[from a, from b]`, or null. */
function sharedEntry(a: readonly string[], b: readonly string[]): [string, string] | null {
  for (const x of a) for (const y of b) if (entriesOverlap(x, y)) return [x, y];
  return null;
}

/**
 * Check 4: positions stay stable. When the brief holds the yaml `deliverables:` array, its length
 * equals the count of top-level prose bullets under `## Deliverables` — an `amend brief:` adds a
 * deliverable only at the end, in both lists.
 */
function checkPositionsStable(text: string, bullets: number): void {
  const yaml = yamlDeliverables(text);
  if (yaml !== null && yaml.count !== bullets) {
    throw new BriefPartError(
      "parts",
      "malformed",
      yaml.line,
      `the yaml \`deliverables:\` array has ${yaml.count} entries and \`## Deliverables\` has ${bullets} top-level bullets — a deliverable is added only at the end, in both lists`
    );
  }
}

/**
 * `## Parts`, cross-checked against the header `model:` line, `## Target files`, `## Deliverables`,
 * and `## Test slices`. With no `## Parts` section, the one implicit `P1`: the header model, the
 * target files, every deliverable, `after: none`, and `tests:` the slices when the brief has any,
 * else `builder`.
 */
export function parseParts(text: string): Part[] {
  const blocks = readBlocks(text, "Parts", "parts", PART_HEAD_RE, PART_HINT, PART_FIELDS);
  const header = parseModelLine(text);
  const targets = parseTargetFiles(text);
  const slices = parseTestSlices(text);
  const bullets = deliverableBullets(text).length;
  if (blocks !== null || slices.length > 0) checkPositionsStable(text, bullets);
  if (blocks === null) {
    return [
      {
        id: "P1",
        says: "the whole unit (no `## Parts` section)",
        model: header.model,
        why: header.why,
        files: targets,
        testFiles: [],
        deliverables: Array.from({ length: bullets }, (_, i) => i + 1),
        after: [],
        tests: slices.length > 0 ? slices.map((s) => s.id) : "builder",
        line: header.line,
      },
    ];
  }
  const bad = (line: number | null, detail: string) => new BriefPartError("parts", "malformed", line, detail);
  const parts = blocks.map((b): Part => {
    const id = b.head[1]!;
    const field = (name: string) => b.fields.get(name)!;
    const model = PART_MODEL_RE.exec(field("model").value);
    if (!model) throw bad(field("model").line, `${id}'s \`model:\` expected \`opus|sonnet|session[ — <why>]\`, got: ${field("model").value}`);
    const files = list(field("files"), id, "files", "parts", PATH_ITEM_RE, PATHS_HINT);
    const outside = files.find((f) => !targets.includes(f) && !matchesTarget(f, targets));
    if (outside !== undefined) {
      throw bad(field("files").line, `${id}'s \`files:\` names ${outside}, which no \`## Target files\` entry equals or matches`);
    }
    const testFiles = field("test files").value === "none" ? [] : list(field("test files"), id, "test files", "parts", PATH_ITEM_RE, PATHS_HINT);
    const after = field("after").value === "none" ? [] : list(field("after"), id, "after", "parts", /^P[1-9]\d*$/, "`none` or `P<k>, …`");
    const tv = field("tests").value;
    const tests: Part["tests"] =
      tv === "builder" || tv === "none" ? tv : list(field("tests"), id, "tests", "parts", /^W[1-9]\d*$/, "`builder`, `none`, or `W<k>, …`");
    return {
      id,
      says: b.head[2]!.trim(),
      model: model[1] as BriefModel,
      why: model[2]?.trim() ?? null,
      files,
      testFiles,
      deliverables: positions(field("deliverables"), id, "deliverables", "parts", bullets),
      after,
      tests,
      line: b.line,
    };
  });
  const fieldLine = (p: Part, name: string) => blocks[parts.indexOf(p)]!.fields.get(name)!.line;
  const byId = new Map(parts.map((p) => [p.id, p]));

  for (const p of parts) {
    for (const a of p.after) {
      if (a === p.id) throw bad(fieldLine(p, "after"), `${p.id} waits for itself`);
      if (!byId.has(a)) throw bad(fieldLine(p, "after"), `${p.id} waits for ${a}, which is not a part`);
    }
  }
  // Every part's transitive `after:` set; a part in its own set is a cycle.
  const before = new Map<string, Set<string>>();
  const walk = (p: Part, path: string[]): Set<string> => {
    const known = before.get(p.id);
    if (known) return known;
    if (path.includes(p.id)) {
      throw bad(fieldLine(p, "after"), `\`after:\` cycle ${[...path.slice(path.indexOf(p.id)), p.id].join(" → ")}`);
    }
    const out = new Set<string>();
    for (const a of p.after) {
      out.add(a);
      for (const x of walk(byId.get(a)!, [...path, p.id])) out.add(x);
    }
    before.set(p.id, out);
    return out;
  };
  for (const p of parts) walk(p, []);

  for (let n = 1; n <= bullets; n++) {
    const owners = parts.filter((p) => p.deliverables.includes(n));
    if (owners.length === 0) throw bad(headingLine(text, "Parts"), `deliverable ${n} is in no part — every deliverable is in exactly one`);
    if (owners.length > 1) {
      throw bad(fieldLine(owners[1]!, "deliverables"), `deliverable ${n} is in ${owners.map((p) => p.id).join(" and ")} — every deliverable is in exactly one`);
    }
  }

  // Check 1: two parts with no `after:` path between them share no file.
  const own = (p: Part) => [...p.files, ...p.testFiles];
  for (const [i, a] of parts.entries()) {
    for (const b of parts.slice(i + 1)) {
      if (before.get(a.id)!.has(b.id) || before.get(b.id)!.has(a.id)) continue;
      const hit = sharedEntry(own(a), own(b));
      if (hit) {
        const where = b.files.includes(hit[1]) ? "files" : "test files";
        throw bad(
          fieldLine(b, where),
          `${a.id} and ${b.id} run side by side (no \`after:\` path between them) and share ${hit[0]} (${a.id}) — ${hit[1]} (${b.id})`
        );
      }
    }
  }

  // Check 2: the header is the strongest part.
  const strongest = strongestModel(parts);
  if (header.model !== strongest) {
    const who = parts.filter((p) => p.model === strongest).map((p) => p.id).join(", ");
    throw bad(header.line, `the header says \`model: ${header.model}\`; the strongest part model is ${strongest} (${who}) — the header line names the strongest part`);
  }

  // Check 3: every named slice exists; every slice is named by exactly one part.
  const sliceIds = new Set(slices.map((s) => s.id));
  for (const p of parts) {
    if (!Array.isArray(p.tests)) continue;
    const missing = p.tests.find((w) => !sliceIds.has(w));
    if (missing !== undefined) throw bad(fieldLine(p, "tests"), `${p.id}'s \`tests:\` names ${missing}, which \`## Test slices\` does not hold`);
  }
  for (const s of slices) {
    const namers = parts.filter((p) => Array.isArray(p.tests) && p.tests.includes(s.id));
    if (namers.length !== 1) {
      throw bad(namers[1] ? fieldLine(namers[1], "tests") : s.line, `${s.id} is named by ${namers.length === 0 ? "no part" : namers.map((p) => p.id).join(" and ")} — every slice is named by exactly one part's \`tests:\``);
    }
    for (const p of parts) {
      const hit = sharedEntry(own(p), s.files);
      if (hit) throw bad(s.line, `${s.id}'s file ${hit[1]} is also ${p.id}'s ${hit[0]} — a slice's files are never a part's`);
    }
  }
  return parts;
}

/**
 * A test writer's excerpt of the brief (plan §3.8, "its slice of the brief, not the whole brief"):
 * the slice block; each covered deliverable bullet verbatim, with its position; the whole
 * `## Public surface` section; and `## Locked decisions` when the brief has one. Null when the brief
 * has no slice `id`. Throws what `parseParts` throws.
 */
export function sliceExcerpt(text: string, id: string): string | null {
  parseParts(text);
  const block = readBlocks(text, "Test slices", "test-slices", SLICE_HEAD_RE, SLICE_HINT, SLICE_FIELDS)?.find((b) => b.head[1] === id);
  if (block === undefined) return null;
  const slice = parseTestSlices(text).find((s) => s.id === id)!;
  const bullets = deliverableBullets(text);
  const whole = (heading: string): string[] | null => {
    const body = section(text, heading, "parts");
    if (body === null) return null;
    const lines = body.map((l) => l.text);
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    return [`## ${heading}`, ...lines];
  };
  const out = ["## Test slices", "", ...block.raw, "", "## Deliverables (the ones this slice covers, by position)", ""];
  for (const n of slice.covers) out.push(`deliverable ${n} of ${bullets.length}:`, ...bullets[n - 1]!.lines, "");
  out.push(...(whole("Public surface") ?? ["## Public surface", "", "(the brief has no `## Public surface` section)"]));
  const locked = whole("Locked decisions");
  if (locked !== null) out.push("", ...locked);
  return `${out.join("\n")}\n`;
}

/** The class moment's pinned line: `class: R<n> — <who>, <date>`; `<who>` is
 *  `agent (unconfirmed)` when the agent picked it. The dateless `(agent, unconfirmed)` form is still read, for a run pinned
 *  before the one form. A repo's brief-header check may refuse any other form at push, so the
 *  `--from-branch` hand-test file must open with this one. */
export const PINNED_CLASS_LINE_RE = /^class:\s*R[0-2]\s+(—\s+\S.*,\s*\d{4}-\d{2}-\d{2}|\(agent, unconfirmed\))/;

/** A brief, or the `--from-branch` hand-test file (its only `## ` section is `## Hand test`). */
export type BriefKind = "brief" | "hand-test-block";

export interface BriefSummary {
  kind: BriefKind;
  cls: RiskClass | null;
  model: BriefModel | null;
  why: string | null;
  targets: string[] | null;
  claims: Claim[];
  /** The brief's parts: the implicit P1 when it has no `## Parts` section; none on a hand-test
   *  file, or on a legacy read missing the model line or the target files. */
  parts: Part[];
  /** True when the brief has a `## Parts` section (the ledger owes `parts=` only then). */
  partsDeclared: boolean;
  slices: Slice[];
  /** The `budget:` line's hours; null when the brief has none (or on a hand-test file). */
  budget: number | null;
  /** Set when a missing part was read as a brief from before the parts existed (`legacyOk`). */
  legacy: BriefPart[];
}

/** Read every part of a brief or a `--from-branch` hand-test file, throwing the first
 *  `BriefPartError`. With `legacyOk` (a first-commit read), a missing part counts as the brief
 *  predating it — 0 claims, no model, no targets — and is listed in `legacy`; a malformed part
 *  still throws. The hand-test file must start with its pinned class line. */
export function summariseBrief(text: string, opts: { legacyOk?: boolean } = {}): BriefSummary {
  const cls = parseClassLine(text)?.cls ?? null;
  const headings = sectionHeadings(text);
  const hasModel = header(text).some((l) => /^model:/.test(l.text));
  const kind: BriefKind =
    headings.length === 1 && headings[0] === "Hand test" && !hasModel ? "hand-test-block" : "brief";
  const legacy: BriefPart[] = [];
  const tolerate = <T>(part: BriefPart, read: () => T, empty: T): T => {
    try {
      return read();
    } catch (err) {
      if (opts.legacyOk && err instanceof BriefPartError && err.kind === "missing") {
        legacy.push(part);
        return empty;
      }
      throw err;
    }
  };
  if (kind === "hand-test-block") {
    const first = scan(text).find((l) => l.text.trim() !== "");
    if (cls === null || first === undefined || !PINNED_CLASS_LINE_RE.test(first.text)) {
      throw new BriefPartError(
        "class",
        "missing",
        first?.line ?? null,
        "the --from-branch hand-test file starts with the pinned class line (`class: R<n> — <who>, <date>`)"
      );
    }
    const claims = parseHandTestBlock(text).claims;
    return { kind, cls, model: null, why: null, targets: null, claims, parts: [], partsDeclared: false, slices: [], budget: null, legacy };
  }
  const model = tolerate<{ model: BriefModel | null; why: string | null }>(
    "model",
    () => parseModelLine(text),
    { model: null, why: null }
  );
  // Optional with or without legacyOk: this is also the gate's HEAD read, and an in-flight brief may
  // predate the line. briefCheck refuses its absence.
  const budget = budgetHoursOrNull(text);
  const targets = tolerate<string[] | null>("target-files", () => parseTargetFiles(text), null);
  const claims = tolerate<Claim[]>("hand-test", () => parseHandTestBlock(text).claims, []);
  const parts = model.model === null || targets === null ? [] : parseParts(text);
  const partsDeclared = headings.includes("Parts");
  const slices = parseTestSlices(text);
  return { kind, cls, model: model.model, why: model.why, targets, claims, parts, partsDeclared, slices, budget, legacy };
}
