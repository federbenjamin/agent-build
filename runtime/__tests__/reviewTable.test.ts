/**
 * The table script's `check` and `dispatch` subcommands (`reviewTable.ts`): each `--stage` reads its
 * own grammar, `--run-dir` holds a file to the run, and `dispatch` gives each reader the rows it must
 * answer and creates the stage folder (R.6). `build` and `leftovers` are tested through
 * `lib/table.ts` (`table.test.ts`).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normaliseLocator, type Round, type RoundId, type Row, serialiseTableJson, stageIdRange, STAGES } from "../lib/runFiles.ts";
import { CHECK_STAGES, main } from "../reviewTable.ts";

const SHA = "4f1c2a9";
const EXIT = "exit checks:\nvacuity: none — no invariant\nmutation: none — no test\nbranches: none — no branch\nshared function: none\n";

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  let code = -1;
  await main(argv, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) }, (c) => {
    code = c;
  });
  return { code, out, err };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "review-table-"));
}

function blk(id: string, loc = "src/a.ts:10", kind = "behavior"): string {
  return `### ${id} — title ${id}\n- locator: ${loc}\n- kind: ${kind}\n- finding: ${id} is wrong\n- after: ${id} is right\n`;
}

function row(id: string, kind: Row["kind"], also: string[] = []): Row {
  return {
    id,
    also,
    kind,
    locators: normaliseLocator(`src/${id.toLowerCase()}.ts:10`),
    texts: [id, ...also].map((t) => ({ id: t, finding: `title ${t} — ${t} is wrong`, after: `${t} is right`, invariant: `${t} holds` })),
    origin: "reader",
    enteredAt: "1",
    history: ["1: fixed abc1234 — earlier"],
  };
}

function writeTable(dir: string, rounds: Partial<Record<RoundId, Row[]>>): void {
  const table = { schema: 2 as const, rounds: {} as Partial<Record<RoundId, Round>> };
  for (const [id, rows] of Object.entries(rounds) as [RoundId, Row[]][]) {
    table.rounds[id] = { head: "bbbbbbb", rows, leftovers: [], banked: [], closed: [], consumed: [], refused: [] };
  }
  writeFileSync(join(dir, "table.json"), serialiseTableJson(table));
}

/** Round 2 of a run, with one row per fixer answer: two fixed (one merged from HUNTER and CODEX),
 *  one dropped, one relabelled, one banked decision. Stage `confirm-2` answers it. */
const ROUND_2 = [
  row("CURSORY.1", "behavior"),
  row("HUNTER.2", "behavior", ["CODEX.3"]),
  row("SIMP.4", "structure"),
  row("CODEX.5", "structure"),
  row("VERIFIER.6", "missing"),
];
const FIX_2 = [
  `CURSORY.1 · fixed · ${SHA} — the loop stops on a 4xx`,
  `HUNTER.2 · fixed · ${SHA} · kind=security — the 409 maps to the taxonomy`,
  "SIMP.4 · dropped — chat.ts:30 already delegates",
  "CODEX.5 · relabel structure→text — the finding is the comment, not the shape",
  "VERIFIER.6 · decision — brief — deliverable 4 names a moved file",
  EXIT,
].join("\n");

function runDir2(): string {
  const dir = tempDir();
  writeTable(dir, { "1": [], "2": ROUND_2 });
  writeFileSync(join(dir, "fix-2.txt"), FIX_2);
  return dir;
}

function stageFile(status: string[], news = "NO FINDINGS — nothing new"): string {
  return `## Status\n${status.join("\n")}\n\n## New\n${news}\n`;
}

// ── check ────────────────────────────────────────────────────────────────────────────────────

