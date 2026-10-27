import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { buildState, combineAnswers, decide, featureSum } from "../adapters/classifierState.ts";
import { headerPath, isProductionPath, shapeDiff } from "../adapters/diffShape.ts";
import { NO_DIFF_LEFT, NO_PRODUCTION_CODE } from "../constants.ts";
import { RunError, type DataValues, type StateField } from "../contracts.ts";
import { FIXTURES, NO_FIXTURES } from "./helpers/fixtures.ts";

const file = (path: string, ...hunks: string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks.map((h) => `@@ -1,2 +1,3 @@\n${h}`)].join("\n");

const QUIET = " context\n+const answer = 42;\n context";
const RISKY = " context\n+const out = JSON.parse(await readFile(p));\n context";

const DIFF = [
  file("src/run.ts", QUIET, RISKY),
  file("src/pure.ts", QUIET),
  file("src/__tests__/run.test.ts", RISKY),
  file("docs/readme.md", RISKY),
  file("package.json", RISKY),
  file("src/generated/api.ts", RISKY),
].join("\n");

test("which paths are production code: tests, docs, data and config, and generated copies are not", () => {
  for (const p of ["src/run.ts", "main.go", "lib/a.py", "app/View.swift"]) assert.equal(isProductionPath(p), true, p);
  for (const p of ["src/a.test.ts", "tests/x.ts", "a/__tests__/b.ts", "test_a.py", "b_test.go", "README.md", "docs/a.ts", "pnpm-lock.yaml", "x.json", "src/generated/a.ts", "LICENSE", ".gitignore"]) {
    assert.equal(isProductionPath(p), false, p);
  }
});

test("production-code keeps every hunk of the production files and drops the rest", () => {
  const text = shapeDiff(DIFF, "production-code");
  assert.match(text, /diff --git a\/src\/run\.ts/);
  assert.match(text, /diff --git a\/src\/pure\.ts/);
  assert.equal((text.match(/^@@/gm) ?? []).length, 3, "both hunks of run.ts and the one of pure.ts");
  for (const gone of ["run.test.ts", "readme.md", "package.json", "generated"]) assert.ok(!text.includes(gone), gone);
});

test("security-surface keeps production code and the config on the security surface: CI workflows, plists, config.toml, an auth or RLS path", () => {
  const kept = ["src/run.ts", ".github/workflows/ci.yml", "supabase/auth/config.toml", "app/Info.plist", "src/authorization/policy.json", "packages/userAuth/settings.yaml", "db/rls/policies.json", ".env.local.example"];
  const dropped = [
    "src/data/authors.json",
    "assets/author.svg",
    "packages/auth-client/pnpm-lock.yaml",
    "apps/oauth-demo/package-lock.json",
    "src/auth/logo.png",
    "src/auth/generated/schema.json",
    "src/auth/__tests__/fixture.json",
    "docs/auth/setup.md",
    "package.json",
  ];
  const text = shapeDiff([...kept, ...dropped].map((p) => file(p, QUIET)).join("\n"), "security-surface");
  for (const p of kept) assert.ok(text.includes(`diff --git a/${p} `), `kept: ${p}`);
  for (const p of dropped) assert.ok(!text.includes(`diff --git a/${p} `), `dropped: ${p}`);
});

test("risky-hunks keeps only the hunks whose added lines parse, call out, handle errors, write, or await", () => {
  const text = shapeDiff(DIFF, "risky-hunks");
  assert.match(text, /JSON\.parse/);
  assert.ok(!text.includes("const answer = 42"), "the quiet hunk is dropped");
  assert.ok(!text.includes("pure.ts"), "a file left with no hunk is dropped");
  assert.equal((text.match(/^@@/gm) ?? []).length, 1);
});

test("a risky pattern on a removed or context line does not keep a hunk", () => {
  const diff = file("src/a.ts", " await context line\n-const x = JSON.parse(y);\n+const x = 1;");
  assert.equal(shapeDiff(diff, "risky-hunks"), NO_PRODUCTION_CODE);
});

test("a diff with nothing in production code, or no diff at all, becomes the placeholder", () => {
  assert.equal(shapeDiff(file("README.md", RISKY), "production-code"), NO_PRODUCTION_CODE);
  assert.equal(shapeDiff("", "risky-hunks"), NO_PRODUCTION_CODE);
});

test("a file with no hunks (a rename or mode change) stays in production-code", () => {
  const rename = "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts";
  assert.match(shapeDiff(rename, "production-code"), /rename to src\/new\.ts/);
});

const text = (t: string): DataValues[string] => ({ schema: "text", text: t });

test("buildState names each field, shapes and samples its input, and adds the note beside it, saying how it sampled", () => {
  const fields = {
    summary: { input: "s" },
    diff: { input: "d", shape: "production-code" as const, maxChars: 200, note: { field: "diff_note", text: "production code only" } },
  };
  const state = buildState(fields, { s: text("as given"), d: text(DIFF) }, "q");
  assert.deepEqual(Object.keys(state), ["summary", "diff", "diff_note"]);
  assert.equal(state.summary, "as given");
  assert.ok(state.diff!.length <= 200);
  assert.match(state.diff!, /src\/run\.ts/);
  assert.match(state.diff!, /src\/pure\.ts/, "the sample reaches the second file");
  const full = shapeDiff(DIFF, "production-code").length;
  assert.match(state.diff_note!, new RegExp(`^production code only \\(sampled to 200 of ${full} characters: 2 of 2 files shown`));
});

