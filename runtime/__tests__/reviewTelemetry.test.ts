/**
 * Acceptance fixtures for reviewTelemetry.ts — the flow-2 ingest and the report. Pins: one source
 * row per reader per stage with counts per kind; `survived` leaves out only findings whose row was
 * dropped with an `agree` (A.17); `session.md` is never a source (A.10); a stage folder is read with
 * the root's repo readers (A.8); the rounds, the open set, the leftovers, and the models on the run
 * row; the `meta.json` lookup and its notes; an old run dir refused with the `flow: 2` message; and a
 * report that prints old rows in a legacy section without throwing.
 *
 * The tables these tests ingest are built by the table script's own core (`buildRound` over
 * `gatherRound`), so the survival rule is checked against the owner's routing, not a hand copy.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { FLOW_CHANGED } from "../lib/ledger.ts";
import { type RoundId, serialiseTableJson } from "../lib/runFiles.ts";
import { buildRound } from "../lib/table.ts";
import { gatherRound } from "../lib/runDir.ts";
import { readLedger, readTable } from "../reviewTable.ts";
import {
  type AgentLookup,
  aggregate,
  aggregateByModel,
  collectRun,
  collectWaveDir,
  eachLine,
  EXTRA_SOURCES_FILE,
  formatReport,
  ingest,
  main,
  metaLookup,
  modelFamily,
  parseExtraSources,
  readExtraSources,
  reportRuns,
  type RunRow,
  type SrcRow,
  type TelemetryRow,
  transcriptModels,
} from "../reviewTelemetry.ts";
import { DEFAULTS } from "../thresholds.ts";

function withTmpDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function block(id: string, kind: string, locator: string, extra: Record<string, string> = {}): string {
  return [
    `### ${id} — a finding`,
    `- locator: ${locator}`,
    `- kind: ${kind}`,
    `- finding: something is wrong at ${locator}`,
    `- after: it is right`,
    ...Object.entries(extra).map(([k, v]) => `- ${k}: ${v}`),
    "",
  ].join("\n");
}

function stageFile(status: string[], news: string): string {
  return ["## Status", ...(status.length ? status : ["- none"]), "", "## New", news, ""].join("\n");
}

const LEDGER = [
  "class: R1 — operator, 2026-09-28 | measured-at=abc1234",
  "flow: 2",
  "steps: none",
  "build: model=opus | agent=abuild1 | sha=abc1234",
  "freshen: skipped | base=abc1234 | sha=abc1234",
  "wave: review-cursory, gate-silent-failure-hunter, build-verifier | repo: comment-reader | sha=abc1234",
  "fix-1: 2/4 | model=sonnet | agent=afix1 | from=abc1234 | sha=def5678",
  "confirm-1: review-cursory (codex failed: exit 2: out dir missing), gate-silent-failure-hunter | sha=def5678",
].join("\n");

/**
 * A run through round 2: four round-1 rows (CURSORY.1 with HUNTER.1 merged, CURSORY-2.1, HUNTER.2,
 * SESSION.1). The fixer fixes CURSORY.1 and SESSION.1 and drops CURSORY-2.1 and HUNTER.2. At
 * confirm-1 the Sonnet stand-in for Codex agrees with the CURSORY-2.1 drop and disagrees with the
 * HUNTER.2 drop, and raises CURSORY.101; a repo reader also writes a stage file.
 */
function writeRun(dir: string, ledger = LEDGER): void {
  writeFileSync(join(dir, "ship.md"), `${ledger}\n`);
  writeFileSync(join(dir, "review-cursory.md"), block("CURSORY.1", "behavior", "a.ts:10"));
  writeFileSync(join(dir, "review-cursory-2.md"), block("CURSORY-2.1", "structure", "b.ts:50"));
  writeFileSync(
    join(dir, "gate-silent-failure-hunter.md"),
    block("HUNTER.1", "behavior", "a.ts:11") + "\n" + block("HUNTER.2", "behavior", "c.ts:5")
  );
  writeFileSync(join(dir, "build-verifier.md"), "NO FINDINGS — every deliverable checked\n");
  writeFileSync(join(dir, "comment-reader.md"), "NO FINDINGS — no comment drift\n");
  writeFileSync(join(dir, "session.md"), block("SESSION.1", "behavior", "e.ts:1", { stage: "wave" }));
  writeFileSync(
    join(dir, "fix-1.txt"),
    [
      "CURSORY.1 · fixed · def5678 — the loop ends",
      "CURSORY-2.1 · dropped — b.ts:50 already delegates",
      "HUNTER.2 · dropped — c.ts:5 is unreachable",
      "SESSION.1 · fixed · def5678 — the queue scopes by user",
      "exit checks:",
      "vacuity: none — no invariant given",
      "mutation: none — no test added",
      "branches: none — no branch added",
      "shared function: none",
      "",
    ].join("\n")
  );
  const stage = join(dir, "stage-confirm-1");
  mkdirSync(stage);
  writeFileSync(
    join(stage, "review-cursory.md"),
    stageFile(
      [
        "- CURSORY.1 · resolved",
        "- CURSORY-2.1 · agree",
        "- HUNTER.2 · disagree — c.ts:5 runs on every retry",
        "- SESSION.1 · resolved",
      ],
      block("CURSORY.101", "behavior", "d.ts:3")
    )
  );
  writeFileSync(
    join(stage, "gate-silent-failure-hunter.md"),
    stageFile(["- CURSORY.1 · resolved", "- HUNTER.2 · disagree — the catch still swallows it"], "NO FINDINGS — nothing new")
  );
  writeFileSync(join(stage, "comment-reader.md"), stageFile([], block("COMMENT.101", "text", "f.ts:2")));
  writeFileSync(join(stage, "review-cursory-codex.refused.txt"), "codex wrote nothing usable\n");
}

