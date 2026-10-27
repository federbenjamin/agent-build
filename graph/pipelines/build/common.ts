/** What the build pipeline's checks and operations share: reading inputs, writing outputs, the
 *  run's start options and repo config. A repo step runs through `runProcess` (`adapters/process.ts`),
 *  in a process group of its own that an abort kills whole. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { Shape } from "../../../runtime/lib/shape.ts";
import type { CheckAnswer, CheckValue, DataValue, DataValues, FilesValue, RefValue } from "../../contracts.ts";

export const filesOf = (v: DataValue | undefined): string[] => (v?.schema === "files" ? v.files : []);

/** A check input, or undefined when the value is absent or not a check. */
export const checkOf = (v: DataValue | undefined): CheckValue | undefined => (v?.schema === "check" ? v : undefined);

/** The file named `name` among a files value's files. */
export const fileNamed = (v: DataValue | undefined, name: string): string | undefined => filesOf(v).find((f) => basename(f) === name);

export const readText = (path: string): string => readFileSync(path, "utf8");

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

/** The input's file `name`, parsed as JSON; throws naming the input when it is missing. */
export function inputJson<T>(inputs: DataValues, id: string, name: string): T {
  const f = fileNamed(inputs[id], name);
  if (f === undefined) throw new Error(`input ${id} holds no ${name}`);
  return readJsonFile<T>(f);
}

/** Write `<outDir>/<id>/<name>` (text, or JSON for an object) and return it as a files value. */
export function writeOut(outDir: string, id: string, files: Record<string, string | object>): FilesValue {
  const dir = join(outDir, id);
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
    out.push(path);
  }
  return { schema: "files", files: out.sort() };
}

export const check = (answer: CheckAnswer, detail: string): CheckValue => ({ schema: "check", answer, detail });
export const yes = (ok: boolean, detail: string): CheckValue => check(ok ? "pass" : "fail", detail);
export const commit = (sha: string): RefValue => ({ schema: "ref", kind: "commit", id: sha });

// ---- the run's start ----

/** `d.start`: the request and its options. A start text that is not a JSON object is the request. */
export interface Start {
  request: string;
  ticket?: string;
  base?: string;
  hold: boolean;
}

export function parseStart(text: string): Start {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { request: text, hold: false };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { request: text, hold: false };
  const s = new Shape("start");
  const o = raw as Record<string, unknown>;
  const ticket = s.optStr(o, "ticket", "(root)");
  const base = s.optStr(o, "base", "(root)");
  const start: Start = {
    request: s.str(o.request, "request"),
    ...(ticket === undefined ? {} : { ticket }),
    ...(base === undefined ? {} : { base }),
    hold: o.hold === undefined ? false : s.bool(o.hold, "hold"),
  };
  const issues = s.issues();
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join("\n"));
  return start;
}

export function startOf(inputs: DataValues): Start {
  const v = inputs.start;
  if (v?.schema !== "text") throw new Error("no start input");
  return parseStart(v.text);
}

// ---- the repo config K-load-config writes ----

export interface RepoConfig {
  /** The run tree the config was read in. */
  tree: string;
  stepsFile: string;
  steps: Record<string, string | null>;
  /** The repo's build notes, by `## ` section heading (lower-cased). */
  notes: Record<string, string>;
  /** Where briefs are committed in the tree; null keeps them in the run's store. */
  briefsDir: string | null;
  /** The branch a run starts from and freshens against. */
  baseRef: string;
  thresholds: Record<string, unknown>;
}

export const repoConfigOf = (inputs: DataValues): RepoConfig => inputJson<RepoConfig>(inputs, "repo-config", "repo-config.json");

/** A notes section's `run: <command>` lines, in order. */
export const runLines = (section: string | undefined): string[] =>
  (section ?? "")
    .split("\n")
    .map((l) => /^run:\s*(.+)$/.exec(l.trim())?.[1])
    .filter((c): c is string => c !== undefined);

/** The last `max` characters of a command's output, for a check's detail. */
export const tail = (text: string, max = 1500): string => (text.length <= max ? text.trim() : `…${text.slice(-max).trim()}`);

export const exists = existsSync;
