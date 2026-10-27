/**
 * The build's lifecycle events: the one writer and the one parser of the JSON a launcher's consumer
 * reads on stdin (README §Build events). Pure, and imports only `./shape.ts`, so a consumer outside
 * this repo imports its types and parser at the cost of two small files. A new field is a schema bump:
 * the parser refuses a key it does not know.
 */

import { Shape, type ShapeIssue } from "./shape.ts";

export const BUILD_EVENT_SCHEMA = 4;

/** The environment variable a launcher sets: the consumer command line. */
export const BUILD_EVENT_CMD = "BUILD_EVENT_CMD";

/** The consumer command line, trimmed; `""` when nobody is listening. */
export function consumerLine(env: Record<string, string | undefined>): string {
  return (env[BUILD_EVENT_CMD] ?? "").trim();
}
export const BUILD_EVENT_NAMES = ["plan", "unit-started", "unit-merged", "blocked", "finished"] as const;
export type BuildEventName = (typeof BUILD_EVENT_NAMES)[number];
export const FINISHED_OUTCOMES = ["merged", "unmerged", "failed", "cancelled", "abandoned"] as const;
export type FinishedOutcome = (typeof FINISHED_OUTCOMES)[number];

export interface BuildEventBase {
  schema: typeof BUILD_EVENT_SCHEMA;
  runid: string;
  at: string;
  event: BuildEventName;
}
export interface PlanEvent extends BuildEventBase {
  event: "plan";
  /** The plan's title, for a unit of a plan. */
  plan?: string;
  /** The plan file's path, when the work names one. */
  plan_path?: string;
  /** The repo as `owner/name`. */
  repo: string;
  units: { id: string; title: string }[];
}
export interface UnitStartedEvent extends BuildEventBase {
  event: "unit-started";
  id: string;
  /** The plan file's path, as the session's `plan` event named it. */
  plan_path?: string;
  /** The repo as `owner/name`. */
  repo: string;
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
  /** The run's branch, and the worktrees it left on disk, for a run that ended before its cleanup. */
  branch?: string;
  worktrees?: string[];
}
export type BuildEvent = PlanEvent | UnitStartedEvent | UnitMergedEvent | BlockedEvent | FinishedEvent;

const BASE_KEYS = ["schema", "runid", "at", "event"] as const;
/** Each event's own fields, in wire order: the keys the parser knows beyond the base four, and the
 *  emitter's flags (`eventFlag`). */
export const BUILD_EVENT_FIELDS = {
  plan: ["plan", "plan_path", "repo", "units"],
  "unit-started": ["id", "plan_path", "repo"],
  "unit-merged": ["id", "pr"],
  blocked: ["id", "needs"],
  finished: ["outcome", "pr", "branch", "worktrees"],
} as const satisfies Record<BuildEventName, readonly string[]>;

/** The list fields, each taken by a repeatable flag named for one item. */
export const BUILD_EVENT_LIST_FLAGS: Readonly<Record<string, string>> = { units: "--unit", worktrees: "--worktree" };

/** The emitter's flag for a field: `--<field>` with `_` typed `-`, or a list field's repeatable flag. */
export const eventFlag = (field: string): string => BUILD_EVENT_LIST_FLAGS[field] ?? `--${field.replaceAll("_", "-")}`;

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

function repoName(s: Shape, v: unknown): string {
  const parts = typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v) ? v.split("/") : [];
  if (parts.length === 2 && parts.every((p) => p !== "." && p !== "..")) return v as string;
  s.bad("repo", "a repo as <owner>/<name>");
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
      case "plan": {
        const plan = o.plan === undefined ? undefined : nonEmpty(s, o.plan, "plan");
        const plan_path = o.plan_path === undefined ? undefined : nonEmpty(s, o.plan_path, "plan_path");
        out = {
          ...base,
          event,
          ...(plan === undefined ? {} : { plan }),
          ...(plan_path === undefined ? {} : { plan_path }),
          repo: repoName(s, o.repo),
          units: readUnits(s, o.units),
        };
        break;
      }
      case "unit-started": {
        const id = unitId(s, o.id, "id");
        const plan_path = o.plan_path === undefined ? undefined : nonEmpty(s, o.plan_path, "plan_path");
        out = { ...base, event, id, ...(plan_path === undefined ? {} : { plan_path }), repo: repoName(s, o.repo) };
        break;
      }
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
        const branch = o.branch === undefined ? undefined : nonEmpty(s, o.branch, "branch");
        const worktrees = o.worktrees === undefined ? undefined : s.arr(o.worktrees, "worktrees").map((w, i) => nonEmpty(s, w, `worktrees[${i}]`));
        out = {
          ...base,
          event,
          outcome,
          ...(pr === undefined ? {} : { pr }),
          ...(branch === undefined ? {} : { branch }),
          ...(worktrees === undefined ? {} : { worktrees }),
        };
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
      wire = {
        ...base,
        ...(event.plan === undefined ? {} : { plan: event.plan }),
        ...(event.plan_path === undefined ? {} : { plan_path: event.plan_path }),
        repo: event.repo,
        units: event.units.map((u) => ({ id: u.id, title: u.title })),
      };
      break;
    case "unit-started":
      wire = { ...base, id: event.id, ...(event.plan_path === undefined ? {} : { plan_path: event.plan_path }), repo: event.repo };
      break;
    case "unit-merged":
      wire = { ...base, id: event.id, pr: event.pr };
      break;
    case "blocked":
      wire = { ...base, ...(event.id === undefined ? {} : { id: event.id }), needs: event.needs };
      break;
    case "finished":
      wire = {
        ...base,
        outcome: event.outcome,
        ...(event.pr === undefined ? {} : { pr: event.pr }),
        ...(event.branch === undefined ? {} : { branch: event.branch }),
        ...(event.worktrees === undefined ? {} : { worktrees: [...event.worktrees] }),
      };
      break;
  }
  return `${JSON.stringify(wire)}\n`;
}
