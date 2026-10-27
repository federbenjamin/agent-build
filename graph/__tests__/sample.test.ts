import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { sampleText } from "../adapters/sample.ts";

const file = (path: string, hunks: string[][]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks.flatMap((lines, i) => [`@@ -${i * 100 + 1},3 +${i * 100 + 1},${lines.length} @@`, ...lines])].join("\n");
const hunk = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `+${tag} line ${i}`);

test("a text within its budget is sent as it is, with nothing to say about sampling", () => {
  assert.deepEqual(sampleText("short", 10, { diff: true }), { text: "short", how: "" });
});

test("a big diff keeps every file, not the first files in path order, and a long file keeps its first and last hunks", () => {
  const long = file("a/long.ts", Array.from({ length: 40 }, (_, i) => hunk(`h${i}`, 20)));
  const small = Array.from({ length: 8 }, (_, i) => file(`z/f${i}.ts`, [hunk(`small${i}`, 2)]));
  const diff = [long, ...small, file("zz/last.ts", [hunk("risky await fetch", 3)])].join("\n");
  const s = sampleText(diff, 4000, { diff: true });
  assert.ok(s.text.length <= 4000, `${s.text.length} characters`);
  for (const p of ["a/long.ts", ...Array.from({ length: 8 }, (_, i) => `z/f${i}.ts`), "zz/last.ts"]) assert.ok(s.text.includes(`diff --git a/${p} b/${p}`), p);
  assert.match(s.text, /risky await fetch/, "the last file in path order is read");
  assert.match(s.text, /\+h0 line 0/, "the long file's first hunk");
  assert.match(s.text, /\+h39 line 19/, "the long file's last hunk");
  assert.match(s.text, /^… \d+ hunks? left out …$/m);
  assert.ok(!s.text.includes("+h20 line 0"), "a middle hunk is left out");
  assert.match(s.how, /^sampled to 4000 of \d+ characters: 10 of 10 files shown/);
});

test("one long new file keeps the head and the tail of its one hunk, with the gap counted in lines", () => {
  const diff = file("src/new.ts", [hunk("n", 2000)]);
  const s = sampleText(diff, 3000, { diff: true });
  assert.ok(s.text.length <= 3000);
  assert.match(s.text, /^@@ -1,3 \+1,2000 @@$/m, "the hunk keeps its line numbers");
  assert.match(s.text, /\+n line 0$/m);
  assert.match(s.text, /\+n line 1999$/m);
  const gap = /^… (\d+) lines left out …$/m.exec(s.text);
  assert.ok(gap !== null);
  const shown = s.text.split("\n").filter((l) => l.startsWith("+n line")).length;
  assert.equal(shown + Number(gap[1]), 2000, "every line is either shown or counted in the gap");
});

test("when even the file headers do not fit, every k-th file is shown and a last line counts the rest", () => {
  const diff = Array.from({ length: 400 }, (_, i) => file(`src/module-${String(i).padStart(3, "0")}/index.ts`, [hunk("x", 1)])).join("\n");
  const s = sampleText(diff, 2000, { diff: true });
  assert.ok(s.text.length <= 2000);
  assert.match(s.text, /module-000/);
  const gap = /^… (\d+) files left out …$/m.exec(s.text);
  assert.ok(gap !== null);
  const shown = (s.text.match(/^diff --git /gm) ?? []).length;
  assert.equal(shown + Number(gap[1]), 400);
  assert.match(s.how, new RegExp(`${shown} of 400 files shown`));
});

const brief = [
  "# Brief: a thing",
  "",
  "## Spec",
  ...Array.from({ length: 300 }, (_, i) => `spec line ${i}`),
  "## Design",
  "```sh",
  "# a shell comment, not a heading",
  "```",
  ...Array.from({ length: 300 }, (_, i) => `design line ${i}`),
  "## Parts",
  "- P1: the parser",
  "## Deliverables",
  ...Array.from({ length: 25 }, (_, i) => `- [ ] deliverable ${i}`),
].join("\n");

test("a long brief keeps its Deliverables section whole and every section's heading with the head and tail of its text", () => {
  const s = sampleText(brief, 3000, { diff: false, keep: ["Deliverables"] });
  assert.ok(s.text.length <= 3000);
  for (let i = 0; i < 25; i++) assert.ok(s.text.includes(`- [ ] deliverable ${i}`), `deliverable ${i}`);
  for (const h of ["# Brief: a thing", "## Spec", "## Design", "## Parts"]) assert.match(s.text, new RegExp(`^${h}$`, "m"));
  assert.match(s.text, /^spec line 0$/m);
  assert.match(s.text, /^spec line 299$/m, "the tail of a long section");
  assert.match(s.text, /^… \d+ lines left out …$/m);
  assert.match(s.how, /the "Deliverables" section first, whole when they fit/);
});

