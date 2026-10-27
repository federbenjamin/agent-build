/**
 * Parsers for the adapter bindings of a run config (`config.ts` calls them). Each reads a JSON
 * value, reports every bad path through the `Shape`, and returns the typed binding. A Jev or Haiku
 * binding may name a `setup` file (a tuned setup shipped under `classifiers/`); its keys are read
 * first and the binding's own keys override them.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { Shape } from "../runtime/lib/shape.ts";
import { HAIKU_MAX_CALLS, HAIKU_MODEL, JEV_SCORE_LEVELS } from "./constants.ts";
import {
  CHECK_ANSWERS,
  type CheckAnswer,
  type CheckBinding,
  type ClassifierAnswer,
  type ClassifierBinding,
  COMBINES,
  DIFF_SHAPES,
  FIELD_SAMPLES,
  type AgentBinding,
  type FileBinding,
  type ForgeBinding,
  type HaikuBinding,
  type JevBinding,
  type JevQuestion,
  type PatternFeature,
  SETUP_STATUSES,
  type SetupId,
  type SetupStatus,
  type StateField,
  type StubAgentBinding,
  type TrackerBinding,
} from "./contracts.ts";

/** `p` made absolute from `base`. */
export const abs = (base: string, p: string): string => (isAbsolute(p) ? p : resolve(base, p));

function stubAgent(s: Shape, o: Record<string, unknown>, path: string, base: string): StubAgentBinding {
  onlyKeys(s, o, ["adapter", "fixtureDir", "ask", "hangOnAttempts", "replay"], path);
  const ask = s.optStr(o, "ask", path);
  const hang = o.hangOnAttempts === undefined ? undefined : s.arr(o.hangOnAttempts, `${path}.hangOnAttempts`).map((x, i) => s.int(x, `${path}.hangOnAttempts[${i}]`));
  const replay = s.optStr(o, "replay", path);
  return {
    adapter: "stub",
    fixtureDir: abs(base, s.str(o.fixtureDir, `${path}.fixtureDir`)),
    ...(ask === undefined ? {} : { ask }),
    ...(hang === undefined ? {} : { hangOnAttempts: hang }),
    ...(replay === undefined ? {} : { replay: abs(base, replay) }),
  };
}

export function agentBinding(s: Shape, v: unknown, path: string, base: string): AgentBinding {
  const o = s.obj(v, path) ?? {};
  const adapter = s.oneOf(o.adapter, ["stub", "claude", "codex"] as const, `${path}.adapter`);
  if (adapter === "codex") {
    onlyKeys(s, o, ["adapter", "role"], path);
    const role = s.optStr(o, "role", path);
    return { adapter, ...(role === undefined ? {} : { role }) };
  }
  if (adapter === "claude") {
    onlyKeys(s, o, ["adapter", "plugin", "model", "permissionMode", "agentFromItem"], path);
    const plugin = s.optStr(o, "plugin", path);
    const model = s.optStr(o, "model", path);
    const permissionMode = s.optStr(o, "permissionMode", path);
    const fromItem = o.agentFromItem === undefined ? undefined : s.bool(o.agentFromItem, `${path}.agentFromItem`);
    return {
      adapter,
      ...(plugin === undefined ? {} : { plugin }),
      ...(model === undefined ? {} : { model }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(fromItem === true ? { agentFromItem: true } : {}),
    };
  }
  return stubAgent(s, o, path, base);
}

function answers<A>(s: Shape, o: Record<string, unknown>, path: string, one: (x: unknown, p: string) => A): { answers: Record<string, A | A[]>; default: A } {
  const map = s.obj(o.answers ?? {}, `${path}.answers`) ?? {};
  const out: Record<string, A | A[]> = {};
  for (const [role, a] of Object.entries(map)) {
    out[role] = Array.isArray(a) ? a.map((x, i) => one(x, `${path}.answers.${role}[${i}]`)) : one(a, `${path}.answers.${role}`);
  }
  return { answers: out, default: one(o.default, `${path}.default`) };
}

function classifierAnswer(s: Shape): (x: unknown, p: string) => ClassifierAnswer {
  return (x, path) => {
    const o = s.obj(x, path) ?? {};
    const p = typeof o.p === "number" && o.p >= 0 && o.p <= 1 ? o.p : (s.bad(`${path}.p`, "a number in [0, 1]"), 0);
    return { answer: s.str(o.answer, `${path}.answer`), p };
  };
}

const num01 = (s: Shape, v: unknown, path: string): number => (typeof v === "number" && v >= 0 && v <= 1 ? v : (s.bad(path, "a number in [0, 1]"), 0));

/** Refuses each key of `o` not in `allowed`: a misspelled key would otherwise fall back to its
 *  default, and a binding or setup run as it was not written. */
function onlyKeys(s: Shape, o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) s.bad(`${path}.${key}`, `no such key: one of ${allowed.join(", ")}`);
}

