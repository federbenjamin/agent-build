/**
 * Pure helpers that outlived the lens catalog: the docs-only predicate every review entry point
 * reads, and the behaviour-markdown paths the review table's kind rule reads (`./lib/table.ts`).
 * No CLI.
 */

const DOCS_ONLY_RES: RegExp[] = [/^docs\//, /\.mdx?$/, /\.txt$/];

/** Behavior-bearing markdown: agent, skill, command, and rule definitions plus the AGENTS.md floor
 * ARE the fleet's executable configuration — a diff touching only these is NOT a docs pass. */
export const BEHAVIOR_MD_RES: RegExp[] = [
  /^\.agents\//,
  /^\.claude\//,
  /^\.codex\//,
  /^AGENTS\.md$/,
  /^docs\/rules\//,
];

export function isDocsOnlyDiff(paths: string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every(
      (p) => !BEHAVIOR_MD_RES.some((re) => re.test(p)) && DOCS_ONLY_RES.some((re) => re.test(p))
    )
  );
}
