#!/usr/bin/env node
/**
 * ledgerLine — writes one line of the ship ledger (`<run-dir>/ship.md`), so the session never
 * types one (CLOSE §The steps). It builds the line from its arguments, checks the whole ledger
 * with the gate's own parser (`parseLedger`, `lib/ledger.ts` — the one grammar), and writes only a
 * ledger the gate can read.
 *
 *   node ~/.agent-build/runtime/ledgerLine.ts --ledger <run-dir>/ship.md <move> ["<text segment>"…] [--<key> <value>…]
 *   node ~/.agent-build/runtime/ledgerLine.ts --ledger <run-dir>/ship.md --replace <move> …
 *   node ~/.agent-build/runtime/ledgerLine.ts --ledger <run-dir>/ship.md --remove <move>
 *
 * Each `|`-separated text segment of a line is one argument; each `key=value` field is
 * `--key value`. `sha`, `from`, and `measured-at` take a sha or the word `head`, read from the
 * cwd's HEAD. `wave: review-cursory, build-verifier | skipped: simplifier — 40 < 100 | sha=<head>` is
 *   … wave "review-cursory, build-verifier" "skipped: simplifier — 40 < 100" --sha head
 *
 * The first line written is `class`: it creates the file and puts `flow: 2` under it. A move that
 * already has a different line is refused; `--replace` rewrites the move's last line in place (a
 * redone step, an operator's class veto), and `--remove` deletes it. A line that already stands
 * word for word is left alone. Every other line is kept as written.
 *
 * Two calls on one ledger never lose a line: each holds `<ledger>.lock` from its read to its write,
 * and the other waits.
 *
 * Exit 0 = written (`wrote:`, `replaced:`, `removed:`, `unchanged:` name each line). Exit 1 =
 * refused, the file untouched: the parser's message for what is wrong with the line itself, plus
 * the move's standing line when it has one. Exit 2 = usage, HEAD unreadable, or the lock never came free.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { assertKnownFlags } from "./lib/cliArgs.ts";
import { gitOut } from "./lib/gitOps.ts";
import { isMain } from "./lib/isMain.ts";
import { LEDGER_KEYS, type LedgerKey, ledgerMoveOf, parseLedger } from "./lib/ledger.ts";

const SHA_KEYS: readonly LedgerKey[] = ["sha", "from", "measured-at"];
const MODE_FLAGS = ["--replace", "--remove"] as const;
const FLOW_LINE = "flow: 2";
/** A call holds the lock for one read and one write, so a wait this long means a dead call left it. */
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

export type Mode = "add" | "replace" | "remove";

export interface LineArgs {
  ledger: string;
  mode: Mode;
  move: string;
  text: string[];
  /** In the order given, which is the order written. */
  fields: [LedgerKey, string][];
}

const USAGE =
  'usage: ledgerLine.ts --ledger <run-dir>/ship.md [--replace | --remove] <move> ["<text segment>"…] [--<key> <value>…]' +
  ` — keys: ${LEDGER_KEYS.join(", ")}; sha, from, and measured-at take a sha or \`head\``;

