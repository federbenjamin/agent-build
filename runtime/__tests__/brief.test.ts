/** brief: the `model:` line, `## Target files`, `## Hand test`, `## Parts`, `## Test slices`, the
 *  target matcher, and briefCheck's output, excerpt modes, `--at`, and exit codes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BriefPartError,
  matchesTarget,
  parseHandTestBlock,
  parseModelLine,
  parseParts,
  parseTargetFiles,
  parseTestSlices,
  PART_MODEL_RANK,
  strongestModel,
  summariseBrief,
  testRunnerOf,
} from "../lib/brief.ts";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";
import { TSX_BIN } from "./helpers/tsxBin.ts";

const SCRIPT = fileURLToPath(new URL("../briefCheck.ts", import.meta.url));

// Strip inherited GIT_* before anything spawns git (docs/rules/tests.md §Tests): an inherited
// GIT_DIR (a hook) would point the `--at` and `--base` repos at another repo.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

const HEADER = ["# quick-x — a sample", "", "class: R1 — operator, 2026-09-28", "model: sonnet — the brief names every file", ""];
const TARGETS = ["## Target files", "", "- apps/mobile/src/chat/send.ts", "- `packages/core/src/chat/**`", "- .claude/build/notes.md — the hand-tester section", ""];
const CLAIMS = [
  "## Hand test",
  "",
  "- H1 · a signed-in user who sends hi sees the reply stream in",
  "  - run: `pnpm app:invoke --function app-chat`",
  '  - pass: exit 0; the output holds "delta" before "done"',
  "  - needs: stack",
  "- H2 · the manifest's exercise passes",
  "  - run: pnpm check:manifest --brief-file docs/build/briefs/quick-x.md",
  "  - pass: exit 0; 0 FAIL",
  "  - needs: stack, sim",
  "",
];
const DELIVERABLES = ["## Deliverables", "", "```yaml", "deliverables:", "  - id: d1", "    model: not-a-header", "```", ""];

const brief = (parts: { header?: string[]; targets?: string[]; hand?: string[]; rest?: string[] } = {}) =>
  [...(parts.header ?? HEADER), ...(parts.targets ?? TARGETS), ...(parts.hand ?? CLAIMS), ...(parts.rest ?? DELIVERABLES)].join("\n");

/** Assert `fn` throws a BriefPartError for `part`, of `kind`, at `line` (null: no line), naming `detail`. */
function throwsPart(fn: () => unknown, part: string, kind: string, line: number | null, detail: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof BriefPartError, `expected a BriefPartError, got ${String(err)}`);
    assert.equal(err.part, part);
    assert.equal(err.kind, kind);
    assert.equal(err.line, line);
    assert.match(err.message, detail);
    return true;
  });
}

// ── model line ────────────────────────────────────────────────────────────────

test("the model line parses its model and why, and ignores a model: key inside a yaml fence", () => {
  assert.deepEqual(parseModelLine(brief()), { model: "sonnet", why: "the brief names every file", line: 4 });
  const bare = brief({ header: ["class: R2 — operator, 2026-09-28", "model: session", ""] });
  assert.deepEqual(parseModelLine(bare), { model: "session", why: null, line: 2 });
});

