const DECLARATION = /^import\s*(?:[^"'`;]*?\bfrom\s*)?(["'])(.*?)\1/;

/** The module specifier of the first `import` statement in `source` (type imports count; comments
 *  and strings before it do not), or null when the source has no import. */
export function firstImport(source: string): string | null {
  let i = source.startsWith("#!") ? source.indexOf("\n") : 0;
  if (i < 0) return null;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      i = stringEnd(source, i);
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = /^[\w$]+/.exec(source.slice(i))![0];
      const before = i > 0 ? source[i - 1] : "";
      if (word === "import" && before !== "." && !/^import\s*[(.]/.test(source.slice(i))) {
        const m = DECLARATION.exec(source.slice(i));
        if (m) return m[2]!;
      }
      i += word.length;
    } else {
      i += 1;
    }
  }
  return null;
}

function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
  return i + 1;
}
