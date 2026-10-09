/**
 * A throwaway repo plus run dir for the owed-set and stage-plan tests: a `main` base, a `quick/x`
 * branch holding a brief, a fake signals arm, and writers for the ledger, `table.json`, and the run
 * files. The arm's app code is `src/**` with a changed line that is not blank or a `//` comment; its
 * fix trigger fires on a path holding `auth`.
 *
 * With `store`, the repo is public (`agents.profile`, origin `o/r`) and a second repo is the store
 * (`AGENT_BUILD_STORE`, set while `fn` runs): its `o/r/` holds the build steps and the brief, which
 * the ledger names `store:briefs/quick-x.md` (`STORE_BRIEF`), and the branch's first commit is the
 * empty one that records the brief's store commit. Every git call in both repos reads one clock
 * that moves 10 s a call, so committer times follow the order the test made the commits in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type Ledger, parseLedger } from "../../lib/ledger.ts";
import { gatherRound } from "../../lib/runDir.ts";
import {
  type Kind,
  parseHandTestFile,
  parseTableJson,
  type RoundId,
  type Row,
  serialiseTableJson,
  type TableJson,
} from "../../lib/runFiles.ts";
import { buildRound } from "../../lib/table.ts";

// Strip inherited GIT_* before anything spawns git (docs/rules/tests.md §Tests): an inherited
// GIT_DIR (a hook) would point both these repos and the runtime's own git calls at another repo.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

export const FAKE_ARM = `import { readFileSync } from "node:fs";
const [arm, file] = process.argv.slice(2);
if (arm !== "--app-code" && arm !== "--fix-security") {
  console.error("fake: unknown flag(s): " + arm);
  process.exit(2);
}
const logic = new Set();
const paths = new Set();
let path = null;
for (const line of readFileSync(file, "utf8").split("\\n")) {
  const m = /^diff --git a\\/\\S+ b\\/(.+)$/.exec(line);
  if (m) { path = m[1]; paths.add(path); continue; }
  if (line.startsWith("+++") || line.startsWith("---")) continue;
  if (path && (line.startsWith("+") || line.startsWith("-"))) {
    const t = line.slice(1).trim();
    if (t !== "" && !t.startsWith("//")) logic.add(path);
  }
}
const out = arm === "--app-code"
  ? [...logic].filter((p) => p.startsWith("src/")).map((p) => "app-code: " + p)
  : [...paths].filter((p) => p.includes("auth")).map((p) => "fires: path " + p);
console.log(out.length ? out.join("\\n") : arm === "--app-code" ? "none" : "quiet");
`;

export const BRIEF_PATH = "docs/briefs/quick-x.md";

/** The ledger's `brief:` value for a store run, and the brief's path in the store dir. */
export const STORE_BRIEF = "store:briefs/quick-x.md";
export const STORE_BRIEF_PATH = "briefs/quick-x.md";

export function briefText(opts: { model?: string; claims?: string; cls?: string } = {}): string {
  return [
    `class: ${opts.cls ?? "R1"} — operator, 2026-09-28`,
    `model: ${opts.model ?? "sonnet"} — the brief names every file`,
    "",
    "## Target files",
    "",
    "- src/app.ts",
    "",
    "## Hand test",
    "",
    opts.claims ??
      ["- H1 · the app answers", "  - run: `node src/app.ts`", "  - pass: exit 0", "  - needs: stack"].join("\n"),
    "",
    "## Deliverables",
    "",
    "1. app answers",
    "",
  ].join("\n");
}

export const TWO_CLAIMS = [
  "- H1 · the app answers",
  "  - run: `node src/app.ts`",
  "  - pass: exit 0",
  "- H2 · the app answers twice",
  "  - run: `node src/app.ts twice`",
  "  - pass: exit 0",
  "  - needs: sim",
].join("\n");