/** One good and one bad text per `--stage` value; each bad text breaks only its own grammar. */
function samples(stage: string): { good: string; bad: string; badSays: RegExp; ok: string } {
  if (stage === "wave") return { good: blk("CURSORY.1"), bad: blk("CURSORY.101"), badSays: /outside stage wave's range/, ok: "ok: 1 findings" };
  if ((STAGES as readonly string[]).includes(stage)) {
    const { min } = stageIdRange(stage as (typeof STAGES)[number]);
    return {
      good: stageFile(["- none"], blk(`CODEX.${min + 1}`)),
      bad: stageFile(["- none"], blk(`CODEX.${min === 100 ? 1 : 101}`)),
      badSays: /outside stage/,
      ok: "ok: 1 findings",
    };
  }
  if (stage === "session") {
    return { good: `${blk("SESSION.1")}- stage: wave\n`, bad: blk("SESSION.1"), badSays: /missing `stage`/, ok: "ok: 1 findings" };
  }
  if (stage === "hand-test") {
    return {
      good: `H1 · pass · ${SHA} — hand-test-1/H1.out\n`,
      bad: `H1 · fail (code) · ${SHA} — hand-test-1/H1.out\n`,
      badSays: /a hand-test line is/,
      ok: "ok: 1 rows",
    };
  }
  const line = `CURSORY.1 · fixed · ${SHA} — the loop stops\n`;
  return { good: `${line}${EXIT}`, bad: `${line}${EXIT.replace(/branches:.*\n/, "")}`, badSays: /missing exit check `branches:`/, ok: "ok: 1 rows" };
}

test("check: every --stage value validates its own grammar", async () => {
  assert.deepEqual(CHECK_STAGES, [
    "wave",
    "confirm-1",
    "confirm-2",
    "last",
    "escalate",
    "drift",
    "drift-confirm",
    "session",
    "fix-1",
    "fix-2",
    "fix-3",
    "fix-escalate",
    "fix-drift",
    "hand-test",
  ]);
  const dir = tempDir();
  for (const stage of CHECK_STAGES) {
    const s = samples(stage);
    writeFileSync(join(dir, "good.txt"), s.good);
    writeFileSync(join(dir, "bad.txt"), s.bad);
    const good = await run(["check", "--file", "good.txt", "--stage", stage], dir);
    assert.deepEqual([good.code, good.out], [0, [s.ok]], `${stage} good: ${good.out.join(" | ")} ${good.err.join(" | ")}`);
    const bad = await run(["check", "--file", "bad.txt", "--stage", stage], dir);
    assert.equal(bad.code, 1, `${stage} bad: ${bad.out.join(" | ")} ${bad.err.join(" | ")}`);
    assert.match(bad.out.join("\n"), s.badSays, stage);
  }
  rmSync(dir, { recursive: true });
});

test("check: an invalid file prints one line per problem, each with its line", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "review-cursory.md"), `${blk("CURSORY.1", "src/a.ts:1", "severe")}\n${blk("CURSORY.2", "src/b.ts:1", "missing")}`);
  const r = await run(["check", "--file", "review-cursory.md", "--stage", "wave"], dir);
  assert.equal(r.code, 1);
  assert.equal(r.out.length, 2, r.out.join("\n"));
  assert.match(r.out[0]!, /^line 1: finding CURSORY\.1: `kind` must be one of/);
  assert.match(r.out[1]!, /^line 7: finding CURSORY\.2: `kind: missing` is legal only on a VERIFIER id/);
  rmSync(dir, { recursive: true });
});

test("fix4: check --stage wave holds a global reader's file to its own id prefix; a repo reader's is its own", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "security-review.md"), blk("SECURITY.1"));
  writeFileSync(join(dir, "review-cursory-2.md"), blk("CURSORY-2.1"));
  writeFileSync(join(dir, "comment-reader.md"), blk("COMMENT.1"));
  const bad = await run(["check", "--file", "security-review.md", "--stage", "wave"], dir);
  assert.deepEqual([bad.code, bad.out], [1, ["line 1: finding SECURITY.1: this reader's ids are `SEC.<n>` (CLOSE §The readers → Id prefixes), got `SECURITY`"]]);
  assert.equal((await run(["check", "--file", "review-cursory-2.md", "--stage", "wave"], dir)).code, 0);
  assert.equal((await run(["check", "--file", "comment-reader.md", "--stage", "wave"], dir)).code, 0);
  rmSync(dir, { recursive: true });
});