/** Parses argv. Throws on anything a typo could turn into a wrong line. */
export function parseArgs(argv: string[]): LineArgs {
  assertKnownFlags(argv, ["--ledger", ...MODE_FLAGS, ...LEDGER_KEYS.map((k) => `--${k}`)]);
  let ledger: string | undefined;
  const modes: string[] = [];
  const positional: string[] = [];
  const fields: [LedgerKey, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((MODE_FLAGS as readonly string[]).includes(arg)) {
      modes.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value, got ${value ?? "(missing)"}`);
    }
    if (arg === "--ledger") {
      if (ledger !== undefined) throw new Error("--ledger is given twice");
      ledger = value;
      continue;
    }
    const key = arg.slice(2) as LedgerKey;
    if (fields.some(([k]) => k === key)) throw new Error(`${arg} is given twice`);
    fields.push([key, value]);
  }
  if (ledger === undefined) throw new Error("needs --ledger <path to the run's ship.md>");
  if (modes.length > 1) throw new Error(`${modes.join(" and ")} are two actions — pick one`);
  const [move, ...text] = positional;
  if (move === undefined) throw new Error("names no move");
  if (ledgerMoveOf(move) === null) {
    throw new Error(`\`${move}\` is not a ledger move (\`hand-test-<n>\` is written \`hand-test-1\`, \`hand-test-2\`, …)`);
  }
  for (const segment of text) {
    if (segment.trim().length === 0) throw new Error("a text segment is empty");
    if (/[|\n]/.test(segment)) {
      throw new Error(`\`${segment}\` holds a \`|\` or a line break — pass each \`|\`-separated segment as its own argument`);
    }
  }
  const mode: Mode = modes[0] === "--replace" ? "replace" : modes[0] === "--remove" ? "remove" : "add";
  if (mode === "remove" && (text.length > 0 || fields.length > 0)) {
    throw new Error("--remove takes the move alone");
  }
  if (move === "banked" && fields.length > 0) throw new Error("`banked:` takes no fields — its ids are one text segment");
  if (move === "leftovers" && mode !== "remove" && !fields.some(([k]) => k === "scope")) {
    throw new Error("a `leftovers:` line names its plan or session — --scope plan-<the plan's epic id> or --scope session-<first 8 characters of the session id> (CLOSE step 13)");
  }
  if (move === "class" && fields.some(([k]) => k !== "measured-at")) {
    throw new Error("`class:` takes only --measured-at");
  }
  return { ledger, mode, move, text: text.map((s) => s.trim()), fields };
}

/** One ledger line: `<move>: <text> | … | <key>=<value> | …`. A move with no text starts at its
 *  first field (`drift-merge: from=… | sha=…`): the parser reads it as it reads the skill's
 *  `drift-merge: | from=… | sha=…`. */
export function composeLine(move: string, text: readonly string[], fields: readonly (readonly [string, string])[]): string {
  const segments = [...text, ...fields.map(([k, v]) => `${k}=${v}`)];
  return segments.length === 0 ? `${move}:` : `${move}: ${segments.join(" | ")}`;
}

/** The move a row writes, read as the parser reads a row (trimmed, a list bullet dropped). */
function moveOfRow(row: string): string | null {
  return /^([a-z][a-z0-9-]*):/.exec(row.trim().replace(/^[-*]\s+/, ""))?.[1] ?? null;
}

function lastRowOf(rows: readonly string[], move: string): number {
  return rows.findLastIndex((row) => moveOfRow(row) === move);
}

interface Change {
  wrote: string[];
  replaced: string | null;
  removed: string | null;
  /** The line already stood, word for word: nothing was written. */
  unchanged: string | null;
}
const NO_CHANGE: Change = { wrote: [], replaced: null, removed: null, unchanged: null };

export type Applied = ({ ok: true; text: string } & Change) | { ok: false; why: string };

const join = (rows: readonly string[]) => `${rows.join("\n")}\n`;

/**
 * The ledger text after one change, or the refusal. Pure: `existing` is the file's text, or null
 * when there is no file (an empty file is no ledger). An accepted result always parses.
 */
export function applyLine(existing: string | null, mode: Mode, move: string, line: string): Applied {
  if (existing === null || existing.trim().length === 0) {
    if (move !== "class" || mode !== "add") {
      return {
        ok: false,
        why: 'there is no ledger yet — its first line is the class line: `class "R<n> — <who>, <YYYY-MM-DD>" --measured-at head`',
      };
    }
    return checked(null, join([line, FLOW_LINE]), { ...NO_CHANGE, wrote: [line, FLOW_LINE] });
  }
  const rows = existing.replace(/\n+$/, "").split("\n");
  const at = lastRowOf(rows, move);
  const old = at === -1 ? null : rows[at]!;
  if (mode === "add") {
    if (old !== null && old.trim() === line) return { ok: true, text: existing, ...NO_CHANGE, unchanged: line };
    const added = checked(existing, join([...rows, line]), { ...NO_CHANGE, wrote: [line] });
    if (added.ok || old === null || refusalOf(existing) !== null) return added;
    // A once-only move's standing line refuses the new one before the parser reads it, so read the
    // new line in the standing line's place: the refusal names what is wrong with the line itself.
    const inPlace = refusalOf(join(rows.with(at, line)));
    const standing = `the ledger holds \`${old.trim()}\``;
    if (inPlace === null) return { ok: false, why: `${added.why} — ${standing}; \`--replace\` rewrites it` };
    if (inPlace !== added.why) return { ok: false, why: `${inPlace} — and ${standing}: once the line reads, \`--replace\` rewrites it` };
    return added;
  }
  if (old === null) return { ok: false, why: `the ledger has no \`${move}:\` line to ${mode}` };
  if (mode === "replace") return checked(existing, join(rows.with(at, line)), { ...NO_CHANGE, wrote: [line], replaced: old });
  if (move === "class" || move === "flow") {
    return { ok: false, why: `the \`${move}:\` line is never removed — \`--replace\` rewrites it` };
  }
  return checked(existing, join(rows.toSpliced(at, 1)), { ...NO_CHANGE, removed: old });
}

