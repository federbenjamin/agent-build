/**
 * A classifier field's text sampled down to its `maxChars`, so that the sample reaches the whole
 * input rather than its first characters. The text is split into units, each with a lead that is
 * always kept and blocks that may be left out:
 *
 * - a diff: one unit per file, its hunks the blocks; a file that does not fit whole keeps its
 *   `diff --git` line and any mode or rename lines as its lead (the `index`, `---` and `+++` lines
 *   say nothing more);
 * - any other text: one unit per `#` or `##` section (outside code fences), its heading the lead and
 *   its body one block. The sections a field `keep`s are served first, whole when they fit.
 *
 * A unit whose share holds its lead and no more sends its lead alone.
 *
 * The budget is shared out so that a short unit keeps all of itself and the long ones split the rest
 * evenly. What the units leave unused then goes back to the cut ones, spread evenly over as many as
 * it can give `SAMPLE_MIN_PARTIAL` characters each, then half as many with twice as much, until it is
 * too small to give; a unit keeps a grant only when it shows more with it. Inside a unit,
 * whole blocks are taken from the front and the back in turn (the other end when one end's block does
 * not fit); the first and last blocks not taken whole split the room left and keep their head and tail
 * lines. A line too long for its room keeps its start and end, with `… N characters left out …` between
 * them. Each other gap is a line that starts with `…` and says what was left out. When even the leads
 * do not fit, every k-th unit is kept and a last line says how many were left out. The result is never
 * longer than the budget.
 */

import { SAMPLE_MIN_PARTIAL as MIN_PARTIAL } from "../constants.ts";
import { parseDiff } from "./diffShape.ts";

export interface Sample {
  text: string;
  /** How the text was sampled, for the field's note. */
  how: string;
}

interface Unit {
  /** The unit as it is, sent when it fits. */
  whole: string[];
  lead: string[];
  blocks: string[][];
}

const size = (lines: readonly string[]): number => lines.reduce((n, l) => n + l.length + 1, 0);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const gap = (what: string): string => `… ${what} left out …`;
/** The room a gap line takes at most: the one for all `n` of a kind left out. */
const gapSize = (n: number, one: string): number => gap(plural(n, one)).length + 1;

/** `line` cut to `room` characters (its newline counted): its start and its end, the characters left
 *  out counted between them; nothing when the room cannot show both ends. */
function cutLine(line: string, room: number): string[] {
  const mark = (n: number) => ` ${gap(plural(n, "character"))} `;
  const keep = room - 1 - mark(line.length).length;
  if (keep < 2) return [];
  const a = Math.ceil(keep / 2);
  const b = keep - a;
  return [`${line.slice(0, a)}${mark(line.length - a - b)}${line.slice(line.length - b)}`];
}

/** `lines` cut to `budget` characters (newlines counted): whole lines from the head and the tail in
 *  turn, the next line cut by characters when it does not fit and the room left is worth it, and a gap
 *  line for the lines left out. */
function headTail(lines: readonly string[], budget: number): string[] {
  if (size(lines) <= budget) return [...lines];
  const room = budget - gapSize(lines.length, "line");
  if (room <= 0) return [];
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let i = 0;
  let j = lines.length - 1;
  while (i <= j) {
    const takeHead = size(head) <= size(tail);
    const line = takeHead ? lines[i]! : lines[j]!;
    if (used + line.length + 1 > room) {
      const part = room - used >= MIN_PARTIAL ? cutLine(line, room - used) : [];
      if (part.length > 0) {
        if (takeHead) (head.push(part[0]!), i++);
        else (tail.unshift(part[0]!), j--);
      }
      break;
    }
    used += line.length + 1;
    if (takeHead) head.push(lines[i++]!);
    else tail.unshift(lines[j--]!);
  }
  const left = j - i + 1;
  return [...head, ...(left > 0 ? [gap(plural(left, "line"))] : []), ...tail];
}

/** One unit cut to `budget`: its lead, then whole blocks from the front and the back in turn, the
 *  first and last blocks not taken whole sharing the room left (their head and tail lines), and a gap
 *  line for the blocks left out. */