/** The keys a setup file carries beside its binding's: its status (kept on the binding, which
 *  explores an `initial` setup), and the report it came from. */
const SETUP_RECORD_KEYS = ["status", "report"];

/** The setup's `status`, kept on the binding: an `initial` setup is explored in a real run. */
function setupStatus(s: Shape, o: Record<string, unknown>, path: string): { status?: SetupStatus } {
  return o.status === undefined ? {} : { status: s.oneOf(o.status, SETUP_STATUSES, `${path}.status`) };
}

/** A string that compiles as a multiline regular expression. */
function regex(s: Shape, v: unknown, path: string): string {
  const pattern = s.str(v, path);
  try {
    new RegExp(pattern, "m");
  } catch {
    s.bad(path, "a valid regular expression");
  }
  return pattern;
}

function stateFields(s: Shape, v: unknown, path: string): Record<string, StateField> {
  const out: Record<string, StateField> = {};
  const map = s.obj(v, path) ?? {};
  if (Object.keys(map).length === 0) s.bad(path, "at least one field");
  for (const [name, raw] of Object.entries(map)) {
    const at = `${path}.${name}`;
    const o = s.obj(raw, at) ?? {};
    onlyKeys(s, o, ["input", "optional", "cutBefore", "shape", "maxChars", "sample", "keep", "note"], at);
    const shape = o.shape === undefined ? undefined : s.oneOf(o.shape, DIFF_SHAPES, `${at}.shape`);
    const maxChars = o.maxChars === undefined ? undefined : s.int(o.maxChars, `${at}.maxChars`);
    if (maxChars === 0) s.bad(`${at}.maxChars`, "a positive integer");
    const note = o.note === undefined ? undefined : s.obj(o.note, `${at}.note`) ?? {};
    if (note !== undefined) onlyKeys(s, note, ["field", "text"], `${at}.note`);
    const optional = o.optional === undefined ? undefined : typeof o.optional === "boolean" ? o.optional : (s.bad(`${at}.optional`, "true or false"), undefined);
    const keep = o.keep === undefined ? undefined : s.strs(o.keep, `${at}.keep`);
    if (keep !== undefined && maxChars === undefined) s.bad(`${at}.keep`, "set only beside maxChars: it says what a sample keeps");
    if (keep !== undefined && shape !== undefined) s.bad(`${at}.keep`, "set only on a field that is not a diff: a diff is sampled by file");
    const sample = o.sample === undefined ? undefined : s.oneOf(o.sample, FIELD_SAMPLES, `${at}.sample`);
    const cutBefore = o.cutBefore === undefined ? undefined : regex(s, o.cutBefore, `${at}.cutBefore`);
    if (sample !== undefined && maxChars === undefined) s.bad(`${at}.sample`, "set only beside maxChars");
    if (sample === "head" && keep !== undefined) s.bad(`${at}.keep`, "unused with sample head, which keeps the first maxChars characters");
    out[name] = {
      input: s.str(o.input, `${at}.input`),
      ...(optional === true ? { optional } : {}),
      ...(cutBefore === undefined ? {} : { cutBefore }),
      ...(shape === undefined ? {} : { shape }),
      ...(maxChars === undefined ? {} : { maxChars }),
      ...(keep === undefined ? {} : { keep }),
      ...(sample === undefined ? {} : { sample }),
      ...(note === undefined ? {} : { note: { field: s.str(note.field, `${at}.note.field`), text: s.str(note.text, `${at}.note.text`) } }),
    };
  }
  return out;
}