/** `table.json` for `rounds`, built by the table script's own core. */
function buildTable(dir: string, rounds: RoundId[]): void {
  const ledger = readLedger(dir);
  let table = readTable(dir);
  for (const round of rounds) {
    table = buildRound({
      round,
      head: "def5678",
      table,
      isTarget: () => false,
      merge: { near: 3, exactAbove: 30 },
      ...gatherRound(dir, round, ledger, table),
    }).table;
  }
  writeFileSync(join(dir, "table.json"), serialiseTableJson(table));
}

const META = { runId: "run-1", pipeline: "build" as const, ref: "main", cls: "R1" as const, ts: "2026-09-28T00:00:00Z" };

const KNOWN: AgentLookup = (id) =>
  ({
    abuild1: { agentType: "builder", model: "opus", models: ["claude-opus-5-5"] },
    afix1: { agentType: "fixer", model: "sonnet", models: ["claude-sonnet-5-5"] },
  })[id] ?? null;

function src(srcs: SrcRow[], source: string, stage: string | null): SrcRow {
  const row = srcs.find((s) => s.source === source && s.stage === stage);
  assert.ok(row, `no src row for ${source} at ${stage}`);
  return row;
}

async function ingestRun(lookup: AgentLookup = KNOWN) {
  return withTmpDir("tele-run-", (dir) => {
    writeRun(dir);
    buildTable(dir, ["1", "2"]);
    return ingest(dir, META, join(dir, "log.jsonl"), lookup);
  });
}

// ── Survival ────────────────────────────────────────────────────────────────────────────────

test("survived: a finding the fixer dropped and the stage reader agreed with is not survived", async () => {
  const { srcs } = await ingestRun();
  const cursory = src(srcs, "review-cursory", "wave");
  assert.equal(cursory.emitted, 2);
  assert.equal(cursory.survived, 1, "CURSORY-2.1 was dropped with an agree");
});

test("survived: a finding whose drop the stage reader disagreed with survives", async () => {
  const { srcs } = await ingestRun();
  const hunter = src(srcs, "gate-silent-failure-hunter", "wave");
  assert.equal(hunter.emitted, 2);
  assert.equal(hunter.survived, 2, "HUNTER.2's drop was disputed, so it came back as a row");
});

// ── Stages and sources ──────────────────────────────────────────────────────────────────────

test("a stage file counts under its stage, apart from the same reader's wave file", async () => {
  const { srcs } = await ingestRun();
  const atStage = src(srcs, "review-cursory", "confirm-1");
  assert.equal(atStage.emitted, 1);
  assert.equal(atStage.survived, 1);
  assert.deepEqual(atStage.kinds, { behavior: 1 });
  assert.deepEqual(src(srcs, "review-cursory", "wave").kinds, { behavior: 1, structure: 1 });
  assert.equal(src(srcs, "gate-silent-failure-hunter", "confirm-1").emitted, 0);
});

test("a stage folder reads the root ledger's repo readers; a renamed refused file is not a source", async () => {
  const { srcs } = await ingestRun();
  assert.deepEqual(src(srcs, "comment-reader", "confirm-1").kinds, { text: 1 });
  assert.equal(srcs.some((s) => s.source === "review-cursory-codex"), false);
});

test("session.md is never a source, at the wave or anywhere", async () => {
  const { run, srcs } = await ingestRun();
  assert.equal(srcs.some((s) => /session/i.test(s.source)), false);
  assert.equal(run.fired.some((s) => /session/i.test(s)), false);
});

test("collectWaveDir: a split read's slices count as one reader", async () => {
  await withTmpDir("tele-wave-", (dir) => {
    writeFileSync(join(dir, "review-cursory-1.md"), block("CURSORY.1", "behavior", "a.ts:1"));
    writeFileSync(join(dir, "review-cursory-2.md"), block("CURSORY-2.1", "text", "a.ts:90"));
    const c = collectWaveDir(dir);
    assert.deepEqual(c.readers.get("review-cursory")?.map((f) => f.id), ["CURSORY.1", "CURSORY-2.1"]);
  });
});

test("CURSORY.4: collectRun reads every drift group's folder into the drift stage", async () => {
  await withTmpDir("tele-drift-", (dir) => {
    writeFileSync(join(dir, "review-cursory.md"), "NO FINDINGS — clean\n");
    for (const [group, id] of [[1, "CURSORY.501"], [2, "CURSORY.502"]] as const) {
      mkdirSync(join(dir, `stage-drift-${group}`));
      writeFileSync(join(dir, `stage-drift-${group}`, "review-cursory.md"), stageFile([], block(id, "behavior", "a.ts:1")));
    }
    mkdirSync(join(dir, "stage-drift"));
    writeFileSync(join(dir, "stage-drift", "review-cursory.md"), stageFile([], block("CURSORY.503", "behavior", "a.ts:1")));
    const drift = collectRun(dir, []).filter((s) => s.stage === "drift");
    assert.equal(drift.length, 1);
    assert.deepEqual(drift[0]!.readers.get("review-cursory")?.map((f) => f.id), ["CURSORY.501", "CURSORY.502"], "a bare stage-drift/ is no group's");
  });
});

