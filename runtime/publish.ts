#!/usr/bin/env node
// Publishes this repo's main to the public one its `.claude-plugin/plugin.json` names as `repository`:
// the tree of the commit at `origin/main`, exported with `git archive`, minus `EXCLUDED`, as one
// commit on a `chore/sync-<sha>` branch cut from the public repo's main, and a PR. The bytes it scans
// are the bytes it pushes: both come from that export, never from the working tree. The public repo
// keeps its own history, because people have clones of it, so a sync never rewrites it. The commit
// replaces the public tree whole: a file only the public repo has is deleted unless it is on this
// repo first.
// Refuses, before anything leaves the machine: a dirty tree, a HEAD that is not `origin/main` once
// main is fetched, and an exported line that holds a macOS home path or a real-ticket citation (the
// rules live in `lib/privateText.ts`). `--dry-run` prints what it excluded and stops before the clone.
//   node publish.ts [repo-dir] [--dry-run]
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { assertKnownFlags } from "./lib/cliArgs.ts";
import { ghOut, gitOk, gitOut, runOut } from "./lib/gitOps.ts";
import { isMain } from "./lib/isMain.ts";
import { type LineHit, privateLines, RULE_TEXT } from "./lib/privateText.ts";

/** The folders that stay in the private repo: old briefs, and recorded runs from private repos. */
export const EXCLUDED: readonly string[] = ["docs/build/", "graph/fixtures/"];

/** `files` (repo-relative) split into what the export keeps and what `EXCLUDED` holds back. */
export function splitTracked(files: readonly string[]): { kept: string[]; excluded: string[] } {
  const held = (f: string): boolean => EXCLUDED.some((dir) => f.startsWith(dir));
  return { kept: files.filter((f) => !held(f)), excluded: files.filter(held) };
}

export interface FileHit extends LineHit {
  file: string;
}

/** Every private-text hit in `files` under `root`; a file holding a NUL byte is binary and skipped. */
export function privateTextHits(root: string, files: readonly string[]): FileHit[] {
  return files.flatMap((file) => {
    const text = readFileSync(join(root, file), "utf8");
    return text.includes("\0") ? [] : privateLines(text, file).map((hit) => ({ file, ...hit }));
  });
}

/** `owner/name` of the GitHub repo in the plugin manifest's `repository` URL. */
export function publicRepo(root: string): string {
  const manifest = join(root, ".claude-plugin", "plugin.json");
  const url = (JSON.parse(readFileSync(manifest, "utf8")) as { repository?: unknown }).repository;
  const m = typeof url === "string" ? url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/) : null;
  if (m === null) throw new Error(`${manifest}: repository is not a https://github.com/<owner>/<name> URL`);
  return m[1]!;
}

/** The commit to publish: HEAD, once `git fetch origin main` shows it is `origin/main`; throws otherwise. */
function mainHead(root: string): string {
  gitOut(["fetch", "-q", "origin", "main"], { cwd: root });
  const head = gitOut(["rev-parse", "HEAD"], { cwd: root }).trim();
  const main = gitOut(["rev-parse", "refs/remotes/origin/main"], { cwd: root }).trim();
  if (head !== main) throw new Error(`refusing: HEAD is ${head}, not origin/main (${main}); a publish is of main, so check out main at origin/main first`);
  return head;
}

/** Commit `sha`'s tree, extracted under `into` by `git archive` (file modes kept), and its file list. */
function exportCommit(root: string, sha: string, into: string): string[] {
  mkdirSync(into, { recursive: true });
  const tar = `${into}.tar`;
  gitOut(["archive", "--format=tar", "-o", tar, sha], { cwd: root });
  runOut("tar", ["-xf", tar, "-C", into]);
  return gitOut(["ls-tree", "-r", "-z", "--name-only", sha], { cwd: root }).split("\0").filter(Boolean);
}

function publish(root: string, dryRun: boolean): void {
  const status = gitOut(["status", "--porcelain"], { cwd: root });
  if (status.trim() !== "") throw new Error(`refusing: the tree is dirty; commit or remove these first:\n${status}`);
  const head = mainHead(root);

  const tmp = mkdtempSync(join(tmpdir(), "publish-"));
  try {
    const tree = join(tmp, "export");
    const { kept, excluded } = splitTracked(exportCommit(root, head, tree));
    const hits = privateTextHits(tree, kept);
    if (hits.length > 0) {
      const lines = hits.map((h) => `${h.file}:${h.line} — ${RULE_TEXT[h.rule]} (${h.match})`);
      throw new Error(`refusing: these lines hold private text; reword or remove them first:\n${lines.join("\n")}`);
    }

    const target = publicRepo(tree);
    const sha = gitOut(["rev-parse", "--short", head], { cwd: root }).trim();
    const branch = `chore/sync-${sha}`;
    if (dryRun) {
      console.log(`excluded ${excluded.length} files (${EXCLUDED.join(", ")}):`);
      for (const f of excluded) console.log(`  ${f}`);
      console.log(`would publish ${kept.length} files to ${target} on ${branch}`);
      return;
    }

    const source = basename(gitOut(["remote", "get-url", "origin"], { cwd: root }).trim()).replace(/\.git$/, "");
    const title = `chore: sync from ${source} main at ${sha}`;
    const clone = join(tmp, "public");
    ghOut(["repo", "clone", target, clone, "--", "--quiet"]);
    gitOut(["switch", "-q", "-c", branch], { cwd: clone });
    for (const f of gitOut(["ls-files", "-z"], { cwd: clone }).split("\0").filter(Boolean)) unlinkSync(join(clone, f));
    for (const f of kept) {
      const to = join(clone, f);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(tree, f), to);
      chmodSync(to, statSync(join(tree, f)).mode);
    }
    gitOut(["add", "-A"], { cwd: clone });
    if (gitOk(["diff", "--cached", "--quiet"], { cwd: clone })) {
      console.log(`${target} already matches ${source} main at ${sha}: nothing to publish`);
      return;
    }
    gitOut(["commit", "-q", "-m", title], { cwd: clone });
    gitOut(["push", "-q", "-u", "origin", branch], { cwd: clone });
    const body = [
      "## What it does",
      "",
      `Brings the public repo up to ${source} main at ${sha}: its tracked tree minus ${EXCLUDED.map((d) => `\`${d}\``).join(" and ")}, published by \`runtime/publish.ts\`, which found no macOS home path and no real-ticket citation in it.`,
      "",
    ].join("\n");
    const url = ghOut(["pr", "create", "-R", target, "--base", "main", "--head", branch, "--title", title, "--body", body], { cwd: clone });
    console.log(url.trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    assertKnownFlags(args, ["--dry-run"]);
    publish(resolve(args.find((a) => !a.startsWith("--")) ?? "."), args.includes("--dry-run"));
  } catch (e) {
    console.error(`publish: ${(e as Error).message}`);
    process.exit(1);
  }
}
