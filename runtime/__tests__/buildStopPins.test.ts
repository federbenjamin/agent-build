/**
 * Pins for SKILL.md, BUILD.md, SHIP.md, and the manifest after landing 2: parts and run trees in the
 * build stop, one drift group at SHIP, the batch's Todo line, the aliases gone, and the SKILL.md cap.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BRIEF_MODELS } from "../lib/brief.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const stop = (file: string) => readFileSync(join(ROOT, "skills/build", file), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "agents.json"), "utf8")) as {
  agents: { name: string; description: string }[];
};

/** Numbered step `n` of a text: from its `n. ` line to the next numbered step or heading. */
function step(text: string, n: number): string {
  const m = text.match(new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |^## |(?![\\s\\S]))`, "m"));
  assert.ok(m, `no step ${n}.`);
  return m[0];
}

test("SKILL.md stays within the skills installer's 12,000-byte cap", () => {
  // A skills installer refuses a SKILL.md over max_chars=12000, counted by `wc -c`.
  assert.ok(Buffer.byteLength(stop("SKILL.md"), "utf8") <= 12000, "SKILL.md is over 12,000 bytes");
});

test("the big-boy and little-man aliases are gone, and their live links are retired", () => {
  const names = new Set(MANIFEST.agents.map((a) => a.name));
  for (const alias of ["big-boy", "little-man"]) {
    assert.ok(!names.has(alias), `agents.json still declares ${alias}`);
    assert.ok(!existsSync(join(ROOT, "agents", `${alias}.md`)), `agents/${alias}.md still exists`);
    // Retiring their live links is the harness manifest's `retiredLivePaths`, so that check lives there.
  }
  for (const file of ["SKILL.md", "BUILD.md", "SHIP.md"]) {
    assert.doesNotMatch(stop(file), /\b(?:big-boy|little-man)\b/, `${file} names an alias agent`);
  }
  // The spoken aliases are gone too: the skill names models by their own names.
  assert.doesNotMatch(stop("SKILL.md"), /big[ ]boy|little[ ]man/i);
});

test("SKILL: one builder per part, no unit too big for one PR, run trees, small work to BRIEF", () => {
  const skill = stop("SKILL.md");
  assert.match(skill, /BUILD \(one builder per part, plus the test writers, each in its own worktree\)/);
  assert.match(skill, /No unit is too big for one PR: the brief cuts it into parts \(BRIEF §Parts and test slices\)\./);
  assert.doesNotMatch(skill, /PLAN bug/);
  assert.match(skill, /Each open run has its own tree, so two runs' CLOSE may overlap \(CLOSE §Trees\); SHIP stays in merge order/);
  assert.doesNotMatch(skill, /session tree|session worktree/, "SKILL names the old single session tree");
  assert.doesNotMatch(skill, /quick\/<program>-fixes/);
  assert.match(skill, /BRIEF §Small work/);
  for (const name of ["PART_MAX_LINES", "TEST_SLICE_MAX_FUNCTIONS", "SMALL_WORK_BELOW_BUCKET", "BATCH_SHIP_BUCKET"]) {
    assert.ok(step(skill, 2).includes(`\`${name}\``), `SKILL Setup 2 lists ${name}`);
  }
});

test("BUILD: a builder per part, its dispatch and watch list, DB slices as Claude spawns (branch K)", () => {
  const build = stop("BUILD.md");
  const eight = step(build, 8);
  for (const line of [
    "part: P<k> — <its head text>",
    "start commit: <the run tree's HEAD",
    "part files: <inputs-dir>/files-P<k>.txt",
    "not yours: every other part's files, and the files the notes list as rebuilt once",
  ]) {
    assert.ok(eight.includes(line), `BUILD step 8's dispatch names \`${line}\``);
  }
  assert.match(eight, /briefCheck\.ts <brief> --files <P<k>\|W<k>> > <inputs-dir>\/files-<id>\.txt/);
  assert.match(eight, /briefCheck\.ts <brief> --slice W<k> > <inputs-dir>\/slice-W<k>\.txt/);
  assert.match(eight, /agent-watchdog\.sh [^\n]*--part-files <\.output path>=<inputs-dir>\/files-<id>\.txt/);
  // agent-watchdog.sh matches a --part-files key to a positional path as typed, and refuses it without --flags.
  assert.match(eight, /its key the agent's `\.output` path exactly as typed among the paths/);
  assert.match(eight, /`--part-files` needs `--flags`/);
  assert.match(eight, /`FLAG <agent> off-part count=<n> limit=<m>`[^\n]*`--ack <agent>:off-part:<n>`/);
  assert.match(stop("SKILL.md"), /agent-watchdog\.sh --flags <each spawn's \.output path>… \[--part-files <\.output path>=<file>\]…/);
  assert.match(eight, /parts whose every `after:` part has merged, the part with the most parts waiting behind it first; then `db` writers; then `plain` writers/);
  assert.match(eight, /\*\*A `plain` slice runs on Codex/);
  assert.match(eight, /\*\*A `db` slice runs as a Claude spawn, in its own worktree\.\*\* Spawn `test-author`[^\n]*`isolation: "worktree"`/);
  assert.match(eight, /never the brief path/);
  const ten = step(build, 10);
  const merge = ten.indexOf("**Merge each part**");
  const rebuild = ten.indexOf("**After the last part merges,**");
  const transplant = ten.indexOf("**The transplant.**");
  assert.ok(merge >= 0 && rebuild > merge && transplant > rebuild, "BUILD step 10: parts, then the rebuild commit, then the transplant");
  assert.match(ten, /\*\*Verify: `db` slices one at a time, `plain` slices side by side\.\*\*/);
  assert.match(ten, /each `plain` verify gets its own tree cut at the integrated head/);
  assert.match(readFileSync(join(ROOT, "agents/test-author.md"), "utf8"),/`db` verify runs go one at a time, since they share the run's stack; `plain` ones run side by side\./);
  assert.match(ten, /git worktree remove --force` each `db` writer's tree/);
  assert.doesNotMatch(build, /Every writer runs on Codex/);
});

test("BUILD's parts= example follows the build line's grammar: <part>:<model>:<ids joined by + | none>", () => {
  const ledger = step(stop("BUILD.md"), 10).match(/`(parts=P1:[^`]+)`/);
  assert.ok(ledger, "BUILD step 10 carries a parts= example");
  const entries = ledger[1]!.slice("parts=".length).split(",");
  assert.ok(entries.length >= 2, "the example has more than one part");
  for (const entry of entries) {
    const m = entry.match(/^P[1-9]\d*:([a-z]+):(none|[^+:]+(?:\+[^+:]+)*)$/);
    assert.ok(m, `bad parts= entry ${entry}`);
    assert.ok((BRIEF_MODELS as readonly string[]).includes(m[1]!), `unknown model in ${entry}`);
    assert.equal(m[1] === "session", m[2] === "none", `session pairs with none and only with it: ${entry}`);
  }
});

test("SHIP: the run tree, one drift group then drift-merge, the batch's Todo flipped before the prune", () => {
  const ship = stop("SHIP.md");
  assert.match(ship, /\*\*Run the gate from the run tree's top folder\*\*/);
  const one = step(ship, 1);
  assert.match(one, /A run has at most one drift group\./);
  assert.match(one, /write `drift-merge: \| from=<head before the merge> \| sha=<head after the merge>`/);
  assert.doesNotMatch(one, /again each time main moves/);
  const five = step(ship, 5);
  const flip = five.indexOf("**The batch branch**");
  const prune = five.indexOf("Prune the session log");
  assert.ok(flip >= 0 && prune > flip, "SHIP step 5 flips the batch's Todo line before the prune");
  assert.match(five, /flip its session-log Todo line \(`- \[ \] \[<batch branch>\] batch: ship …`\) to `\[x\]`/);
  assert.match(five, /every part's worktree and every fixer's worktree/);
  assert.match(five, /\*\*The run tree\*\*, when it is not the launch tree: `EnterWorktree`/);
});

test("the test-author manifest description states the U21 verdict's branch K", () => {
  const entry = MANIFEST.agents.find((a) => a.name === "test-author");
  assert.ok(entry, "test-author is a manifest agent");
  assert.match(entry.description, /A database slice runs as a Claude spawn in its own worktree; every other slice runs on Codex/);
  assert.doesNotMatch(entry.description, /\. Runs on Codex\.$/);
});