test("collectWaveDir: a file with no blocks and no NO FINDINGS line throws naming the file", async () => {
  await withTmpDir("tele-wave-", (dir) => {
    writeFileSync(join(dir, "simplifier.md"), "I found no findings worth reporting here.\n");
    assert.throws(() => collectWaveDir(dir), /reader file simplifier\.md: .*NO FINDINGS/);
  });
});

// ── The run row ─────────────────────────────────────────────────────────────────────────────

test("run row: schema 2, fired across stages, rounds from the fix file and the ledger", async () => {
  const { run } = await ingestRun();
  assert.equal(run.schema, 2);
  assert.deepEqual(run.fired, ["build-verifier", "comment-reader", "gate-silent-failure-hunter", "review-cursory"]);
  assert.deepEqual(run.notFired, []);
  assert.deepEqual(run.rounds, [
    { round: "1", rows: 4, fixed: 2, dropped: 2, relabelled: 0, decisions: 0, model: "sonnet", agentType: "fixer", modelIds: ["claude-sonnet-5-5"] },
    { round: "2", rows: 2, fixed: 0, dropped: 0, relabelled: 0, decisions: 0, model: null, agentType: null },
  ]);
  assert.deepEqual(run.build, { model: "opus", agentType: "builder", modelIds: ["claude-opus-5-5"] });
});

test("run row: openAtEnd per kind and the leftovers come from the final round", async () => {
  await withTmpDir("tele-final-", (dir) => {
    writeRun(dir);
    buildTable(dir, ["1", "2"]);
    const table = JSON.parse(readFileSync(join(dir, "table.json"), "utf8"));
    const empty = { head: "def5678", rows: [], leftovers: [], banked: [], closed: [], consumed: [], refused: [] };
    table.rounds["3"] = empty;
    table.rounds.escalate = empty;
    table.rounds.final = {
      ...empty,
      leftovers: [{ advice: { locator: "a.md:1", text: "stale" }, reason: "prose drift (advisory)" }],
      open: [
        { id: "HUNTER.2", kind: "behavior" },
        { id: "CURSORY.101", kind: "behavior" },
        { id: "SEC.1", kind: "security" },
      ],
    };
    writeFileSync(join(dir, "table.json"), JSON.stringify(table));
    const { run, notes } = ingest(dir, META, join(dir, "log.jsonl"), KNOWN);
    assert.deepEqual(run.openAtEnd, { behavior: 2, security: 1 });
    assert.equal(run.leftovers, 1);
    assert.equal(notes.some((n) => /no final round/.test(n)), false);
  });
});

test("the ledger's `codex failed: <why>` token with colons and spaces ingests", async () => {
  const { run } = await ingestRun();
  assert.ok(run.fired.includes("review-cursory"));
});

// ── meta.json ───────────────────────────────────────────────────────────────────────────────

test("a missing meta.json prints a note and the ingest goes on", async () => {
  await withTmpDir("tele-meta-", async (dir) => {
    writeRun(dir);
    buildTable(dir, ["1", "2"]);
    const out: string[] = [];
    let code = -1;
    await main(
      ["--ingest", dir, "--pipeline", "build", "--ref", "main", "--run-id", "m-1", "--class", "R1", "--file", join(dir, "log.jsonl")],
      { out: (l) => out.push(l), err: (l) => out.push(l), lookup: () => null },
      (c) => (code = c)
    );
    assert.equal(code, 0);
    assert.ok(out.includes("note: fix-1 agent afix1: no meta.json found — agent type and real model unknown"), out.join("\n"));
    assert.ok(out.some((l) => l.startsWith("note: build agent abuild1: no meta.json")));
    const run = JSON.parse(readFileSync(join(dir, "log.jsonl"), "utf8").split("\n")[0]!);
    assert.equal(run.rounds[0].agentType, null);
  });
});

test("a model mismatch between the ledger and meta.json prints a note, not a failure", async () => {
  const { notes } = await ingestRun(() => ({ agentType: "fixer", model: "opus" }));
  assert.deepEqual(notes.filter((n) => /ledger says/.test(n)), ["note: fix-1 agent afix1: the ledger says model=sonnet, the agent ran opus"]);
});

