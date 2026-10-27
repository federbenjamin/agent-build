/**
 * Code-side shaping of a diff before a classifier reads it, as tuned for the setups in
 * `graph/classifiers/`: keep production code only, and optionally only the hunks whose added lines
 * handle errors, call an outside process or service, parse outside output, do async work, or write
 * files or data; or leave out tests, docs and lockfiles as the hunter's round-4 tuning did
 * (`no-tests-docs-locks`); or keep production code plus the config files a security read needs
 * (`security-surface`). The patterns are the tuned ones; a change to one invalidates the cut-offs.
 */

import { NO_DIFF_LEFT, NO_PRODUCTION_CODE } from "../constants.ts";
import type { DiffShape } from "../contracts.ts";

interface Hunk {
  head: string;
  lines: string[];
}
interface DiffFile {
  path: string;
  header: string[];
  hunks: Hunk[];
}

/** A git C-quoted name (`"a/caf\303\251"`) as text. */
function unquote(quoted: string): string {
  const bytes: number[] = [];
  const body = quoted.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i]!, "utf8"));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += oct[0].length;
    } else {
      bytes.push(escapes[body[i + 1]!] ?? body.charCodeAt(i + 1));
      i++;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The first C-quoted token at the start of `s`, or null. */
function quotedPrefix(s: string): string | null {
  if (!s.startsWith('"')) return null;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return s.slice(0, i + 1);
  }
  return null;
}

/** The new path of a `diff --git a/<old> b/<new>` header. Git quotes names with special bytes, and
 *  leaves spaces bare, so `a/my file.ts b/my file.ts` is split where both halves are the same name
 *  (any rename's real name is on its `+++` line, which the caller reads). */