test("an optional field whose input is absent is left out, note and all; present, it is read like any other", () => {
  const fields = { request: { input: "start" }, ticket: { input: "ticket", optional: true, note: { field: "ticket_note", text: "the ticket" } } };
  assert.deepEqual(buildState(fields, { start: text("add a flag") }, "prior-art"), { request: "add a flag" });
  assert.deepEqual(buildState(fields, { start: text("add a flag"), ticket: text("DEV-3: a flag") }, "prior-art"), { request: "add a flag", ticket: "DEV-3: a flag", ticket_note: "the ticket" });
  assert.throws(() => buildState({ ticket: { input: "ticket" } }, { start: text("x") }, "prior-art"), /prior-art: no input ticket/, "a field not marked optional still needs its input");
});

test("an \"any of these\" combination takes the largest answer; the mean is the default shape", () => {
  assert.equal(combineAnswers([0.1, 0.9, 0.2], "max"), 0.9);
  assert.equal(combineAnswers([0.2, 0.8, 0.5], "mean"), 0.5);
  assert.throws(() => combineAnswers([], "max"), /no answers/);
});

test("a field that fits is not cut and its note is the bare text", () => {
  const state = buildState({ diff: { input: "d", maxChars: 1000, note: { field: "n", text: "all of it" } } }, { d: text("short") }, "q");
  assert.deepEqual(state, { diff: "short", n: "all of it" });
});

test("an input the node was not given is a run error naming the classifier and the input", () => {
  assert.throws(() => buildState({ diff: { input: "d" } }, {}, "hunter"), (e: unknown) => e instanceof RunError && /hunter: no input d/.test(e.message));
  assert.throws(() => buildState({ x: { input: "toString" } }, {}, "q"), RunError);
});

test("a feature adds its weight when its pattern matches a line of its input, once however many match", () => {
  const features = [{ input: "report", pattern: "^\\S+ · decision\\b", weight: 0.4 }];
  const report = (t: string): DataValues => ({ report: text(t) });
  assert.equal(featureSum(features, report("F1 · fixed · abc1234 — done\nF2 · decision — which one?\nF3 · decision — another"), "q"), 0.4);
  assert.equal(featureSum(features, report("F1 · fixed · abc1234 — a decision was needed"), "q"), 0);
  assert.equal(featureSum([], report(""), "q"), 0);
  assert.throws(() => featureSum(features, {}, "q"), RunError);
});

test("decide answers on the score at the cut-off, and caps p at 1 on the same side of it", () => {
  assert.deepEqual(decide(0.5, 0.5, "yes", "no"), { answer: "yes", p: 0.5 });
  assert.deepEqual(decide(0.49, 0.5, "yes", "no"), { answer: "no", p: 0.49 });
  assert.deepEqual(decide(1.3, 0.974, "yes", "no"), { answer: "yes", p: 1 });
  assert.deepEqual(decide(-0.2, 0, "yes", "no"), { answer: "no", p: 0 });
});

test("a production file whose name has a space, or a quoted name, or a rename is still production code", () => {
  const spaced = "diff --git a/src/my file.ts b/src/my file.ts\n--- a/src/my file.ts\n+++ b/src/my file.ts\n@@ -1 +1,2 @@\n+const a = JSON.parse(x);";
  assert.match(shapeDiff(spaced, "production-code"), /my file\.ts/);
  assert.match(shapeDiff(spaced, "risky-hunks"), /JSON\.parse/);
  const quoted = 'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"\n--- "a/src/caf\\303\\251.ts"\n+++ "b/src/caf\\303\\251.ts"\n@@ -1 +1,2 @@\n+await go();';
  assert.match(shapeDiff(quoted, "production-code"), /await go/);
  const renamed = "diff --git a/docs/a b.md b/src/new name.ts\nsimilarity index 90%\nrename from docs/a b.md\nrename to src/new name.ts\n--- a/docs/a b.md\n+++ b/src/new name.ts\n@@ -1 +1,2 @@\n+await go();";
  assert.match(shapeDiff(renamed, "production-code"), /new name\.ts/);
});

test("a test or doc file with a space in its name is still dropped", () => {
  const doc = "diff --git a/docs/my notes.md b/docs/my notes.md\n--- a/docs/my notes.md\n+++ b/docs/my notes.md\n@@ -1 +1,2 @@\n+await go();";
  assert.equal(shapeDiff(doc, "production-code"), NO_PRODUCTION_CODE);
});

