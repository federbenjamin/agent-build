#!/usr/bin/env node
/**
 * Make a mock fixture from a recorded /build run: a stand-in repo whose commits change the same paths
 * by the same line counts as the recorded ones (the lines themselves are synthetic, so no source
 * leaves its repo), the writers' commits as patches, and the recorded agent files as the stub agents'
 * outputs, with machine paths and addresses replaced by placeholders.
 *
 *   node mock/make.ts <fixture dir> --source <repo> --run-dir <dir> [--store <repo>] [--file <name>=<path> …] [--redact <word>=<by> …] [--ticket <prefix> …]
 *
 * `<fixture dir>/spec.json` says what to take (`Spec`); `--source` is the recorded run's repo,
 * `--store` the repo holding a brief kept outside the tree, `--run-dir` the recorded run dir, and each
 * `--file` a recorded file found elsewhere (a builder's final report). `--redact` replaces a private
 * name, `--ticket` a private tracker team's ids (`<prefix>-<n>` becomes `TEAM-<n>`); both are kept as
 * hashes in `<fixture dir>/redactions.json`, which the fixtures' privacy test reads. The files the spec
 * does not name (authored answers, edits) are left as they are.
 *
 * Each recorded commit owns a region of every file it touches: the base file holds, per commit, the
 * lines that commit deletes, between fixed separator lines; the commit deletes them and adds its own.
 * So any writer's patch applies, and any two writers merge, in whatever order the graph runs them.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gitOut, gitTry } from "../../runtime/lib/gitOps.ts";
import { isMain } from "../../runtime/lib/isMain.ts";
import { EMAIL, TILDE_HOME } from "../../runtime/lib/privateText.ts";

export interface Spec {
  run: string;
  /** The recorded run's base commit in `--source`. */
  base: string;
  brief: {
    /** Which repo holds the brief's versions. */
    repo: "source" | "store";
    /** Its path in that repo, from the folder `--source` or `--store` names. */
    path: string;
    /** The commits of each version, first draft first. */
    versions: string[];
    /** Its path in the stand-in tree; absent when the run's store keeps it: the tree holds no brief,
     *  and an amend is an empty `amend brief:` commit, as the recorded run made one. */
    at?: string;
  };
  /** Main's moves, in order: each a commit range of `--source` squashed into one stand-in commit. A
   *  `seed` move is on main when the repo is made; a later one only as its tag, for the replay to move
   *  main to. */
  main: { range: string; tag: string; seed: boolean }[];
  /** Each writer run, in the order the graph runs them: its role, its ref output, its fixture key,
   *  and the recorded commits it made, or the brief version it writes. */
  writers: { role: string; output: string; key?: string; commits?: string[]; brief?: number }[];
  /** Recorded files to copy: `run:<path in the run dir>` or `file:<name of a --file>`, to a path under
   *  `agents/`; `replace` lists the edits the v1 graph needs, each `[old, new]` (old must be present),
   *  and `dropLines` the prefixes of lines it removes (each must match one). */
  files: { from: string; to: string; replace?: [string, string][]; dropLines?: string[] }[];
}

interface Args {
  fixture: string;
  /** `--redact <word>=<by>`: a name the fixture must not hold, replaced in every text and path. */
  redact: [string, string][];
  /** `--ticket <prefix>`: a private tracker team whose ids (`<prefix>-<n>`) become `TEAM-<n>`. */
  tickets: string[];
  source: string;
  store: string | null;
  runDir: string;
  files: Record<string, string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** The temp repo's git settings: a fixed identity, no signing, and no background gc or maintenance
 *  writing into the repo while it is removed. */
const IDENT = ["-c", "user.name=mock", "-c", "user.email=mock@localhost", "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
const DATE_ENV = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
/** The stand-in's own files; a recorded commit may not touch them. */
const CONTROL = { steps: ".claude/build-steps.toml", notes: ".build/notes.md", thresholds: ".build/thresholds.json", replay: ".build/replay.json", script: ".build/replay-steps.mjs" };

/** `word` replaced by `by` in `text`, any case, keeping the case of each match (`Word`, `WORD`, `word`). */
export function redactWord(text: string, word: string, by: string): string {
  return text.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) =>
    m === m.toUpperCase() && m !== m.toLowerCase() ? by.toUpperCase() : m[0] === m[0]!.toUpperCase() && m[0] !== m[0]!.toLowerCase() ? by[0]!.toUpperCase() + by.slice(1) : by
  );
}