function jevQuestions(s: Shape, v: unknown, path: string): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  const map = s.obj(v, path) ?? {};
  if (Object.keys(map).length === 0) s.bad(path, "at least one question");
  for (const [name, raw] of Object.entries(map)) {
    const at = `${path}.${name}`;
    const o = s.obj(raw, at) ?? {};
    onlyKeys(s, o, ["type", "instructions", "criteria"], at);
    const type = s.oneOf(o.type, ["noul", "score"] as const, `${at}.type`);
    const instructions = s.optStr(o, "instructions", at);
    const head = instructions === undefined ? {} : { instructions };
    if (type === "score") {
      const levels = s.strs(o.criteria, `${at}.criteria`);
      if (levels.length < JEV_SCORE_LEVELS.min || levels.length > JEV_SCORE_LEVELS.max) s.bad(`${at}.criteria`, `${JEV_SCORE_LEVELS.min} to ${JEV_SCORE_LEVELS.max} levels`);
      out[name] = { type, ...head, criteria: levels };
      continue;
    }
    const c = o.criteria === undefined ? undefined : s.obj(o.criteria, `${at}.criteria`) ?? {};
    if (c !== undefined) onlyKeys(s, c, ["true", "false"], `${at}.criteria`);
    const t = c === undefined ? undefined : s.optStr(c, "true", `${at}.criteria`);
    const f = c === undefined ? undefined : s.optStr(c, "false", `${at}.criteria`);
    if (instructions === undefined && t === undefined && f === undefined) s.bad(at, "instructions or criteria");
    out[name] = { type, ...head, ...(c === undefined ? {} : { criteria: { ...(t === undefined ? {} : { true: t }), ...(f === undefined ? {} : { false: f }) } }) };
  }
  return out;
}