test("check --run-dir: a stage file answers exactly the rows its reader was given", async () => {
  const dir = runDir2();
  mkdirSync(join(dir, "stage-confirm-2"));
  const codex = join("stage-confirm-2", "review-cursory-codex.md");
  const all = ["- CURSORY.1 · resolved", "- CODEX.3 · resolved", "- SIMP.4 · agree", "- CODEX.5 · disagree — it is the shape"];
  writeFileSync(join(dir, codex), stageFile(all));
  assert.deepEqual((await run(["check", "--file", codex, "--stage", "confirm-2", "--run-dir", "."], dir)).out, ["ok: 0 findings"]);

  writeFileSync(join(dir, codex), stageFile(all.filter((l) => !l.includes("SIMP.4"))));
  const missing = await run(["check", "--file", codex, "--stage", "confirm-2", "--run-dir", "."], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.out.join("\n"), /SIMP\.4: row given and missing from `## Status`/);
  const noRunDir = await run(["check", "--file", codex, "--stage", "confirm-2"], dir);
  assert.equal(noRunDir.code, 0, "without --run-dir, coverage is not checked");

  const hunter = join("stage-confirm-2", "gate-silent-failure-hunter.md");
  writeFileSync(join(dir, hunter), stageFile(["- HUNTER.2 · unresolved — the catch still swallows it", "- CURSORY.1 · resolved"]));
  const extra = await run(["check", "--file", hunter, "--stage", "confirm-2", "--run-dir", "."], dir);
  assert.equal(extra.code, 0, extra.out.join("\n"));
  assert.match(extra.err.join("\n"), /^warning: line 3: CURSORY\.1 was not given to this reader; ignored$/);
  rmSync(dir, { recursive: true });
});

test("check --run-dir: a fix file has one line per row of its round", async () => {
  const dir = runDir2();
  writeFileSync(join(dir, "fix-2.txt"), FIX_2.replace(/^CODEX\.5 .*\n/m, ""));
  const r = await run(["check", "--file", "fix-2.txt", "--stage", "fix-2", "--run-dir", dir], dir);
  assert.equal(r.code, 1);
  assert.match(r.out.join("\n"), /CODEX\.5: row has no line/);
  assert.equal((await run(["check", "--file", "fix-2.txt", "--stage", "fix-2"], dir)).code, 0, "without --run-dir, rows are not checked");
  const notBuilt = await run(["check", "--file", "fix-2.txt", "--stage", "fix-3", "--run-dir", dir], dir);
  assert.equal(notBuilt.code, 2);
  assert.match(notBuilt.err.join("\n"), /table\.json has no round 3/);
  rmSync(dir, { recursive: true });
});

test("check --run-dir: every hand-test output file is in the run dir", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "hand-test-1.txt"), `H1 · pass · ${SHA} — hand-test-1/H1.out\nH2 · fail (env) · ${SHA} — hand-test-1/H2.out — no stack\n`);
  mkdirSync(join(dir, "hand-test-1"));
  writeFileSync(join(dir, "hand-test-1", "H1.out"), "ok\n");
  const r = await run(["check", "--file", "hand-test-1.txt", "--stage", "hand-test", "--run-dir", dir], dir);
  assert.deepEqual([r.code, r.out], [1, ["line 2: H2: output file hand-test-1/H2.out is not in the run dir"]]);
  writeFileSync(join(dir, "hand-test-1", "H2.out"), "no stack\n");
  assert.deepEqual((await run(["check", "--file", "hand-test-1.txt", "--stage", "hand-test", "--run-dir", dir], dir)).out, ["ok: 2 rows"]);
  rmSync(dir, { recursive: true });
});

test("check: usage and unreadable input exit 2", async () => {
  const dir = runDir2();
  mkdirSync(join(dir, "stage-confirm-1"));
  writeFileSync(join(dir, "stage-confirm-1", "review-cursory-codex.md"), stageFile(["- none"]));
  writeFileSync(join(dir, "notes.md"), stageFile(["- none"]));
  const cases: [string[], RegExp][] = [
    [["check", "--file", "fix-2.txt", "--stage", "fix-9"], /--stage must be one of/],
    [["check", "--file", "nope.txt", "--stage", "wave"], /is not a file/],
    [["check", "--file", "stage-confirm-1/review-cursory-codex.md", "--stage", "confirm-2"], /is in stage-confirm-1, not stage-confirm-2/],
    [["check", "--file", "notes.md", "--stage", "confirm-2", "--run-dir", "."], /not a reader's file name/],
    [["check", "--file", "fix-2.txt", "--stage", "fix-2", "--bogus", "x"], /unknown flag/],
  ];
  for (const [argv, says] of cases) {
    const r = await run(argv, dir);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err.join("\n"), says, argv.join(" "));
  }
  rmSync(dir, { recursive: true });
});

