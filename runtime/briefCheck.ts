/**
 * briefCheck — the claim counter. Reads a brief's machine-read parts (`R/lib/brief.ts`) and prints them:
 *
 *   node ~/.agent-build/runtime/briefCheck.ts <path> [--at <commit>] [--json]
 *
 *   class: R<n>            (or `none` on a draft the class moment has not pinned yet)
 *   model: <m>
 *   target-files: <n>
 *   claims: <n> (H1, H2, …)
 *   parts: <n> (P1 sonnet, P2 opus after P1)        (the implicit P1 when there is no `## Parts`)
 *   slices: <n> (W1 db, 2 functions; …)             (`— over the <g> guide` past TEST_SLICE_MAX_FUNCTIONS)
 *
 * The slice guide is `TEST_SLICE_MAX_FUNCTIONS` from the thresholds of the code repo (the brief's own
 * `git rev-parse --show-toplevel`, or the cwd's for a brief in the store, `repoId.ts`; the default
 * outside a repo), read only when the brief has a slice. A slice over it is a warning on its line,
 * never an exit 1.
 *
 *   briefCheck.ts <path> --base <ref>                adds `order: ok`, or `order: <why>` and exit 1:
 *                                                   the brief-first proof (`briefOrder`, `lib/owed.ts`)
 *                                                   over the code repo's `<ref>..HEAD`
 *
 * Two excerpt modes, for the session to write into its inputs dir:
 *
 *   briefCheck.ts <path> --files <P<k>|W<k>>    one path per line: a part's `files:` then `test files:`,
 *                                               or a slice's `files:`
 *   briefCheck.ts <path> --slice W<k>           the writer's excerpt: the slice block, each covered
 *                                               deliverable verbatim with its position, `## Public
 *                                               surface`, and `## Locked decisions` when present
 *
 * The `--from-branch` hand-test file (its one `## ` section is `## Hand test`, under its pinned class
 * line) prints `class:` and `claims:` only. `--at` reads `git show <commit>:<path>`; there, a part
 * missing from a brief written before the parts existed is legacy, not an error:
 * `claims: 0 (legacy: no section)`.
 * Exit 0 ok · 1 the order check fails, a part is malformed or missing (the message names the part and line), a claim's
 * `run:` is a test runner (`TEST_RUNNER_RES`) or the repo's manifest step with no exercise to run (neither
 * checked under `--at` or an excerpt mode), or the id
 * an excerpt mode names is not in the brief · 2 usage or unreadable input.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import {
  BriefPartError,
  type BriefSummary,
  manifestWithoutExercise,
  sliceExcerpt,
  summariseBrief,
  testRunnerOf,
} from "./lib/brief.ts";
import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { exitWhenFlushed } from "./lib/exitWhenFlushed.ts";
import { gitOut, gitTry } from "./lib/gitOps.ts";
import { isMain } from "./lib/isMain.ts";
import { briefOrder, firstAddingCommit } from "./lib/owed.ts";
import { inStore, inStoreOf, storeDir } from "./lib/repoId.ts";
import { stepCommand } from "./steps.ts";
import { DEFAULTS, loadThresholds } from "./thresholds.ts";

const USAGE = "usage: briefCheck.ts <path> [--at <commit>] [--json | --files <P<k>|W<k>> | --slice W<k>] | <path> --base <ref>";

/** The text lines briefCheck prints for a summary. `sliceGuide` is `TEST_SLICE_MAX_FUNCTIONS`. */
export function formatSummary(s: BriefSummary, sliceGuide: number = DEFAULTS.TEST_SLICE_MAX_FUNCTIONS): string[] {
  const claims =
    s.claims.length > 0
      ? `claims: ${s.claims.length} (${s.claims.map((c) => c.id).join(", ")})`
      : s.legacy.includes("hand-test")
        ? "claims: 0 (legacy: no section)"
        : "claims: 0 (none)";
  const cls = `class: ${s.cls ?? "none"}`;
  if (s.kind === "hand-test-block") return [cls, claims];
  const part = (p: BriefSummary["parts"][number]) => `${p.id} ${p.model}${p.after.length > 0 ? ` after ${p.after.join("+")}` : ""}`;
  const parts =
    s.parts.length === 0
      ? "parts: 0 (legacy: no model line or target files)"
      : `parts: ${s.parts.length} (${s.parts.map(part).join(", ")}${s.partsDeclared ? "" : "; no ## Parts section"})`;
  const slice = (w: BriefSummary["slices"][number]) => {
    const n = w.underTest.length;
    return `${w.id} ${w.lane}, ${n} function${n === 1 ? "" : "s"}${n > sliceGuide ? ` — over the ${sliceGuide} guide` : ""}`;
  };
  const slices = s.slices.length === 0 ? "slices: 0 (none)" : `slices: ${s.slices.length} (${s.slices.map(slice).join("; ")})`;
  return [
    cls,
    `model: ${s.model ?? (s.legacy.includes("model") ? "none (legacy: no line)" : "none")}`,
    `target-files: ${s.targets?.length ?? (s.legacy.includes("target-files") ? "0 (legacy: no section)" : 0)}`,
    claims,
    parts,
    slices,
  ];
}