test("a brief with no model line in its header is refused as missing", () => {
  throwsPart(() => parseModelLine(brief({ header: ["class: R1 — operator, 2026-09-28", ""] })), "model", "missing", null, /no `model:/);
});

test("a model line naming another model, or with a hyphen for the dash, is refused by line", () => {
  throwsPart(() => parseModelLine(brief({ header: ["class: R1 — o, 2026-09-28", "model: haiku", ""] })), "model", "malformed", 2, /got: model: haiku/);
  throwsPart(() => parseModelLine(brief({ header: ["class: R1 — o, 2026-09-28", "model: opus - why", ""] })), "model", "malformed", 2, /expected/);
});

test("a model line not directly under the class line, or a second model line, is refused", () => {
  throwsPart(() => parseModelLine(brief({ header: ["class: R1 — o, 2026-09-28", "", "model: opus", ""] })), "model", "malformed", 3, /directly under the class line \(line 1\)/);
  throwsPart(() => parseModelLine(brief({ header: ["class: R1 — o, 2026-09-28", "model: opus", "model: sonnet", ""] })), "model", "malformed", 3, /second `model:`/);
});

// ── target files ──────────────────────────────────────────────────────────────

test("target files: entries parse, backticks and the why are stripped, blank lines pass", () => {
  assert.deepEqual(parseTargetFiles(brief()), ["apps/mobile/src/chat/send.ts", "packages/core/src/chat/**", ".claude/build/notes.md"]);
});

test("target files: a missing section, a non-entry line, and an empty section are each refused", () => {
  throwsPart(() => parseTargetFiles(brief({ targets: [] })), "target-files", "missing", null, /no `## Target files`/);
  throwsPart(
    () => parseTargetFiles(brief({ targets: ["## Target files", "", "- apps/x.ts (new)", ""] })),
    "target-files",
    "malformed",
    8,
    /got: - apps\/x\.ts \(new\)/
  );
  throwsPart(() => parseTargetFiles(brief({ targets: ["## Target files", "", ""] })), "target-files", "malformed", null, /lists no file/);
});

test("matchesTarget: **/ spans leading segments, * stays in one segment, a trailing / is a prefix", () => {
  assert.ok(matchesTarget("apps/mobile/src/auth.ts", "**/auth.ts"));
  assert.ok(matchesTarget("auth.ts", "**/auth.ts"));
  assert.ok(!matchesTarget("apps/mobile/src/oauth.ts", "**/auth.ts"));
  assert.ok(matchesTarget("apps/mobile/src/a.ts", "apps/mobile/src/*.ts"));
  assert.ok(!matchesTarget("apps/mobile/src/chat/a.ts", "apps/mobile/src/*.ts"));
  assert.ok(matchesTarget("packages/core/src/chat/x/y.ts", "packages/core/src/chat/"));
  assert.ok(!matchesTarget("packages/core/src/chatter.ts", "packages/core/src/chat/"));
  assert.ok(matchesTarget("packages/core/src/chat/x/y.ts", "packages/core/src/chat/**"));
  assert.ok(matchesTarget("apps/mobile/src/chat/send.ts", ["docs/x.md", "apps/mobile/src/chat/send.ts"]));
  assert.ok(!matchesTarget("apps/mobile/src/chat/send.tsx", "apps/mobile/src/chat/send.ts"));
  assert.ok(!matchesTarget("apps/mobileXsrc/a.ts", "apps/mobile.src/a.ts"), "a dot is literal");
});

// ── hand test ─────────────────────────────────────────────────────────────────

test("hand test: claims parse with run, pass, and needs; the run's backticks come off", () => {
  const { claims, none } = parseHandTestBlock(brief());
  assert.equal(none, null);
  assert.deepEqual(
    claims.map((c) => [c.id, c.run, c.needs]),
    [
      ["H1", "pnpm app:invoke --function app-chat", ["stack"]],
      ["H2", "pnpm check:manifest --brief-file docs/build/briefs/quick-x.md", ["stack", "sim"]],
    ]
  );
});

test("hand test: `none — <reason>` counts 0 claims", () => {
  const r = parseHandTestBlock(brief({ hand: ["## Hand test", "", "none — the diff changes only a doc", ""] }));
  assert.deepEqual(r, { claims: [], none: "the diff changes only a doc" });
});

test("hand test: a section heading inside a fence is never read as the section", () => {
  const text = brief({ hand: [], rest: ["## Deliverables", "", "````markdown", "## Hand test", "", "none — example", "````", ""] });
  throwsPart(() => parseHandTestBlock(text), "hand-test", "missing", null, /no `## Hand test`/);
});

test("hand test: none with claims, a claim without run or pass, and an empty section are refused", () => {
  const at = (lines: string[]) => brief({ hand: ["## Hand test", "", ...lines, ""] });
  // The section's first body line is line 14 in `brief()`: 5 header + 6 target lines + heading + blank.
  throwsPart(() => parseHandTestBlock(at(["none — doc only", "- H1 · x", "  - run: a", "  - pass: b"])), "hand-test", "malformed", 14, /`none —` and claims together/);
  throwsPart(() => parseHandTestBlock(at(["- H1 · x", "  - pass: b"])), "hand-test", "malformed", 14, /H1 has no `  - run:/);
  throwsPart(() => parseHandTestBlock(at(["- H1 · x", "  - run: a"])), "hand-test", "malformed", 14, /H1 has no `  - pass:/);
  throwsPart(() => parseHandTestBlock(at([])), "hand-test", "malformed", null, /no claim and no `none —/);
});

test("hand test: a repeated id, run, or needs line, a bad needs value, and a stray line are refused by line", () => {
  const at = (lines: string[]) => brief({ hand: ["## Hand test", "", ...lines, ""] });
  const ok = ["- H1 · x", "  - run: a", "  - pass: b"];
  throwsPart(() => parseHandTestBlock(at([...ok, "- H1 · y", "  - run: a", "  - pass: b"])), "hand-test", "malformed", 17, /H1 used twice/);
  throwsPart(() => parseHandTestBlock(at([...ok, "  - run: c"])), "hand-test", "malformed", 17, /second `run:`/);
  throwsPart(() => parseHandTestBlock(at([...ok, "  - needs: stack", "  - needs: sim"])), "hand-test", "malformed", 18, /second `needs:`/);
  throwsPart(() => parseHandTestBlock(at([...ok, "  - needs: stack, stack"])), "hand-test", "malformed", 17, /names `stack` twice/);
  throwsPart(() => parseHandTestBlock(at([...ok, "  - needs: db"])), "hand-test", "malformed", 17, /under H1, expected/);
  throwsPart(() => parseHandTestBlock(at(["a stray line"])), "hand-test", "malformed", 14, /expected `- H<k> ·/);
  throwsPart(() => parseHandTestBlock(at(["- H0 · x", "  - run: a", "  - pass: b"])), "hand-test", "malformed", 14, /expected `- H<k> ·/);
});

// ── the from-branch hand-test file ────────────────────────────────────────────

const FROM_BRANCH = ["class: R1 — operator, 2026-09-28", "", "## Hand test", "", "- H1 · the toggle shows", "  - run: maestro test a.yaml", "  - pass: COMPLETED", ""].join("\n");

test("the --from-branch file reads as its class and its claims only", () => {
  const s = summariseBrief(FROM_BRANCH);
  assert.equal(s.kind, "hand-test-block");
  assert.equal(s.cls, "R1");
  assert.deepEqual(s.claims.map((c) => c.id), ["H1"]);
});

test("a --from-branch file that does not open with a pinned class line is refused", () => {
  throwsPart(() => summariseBrief(FROM_BRANCH.split("\n").slice(2).join("\n")), "class", "missing", 1, /starts with the pinned class line/);
  throwsPart(() => summariseBrief(FROM_BRANCH.replace("class: R1 — operator, 2026-09-28", "class: R1")), "class", "missing", 1, /pinned/);
});

// ── parts and test slices ─────────────────────────────────────────────────────

const P_HEADER = ["# quick-y — a two-part sample", "", "class: R1 — operator, 2026-09-28", "model: opus — P2 is a design choice", ""];
const P_TARGETS = ["## Target files", "", "- src/a.ts", "- src/b.ts", "- src/docs/", "- src/lib/**", ""];
const P_HAND = ["## Hand test", "", "none — tooling only", ""];
const P_PARTS = [
  "## Parts",
  "",
  "- P1 · the first half",
  "  - model: sonnet — the brief names each file",
  "  - files: src/a.ts",
  "  - test files: tests/a.test.ts",
  "  - deliverables: 1, 2",
  "  - after: none",
  "  - tests: builder",
  "- P2 · the second half",
  "  - model: opus — a design choice",
  "  - files: src/b.ts, `src/docs/`",
  "  - test files: none",
  "  - deliverables: 3",
  "  - after: none",
  "  - tests: W1",
  "",
];
const P_SLICES = [
  "## Test slices",
  "",
  "- W1 · db · the second half's write contract",
  "  - files: tests/b.db.test.ts",
  "  - covers: 2",
  "  - under test: writeB, readB",
  "",
];
const P_DELIVERABLES = ["## Deliverables", "", "- one: a", "- two: b", "  - nested detail of two", "- three: c", ""];

const partsBrief = (edit: (text: string) => string = (t) => t) =>
  edit([...P_HEADER, ...P_TARGETS, ...P_HAND, ...P_PARTS, ...P_SLICES, ...P_DELIVERABLES].join("\n"));

/** Replace the `nth` line equal to `from` with `to` (no lines when `to` is empty). */
const swap = (from: string, to: string[], nth = 1) => (text: string) => {
  const lines = text.split("\n");
  let seen = 0;
  const at = lines.findIndex((l) => l === from && ++seen === nth);
  assert.ok(at >= 0, `the fixture holds ${JSON.stringify(from)} ${nth} time(s)`);
  lines.splice(at, 1, ...to);
  return lines.join("\n");
};
const chain = (...edits: ((t: string) => string)[]) => (t: string) => edits.reduce((acc, e) => e(acc), t);

/** 1-based line of the `nth` line equal to `s` in `text`. */
function lineOf(text: string, s: string, nth = 1): number {
  let seen = 0;
  const i = text.split("\n").findIndex((l) => l === s && ++seen === nth);
  assert.ok(i >= 0, `no line ${JSON.stringify(s)}`);
  return i + 1;
}

test("parts: a brief with no `## Parts` has one implicit P1 from the header model and the target files", () => {
  const parts = parseParts(brief());
  assert.deepEqual(parts, [
    {
      id: "P1",
      says: "the whole unit (no `## Parts` section)",
      model: "sonnet",
      why: "the brief names every file",
      files: ["apps/mobile/src/chat/send.ts", "packages/core/src/chat/**", ".claude/build/notes.md"],
      testFiles: [],
      deliverables: [],
      after: [],
      tests: "builder",
      line: 4,
    },
  ]);
  const s = summariseBrief(brief());
  assert.equal(s.partsDeclared, false);
  assert.deepEqual(s.parts, parts);
  assert.deepEqual(s.slices, []);
});

test("parts: a legacy brief with no ## Parts parses unchanged, with one implicit opus part over its targets", () => {
  const text = readFileSync(fileURLToPath(new URL("fixtures/legacy-brief.md", import.meta.url)), "utf8");
  const s = summariseBrief(text);
  assert.equal(s.model, "opus");
  assert.equal(s.targets!.length, 3);
  assert.deepEqual(s.claims.map((c) => c.id), ["H1", "H2"]);
  assert.equal(s.partsDeclared, false);
  assert.equal(s.parts.length, 1);
  assert.deepEqual([s.parts[0]!.id, s.parts[0]!.model, s.parts[0]!.files], ["P1", "opus", s.targets]);
});

test("parts: a declared block parses each field; slices parse with their lane, files, covers, and functions", () => {
  const s = summariseBrief(partsBrief());
  assert.equal(s.partsDeclared, true);
  assert.deepEqual(
    s.parts.map((p) => [p.id, p.model, p.why, p.files, p.testFiles, p.deliverables, p.after, p.tests]),
    [
      ["P1", "sonnet", "the brief names each file", ["src/a.ts"], ["tests/a.test.ts"], [1, 2], [], "builder"],
      ["P2", "opus", "a design choice", ["src/b.ts", "src/docs/"], [], [3], [], ["W1"]],
    ]
  );
  assert.deepEqual(s.slices, [
    { id: "W1", lane: "db", says: "the second half's write contract", files: ["tests/b.db.test.ts"], covers: [2], underTest: ["writeB", "readB"], line: lineOf(partsBrief(), "- W1 · db · the second half's write contract") },
  ]);
});

test("parts: a missing, repeated, empty, unknown, or malformed field is refused by line", () => {
  const t = partsBrief();
  const at = (edit: (t: string) => string, line: number, detail: RegExp) => throwsPart(() => parseParts(partsBrief(edit)), "parts", "malformed", line, detail);
  at(swap("  - after: none", [], 2), lineOf(t, "- P2 · the second half"), /P2 has no `  - after: …` line/);
  at(swap("  - after: none", ["  - after: none", "  - after: none"]), lineOf(t, "  - tests: builder"), /P1 has a second `after:` line/);
  at(swap("  - files: src/a.ts", ["  - files: "]), lineOf(t, "  - files: src/a.ts"), /P1's `files:` is empty/);
  at(swap("  - tests: builder", ["  - tests: builder", "  - owner: me"]), lineOf(t, "  - tests: builder") + 1, /under P1, expected one of/);
  at(swap("  - model: sonnet — the brief names each file", ["  - model: haiku"]), lineOf(t, "  - model: sonnet — the brief names each file"), /P1's `model:` expected/);
  at(swap("  - deliverables: 1, 2", ["  - deliverables: one"]), lineOf(t, "  - deliverables: 1, 2"), /P1's `deliverables:` expected/);
  at(swap("  - deliverables: 1, 2", ["  - deliverables: 1, 1, 2"]), lineOf(t, "  - deliverables: 1, 2"), /names 1 twice/);
  at(swap("  - after: none", ["  - after: 2"]), lineOf(t, "  - after: none"), /P1's `after:` expected/);
  at(swap("  - tests: builder", ["  - tests: writers"]), lineOf(t, "  - tests: builder"), /P1's `tests:` expected/);
  at(swap("  - files: src/a.ts", ["  - files: src/a.ts src/b.ts"]), lineOf(t, "  - files: src/a.ts"), /P1's `files:` expected/);
  at(swap("- P2 · the second half", ["- P1 · the second half"]), lineOf(t, "- P2 · the second half"), /P1 used twice/);
  at(swap("- P1 · the first half", ["a stray line"]), lineOf(t, "- P1 · the first half"), /expected `- P<k> ·/);
  at(swap("## Parts", ["## Parts", "", "```", "x", "```"]), lineOf(t, "## Parts") + 2, /a fenced block inside the section/);
});

test("parts: a section with no part, and a second `## Parts`, are refused", () => {
  const empty = partsBrief((t) => t.replace(P_PARTS.slice(2).join("\n"), ""));
  throwsPart(() => parseParts(empty), "parts", "malformed", lineOf(empty, "## Parts"), /lists no `- P<k> ·/);
  const twice = partsBrief(swap("## Test slices", ["## Parts", "", "## Test slices"]));
  throwsPart(() => parseParts(twice), "parts", "malformed", lineOf(twice, "## Parts", 2), /a second `## Parts` section/);
});

test("parts: a `files:` entry outside `## Target files` is refused; a glob-matched one and any `test files:` entry pass", () => {
  const t = partsBrief(swap("  - files: src/a.ts", ["  - files: src/a.ts, src/c.ts"]));
  throwsPart(() => parseParts(t), "parts", "malformed", lineOf(t, "  - files: src/a.ts, src/c.ts"), /names src\/c\.ts, which no `## Target files` entry/);
  const ok = parseParts(partsBrief(swap("  - files: src/a.ts", ["  - files: src/a.ts, src/lib/x.ts"])));
  assert.deepEqual(ok[0]!.files, ["src/a.ts", "src/lib/x.ts"]);
  assert.deepEqual(ok[0]!.testFiles, ["tests/a.test.ts"], "tests/ is in no target entry and still passes");
});

test("parts: side-by-side parts that share a file, a test file, a glob's file, or a glob prefix are refused", () => {
  const cases: [(t: string) => string, string, RegExp, number?][] = [
    [swap("  - files: src/b.ts, `src/docs/`", ["  - files: src/b.ts, src/a.ts"]), "  - files: src/b.ts, src/a.ts", /P1 and P2 run side by side .* share src\/a\.ts \(P1\) — src\/a\.ts \(P2\)/],
    [swap("  - test files: none", ["  - test files: tests/a.test.ts"]), "  - test files: tests/a.test.ts", /share tests\/a\.test\.ts \(P1\)/, 2],
    [
      chain(swap("  - files: src/a.ts", ["  - files: src/lib/x.ts"]), swap("  - files: src/b.ts, `src/docs/`", ["  - files: src/b.ts, src/lib/**"])),
      "  - files: src/b.ts, src/lib/**",
      /share src\/lib\/x\.ts \(P1\) — src\/lib\/\*\* \(P2\)/,
    ],
    [
      chain(swap("  - files: src/a.ts", ["  - files: src/lib/*.ts"]), swap("  - files: src/b.ts, `src/docs/`", ["  - files: src/b.ts, src/lib/sub/**"])),
      "  - files: src/b.ts, src/lib/sub/**",
      /share src\/lib\/\*\.ts \(P1\) — src\/lib\/sub\/\*\* \(P2\)/,
    ],
  ];
  for (const [edit, line, detail, nth] of cases) {
    const t = partsBrief(edit);
    throwsPart(() => parseParts(t), "parts", "malformed", lineOf(t, line, nth), detail);
    // The same two parts linked by `after:` pass: they never run at once.
    const linked = parseParts(partsBrief(chain(edit, swap("  - after: none", ["  - after: P1"], 2))));
    assert.deepEqual(linked[1]!.after, ["P1"]);
  }
});

test("parts: a deliverable in no part, in two parts, or past the last bullet is refused", () => {
  const none = partsBrief(swap("  - deliverables: 1, 2", ["  - deliverables: 1"]));
  throwsPart(() => parseParts(none), "parts", "malformed", lineOf(none, "## Parts"), /deliverable 2 is in no part/);
  const two = partsBrief(swap("  - deliverables: 3", ["  - deliverables: 2, 3"]));
  throwsPart(() => parseParts(two), "parts", "malformed", lineOf(two, "  - deliverables: 2, 3"), /deliverable 2 is in P1 and P2/);
  const past = partsBrief(swap("  - deliverables: 3", ["  - deliverables: 3, 4"]));
  throwsPart(() => parseParts(past), "parts", "malformed", lineOf(past, "  - deliverables: 3, 4"), /names deliverable 4; `## Deliverables` has 3 top-level/);
});

test("parts: prose bullets and a yaml `deliverables:` array of different lengths are refused; equal lengths pass", () => {
  const yaml = (n: number) => ["```yaml", "files_exist:", "  - src/a.ts", "deliverables:", ...Array.from({ length: n }, (_, i) => [`  - name: d${i + 1}`, "    covered_by: [judgment]"]).flat(), "```", ""];
  const short = partsBrief((t) => `${t}\n${yaml(2).join("\n")}`);
  throwsPart(() => parseParts(short), "parts", "malformed", lineOf(short, "deliverables:"), /yaml `deliverables:` array has 2 entries and `## Deliverables` has 3/);
  assert.equal(parseParts(partsBrief((t) => `${t}\n${yaml(3).join("\n")}`)).length, 2);
  // A brief with no parts and no slices is not checked: positions key nothing there.
  assert.equal(parseParts(brief({ rest: ["## Deliverables", "", "- one", "", ...yaml(2)] })).length, 1);
});

test("parts: numbered `1.` deliverable items count as positions like `- ` bullets; a flow-form yaml array is not counted", () => {
  const numbered = partsBrief(chain(swap("- one: a", ["1. one: a"]), swap("- two: b", ["2. two: b"]), swap("- three: c", ["3. three: c"])));
  assert.deepEqual(parseParts(numbered).map((p) => p.deliverables), [[1, 2], [3]]);
  const flow = partsBrief((t) => `${t}\n\`\`\`yaml\ndeliverables: [{ name: a, covered_by: [judgment] }]\n\`\`\`\n`);
  assert.equal(parseParts(flow).length, 2, "the flow form is left to the manifest step");
  const empty = partsBrief((t) => `${t}\n\`\`\`yaml\ndeliverables: []\n\`\`\`\n`);
  throwsPart(() => parseParts(empty), "parts", "malformed", lineOf(empty, "deliverables: []"), /array has 0 entries/);
});

test("parts: an `after:` cycle, a self-wait, and a wait on no part are refused", () => {
  const cyc = partsBrief(swap("  - after: none", ["  - after: P2"]));
  const cycle = chain(swap("  - after: none", ["  - after: P2"]), swap("  - after: none", ["  - after: P1"]));
  throwsPart(() => parseParts(partsBrief(cycle)), "parts", "malformed", lineOf(cyc, "  - after: P2"), /`after:` cycle P1 → P2 → P1/);
  throwsPart(() => parseParts(partsBrief(swap("  - after: none", ["  - after: P1"]))), "parts", "malformed", lineOf(cyc, "  - after: P2"), /P1 waits for itself/);
  throwsPart(() => parseParts(partsBrief(swap("  - after: none", ["  - after: P9"]))), "parts", "malformed", lineOf(cyc, "  - after: P2"), /P1 waits for P9, which is not a part/);
});

test("parts: the header model must be the strongest part; session under sonnet makes the header sonnet", () => {
  const low = partsBrief(swap("model: opus — P2 is a design choice", ["model: sonnet — wrong"]));
  throwsPart(() => parseParts(low), "parts", "malformed", 4, /the header says `model: sonnet`; the strongest part model is opus \(P2\)/);
  const mixed = partsBrief(
    chain(
      swap("model: opus — P2 is a design choice", ["model: sonnet — P2 is the strongest"]),
      swap("  - model: sonnet — the brief names each file", ["  - model: session — the floor check"]),
      swap("  - model: opus — a design choice", ["  - model: sonnet"])
    )
  );
  assert.deepEqual(parseParts(mixed).map((p) => [p.model, p.why]), [["session", "the floor check"], ["sonnet", null]]);
  assert.equal(strongestModel([{ model: "session" }, { model: "sonnet" }]), "sonnet");
  assert.equal(strongestModel([{ model: "opus" }, { model: "session" }]), "opus");
  assert.ok(PART_MODEL_RANK.opus > PART_MODEL_RANK.sonnet && PART_MODEL_RANK.sonnet > PART_MODEL_RANK.session);
});

test("parts: a `tests:` slice with no slice, a slice no part names or two parts name, and a slice on a part's file are refused", () => {
  const t = partsBrief();
  throwsPart(() => parseParts(partsBrief(swap("  - tests: W1", ["  - tests: W1, W2"]))), "parts", "malformed", lineOf(t, "  - tests: W1"), /P2's `tests:` names W2, which `## Test slices` does not hold/);
  throwsPart(() => parseParts(partsBrief(swap("  - tests: W1", ["  - tests: none"]))), "parts", "malformed", lineOf(t, "- W1 · db · the second half's write contract"), /W1 is named by no part/);
  throwsPart(() => parseParts(partsBrief(swap("  - tests: builder", ["  - tests: W1"]))), "parts", "malformed", lineOf(t, "  - tests: W1"), /W1 is named by P1 and P2/);
  throwsPart(() => parseParts(partsBrief(swap("  - files: tests/b.db.test.ts", ["  - files: src/docs/b.test.ts"]))), "parts", "malformed", lineOf(t, "- W1 · db · the second half's write contract"), /W1's file src\/docs\/b\.test\.ts is also P2's src\/docs\//);
});

test("slices: a missing or malformed field, a cover past the last bullet, and two slices on one file are refused", () => {
  const t = partsBrief();
  const at = (edit: (t: string) => string, line: number, detail: RegExp) => throwsPart(() => parseTestSlices(partsBrief(edit)), "test-slices", "malformed", line, detail);
  at(swap("  - under test: writeB, readB", []), lineOf(t, "- W1 · db · the second half's write contract"), /W1 has no `  - under test: …` line/);
  at(swap("  - covers: 2", ["  - covers: 7"]), lineOf(t, "  - covers: 2"), /W1's `covers:` names deliverable 7/);
  at(swap("- W1 · db · the second half's write contract", ["- W1 · sql · x"]), lineOf(t, "- W1 · db · the second half's write contract"), /expected `- W<k> · db\|plain ·/);
  const second = ["- W2 · plain · another", "  - files: tests/b.db.test.ts", "  - covers: 3", "  - under test: c"];
  const two = partsBrief(swap("  - under test: writeB, readB", ["  - under test: writeB, readB", ...second]));
  throwsPart(() => parseTestSlices(two), "test-slices", "malformed", lineOf(two, "  - files: tests/b.db.test.ts", 2), /W2 and W1 share tests\/b\.db\.test\.ts/);
});

// ── briefCheck CLI ────────────────────────────────────────────────────────────

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "briefcheck-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (args: string[], cwd?: string) => spawnSmoke(TSX_BIN, [SCRIPT, ...args], cwd ? { cwd } : {});

const IMPLICIT_LINES = "parts: 1 (P1 sonnet; no ## Parts section)\nslices: 0 (none)\n";

test("briefCheck prints class, model, target files, claims, parts, and slices; the from-branch file prints class and claims", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "b.md"), brief());
    writeFileSync(join(dir, "h.md"), FROM_BRANCH);
    const b = run([join(dir, "b.md")]);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(b.stdout, `class: R1\nmodel: sonnet\ntarget-files: 3\nclaims: 2 (H1, H2)\n${IMPLICIT_LINES}`);
    const h = run([join(dir, "h.md")]);
    assert.equal(h.status, 0, h.stderr);
    assert.equal(h.stdout, "class: R1\nclaims: 1 (H1)\n");
    const none = run([join(dir, "n.md")]);
    assert.equal(none.status, 2, "a missing file is usage");
  });
});

test("briefCheck reads an older brief's `budget:` header line as nothing: same summary, exit 0, no budget key", () => {
  withDir((dir) => {
    for (const line of ["budget: 2h", "budget: 3"]) {
      writeFileSync(join(dir, "b.md"), brief({ header: [...HEADER.slice(0, -1), line, ""] }));
      const r = run([join(dir, "b.md")]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `class: R1\nmodel: sonnet\ntarget-files: 3\nclaims: 2 (H1, H2)\n${IMPLICIT_LINES}`, line);
      assert.equal(Object.hasOwn(JSON.parse(run([join(dir, "b.md"), "--json"]).stdout), "budget"), false, line);
    }
  });
});

test("briefCheck exits 1 naming the part and line on a malformed part, and 2 on an unknown flag", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "b.md"), brief({ targets: ["## Target files", "", "* apps/x.ts", ""] }));
    const r = run([join(dir, "b.md")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^briefCheck: target-files: line 8: expected/);
    assert.equal(run([join(dir, "b.md"), "--bogus"]).status, 2);
  });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

test("briefCheck --at reads the old version, and a legacy first commit counts 0 claims (R.11)", () => {
  withDir((dir) => {
    git(dir, "init", "-q", "-b", "main");
    const legacy = ["# quick-x", "", "class: R1 — operator, 2026-09-28", "", "## Spec", "", "text", ""].join("\n");
    writeFileSync(join(dir, "brief.md"), legacy);
    git(dir, "add", "brief.md");
    git(dir, "commit", "-q", "-m", "brief");
    const first = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "brief.md"), brief());
    git(dir, "commit", "-q", "-am", "amend brief: the parts");

    const head = run(["brief.md"], dir);
    assert.equal(head.stdout, `class: R1\nmodel: sonnet\ntarget-files: 3\nclaims: 2 (H1, H2)\n${IMPLICIT_LINES}`);
    const at = run(["brief.md", "--at", first], dir);
    assert.equal(at.status, 0, at.stderr);
    assert.equal(
      at.stdout,
      "class: R1\nmodel: none (legacy: no line)\ntarget-files: 0 (legacy: no section)\nclaims: 0 (legacy: no section)\n" +
        "parts: 0 (legacy: no model line or target files)\nslices: 0 (none)\n"
    );
    const json = JSON.parse(run(["brief.md", "--at", first, "--json"], dir).stdout);
    assert.deepEqual(json.legacy, ["model", "target-files", "hand-test"]);

    // Without --at the same legacy text is a missing part: exit 1.
    writeFileSync(join(dir, "brief.md"), legacy);
    const now = run(["brief.md"], dir);
    assert.equal(now.status, 1);
    assert.match(now.stderr, /^briefCheck: model: no `model:/);

    assert.equal(run(["brief.md", "--at", "no-such-ref"], dir).status, 2, "an unreadable commit is exit 2");
  });
});

/** git at a fixed committer time, so each test's commits are in a stated order. */
function gitAt(dir: string, at: number, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` },
  });
}

function commitAt(dir: string, at: number, rel: string, text: string, msg: string): string {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
  gitAt(dir, at, "add", "-A");
  gitAt(dir, at, "commit", "-q", "-m", msg);
  return gitAt(dir, at, "rev-parse", "HEAD").trim();
}

const SUMMARY = `class: R1\nmodel: sonnet\ntarget-files: 3\nclaims: 2 (H1, H2)\n${IMPLICIT_LINES}`;

test("briefCheck --base: a brief in the code repo is ok as the branch's first commit, and exit 1 as its second", () => {
  for (const late of [false, true]) {
    withDir((dir) => {
      gitAt(dir, 1000, "init", "-q", "-b", "main");
      commitAt(dir, 1000, "src/a.ts", "a\n", "base");
      gitAt(dir, 1000, "checkout", "-q", "-b", "quick/x");
      const code = () => commitAt(dir, 2000, "src/a.ts", "b\n", "build");
      const first = late ? code() : null;
      const added = commitAt(dir, 3000, "docs/brief.md", brief(), "brief");
      if (!late) code();
      const r = run(["docs/brief.md", "--base", "main"], dir);
      if (!late) {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, `${SUMMARY}order: ok\n`);
      } else {
        assert.equal(r.status, 1, r.stderr);
        assert.equal(
          r.stdout,
          `${SUMMARY}order: the brief was first committed at ${added}, not as the branch's first commit ${first}, so it post-dates the work it grades\n`
        );
      }
      assert.equal(run(["docs/brief.md"], dir).stdout, SUMMARY, "without --base, no order line");
      assert.equal(run(["docs/brief.md", "--base", "main", "--json"], dir).status, 2, "--base takes the summary only");
    });
  }
});

test("briefCheck --base: a brief in the store is ok when the branch's first commit records its store commit, run from the code repo", () => {
  for (const recorded of [true, false]) {
    withDir((dir) => {
      const store = join(dir, "store");
      const repo = join(dir, "repo");
      mkdirSync(store);
      mkdirSync(repo);
      gitAt(store, 1000, "init", "-q", "-b", "main");
      gitAt(repo, 1000, "init", "-q", "-b", "main");
      gitAt(repo, 1000, "remote", "add", "origin", "git@github.com:o/r.git");
      gitAt(repo, 1000, "config", "agents.profile", "public");
      commitAt(repo, 1000, "src/a.ts", "a\n", "base");
      gitAt(repo, 1000, "checkout", "-q", "-b", "quick/x");
      const added = commitAt(store, 1500, "o/r/briefs/quick-x.md", brief(), "brief: quick-x");
      if (recorded) gitAt(repo, 1800, "commit", "-q", "--allow-empty", "-m", `brief: store:briefs/quick-x.md @ ${added}`);
      const first = commitAt(repo, 2000, "src/a.ts", "b\n", "build");
      const r = spawnSmoke(TSX_BIN, [SCRIPT, join(store, "o/r/briefs/quick-x.md"), "--base", "main"], {
        cwd: repo,
        env: { ...process.env, AGENT_BUILD_STORE: store },
      });
      if (recorded) {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, `${SUMMARY}order: ok\n`);
      } else {
        assert.equal(r.status, 1, r.stderr);
        assert.equal(
          r.stdout,
          `${SUMMARY}order: the brief is not recorded by the branch's first commit ${first} — that commit is an empty one whose subject is \`brief: store:briefs/quick-x.md @ <store commit>\` (BRIEF step 6), so nothing proves it came before the work it grades\n`
        );
      }
    });
  }
});

test("briefCheck --base: a brief in the store is refused from the store itself and from another repo", () => {
  withDir((dir) => {
    const store = join(dir, "store");
    const other = join(dir, "other");
    mkdirSync(store);
    mkdirSync(other);
    gitAt(store, 1000, "init", "-q", "-b", "main");
    gitAt(other, 1000, "init", "-q", "-b", "main");
    gitAt(other, 1000, "remote", "add", "origin", "git@github.com:o/other.git");
    commitAt(other, 1000, "src/a.ts", "a\n", "base");
    commitAt(store, 1500, "o/r/briefs/quick-x.md", brief(), "brief: quick-x");
    const from = (cwd: string) =>
      spawnSmoke(TSX_BIN, [SCRIPT, join(store, "o/r/briefs/quick-x.md"), "--base", "main"], { cwd, env: { ...process.env, AGENT_BUILD_STORE: store } });
    // In either, main..HEAD is empty, which used to read `order: ok`.
    const inStore = from(store);
    assert.equal(inStore.status, 2, inStore.stdout);
    assert.doesNotMatch(inStore.stdout, /order: ok/);
    const inOther = from(other);
    assert.equal(inOther.status, 2, inOther.stdout);
    assert.match(inOther.stderr, /is not under .*o\/other, the store dir of the repo briefCheck was run in/);
    assert.doesNotMatch(inOther.stdout, /order: ok/);
  });
});

test("briefCheck --at still refuses a malformed part at the old commit", () => {
  withDir((dir) => {
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "brief.md"), brief({ hand: ["## Hand test", "", "- H1 · x", "  - run: a", ""] }));
    git(dir, "add", "brief.md");
    git(dir, "commit", "-q", "-m", "brief");
    const r = run(["brief.md", "--at", "HEAD"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hand-test: line 14: H1 has no `  - pass:/);
  });
});

test("briefCheck refuses a claim whose run: is a test runner; a live command, a Maestro flow, and a query pass", () => {
  const runners: [string, string][] = [
    ["pnpm exec jest packages/core/src/x.test.ts", "jest"],
    ["pnpm -F @acme/core test src/x.test.ts", "pnpm test"],
    ["pnpm test", "pnpm test"],
    ["bash scripts/with-dev-env.sh deno task --cwd apps/supabase test tests/x_test.ts", "deno test"],
    ["deno test -A tests/x_test.ts", "deno test"],
    ["node --import tsx --test src/x.test.ts", "node --test"],
    ["npx vitest run", "vitest"],
  ];
  for (const [cmd, name] of runners) assert.equal(testRunnerOf(cmd), name, cmd);
  for (const cmd of [
    "pnpm exec maestro test apps/mobile/.maestro/chat.yaml",
    "curl -s http://127.0.0.1:54321/functions/v1/chat",
    "psql \"$APP_PG_URL\" -c 'select count(*) from tests'",
    "node src/app.ts --test-mode",
    "pnpm exec tsx scripts/test-report.ts",
  ]) {
    assert.equal(testRunnerOf(cmd), null, cmd);
  }
  withDir((dir) => {
    const hand = ["## Hand test", "", "- H1 · the send test passes", "  - run: `node --test src/send.test.ts`", "  - pass: exit 0", ""];
    writeFileSync(join(dir, "b.md"), brief({ hand }));
    const r = run([join(dir, "b.md")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^briefCheck: hand-test: H1 \(line 14\) runs node --test — tests run in the checks and CI; [^\n]*write `none — <reason>`/);
    writeFileSync(join(dir, "ok.md"), brief());
    assert.equal(run([join(dir, "ok.md")]).status, 0);
  });
});

test("briefCheck refuses a manifest claim with no exercise to run; one that runs the brief's exercise passes", () => {
  withDir((dir) => {
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/build-steps.toml"), 'manifest = "pnpm check:manifest"\n');
    const claim = (flags: string) => ["## Hand test", "", "- H1 · the exercise passes on the stack", `  - run: \`pnpm check:manifest --brief-file b.md${flags}\``, "  - pass: 0 FAIL", "  - needs: stack", ""];
    const exercise = ["## Deliverables", "", "```yaml", "deliverables:", "  - id: d1", "exercise:", "  - fn: chat", "```", ""];
    writeFileSync(join(dir, "none.md"), brief({ hand: claim("") }));
    const none = run([join(dir, "none.md")], dir);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /^briefCheck: hand-test: H1 \(line 14\) runs the manifest with no exercise/);
    writeFileSync(join(dir, "flag.md"), brief({ hand: claim(" --no-exercise"), rest: exercise }));
    assert.equal(run([join(dir, "flag.md")], dir).status, 1);
    writeFileSync(join(dir, "live.md"), brief({ hand: claim(""), rest: exercise }));
    const live = run([join(dir, "live.md")], dir);
    assert.equal(live.status, 0, live.stderr);
  });
});

// ── briefCheck: parts, slices, and the excerpt modes ──────────────────────────

const OVER_GUIDE = swap("  - under test: writeB, readB", ["  - under test: a, b, c, d, e"]);

test("briefCheck prints the parts with their waits and the slices with their size; exit 1 names a bad part", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "b.md"), partsBrief(swap("  - after: none", ["  - after: P1"], 2)));
    const r = run([join(dir, "b.md")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\nparts: 2 \(P1 sonnet, P2 opus after P1\)\nslices: 1 \(W1 db, 2 functions\)\n$/);
    writeFileSync(join(dir, "bad.md"), partsBrief(swap("  - deliverables: 3", ["  - deliverables: 2, 3"])));
    const bad = run([join(dir, "bad.md")]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^briefCheck: parts: line \d+: deliverable 2 is in P1 and P2/);
  });
});

