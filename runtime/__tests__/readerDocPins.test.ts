/**
 * Doc pins for the reader agents: the finding block and the stage file their prompts teach must be
 * the ones the run-file parsers accept, and the tier grammar the kinds replaced must not come back.
 * A reader copies its prompt's example; an example the parser refuses makes every run refuse it.
 * The last block pins the agent-file rules build-flow-v2 landing 2 changed: the Skill tool's
 * removal, the isolated simplifier, and the builder's and fixer's lookup, lane, and stack rules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { KINDS, parseFindingBlock, parseStageFile, READER_ID_PREFIX, STAGES, stageIdRange } from "../lib/runFiles.ts";

const AGENTS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "agents");
const read = (agent: string) => readFileSync(join(AGENTS, `${agent}.md`), "utf8");

/** The reader files this pin owns. */
const READER_FILES = [
  "review-cursory",
  "gate-silent-failure-hunter",
  "security-review",
  "simplifier",
  "gate-warden",
  "prior-art",
  "test-author",
  "build-verifier",
] as const;

const BLOCK_TAGS = ["finding-block", "stage-file"] as const;
type BlockTag = (typeof BLOCK_TAGS)[number];

/** Every fenced block tagged `finding-block` or `stage-file`: three or more backticks, then the tag. */
function taggedBlocks(text: string): { tag: BlockTag; body: string }[] {
  const re = /^(`{3,})(finding-block|stage-file)[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;
  return [...text.matchAll(re)].map((m) => ({ tag: m[2] as BlockTag, body: m[3]! }));
}

test("every finding-block and stage-file example in review-cursory.md parses", () => {
  const counts: Record<BlockTag, number> = { "finding-block": 0, "stage-file": 0 };
  for (const { tag, body } of taggedBlocks(read("review-cursory"))) {
    counts[tag]++;
    if (tag === "finding-block") {
      // The example is a wave block, so its ids must sit in the wave's range too.
      const found = parseFindingBlock(body, { stage: "wave" });
      assert.ok(found.length >= 1, "a ```finding-block example must hold at least one block");
    } else {
      // Stage-file examples are written at confirm-1, the first read after a fix.
      const file = parseStageFile(body, { stage: "confirm-1" });
      assert.ok(file.status.length >= 1, "a ```stage-file example must answer at least one row");
      assert.ok(file.findings.length >= 1, "a ```stage-file example must show one `## New` block");
    }
    assert.doesNotMatch(body, /^- fix:/m, "a reader writes `after:`, never `fix:`");
  }
  assert.ok(counts["finding-block"] >= 1, "review-cursory.md needs a ```finding-block example");
  assert.ok(counts["stage-file"] >= 1, "review-cursory.md needs a ```stage-file example");
});

test("no reader file keeps the tier grammar or any memory", () => {
  for (const agent of READER_FILES) {
    const text = read(agent);
    assert.doesNotMatch(text, /\btier:/, `${agent}.md still holds \`tier:\``);
    assert.doesNotMatch(text, /\brelevance:/, `${agent}.md still holds \`relevance:\``);
    assert.doesNotMatch(text, /^memory:/m, `${agent}.md keeps no memory: its lessons live in its definition`);
    // The tier words and the three graded fields the kinds replaced (U1). A bare `fires` stays
    // legal: it is also the size step's word for a reader that runs (simplifier.md).
    const tierWords = text.match(/\b(?:BLOCK|FIX|NOTE)\b|^- (?:surface|fires|ease):|`(?:surface|ease)`/gm) ?? [];
    assert.deepEqual(tierWords, [], `${agent}.md still grades in tiers: ${tierWords.join(", ")}`);
  }
});

/** The two-column markdown rows of a file: first cell, second cell. */
function tableRows(text: string): [string, string][] {
  return text
    .split("\n")
    .map((l) => l.match(/^\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/))
    .filter((m): m is RegExpMatchArray => m !== null && !/^-+$/.test(m[1]!))
    .map((m) => [m[1]!, m[2]!]);
}
const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

test("review-cursory's kinds table names every kind the parser takes, once", () => {
  const kinds = tableRows(read("review-cursory"))
    .map(([first]) => ticked(first))
    .filter((t) => t.length === 1 && (KINDS as readonly string[]).includes(t[0]!))
    .map((t) => t[0]!);
  assert.deepEqual([...kinds].sort(), [...KINDS].sort());
});

test("review-cursory's id-range table matches the parser's stage ranges", () => {
  const ranges = new Map<string, string>();
  for (const [first, second] of tableRows(read("review-cursory"))) {
    const t = ticked(first);
    if (t.length === 1 && (STAGES as readonly string[]).includes(t[0]!)) ranges.set(t[0]!, second);
  }
  for (const stage of STAGES) {
    const { min, max } = stageIdRange(stage);
    assert.equal(ranges.get(stage), `${min}–${max}`, `review-cursory.md gives stage ${stage} the range ${min}–${max}`);
  }
});

