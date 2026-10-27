import "./helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { privateTextHits } from "../publish.ts";
import { privateLines, ticketIds, TRACKER_KEYS } from "../lib/privateText.ts";
import { isTestPath } from "../lib/testPaths.ts";

const homeMatch = ["", "Users", ""].join("/");

test("an id finder keeps only complete letter-number ids and records their spelling and offset", () => {
  const text = "XENG-1 ENG-12abc ENG- ENG-x ENG-1ENG-2 ENG-3 Eng-4";

  assert.deepEqual(ticketIds(text), [
    { id: "XENG-1", prefix: "XENG", index: 0 },
    { id: "ENG-3", prefix: "ENG", index: text.indexOf("ENG-3") },
    { id: "Eng-4", prefix: "Eng", index: text.indexOf("Eng-4") },
  ]);
});

test("test paths include every test convention without treating ordinary source and metadata as tests", () => {
  for (const path of ["runtime/__tests__/x.ts", "graph/__tests__/helpers/y.ts", "tests/z.test.mjs", "a/b.spec.ts", "a/b_test.go"]) {
    assert.equal(isTestPath(path), true, path);
  }
  for (const path of ["runtime/lib/x.ts", "README.md", "graph/classifiers/x.json"]) {
    assert.equal(isTestPath(path), false, path);
  }
});

test("a non-test file reports each configured key regardless of its case and leaves other prefixes alone", () => {
  const text = "first eng-7\nsecond OPS-9\nthird ENG-8";

  assert.deepEqual(privateLines(text, "docs/notes.md", ["ENG"]), [
    { line: 1, rule: "ticket-citation", match: "eng-7" },
    { line: 3, rule: "ticket-citation", match: "ENG-8" },
  ]);
});

test("a test file permits ids in data but rejects citations in comments, titles, and parentheticals", () => {
  const text = [
    "// ENG-1",
    "/* ENG-2",
    " * ENG-3",
    'test("ENG-4", () => {});',
    'describe("ENG-5", () => {});',
    'it("ENG-6", () => {});',
    "const note = (ENG-10);",
    'const quoted = "ENG-12";',
    'ingest("ENG-3");',
    "/fixes ENG-9/;",
    "leftovers: ENG-12 | scope=plan-ENG-5",
    "https://x/issue/ENG-3",
    'it = take("ENG-4");',
    'test.skip("ENG-5 x", () => {});',
    '\tit ("ENG-7", () => {});',
    'itemize("ENG-8");',
    'describe: "ENG-11",',
  ].join("\n");

  assert.deepEqual(privateLines(text, "runtime/__tests__/x.test.ts", ["ENG"]), [
    { line: 1, rule: "ticket-citation", match: "ENG-1" },
    { line: 2, rule: "ticket-citation", match: "ENG-2" },
    { line: 3, rule: "ticket-citation", match: "ENG-3" },
    { line: 4, rule: "ticket-citation", match: "ENG-4" },
    { line: 5, rule: "ticket-citation", match: "ENG-5" },
    { line: 6, rule: "ticket-citation", match: "ENG-6" },
    { line: 7, rule: "ticket-citation", match: "ENG-10" },
    { line: 14, rule: "ticket-citation", match: "ENG-5" },
    { line: 15, rule: "ticket-citation", match: "ENG-7" },
  ]);
});

test("a macOS home path is refused in source and test files", () => {
  const home = ["", "Users", "someone"].join("/");

  for (const path of ["docs/notes.md", "runtime/__tests__/x.test.ts"]) {
    assert.deepEqual(privateLines(`at ${home}/code`, path, ["ENG"]), [
      { line: 1, rule: "home-path", match: homeMatch },
    ]);
  }
});

test("line hits stay in source order when home paths and citations share a file", () => {
  const home = ["", "Users", "someone"].join("/");
  const text = `first ENG-1\nsecond ${home}\nthird eng-2 ${home}\nfourth ${home} ENG-3\nENG-4 ${home} ENG-5`;

  assert.deepEqual(privateLines(text, "docs/notes.md", ["ENG"]), [
    { line: 1, rule: "ticket-citation", match: "ENG-1" },
    { line: 2, rule: "home-path", match: homeMatch },
    { line: 3, rule: "ticket-citation", match: "eng-2" },
    { line: 3, rule: "home-path", match: homeMatch },
    { line: 4, rule: "home-path", match: homeMatch },
    { line: 4, rule: "ticket-citation", match: "ENG-3" },
    { line: 5, rule: "ticket-citation", match: "ENG-4" },
    { line: 5, rule: "home-path", match: homeMatch },
    { line: 5, rule: "ticket-citation", match: "ENG-5" },
  ]);
});

const root = mkdtempSync(join(tmpdir(), "private-text-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a file scan keeps file and line order while skipping binary input", () => {
  const home = ["", "Users", "someone"].join("/");
  const id = (n: number) => [TRACKER_KEYS[0], n].join("-");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "docs", "first.md"), `${id(1)}\n${home}\n`);
  writeFileSync(join(root, "docs", "second.md"), `${id(2)}\n`);
  writeFileSync(join(root, "bin", "data.bin"), Buffer.from([0, 69, 78, 71, 45, 51]));

  assert.deepEqual(privateTextHits(root, ["docs/second.md", "bin/data.bin", "docs/first.md"]), [
    { file: "docs/second.md", line: 1, rule: "ticket-citation", match: id(2) },
    { file: "docs/first.md", line: 1, rule: "ticket-citation", match: id(1) },
    { file: "docs/first.md", line: 2, rule: "home-path", match: homeMatch },
  ]);
});
