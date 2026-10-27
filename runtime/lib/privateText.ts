import { isTestPath } from "./testPaths.ts";

/** A macOS home path, which names a person's account. */
export const HOME_PATH = /\/Users\//;

/** A home path written with a tilde. */
export const TILDE_HOME = /~\//;

/** An email address. */
export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/** The operator's tracker keys; an id's prefix is compared to them upper-cased. */
export const TRACKER_KEYS: readonly string[] = ["QRK", "DEV"];

export interface TicketId {
  id: string;
  prefix: string;
  index: number;
}

/** Every whole-word `<letters>-<digits>` id in `text`, any prefix, any case, in order. */
export function ticketIds(text: string): TicketId[] {
  return [...text.matchAll(/\b([A-Za-z]+)-\d+\b/g)].map((m) => ({ id: m[0], prefix: m[1]!, index: m.index }));
}

export type PrivacyRule = "home-path" | "ticket-citation";

export const RULE_TEXT: Readonly<Record<PrivacyRule, string>> = { "home-path": "a macOS home path", "ticket-citation": "a real-ticket citation" };

export interface LineHit {
  line: number;
  rule: PrivacyRule;
  match: string;
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const TITLE_LINE = /^\s*(test|describe|it)\s*[.(]/;

/** Whether `id` on `line` of a test file cites a ticket rather than using it as example data. */
function citedInTest(line: string, id: TicketId): boolean {
  return COMMENT_LINE.test(line) || TITLE_LINE.test(line) || (line[id.index - 1] === "(" && line[id.index + id.id.length] === ")");
}

/** The lines of `text` (a file at repo-relative `path`) that hold private text, in line order and within
 *  a line in the order the matches start: a macOS home path anywhere, and an id of a `keys` tracker that
 *  cites a ticket. Outside a test file every such id cites one; in a test file only one in a comment
 *  line, a test title line, or directly in parentheses does, and any other is example data. */
export function privateLines(text: string, path: string, keys: readonly string[] = TRACKER_KEYS): LineHit[] {
  const tracked = new Set(keys.map((k) => k.toUpperCase()));
  const inTest = isTestPath(path);
  return text.split("\n").flatMap((line, i): LineHit[] => {
    const home = HOME_PATH.exec(line);
    const found: { column: number; rule: PrivacyRule; match: string }[] = [
      ...(home ? [{ column: home.index, rule: "home-path" as const, match: home[0] }] : []),
      ...ticketIds(line)
        .filter((t) => tracked.has(t.prefix.toUpperCase()) && (!inTest || citedInTest(line, t)))
        .map((t) => ({ column: t.index, rule: "ticket-citation" as const, match: t.id })),
    ];
    return found.sort((a, b) => a.column - b.column).map(({ rule, match }) => ({ line: i + 1, rule, match }));
  });
}