/** The text under `## <heading>`, up to the next `## ` heading. */
function section(text: string, heading: string): string | null {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

test("fix4 item 6: CLOSE's id-prefix table is READER_ID_PREFIX, and each reader's agent file names its own prefix", () => {
  const close = readFileSync(join(AGENTS, "..", "skills", "build", "CLOSE.md"), "utf8");
  const at = close.indexOf("**Id prefixes.**");
  assert.ok(at >= 0, "CLOSE §The readers has an **Id prefixes.** table");
  const lines = close.slice(at).split("\n");
  const first = lines.findIndex((l) => l.startsWith("|"));
  const end = lines.findIndex((l, i) => i > first && !l.startsWith("|"));
  const rows = tableRows(lines.slice(first, end).join("\n")).filter(([a]) => a !== "Reader");
  const global = Object.fromEntries(
    rows.filter(([a]) => ticked(a).length === 1 && ticked(a)[0]! in READER_ID_PREFIX).map(([a, b]) => [ticked(a)[0]!, ticked(b)[0]!])
  );
  assert.deepEqual(global, READER_ID_PREFIX, "every global reader, with the parser's prefix");
  assert.deepEqual(
    rows.filter(([a]) => !(ticked(a)[0]! in READER_ID_PREFIX)).map(([, b]) => ticked(b)[0] ?? b),
    ["its own — the notes name it", "SESSION", "HAND"]
  );
  // Each agent file names its own ids; review-cursory's Rubric names every global one, and CODEX.
  const own: Record<string, string> = {
    "gate-silent-failure-hunter": "HUNTER",
    "security-review": "SEC",
    "build-verifier": "VERIFIER",
    simplifier: "SIMP",
  };
  for (const [agent, prefix] of Object.entries(own)) {
    assert.equal(prefix, READER_ID_PREFIX[agent]);
    assert.ok(read(agent).includes(`ids \`${prefix}.<n>\``), `${agent}.md names its ids \`${prefix}.<n>\``);
  }
  const rubric = read("review-cursory");
  for (const prefix of ["CURSORY", "HUNTER", "SEC", "VERIFIER", "SIMP"]) assert.ok(rubric.includes(`\`${prefix}.1\``), `review-cursory.md §Rubric names ${prefix}`);
  assert.ok(rubric.includes("A paired Codex read of this role uses `CODEX.<n>`"));
});

test("dry-run 12: every CLOSE reader returns one line of an exact shape, and its findings live only in its file", () => {
  // CLOSE: the session reads each agent's one-line report, never a finding. A reader that returns
  // paragraphs puts findings where the table script never reads them.
  const shapes: Record<string, string> = {
    "review-cursory": "`review-cursory — <n> findings, file written`",
    "gate-silent-failure-hunter": "`gate-silent-failure-hunter — <n> findings, file written`",
    "security-review": "`security-review — <n> findings, file written`",
    simplifier: "`simplifier — <n> findings, file written`",
    "build-verifier": "`build-verifier — <n> findings, VERDICT: <CLEAN | INCOMPLETE — <check>>, file written`",
  };
  for (const [agent, shape] of Object.entries(shapes)) {
    const ret = section(read(agent), "Return");
    assert.ok(ret !== null, `${agent}.md has no \`## Return\` section`);
    assert.ok(ret.includes(`final message is one line, exactly ${shape}, and nothing else`), `${agent}.md §Return states the one line ${shape}`);
    assert.ok(ret.includes("Your findings live only in your file"), `${agent}.md §Return says findings live only in the file`);
  }
});

// ── Landing 2: the agent files L5 changed ─────────────────────────────────────────────────────

const frontmatterOf = (agent: string) => read(agent).match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
const bodyOf = (agent: string) => read(agent).replace(/^---\n[\s\S]*?\n---\n/, "");

/**
 * The agents that hold no Skill tool (U9): the readers, and the agents whose only Skill calls in
 * 21 days loaded `agent-memory`, which the memory-rules hook delivers on the first save.
 * `bulk-edit` is a harness agent, so its half of this pin lives in the harness.
 */
const SKILL_FREE = [
  "review-cursory",
  "gate-silent-failure-hunter",
  "security-review",
  "gate-warden",
  "simplifier",
  "test-author",
  "build-verifier",
] as const;

test("U9: no Skill tool, and no body that sends the agent to a skill", () => {
  for (const agent of SKILL_FREE) {
    const fm = frontmatterOf(agent);
    const tools = fm.split("\n").find((l) => l.startsWith("tools:")) ?? "";
    assert.ok(tools.length > 0, `${agent}.md declares a tools: line`);
    assert.doesNotMatch(tools, /\bSkill\b/, `${agent}.md tools: must not include Skill`);
    // `\s+`: the old text wrapped between the skill's name and the word "skill".
    assert.doesNotMatch(bodyOf(agent), /invoke the `[\w:-]+`\s+skill/,`${agent}.md sends the agent to a skill it cannot load`);
  }
});

test("U9: review-cursory carries no writing-style block", () => {
  const text = read("review-cursory");
  assert.doesNotMatch(text, /^## Writing style\s*$/m);
  assert.doesNotMatch(text, /ASD-STE100/);
});

test("U13: the simplifier's post-build pass reads its own tree at the dispatched start commit, installed first", () => {
  const readRoot = bodyOf("simplifier").match(/^\*\*Read root\.\*\*[^\n]*$/m)?.[0] ?? "";
  assert.match(readRoot, /spawns you with `isolation: "worktree"`/);
  assert.match(readRoot, /your read root is your own tree/);
  assert.match(readRoot, /`git rev-parse HEAD` must equal the `start commit:` your dispatch names/);
  assert.match(readRoot, /`git switch --detach <start commit>`/);
  assert.match(readRoot, /`node ~\/\.agent-build\/runtime\/steps\.ts \. --get install`[^\n]*before your first repo command/);
});

test("U24: lookup binds the builder and the fixer at every point in the run, LSP first", () => {
  for (const agent of ["builder", "fixer"]) {
    const text = read(agent);
    assert.match(text, /\*\*Lookup is how you answer, at every point in the run\*\*/, `${agent}.md keys lookup to the question`);
    assert.match(text, /"Who calls this\?" or "Where is this defined\?" — your first call is `LSP`/, `${agent}.md: LSP first`);
    assert.match(text, /they never replace it/, `${agent}.md: grep never replaces LSP`);
    assert.match(text, /"How or why does this area work\?" — your first call is the doc corpus the notes name/, `${agent}.md: the corpus first`);
    assert.match(text, /An answer reached another way first is redone the lookup way before you act on it\./, `${agent}.md: redo rule`);
    assert.doesNotMatch(text, /before the first edit|Before you change code, look it up/, `${agent}.md still keys lookup to a moment`);
  }
});

test("parts: the builder's dispatch names its part, and one lane rule holds the off-part, rebuilt-once, and public-surface STOPs", () => {
  const builder = bodyOf("builder");
  assert.match(builder, /\*\*Your dispatch\*\*[^\n]*`part: P<k> — <its head text>`[^\n]*`part files: <path>`[^\n]*`not yours:`/);
  const lane = builder.match(/^- \*\*Your lane — one rule\.\*\*[^\n]*$/m)?.[0] ?? "";
  assert.match(lane, /out-of-lane fixes:/);
  assert.match(lane, /may edit a file that no part lists/);
  assert.match(lane, /a file another part lists \(your dispatch's `not yours:`\)/);
  assert.match(lane, /a file the notes list as rebuilt once/);
  assert.match(lane, /`## Public surface` block, which is frozen/);
  assert.equal(builder.match(/## Public surface` block is frozen|`## Public surface` block, which is frozen/g)?.length, 1, "the frozen-surface rule is stated once");
  assert.match(section(builder, "Report") ?? "", /your part \(`P<k>`/);
});

test("U21 branch K: a db slice's writer is a Claude spawn on the run's stack, every other slice runs on Codex, and both write from the excerpt", () => {
  // The agent file's description is the short routing line (a084b01); the body carries branch K.
  const body = bodyOf("test-author");
  assert.doesNotMatch(body, /\*\*You run on Codex, not as a Claude spawn\*\*/);
  assert.match(body, /- \*\*A `plain` slice runs on Codex\*\*/);
  assert.match(body, /- \*\*A `db` slice runs as a Claude spawn in its own tree\*\* \(`isolation: "worktree"`[^\n]*the notes' copy rule[^\n]*Never start, stop, reset, or migrate the stack/);
  assert.match(body, /Write your slice's tests from the excerpt your dispatch carries/);
  assert.doesNotMatch(body, /tests from the brief|differs from the brief you were given/);
  assert.match(body, /its restore text is the function's definition copied byte for byte from the file that defines it, never retyped/);
});

test("parts and the stack: the fixer reads one handoff note per part and reaches the run's stack only by the copy rule", () => {
  const fixer = bodyOf("fixer");
  assert.match(fixer, /\*\*Your dispatch\*\*[^\n]*the handoff note paths, one per part, or `none`/);
  assert.match(fixer, /\*\*Your dispatch\*\*[^\n]*the run tree/);
  assert.doesNotMatch(fixer, /never boot a stack, point at another tree's/);
  assert.match(fixer, /your diff changes no schema file the notes name[^\n]*the notes' copy rule/);
  assert.match(fixer, /Never start, stop, reset, or migrate the stack/);
});
