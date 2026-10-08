/**
 * The paths a patch changes logic in: the runtime's own comment detection, the same judgment a
 * repo's `--app-code` arm applies to app code. A changed line counts unless it is blank or a comment in its
 * file's syntax (`COMMENT_SYNTAX`); a file type the table lacks (markdown, json) counts every
 * non-blank line, so a changed path string is a change. A block comment is tracked within a hunk
 * only: an opener above the hunk leaves its lines counted, so the error only ever counts more.
 *
 * A file section with no hunk counts its paths (a mode change, a binary file, an empty file added or
 * deleted), except an identical rename (`similarity index 100%`, no mode change), which changes no
 * content: neither its old path nor its new one counts. Git writes one only when asked for exact
 * renames (`-M100%`); a patch without rename detection shows a move as a delete and an add, and
 * both count. Pure.
 */

interface Syntax {
  line: readonly string[];
  block: { open: string; close: string } | null;
}

const SLASH: Syntax = { line: ["//"], block: { open: "/*", close: "*/" } };
const HASH: Syntax = { line: ["#"], block: null };

/** Comment delimiters per extension. */
const COMMENT_SYNTAX: Readonly<Record<string, Syntax>> = {
  ".ts": SLASH,
  ".tsx": SLASH,
  ".js": SLASH,
  ".jsx": SLASH,
  ".mjs": SLASH,
  ".cjs": SLASH,
  ".sql": { line: ["--"], block: { open: "/*", close: "*/" } },
  ".sh": HASH,
  ".bash": HASH,
  ".yaml": HASH,
  ".yml": HASH,
  ".toml": HASH,
};

function syntaxOf(path: string | null): Syntax | null {
  if (path === null) return null;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? null : (COMMENT_SYNTAX[base.slice(dot).toLowerCase()] ?? null);
}

/** Block-comment state for one side of a hunk. */
class CommentScanner {
  private inBlock = false;
  private readonly syntax: Syntax | null;
  constructor(syntax: Syntax | null) {
    this.syntax = syntax;
  }

  /** True when the line holds no logic: a comment, or inside a block comment. */
  consume(content: string): boolean {
    const s = this.syntax;
    if (s === null) return false;
    const t = content.trim();
    if (this.inBlock) {
      const closeAt = s.block === null ? -1 : t.indexOf(s.block.close);
      if (closeAt === -1) return true;
      this.inBlock = false;
      return t.slice(closeAt + s.block!.close.length).trim() === "";
    }
    if (t === "") return false;
    if (s.line.some((p) => t.startsWith(p))) return true;
    if (s.block !== null && t.startsWith(s.block.open)) {
      const rest = t.slice(s.block.open.length);
      const closeAt = rest.indexOf(s.block.close);
      if (closeAt === -1) {
        this.inBlock = true;
        return true;
      }
      return rest.slice(closeAt + s.block.close.length).trim() === "";
    }
    return false;
  }
}

interface Section {
  pre: string | null;
  post: string | null;
  hunks: boolean;
  identical: boolean;
  modeChange: boolean;
  logic: Set<string>;
}

/** `a/<p> b/<p>`: the one path of a section that neither renames nor quotes it. */
function headerPath(line: string): string | null {
  const s = line.slice("diff --git ".length);
  if (!s.startsWith("a/") || (s.length - 5) % 2 !== 0) return null;
  const p = s.slice(2, 2 + (s.length - 5) / 2);
  return s === `a/${p} b/${p}` ? p : null;
}

/** Every path a patch changes logic in, in first-seen order. */
export function logicChangedPaths(patch: string): string[] {
  const out = new Set<string>();
  let sec: Section | null = null;
  let pre = new CommentScanner(null);
  let post = new CommentScanner(null);
  const flush = () => {
    if (sec === null) return;
    const paths = [sec.pre, sec.post].filter((p): p is string => p !== null);
    if (sec.modeChange || (!sec.hunks && !sec.identical)) for (const p of paths) out.add(p);
    for (const p of sec.logic) out.add(p);
    sec = null;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const p = headerPath(line);
      sec = { pre: p, post: p, hunks: false, identical: false, modeChange: false, logic: new Set() };
      continue;
    }
    if (sec === null) continue;
    const s: Section = sec;
    if (line.startsWith("@@")) {
      s.hunks = true;
      pre = new CommentScanner(syntaxOf(s.pre));
      post = new CommentScanner(syntaxOf(s.post));
      continue;
    }
    if (!s.hunks) {
      if (line.startsWith("rename from ")) s.pre = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) s.post = line.slice("rename to ".length);
      else if (line === "similarity index 100%") s.identical = true;
      else if (line.startsWith("old mode ") || line.startsWith("new mode ")) s.modeChange = true;
      else if (line === "--- /dev/null") s.pre = null;
      else if (line === "+++ /dev/null") s.post = null;
      else if (line.startsWith("--- a/")) s.pre = line.slice("--- a/".length);
      else if (line.startsWith("+++ b/")) s.post = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      const plus = line[0] === "+";
      const content = line.slice(1);
      const comment = (plus ? post : pre).consume(content);
      const path = plus ? s.post : s.pre;
      if (!comment && content.trim() !== "" && path !== null) s.logic.add(path);
    } else if (line.startsWith(" ")) {
      pre.consume(line.slice(1));
      post.consume(line.slice(1));
    }
  }
  flush();
  return [...out];
}