/** The placeholder team a private tracker's ids are rewritten to. */
export const PLACEHOLDER_TEAM = "team";

/** Each `<prefix>-<n>` ticket id in `text` as `TEAM-<n>`, any case, keeping the case of each match. */
export function redactTicket(text: string, prefix: string): string {
  return text.replace(new RegExp(`\\b(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})-(\\d+)\\b`, "gi"), (_m, p: string, n: string) => `${redactWord(p, p, PLACEHOLDER_TEAM)}-${n}`);
}

/** A recorded file's text with what is personal replaced: home paths (absolute or `~/`), temp paths,
 *  addresses, URLs, each `[word, by]` of `redact` (a private repo's name), and each ticket prefix's
 *  ids. */
export function sanitise(text: string, home: string, redact: readonly [string, string][] = [], tickets: readonly string[] = []): string {
  return tickets
    .reduce((t, prefix) => redactTicket(t, prefix), redact.reduce((t, [word, by]) => redactWord(t, word, by), text))
    .replaceAll(home, "<home>")
    .replace(new RegExp(TILDE_HOME, "g"), "<home>/")
    .replace(/\/(?:private\/)?tmp\/claude[^\s`'")]*/g, "<tmp>")
    .replace(/\/private\/var\/folders\/[^\s`'")]*/g, "<tmp>")
    .replace(new RegExp(EMAIL, "g"), "<email>")
    .replace(/https?:\/\/github\.com\/[^\s`'")]*/g, "<forge-url>")
    .replace(/https?:\/\/linear\.app\/[^\s`'")]*/g, "<tracker-url>");
}

interface Touch {
  commit: string;
  added: number;
  deleted: number;
  status: "A" | "M" | "D";
}

function touches(source: string, commit: string, range = false): Map<string, Touch> {
  const spec = range ? [commit] : [`${commit}^`, commit];
  const numstat = gitOut(["diff", "--no-renames", "--numstat", ...spec], { cwd: source });
  const status = gitOut(["diff", "--no-renames", "--name-status", ...spec], { cwd: source });
  const kinds = new Map(
    status
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [k, p] = l.split("\t");
        return [p!, (k!.startsWith("A") ? "A" : k!.startsWith("D") ? "D" : "M") as Touch["status"]];
      })
  );
  const out = new Map<string, Touch>();
  for (const l of numstat.split("\n").filter(Boolean)) {
    const [a, d, p] = l.split("\t");
    const num = (s: string) => (s === "-" ? 1 : Number(s));
    out.set(p!, { commit, added: num(a!), deleted: num(d!), status: kinds.get(p!) ?? "M" });
  }
  return out;
}

const sep = (path: string, k: number) => Array.from({ length: 4 }, (_, i) => `-- ${path} · keep ${k}.${i + 1}`);
const oldLines = (k: number, n: number) => Array.from({ length: n }, (_, i) => `c${k} line ${i + 1}`);
const newLines = (k: number, n: number) => Array.from({ length: n }, (_, i) => `c${k} new line ${i + 1}`);

/** Every stand-in file: its lines as each step leaves them, built by region. */
class StandIn {
  readonly files = new Map<string, string[]>();
  readonly notes: string[] = [];
  /** The steps touching each path, in order, as region numbers. */
  private plan = new Map<string, { k: number; t: Touch }[]>();

  addStep(k: number, changes: Map<string, Touch>): void {
    for (const [p, t] of changes) this.plan.set(p, [...(this.plan.get(p) ?? []), { k, t }]);
  }

  /** The base: each path that exists at base holds a region per step that touches it. */
  base(existsAtBase: (p: string) => boolean): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, steps] of this.plan) {
      const creator = steps[0]!.t.status === "A";
      if (!existsAtBase(p) || creator) continue;
      const lines = [`stand-in for ${p}: synthetic lines; each recorded commit's region holds the lines it deletes`];
      for (const s of steps) lines.push(...sep(p, s.k), ...oldLines(s.k, s.t.status === "D" ? 0 : s.t.deleted));
      lines.push(...sep(p, 9999));
      this.files.set(p, lines);
      out[p] = `${lines.join("\n")}\n`;
    }
    return out;
  }

  /** Apply step `k` to the tree in `dir`. */
  apply(k: number, dir: string): void {
    for (const [p, steps] of this.plan) {
      const at = steps.findIndex((s) => s.k === k);
      if (at < 0) continue;
      const { t } = steps[at]!;
      const file = join(dir, p);
      if (t.status === "D") {
        const had = this.files.get(p)?.length ?? 0;
        if (had !== t.deleted) this.notes.push(`${p}: deleted ${had} lines, recorded ${t.deleted}`);
        rmSync(file, { force: true });
        this.files.delete(p);
        continue;
      }
      if (t.status === "A" && !this.files.has(p)) {
        const later = steps.slice(at + 1).filter((s) => s.t.status !== "A");
        const body: string[] = [];
        for (const s of later) body.push(...sep(p, s.k), ...oldLines(s.k, s.t.status === "D" ? 0 : s.t.deleted));
        if (later.length > 0) body.push(...sep(p, 9999));
        const own = newLines(k, Math.max(0, t.added - body.length));
        if (body.length > t.added) this.notes.push(`${p}: created with ${body.length} lines for the later commits' regions, recorded ${t.added}`);
        const lines = [...own, ...body];
        this.files.set(p, lines);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${lines.join("\n")}\n`);
        continue;
      }
      const lines = this.files.get(p);
      if (lines === undefined) throw new Error(`${p}: step ${k} modifies a file the stand-in does not hold`);
      const start = lines.indexOf(`-- ${p} · keep ${k}.4`) + 1;
      if (start === 0) throw new Error(`${p}: no region for step ${k}`);
      const old = oldLines(k, t.deleted);
      lines.splice(start, old.length, ...newLines(k, t.added));
      writeFileSync(file, `${lines.join("\n")}\n`);
    }
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", [...IDENT, ...args], { cwd: dir, env: DATE_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", message]);
  return gitOut(["rev-parse", "HEAD"], { cwd: dir }).trim();
}

/** `git format-patch` of `from..to` into `dir` (emptied first). */
function patches(repo: string, from: string, to: string, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  gitOut(["format-patch", "-q", "--no-signature", "--zero-commit", "-o", dir, `${from}..${to}`], { cwd: repo });
}

function subjectOf(repo: string, commit: string): string {
  return gitOut(["log", "-1", "--format=%s", commit], { cwd: repo }).trim();
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Build the fixture's `repo/` and the writers' patches, and copy the recorded files; returns where
 *  the stand-in could not match a recorded line count. */
export function make(a: Args): string[] {
  const spec = JSON.parse(readFileSync(join(a.fixture, "spec.json"), "utf8")) as Spec;
  const clean = (t: string) => sanitise(t, process.env.HOME ?? "/nonexistent-home", a.redact, a.tickets);
  writeFile(join(a.fixture, "redactions.json"), `${JSON.stringify(redactions(a), null, 2)}\n`);
  const briefRepo = spec.brief.repo === "store" ? a.store : a.source;
  if (briefRepo === null) throw new Error("the brief lives in the store: pass --store <repo>");
  const prefix = gitOut(["rev-parse", "--show-prefix"], { cwd: briefRepo }).trim();
  const versions = spec.brief.versions.map((c) => clean(gitOut(["show", `${c}:${prefix}${spec.brief.path}`], { cwd: briefRepo })));
  const briefAt = spec.brief.at === undefined ? null : a.redact.reduce((t, [word, by]) => redactWord(t, word, by), spec.brief.at);
  const reserved = new Set([...Object.values(CONTROL), spec.brief.at ?? "", spec.brief.repo === "source" ? spec.brief.path : ""]);
  const original = new Map<string, string>();
  const recorded = (c: string, range = false): Map<string, Touch> => {
    const out = new Map<string, Touch>();
    for (const [p, t] of touches(a.source, c, range)) {
      if (reserved.has(p)) continue;
      const at = clean(p);
      original.set(at, p);
      out.set(at, t);
    }
    return out;
  };

  const standIn = new StandIn();
  let k = 0;
  const mainSteps = spec.main.map((m) => {
    standIn.addStep(++k, recorded(m.range, true));
    return k;
  });
  const writerSteps = spec.writers.map((w) =>
    (w.commits ?? []).map((c) => {
      standIn.addStep(++k, recorded(c));
      return { k, subject: clean(subjectOf(a.source, c)) };
    })
  );

  const control = join(a.fixture, "repo", "control");
  const base: Record<string, string> = {
    ...standIn.base((p) => gitTry(["cat-file", "-e", `${spec.base}:${original.get(p) ?? p}`], { cwd: a.source }) !== null),
    [CONTROL.steps]: readFileSync(join(control, "build-steps.toml"), "utf8"),
    ...(existsSync(join(control, "thresholds.json")) ? { [CONTROL.thresholds]: readFileSync(join(control, "thresholds.json"), "utf8") } : {}),
    [CONTROL.notes]: readFileSync(join(control, "notes.md"), "utf8"),
    [CONTROL.replay]: readFileSync(join(control, "replay.json"), "utf8"),
    [CONTROL.script]: readFileSync(join(HERE, "replay-steps.mjs"), "utf8"),
  };
  writeFile(join(a.fixture, "repo", "base.json"), `${JSON.stringify(base, null, 1)}\n`);

  const tmp = mkdtempSync(join(tmpdir(), "mock-fixture-"));
  try {
    git(tmp, ["init", "-q", "-b", "main"]);
    for (const [p, content] of Object.entries(base)) writeFile(join(tmp, p), content);
    const baseSha = commitAll(tmp, "base");
    const mainDir = join(a.fixture, "repo", "main");
    rmSync(mainDir, { recursive: true, force: true });
    let prev = baseSha;
    spec.main.forEach((m, i) => {
      standIn.apply(mainSteps[i]!, tmp);
      const end = m.range.split("..")[1]!;
      const sha = commitAll(tmp, `main: ${clean(subjectOf(a.source, end))}`);
      patches(tmp, prev, sha, join(mainDir, m.tag.replaceAll("/", "-")));
      prev = sha;
    });
    writeFile(join(a.fixture, "repo", "main.json"), `${JSON.stringify(spec.main.map((m) => ({ tag: m.tag, seed: m.seed, dir: m.tag.replaceAll("/", "-") })), null, 2)}\n`);

    git(tmp, ["checkout", "-q", "-b", "work", baseSha]);
    const name = clean((briefAt ?? spec.brief.path).split("/").pop()!);
    if (briefAt !== null) {
      writeFile(join(tmp, briefAt), versions[0]!);
      commitAll(tmp, `brief: ${name.replace(/\.md$/, "")}`);
    }
    writeFile(join(a.fixture, "agents", "write-brief", "brief", name), versions[0]!);
    spec.writers.forEach((w, i) => {
      const from = gitOut(["rev-parse", "HEAD"], { cwd: tmp }).trim();
      if (w.brief !== undefined) {
        const subject = clean(subjectOf(briefRepo, spec.brief.versions[w.brief]!));
        if (briefAt === null) commitAll(tmp, subject);
        else {
          writeFile(join(tmp, briefAt), versions[w.brief]!);
          if (gitOut(["status", "--porcelain"], { cwd: tmp }).trim() !== "") commitAll(tmp, subject);
        }
        writeFile(join(a.fixture, "agents", w.role, "brief-amended", `@${w.key}`, name), versions[w.brief]!);
      }
      for (const s of writerSteps[i]!) {
        standIn.apply(s.k, tmp);
        commitAll(tmp, s.subject);
      }
      const to = gitOut(["rev-parse", "HEAD"], { cwd: tmp }).trim();
      const dir = join(a.fixture, "agents", w.role, w.output, ...(w.key === undefined ? [] : [`@${w.key}`]));
      if (from === to) {
        rmSync(dir, { recursive: true, force: true });
        writeFile(join(dir, ".keep"), "this run made no commit\n");
      } else patches(tmp, from, to, dir);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  for (const f of spec.files) {
    const [kind, rest] = [f.from.slice(0, f.from.indexOf(":")), f.from.slice(f.from.indexOf(":") + 1)];
    const src = kind === "run" ? join(a.runDir, rest) : kind === "file" ? a.files[rest] : undefined;
    if (src === undefined || !existsSync(src)) throw new Error(`${f.from}: no such recorded file`);
    let text = clean(readFileSync(src, "utf8"));
    for (const [old, now] of f.replace ?? []) {
      if (!text.includes(old)) throw new Error(`${f.from}: the edit's text is not there: ${old}`);
      text = text.replaceAll(old, now);
    }
    for (const prefix of f.dropLines ?? []) {
      const lines = text.split("\n");
      if (!lines.some((l) => l.startsWith(prefix))) throw new Error(`${f.from}: no line starts with ${prefix}`);
      text = lines.filter((l) => !l.startsWith(prefix)).join("\n");
    }
    writeFile(join(a.fixture, "agents", f.to), text);
  }
  return standIn.notes;
}