test("CURSORY.4: check --run-dir reads a drift group's own round, fix file, and confirm folder", async () => {
  const dir = tempDir();
  writeTable(dir, { "drift-1": [row("CURSORY.501", "behavior")], "drift-2": [] });
  writeFileSync(join(dir, "fix-drift-1.txt"), `CURSORY.501 · fixed · ${SHA} — a is 6\n${EXIT}`);
  mkdirSync(join(dir, "stage-drift-confirm-1"));
  const codex = join("stage-drift-confirm-1", "review-cursory-codex.md");
  writeFileSync(join(dir, codex), stageFile(["- CURSORY.501 · resolved"]));
  for (const stage of ["drift-confirm-1", "drift-confirm"]) {
    const r = await run(["check", "--file", codex, "--stage", stage, "--run-dir", "."], dir);
    assert.deepEqual([r.code, r.out, r.err], [0, ["ok: 0 findings"], []], `--stage ${stage}`);
  }
  const wrong = await run(["check", "--file", codex, "--stage", "drift-confirm-2", "--run-dir", "."], dir);
  assert.match(wrong.err.join("\n"), /is in stage-drift-confirm-1, not stage-drift-confirm-2/);
  writeFileSync(join(dir, "review-cursory-codex.md"), stageFile(["- CURSORY.501 · resolved"]));
  const loose = await run(["check", "--file", "review-cursory-codex.md", "--stage", "drift-confirm", "--run-dir", "."], dir);
  assert.equal(loose.code, 2);
  assert.match(loose.err.join("\n"), /--stage drift-confirm with --run-dir needs its drift group: drift-confirm-<n>/);
  const fix = await run(["check", "--file", "fix-drift-1.txt", "--stage", "fix-drift-1", "--run-dir", "."], dir);
  assert.deepEqual([fix.code, fix.out], [0, ["ok: 1 rows"]]);
  const other = await run(["check", "--file", "fix-drift-1.txt", "--stage", "fix-drift-2", "--run-dir", "."], dir);
  assert.equal(other.code, 1, "round drift-2 has no CURSORY.501");
  const bare = await run(["check", "--file", "fix-drift-1.txt", "--stage", "fix-drift", "--run-dir", "."], dir);
  assert.equal(bare.code, 2);
  assert.match(bare.err.join("\n"), /needs its drift group: fix-drift-<n>/);
  rmSync(dir, { recursive: true });
});

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────