/** The file's text at `commit`, read from the repo that holds it. */
function textAt(path: string, commit: string): string {
  const abs = resolve(path);
  const dir = realpathSync(dirname(abs));
  const top = gitOut(["rev-parse", "--show-toplevel"], { cwd: dir }).trim();
  const rel = relative(realpathSync(top), resolve(dir, basename(abs)));
  return gitOut(["show", `${commit}:${rel}`], { cwd: top });
}

/** The top folder of the repo that holds the brief, or null when it sits in no repo. */
function repoTop(path: string): string | null {
  return gitTry(["rev-parse", "--show-toplevel"], { cwd: realpathSync(dirname(resolve(path))) })?.trim() || null;
}

/** The code repo's top: the brief's own repo, or for a brief in the store the repo the script was
 *  run in. Null when there is none. */
function codeTop(path: string): string | null {
  if (!inStore(path)) return repoTop(path);
  return gitTry(["rev-parse", "--show-toplevel"], { cwd: process.cwd() })?.trim() || null;
}

/** `order: ok`, or `order: <why>` with `ok` false (`briefOrder`). Throws when a repo is unreadable. */
function orderLine(path: string, base: string): { ok: boolean; line: string } {
  const top = repoTop(path);
  if (top === null) throw new Error(`${path} is in no git repo — the order check reads its history`);
  const code = codeTop(path);
  if (code === null) throw new Error("a brief in the store is checked from the code repo — run briefCheck there");
  // The cwd picks the code repo for a store brief. Inside the store, or in another repo, `<base>..HEAD`
  // is some other history (often empty), and the line would read `order: ok` for no reason.
  if (inStore(path) && !inStoreOf(path, code)) {
    throw new Error(`${path} is not under ${storeDir(code)}, the store dir of the repo briefCheck was run in — run it from the brief's own code repo`);
  }
  // A store brief is named, and read, from its repo's store dir: the record holds that path.
  const dir = inStore(path) ? storeDir(code) : top;
  const rel = relative(realpathSync(dir), realpathSync(resolve(path)));
  const briefGit = (args: string[]) => gitOut(args, { cwd: dir });
  const first = firstAddingCommit(briefGit, rel);
  const why =
    first === null
      ? `the brief ${path} has no commit that adds it`
      : briefOrder({
          name: "the brief",
          kind: "brief",
          base,
          code: (args) => gitOut(args, { cwd: code }),
          path: rel,
          firstCommit: first,
          store: inStore(path) ? { git: briefGit, ok: (args) => gitTry(args, { cwd: dir }) !== null } : null,
        }).failure;
  return why === null ? { ok: true, line: "order: ok" } : { ok: false, line: `order: ${why}` };
}

/** `TEST_SLICE_MAX_FUNCTIONS` for the code repo; the default when there is none. */
async function sliceGuide(path: string): Promise<number> {
  const top = codeTop(path);
  if (!top) return DEFAULTS.TEST_SLICE_MAX_FUNCTIONS;
  return (await loadThresholds(top)).values.TEST_SLICE_MAX_FUNCTIONS;
}

/** The lines `--files <id>` prints, or null when the brief holds no such part or slice. */
function filesOf(s: BriefSummary, id: string): string[] | null {
  const part = s.parts.find((p) => p.id === id);
  if (part) return [...part.files, ...part.testFiles];
  return s.slices.find((w) => w.id === id)?.files ?? null;
}