test("a heading inside a code fence does not start a section", () => {
  const s = sampleText(brief, 3000, { diff: false, keep: ["Design"] });
  assert.ok(s.text.includes("# a shell comment, not a heading"), "the fenced line stays inside the kept Design section");
  assert.match(s.how, /the "Design" section first/);
});

test("without keep, the Deliverables of a brief no longer fall off the end: every section is reached", () => {
  const s = sampleText(brief, 3000, { diff: false });
  assert.match(s.text, /^## Deliverables$/m);
  assert.match(s.text, /deliverable 24/);
  assert.ok(!s.how.includes("first, whole"));
});

test("a diff field whose text is no diff, and a text with no headings, keep their head and tail", () => {
  const plain = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join("\n");
  for (const diff of [true, false]) {
    const s = sampleText(plain, 500, { diff });
    assert.ok(s.text.length <= 500);
    assert.match(s.text, /^row 0$/m);
    assert.match(s.text, /^row 999$/m);
  }
});

test("the sample never passes its budget, at any budget, for a diff or a brief", () => {
  const diff = [file("a.ts", Array.from({ length: 30 }, (_, i) => hunk(`a${i}`, 7))), ...Array.from({ length: 25 }, (_, i) => file(`b${i}.ts`, [hunk("b", 40)]))].join("\n");
  for (const max of [1, 10, 49, 50, 120, 333, 1000, 2500, 7777]) {
    assert.ok(sampleText(diff, max, { diff: true }).text.length <= max, `diff at ${max}`);
    assert.ok(sampleText(brief, max, { diff: false, keep: ["Deliverables"] }).text.length <= max, `brief at ${max}`);
  }
});

test("a diff of 160 files sends code from every file and uses its budget, not just the file headers", () => {
  const path = (i: number) => `packages/core/src/module-${String(i).padStart(3, "0")}/handler.ts`;
  const big = (tag: string) => Array.from({ length: 15 }, (_, k) => `+  const ${tag}_${k} = await fetchThing(${k}); // pad`);
  const diff = Array.from({ length: 160 }, (_, i) => [`diff --git a/${path(i)} b/${path(i)}`, "index 1234567..89abcde 100644", `--- a/${path(i)}`, `+++ b/${path(i)}`, "@@ -1,3 +1,15 @@", ...big(`a${i}`), "@@ -101,3 +101,15 @@", ...big(`b${i}`)].join("\n")).join("\n");
  const s = sampleText(diff, 60000, { diff: true });
  assert.ok(s.text.length <= 60000, `${s.text.length} characters`);
  assert.ok(s.text.length >= 57000, `the budget is used: ${s.text.length} of 60000 characters`);
  const coded = new Set(s.text.split("\n").flatMap((l) => /^\+ {2}const [ab](\d+)_/.exec(l)?.[1] ?? []));
  assert.equal(coded.size, 160, "every file sends code lines");
  assert.equal((s.text.match(/^diff --git /gm) ?? []).length, 160);
});

test("an oversized first hunk does not crowd out a small last hunk: both boundary hunks are shown", () => {
  const diff = file("src/guard.ts", [hunk("big", 500), hunk("middle", 40), ["+if (!allowed(user)) throw new Forbidden();"]]);
  const s = sampleText(diff, 3000, { diff: true });
  assert.ok(s.text.length <= 3000);
  assert.match(s.text, /^\+if \(!allowed\(user\)\) throw new Forbidden\(\);$/m, "the last hunk, whole");
  assert.match(s.text, /^\+big line 0$/m, "the first hunk's head");
  assert.match(s.text, /^\+big line 499$/m, "the first hunk's tail");
});

test("a single line longer than the budget keeps its start and end and counts the characters left out", () => {
  const line = `Request: ${"x".repeat(4980)} and it MUST log the refusal`;
  const s = sampleText(line, 1000, { diff: false });
  assert.ok(s.text.length <= 1000, `${s.text.length} characters`);
  assert.ok(s.text.startsWith("Request: x"));
  assert.ok(s.text.endsWith("it MUST log the refusal"), "the line's tail survives");
  const gap = / … (\d+) characters left out … /.exec(s.text);
  assert.ok(gap !== null, s.text.slice(0, 200));
  assert.equal(s.text.length - gap[0].length + Number(gap[1]), line.length, "every character is shown or counted");
  assert.doesNotMatch(s.text, /\b0 lines left out/);
});