export function headerPath(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  const first = quotedPrefix(rest);
  if (first !== null) {
    const second = rest.slice(first.length + 1);
    const name = second.startsWith('"') ? unquote(quotedPrefix(second) ?? second) : second;
    return name.replace(/^b\//, "");
  }
  const quotedB = rest.indexOf(' "b/');
  if (quotedB >= 0) return unquote(quotedPrefix(rest.slice(quotedB + 1)) ?? rest.slice(quotedB + 1)).replace(/^b\//, "");
  const half = (rest.length - " a/ b/".length + 1) / 2;
  if (Number.isInteger(half) && rest.startsWith("a/") && rest.slice(2 + half, 2 + half + 3) === " b/" && rest.slice(2, 2 + half) === rest.slice(2 + half + 3)) {
    return rest.slice(2 + half + 3);
  }
  const m = /^a\/(\S+) b\/(.+)$/.exec(rest);
  return m === null ? null : m[2]!;
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = headerPath(line);
      file = { path: path ?? "", header: [line], hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file !== null && hunk === null && line.startsWith("+++ ") && line !== "+++ /dev/null") {
      const name = line.slice(4).replace(/\t$/, "");
      file.path = (name.startsWith('"') ? unquote(name) : name).replace(/^b\//, "");
    }
    if (file === null) continue;
    if (line.startsWith("@@")) {
      hunk = { head: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk !== null) hunk.lines.push(line);
    else file.header.push(line);
  }
  return files;
}

const TEST = /(^|\/)(__tests__|__mocks__|tests?|testutil|testing|fixtures?|herdrtest|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|\.bats$|(^|\/)conftest\.py$/i;
const DOC = /\.(md|mdx|txt|rst)$|(^|\/)docs?\//i;
const LOCKFILE = /(^|\/)(package-lock|pnpm-lock|yarn\.lock|go\.sum)|\.(lock|sum)$/i;
const CONFIG = /\.(json|jsonc|toml|ya?ml|plist)$/i;
const OTHER_DATA = /\.(podspec|svg|png|csv|snap)$|(^|\/)\.gitignore$|(^|\/)LICENSE/i;
const GENERATED = /(^|\/)generated\//;

const isData = (path: string): boolean => CONFIG.test(path) || LOCKFILE.test(path) || OTHER_DATA.test(path);

/** Not a test, a doc, or a generated copy: what both production-code and security-surface start from. */
const isNotTestDocOrGenerated = (path: string): boolean => !TEST.test(path) && !DOC.test(path) && !GENERATED.test(path);

/** Whether `path` is production code: not a test, doc, generated copy, or data and config file. */
export const isProductionPath = (path: string): boolean => isNotTestDocOrGenerated(path) && !isData(path);

/** The config files a security read keeps wherever they are: CI workflows, plists, and `config.toml`
 *  (Supabase's auth settings live there). An env example is not a data file, so both shapes keep it. */
const SECURITY_CONFIG = /(^|\/)\.github\/workflows\/|\.plist$|(^|\/)config\.toml$/i;
/** A path word that puts a config file on the auth or RLS surface; `author` and `authoring` are not. */
const SURFACE_WORD = /^(o?auth\d*|auth[nz]|authenticat[a-z]*|authori[sz][a-z]*|rls)$/;
const pathWords = (path: string): string[] => path.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);

/** A config file on the security surface: one of `SECURITY_CONFIG`, or a config file with an auth or
 *  RLS word in its path. Never a lockfile, and never another data file (a binary asset, a snapshot). */
const onSecuritySurface = (path: string): boolean =>
  CONFIG.test(path) && !LOCKFILE.test(path) && (SECURITY_CONFIG.test(path) || pathWords(path).some((w) => SURFACE_WORD.test(w)));

/** Production code, or a config file on the security surface (still not a test, doc or generated copy). */
const isSecurityPath = (path: string): boolean => isNotTestDocOrGenerated(path) && (!isData(path) || onSecuritySurface(path));

const RISKY = new RegExp(
  [
    // error_handling
    String.raw`\bcatch\b|\bexcept\b|\brecover\(|err\s*!=\s*nil|\|\|\s*(true|:|return|exit)|2>\s*\/dev\/null|\.catch\(|on\(['"]error|\bfinally\b|\bfallback\b|\btrap\b`,
    // swallowed_or_defaulted
    String.raw`catch\s*(\([^)]*\))?\s*\{\s*\}|catch\s*\{\s*(return\s*[^;}]*;?\s*)?\}|except[^:]*:\s*(pass|return\b|continue)|\|\|\s*true|2>\s*\/dev\/null|\b_\s*(,\s*_)?\s*=\s*\w|\?\?\s*(\[\]|\{\}|''|""|null|0|false|undefined)|\bor\s*(\[\]|\{\}|''|""|None|0)\b|\|\|\s*(\[\]|\{\}|''|""|0)\b|\.catch\(\s*\(\)\s*=>`,
    // outside_process_or_service
    String.raw`\bspawn\w*\(|\bexec\w*\(|execFile|subprocess|exec\.Command|\$\(|\bfetch\(|\bhttp\.|axios|\.rpc\(|\.from\(['"]|supabase\.|\bcurl\b|\bgh\s|\bgit\s|\bherdr\s|\bclaude\s|\bcodex\s|requests\.|urlopen|\.run\(\[`,
    // parses_outside_output
    String.raw`JSON\.parse|json\.loads?|json\.Unmarshal|Unmarshal\(|\bjq\b|parseInt|parseFloat|\.split\(|\.match\(|re\.(match|search|findall)|regexp\.|plistlib\.load|yaml\.(safe_)?load|toml\.|Number\(`,
    // writes_files_or_db
    String.raw`writeFile|appendFile|\brename\w*\(|unlink|\brm\s+-|\bmv\s|os\.(WriteFile|Remove|Rename|Create)|\.Truncate|\bopen\([^)]*['"][wa]|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b|mkdir|plistlib\.dump|>\s*"?\$`,
    // async_or_background
    String.raw`\bawait\b|\bPromise\b|\bgo\s+func|\bsetTimeout|\.then\(|\bnohup\b|&\s*$|\bdetached\b|unref\(|asyncio|threading|\bvoid\s+\w+\(`,
  ].join("|")
);

const addedLines = (h: Hunk): string[] => h.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));

const render = (f: DiffFile, hunks: Hunk[]): string => [...f.header, ...hunks.flatMap((h) => [h.head, ...h.lines])].join("\n");

/** The hunter's round-4 filter, as its inputs were built (`build_fresh.py`'s `filter_diff`): the
 *  diff's file chunks as they are, newlines and all, less each whose `diff --git` line's `b/` path is a
 *  test, a doc (any `.md` or `.txt`, any case) or a lockfile; a header the pattern does not parse (a
 *  quoted path) is kept. Text before the first file (the diff item's `diff.json`) is not diff. It is
 *  not the size step's count, which keeps behavior markdown. */
const R4_HEADER = /^diff --git a\/(\S+) b\/(\S+)/;
const R4_TEST = [/(^|\/)__tests__\//, /(^|\/)tests?\//, /\.(test|spec)\.[a-z]+$/, /_test\.[a-z]+$/];
const R4_DOC = [/^docs\//i, /\.mdx?$/i, /\.txt$/i, /(^|\/)(README|CHANGELOG|LICENSE)(\.[a-z]+)?$/i];
const R4_LOCK = [/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/];
function round4Diff(diff: string): string {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => {
      if (!chunk.startsWith("diff --git ")) return false;
      const path = R4_HEADER.exec(chunk)?.[2];
      return path === undefined || ![...R4_TEST, ...R4_DOC, ...R4_LOCK].some((re) => re.test(path));
    })
    .join("");
}

/** `diff` reduced to `shape`; `NO_PRODUCTION_CODE` when nothing is left (`NO_DIFF_LEFT` for round 4's
 *  shape, as round 4 sent it). */
export function shapeDiff(diff: string, shape: DiffShape): string {
  if (shape === "no-tests-docs-locks") return round4Diff(diff) || NO_DIFF_LEFT;
  const out: string[] = [];
  const keep = shape === "security-surface" ? isSecurityPath : isProductionPath;
  for (const f of parseDiff(diff)) {
    if (!keep(f.path)) continue;
    const hunks = shape === "risky-hunks" ? f.hunks.filter((h) => addedLines(h).some((l) => RISKY.test(l))) : f.hunks;
    if (hunks.length > 0 || f.hunks.length === 0) out.push(render(f, hunks));
  }
  const text = out.join("\n");
  return text === "" ? NO_PRODUCTION_CODE : text;
}