export async function main(argv: string[], exit: (code: number) => void = exitWhenFlushed): Promise<void> {
  let text: string;
  let path: string;
  let at: string | undefined;
  let json: boolean;
  let files: string | undefined;
  let slice: string | undefined;
  let base: string | undefined;
  try {
    const b = takeValue(argv, "--base");
    base = b.value;
    const t = takeValue(b.rest, "--at");
    at = t.value;
    const f = takeValue(t.rest, "--files");
    files = f.value;
    const w = takeValue(f.rest, "--slice");
    slice = w.value;
    json = w.rest.includes("--json");
    const rest = w.rest.filter((a) => a !== "--json");
    assertKnownFlags(rest, []);
    if (rest.length !== 1) throw new Error(`expected one <path>, got ${rest.length}`);
    if ([json, files !== undefined, slice !== undefined].filter(Boolean).length > 1) {
      throw new Error("--json, --files, and --slice are one each: pick one");
    }
    if (base !== undefined && (at !== undefined || json || files !== undefined || slice !== undefined)) {
      throw new Error("--base checks the brief at HEAD and prints its summary: no --at, --json, --files, or --slice");
    }
    if (files !== undefined && !/^[PW][1-9]\d*$/.test(files)) throw new Error(`--files takes P<k> or W<k>, got ${files}`);
    if (slice !== undefined && !/^W[1-9]\d*$/.test(slice)) throw new Error(`--slice takes W<k>, got ${slice}`);
    path = rest[0]!;
    if (at !== undefined) {
      text = textAt(path, at);
    } else {
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no file at ${path}`);
      text = readFileSync(path, "utf8");
    }
  } catch (err) {
    console.error(`briefCheck: ${(err as Error).message.trim()}\n${USAGE}`);
    exit(2);
    return;
  }
  let summary: BriefSummary;
  let excerpt: string | null = null;
  try {
    summary = summariseBrief(text, { legacyOk: at !== undefined });
    if (slice !== undefined) excerpt = sliceExcerpt(text, slice);
  } catch (err) {
    if (!(err instanceof BriefPartError)) throw err;
    console.error(`briefCheck: ${err.message}`);
    exit(1);
    return;
  }
  if (files === undefined && slice === undefined && at === undefined && summary.claims.length > 0) {
    let manifest: string | null;
    try {
      const top = codeTop(path);
      manifest = top === null ? null : stepCommand(top, "manifest");
    } catch (err) {
      console.error(`briefCheck: ${(err as Error).message.trim()}`);
      exit(2);
      return;
    }
    const tests = summary.claims.flatMap((c) => {
      const runner = testRunnerOf(c.run);
      if (runner !== null) return [`${c.id} (line ${c.line}) runs ${runner}`];
      return manifestWithoutExercise(c.run, manifest, text) ? [`${c.id} (line ${c.line}) runs the manifest with no exercise`] : [];
    });
    if (tests.length > 0) {
      console.error(
        `briefCheck: hand-test: ${tests.join("; ")} — tests run in the checks and CI; a claim uses the live app, ` +
          "queries the database, calls a live endpoint, or reads a log. With no such claim, write `none — <reason>`"
      );
      exit(1);
      return;
    }
  }
  if (files !== undefined || slice !== undefined) {
    const out = files !== undefined ? filesOf(summary, files) : excerpt;
    if (out === null) {
      console.error(`briefCheck: no ${files !== undefined ? "part or slice" : "slice"} ${files ?? slice} in the brief`);
      exit(1);
      return;
    }
    process.stdout.write(Array.isArray(out) ? `${out.join("\n")}\n` : out);
    exit(0);
    return;
  }
  if (json) {
    console.log(
      JSON.stringify(
        {
          kind: summary.kind,
          class: summary.cls,
          model: summary.model,
          why: summary.why,
          targets: summary.targets,
          claims: summary.claims,
          parts: summary.parts,
          partsDeclared: summary.partsDeclared,
          slices: summary.slices,
          legacy: summary.legacy,
        },
        null,
        2
      )
    );
  } else {
    let guide: number;
    let order: { ok: boolean; line: string } | null;
    try {
      guide = summary.slices.length > 0 ? await sliceGuide(path) : DEFAULTS.TEST_SLICE_MAX_FUNCTIONS;
      order = base === undefined ? null : orderLine(path, base);
    } catch (err) {
      console.error(`briefCheck: ${(err as Error).message.trim()}`);
      exit(2);
      return;
    }
    console.log([...formatSummary(summary, guide), ...(order === null ? [] : [order.line])].join("\n"));
    if (order !== null && !order.ok) {
      exit(1);
      return;
    }
  }
  exit(0);
}

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2));
}