function features(s: Shape, v: unknown, path: string): PatternFeature[] {
  return (v === undefined ? [] : s.arr(v, path)).map((raw, i) => {
    const at = `${path}[${i}]`;
    const o = s.obj(raw, at) ?? {};
    onlyKeys(s, o, ["input", "pattern", "weight"], at);
    const pattern = regex(s, o.pattern, `${at}.pattern`);
    const weight = typeof o.weight === "number" && Number.isFinite(o.weight) ? o.weight : (s.bad(`${at}.weight`, "a number"), 0);
    return { input: s.str(o.input, `${at}.input`), pattern, weight };
  });
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `o` with the keys of its `setup` file under it (the binding's own keys win), and the setup's id
 *  for the decision record: the file's name and a hash of its bytes, with the keys the binding set
 *  over them; `inline` and a hash of the binding as written when it names no file. */
function withSetup(s: Shape, o: Record<string, unknown>, path: string, base: string): { o: Record<string, unknown>; setup: SetupId } {
  if (o.setup === undefined) return { o, setup: { name: "inline", sha256: sha256(JSON.stringify(o)) } };
  const file = abs(base, s.str(o.setup, `${path}.setup`));
  try {
    const text = readFileSync(file, "utf8");
    const setup = JSON.parse(text) as Record<string, unknown>;
    const { setup: _, ...own } = o;
    const overrides = Object.keys(own).filter((k) => k !== "adapter");
    return { o: { ...setup, ...own }, setup: { name: basename(file, ".json"), sha256: sha256(text), ...(overrides.length === 0 ? {} : { overrides }) } };
  } catch (e) {
    s.bad(`${path}.setup`, `a readable JSON file (${(e as Error).message})`);
    return { o, setup: { name: "unreadable", sha256: "" } };
  }
}

function jevBinding(s: Shape, o: Record<string, unknown>, path: string, setup: SetupId): JevBinding {
  onlyKeys(s, o, ["adapter", "model", "fields", "questions", "combine", "features", "cutoff", ...SETUP_RECORD_KEYS], path);
  return {
    adapter: "jev",
    setup,
    ...setupStatus(s, o, path),
    model: s.str(o.model, `${path}.model`),
    fields: stateFields(s, o.fields, `${path}.fields`),
    questions: jevQuestions(s, o.questions, `${path}.questions`),
    combine: o.combine === undefined ? "mean" : s.oneOf(o.combine, COMBINES, `${path}.combine`),
    features: features(s, o.features, `${path}.features`),
    cutoff: num01(s, o.cutoff, `${path}.cutoff`),
  };
}

function haikuBinding(s: Shape, o: Record<string, unknown>, path: string, setup: SetupId): HaikuBinding {
  const jevKeys = ["questions", "features", "combine", "question"];
  for (const key of jevKeys) {
    if (o[key] !== undefined) s.bad(`${path}.${key}`, "no such key for haiku: its system prompt carries the question and its p is the mean of its calls, so this key would be dropped");
  }
  onlyKeys(s, o, ["adapter", "model", "fields", "system", "prompt", "calls", "cutoff", ...SETUP_RECORD_KEYS, ...jevKeys], path);
  const model = s.optStr(o, "model", path);
  const fields = stateFields(s, o.fields, `${path}.fields`);
  const prompt = s.str(o.prompt, `${path}.prompt`);
  const namesOf = (f: StateField, name: string) => (f.note === undefined ? [name] : [name, f.note.field]);
  const names = new Set(Object.entries(fields).flatMap(([name, f]) => namesOf(f, name)));
  const optional = new Set(Object.entries(fields).flatMap(([name, f]) => (f.optional === true ? namesOf(f, name) : [])));
  for (const [, name] of prompt.matchAll(/\{\{([\w-]+)\}\}/g)) {
    if (!names.has(name!)) s.bad(`${path}.prompt`, `placeholders that name a field or a note; {{${name}}} names neither`);
    else if (optional.has(name!)) s.bad(`${path}.prompt`, `placeholders that name a field every run has; {{${name}}} names an optional field, absent from some runs, and the prompt has nothing to put there`);
  }
  const calls = o.calls === undefined ? 1 : s.int(o.calls, `${path}.calls`);
  if (calls < 1 || calls > HAIKU_MAX_CALLS) s.bad(`${path}.calls`, `1 to ${HAIKU_MAX_CALLS}`);
  return {
    adapter: "haiku",
    setup,
    ...setupStatus(s, o, path),
    model: model ?? HAIKU_MODEL,
    fields,
    system: s.str(o.system, `${path}.system`),
    prompt,
    calls,
    cutoff: num01(s, o.cutoff, `${path}.cutoff`),
  };
}

export function classifierBinding(s: Shape, v: unknown, path: string, base: string): ClassifierBinding {
  const o0 = s.obj(v, path) ?? {};
  const adapter = s.oneOf(o0.adapter, ["stub", "jev", "haiku"] as const, `${path}.adapter`);
  if (adapter === "stub") {
    onlyKeys(s, o0, ["adapter", "answers", "default"], path);
    return { adapter, ...answers(s, o0, path, classifierAnswer(s)) };
  }
  const { o, setup } = withSetup(s, o0, path, base);
  return adapter === "jev" ? jevBinding(s, o, path, setup) : haikuBinding(s, o, path, setup);
}

export function checkBinding(s: Shape, v: unknown, path: string): CheckBinding {
  const o = s.obj(v, path) ?? {};
  const adapter = s.oneOf(o.adapter, ["stub", "shell", "pipeline"] as const, `${path}.adapter`);
  onlyKeys(s, o, adapter === "stub" ? ["adapter", "answers", "default"] : ["adapter"], path);
  if (adapter === "shell" || adapter === "pipeline") return { adapter };
  return { adapter, ...answers(s, o, path, (x, p): CheckAnswer => s.oneOf(x, CHECK_ANSWERS, p)) };
}

function fileBinding(s: Shape, o: Record<string, unknown>, path: string, base: string): FileBinding {
  onlyKeys(s, o, ["adapter", "dir"], path);
  const dir = s.optStr(o, "dir", path);
  return { adapter: "file", ...(dir === undefined ? {} : { dir: abs(base, dir) }) };
}

/** A missing tracker or forge is the file-backed fake. */
export function trackerBinding(s: Shape, v: unknown, path: string, base: string): TrackerBinding {
  if (v === undefined) return { adapter: "file" };
  const o = s.obj(v, path) ?? {};
  const adapter = s.oneOf(o.adapter, ["file", "linear"] as const, `${path}.adapter`);
  if (adapter === "linear") onlyKeys(s, o, ["adapter"], path);
  return adapter === "linear" ? { adapter } : fileBinding(s, o, path, base);
}

export function forgeBinding(s: Shape, v: unknown, path: string, base: string): ForgeBinding {
  if (v === undefined) return { adapter: "file" };
  const o = s.obj(v, path) ?? {};
  const adapter = s.oneOf(o.adapter, ["file", "github"] as const, `${path}.adapter`);
  if (adapter === "github") onlyKeys(s, o, ["adapter"], path);
  return adapter === "github" ? { adapter } : fileBinding(s, o, path, base);
}