/** Runs the gate's parser over `next`, and says so when the ledger could not be read before this
 *  change either. */
function checked(before: string | null, next: string, change: Change): Applied {
  const refusal = refusalOf(next);
  if (refusal === null) return { ok: true, text: next, ...change };
  if (before !== null && refusalOf(before) === refusal) {
    return {
      ok: false,
      why: `the ledger could not be read before this line: ${refusal} — fix that line first (\`--replace\` or \`--remove\`)`,
    };
  }
  return { ok: false, why: refusal };
}

function refusalOf(text: string): string | null {
  try {
    parseLedger(text);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

class LockBusy extends Error {}

/**
 * Runs `fn` while holding `<path>.lock`, so one call's read and write never interleave with
 * another's. A lock left by a killed call is never stolen (two waiters stealing at once would both
 * hold it): the wait runs out and the message names the file to delete.
 */
function withLock<T>(path: string, waitMs: number, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        throw new LockBusy(`another ledgerLine call holds ${lock} — nothing was written; if none is running, delete that file and run this again`);
      }
      Atomics.wait(pause, 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export interface MainDeps {
  /** The cwd's HEAD sha. Default: `git rev-parse HEAD`. */
  head?: (cwd: string) => string;
  /** How long to wait for another call's lock. Default: `LOCK_WAIT_MS`. */
  lockWaitMs?: number;
}

export function main(argv: string[], cwd = process.cwd(), out = (l: string) => console.log(l), deps: MainDeps = {}): number {
  let args: LineArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`ledgerLine: ${(err as Error).message}`);
    console.error(USAGE);
    return 2;
  }
  let fields: [string, string][];
  try {
    let head: string | undefined;
    const readHead = deps.head ?? ((dir: string) => gitOut(["rev-parse", "HEAD"], { cwd: dir }).trim());
    fields = args.fields.map(([key, value]) => {
      if (!SHA_KEYS.includes(key) || value.toLowerCase() !== "head") return [key, value];
      head ??= readHead(cwd);
      return [key, head];
    });
  } catch (err) {
    console.error(`ledgerLine: could not read HEAD here — ${(err as Error).message.trim()}`);
    return 2;
  }
  const path = resolve(cwd, args.ledger);
  const line = composeLine(args.move, args.text, fields);
  const refuse = (why: string) => {
    console.error(`ledgerLine: refused — ${why}`);
    return 1;
  };
  // No folder means no ledger: only a class line that reads may make it, so a refusal makes none.
  if (!existsSync(dirname(path))) {
    const first = applyLine(null, args.mode, args.move, line);
    if (!first.ok) return refuse(first.why);
    mkdirSync(dirname(path), { recursive: true });
  }
  let applied: Applied;
  try {
    applied = withLock(path, deps.lockWaitMs ?? LOCK_WAIT_MS, () => {
      const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
      const next = applyLine(existing, args.mode, args.move, line);
      if (next.ok && next.unchanged === null) {
        const tmp = `${path}.tmp-${process.pid}`;
        writeFileSync(tmp, next.text);
        renameSync(tmp, path);
      }
      return next;
    });
  } catch (err) {
    if (!(err instanceof LockBusy)) throw err;
    console.error(`ledgerLine: ${err.message}`);
    return 2;
  }
  if (!applied.ok) return refuse(applied.why);
  if (applied.unchanged !== null) {
    out(`unchanged: ${applied.unchanged}`);
    return 0;
  }
  if (applied.replaced !== null) out(`replaced: ${applied.replaced.trim()}`);
  if (applied.removed !== null) out(`removed: ${applied.removed.trim()}`);
  for (const line of applied.wrote) out(`wrote: ${line}`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
