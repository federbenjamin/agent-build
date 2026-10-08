/**
 * The build's lifecycle events: the one writer and the one parser of the JSON a launcher's consumer
 * reads on stdin (README §Build events). Pure, and imports only `./shape.ts`, so a consumer outside
 * this repo imports its types and parser at the cost of two small files. A new field is a schema bump:
 * the parser refuses a key it does not know.
 */

import { Shape, type ShapeIssue } from "./shape.ts";

export const BUILD_EVENT_SCHEMA = 1;
export const BUILD_EVENT_NAMES = ["plan", "unit-merged", "blocked", "finished"] as const;
export type BuildEventName = (typeof BUILD_EVENT_NAMES)[number];
export const FINISHED_OUTCOMES = ["merged", "unmerged"] as const;
export type FinishedOutcome = (typeof FINISHED_OUTCOMES)[number];

export interface BuildEventBase {
  schema: 1;
  runid: string;
  at: string;
  event: BuildEventName;
}
export interface PlanEvent extends BuildEventBase {
  event: "plan";
  units: { id: string; title: string }[];
}
export interface UnitMergedEvent extends BuildEventBase {
  event: "unit-merged";
  id: string;
  pr: number;
}
export interface BlockedEvent extends BuildEventBase {
  event: "blocked";
  id?: string;
  needs: string;
}
export interface FinishedEvent extends BuildEventBase {
  event: "finished";
  outcome: FinishedOutcome;
  pr?: number;
}
export type BuildEvent = PlanEvent | UnitMergedEvent | BlockedEvent | FinishedEvent;

const BASE_KEYS = ["schema", "runid", "at", "event"] as const;
/** Each event's own fields, in wire order: the keys the parser knows beyond the base four, and the
 *  emitter's flags (`--<field>`; `units` is the repeatable `--unit`). */
export const BUILD_EVENT_FIELDS = {
  plan: ["units"],
  "unit-merged": ["id", "pr"],
  blocked: ["id", "needs"],
  finished: ["outcome", "pr"],
} as const satisfies Record<BuildEventName, readonly string[]>;

export function isBuildEventName(v: unknown): v is BuildEventName {
  return (BUILD_EVENT_NAMES as readonly unknown[]).includes(v);
}

/** Every issue the validator found, one per field; `message` is the joined list. */
export class BuildEventError extends Error {
  readonly issues: readonly ShapeIssue[];
  constructor(issues: readonly ShapeIssue[]) {
    super(issues.map((i) => i.message).join("\n"));
    this.name = "BuildEventError";
    this.issues = issues;
  }
}

function nonEmpty(s: Shape, v: unknown, path: string): string {
  if (typeof v === "string" && v !== "") return v;
  s.bad(path, "a non-empty string");
  return "";
}

function unitId(s: Shape, v: unknown, path: string): string {
  if (typeof v === "string" && v !== "" && !/[\s=]/.test(v)) return v;
  s.bad(path, "a unit id (a non-empty string with no whitespace and no `=`)");
  return "";
}

function prNumber(s: Shape, v: unknown, path: string): number {
  if (Number.isInteger(v) && (v as number) >= 1) return v as number;
  s.bad(path, "a PR number (an integer ≥ 1)");
  return 1;
}

function readUnits(s: Shape, v: unknown): PlanEvent["units"] {
  const units = s.arr(v, "units").map((x, i) => {
    const o = s.obj(x, `units[${i}]`) ?? {};
    return { id: unitId(s, o.id, `units[${i}].id`), title: nonEmpty(s, o.title, `units[${i}].title`) };
  });
  if (Array.isArray(v) && units.length === 0) s.bad("units", "at least one unit");
  const seen = new Set<string>();
  units.forEach((u, i) => {
    if (u.id !== "" && seen.has(u.id)) s.bad(`units[${i}].id`, `an id not used before, got ${u.id} twice`);
    seen.add(u.id);
  });
  return units;
}

/** Validate a parsed value as a build event. Throws `BuildEventError` naming every bad path. */
export function parseBuildEvent(raw: unknown): BuildEvent {
  const s = new Shape("build event");
  const o = s.obj(raw, "(root)") ?? {};
  if (o.schema !== BUILD_EVENT_SCHEMA) s.bad("schema", String(BUILD_EVENT_SCHEMA));
  const runid = nonEmpty(s, o.runid, "runid");
  const at = typeof o.at === "string" && !Number.isNaN(Date.parse(o.at)) ? o.at : "";
  if (at === "") s.bad("at", "a date-time string");
  const event = isBuildEventName(o.event) ? o.event : undefined;
  if (event === undefined) s.bad("event", `one of ${BUILD_EVENT_NAMES.join(" | ")}`);
  const known = new Set<string>([...BASE_KEYS, ...(event === undefined ? [] : BUILD_EVENT_FIELDS[event])]);
  for (const key of Object.keys(o)) if (!known.has(key)) s.bad(key, `no key ${key}`);

  const base = { schema: BUILD_EVENT_SCHEMA, runid, at } as const;
  let out: BuildEvent | undefined;
  if (event !== undefined) {
    switch (event) {
      case "plan":
        out = { ...base, event, units: readUnits(s, o.units) };
        break;
      case "unit-merged":
        out = { ...base, event, id: unitId(s, o.id, "id"), pr: prNumber(s, o.pr, "pr") };
        break;
      case "blocked": {
        const id = o.id === undefined ? undefined : unitId(s, o.id, "id");
        out = { ...base, event, ...(id === undefined ? {} : { id }), needs: nonEmpty(s, o.needs, "needs") };
        break;
      }
      case "finished": {
        const outcome = s.oneOf(o.outcome, FINISHED_OUTCOMES, "outcome");
        const pr = o.pr === undefined ? undefined : prNumber(s, o.pr, "pr");
        out = { ...base, event, outcome, ...(pr === undefined ? {} : { pr }) };
        break;
      }
    }
  }
  const issues = s.issues();
  if (issues.length > 0 || out === undefined) throw new BuildEventError(issues);
  return out;
}

/** `JSON.parse`, then `parseBuildEvent`; a text that is not JSON is a `BuildEventError` (`build event is not JSON: …`). */
export function readBuildEvent(text: string): BuildEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new BuildEventError([{ message: `build event is not JSON: ${(e as Error).message}` }]);
  }
  return parseBuildEvent(raw);
}

/** The wire form: one line of JSON, keys `schema, runid, at, event` then the event's fields in the order above, ending `\n`. */
export function formatBuildEvent(event: BuildEvent): string {
  const base = { schema: event.schema, runid: event.runid, at: event.at, event: event.event };
  let wire: Record<string, unknown>;
  switch (event.event) {
    case "plan":
      wire = { ...base, units: event.units.map((u) => ({ id: u.id, title: u.title })) };
      break;
    case "unit-merged":
      wire = { ...base, id: event.id, pr: event.pr };
      break;
    case "blocked":
      wire = { ...base, ...(event.id === undefined ? {} : { id: event.id }), needs: event.needs };
      break;
    case "finished":
      wire = { ...base, outcome: event.outcome, ...(event.pr === undefined ? {} : { pr: event.pr }) };
      break;
  }
  return `${JSON.stringify(wire)}\n`;
}