test("briefCheck: a slice over the guide is a warning on its line and still exits 0", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "b.md"), partsBrief(OVER_GUIDE));
    const r = run([join(dir, "b.md")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\nslices: 1 \(W1 db, 5 functions — over the 4 guide\)\n$/);
  });
});

test("briefCheck reads the slice guide from the brief's repo thresholds", () => {
  withDir((dir) => {
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/build-steps.toml"), 'thresholds = "t.json"\n');
    writeFileSync(join(dir, "t.json"), '{"TEST_SLICE_MAX_FUNCTIONS": 1}');
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/b.md"), partsBrief());
    const r = run([join(dir, "docs/b.md")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\nslices: 1 \(W1 db, 2 functions — over the 1 guide\)\n$/);
  });
});

test("briefCheck --files prints a part's files then its test files, or a slice's files; an unknown id exits 1", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "b.md"), partsBrief());
    writeFileSync(join(dir, "one.md"), brief());
    const out = (args: string[]) => {
      const r = run([join(dir, "b.md"), ...args]);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    assert.equal(out(["--files", "P1"]), "src/a.ts\ntests/a.test.ts\n");
    assert.equal(out(["--files", "P2"]), "src/b.ts\nsrc/docs/\n");
    assert.equal(out(["--files", "W1"]), "tests/b.db.test.ts\n");
    const implicit = run([join(dir, "one.md"), "--files", "P1"]);
    assert.equal(implicit.stdout, "apps/mobile/src/chat/send.ts\npackages/core/src/chat/**\n.claude/build/notes.md\n");
    const unknown = run([join(dir, "b.md"), "--files", "P9"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /no part or slice P9 in the brief/);
    assert.equal(run([join(dir, "b.md"), "--files", "X1"]).status, 2, "a malformed id is usage");
    assert.equal(run([join(dir, "b.md"), "--files", "P1", "--json"]).status, 2, "one mode at a time");
  });
});

