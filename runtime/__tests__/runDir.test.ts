/** `readerFiles` (`lib/runDir.ts`): which files in a run dir or stage folder are reader files. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseLedger } from "../lib/ledger.ts";
import { missingHandTestOutputs, readerFiles, resolveTargets } from "../lib/runDir.ts";
import { parseHandTestFile } from "../lib/runFiles.ts";

test("fix4: resolveTargets never counts the brief, or a --from-branch run's hand-test file, as a target", () => {
  const repo = mkdtempSync(join(tmpdir(), "targets-"));
  try {
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "b.md"), "## Target files\n\n- src/a.ts\n- docs/b.md\n- docs/**\n");
    const head = "class: R1 — operator, 2026-09-28\nflow: 2\n";
    const briefed = resolveTargets(parseLedger(`${head}brief: docs/b.md\n`), repo, "HEAD");
    assert.deepEqual(["src/a.ts", "docs/b.md", "./docs/b.md", "docs/c.md"].map(briefed), [true, false, false, true]);
    const exec = () => "src/a.ts\ndocs/x-hand-test.md\n";
    const fb = resolveTargets(parseLedger(`${head}from-branch: dryrun/x\nhand-test-block: docs/x-hand-test.md\nfreshen: m | base=main | sha=aaaaaaa\n`), repo, "HEAD", { exec });
    assert.deepEqual(["src/a.ts", "docs/x-hand-test.md"].map(fb), [true, false]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveTargets reads a `store:` brief from the store dir, where no code path is the brief", () => {
  const root = mkdtempSync(join(tmpdir(), "targets-store-"));
  const before = process.env.AGENT_BUILD_STORE;
  try {
    mkdirSync(join(root, "store", "o", "r", "briefs"), { recursive: true });
    writeFileSync(join(root, "store", "o", "r", "briefs", "b.md"), "## Target files\n\n- src/a.ts\n- briefs/**\n");
    process.env.AGENT_BUILD_STORE = join(root, "store");
    const exec = (_cmd: string, args: string[]) => {
      if (args.join(" ") === "remote get-url origin") return "git@github.com:o/r.git\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const head = "class: R1 — operator, 2026-09-28\nflow: 2\n";
    const isTarget = resolveTargets(parseLedger(`${head}brief: store:briefs/b.md\n`), join(root, "repo"), "HEAD", { exec });
    assert.deepEqual(["src/a.ts", "briefs/b.md", "src/c.ts"].map(isTarget), [true, true, false]);
  } finally {
    if (before === undefined) delete process.env.AGENT_BUILD_STORE;
    else process.env.AGENT_BUILD_STORE = before;
    rmSync(root, { recursive: true, force: true });
  }
});

function runDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "run-dir-"));
  for (const f of files) writeFileSync(join(dir, f), "NO FINDINGS — checked\n");
  return dir;
}

test("CODEX.5: missingHandTestOutputs names each hand-test line whose output file is not in the run dir", () => {
  const dir = runDir([]);
  try {
    mkdirSync(join(dir, "hand-test-1"));
    writeFileSync(join(dir, "hand-test-1", "H1.out"), "ok\n");
    const lines = parseHandTestFile("H1 · pass · 4f1c2a9 — hand-test-1/H1.out\nH2 · pass · 4f1c2a9 — hand-test-1/H2.out\n");
    assert.deepEqual(missingHandTestOutputs(dir, lines).map((l) => l.claim), ["H2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader files: each stage reader, each slice of a split read, a named repo reader, and session.md", () => {
  const dir = runDir([
    "review-cursory-1.md",
    "review-cursory-2.md",
    "review-cursory-codex.md",
    "review-cursory-codex-2.md",
    "gate-silent-failure-hunter.md",
    "build-verifier.md",
    "security-review.md",
    "simplifier.md",
    "comment-reader.md",
    "session.md",
  ]);
  try {
    assert.deepEqual(
      readerFiles(dir, ["comment-reader"]).map((f) => [f.name, f.reader, f.slice]),
      [
        ["build-verifier.md", "build-verifier", null],
        ["comment-reader.md", "comment-reader", null],
        ["gate-silent-failure-hunter.md", "gate-silent-failure-hunter", null],
        ["review-cursory-1.md", "review-cursory", 1],
        ["review-cursory-2.md", "review-cursory", 2],
        ["review-cursory-codex-2.md", "review-cursory-codex", 2],
        ["review-cursory-codex.md", "review-cursory-codex", null],
        ["security-review.md", "security-review", null],
        ["session.md", "session", null],
        ["simplifier.md", "simplifier", null],
      ]
    );
    assert.equal(readerFiles(dir, ["comment-reader"])[0]!.path, join(dir, "build-verifier.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not reader files: a refused file, run files, flow agents, an unnamed repo reader, old-flow names, folders", () => {
  const dir = runDir([
    "review-cursory-codex.refused.txt",
    "review-cursory-codex.md.refused.txt",
    "ship.md",
    "table-1.md",
    "fix-1.txt",
    "hand-test-1.txt",
    "fixer.md",
    "hand-tester.md",
    "builder.md",
    "comment-reader.md",
    "review-cursory-codex-confirm.md",
    "confirm-review-cursory.md",
    "review-cursory.md",
  ]);
  mkdirSync(join(dir, "stage-confirm-1"));
  mkdirSync(join(dir, "security-review.md"));
  try {
    assert.deepEqual(
      readerFiles(dir).map((f) => f.name),
      ["review-cursory.md"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stage folder reads the same way; a missing folder throws", () => {
  const dir = runDir([]);
  try {
    mkdirSync(join(dir, "stage-confirm-1"));
    writeFileSync(join(dir, "stage-confirm-1", "review-cursory-codex.md"), "x");
    writeFileSync(join(dir, "stage-confirm-1", "review-cursory.md"), "x");
    assert.deepEqual(
      readerFiles(join(dir, "stage-confirm-1")).map((f) => f.reader),
      ["review-cursory-codex", "review-cursory"]
    );
    assert.throws(() => readerFiles(join(dir, "stage-last")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