test("parts=: the run row records each part's brief model, agent type, and real model; a part that ran another model prints a note", async () => {
  await withTmpDir("tele-parts-", (dir) => {
    const ledger = LEDGER.replace(
      "build: model=opus | agent=abuild1 | sha=abc1234",
      "build: model=opus | agent=ap1,ap2 | parts=P1:sonnet:ap1,P2:opus:ap2,P3:session:none | sha=abc1234"
    );
    writeRun(dir, ledger);
    buildTable(dir, ["1", "2"]);
    const lookup: AgentLookup = (id) =>
      ({
        ap1: { agentType: "builder", model: "opus", models: ["claude-opus-5-5"] },
        ap2: { agentType: "builder", model: "opus", models: ["claude-opus-5-5", "claude-opus-4-8"] },
        afix1: { agentType: "fixer", model: "sonnet" },
      })[id] ?? null;
    const { run, notes } = ingest(dir, META, join(dir, "log.jsonl"), lookup);
    assert.deepEqual(run.build, {
      model: "opus",
      agentType: "builder",
      modelIds: ["claude-opus-5-5", "claude-opus-4-8"],
      parts: [
        { part: "P1", model: "sonnet", agentType: "builder", realModel: "opus", modelIds: ["claude-opus-5-5"] },
        { part: "P2", model: "opus", agentType: "builder", realModel: "opus", modelIds: ["claude-opus-5-5", "claude-opus-4-8"] },
        { part: "P3", model: "session", agentType: null, realModel: null },
      ],
    });
    assert.deepEqual(notes.filter((n) => /ledger says/.test(n)), ["note: build P1 agent ap1: the ledger says model=sonnet, the agent ran opus"]);
    assert.deepEqual(notes.filter((n) => /more than one model/.test(n)), [
      "note: build P2 agent ap2: ran more than one model — claude-opus-5-5, claude-opus-4-8",
    ]);
    assert.equal(run.rounds[0]!.modelIds?.length, 0, "a lookup that read no transcript records [] for a fixer that ran");
  });
});

test("parts=: a sonnet part that ran sonnet under an opus header prints no note", async () => {
  await withTmpDir("tele-parts-ok-", (dir) => {
    writeRun(dir, LEDGER.replace("agent=abuild1 | sha", "agent=ap1,ap2 | parts=P1:sonnet:ap1,P2:opus:ap2 | sha"));
    buildTable(dir, ["1", "2"]);
    const lookup: AgentLookup = (id) =>
      ({ ap1: { agentType: "builder", model: "sonnet" }, ap2: { agentType: "builder", model: "opus" }, afix1: { agentType: "fixer", model: "sonnet" } })[id] ?? null;
    const { notes } = ingest(dir, META, join(dir, "log.jsonl"), lookup);
    assert.deepEqual(notes.filter((n) => /ledger says/.test(n)), []);
  });
});

test("metaLookup: meta.json's model wins; with none, the transcript beside it names the model", async () => {
  await withTmpDir("tele-projects-", (projects) => {
    const sub = join(projects, "-Users-x-repo", "session-1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "fixer", model: "sonnet" }));
    writeFileSync(join(sub, "agent-a2.meta.json"), JSON.stringify({ agentType: "big-boy" }));
    // A plugin agent's meta.json carries the plugin prefix; the lookup names it bare.
    writeFileSync(join(sub, "agent-a4.meta.json"), JSON.stringify({ agentType: "agent-build:review-cursory", model: "sonnet" }));
    writeFileSync(
      join(sub, "agent-a2.jsonl"),
      `${JSON.stringify({ type: "user", message: { role: "user" } })}\n${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } })}\n`
    );
    const lookup = metaLookup(projects);
    assert.deepEqual(lookup("a1"), { agentType: "fixer", model: "sonnet", models: [] });
    assert.deepEqual(lookup("a2"), { agentType: "big-boy", model: "opus", models: ["claude-opus-5-5"] });
    assert.equal(lookup("a3"), null);
    assert.deepEqual(lookup("a4"), { agentType: "review-cursory", model: "sonnet", models: [] });
  });
  assert.equal(modelFamily("claude-sonnet-4-6"), "sonnet");
});

// ── Full model ids ──────────────────────────────────────────────────────────────────────────

const assistant = (model: string, pad = "") => JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text: pad }] } });

test("transcriptModels: every id in the whole transcript, first seen first; only assistant records count", async () => {
  await withTmpDir("tele-tr-", (dir) => {
    const path = join(dir, "agent.jsonl");
    // Past the old 256 KB head and across many 64 KB chunks: the second id sits near the end.
    const big = "x".repeat(300 * 1024);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "go", model: "claude-haiku-9" } }),
        assistant("claude-sonnet-5-5", big),
        JSON.stringify({ type: "assistant", message: { model: "<synthetic>" }, retry: { model: "claude-haiku-9" } }),
        assistant("claude-sonnet-5-5"),
        assistant("claude-sonnet-5", big),
        assistant("claude-sonnet-5-5"),
        '{"type":"assistant","message":{"model":"claude-torn',
      ].join("\n")
    );
    assert.deepEqual(transcriptModels(path), ["claude-sonnet-5-5", "claude-sonnet-5"]);
    assert.deepEqual(transcriptModels(join(dir, "missing.jsonl")), []);
  });
});

test("eachLine: a line and a multi-byte character cut by a chunk boundary come back whole", async () => {
  await withTmpDir("tele-lines-", (dir) => {
    const path = join(dir, "t.txt");
    const first = "a".repeat(64 * 1024 - 1) + "é" + "b".repeat(10); // é straddles the 64 KB boundary
    const lines = [first, "", "ünïcode", "last line with no newline"];
    writeFileSync(path, lines.join("\n"));
    const seen: string[] = [];
    eachLine(path, (l) => void seen.push(l));
    assert.deepEqual(seen, lines);
    const head: string[] = [];
    eachLine(path, (l) => (head.push(l), false));
    assert.equal(head.length, 1, "returning false stops the read");
  });
});

/** A subagent under `<projects>/<project>/<session>/subagents/`: its meta.json and a transcript whose
 *  first record is the prompt and whose assistant records carry `models`. */