test("briefCheck --slice prints the slice block, its covered deliverables verbatim, and the public surface and locked decisions", () => {
  withDir((dir) => {
    const rest = ["", "## Public surface", "", "- `writeB(x): Ack` — new", "", "## Locked decisions", "", "- LD-1: never X", ""];
    writeFileSync(join(dir, "b.md"), partsBrief((t) => `${t}${rest.join("\n")}`));
    const r = run([join(dir, "b.md"), "--slice", "W1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        "## Test slices",
        "",
        "- W1 · db · the second half's write contract",
        "  - files: tests/b.db.test.ts",
        "  - covers: 2",
        "  - under test: writeB, readB",
        "",
        "## Deliverables (the ones this slice covers, by position)",
        "",
        "deliverable 2 of 3:",
        "- two: b",
        "  - nested detail of two",
        "",
        "## Public surface",
        "",
        "- `writeB(x): Ack` — new",
        "",
        "## Locked decisions",
        "",
        "- LD-1: never X",
        "",
      ].join("\n")
    );
    assert.doesNotMatch(r.stdout, /- one: a|- three: c/, "no other deliverable");
    const unknown = run([join(dir, "b.md"), "--slice", "W9"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /no slice W9 in the brief/);
    assert.equal(run([join(dir, "b.md"), "--slice", "P1"]).status, 2, "--slice takes a W id");
  });
});