function fitUnit(u: Unit, budget: number, blockName: string): string[] {
  if (size(u.whole) <= budget) return [...u.whole];
  const lead = size(u.lead) <= budget ? u.lead : headTail(u.lead, budget);
  const markerSize = gapSize(u.blocks.length, blockName);
  if (size(lead) + markerSize > budget) return [...lead];
  let room = budget - size(lead) - markerSize;
  const front: string[][] = [];
  const back: string[][] = [];
  let i = 0;
  let j = u.blocks.length - 1;
  while (i <= j) {
    const fromFront = front.length <= back.length;
    const fits = (b: string[]) => size(b) <= room;
    const takeFront = fits(u.blocks[fromFront ? i : j]!) ? fromFront : i < j && fits(u.blocks[fromFront ? j : i]!) ? !fromFront : null;
    if (takeFront === null) break;
    const block = takeFront ? u.blocks[i++]! : u.blocks[j--]!;
    room -= size(block);
    if (takeFront) front.push(block);
    else back.unshift(block);
  }
  const ends = i < j ? [i, j] : i === j ? [i] : [];
  const least = (k: number) => MIN_PARTIAL + gapSize(u.blocks[k]!.length, "line");
  let endShares = shares(ends.map((k) => size(u.blocks[k]!)), Math.max(0, room));
  if (ends.length === 2 && endShares.some((sh, n) => sh < least(ends[n]!))) endShares = [Math.max(0, room), 0];
  const parts = ends.map((k, n) => (endShares[n]! >= least(k) ? headTail(u.blocks[k]!, endShares[n]!) : []));
  const leftOut = (j - i + 1) - parts.filter((p) => p.length > 0).length;
  const marker = leftOut > 0 ? [gap(plural(leftOut, blockName))] : [];
  const out = [...lead, ...front.flat(), ...(parts[0] ?? []), ...marker, ...(ends.length === 2 ? parts[1]! : []), ...back.flat()];
  return size(out) <= budget ? out : headTail(out, budget);
}

/** Each unit's share of `budget`: a unit smaller than an even share keeps all it needs, and what it
 *  leaves goes to the rest. */
function shares(sizes: readonly number[], budget: number): number[] {
  const out = new Array<number>(sizes.length).fill(0);
  const order = sizes.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  let left = budget;
  order.forEach(([s, i], k) => {
    const give = Math.min(s, Math.floor(left / (order.length - k)));
    out[i] = give;
    left -= give;
  });
  return out;
}

/** The units laid out in `budget`: kept units served first (leaving room for the others' first lead
 *  lines), then the rest; what the cut units leave unused is shared among them again. Every k-th unit
 *  when even the units' first lead lines do not all fit. Returns the lines and how many units were
 *  dropped. */
function layout(units: readonly Unit[], kept: ReadonlySet<number>, budget: number, blockName: string, unitName: string): { lines: string[]; dropped: number } {
  const firstLead = (u: Unit) => (u.lead[0] ?? "").length + 1;
  const minimal = units.reduce((n, u) => n + firstLead(u), 0);
  let chosen = units.map((_, i) => i);
  let room = budget;
  let dropped = 0;
  if (minimal > budget) {
    room = budget - gapSize(units.length, unitName);
    const stride = Math.ceil(minimal / Math.max(1, room));
    chosen = chosen.filter((i) => i % stride === 0);
    dropped = units.length - chosen.length;
  }
  const full = units.map((u) => size(u.whole));
  const keptIds = chosen.filter((i) => kept.has(i));
  const restIds = chosen.filter((i) => !kept.has(i));
  const restLeads = restIds.reduce((n, i) => n + firstLead(units[i]!), 0);
  const keptShares = shares(keptIds.map((i) => full[i]!), Math.max(0, room - restLeads));
  const used = keptShares.reduce((a, b) => a + b, 0);
  const restShares = shares(restIds.map((i) => full[i]!), room - used);
  const share = new Map<number, number>([...keptIds.map((id, k) => [id, keptShares[k]!] as const), ...restIds.map((id, k) => [id, restShares[k]!] as const)]);
  const fitted = new Map(chosen.map((i) => [i, fitUnit(units[i]!, share.get(i)!, blockName)] as const));
  for (let grant = MIN_PARTIAL; ; grant *= 2) {
    const spare = room - chosen.reduce((n, i) => n + size(fitted.get(i)!), 0);
    const cut = chosen.filter((i) => size(fitted.get(i)!) < full[i]!);
    const takers = Math.min(cut.length, Math.floor(spare / grant));
    if (takers === 0) break;
    const given = cut.filter((_, k) => Math.floor((k * takers) / cut.length) !== Math.floor(((k + 1) * takers) / cut.length));
    const extra = shares(given.map((i) => full[i]! - size(fitted.get(i)!)), spare);
    given.forEach((i, k) => {
      const again = fitUnit(units[i]!, size(fitted.get(i)!) + extra[k]!, blockName);
      if (size(again) > size(fitted.get(i)!)) fitted.set(i, again);
    });
  }
  const lines = chosen.flatMap((i) => fitted.get(i)!);
  if (dropped > 0) lines.push(gap(plural(dropped, unitName)));
  return { lines: size(lines) <= budget ? lines : headTail(lines, budget), dropped };
}