export interface Run {
  repo: string;
  runDir: string;
  /** The wave head: the brief and the build's commit. */
  wave: string;
  git: (...args: string[]) => string;
  commit: (files: Record<string, string>, msg: string) => string;
  head: () => string;
  write: (rel: string, text: string) => void;
  /** Writes `hand-test-<n>.txt` and an output file for each of its lines. */
  handTest: (n: number, text: string) => void;
  table: (rounds: TableJson["rounds"]) => void;
  /** Builds these rounds, in order, with the table script's own `buildRound` over the run dir's
   *  files, at `head` (default HEAD); the brief's one target is `src/app.ts`. */
  build: (rounds: RoundId[], head?: string) => void;
  ledger: (lines: string[]) => void;
  /** Set with `opts.store`: the store repo, its dir for this repo (`<root>/o/r`), and a commit there
   *  whose paths are relative to that dir. */
  store: { root: string; dir: string; git: (...args: string[]) => string; commit: (files: Record<string, string>, msg: string) => string } | null;
}

/** The rounds every run builds, in order. */
export const ALL_ROUNDS: RoundId[] = ["1", "2", "3", "escalate", "final"];

const LIM = { near: 3, exactAbove: 30 };

function buildRounds(runDir: string, rounds: RoundId[], head: string): void {
  const shipPath = join(runDir, "ship.md");
  const ledger: Ledger = existsSync(shipPath)
    ? parseLedger(readFileSync(shipPath, "utf8"))
    : ({ waveRepoReaders: [] } as unknown as Ledger);
  const tablePath = join(runDir, "table.json");
  let table: TableJson = existsSync(tablePath) ? parseTableJson(readFileSync(tablePath, "utf8")) : { schema: 2, rounds: {} };
  for (const round of rounds) {
    table = buildRound({
      round,
      head,
      table,
      isTarget: (p) => p === "src/app.ts",
      merge: LIM,
      ...gatherRound(runDir, round, ledger, table),
    }).table;
  }
  writeFileSync(tablePath, serialiseTableJson(table));
}

function writeAt(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** Runs `fn` over a fresh repo on `quick/x` whose wave head holds the brief and one build commit. */
export async function withRun(
  fn: (run: Run) => Promise<void> | void,
  opts: {
    brief?: string | null;
    briefPath?: string;
    arm?: string | null;
    /** A public repo whose brief is in the store: committed there and recorded by the branch's first
     *  commit, or `"after"`: committed after the first code commit, which records nothing. */
    store?: "before" | "after";
  } = {}
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "owed-run-"));
  const repo = join(root, "repo");
  const runDir = join(root, "run");
  mkdirSync(repo);
  mkdirSync(runDir);
  let clock = 1_700_000_000;
  const gitIn = (cwd: string) => (...args: string[]) => {
    const at = `@${(clock += 10)} +0000`;
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    }).trim();
  };
  const committer = (top: string, under: string) => {
    const g = gitIn(top);
    return (files: Record<string, string>, msg: string) => {
      for (const [rel, text] of Object.entries(files)) writeAt(under, rel, text);
      g("add", "-A");
      g("commit", "-q", "--allow-empty", "-m", msg);
      return g("rev-parse", "HEAD");
    };
  };
  const git = gitIn(repo);
  const commit = committer(repo, repo);
  const storeRoot = join(root, "store");
  const store = opts.store === undefined ? null : { root: storeRoot, dir: join(storeRoot, "o", "r"), git: gitIn(storeRoot), commit: committer(storeRoot, join(storeRoot, "o", "r")) };
  const envBefore = process.env.AGENT_BUILD_STORE;
  try {
    git("init", "-q", "-b", "main");
    const arm = opts.arm === undefined ? FAKE_ARM : opts.arm;
    const files: Record<string, string> = {
      "src/app.ts": "export const a = 1;\n",
      "src/auth.ts": "export const token = 1;\n//\n//\n//\nexport const other = 1;\n",
      "test/app.test.ts": "// test\n",
      "scripts/snapshot.json": "{}\n",
    };
    const steps = arm === null ? null : `signals = "node ${join(root, "arm.mjs")}"\n`;
    if (arm !== null) writeAt(root, "arm.mjs", arm);
    if (store === null) {
      if (steps !== null) files[".claude/build-steps.toml"] = steps;
    } else {
      git("remote", "add", "origin", "git@github.com:o/r.git");
      git("config", "agents.profile", "public");
      mkdirSync(storeRoot);
      store.git("init", "-q", "-b", "main");
      store.commit(steps === null ? {} : { "build-steps.toml": steps }, "steps: o/r");
      process.env.AGENT_BUILD_STORE = storeRoot;
    }
    commit(files, "base");
    git("checkout", "-q", "-b", "quick/x");
    const briefFile = { [store === null ? (opts.briefPath ?? BRIEF_PATH) : STORE_BRIEF_PATH]: opts.brief ?? briefText() };
    const briefCommit = store === null ? commit : store.commit;
    if (opts.brief !== null && opts.store !== "after") {
      const at = briefCommit(briefFile, "brief: quick-x");
      if (store !== null) commit({}, `brief: ${STORE_BRIEF} @ ${at}`);
    }
    const wave = commit({ "src/app.ts": "export const a = 2;\n" }, "build: a is 2");
    if (opts.brief !== null && opts.store === "after") briefCommit(briefFile, "brief: quick-x");
    await fn({
      repo,
      runDir,
      wave,
      git,
      commit,
      head: () => git("rev-parse", "HEAD"),
      write: (rel, text) => writeAt(runDir, rel, text),
      handTest: (n, text) => {
        writeAt(runDir, `hand-test-${n}.txt`, text);
        for (const l of parseHandTestFile(text)) writeAt(runDir, l.output, `${l.claim} output\n`);
      },
      table: (rounds) => writeAt(runDir, "table.json", serialiseTableJson({ schema: 2, rounds })),
      build: (rounds, head) => buildRounds(runDir, rounds, head ?? git("rev-parse", "HEAD")),
      ledger: (lines) => writeAt(runDir, "ship.md", `${lines.join("\n")}\n`),
      store,
    });
  } finally {
    if (envBefore === undefined) delete process.env.AGENT_BUILD_STORE;
    else process.env.AGENT_BUILD_STORE = envBefore;
    rmSync(root, { recursive: true, force: true });
  }
}