/** What `redactions.json` holds: each redacted word and ticket prefix, lower-cased and hashed, so the
 *  privacy test can look for them without the repo naming them. */
export interface Redactions {
  words: { sha256: string; length: number }[];
  tickets: { sha256: string }[];
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function redactions(a: Args): Redactions {
  return {
    words: a.redact.map(([w]) => ({ sha256: sha256(w.toLowerCase()), length: w.length })),
    tickets: a.tickets.map((t) => ({ sha256: sha256(t.toLowerCase()) })),
  };
}

function parseArgs(argv: string[]): Args {
  const [fixture, ...rest] = argv;
  if (fixture === undefined) throw new Error("usage: make.ts <fixture dir> --source <repo> --run-dir <dir> [--store <repo>] [--file <name>=<path> …] [--redact <word>=<by> …] [--ticket <prefix> …]");
  const out: Args = { fixture: resolve(fixture), redact: [], tickets: [], source: "", store: null, runDir: "", files: {} };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--source") out.source = resolve(value);
    else if (flag === "--store") out.store = resolve(value);
    else if (flag === "--run-dir") out.runDir = resolve(value);
    else if (flag === "--redact") {
      const eq = value.indexOf("=");
      if (eq <= 0) throw new Error("--redact takes <word>=<by>");
      out.redact.push([value.slice(0, eq), value.slice(eq + 1)]);
    }
    else if (flag === "--ticket") out.tickets.push(value);
    else if (flag === "--file") {
      const eq = value.indexOf("=");
      out.files[value.slice(0, eq)] = resolve(value.slice(eq + 1));
    } else throw new Error(`unknown flag ${flag}`);
  }
  if (out.source === "" || out.runDir === "") throw new Error("--source and --run-dir are required");
  return out;
}

if (isMain(import.meta.url)) {
  const notes = make(parseArgs(process.argv.slice(2)));
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`made ${process.argv[2]}`);
}