const DIFF_LEAD_NOISE = /^(index |--- |\+\+\+ )/;

function diffUnits(text: string): Unit[] {
  return parseDiff(text).map((f) => {
    const blocks = f.hunks.map((h) => [h.head, ...h.lines]);
    return { whole: [...f.header, ...blocks.flat()], lead: f.header.filter((l) => !DIFF_LEAD_NOISE.test(l)), blocks };
  });
}

const HEADING = /^#{1,2}\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

function sectionUnits(text: string): { units: Unit[]; titles: string[] } {
  const units: Omit<Unit, "whole">[] = [];
  const titles: string[] = [];
  let cur = { lead: [] as string[], blocks: [[]] as string[][] };
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const h = fenced ? null : HEADING.exec(line);
    if (h !== null) {
      if (cur.lead.length > 0 || cur.blocks[0]!.length > 0) units.push(cur);
      cur = { lead: [line], blocks: [[]] };
      titles[units.length] = h[1]!.trim();
      continue;
    }
    cur.blocks[0]!.push(line);
  }
  units.push(cur);
  return { units: units.map((u) => ({ ...u, whole: [...u.lead, ...u.blocks.flat()] })), titles: units.map((_, i) => titles[i] ?? "") };
}

/** `text` sampled to at most `maxChars` characters, as a diff when `diff` is set and the text parses
 *  as one, else by markdown sections, keeping the sections whose titles start with a `keep` entry.
 *  With `head`, the first `maxChars` characters, as a tuned setup was measured. */
export function sampleText(text: string, maxChars: number, opts: { diff: boolean; keep?: readonly string[]; head?: boolean }): Sample {
  if (text.length <= maxChars) return { text, how: "" };
  const of = `${maxChars} of ${text.length} characters`;
  if (opts.head === true) return { text: text.slice(0, maxChars), how: `first ${of}` };
  const files = opts.diff ? diffUnits(text) : [];
  if (files.length > 0) {
    const { lines, dropped } = layout(files, new Set(), maxChars + 1, "hunk", "file");
    const shown = files.length - dropped;
    return {
      text: lines.join("\n"),
      how: `sampled to ${of}: ${shown} of ${plural(files.length, "file")} shown, each with its \`diff --git\` line; a long file keeps its first and last hunks, and each gap starts with "…" and says what was left out`,
    };
  }
  const { units, titles } = sectionUnits(text);
  const keep = (opts.keep ?? []).map((k) => k.toLowerCase());
  const kept = new Set(units.map((_, i) => i).filter((i) => keep.some((k) => titles[i]!.toLowerCase().startsWith(k))));
  const { lines } = layout(units, kept, maxChars + 1, "block", "section");
  const keptNames = [...kept].map((i) => `"${titles[i]}"`);
  return {
    text: lines.join("\n"),
    how: `sampled to ${of}: ${keptNames.length > 0 ? `the ${keptNames.join(", ")} section${keptNames.length === 1 ? "" : "s"} first, whole when they fit, then ` : ""}every section's heading with the head and tail of its text; each gap starts with "…" and says what was left out`,
  };
}
