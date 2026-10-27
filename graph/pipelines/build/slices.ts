/**
 * A fix round shared out among fixers that run at once (the close loop's slices): the draft D-build-fix-table
 * writes (rows that point at one file join), the links A-link-slices reports between draft slices, and the
 * plan D-plan-slices makes of both, the fix slices and each one's peers. Each JSON shape here is the
 * contract between the node that writes it and every node that reads it. Pure.
 */

import { matchesTarget } from "../../../runtime/lib/brief.ts";
import { cleanPath, type Row } from "../../../runtime/lib/runFiles.ts";
import { blockedFixFile, joinFixFiles, parseFixFile } from "../../../runtime/lib/fixFile.ts";
import { disjointSet, setsOf } from "../../../runtime/lib/disjointSet.ts";
import { Shape } from "../../../runtime/lib/shape.ts";

/** The files these shapes travel in: D-build-fix-table's `draft-slices`, A-link-slices' `links`, D-plan-slices'
 *  `slice-plan`, D-merge-slice's `slice-conflict`. */
export const DRAFT_FILE = "draft-slices.json";
export const LINKS_FILE = "links.json";
export const PLAN_FILE = "slices.json";
export const CONFLICT_FILE = "slice-conflict.json";

/** A draft slice: rows that share no file with any other draft slice. */
export interface DraftSlice {
  id: string;
  rows: string[];
  files: string[];
}

/** `draft-slices.json`, D-build-fix-table's: the round's rows by draft slice, table order. */
export interface DraftFile {
  round: string;
  slices: DraftSlice[];
}

/** The draft slices of a round: rows that point at one path (any of their parsed locators) join, so no
 *  file falls in two slices. A row with no parsed path (a hand test, a `(none)` locator) is a slice of
 *  its own. Ids `D1`… in the order of each slice's first row. */
export function draftSlices(rows: readonly Pick<Row, "id" | "locators">[]): DraftSlice[] {
  const sets = disjointSet(rows.length);
  const paths = rows.map((r) => [...new Set(r.locators.filter((l) => l.parsed).map((l) => cleanPath(l.path)))]);
  const firstWith = new Map<string, number>();
  paths.forEach((ps, i) => {
    for (const p of ps) {
      const at = firstWith.get(p);
      if (at === undefined) firstWith.set(p, i);
      else sets.union(at, i);
    }
  });
  return setsOf(sets, rows.length).map((members, k) => ({
    id: `D${k + 1}`,
    rows: members.map((i) => rows[i]!.id),
    files: [...new Set(members.flatMap((i) => paths[i]!))].sort(),
  }));
}

export const LINK_KINDS = ["signature", "type", "constant", "export", "store", "behaviour", "doc", "same-lines"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** A link A-link-slices found: `from`'s fix will likely change a thing that `to`'s files use. */
export interface Link {
  from: string;
  to: string;
  kind: LinkKind;
  /** file:line of the use. */
  evidence: string;
  /** What the fixer of `to` must know. */
  note: string;
}

/** `links.json`, A-link-slices' output: `{ links: [...] }`. Throws naming every bad path. */
export function parseLinks(raw: unknown, label = "links"): Link[] {
  const s = new Shape(label);
  const o = s.obj(raw, "(root)") ?? {};
  const links = s.arr(o.links, "links").map((x, i): Link => {
    const l = s.obj(x, `links[${i}]`) ?? {};
    return {
      from: s.str(l.from, `links[${i}].from`),
      to: s.str(l.to, `links[${i}].to`),
      kind: s.oneOf(l.kind, LINK_KINDS, `links[${i}].kind`),
      evidence: s.str(l.evidence, `links[${i}].evidence`),
      note: s.str(l.note, `links[${i}].note`),
    };
  });
  const issues = s.issues();
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join("\n"));
  return links;
}

/** The draft slices one fixer gets: their rows and files. */
export interface PlannedSlice {
  id: string;
  drafts: string[];
  rows: string[];
  files: string[];
}

/**
 * The fix slices of a round (D-plan-slices): linked draft slices merge, in link order, while the merged
 * slice holds at most `share` of the round's rows (rounded up), or the largest draft slice when that is
 * bigger; what is left is packed into at most `max` slices, the biggest first, each into the smallest
 * so far. A link whose ends land in two slices is a warning both fixers get; one naming a slice the
 * draft does not hold, or one slice twice, is dropped.
 */