test("headerPath reads the new name from bare, spaced, quoted and renamed headers", () => {
  assert.equal(headerPath("diff --git a/x.ts b/x.ts"), "x.ts");
  assert.equal(headerPath("diff --git a/src/my file.ts b/src/my file.ts"), "src/my file.ts");
  assert.equal(headerPath('diff --git "a/q\\"x.ts" "b/q\\"x.ts"'), 'q"x.ts');
  assert.equal(headerPath('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"'), "café.ts");
  assert.equal(headerPath("diff --git a/old.ts b/new.ts"), "new.ts");
});

/** Round 4's summaries for the two recorded runs the mock fixtures replay (its labelled inputs). */
const ROUND4_SUMMARY: Record<string, string> = {
  "build-1792523343-EIBekQ": "summary: There is a sweep command that starts unattended ticket runs, each in its own tab of the\n         herdr workspace build-runs. When a run finishes, its tab stays open with an idle agent in\n         it; after the first real sweep three such tabs were left behind and had to be found by\n         hand. The sweep now also looks at every tab in that workspace whose name reads\n         \"Linear Run <ticket>\", checks the ticket, and closes the tab's pane when the ticket is no\n         longer In Progress (Done, Canceled, back in Backlog, or gone). A pane is kept when its\n         ticket is still In Progress, when any In Progress run's start comment names it, or when\n         its agent is still working (the ticket flips to Done at merge while the worker is still\n         cleaning up). Each close is printed and logged; `--dry-run` prints what it would close and\n         closes nothing.\nimpact:  The operator stops finding dead tabs by hand: a run that crashed or never reached its\n         own close is cleaned up by the next sweep, and a run that is still going is never cut off.\nclass:   R1 — a wrong close kills a worker mid-cleanup (lost work); a missed close is the bug today",
  "build-1790977465-962": "summary: Every encrypted (O1) database column is read and written through supabase-js as a\n         hex string the codec encodes and decodes. Today the generated types call those\n         columns plain bytes, so a raw-bytes write (silent ciphertext corruption) and an\n         undecoded read (a hex string handed to decrypt) both compile. The work makes the\n         column type an opaque brand that only the codec mints and reads, so both mistakes\n         fail the type check, and fixes every site the new type rejects.\nimpact:  No user sees a change. A new O1 site no longer needs manual review: tsc holds the\n         rule the docs state.\nclass:   R2 — the change retypes the encryption boundary (every O1 table column, the codec's\n         signature) (agent, unconfirmed)",
};

test("the hunter's summary is the risk moment cut before its size line, byte for byte what round 4 sent, on two recorded runs", { skip: NO_FIXTURES }, () => {
  const fields = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "classifiers", "silent-failures.json"), "utf8")) as { fields: Record<string, StateField> }).fields;
  for (const [run, summary] of Object.entries(ROUND4_SUMMARY)) {
    const path = join(FIXTURES, run, "agents", "write-brief", "risk-moment", "class-moment.txt");
    const moment = readFileSync(path, "utf8");
    assert.match(moment, /^size:/m, `${run}: the recorded block goes on past the class line`);
    const files: DataValues[string] = { schema: "files", files: [path] };
    assert.equal(buildState({ summary: fields.summary! }, { "risk-moment": files }, "C-silent-failures").summary, summary, run);
    assert.equal(buildState({ raw: { input: "risk-moment" } }, { "risk-moment": files }, "C-silent-failures").raw, moment, "a file is read as it is, its last newline kept");
  }
  assert.equal(buildState({ s: { input: "m", cutBefore: "^size:" } }, { m: text("  class: R1\n") }, "C").s, "class: R1", "no match: the whole text, trimmed");
});

test("no-tests-docs-locks is round 4's filter: every .md and .txt, tests and lockfiles go, behavior markdown included; config stays", () => {
  const diff = [
    file("src/run.ts", QUIET),
    file(".claude/agents/fixer.md", QUIET),
    file("AGENTS.md", QUIET),
    file("docs/rules/review.md", QUIET),
    file("notes/plan.TXT", QUIET),
    file("src/__tests__/run.test.ts", QUIET),
    file("pnpm-lock.yaml", QUIET),
    file("package.json", QUIET),
  ].join("\n");
  const kept = shapeDiff(diff, "no-tests-docs-locks").match(/^diff --git a\/(\S+)/gm);
  assert.deepEqual(kept, ["diff --git a/src/run.ts", "diff --git a/package.json"]);
  const chunk = (path: string) => `${file(path, QUIET)}\n`;
  const raw = `{"range": "a..b"}\n\n${chunk("src/a.ts")}${chunk("src/b.ts")}${chunk("docs/x.md")}`;
  assert.equal(shapeDiff(raw, "no-tests-docs-locks"), chunk("src/a.ts") + chunk("src/b.ts"), "the kept chunks verbatim, each with its newline, and no text before the first file");
  assert.equal(shapeDiff(file("README.md", QUIET), "no-tests-docs-locks"), NO_DIFF_LEFT, "nothing left is sent as round 4 sent it");
  assert.match(shapeDiff('diff --git "a/my notes.md" "b/my notes.md"\n@@ -1 +1 @@\n+x', "no-tests-docs-locks"), /my notes\.md/, "a quoted header round 4 could not parse stays");
});