function writeAgent(projects: string, id: string, agentType: string, prompt: unknown, models: string[], session = "session-1"): void {
  const sub = join(projects, "-Users-x-repo", session, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType, description: "a read" }));
  const first = JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: prompt } });
  // A record that is not the prompt, and a torn line, may come before it.
  const before = [JSON.stringify({ type: "summary", message: { content: String(prompt).replace(/\/build-1\//g, "/other/") } }), "{torn"];
  writeFileSync(join(sub, `agent-${id}.jsonl`), [...before, first, ...models.map((m) => assistant(m))].join("\n") + "\n");
}

test("readerAgents: the agent of the reader's type whose prompt names the reader file; a stage read is not the wave's", async () => {
  await withTmpDir("tele-readers-", (root) => {
    const projects = join(root, "projects");
    const run = join(root, "build-1");
    const wave = join(run, "gate-silent-failure-hunter.md");
    const stage = join(run, "stage-confirm-1", "gate-silent-failure-hunter.md");
    // The first mention is a longer name; the second is the file.
    writeAgent(projects, "w1", "gate-silent-failure-hunter", `Not ${wave}.bak.\n- Output: ${wave} — check it`, ["claude-opus-5-5"]);
    // The stage read's prompt names the run dir (`--run-dir`) and its own file, never the wave's.
    writeAgent(projects, "s1", "gate-silent-failure-hunter", `- Output: ${stage} — check it with --run-dir ${run}`, ["claude-sonnet-5-5", "claude-sonnet-5"]);
    // Another reader's type with the same path, and a prompt naming only longer file names.
    writeAgent(projects, "c1", "review-cursory", `- Output: ${wave}`, ["claude-sonnet-5"]);
    writeAgent(projects, "x1", "gate-silent-failure-hunter", `renamed ${wave}.refused.txt, and ${wave}_old`, ["claude-haiku-4-5"], "session-2");
    // A prompt given as content blocks, spelling the path from ~/ .
    const home = join(homedir(), "tele-fixture-not-real", "build-1", "simplifier.md");
    writeAgent(projects, "h1", "simplifier", [null, { type: "image" }, { type: "text", text:`Write ~/tele-fixture-not-real/build-1/simplifier.md.` }], ["claude-sonnet-5-5"]);
    // The ingest is given the run dir through a symlink; the prompt spells its real path.
    mkdirSync(join(root, "real", "build-1"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const verifier = join(root, "link", "build-1", "build-verifier.md");
    writeFileSync(verifier, "NO FINDINGS\n");
    writeAgent(projects, "v1", "build-verifier", `- Output: ${realpathSync(join(root, "real"))}/build-1/build-verifier.md`, ["claude-opus-5-5"]);
    // Noise the index must pass over: a broken meta.json, one with no agentType, one with no
    // transcript, and a session with no subagents dir.
    const sub = join(projects, "-Users-x-repo", "session-3", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-bad.meta.json"), "{");
    writeFileSync(join(sub, "agent-null.meta.json"), "null");
    writeFileSync(join(sub, "agent-untyped.meta.json"), JSON.stringify({ description: "x" }));
    writeFileSync(join(sub, "agent-bare.meta.json"), JSON.stringify({ agentType: "build-verifier" }));
    mkdirSync(join(projects, "-Users-x-repo", "session-4"));
    const lookup = metaLookup(projects);
    assert.deepEqual(lookup.readerAgents!("gate-silent-failure-hunter", wave), [{ id: "w1", models: ["claude-opus-5-5"] }]);
    assert.deepEqual(lookup.readerAgents!("gate-silent-failure-hunter", stage), [{ id: "s1", models: ["claude-sonnet-5-5", "claude-sonnet-5"] }]);
    assert.deepEqual(lookup.readerAgents!("simplifier", home), [{ id: "h1", models: ["claude-sonnet-5-5"] }]);
    assert.deepEqual(lookup.readerAgents!("build-verifier", verifier), [{ id: "v1", models: ["claude-opus-5-5"] }]);
    assert.deepEqual(lookup.readerAgents!("security-review", join(run, "security-review.md")), []);
  });
});

test("readerAgents: a path under ~/ is found when HOME is spelled with a doubled slash", async () => {
  await withTmpDir("tele-home-", (root) => {
    const projects = join(root, "projects");
    const file = join(homedir(), "tele-fixture-not-real", "build-2", "simplifier.md");
    writeAgent(projects, "h2", "simplifier", "Write ~/tele-fixture-not-real/build-2/simplifier.md.", ["claude-sonnet-5-5"]);
    const was = process.env.HOME;
    process.env.HOME = `${dirname(homedir())}//${basename(homedir())}`;
    try {
      assert.deepEqual(metaLookup(projects).readerAgents!("simplifier", file), [{ id: "h2", models: ["claude-sonnet-5-5"] }]);
    } finally {
      if (was === undefined) delete process.env.HOME;
      else process.env.HOME = was;
    }
  });
});

test("ingest over metaLookup: each wave and stage reader row records its agents' full ids; switches and misses print notes", async () => {
  await withTmpDir("tele-ids-", (root) => {
    const dir = join(root, "run");
    const projects = join(root, "projects");
    mkdirSync(dir);
    writeRun(dir);
    buildTable(dir, ["1", "2"]);
    // A Codex read has no Claude transcript: no field, no note.
    writeFileSync(join(dir, "review-cursory-codex.md"), "NO FINDINGS — clean\n");
    const at = (f: string) => `- Output: ${join(dir, f)} — check it`;
    writeAgent(projects, "cur1", "review-cursory", at("review-cursory.md"), ["claude-sonnet-5-5"]);
    writeAgent(projects, "cur2", "review-cursory", at("review-cursory-2.md"), ["claude-sonnet-5"]);
    writeAgent(projects, "hw", "gate-silent-failure-hunter", at("gate-silent-failure-hunter.md"), ["claude-opus-5-5"]);
    writeAgent(projects, "hs", "gate-silent-failure-hunter", `${at("stage-confirm-1/gate-silent-failure-hunter.md")} --run-dir ${dir}`, [
      "claude-sonnet-5-5",
      "claude-sonnet-5",
    ]);
    writeAgent(projects, "cs", "review-cursory", at("stage-confirm-1/review-cursory.md"), ["claude-sonnet-5-5"]);
    writeAgent(projects, "cr", "comment-reader", at("comment-reader.md"), ["claude-haiku-4-5"]);
    writeAgent(projects, "crs", "comment-reader", at("stage-confirm-1/comment-reader.md"), ["claude-haiku-4-5"]);
    writeFileSync(join(dir, EXTRA_SOURCES_FILE), JSON.stringify({ "prior-art": { emitted: 1, survived: 1 } }));
    const { srcs, notes } = ingest(dir, META, join(dir, "log.jsonl"), metaLookup(projects));
    const ids = (source: string, stage: string | null) => src(srcs, source, stage).modelIds;
    assert.deepEqual(ids("review-cursory", "wave"), ["claude-sonnet-5", "claude-sonnet-5-5"], "a split read's slices, in file-name order");
    assert.deepEqual(ids("gate-silent-failure-hunter", "wave"), ["claude-opus-5-5"]);
    assert.deepEqual(ids("gate-silent-failure-hunter", "confirm-1"), ["claude-sonnet-5-5", "claude-sonnet-5"]);
    assert.deepEqual(ids("review-cursory", "confirm-1"), ["claude-sonnet-5-5"]);
    assert.deepEqual(ids("comment-reader", "confirm-1"), ["claude-haiku-4-5"]);
    assert.deepEqual(ids("build-verifier", "wave"), [], "no agent found records []");
    assert.equal("modelIds" in src(srcs, "review-cursory-codex", "wave"), false);
    assert.equal("modelIds" in src(srcs, "prior-art", null), false);
    assert.deepEqual(notes.filter((n) => /^note: reader /.test(n)), [
      "note: reader build-verifier.md: no build-verifier agent's prompt names this file — its model is unknown",
      "note: reader stage-confirm-1/gate-silent-failure-hunter.md agent hs: ran more than one model — claude-sonnet-5-5, claude-sonnet-5",
    ]);
  });
});

test("a lookup with no readerAgents records no reader ids and prints no reader notes", async () => {
  const { srcs, notes } = await ingestRun();
  assert.ok(srcs.every((s) => !("modelIds" in s)));
  assert.equal(notes.some((n) => /^note: reader /.test(n)), false);
});

test("a fixer that ran more than one model prints a note naming the ids in order", async () => {
  const { notes } = await ingestRun((id) =>
    id === "afix1" ? { agentType: "fixer", model: "sonnet", models: ["claude-sonnet-5-5", "claude-sonnet-5"] } : null
  );
  assert.ok(notes.includes("note: fix-1 agent afix1: ran more than one model — claude-sonnet-5-5, claude-sonnet-5"), notes.join("\n"));
});

// ── Old flow ────────────────────────────────────────────────────────────────────────────────

test("an old run dir (round.json, no table.json) exits 1 with the flow: 2 message", async () => {
  await withTmpDir("tele-old-", async (dir) => {
    // A flow-2 ledger, so only the round.json rule can refuse it.
    writeFileSync(join(dir, "ship.md"), `${LEDGER}\n`);
    writeFileSync(join(dir, "review-cursory.md"), "NO FINDINGS\n");
    writeFileSync(join(dir, "round.json"), "{}");
    const err: string[] = [];
    let code = -1;
    await main(
      ["--ingest", dir, "--pipeline", "build", "--ref", "main", "--run-id", "o-1", "--class", "R1", "--file", join(dir, "log.jsonl")],
      { out: () => {}, err: (l) => err.push(l) },
      (c) => (code = c)
    );
    assert.equal(code, 1);
    assert.deepEqual(err, [`reviewTelemetry: ${FLOW_CHANGED}`]);
  });
});

test("an old ledger beside a table.json also exits 1 with the flow: 2 message", async () => {
  await withTmpDir("tele-old-", async (dir) => {
    writeFileSync(join(dir, "ship.md"), "class: R1 — operator, 2026-09-20\nwave: review-cursory | sha=abc1234\n");
    writeFileSync(join(dir, "table.json"), JSON.stringify({ schema: 2, rounds: {} }));
    let code = -1;
    const err: string[] = [];
    await main(["--ingest", dir, "--pipeline", "build", "--ref", "m", "--run-id", "o-2", "--class", "R1"], { out: () => {}, err: (l) => err.push(l) }, (c) => (code = c));
    assert.equal(code, 1);
    assert.match(err.join("\n"), /the build flow changed/);
  });
});

// ── Extra sources ───────────────────────────────────────────────────────────────────────────

test("extra sources: parsed and validated, and each is a source row with no stage", async () => {
  assert.equal(parseExtraSources({ "prior-art": { emitted: 3, survived: 2 } }, EXTRA_SOURCES_FILE).get("prior-art")?.survived, 2);
  assert.throws(() => parseExtraSources({ "prove-claims": { emitted: 1, survived: 1 } }, "x"), /is not one of/);
  assert.throws(() => parseExtraSources({ "prior-art": { emitted: 1, survived: 2 } }, "x"), /exceeds emitted/);
  await withTmpDir("tele-extra-", (dir) => {
    assert.equal(readExtraSources(dir).size, 0);
    writeRun(dir);
    buildTable(dir, ["1"]);
    writeFileSync(join(dir, EXTRA_SOURCES_FILE), JSON.stringify({ "test-author": { emitted: 1, survived: 1 } }));
    const { run, srcs } = ingest(dir, META, join(dir, "log.jsonl"), KNOWN);
    assert.deepEqual(src(srcs, "test-author", null), {
      kind: "src",
      schema: 2,
      runId: "run-1",
      source: "test-author",
      stage: null,
      type: "reader",
      emitted: 1,
      survived: 1,
      kinds: {},
    });
    assert.equal(run.fired.at(-1), "test-author");
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

async function cli(argv: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  let code = -1;
  await main(argv, { out: (l) => out.push(l), err: (l) => out.push(l), lookup: KNOWN }, (c) => (code = c));
  return { code, out };
}

test("CLI: the diff-review pipeline and R3 are refused with exit 2", async () => {
  const base = ["--ingest", "/nonexistent", "--ref", "main", "--run-id", "x"];
  const dr = await cli([...base, "--pipeline", "diff-review", "--class", "R1"]);
  assert.equal(dr.code, 2);
  assert.match(dr.out.join("\n"), /--pipeline must be one of build/);
  const r3 = await cli([...base, "--pipeline", "build", "--class", "R3"]);
  assert.equal(r3.code, 2);
  assert.match(r3.out.join("\n"), /--class must be one of R0, R1, R2/);
});

test("CLI: an ingest is idempotent by run id and writes schema-2 rows", async () => {
  await withTmpDir("tele-cli-", async (dir) => {
    writeRun(dir);
    buildTable(dir, ["1", "2"]);
    const log = join(dir, "log.jsonl");
    const argv = ["--ingest", dir, "--pipeline", "build", "--ref", "main", "--run-id", "e2e", "--class", "R1", "--file", log];
    assert.equal((await cli(argv)).code, 0);
    const again = await cli(argv);
    assert.equal(again.code, 0);
    assert.match(again.out.join("\n"), /already ingested/);
    const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.filter((r) => r.kind === "run").length, 1);
    assert.ok(rows.every((r) => r.schema === 2));
  });
});

// ── Report ──────────────────────────────────────────────────────────────────────────────────

function v2Src(runId: string, source: string, stage: SrcRow["stage"], survived: number): SrcRow {
  return { kind: "src", schema: 2, runId, source, stage, type: "reader", emitted: survived, survived, kinds: { behavior: survived } };
}

function v2Run(runId: string, ts = "2026-09-28T00:00:00Z"): RunRow {
  return {
    kind: "run",
    schema: 2,
    ts,
    runId,
    pipeline: "build",
    ref: "main",
    cls: "R2",
    fired: [],
    notFired: [],
    rounds: [{ round: "1", rows: 3, fixed: 2, dropped: 1, relabelled: 0, decisions: 0, model: "opus", agentType: "fixer" }],
    openAtEnd: {},
    leftovers: 2,
    build: { model: "opus", agentType: "builder" },
  };
}

test("report: an old row in the log does not break --report; it prints in a legacy section", () => {
  const rows = [
    { kind: "run", ts: "2026-07-08T00:00:00Z", runId: "lane", pipeline: "diff-review", fired: [], notFired: [] },
    { kind: "run", ts: "2026-09-20T00:00:00Z", runId: "old", pipeline: "build", cls: "R2", round: { applied: 3, unresolvedAfterRound: 1, regressionsAtConfirm: { count: 1, worst: "FIX" }, revertedTrivial: 0 } },
    { kind: "run", ts: "2026-09-21T00:00:00Z", runId: "odd", cls: "R1", round: { applied: 1 } },
    { kind: "src", runId: "old", source: "review-cursory", type: "reader", emitted: 4, survived: 4, tiers: { blocker: 1, high: 2, medium: 0, low: 1 } },
    { kind: "src", runId: "odd", source: "simplifier", type: "reader", emitted: 2 },
    { kind: "src", runId: "old", source: "backstop", type: "backstop", emitted: 9, survived: 9 },
    v2Run("new"),
    v2Src("new", "review-cursory-codex", "wave", 3),
    v2Src("new", "review-cursory-codex", "confirm-1", 1),
  ] as TelemetryRow[];
  const text = formatReport(rows);
  assert.match(text, /^reviewTelemetry: 1 run\(s\) \(1 R2\)/);
  assert.match(text, /review-cursory-codex\s+wave\s+1\s+3\s+3\s+3\.00\s+behavior 3/);
  assert.match(text, /review-cursory-codex\s+confirm-1\s+1\s+1\s+1/);
  assert.match(text, /new R2: build opus\/builder · 1: 3 rows, 2 fixed, 1 dropped, 0 relabelled, 0 decisions, opus\/fixer · open none · leftovers 2/);
  assert.match(text, /^legacy .*: 2 run\(s\) \(1 R1, 1 R2\)/m);
  assert.match(text, /review-cursory\s+1\s+4\s+4\s+4\.00\s+1\/2\/1/);
  assert.match(text, /simplifier\s+1\s+2\s+0\s+0\.00\s+0\/0\/0/);
  assert.match(text, /old R2: applied 3, unresolved 1, regressions 1 \(worst FIX\)/);
  assert.match(text, /odd R1: applied 1, unresolved 0, regressions 0, reverted-trivial 0/);
  assert.match(text, /runs with a BLOCK\/FIX regression at confirm: 1\/2/);
  assert.doesNotMatch(text, /backstop|lane/);
  assert.match(text, /review-cursory-codex\s+wave\s+1\s+3\s+3\s+3\.00\s+behavior 3\s+\?$/m, "a row with no modelIds reads as ?");
  assert.doesNotMatch(text, /by model/, "one model (?) per source: nothing to split");
});

test("report: full ids per source and per run; a source whose fires ran different models is split apart", () => {
  const withIds = (row: SrcRow, modelIds: string[]): SrcRow => ({ ...row, modelIds });
  const newer = v2Run("new");
  newer.rounds[0]!.modelIds = ["claude-opus-5-5", "claude-opus-4-8"];
  newer.build!.modelIds = ["claude-opus-5-5"];
  // Log order is first-seen order; `old`'s rows, written before modelIds, read as `?`.
  const rows: TelemetryRow[] = [
    newer,
    withIds(v2Src("new", "security-review", "wave", 1), ["claude-sonnet-5-5"]),
    withIds(v2Src("new", "review-cursory", "wave", 2), ["claude-sonnet-5-5", "claude-sonnet-5"]),
    withIds(v2Src("new", "build-verifier", "wave", 1), []),
    { ...v2Run("newer"), build: { model: "opus", agentType: "builder", modelIds: [] } },
    withIds(v2Src("newer", "security-review", "wave", 2), ["claude-sonnet-5-5"]),
    v2Src("newer", "review-cursory", "wave", 3),
    v2Run("old"),
    v2Src("old", "security-review", "wave", 4),
  ];
  const text = formatReport(rows);
  assert.match(text, /security-review\s+wave\s+3\s+7\s+7\s+2\.33\s+behavior 7\s+claude-sonnet-5-5 \(2\), \? \(1\)$/m);
  assert.match(text, /review-cursory\s+wave\s+2\s+5\s+5\s+2\.50\s+behavior 5\s+claude-sonnet-5-5\+claude-sonnet-5 \(1\), \? \(1\)$/m);
  assert.match(text, /build-verifier\s+wave\s+1\s+1\s+1\s+1\.00\s+behavior 1\s+\?$/m, "an empty modelIds reads as ?");
  // Grouped by source; within one, the models in the order first seen (not by per-fire or by name).
  const split = aggregateByModel(rows, reportRuns(rows)).map((s) => [s.source, s.stage, s.models[0]!.model, s.fires, s.survived]);
  assert.deepEqual(split, [
    ["review-cursory", "wave", "claude-sonnet-5-5+claude-sonnet-5", 1, 2],
    ["review-cursory", "wave", "?", 1, 3],
    ["security-review", "wave", "claude-sonnet-5-5", 2, 3],
    ["security-review", "wave", "?", 1, 4],
  ]);
  assert.match(text, /^by model .*\nsource\s+stage\s+model\s+fires.*\nreview-cursory\s+wave\s+claude-sonnet-5-5\+claude-sonnet-5\s+1\s+2\s+2\s+2\.00/m);
  assert.match(text, /new R2: build opus\/builder \(claude-opus-5-5\) · 1: 3 rows, .*, opus\/fixer \(claude-opus-5-5, claude-opus-4-8\) ·/);
  assert.match(text, /old R2: build opus\/builder · 1: 3 rows, .*, opus\/fixer · open none/, "a run row with no ids prints as before");
  assert.match(text, /newer R2: build opus\/builder · /, "an empty modelIds prints no brackets");
});

test("report: --since windows both sections; no runs at all says so", () => {
  const rows: TelemetryRow[] = [v2Run("a", "2026-09-01T00:00:00Z"), v2Run("b", "2026-09-28T00:00:00Z")];
  assert.deepEqual(reportRuns(rows, "2026-09-10").map((r) => r.runId), ["b"]);
  assert.equal(formatReport([], "2026-09-10"), "reviewTelemetry: no class-era runs ingested since 2026-09-10");
});

test("report: the floor judges each source at each stage on its own fires", () => {
  const rows: TelemetryRow[] = [];
  for (let i = 0; i < DEFAULTS.READER_FLOOR_MIN_FIRES; i++) {
    rows.push(v2Run(`r${i}`), v2Src(`r${i}`, "simplifier", "wave", 2), v2Src(`r${i}`, "simplifier", "confirm-1", 0));
  }
  const by = new Map(aggregate(rows, reportRuns(rows)).map((s) => [`${s.source} ${s.stage}`, s]));
  assert.equal(by.get("simplifier wave")!.belowFloor, false);
  assert.equal(by.get("simplifier confirm-1")!.belowFloor, true);
  assert.match(formatReport(rows), /simplifier ⚠ below floor\s+confirm-1/);
});