export function planSlices(drafts: readonly DraftSlice[], links: readonly Link[], max: number, share: number): { slices: PlannedSlice[]; warnings: Link[]; dropped: number } {
  const total = drafts.reduce((n, d) => n + d.rows.length, 0);
  const cap = Math.max(Math.ceil(total * share), ...drafts.map((d) => d.rows.length));
  const index = new Map(drafts.map((d, i) => [d.id, i]));
  const valid = links.filter((l) => index.has(l.from) && index.has(l.to) && l.from !== l.to);
  const sets = disjointSet(drafts.length);
  const size = drafts.map((d) => d.rows.length);
  for (const l of valid) {
    const [a, b] = [sets.find(index.get(l.from)!), sets.find(index.get(l.to)!)];
    const merged = size[a]! + size[b]!;
    if (a === b || merged > cap) continue;
    size[sets.union(a, b)] = merged;
  }
  const units = setsOf(sets, drafts.length).map((members) => members.map((i) => drafts[i]!));
  const rowsOf = (u: readonly DraftSlice[]) => u.reduce((n, d) => n + d.rows.length, 0);
  const bins: DraftSlice[][] = Array.from({ length: Math.max(1, Math.min(max, units.length)) }, () => []);
  for (const u of [...units].sort((a, b) => rowsOf(b) - rowsOf(a))) bins.reduce((min, bin) => (rowsOf(bin) < rowsOf(min) ? bin : min)).push(...u);
  const order = new Map(drafts.map((d, i) => [d.id, i]));
  const slices = bins
    .filter((b) => b.length > 0)
    .map((bin, k): PlannedSlice => {
      const ds = [...bin].sort((x, y) => order.get(x.id)! - order.get(y.id)!);
      return { id: `S${k + 1}`, drafts: ds.map((d) => d.id), rows: ds.flatMap((d) => d.rows), files: [...new Set(ds.flatMap((d) => d.files))].sort() };
    });
  const sliceOf = (draft: string) => slices.find((s) => s.drafts.includes(draft))!.id;
  return { slices, warnings: valid.filter((l) => sliceOf(l.from) !== sliceOf(l.to)), dropped: links.length - valid.length };
}

/** Another fixer of the round, as one fixer sees it. */
export interface Peer {
  /** Its fan-out item. */
  item: string;
  /** Its session's name (`sessionName`): the address to message it at. */
  session: string;
  /** Its node run's folder: `pgid.json` (`{pid}` while it runs, `{pid: null}` once its attempt ended)
   *  and `rerun-<r>/attempt-<n>.json` (`endedAt` once ended) say whether it is still running. */
  nodeRun: string;
  /** The files its slice owns. */
  files: string[];
  /** The links A-link-slices found between this slice and that one, either way. */
  links: Link[];
}

/** One line of `crosstalk.jsonl` (`CROSSTALK_FILE`): a message a fixer sent a peer, as the sender
 *  logged it. `to` is the peer's item, `session` its session name. */
export interface CrosstalkMessage {
  at: string;
  to: string;
  session: string;
  text: string;
}
const CROSSTALK_KEYS = ["at", "to", "session", "text"] as const satisfies readonly (keyof CrosstalkMessage)[];

/** `crosstalk.jsonl`, one JSON object per line; a blank line is skipped. A bad line is dropped and
 *  named in `problems`, so one bad line never hides the rest. */
export function parseCrosstalk(text: string, label = "crosstalk"): { messages: CrosstalkMessage[]; problems: string[] } {
  const messages: CrosstalkMessage[] = [];
  const problems: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      problems.push(`${label} line ${i + 1}: not JSON; dropped`);
      return;
    }
    const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const lacking = CROSSTALK_KEYS.filter((k) => typeof o[k] !== "string");
    if (lacking.length > 0) problems.push(`${label} line ${i + 1}: ${lacking.join(", ")} not a string; dropped`);
    else messages.push({ at: o.at as string, to: o.to as string, session: o.session as string, text: o.text as string });
  });
  return { messages, problems };
}

export interface FixSlice extends PlannedSlice {
  peers: Peer[];
}

/** `slices.json`, D-plan-slices' `slice-plan` output: the round's fix slices, each with its peers. */
export interface SlicePlan {
  round: string;
  slices: FixSlice[];
}

/** The plan with each slice's peers: every other slice of the round, how to reach it, and the links
 *  left between the two. */
export function withPeers(round: string, plan: ReturnType<typeof planSlices>, reach: (item: string) => { session: string; nodeRun: string }): SlicePlan {
  const between = (a: PlannedSlice, b: PlannedSlice) => plan.warnings.filter((l) => (a.drafts.includes(l.from) && b.drafts.includes(l.to)) || (b.drafts.includes(l.from) && a.drafts.includes(l.to)));
  return {
    round,
    slices: plan.slices.map((s) => ({
      ...s,
      peers: plan.slices.filter((o) => o.id !== s.id).map((o) => ({ item: o.id, ...reach(o.id), files: o.files, links: between(s, o) })),
    })),
  };
}

