/**
 * Doc pins for the build flow's own prompts. They assert prompt CONTENT stayed consistent with the
 * design: a worker that can re-acquire fan-out, or a surface that loses the one/two-local, three-plus-to-test-author
 * rule, regresses silently otherwise.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  type BriefModel,
  BriefPartError,
  parseHandTestBlock,
  parseParts,
  parseTestSlices,
  strongestModel,
  summariseBrief,
  testRunnerOf,
} from "../lib/brief.ts";
import { composeLine, parseArgs as parseLineArgs } from "../ledgerLine.ts";
import { parseLedger } from "../lib/ledger.ts";
import { DEFAULTS } from "../thresholds.ts";
import { FLOW_AGENTS, STAGE_READER_NAMES } from "../lib/riskClass.ts";
import {
  DECISION_WHICH,
  FIX_ROUNDS,
  isFixRound,
  isRoundId,
  KINDS,
  parseFixFile,
  parseHandTestFile,
  parseStageKey,
  STAGES_FIXING,
} from "../lib/runFiles.ts";

const EXIT_LINES = [
  "exit checks:",
  "vacuity: none — no invariant given",
  "mutation: none — no test added",
  "branches: none — no branch added",
  "shared function: none",
  "",
].join("\n");

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
// The /build skill is SKILL.md plus one file per stop; a pin holds wherever in it the rule lives.
const read = (rel: string) =>
  rel === "skills/build"
    ? readdirSync(join(ROOT, rel))
        .filter((f) => f.endsWith(".md"))
        .map((f) => readFileSync(join(ROOT, rel, f), "utf8"))
        .join("\n")
    : readFileSync(join(ROOT, rel), "utf8");

function frontmatter(agent: string): string {
  const match = read(`agents/${agent}.md`).match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${agent}.md needs frontmatter`);
  return match[1]!;
}
const fmLine = (fm: string, key: string) =>
  (fm.split("\n").find((l) => l.startsWith(`${key}:`)) ?? "").trim();
const body = (agent: string) => read(`agents/${agent}.md`).replace(/^---\n[\s\S]*?\n---\n/, "");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "agents.json"), "utf8")) as {
  agents: { name: string; description: string; claudeModel?: string; context?: { claudeMd?: boolean; principles?: boolean } }[];
};

test("a builder's spawned worker can never itself spawn agents — no Agent in its tools line", () => {
  // The orchestrating /build session starts every agent; builder, fixer, hand tester, and the
  // test-author writers spawn nothing.
  for (const agent of ["builder", "fixer", "hand-tester", "test-author"]) {
    const toolsLine = fmLine(frontmatter(agent), "tools");
    assert.ok(toolsLine.length > 0, `${agent} must declare a tools: line`);
    assert.ok(!/\bAgent\b/.test(toolsLine), `${agent} tools: must not include Agent`);
  }
});

test("the small-batch rule: one/two tests stay local, three or more go to test-author", () => {
  for (const rel of ["skills/build", "agents/builder.md", "agents/test-author.md"]) {
    const text = read(rel);
    assert.match(
      text,
      /\b(?:one|1)\s*(?:or|\/)\s*(?:two|2)\b[\s\S]{0,180}(?:\b(?:code.?s author|builder|session|write)\b|never spawn)/i,
      `${rel} must keep one/two tests with the code author`
    );
    assert.match(
      text,
      /(?:\b(?:three|3)\s*(?:or more|\+)\b[\s\S]{0,180}\btest-author\b|\btest-author\b[\s\S]{0,180}\b(?:three|3)\s*(?:or more|\+)\b)/i,
      `${rel} must send three+ tests to test-author`
    );
  }
});

test("no build prompt names a repo command: every command is a step or a global script", () => {
  // The port's point: the skill and its agents name steps, never a repo's commands. Examples in
  // fenced blocks count too: they are copied.
  const files = [
    "skills/build",
    ...[
      "build-verifier",
      "builder",
      "fixer",
      "gate-silent-failure-hunter",
      "gate-warden",
      "hand-tester",
      "prior-art",
      "review-cursory",
      "security-review",
      "simplifier",
      "test-author",
    ].map((a) => `agents/${a}.md`),
  ];
  for (const rel of files) {
    const text = read(rel).replace(/^---\n[\s\S]*?\n---\n/, "");
    const hits = text.match(/\b(?:pnpm|npm run|yarn|npx tsx|tsx scripts\/|scripts\/[\w/-]+\.(?:ts|sh))\b/g) ?? [];
    assert.deepEqual(hits, [], `${rel} names repo commands: ${hits.join(", ")}`);
  }
});

const BLOCK_TAGS = ["fix-file", "hand-test-file", "hand-test-block", "parts-block", "test-slices-block"] as const;
type BlockTag = (typeof BLOCK_TAGS)[number];

/** Every fenced block tagged with a run-file or brief grammar: three or more backticks, then the tag. */
function taggedBlocks(text: string): { tag: BlockTag; body: string }[] {
  const re = /^(`{3,})(fix-file|hand-test-file|hand-test-block|parts-block|test-slices-block)[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;
  return [...text.matchAll(re)].map((m) => ({ tag: m[2] as BlockTag, body: m[3]! }));
}

/**
 * A `## Parts` example wrapped in the least brief `summariseBrief` takes: the header model is the
 * strongest part's, `## Target files` lists every part's `files:` entry, `## Deliverables` holds as
 * many bullets as the highest position a part names, and the `## Test slices` example rides along.
 */
function wrapPartsExample(parts: string, slices: string | null): string {
  const field = (name: string) => [...parts.matchAll(new RegExp(`^ {2}- ${name}: (.+)$`, "gm"))].map((m) => m[1]!);
  const models = field("model").map((v) => ({ model: /^(opus|sonnet|session)\b/.exec(v)![1] as BriefModel }));
  const files = field("files").flatMap((v) => v.split(",").map((e) => e.trim()));
  const last = Math.max(...field("deliverables").flatMap((v) => v.split(",").map(Number)));
  return [
    `model: ${strongestModel(models)} — the doc pin's wrapper`,
    "",
    "## Target files",
    "",
    ...files.map((f) => `- ${f}`),
    "",
    parts,
    "",
    ...(slices === null ? [] : [slices, ""]),
    "## Hand test",
    "",
    "none — the doc pin's wrapper",
    "",
    "## Deliverables",
    "",
    ...Array.from({ length: last }, (_, i) => `- deliverable ${i + 1}`),
    "",
  ].join("\n");
}

test("every run-file and brief-block example in the fixer, the hand tester, and the build skill parses", () => {
  const counts: Record<string, Record<BlockTag, number>> = {};
  const parts: string[] = [];
  const slices: string[] = [];
  for (const rel of ["agents/fixer.md", "agents/hand-tester.md", "skills/build"]) {
    counts[rel] = { "fix-file": 0, "hand-test-file": 0, "hand-test-block": 0, "parts-block": 0, "test-slices-block": 0 };
    for (const { tag, body: block } of taggedBlocks(read(rel))) {
      counts[rel]![tag]++;
      const where = `${rel} \`\`\`${tag} block`;
      if (tag === "fix-file") {
        assert.doesNotThrow(() => parseFixFile(block), where);
      } else if (tag === "hand-test-file") {
        assert.doesNotThrow(() => parseHandTestFile(block), where);
      } else if (tag === "hand-test-block") {
        assert.doesNotThrow(() => parseHandTestBlock(block), where);
      } else if (tag === "parts-block") {
        parts.push(block);
      } else {
        slices.push(block);
      }
    }
  }
  // A pin that parses nothing passes on nothing: each agent must hold the example it writes.
  assert.ok(counts["agents/fixer.md"]!["fix-file"] >= 1, "fixer.md needs a ```fix-file example");
  assert.ok(counts["agents/hand-tester.md"]!["hand-test-file"] >= 1, "hand-tester.md needs a ```hand-test-file example");
  assert.ok(counts["skills/build"]!["hand-test-block"] >= 1, "skills/build needs a ```hand-test-block example");
  assert.equal(counts["skills/build"]!["parts-block"], 1, "skills/build holds one ```parts-block example (BRIEF)");
  assert.equal(counts["skills/build"]!["test-slices-block"], 1, "skills/build holds one ```test-slices-block example (BRIEF)");
  // The two examples are one brief: the parts name the slice, so they parse together, as L1's parsers read them.
  const brief = wrapPartsExample(parts[0]!, slices[0]!);
  const summary = summariseBrief(brief);
  assert.equal(summary.partsDeclared, true);
  assert.deepEqual(parseParts(brief).map((p) => p.id), [...parts[0]!.matchAll(/^- (P\d+) · /gm)].map((m) => m[1]!));
  assert.deepEqual(parseTestSlices(brief).map((s) => s.id), [...slices[0]!.matchAll(/^- (W\d+) · /gm)].map((m) => m[1]!));
  assert.ok(summary.slices.every((s) => s.underTest.length <= DEFAULTS.TEST_SLICE_MAX_FUNCTIONS), "the example slice sits within the guide");
  // And the command a session runs on it takes it: briefCheck.ts exits 0.
  const dir = mkdtempSync(join(tmpdir(), "buildDocPins-"));
  try {
    const file = join(dir, "parts-example.md");
    writeFileSync(file, brief);
    const run = spawnSync(process.execPath, [join(ROOT, "runtime/briefCheck.ts"), file], { encoding: "utf8" });
    assert.equal(run.status, 0, `briefCheck.ts on BRIEF's parts example: ${run.stderr}`);
    assert.match(run.stdout, /^parts: 2 \(P1 sonnet, P2 opus after P1\)$/m);
    assert.match(run.stdout, /^slices: 1 \(W1 db, 2 functions\)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the builder and the fixer carry no model pin, no Skill, no Agent; the principles reach the choosing agents by their context row, not a skill preload; each flow agent is in the manifest", () => {
  // The spawn passes the model; with no pin, agent-model-guard.sh refuses a spawn that forgets.
  for (const agent of ["builder", "fixer"]) {
    const fm = frontmatter(agent);
    assert.equal(fmLine(fm, "model"), "", `${agent} must not pin model:`);
    assert.ok(!/\b(?:Skill|Agent)\b/.test(fmLine(fm, "tools")), `${agent} tools: must not include Skill or Agent`);
  }
  // The agents that make choices unasked hold the operator's decision principles from start.
  // The SubagentStart hook injects them for a context row with principles: true; a make-decision
  // preload would add the same text a second time, and the fixer stays light with no skills at all.
  const skillsOf = (agent: string) =>
    (frontmatter(agent).match(/^skills:\n((?: {2}- .+\n?)+)/m)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/^ {2}- /, "").trim())
      .filter(Boolean);
  assert.deepEqual(skillsOf("fixer"), [], "fixer preloads no skill");
  for (const agent of ["builder", "fixer", "brief-writer"]) {
    assert.ok(!skillsOf(agent).includes("make-decision"), `${agent} must not preload make-decision`);
    const row = MANIFEST.agents.find((a) => a.name === agent)?.context;
    assert.equal(row?.principles, true, `${agent}'s context row must inject the principles`);
  }
  const names = new Set(MANIFEST.agents.map((a) => a.name));
  for (const agent of FLOW_AGENTS) {
    assert.ok(names.has(agent), `${agent} (FLOW_AGENTS) must be an agents.json agent`);
    assert.doesNotThrow(() => frontmatter(agent), `${agent} must have agents/${agent}.md`);
  }
});

test("an agent whose context row has claudeMd: false carries omitClaudeMd: true itself", () => {
  // The plugin loads the raw file, so the row's claudeMd flag has to be in the frontmatter too.
  for (const a of MANIFEST.agents) {
    const want = a.context?.claudeMd === false ? "omitClaudeMd: true" : "";
    assert.equal(fmLine(frontmatter(a.name), "omitClaudeMd"), want, `${a.name}: omitClaudeMd must match its context row`);
  }
});

test("the hand tester is Opus, edits nothing, and keeps no memory", () => {
  const fm = frontmatter("hand-tester");
  assert.equal(fmLine(fm, "model"), "model: opus");
  const tools = fmLine(fm, "tools");
  for (const tool of ["Edit", "Skill", "Agent"]) {
    assert.ok(!new RegExp(`\\b${tool}\\b`).test(tools), `hand-tester tools: must not include ${tool}`);
  }
  assert.equal(fmLine(fm, "memory"), "", "hand-tester keeps no memory (memory would re-enable Edit)");
});

test("no agent keeps memory, and an agent that writes a file lists Write itself", () => {
  // `memory: user` would grant Write and Edit; agent memory is off, so a writer gets them only through `tools:`.
  for (const file of readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md"))) {
    assert.equal(fmLine(frontmatter(file.slice(0, -3)), "memory"), "", `${file} keeps no memory`);
    // A plugin agent's `hooks:` and `permissionMode:` are ignored by Claude Code; the no-push guard ships in hooks/hooks.json.
    assert.equal(fmLine(frontmatter(file.slice(0, -3)), "hooks"), "", `${file} carries no hooks: block`);
    assert.equal(fmLine(frontmatter(file.slice(0, -3)), "permissionMode"), "", `${file} carries no permissionMode:`);
  }
  for (const agent of ["builder", "fixer", "review-cursory", "gate-silent-failure-hunter", "security-review", "simplifier", "gate-warden", "build-verifier", "test-author"]) {
    assert.match(fmLine(frontmatter(agent), "tools"), /\bWrite\b/, `${agent} must list Write in tools`);
  }
});

/** The two-column markdown tables in a file: first cell, second cell. */
function tableRows(text: string): [string, string][] {
  return text
    .split("\n")
    .map((l) => l.match(/^\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null && !/^-+$/.test(m[1]!))
    .map((m) => [m[1]!, m[2]!]);
}
const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

test("the fixer's round table and decision table match the run-file grammar", () => {
  const rows = tableRows(body("fixer"));
  const byRound = new Map<string, string[]>();
  for (const [first, second] of rows) {
    // A drift group's round is `drift-<g>`; its kinds are the `drift` name's.
    const rounds = ticked(first).map((r) => (r === "drift-<g>" ? "drift" : r));
    if (rounds.length === 0 || !rounds.every((r) => (FIX_ROUNDS as readonly string[]).includes(r))) continue;
    const kinds = second === "every kind" ? [...KINDS] : ticked(second);
    for (const r of rounds) {
      assert.ok(!byRound.has(r), `round ${r} appears twice in fixer.md's round table`);
      byRound.set(r, kinds);
    }
  }
  for (const round of FIX_ROUNDS) {
    assert.deepEqual(
      [...(byRound.get(round) ?? [])].sort(),
      [...STAGES_FIXING[round]].sort(),
      `fixer.md says round ${round} fixes the kinds STAGES_FIXING gives`
    );
  }
  const which = rows
    .map(([first]) => ticked(first))
    .filter((t) => t.length === 1 && (DECISION_WHICH as readonly string[]).includes(t[0]!))
    .map((t) => t[0]!);
  assert.deepEqual([...which].sort(), [...DECISION_WHICH].sort(), "fixer.md lists every decision token once");
});

// ── The skill's procedure text agrees with the scripts (review of 0798a0d, CURSORY.*) ──────────

const stop = (file: string) => readFileSync(join(ROOT, "skills/build", file), "utf8");

/** The text under `## <heading>`, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `no \`## ${heading}\` section`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Numbered step `n` of a text: from its `n. ` line to the next numbered step or heading. */
function step(text: string, n: number): string {
  const m = text.match(new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |^## |(?![\\s\\S]))`, "m"));
  assert.ok(m, `no step ${n}.`);
  return m[0];
}

test("a failed Codex stage read's stand-in gets its own rows file, never the Codex dispatch", () => {
  assert.ok(STAGE_READER_NAMES.includes("review-cursory"), "reviewTable.ts dispatch must take --reader review-cursory");
  const fails = section(stop("CLOSE.md"), "Codex fails at a read");
  assert.match(fails, /reviewTable\.ts dispatch --run-dir <run-dir> --stage <stage> --reader review-cursory --out /);
  assert.match(fails, /stage-<stage>\/review-cursory\.md/);
  assert.doesNotMatch(fails, /same dispatch/, "the Codex dispatch tells its reader to write no file");
});

test("every stage read after a fix runs step 5's dispatch first", () => {
  const close = stop("CLOSE.md");
  assert.match(step(close, 5), /reviewTable\.ts dispatch --run-dir <run-dir> --stage confirm-1 --reader <reader>/);
  for (const n of [8, 10, 11]) assert.match(step(close, n), /owed readers as step 5/i, `CLOSE step ${n}`);
  const driftConfirm = step(stop("DRIFT.md"), 5);
  assert.match(driftConfirm, /owed readers as CLOSE step 5/);
  assert.match(driftConfirm, /reviewTable\.ts dispatch --run-dir <run-dir> --stage drift-confirm-<g> --reader review-cursory-codex/);
});

test("CURSORY.4: the drift group's commands use the group's own names, the ones the scripts take", () => {
  const drift = stop("DRIFT.md");
  assert.match(step(drift, 2), /stagePlan\.ts --run-dir <run-dir> --stage drift --from <pre-merge head>` prints `stage drift-<g>`/);
  assert.match(step(drift, 3), /reviewTable\.ts dispatch --run-dir <run-dir> --stage drift-<g> --reader review-cursory /);
  assert.match(step(drift, 3), /`<run-dir>\/stage-drift-<g>\/review-cursory\.md`/);
  assert.match(step(drift, 4), /reviewTable\.ts build --run-dir <run-dir> --round drift-<g>`/);
  assert.match(step(drift, 4), /`table-drift-<g>\.md`, `fix-drift-<g>\.txt`/);
  assert.match(step(drift, 5), /into `stage-drift-confirm-<g>\/`/);
  assert.doesNotMatch(drift, /`stage-drift\/|`stage-drift-confirm\/|--round drift`|`fix-drift\.txt`|The gate judges the latest group/);
  assert.match(drift, /The gate judges the one group/);
  // The names the text uses, as the scripts read them, for group 2.
  assert.deepEqual(parseStageKey("drift-2"), { stage: "drift", group: 2, key: "drift-2", folder: "stage-drift-2" });
  assert.deepEqual(parseStageKey("drift-confirm-2"), { stage: "drift-confirm", group: 2, key: "drift-confirm-2", folder: "stage-drift-confirm-2" });
  assert.ok(isRoundId("drift-2") && isFixRound("drift-2"));
  assert.equal(parseStageKey("drift"), null, "a bare drift stage names no group");
  assert.match(body("fixer"), /the round \(`1`, `2`, `3`, `escalate`, or a drift group's `drift-<g>`\)/);
});

test("TEXT-CURSORY.11: a blocked fixer has a route, and a row it cannot fix is a `blocked` line the grammar takes", () => {
  assert.match(step(stop("CLOSE.md"), 4), /\*\*A `blocked:` report\*\*[^\n]*spawn a fresh fixer from the same round head[^\n]*`<ROW> · blocked — <evidence>` line/);
  const fixer = body("fixer");
  assert.match(fixer, /`<ROW> · blocked — <evidence>`\./);
  assert.match(fixer, /Three failed fixes in a row on one row's check → stop on that row: write `<ROW> · blocked — <evidence>`/);
  const file = parseFixFile("CURSORY.1 · blocked — three tries left send.test.ts red\n" + EXIT_LINES, { rows: ["CURSORY.1"], round: "2" });
  assert.equal(file.lines[0]!.action, "blocked");
});

test("TEXT-CURSORY.5: `leftovers:` and `banked:` may repeat, as the ledger parser allows", () => {
  const close = stop("CLOSE.md");
  assert.match(close, /except the drift group \(DRIFT\.md; at most one per build\), `drift-merge:` \(every one counts\), `leftovers:` \(the last one counts\), `verifier:` \(the last one counts\), `banked:` \(every one counts\), and `answered:` \(every one counts\)/);
  assert.match(step(stop("DRIFT.md"), 6), /write a new `leftovers:` line with the new count/);
  const ledger = parseLedger(
    ["class: R1 — o, 2026-09-28", "flow: 2", "leftovers: pr-body | rows=1 | scope=plan-QRK-5", "banked: A.1 (awaiting operator)", "leftovers: pr-body | rows=2 | scope=plan-QRK-5", "banked: B.2 (awaiting operator)"].join("\n")
  );
  assert.equal(ledger.leftovers?.rows, 2);
  assert.deepEqual(ledger.banked, ["A.1", "B.2"]);
});

test("CODEX.6: CLOSE and SHIP say any signals arm failure but exit 2 is loud", () => {
  assert.match(stop("CLOSE.md"), /exited non-zero with any code but 2/);
  assert.match(stop("SHIP.md"), /any failure but an old arm's exit 2/);
});

test("a stacked unit moves its base to origin/main by --base, since freshen: is written once", () => {
  const multi = section(stop("SKILL.md"), "Multi-unit plans — stack, never idle");
  assert.match(multi, /`base=origin\/main`/);
  assert.match(multi, /`base=<N-1 head sha>`/);
  assert.match(multi, /pass `--base origin\/main` to every `stagePlan\.ts` and `shipGate\.ts` call/);
  assert.match(stop("SHIP.md"), /passes `--base origin\/main`/);
  for (const script of ["stagePlan.ts", "shipGate.ts"]) {
    assert.match(readFileSync(join(ROOT, "runtime", script), "utf8"), /assertKnownFlags\(argv, \[[^\]]*"--base"/, `${script} takes --base`);
  }
});

test("the no-findings path still runs the leftovers step and may owe its ledger line", () => {
  const none = section(stop("CLOSE.md"), "No findings");
  assert.match(none, /run steps 13 and 14/);
  assert.match(none, /Ledger:[^\n]*`leftovers`/);
});

test("the fixer reads a HAND row's claim in the hand-test section, and its dispatch names that file", () => {
  const fixer = body("fixer");
  assert.match(fixer, /A `HAND\.<k>` row[^\n]*does not hold the claim: read the claim's `run:` and `pass:` lines in the `## Hand test` section/);
  assert.doesNotMatch(fixer, /Its texts hold the claim/);
  assert.match(fixer, /\*\*Your dispatch\*\*[^\n]*the brief path \(on a `--from-branch` run, the `hand-test-block:` file/);
  assert.match(step(stop("CLOSE.md"), 4), /the brief path \(on `--from-branch`, the `hand-test-block:` file\)/);
});

test("the hand tester's report names each failed claim's cause, as CLOSE 5a and 5b need", () => {
  const line = "then one `fail (<cause>): H<k>` line per failed claim";
  assert.ok(section(body("hand-tester"), "Report").includes(line), "hand-tester.md §Report");
  assert.ok(step(stop("CLOSE.md"), 5).includes(line), "CLOSE step 5");
});

test("the brief's model line is written at step 2, because step 3's check refuses a draft without it", () => {
  const draft = [
    "# quick-x",
    "",
    "## Target files",
    "",
    "- a.ts",
    "",
    "## Hand test",
    "",
    "none — a doc",
    "",
    "## Deliverables",
    "",
    "- one",
  ].join("\n");
  assert.throws(() => summariseBrief(draft), (e: unknown) => e instanceof BriefPartError && e.part === "model");
  const brief = stop("BRIEF.md");
  assert.match(step(brief, 7), /Write the line by this rule at step 2/);
  assert.match(step(brief, 7), /step 4's `signals` line/);
});

test("BUILD's fresh-tree path and the builder's first check agree: fast-forward, then the HEAD check", () => {
  const build = stop("BUILD.md");
  const builder = body("builder");
  assert.match(build, /`fast-forward: <start commit>`/);
  assert.match(build, /`git merge --ff-only <start commit>`/);
  assert.match(builder, /`fast-forward: <start commit>` line, run `git merge --ff-only <start commit>`[^\n]*Then `git rev-parse HEAD` must equal the start commit/);
  assert.doesNotMatch(build, /cherry-pick/);
  assert.doesNotMatch(builder, /git cherry-pick/);
});

// ── Dry run B2b (fix3): the text agrees with the gate on a session's commit between rounds ──────

test("dry-run 2, 3, 9: a session commit joins the next read by from=, owes the verifier on an amend, and sha= is the range end", () => {
  const close = stop("CLOSE.md");
  const four = step(close, 4);
  assert.match(four, /from=<where the last read ended> \| sha=<HEAD after the merge>`/);
  assert.match(four, /for rounds 2, 3, and escalate the previous fix line's `sha=` \(the previous round's head when that round had no fixer\)/);
  assert.doesNotMatch(four, /from=<HEAD before the merge>/);
  assert.match(four, /\*\*4c\. A session commit between rounds\*\*[^\n]*joins the next read/);
  assert.match(four, /4c\.[^\n]*When the next round has no rows, stagePlan still owes that round's read over it/);
  assert.match(four, /4c\.[^\n]*An `amend brief:` commit anywhere in a read's range owes the verifier at that read/);
  assert.match(step(close, 5), /The `sha=` of every read line is the end of the range the readers read, as stagePlan printed it — not the tree's head/);
  assert.match(body("build-verifier"), /at any later read whose range holds an `amend brief:` commit/);
  // a read after a fix re-grades only what the range amends or touches, in the agent and in CLOSE alike.
  assert.match(section(body("build-verifier"), "Your file"), /Checks 0, 1, and 2 in full; Check 3 grades only the deliverables an `amend brief:` in the range adds or changes, and those whose file \(its locator in the last check log\) the range touches/);
  assert.match(body("build-verifier"), /so at the wave run it exhaustively \(a read after a fix grades fewer: §Your file\)/);
  assert.match(close, /a `build-verifier` line ending `run <manifest> --brief-file <brief> --no-exercise yourself` — run that command on the post-round head; a non-zero exit owes the verifier at that read/);
  assert.doesNotMatch(body("build-verifier"), /what the four checks find now at the round's head/);
});

test("hand tests: a commit after final owes none; a claim the session re-runs comes before the final table's rebuild", () => {
  const one = step(stop("SHIP.md"), 1);
  assert.match(one, /\*\*A commit after the final table\*\*[^\n]*owes no hand test: a claim that passed stays passed/);
  assert.doesNotMatch(one, /the gate names stale|the PR's code changed after the final table/);
  const hand = one.indexOf("you may spawn a fresh `hand-tester`");
  const table = one.indexOf("re-run `node ~/.agent-build/runtime/reviewTable.ts build --run-dir <run-dir> --round final`");
  assert.ok(hand >= 0 && table > hand, "SHIP step 1: a chosen hand tester runs before the final table is re-built");
  const close = stop("CLOSE.md");
  assert.match(step(close, 8), /the first hand test runs every claim; after it the line names only claims whose last run failed\. A claim that passed is never re-owed by a later change to the PR's code; you may add one/);
  assert.doesNotMatch(close, /stale claims|went stale because the PR's code changed/);
  assert.doesNotMatch(stop("BRIEF.md"), /owes a re-read and a fresh hand test/);
});

test("hand tests: a claim is what tests do not do; a test-runner run: is no claim", () => {
  const brief = stop("BRIEF.md");
  assert.match(brief, /\*\*A claim is what the tests do not already do:\*\* it drives the live app \(a Maestro flow on the simulator\), queries the database, calls a live endpoint, or reads a log/);
  assert.match(brief, /`testRunnerOf`, `~\/\.agent-build\/runtime\/lib\/brief\.ts`\) — is no claim[^\n]*`briefCheck\.ts` exits 1 on it\. The same holds for the `<manifest>` step with no exercise to run \(`--no-exercise`, or a brief with no `exercise:` line\)[^\n]*A brief with no such claim has no hand test/);
  assert.match(brief, /has a claim that runs the `<manifest>` step on the brief with the exercise \(H2 below\), because the exercise calls live endpoints and nothing else runs it/);
  assert.match(brief, /or a claim whose `run:` is a test runner or the `<manifest>` step with no exercise is malformed/);
  assert.match(body("hand-tester"), /A claim is what the tests do not already do: it drives the live app \(a Maestro flow\), queries the database, calls a live endpoint, or reads a log\./);
  assert.match(body("hand-tester"), /or runs the repo's `manifest` step with no exercise \(`--no-exercise`, or a brief with no `exercise:` line\), is no claim/);
  for (const m of read("skills/build").matchAll(/^ {2}- run: `([^`]+)`$/gm)) {
    assert.equal(testRunnerOf(m[1]!), null, `a skill example claim runs a test runner: ${m[1]}`);
  }
});

test("dry-run 6: freshen additions that commit re-run the size step", () => {
  assert.match(step(stop("CLOSE.md"), 1), /An addition that commits changes what the size step reports: re-materialize `diff\.patch` and re-run the size step after that commit/);
});

test("dry-run 7 and 8: a stopped fixer's edits ride as a patch note; a watch that dies is re-armed", () => {
  const four = step(stop("CLOSE.md"), 4);
  assert.match(four, /\*\*4d\. A stopped fixer's uncommitted edits\.\*\*[^\n]*> <inputs-dir>\/fix-<round>-partial\.patch`/);
  assert.match(four, /4d\.[^\n]*reads and never applies blindly\. Remove the old worktree[^\n]*after the fresh fixer has started/);
  assert.doesNotMatch(four, /`git -C <old worktree>/, "a worktree session refuses git -C into another worktree");
  assert.match(stop("SKILL.md"), /Any other exit — 144, a kill, a signal — is the watch dying, not a verdict on any agent: re-arm it with the same paths, and check each watched agent's output file/);
});

test("dry-run 10 and 11: the first leftovers ticket has an owner, and the telemetry ingest runs sandbox-off", () => {
  const close = stop("CLOSE.md");
  assert.match(step(close, 13), /\*\*No ticket yet\*\*[^\n]*you, the orchestrating session, create it now with the notes' ticket skill \(`\/file-linear-ticket` where the notes name it\) — one standing ticket per plan/);
  assert.match(step(close, 13), /Until it exists[^\n]*the ledger says `pr-body`/);
  assert.match(step(close, 14), /in the MAIN checkout[^\n]*`dangerouslyDisableSandbox: true`[^\n]*A dry run skips the ingest/);
});

test("dry-run 13: the fixer names the DB-lane tests its tree cannot run, and CLOSE runs the DB gate on that line", () => {
  const line = "`not run here: <test path>, … — <why>`";
  assert.ok(section(body("fixer"), "Report").includes(line), "fixer.md §Report");
  assert.match(body("fixer"), /Name it on your report's `not run here:` line; the session runs those tests \(the repo's DB gate when your diff changes a schema file\) after it merges your branch, before the confirm/);
  const four = step(stop("CLOSE.md"), 4);
  assert.ok(four.includes(`on a ${line} line`), "CLOSE 4e names the same line");
  // with no schema change, only the named tests run; the whole DB gate is for a schema change.
  assert.match(four, /4e\.[^\n]*after `git merge <b>` and before the confirm's spawns: when the fix changed no schema file the notes name, run only the tests the line names[^\n]*when it did, run the repo's `<db_gate>` step in the run tree/);
});

// ── fix4: dry runs 2 and 3 ──────────────────────────────────────────────────────────────────

test("fix4 items 1, 2, 4: a re-built round keeps its head; `verifier:` repeats; order past line two carries no meaning", () => {
  const close = stop("CLOSE.md");
  assert.match(step(close, 3), /\*\*3b\. Re-building a round\.\*\*[^\n]*re-builds it at the head it holds[^\n]*`--head <sha>` overrides, and `final` always takes the tree's HEAD/);
  assert.match(close, /Past the class and `flow:` lines, order carries no meaning outside a drift group/);
  assert.match(step(close, 2), /when a later read owes the verifier again[^\n]*write a new `verifier:` line after that read — the last one counts/);
  // an INCOMPLETE verifier is re-spawned once, never in a loop.
  assert.match(step(close, 2), /re-spawn the verifier fresh, once \(before step 3 at the wave\)[^\n]*A second `INCOMPLETE` on the same check that no claim clears is a blocker, as in 3a/);
  assert.match(step(close, 4), /write `banked: <ids> \(awaiting operator\)` when you bank \(any later line may follow it\)/);
  assert.match(step(stop("SHIP.md"), 1), /`hand-test-<n>:` line \(after `ship:` is fine/);
  // The forms the text describes parse in that order.
  const l = parseLedger(
    [
      "class: R1 — o, 2026-09-28",
      "flow: 2",
      "wave: review-cursory | sha=aaaaaaa",
      "verifier: CLEAN | sha=aaaaaaa",
      "banked: CODEX.2 (awaiting operator)",
      "verifier: CLEAN | sha=bbbbbbb",
      "ship: dry-run | sha=bbbbbbb",
      "hand-test-2: 1/1 | sha=bbbbbbb",
    ].join("\n")
  );
  assert.deepEqual([l.verifier, l.banked, l.handTests.length], [{ verdict: "CLEAN", sha: "bbbbbbb" }, ["CODEX.2"], 1]);
});

test("fix4 item 3: BRIEF says the target list never names the brief", () => {
  assert.match(stop("BRIEF.md"), /\*\*The list never names the brief itself:\*\* the brief is the spec, not the PR's code/);
});

test("fix4 item 5: the cursory split names its helper, and a wave past the cap runs one message per beat", () => {
  const close = stop("CLOSE.md");
  assert.match(close, /`node ~\/\.agent-build\/runtime\/cursorySplit\.ts --diff-file <inputs-dir>\/diff\.patch` prints every folder's counted lines/);
  assert.match(close, /A wave larger than the cap runs in beats, as many as it takes: one message spawns each beat's readers/);
  assert.match(step(close, 2), /^2\. \*\*Wave\.\*\* One message per beat spawns the class's readers/);
});

test("fix4 item 7: entering CLOSE on a branch built earlier — the build line's form parses, and the handoff note is none", () => {
  const one = step(stop("CLOSE.md"), 1);
  const form = /`(build: model=<the brief's model: line> \| agent=none \| sha=<the head you entered at>)`/.exec(one);
  assert.ok(form, "CLOSE step 1 gives the build line for a branch built earlier");
  const line = form[1]!.replace("<the brief's model: line>", "opus").replace("<the head you entered at>", "aaaaaaa");
  assert.deepEqual(parseLedger(`class: R1 — o, 2026-09-28\nflow: 2\n${line}\n`).build, { model: "opus", agents: [], sha: "aaaaaaa" });
  assert.match(step(stop("CLOSE.md"), 4), /`none` on a floor-check or `--from-branch` run, or when this run entered at CLOSE on a branch built earlier/);
});

test("fix4 item 8: the Codex stand-in is spawned on sonnet", () => {
  assert.match(section(stop("CLOSE.md"), "Codex fails at a read"), /spawn a fresh `review-cursory` with `model: sonnet`/);
});

test("fix4 item 9: --from-branch makes the diff first, defines <branch-slug>, pins the unattended class, and uses the repo's commit style", () => {
  // Its example block holds a `## Hand test` heading, so the section runs to the next stop heading.
  const fb = stop("FROM-BRANCH.md");
  const diff = fb.indexOf("**First, the diff:** `git diff <base>...HEAD > <inputs-dir>/diff.patch`");
  assert.ok(diff >= 0 && diff < fb.indexOf("The class moment runs from that file"), "the diff is made before the class moment");
  // The agent picks the class on every run, attended or not.
  assert.match(fb, /its status message, with `decisions: none`; pin `class: R<n> — agent \(unconfirmed\), <date>` as BRIEF step 4 says/);
  assert.doesNotMatch(read("skills/build"), /AskUserQuestion/);
  assert.match(fb, /in the repo's commit style/);
  assert.doesNotMatch(fb, /subject `hand-test:/);
  assert.match(fb, /`verifier: N\/A \(from-branch, no brief\)` where it writes its verifier line, after `wave:`/);
  assert.match(stop("SKILL.md"), /\*\*`<branch-slug>`\*\* is the same rule on any branch name[^\n]*every `\/` becomes `-`/);
  assert.match(step(stop("CLOSE.md"), 2), /the `simplifier` when the size step's line said `fires`/);
});

test("fix4 items 10, 11, 13: the DB gate runs at the run's base; one defect keeps one fix; a stale server is env", () => {
  const four = step(stop("CLOSE.md"), 4);
  assert.match(four, /4e\.[^\n]*against the run's base: the ledger's `base=` in place of the `--base <ref>` the step's command carries/);
  assert.match(four, /4e\.[^\n]*the block's title starts `same defect as claim H<k>:`/);
  assert.match(body("fixer"), /\*\*A `SESSION` row whose text starts `same defect as claim H<k>:`\*\* and row `HAND\.<k>` are one defect[^\n]*write both rows `fixed` with the same sha/);
  assert.match(four, /4b\.[^\n]*restart that server before the next hand tester starts/);
  assert.match(body("hand-tester"), /`env`: [^\n]*a server the claim reaches still serves code older than the head/);
});

test("fix4 items 12, 14: the banked question has a named file, and a banked run removes its fixer worktrees", () => {
  const close = stop("CLOSE.md");
  assert.match(step(close, 4), /4a\.[^\n]*when a session log is configured, bank each as[^\n]*in its Todo; with none, and on an unattended run[^\n]*as well, in the question bank, `<run-root>\/<worktree>-<branch>\/afk-questions\.md`/);
  assert.match(step(close, 12), /\*\*A banked run stops here until the operator answers,\*\*[^\n]*`git worktree remove` every fixer's worktree[^\n]*Leave the local stack up/);
});

test("trial issues 13, 18: the session answers a decision it can before banking; a banked run still pushes a draft PR", () => {
  const close = stop("CLOSE.md");
  const four = step(close, 4);
  assert.match(four, /4a\.[^\n]*\*\*Answer it yourself first\*\* when anything answers it: the code, the plan docs, `docs\/`, the ticket or the tracker, the repo's knowledge base[^\n]*or your own brief/);
  assert.match(four, /4a\.[^\n]*then the ledger line `answered: <id> \| by=SESSION\.<n>`\. Nothing is banked[^\n]*\*\*Bank only a product decision nothing answers:\*\*/);
  assert.match(body("fixer"), /a choice the code or the repo's docs already make is not a decision/);
  assert.match(step(close, 12), /\*\*A banked run still pushes and opens its PR as a draft,\*\* so the operator can see it[^\n]*it never flips ready or merges\./);
  // The line 4a writes parses.
  const l = parseLedger(["class: R1 — o, 2026-09-28", "flow: 2", "answered: CODEX.2 | by=SESSION.3"].join("\n"));
  assert.deepEqual(l.answered, [{ id: "CODEX.2", by: "SESSION.3" }]);
});

test("unbank: a banked run resumes in its own run dir, never by --from-branch; one cursory read of the fix", () => {
  const close = stop("CLOSE.md");
  for (const n of [4, 12]) assert.match(step(close, n), /the same run resumes \(UNBANK\.md\)/);
  assert.doesNotMatch(step(close, 12), /--from-branch/);
  assert.doesNotMatch(read("skills/build"), /later `\/build --from-branch` run|later `--from-branch` run/);
  assert.match(stop("FROM-BRANCH.md"), /A banked run never comes here: it resumes by UNBANK\.md\./);
  const unbank = stop("UNBANK.md");
  assert.match(unbank, /No new run, no wave, no fix rounds\./);
  assert.match(step(unbank, 2), /`unbank: <ids> \| from=<the head step 1 noted> \| sha=<head after the fix>`, with `\| model=<m> \| agent=<id>` when a fixer made it/);
  assert.match(step(unbank, 3), /stagePlan\.ts --run-dir <run-dir> --stage unbank`[^\n]*spawn ONE `review-cursory`: no Codex, and no other reader/);
  assert.match(step(unbank, 3), /`unbank-read: review-cursory \| sha=<range end>`[^\n]*no read follows unless the operator asks for one/);
  assert.match(step(unbank, 4), /only claims whose last run failed\), plus any you judge the fix reaches\. None named and none chosen → none run\./);
  assert.match(body("fixer"), /## An unbank round\n\nRound `unbank` fixes rows the run banked/);
  assert.match(body("review-cursory"), /on the one read of an unbank fix, `<run-dir>\/unbank\/review-cursory\.md` in the wave's format/);
  // The lines the text writes parse, and the read folder is the one the text names.
  const l = parseLedger(
    [
      "class: R1 — o, 2026-09-28",
      "flow: 2",
      "banked: CODEX.2 (awaiting operator)",
      "unbank: CODEX.2 | from=aaaaaaa | sha=bbbbbbb | model=sonnet | agent=u1",
      "unbank-read: review-cursory | sha=bbbbbbb",
    ].join("\n")
  );
  assert.deepEqual([l.banked, l.unbank?.ids, l.unbankRead?.sha], [["CODEX.2"], ["CODEX.2"], "bbbbbbb"]);
});

// ── Landing 2 (L6): BRIEF's parts and small work, CLOSE's trees, the isolated verifier ─────────

test("CLOSE §Trees: a run tree per open run, entered with EnterWorktree; never git into another tree", () => {
  const trees = section(stop("CLOSE.md"), "Trees");
  assert.match(trees, /`git worktree add <that path> -b <branch> <start>` with the sandbox off \(`dangerouslyDisableSandbox: true`/);
  assert.match(trees, /then run `git worktree add <that path> <branch>`, without `-b`/);
  assert.match(trees, /`<start>` is `origin\/main`, or for a stacked unit N the head of N-1/);
  assert.match(trees, /then `EnterWorktree` with `path: <that path>`; then the `<install>` step/);
  assert.match(trees, /Back to the launch tree: `EnterWorktree` with its `path` when it sits under `\.claude\/worktrees\/`, else `ExitWorktree` with `action: "keep"` \(never `"remove"`\)/);
  assert.match(trees, /\*\*Never run git in another tree by `git -C <tree>` or `cd <tree> && git …`, even to read\.\*\*/);
  assert.match(trees, /The first call after entering, and after any compaction, is `git rev-parse --abbrev-ref HEAD`[^\n]*`branch=`/);
  assert.match(trees, /`run <runid> is on <b>; this tree is on <c> — enter the run's tree first`/);
  assert.match(trees, /SHIP runs one run at a time, in merge order/);
});

test("CLOSE §Trees: every read has a review tree; the verifier and the simplifier read their own isolated trees", () => {
  const close = stop("CLOSE.md");
  const trees = section(close, "Trees");
  assert.match(trees, /`git worktree add --detach <inputs-dir>\/review-<stage>-<n> <range end>`/);
  assert.match(trees, /Remove the review tree \(`git worktree remove --force <inputs-dir>\/review-<stage>-<n>`\) once every reader of that read has reported and its Codex run has exited/);
  assert.match(trees, /\*\*`build-verifier` and `simplifier` spawn with `isolation: "worktree"` instead\*\*[^\n]*`start commit: <range end>`/);
  assert.match(trees, /When each reports, remove its tree: `git worktree remove --force <its path, from the spawn's result>`/);
  // Each read names its own tree: the wave, a stage read, a Codex stand-in, the drift read.
  assert.match(step(close, 2), /`<inputs-dir>\/review-wave-1`[^\n]*`build-verifier` and `simplifier` spawn with `isolation: "worktree"` and get `start commit: <the wave head>`/);
  assert.match(step(close, 5), /`<inputs-dir>\/review-confirm-1-1` at the range end stagePlan printed[^\n]*`build-verifier`, when owed, spawns with `isolation: "worktree"` and `start commit: <range end>`/);
  assert.match(section(close, "Codex fails at a read"), /`<inputs-dir>\/review-<stage>-2` at the same range end/);
  assert.match(step(stop("DRIFT.md"), 3), /`<inputs-dir>\/review-drift-<g>-1` at the merged head/);
  // The simplifier's own file agrees: it reads its own tree at the start commit.
  assert.match(body("simplifier"), /spawns you with `isolation: "worktree"`, and your read root is your own tree/);
  assert.doesNotMatch(close, /session tree|session worktree/, "CLOSE names the run tree, never the session tree");
});

test("CLOSE §Trees: the hand tester pins its run tree through the harness's live-agent check or its report, and the stack only moves when nothing uses it", () => {
  const close = stop("CLOSE.md");
  const trees = section(close, "Trees");
  assert.match(trees, /is the harness's live-agent check when it has one, asked for live `hand-tester` agents whose cwd is the run tree/);
  assert.match(trees, /With no such check, the hand tester is live from its spawn until its report \(`hand-test-<n>\.txt written` or `blocked:`\) is in\./);
  assert.doesNotMatch(close, /agent-guard\.py/, "CLOSE names no harness script");
  assert.match(trees, /Empty output and exit 0 is clear; any line, or any non-zero exit, counts as live/);
  assert.doesNotMatch(close, /ls ~\/\.claude\/agent-guard/, "no session re-parses agent-guard's files");
  assert.match(trees, /\*\*The stack rule, per run tree\.\*\* Nothing changes a run's stack[^\n]*while anything uses it/);
  assert.match(trees, /After any merge that changes a schema file the notes name — a part, the freshen, a fixer — run the notes' stack refresh/);
  assert.match(step(close, 5), /spawn a `hand-tester` un-isolated, cwd the run tree/);
  assert.match(step(close, 4), /4b\.[^\n]*run the stack refresh \(§Trees, the stack rule\)\. Neither runs while the `--live` check \(§Trees\) prints a hand tester/);
});

test("CLOSE step 1: freshen writes branch=, and a build line entered at CLOSE carries no parts=", () => {
  const one = step(stop("CLOSE.md"), 1);
  assert.match(one, /`freshen: <merged sha> \| base=<[^`]*> \| branch=<the run's branch; on --from-branch, that branch> \| sha=<head>`/);
  assert.match(one, /the line carries no `parts=` whatever the brief holds/);
  assert.match(one, /A freshen merge that changes a schema file the notes name owes the stack refresh/);
});

test("CLOSE step 4: the fixer gets every part's handoff note and the run tree, and reaches the stack by the copy rule", () => {
  const four = step(stop("CLOSE.md"), 4);
  assert.match(four, /every part's handoff note, one per part \(`<part worktree>\/\.claude\/run-state\/handoff\.md` for a builder part, `none` for a `session` part/);
  assert.match(four, /the run tree \(absolute: the fixer copies the stack's bindings from it, 4e\)/);
  assert.match(four, /4e\.[^\n]*A fixer whose diff changes no schema file the notes name reaches the run's stack by the notes' copy rule/);
  assert.doesNotMatch(four, /cannot reach the local stack/);
  assert.match(body("fixer"), /\*\*Your dispatch\*\*[^\n]*the handoff note paths, one per part, or `none`/);
});

test("DRIFT.md: one drift group per build; main moving again after it writes drift-merge:", () => {
  const drift = stop("DRIFT.md");
  assert.match(drift, /A build has at most one drift group/);
  assert.match(step(drift, 2), /`<g>` is the group's number, `1`/);
  assert.match(drift, /`drift-merge: \| from=<head before the merge> \| sha=<head after the merge>`/);
  // SHIP's pre-push `<checks>` on the same head is the one run; a drift-merge runs none of its own.
  assert.match(drift, /No second group, no reader, no fixer, and no `<checks>` run of its own: `git fetch origin`, merge `origin\/main`[^\n]*SHIP's pre-push `<checks>` run and CI carry what changed/);
  assert.doesNotMatch(drift, /run the `<checks>` step/);
  const shipOne = step(stop("SHIP.md"), 1);
  assert.match(shipOne, /Any later move is only merged, with no reader:[^\n]*write `drift-merge: [^\n]*then re-run the gate; the `<checks>` run below is its run\./);
  assert.doesNotMatch(shipOne, /run the `<checks>` step, write `drift-merge:/);
  assert.doesNotMatch(drift, /then 2, 3|another group|every group/);
});

test("CLOSE: security-review reads a fix only at confirm-1 and confirm-2", () => {
  const close = stop("CLOSE.md");
  for (const n of [10, 11]) assert.doesNotMatch(step(close, n), /security-review/, `CLOSE step ${n}`);
  assert.doesNotMatch(stop("DRIFT.md"), /security-review/);
  assert.match(step(close, 8), /`security-review` at R2 on a fire/);
});

test("build-verifier: no Skill, isolated at its start commit, installed before Check 1, and it reads the parts", () => {
  const fm = frontmatter("build-verifier");
  assert.doesNotMatch(fmLine(fm, "tools"), /\bSkill\b/);
  const verifier = body("build-verifier");
  const tree = section(verifier, "Your tree");
  assert.match(tree, /\*\*First action:\*\* `git rev-parse HEAD`, as its own call, must equal the `start commit:` your dispatch names/);
  assert.match(tree, /`git switch --detach <start commit>` in your own tree/);
  assert.match(tree, /`VERDICT: INCOMPLETE — start commit: HEAD <sha> is not <start commit>`/);
  assert.match(tree, /\*\*Before Check 1\*\*, run the repo's install step: `node ~\/\.agent-build\/runtime\/steps\.ts \. --get install`/);
  const inputs = section(verifier, "Your inputs");
  assert.match(inputs, /Its `## Parts` section[^\n]*its `## Test slices` section/);
  assert.match(inputs, /\*\*The start commit\*\* — `start commit: <sha>`[^\n]*`isolation: "worktree"`/);
  assert.match(verifier, /> \*\*Contract pin — edit in lockstep\.\*\*[^\n]*`## Parts` and `## Test slices`/);
});

test("with no session log, every record a later session needs lands in a run-root artifact SHIP or a resume reads", () => {
  const close = stop("CLOSE.md");
  const shipOne = step(stop("SHIP.md"), 1);
  const bank = "`<run-root>/<worktree>-<branch>/afk-questions.md`";
  assert.match(step(stop("BUILD.md"), 9), /one you reject is, when a session log is configured, [^\n]*else one line appended to the `decisions:` list of `<run-dir>\/class-moment\.txt`[^\n]*which SHIP step 1 copies into the PR body's `## Decisions`/);
  assert.match(shipOne, /its `class:` line followed by its `decisions:` lines, verbatim/);
  assert.match(step(close, 4), /SHIP step 1 copies the bank's open entries into the PR body's `## Open questions`/);
  assert.ok(shipOne.includes(`the open \`## Q<n>\` entries (a heading with no \`(answered …)\`) of the question bank ${bank} (CLOSE 4a), when it exists, under \`## Open questions\``), "SHIP step 1 reads the bank's open entries only");
  const thirteen = step(close, 13);
  assert.match(thirteen, /else on an earlier run's `leftovers:` ledger line of the same `<scope>`/);
  assert.match(thirteen, /with none, the `leftovers: <ticket id>` ledger line below is the record a later run reads/);
  for (const file of ["BRIEF.md", "BUILD.md", "CLOSE.md"]) {
    assert.doesNotMatch(stop(file),/next status|else (in|under) the PR body/, `${file}: a no-log fallback is a file, not a status or a PR body`);
  }
});

test("an answered banked question leaves the bank's open entries, so SHIP never copies it as open", () => {
  const bank = "`<run-root>/<worktree>-<branch>/afk-questions.md`";
  assert.match(step(stop("CLOSE.md"), 4), /4a\.[^\n]*as one `## Q<n> — <id>` entry under `# Open questions`/);
  const one = step(stop("UNBANK.md"), 1);
  assert.match(one, /Flip each answered `question:` Todo line \(CLOSE 4a\) to `\[x\]`/);
  assert.ok(one.includes(`in the question bank ${bank}, when it exists, end each answered row's \`## Q<n> — <id>\` heading with \` (answered <date>: <the answer>)\``), "UNBANK closes the bank entry");
  const shipOne = step(stop("SHIP.md"), 1);
  assert.ok(shipOne.includes("the open `## Q<n>` entries (a heading with no `(answered …)`)"), "SHIP copies only open entries");
  assert.ok(shipOne.includes("or, when the PR exists (a banked run's draft), `gh pr edit <n> --body-file <file>`, so a question answered since leaves its `## Open questions`"), "the banked draft's body is rewritten");
});

test("the no-log leftovers lookup selects only the standing ticket of the same plan or session", () => {
  const thirteen = step(stop("CLOSE.md"), 13);
  const cmd = /`(awk [^`]* <run-root>\/\*\/build-\*\/ship\.md)`/.exec(thirteen)?.[1];
  assert.ok(cmd, "CLOSE step 13 names the lookup command");
  assert.match(thirteen, /`leftovers: <ticket id \| pr-body> \| rows=<n> \| scope=<scope>`/);
  assert.match(thirteen, /`plan-<the plan's epic id>` for plan-driven work, `session-<first 8 characters of the session id>` for work outside a plan/);
  assert.match(stop("DRIFT.md"), /write a new `leftovers:` line with the new count and the same `scope=`/);
  const root = mkdtempSync(join(tmpdir(), "leftovers-lookup-"));
  try {
    const runs: Record<string, string> = {
      // This session's earlier ad-hoc run, and a later one of it that only reached the PR body.
      "wt-a-fix-x/build-1": "leftovers: QRK-12 | rows=2 | scope=session-1a2b3c4d",
      "wt-a-fix-y/build-2": "leftovers: pr-body | rows=1 | scope=session-1a2b3c4d",
      // Another session's ad-hoc run in the same run root.
      "wt-b-fix-z/build-3": "leftovers: QRK-99 | rows=1 | scope=session-ffff0000",
      // A plan, its fields in the other order, and a plan whose id has QRK-5 as a prefix.
      "wt-c-feat-p/build-4": "leftovers: QRK-50 | scope=plan-QRK-5 | rows=3",
      "wt-d-feat-q/build-5": "leftovers: QRK-77 | rows=1 | scope=plan-QRK-55",
      // A plan id with a dot, and two ids it must not match: one with another character there, one it prefixes.
      "wt-e-feat-r/build-6": "leftovers: QRK-60 | rows=1 | scope=plan-release.1",
      "wt-f-feat-s/build-7": "leftovers: QRK-61 | rows=1 | scope=plan-releaseX1",
      "wt-g-feat-t/build-8": "leftovers: QRK-62 | rows=1 | scope=plan-release.10",
      // Written by hand: the ticket last, no spaces around `|`, trailing whitespace.
      "wt-h-feat-u/build-9": "leftovers: rows=1|scope=plan-QRK-7|QRK-70  ",
      // A line from before `scope=` existed names no plan or session, so no lookup selects it.
      "wt-i-fix-v/build-10": "leftovers: QRK-88 | rows=1",
    };
    for (const [dir, line] of Object.entries(runs)) {
      // Each fixture line is one the ledger grammar accepts, so the lookup reads what ledgerLine.ts writes.
      parseLedger(["class: R1 — o, 2026-09-28", "flow: 2", line].join("\n"));
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "ship.md"), `class: R1 — o, 2026-09-28\nflow: 2\n${line}\n`);
    }
    const lookup = (scope: string) => {
      const r = spawnSync("bash", ["-c", cmd.replaceAll("<run-root>", root).replaceAll("<scope>", scope)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim().split("\n").filter(Boolean);
    };
    assert.deepEqual(lookup("session-1a2b3c4d"), ["QRK-12"]);
    assert.deepEqual(lookup("session-ffff0000"), ["QRK-99"]);
    assert.deepEqual(lookup("plan-QRK-5"), ["QRK-50"]);
    assert.deepEqual(lookup("session-00000000"), []);
    assert.deepEqual(lookup("plan-release.1"), ["QRK-60"]);
    assert.deepEqual(lookup("plan-releaseX1"), ["QRK-61"]);
    assert.deepEqual(lookup("plan-QRK-7"), ["QRK-70"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BRIEF names every threshold it uses, each a thresholds key", () => {
  const brief = stop("BRIEF.md");
  const used = new Set(brief.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []);
  for (const key of ["PART_MAX_LINES", "TEST_SLICE_MAX_FUNCTIONS", "SMALL_WORK_BELOW_BUCKET", "BATCH_SHIP_BUCKET"]) {
    assert.ok(used.has(key), `BRIEF names ${key}`);
  }
  for (const key of used) assert.ok(key in DEFAULTS, `BRIEF names ${key}, which is not a thresholds.ts DEFAULTS key`);
});

test("BRIEF: small work joins an open unit or the batch; the batch has its branch, class line, Todo line, and ship events", () => {
  const small = section(stop("BRIEF.md"), "Small work");
  assert.match(small, /A change you size below `SMALL_WORK_BELOW_BUCKET` is \*\*small\*\*/);
  assert.match(small, /An open unit of this session has not reached its wave \(CLOSE step 2\), and the change would not raise that unit's class/);
  assert.match(small, /`chore\/batch-<first 8 characters of the session id>-<n>`, `n` from 1, one higher after each batch ships/);
  assert.match(small, /`class: R1 — batch rule, <date>`: this rule sets the class, so the class moment picks none/);
  assert.match(small, /and a session log is configured, add `- \[ \] \[<batch branch>\] batch: ship <batch branch> — <brief path>` to its Todo[^\n]*With none, nothing is written: [^\n]*`git branch --list 'chore\/batch-<session8>-\*'`/);
  assert.match(small, /reaches `BATCH_SHIP_BUCKET`[^\n]*\(2\) the session's last other open unit leaves CLOSE; \(3\) the operator says ship/);
  assert.match(small, /A change that would raise the batch to R2 ships alone/);
  assert.doesNotMatch(small, /^\d+\. /m, "a numbered list here would be read as BRIEF's steps");
});

test("BRIEF: parts pair deliverables by position, the model is picked per part, and a part over the size is cut", () => {
  const brief = stop("BRIEF.md");
  // Its examples hold `## Parts` and `## Test slices` headings, so the section runs to the file's end.
  const at = brief.indexOf("\n## Parts and test slices\n");
  assert.ok(at >= 0, "BRIEF has a `## Parts and test slices` section");
  const parts = brief.slice(at);
  assert.match(parts, /\*\*The prose list under `## Deliverables` and the yaml `deliverables:` array pair by position\*\*/);
  assert.match(parts, /each a `- ` bullet or a `1\. ` item, from 1/);
  assert.match(parts, /\*\*Every doc the diff must update \(a README, a rule file\) is in exactly one part's `files:`\*\*/);
  assert.match(parts, /`PART_MAX_LINES` is a planning number, never a gate/);
  assert.match(step(brief, 2), /\*\*an `amend brief:` adds a deliverable only at the end of both lists\*\*/);
  assert.match(step(brief, 1), /\*\*The check applies per part\*\*/);
  assert.match(step(brief, 1), /`build: model=session \| agent=none \| sha=<head after your edits>`, with no `parts=`/);
  assert.match(step(brief, 3), /Size check: a part over `PART_MAX_LINES` is cut, or the brief says why it cannot be/);
  assert.doesNotMatch(brief, /Scope check \(one PR's worth\)/);
  assert.match(step(brief, 4), /`opus — P2 \(design choice\); P1, P3 sonnet`/);
  assert.match(step(brief, 7), /A part is `opus` when any of these holds: a `## Design` entry names one of the part's own files or deliverables/);
  assert.match(step(brief, 6), /in the run's own tree[^\n]*\(CLOSE §Trees\)/);
});

test("trial QRK-470: the manifest parse keys on its line, one class form, one ticket comment, BRIEF's files", () => {
  const brief = stop("BRIEF.md");
  assert.match(step(brief, 3), /read its `brief manifest block` line, never its exit code/);
  assert.match(step(brief, 3), /`brief manifest block — parses against manifestSchema` passes; any other text on that line is a rewrite/);
  assert.doesNotMatch(brief, /a non-parsing block is a rewrite here/);
  assert.match(step(brief, 2), /its step-3 run fails the header and step 6's run is the first that must pass it/);
  assert.match(step(brief, 2), /`<who>` is `agent \(unconfirmed\)`, or `operator` once the operator has vetoed the class/);
  assert.match(step(brief, 4), /pin `class: R<n> — agent \(unconfirmed\), <date>`/);
  assert.doesNotMatch(read("skills/build"), /class: R<n> \(agent, unconfirmed\)/);
  assert.match(step(brief, 2), /put the corrections in the ticket's one work-start comment \(SKILL §Tickets\), never a comment of their own/);
  assert.match(section(stop("SKILL.md"), "Tickets"), /ONE comment at work start, posted once BRIEF step 2 has checked the ticket's claims — [^\n]*and the corrections that check found/);
  assert.match(step(brief, 5), /`<run-dir>\/prior-art\.txt`\. A dispatch file you write for it or for a builder goes in `<inputs-dir>`/);
  assert.match(step(brief, 5), /\/build spawns no `simplifier` at BRIEF/);
  assert.match(step(brief, 2), /\*\*A stamped plan is not swept again\.\*\*[^\n]*names every new artifact this brief adds, copy the section verbatim, stamp included, and spawn nothing/);
  assert.match(body("prior-art"), /^## Stamp$/m);
});

test("trial QRK-470: exit checks accept a SESSION-named coverage gap and re-runs; the wave's beats have an order; no fixer edits a shipped migration", () => {
  const ten = step(stop("BUILD.md"), 10);
  assert.match(ten, /except the red tests `session\.md` names and a coverage gap a `SESSION` block names\*\*/);
  // a fix of a red check re-runs that check and the tests beside the fix, never the whole step.
  assert.match(ten, /After each fix of a red check, re-run only the check that failed and the tests beside the files the fix changed, as often as it takes; the last run of each counts/);
  assert.doesNotMatch(ten, /Re-run it after each fix of a red check/);
  assert.match(ten, /When the `<tests>` step's command is already one of the `<exit_checks>` step's commands, the `<tests>` step is not run again: the `<exit_checks>` run is its run\./);
  assert.match(stop("CLOSE.md"), /The Claude beats take the readers in this order: the class readers first, then `build-verifier`, the `simplifier`, and the repo readers\./);
  assert.match(stop("CLOSE.md"), /the two pools are counted apart, so every Codex run starts in the first beat/);
  assert.match(body("fixer"), /\*\*Never edit a migration already on `main`\*\*[^\n]*a schema fix is a new migration\. A comment-only edit to a migration this branch added is allowed\./);
  assert.match(body("builder"), /\*\*Never edit a migration already on `main`\*\*[^\n]*a schema change is a new migration\./);
});

test("a test that is not yet binding re-runs as its one entry, at most three tries", () => {
  const author = body("test-author");
  assert.match(author, /Strengthen it and re-run that one entry \(a map holding only it\) until BINDING, at most three tries; still not binding after the third, it is the finding below\./);
  assert.match(author, /The `<n>\/<m> BINDING` line counts each entry by its last run: `<m>` is the map's entries, `<n>` those whose last run was BINDING\./);
  assert.doesNotMatch(author, /Strengthen it and re-run until BINDING\./);
});

test("the session writes the ledger through ledgerLine.ts, and CLOSE's example command writes the line it shows", () => {
  const close = stop("CLOSE.md");
  assert.match(close, /\*\*Never type a line into `ship\.md`: `ledgerLine\.ts` writes every one\.\*\*/);
  assert.match(close, /`--replace <move> …` rewrites it in place[^\n]*`--remove <move>` deletes the move's last line/);
  assert.match(close, /The first call is the `class` line: it creates the file and writes `flow: 2` under it/);
  // One instruction for who writes `flow: 2`: step 1's list names it only as the class call's work.
  assert.match(close, /Ledger, in this order: `class: [^`]+` \(its call writes `flow: 2` under it\); `brief: /);
  assert.doesNotMatch(close, /; `flow: 2`;/);
  assert.match(close, /A move that repeats \(the list above\) takes each new line under its last one: never `--replace` one to add to it\./);
  assert.match(stop("SHIP.md"), /goes through `ledgerLine\.ts`, never typed into `ship\.md`/);
  assert.match(stop("BRIEF.md"), /`ledgerLine\.ts --replace class …`/);
  const example = close.match(/`(wave: [^`]+)` is `… ship\.md ([^`]+)`/);
  assert.ok(example, "CLOSE shows one ledger line beside the command that writes it");
  const argv = [...example[2]!.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  const args = parseLineArgs(["--ledger", "ship.md", ...argv]);
  const line = composeLine(args.move, args.text, args.fields.map(([k, v]) => [k, v === "head" ? "aaaaaaa" : v] as const));
  assert.equal(line, example[1]!.replace("<head>", "aaaaaaa"));
  assert.deepEqual(parseLedger(`class: R1 — o, 2026-09-28\nflow: 2\n${line}\n`).waveReaders, ["review-cursory", "build-verifier"]);
});