/** One finding block, as a reader writes it. */
export function blk(id: string, kind: Kind, locator = "src/app.ts:1"): string {
  return `### ${id} — ${id} title\n- locator: ${locator}\n- kind: ${kind}\n- finding: ${id} is wrong\n- after: ${id} is right\n`;
}

/** A stage file: the status lines (or `- none`), then new blocks (or NO FINDINGS). */
export function stageFile(status: string[], blocks: string[] = []): string {
  return `## Status\n${status.length === 0 ? "- none" : status.join("\n")}\n\n## New\n${blocks.length === 0 ? "NO FINDINGS" : blocks.join("\n")}\n`;
}

/** The wave's two files for `briefedHead`'s wave line: a cursory read holding `blocks`, and a clean
 *  verifier. */
export function waveFiles(run: Run, blocks: string[] = []): void {
  run.write("review-cursory.md", blocks.length === 0 ? "NO FINDINGS\n" : blocks.join("\n"));
  run.write("build-verifier.md", "NO FINDINGS\nVERDICT: CLEAN\n");
}

export function row(id: string, kind: Kind, path = "src/app.ts"): Row {
  return {
    id,
    also: [],
    kind,
    locators: [{ path, start: 1, end: 1, parsed: true }],
    texts: [{ id, finding: `${id} finding`, after: `${id} after` }],
    origin: "reader",
    enteredAt: "1",
    history: [],
  };
}

/** A round with these rows, built at `head`. */
export function round(head: string, rows: Row[] = []) {
  return { head, rows, leftovers: [], banked: [], closed: [], consumed: [], refused: [] };
}

export function finalRound(head: string) {
  return { ...round(head), open: [] as { id: string; kind: Kind }[] };
}

/** Every round empty at `head`: a run whose wave found nothing. */
export function emptyRounds(head: string): TableJson["rounds"] {
  return { "1": round(head), "2": round(head), "3": round(head), escalate: round(head), final: finalRound(head) };
}

export const EXIT_CHECKS = [
  "exit checks:",
  "vacuity: none — no invariant given",
  "mutation: none — no mutation map",
  "branches: none — no branch added",
  "shared function: none",
].join("\n");

/** The ledger's head lines for a briefed run, class `cls`; `brief` is the `brief:` value. */
export function briefedHead(cls: string, wave: string, model = "sonnet", brief = BRIEF_PATH): string[] {
  return [
    `class: ${cls} — operator, 2026-09-28`,
    "flow: 2",
    `brief: ${brief}`,
    "steps: .claude/build-steps.toml",
    `build: model=${model} | agent=a1 | sha=${wave}`,
    `freshen: merged | base=main | sha=${wave}`,
    `wave: review-cursory, build-verifier | sha=${wave}`,
  ];
}