/** Why a slice's commit did not reach the run tree: its merge conflicted on `paths` with a slice merged
 *  before it, or it touches files other slices own (`owned`, by owner). */
export type SliceUnmerged = { cause: "conflict"; paths: string[] } | { cause: "lane"; owned: { slice: string; files: string[] }[] };

/** `slice-conflict.json`, D-merge-slice's `slice-conflict` output, one per fix slice. */
export interface SliceConflict {
  /** The fan-out item: the plan slice's id. */
  slice: string;
  /** The fixer's commit, its full sha. */
  commit: string;
  /** Why it was not merged; null when it merged. */
  unmerged: SliceUnmerged | null;
}

/** The files of `changed` that slice `item` does not own and another slice of the plan does, by that
 *  slice, in plan order, each list in `changed` order; empty when the commit stays in its lane (a file no
 *  slice owns is allowed). Throws (`sliceOf`) naming the item when the plan has no such slice. */
export function foreignSliceFiles(plan: SlicePlan, item: string, changed: readonly string[]): { slice: string; files: string[] }[] {
  const own = sliceOf(plan, item).files;
  return plan.slices
    .filter((s) => s.id !== item)
    .map((s) => ({ slice: s.id, files: changed.filter((f) => !matchesTarget(f, own) && matchesTarget(f, s.files)) }))
    .filter((o) => o.files.length > 0);
}

/** An unmerged slice's fix file: each row its text fixed `blocked`, naming the cause and the full commit
 *  (the next fixer reuses it by that sha), its other lines as written. */
function unmergedFix(slice: PlannedSlice, conflict: SliceConflict & { unmerged: SliceUnmerged }, text: string): string {
  const { commit, unmerged } = conflict;
  const reason =
    unmerged.cause === "conflict"
      ? `merging slice ${slice.id}'s commit ${commit} conflicted on ${unmerged.paths.join(", ")} with a slice merged before it; its fix is not in the run tree`
      : `slice ${slice.id}'s commit ${commit} touches ${unmerged.owned.map((o) => `${o.files.join(", ")}, which slice ${o.slice} owns`).join("; ")}, so it was not merged; its fix is not in the run tree`;
  return blockedFixFile(slice.rows, reason, `slice ${slice.id}'s commit did not merge`, text);
}

/** The round's one fix file from its slices' (`joinFixFiles`): each text is the slice's whose rows it
 *  answers (the one slice's, in a round of one), checked against them; every slice of the plan needs
 *  one. A slice whose commit did not merge (`conflicts`, unmerged not null) answers the rows it fixed
 *  `blocked` and keeps its other lines. */
export function joinSliceFixes(plan: SlicePlan, texts: readonly string[], rows: readonly string[], conflicts: readonly SliceConflict[] = []): string {
  const unknown = conflicts.filter((c) => !plan.slices.some((s) => s.id === c.slice)).map((c) => c.slice);
  if (unknown.length > 0) throw new Error(`round ${plan.round}: a merge conflict names slice ${unknown.join(", ")}, which the plan does not hold`);
  const parts = texts.map((text) => {
    const first = parseFixFile(text).lines[0]?.row;
    const slice = plan.slices.length === 1 ? plan.slices[0] : plan.slices.find((s) => first !== undefined && s.rows.includes(first));
    if (slice === undefined) throw new Error(`a slice fix file answers ${first ?? "no row"}, which no slice of round ${plan.round} holds`);
    const conflict = conflicts.find((x): x is SliceConflict & { unmerged: SliceUnmerged } => x.slice === slice.id && x.unmerged !== null);
    return { slice: slice.id, rows: slice.rows, text: conflict === undefined ? text : unmergedFix(slice, conflict, text) };
  });
  const missing = plan.slices.filter((s) => !parts.some((p) => p.slice === s.id)).map((s) => s.id);
  if (missing.length > 0) throw new Error(`round ${plan.round}: no fix file from slice ${missing.join(", ")}`);
  const twice = parts.filter((p, i) => parts.findIndex((q) => q.slice === p.slice) !== i).map((p) => p.slice);
  if (twice.length > 0) throw new Error(`round ${plan.round}: two fix files from slice ${twice.join(", ")}`);
  return joinFixFiles(plan.slices.map((s) => parts.find((p) => p.slice === s.id)!), rows);
}

/** The slice `item` of a plan; throws naming the item when the plan has none. */
export function sliceOf(plan: SlicePlan, item: string | undefined): FixSlice {
  const s = plan.slices.find((x) => x.id === item);
  if (s === undefined) throw new Error(`the slice plan of round ${plan.round} has no slice ${item ?? "(no item)"}`);
  return s;
}