/** The row ids a dispatch file lists, from its `## <ID> · …` headings. */
function dispatchedIds(text: string): string[] {
  return [...text.matchAll(/^## ([A-Z][A-Z0-9-]*\.\d+) · /gm)].map((m) => m[1]!);
}

test("dispatch for Codex lists every fixed, dropped, and relabelled row with its texts and the fixer's line", async () => {
  const dir = runDir2();
  const r = await run(["dispatch", "--run-dir", ".", "--stage", "confirm-2", "--reader", "review-cursory-codex", "--out", "codex.txt"], dir);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.equal(r.out[0], `stage confirm-2 · reader review-cursory-codex · rows 4 (CURSORY.1, HUNTER.2, SIMP.4, CODEX.5) · wrote ${join(dir, "codex.txt")}`);
  const text = readFileSync(join(dir, "codex.txt"), "utf8");
  assert.deepEqual(dispatchedIds(text), ["CURSORY.1", "HUNTER.2", "SIMP.4", "CODEX.5"], "the decision row is banked, never given");
  assert.match(text, /^## HUNTER\.2 · behavior · fixed — answer resolved \| unresolved$/m);
  assert.match(text, /^## SIMP\.4 · structure · dropped — answer agree \| disagree$/m);
  assert.match(text, /^## CODEX\.5 · structure · relabel — answer agree \| disagree$/m);
  assert.match(text, /^- fixer: HUNTER\.2 · fixed · 4f1c2a9 · kind=security — the 409 maps to the taxonomy$/m);
  assert.match(text, /^- fixer: CODEX\.5 · relabel structure→text — the finding is the comment, not the shape$/m);
  assert.match(text, /^- also: CODEX\.3$/m);
  assert.match(text, /^- CODEX\.3: title CODEX\.3 — CODEX\.3 is wrong\n {2}- after: CODEX\.3 is right\n {2}- invariant: CODEX\.3 holds$/m);
  assert.match(text, /^- locators: src\/simp\.4\.ts:10-10$/m);
  assert.match(text, /^- history: 1: fixed abc1234 — earlier$/m);
  assert.match(text, /ids `CODEX\.200` to `CODEX\.299`/);
  assert.match(text, /Your answer is `stage-confirm-2\/review-cursory-codex\.md`/);
  rmSync(dir, { recursive: true });
});

test("dispatch for another reader lists only the rows holding one of its ids; the stand-in gets Codex's rows", async () => {
  const dir = runDir2();
  const given = async (reader: string) => {
    const r = await run(["dispatch", "--run-dir", dir, "--stage", "confirm-2", "--reader", reader, "--out", `${reader}.txt`], dir);
    assert.equal(r.code, 0, r.err.join("\n"));
    return readFileSync(join(dir, `${reader}.txt`), "utf8");
  };
  assert.deepEqual(dispatchedIds(await given("gate-silent-failure-hunter")), ["HUNTER.2"]);
  assert.deepEqual(dispatchedIds(await given("simplifier")), ["SIMP.4"]);
  assert.deepEqual(dispatchedIds(await given("review-cursory")), ["CURSORY.1", "HUNTER.2", "SIMP.4", "CODEX.5"]);
  const verifier = await given("build-verifier");
  assert.deepEqual(dispatchedIds(verifier), [], "VERIFIER.6 is a decision");
  assert.match(verifier, /the one line `- none`/);
  assert.match(verifier, /Last line: `VERDICT: CLEAN` or `VERDICT: INCOMPLETE — <check>`/);
  rmSync(dir, { recursive: true });
});

test("dispatch and check agree: a stage file that answers every dispatched row passes check --run-dir", async () => {
  const dir = runDir2();
  for (const reader of ["review-cursory-codex", "gate-silent-failure-hunter", "simplifier", "build-verifier", "security-review"]) {
    await run(["dispatch", "--run-dir", dir, "--stage", "confirm-2", "--reader", reader, "--out", `${reader}.txt`], dir);
    const text = readFileSync(join(dir, `${reader}.txt`), "utf8");
    const status = [...text.matchAll(/^## (\S+) · \S+ · (\S+) — /gm)].map((m) => `- ${m[1]} · ${m[2] === "fixed" ? "resolved" : "agree"}`);
    const file = join("stage-confirm-2", `${reader}.md`);
    const verdict = reader === "build-verifier" ? "\nVERDICT: CLEAN" : "";
    writeFileSync(join(dir, file), `${stageFile(status.length > 0 ? status : ["- none"])}${verdict}\n`);
    const r = await run(["check", "--file", file, "--stage", "confirm-2", "--run-dir", dir], dir);
    assert.deepEqual([r.code, r.err], [0, []], `${reader}: ${r.out.join("\n")}`);
  }
  rmSync(dir, { recursive: true });
});

test("R.6: dispatch into a fresh run dir leaves the stage folder in place", async () => {
  const fresh = tempDir();
  assert.equal(existsSync(join(fresh, "stage-drift-1")), false);
  const r = await run(["dispatch", "--run-dir", fresh, "--stage", "drift-1", "--reader", "review-cursory", "--out", join(fresh, "d.txt")], fresh);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.equal(existsSync(join(fresh, "stage-drift-1")), true);
  const bare = await run(["dispatch", "--run-dir", fresh, "--stage", "drift", "--reader", "review-cursory", "--out", join(fresh, "d.txt")], fresh);
  assert.equal(bare.code, 2, "CURSORY.4: a drift dispatch names its group");
  assert.match(bare.err.join("\n"), /--stage must be one of .*drift-<n> \| drift-confirm-<n>, got drift/);
  assert.match(readFileSync(join(fresh, "d.txt"), "utf8"), /the one line `- none`/);

  const dir = runDir2();
  const c1 = await run(["dispatch", "--run-dir", dir, "--stage", "confirm-1", "--reader", "review-cursory-codex", "--out", "c1.txt"], dir);
  assert.equal(c1.code, 0, c1.err.join("\n"));
  assert.match(c1.out[0]!, /· rows 0 · /, "round 1 had no rows, so no fix-1.txt is needed");
  assert.equal(existsSync(join(dir, "stage-confirm-1")), true);
  rmSync(fresh, { recursive: true });
  rmSync(dir, { recursive: true });
});

test("dispatch: usage and unreadable input exit 2, and a failed dispatch creates no stage folder", async () => {
  const dir = runDir2();
  const cases: [string[], RegExp][] = [
    [["--stage", "wave", "--reader", "review-cursory"], /--stage must be one of confirm-1/],
    [["--stage", "confirm-2", "--reader", "comment-reader"], /--reader must be one of/],
    [["--stage", "last", "--reader", "review-cursory-codex"], /table\.json has no round 3/],
    [["--stage", "confirm-2", "--reader", "simplifier", "--out", "no/such/dir/x.txt"], /--out directory .* does not exist/],
  ];
  for (const [argv, says] of cases) {
    const full = ["dispatch", "--run-dir", dir, ...argv, ...(argv.includes("--out") ? [] : ["--out", "x.txt"])];
    const r = await run(full, dir);
    assert.equal(r.code, 2, full.join(" "));
    assert.match(r.err.join("\n"), says, full.join(" "));
  }
  assert.equal(existsSync(join(dir, "stage-last")), false);
  rmSync(join(dir, "fix-2.txt"));
  const noFix = await run(["dispatch", "--run-dir", dir, "--stage", "confirm-2", "--reader", "simplifier", "--out", "x.txt"], dir);
  assert.equal(noFix.code, 2);
  assert.match(noFix.err.join("\n"), /fix-2\.txt is missing: round 2 has 5 rows/);
  assert.equal(existsSync(join(dir, "stage-confirm-2")), false);
  rmSync(dir, { recursive: true });
});

test("build: a round table.json holds re-builds at its stored head; a new round and `final` take HEAD; --head overrides", async () => {
  const dir = tempDir();
  const HEAD_SHA = "ccccccc";
  const exec = (_cmd: string, args: string[]): string => {
    if (args.join(" ") === "rev-parse --show-toplevel") return `${dir}\n`;
    if (args.join(" ") === "rev-parse HEAD") return `${HEAD_SHA}\n`;
    if (args[0] === "diff") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const build = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    let code = -1;
    await main(["build", "--run-dir", dir, ...argv], { cwd: dir, exec, out: (l) => out.push(l), err: (l) => err.push(l) }, (c) => {
      code = c;
    });
    return { code, out, err };
  };
  const rounds = () => (JSON.parse(readFileSync(join(dir, "table.json"), "utf8")) as { rounds: Record<string, Round & { open?: [] }> }).rounds;
  const setRounds = (r: Record<string, unknown>) => writeFileSync(join(dir, "table.json"), JSON.stringify({ schema: 2, rounds: r }));
  writeFileSync(
    join(dir, "ship.md"),
    "class: R1 — operator, 2026-09-28\nflow: 2\nfrom-branch: quick/x\nhand-test-block: docs/x-hand-test.md\nfreshen: skipped | base=main | sha=aaaaaaa\n"
  );
  writeTable(dir, { "1": [] });
  setRounds({ "1": { ...rounds()["1"]!, head: "aaaaaaa" } });

  const again = await build("--round", "1");
  assert.equal(again.code, 0, again.err.join("\n"));
  assert.equal(rounds()["1"]!.head, "aaaaaaa", "a re-built round keeps its range");
  assert.deepEqual(again.err, ["note: table.json holds round 1 — re-built at its head aaaaaaa; pass --head <sha> to build it elsewhere"]);
  assert.match(again.out[0]!, /^round 1 · head aaaaaaa · /);
  assert.equal(again.out.at(-1), "budget: unenforced (no started=)", "a --from-branch run has no brief and no budget");

  assert.equal((await build("--round", "1", "--head", "ddddddd")).code, 0);
  assert.equal(rounds()["1"]!.head, "ddddddd", "--head overrides the stored head");

  for (const id of ["2", "3", "escalate"] as const) {
    const r = await build("--round", id);
    assert.deepEqual([r.code, r.err], [0, []], `a new round ${id} prints no note`);
    assert.equal(rounds()[id]!.head, HEAD_SHA, `a new round ${id} is built at HEAD`);
  }
  setRounds({ ...rounds(), final: { ...rounds().escalate!, head: "aaaaaaa", open: [] } });
  const final = await build("--round", "final");
  assert.deepEqual([final.code, final.err], [0, []]);
  assert.equal(rounds().final!.head, HEAD_SHA, "SHIP re-builds `final` after a later commit, at the new head");
  // The ledger names no `branch=`, so the build never asked git for the branch: `exec` throws on it.
  rmSync(dir, { recursive: true });
});

test("build: with started= and the brief's budget: the last line is the verdict; a future start or a malformed line exits 2 and writes nothing", async () => {
  const dir = tempDir();
  const exec = (_cmd: string, args: string[]): string => {
    if (args.join(" ") === "rev-parse --show-toplevel") return `${dir}\n`;
    if (args.join(" ") === "rev-parse HEAD") return "ccccccc\n";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const build = async () => {
    const out: string[] = [];
    const err: string[] = [];
    let code = -1;
    await main(["build", "--run-dir", dir, "--round", "1"], { cwd: dir, exec, out: (l) => out.push(l), err: (l) => err.push(l) }, (c) => {
      code = c;
    });
    return { code, out, err };
  };
  const ledger = (started: string) =>
    writeFileSync(
      join(dir, "ship.md"),
      `class: R1 — operator, 2026-09-28\nflow: 2\nbrief: docs/b.md\nbuild: model=sonnet | agent=a1 | sha=aaaaaaa | started=${started}\n`
    );
  const brief = (budget: string) => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "b.md"), `class: R1 — o, 2026-09-28\nmodel: sonnet\n${budget}\n\n## Target files\n\n- src/a.ts\n`);
  };
  const tables = () => ["table.json", "table-1.md"].filter((f) => existsSync(join(dir, f)));
  try {
    brief("budget: 2h");
    ledger("2999-01-01T00:00:00Z");
    const future = await build();
    assert.equal(future.code, 2);
    assert.match(future.err[0]!, /^reviewTable build: budgetVerdict: started=2999-01-01T00:00:00Z is later than now/);
    assert.deepEqual(tables(), [], "a refused start writes no table");

    brief("budget: 2");
    ledger("2020-01-01T00:00:00Z");
    const malformed = await build();
    assert.equal(malformed.code, 2);
    assert.match(malformed.err[0]!, /^reviewTable build: docs\/b\.md: budget: line 3: expected `budget: <n>h`/);
    assert.deepEqual(tables(), [], "a malformed budget line writes no table");

    brief("budget: 2h");
    ledger(new Date(Date.now() - 30 * 60_000).toISOString());
    const ok = await build();
    assert.equal(ok.code, 0, ok.err.join("\n"));
    assert.match(ok.out[0]!, /^round 1 · head ccccccc · /);
    assert.equal(ok.out.at(-1), "budget: 0.5h of 2h — ok");

    ledger("2020-01-01T00:00:00Z");
    const over = await build();
    assert.equal(over.code, 0, over.err.join("\n"));
    assert.match(over.out.at(-1)!, /^budget: \d+\.\dh of 2h — over: spawn nothing$/);
    assert.deepEqual(tables(), ["table.json", "table-1.md"], "an over verdict still writes the table");

    brief("");
    const noLine = await build();
    assert.equal(noLine.code, 0, noLine.err.join("\n"));
    assert.equal(noLine.out.at(-1), "budget: unenforced (no budget: line)");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("build: the budget line's time is sampled after the table is written, so a limit crossed during the build prints over", async () => {
  const dir = tempDir();
  const exec = (_cmd: string, args: string[]): string => {
    if (args.join(" ") === "rev-parse --show-toplevel") return `${dir}\n`;
    if (args.join(" ") === "rev-parse HEAD") return "ccccccc\n";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const started = Date.parse("2026-10-06T00:00:00Z");
  writeFileSync(
    join(dir, "ship.md"),
    "class: R1 — operator, 2026-09-28\nflow: 2\nbrief: docs/b.md\nbuild: model=sonnet | agent=a1 | sha=aaaaaaa | started=2026-10-06T00:00:00Z\n"
  );
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "b.md"), "class: R1 — o, 2026-09-28\nmodel: sonnet\nbudget: 2h\n\n## Target files\n\n- src/a.ts\n");
  // The clock reads 1.9h until this build writes table.json, then 2.1h: the limit falls inside the command.
  const json = join(dir, "table.json");
  const mark = Date.parse("2001-01-01T00:00:00Z");
  const written = () => existsSync(json) && statSync(json).mtimeMs > mark;
  const RealDate = Date;
  class ClockDate extends RealDate {
    constructor(...args: [] | [string | number | Date]) {
      super(args.length === 0 ? started + (written() ? 2.1 : 1.9) * 3_600_000 : args[0]);
    }
  }
  const build = async () => {
    const out: string[] = [];
    const err: string[] = [];
    let code = -1;
    globalThis.Date = ClockDate as DateConstructor;
    try {
      await main(["build", "--run-dir", dir, "--round", "1"], { cwd: dir, exec, out: (l) => out.push(l), err: (l) => err.push(l) }, (c) => {
        code = c;
      });
    } finally {
      globalThis.Date = RealDate;
    }
    return { code, out, err };
  };
  try {
    const fresh = await build();
    assert.equal(fresh.code, 0, fresh.err.join("\n"));
    assert.equal(fresh.out.at(-1), "budget: 2.1h of 2h — over: spawn nothing", "a new round's table");

    utimesSync(json, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    const rebuilt = await build();
    assert.equal(rebuilt.code, 0, rebuilt.err.join("\n"));
    assert.match(rebuilt.err[0]!, /^note: table\.json holds round 1/);
    assert.equal(rebuilt.out.at(-1), "budget: 2.1h of 2h — over: spawn nothing", "a re-built round's table");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("build: a tree on another branch than the ledger's branch= exits 2 with the message and writes nothing; its own branch builds", async () => {
  const root = tempDir();
  const dir = join(root, "build-17-4");
  mkdirSync(dir);
  let branch = "quick/other";
  const exec = (_cmd: string, args: string[]): string => {
    if (args.join(" ") === "rev-parse --show-toplevel") return `${root}\n`;
    if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return `${branch}\n`;
    if (args.join(" ") === "rev-parse HEAD") return "ccccccc\n";
    if (args[0] === "diff") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const build = async () => {
    const err: string[] = [];
    let code = -1;
    await main(["build", "--run-dir", dir, "--round", "1"], { cwd: root, exec, out: () => {}, err: (l) => err.push(l) }, (c) => {
      code = c;
    });
    return { code, err };
  };
  writeFileSync(
    join(dir, "ship.md"),
    "class: R1 — operator, 2026-09-28\nflow: 2\nfrom-branch: quick/x\nhand-test-block: docs/x-hand-test.md\nfreshen: skipped | base=main | branch=quick/x | sha=aaaaaaa\n"
  );
  const wrong = await build();
  assert.deepEqual(wrong, {
    code: 2,
    err: ["reviewTable build: run 17-4 is on quick/x; this tree is on quick/other — enter the run's tree first"],
  });
  assert.equal(existsSync(join(dir, "table.json")), false);
  branch = "quick/x";
  assert.equal((await build()).code, 0);
  assert.equal(existsSync(join(dir, "table.json")), true);
  rmSync(root, { recursive: true });
});

test("main: the usage line names all four subcommands", async () => {
  const r = await run([], tempDir());
  assert.deepEqual([r.code, r.err], [2, ["usage: reviewTable.ts <build | check | dispatch | leftovers> …"]]);
});
