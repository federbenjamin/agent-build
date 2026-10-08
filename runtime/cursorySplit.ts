#!/usr/bin/env node
/**
 * cursorySplit — where to cut a wave's `review-cursory` read in two (CLOSE §The readers: above
 * `WAVE_CURSORY_SPLIT_LINES`, two spawns with exclusive slices, cut at the folder boundary closest to
 * half the counted lines). It runs the repo's `size` step once per changed file, in the step's own
 * currency, and sums the counts into every folder at every depth, so the cut is read off, never
 * measured by hand.
 *
 *   node ~/.agent-build/runtime/cursorySplit.ts --diff-file <inputs-dir>/diff.patch
 *
 * Prints `total <n> counted lines · half <h>`, one `<folder>/ <n>` line per folder that counts, and
 * `cut: slice 1 = <folder>/ (<n>) · slice 2 = the rest (<m>)` — the folder whose count is nearest
 * half (the shallower one on a tie). Exit 0 · 2 usage, or a size run that failed (a tsx step inside
 * the sandbox: re-run it outside).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { assertKnownFlags, takeValue } from "./lib/cliArgs.ts";
import { isMain } from "./lib/isMain.ts";
import { whyLine } from "./lib/signalsArms.ts";
import { stepCommand } from "./steps.ts";

/** Size runs at once: each is a short diff read, most of it process start-up. */
const JOBS = 6;
const COUNTED = /^\[[^\]]+\]\s+(\d+(?:\.\d+)?) counted lines/;

/** A unified diff cut into one patch per file, keyed by its post-image path (pre-image on a delete). */
export function splitPatch(diff: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (m) out.push({ path: chunk.includes("\n+++ /dev/null") ? m[1]! : m[2]!, text: chunk });
  }
  return out;
}

/** Every folder's summed count, at every depth; files at the repo root sit in no folder. */
export function folderCounts(perFile: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [path, n] of perFile) {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const folder = `${parts.slice(0, i).join("/")}/`;
      out.set(folder, (out.get(folder) ?? 0) + n);
    }
  }
  return out;
}

/** The folder whose count is nearest half the total; the shallower, then the first by name, on a tie. */
export function bestCut(folders: ReadonlyMap<string, number>, total: number): { folder: string; n: number } | null {
  let best: { folder: string; n: number } | null = null;
  const depth = (f: string) => f.split("/").length;
  for (const [folder, n] of [...folders].sort((a, b) => depth(a[0]) - depth(b[0]) || a[0].localeCompare(b[0]))) {
    if (n <= 0 || n >= total) continue;
    if (best === null || Math.abs(n - total / 2) < Math.abs(best.n - total / 2)) best = { folder, n };
  }
  return best;
}

function runSize(command: string, file: string, cwd: string): Promise<{ n: number } | { error: string }> {
  return new Promise((done) => {
    const child = spawn("/bin/sh", ["-c", `${command} --diff-file '${file.replaceAll("'", `'\\''`)}'`], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => done({ error: e.message }));
    child.on("close", (code) => {
      const m = stdout.split("\n").map((l) => COUNTED.exec(l.trim())).find(Boolean);
      if (code === 0 && m) done({ n: Number(m[1]) });
      else done({ error: code === 0 ? "printed no `[<bucket>] <n> counted lines` line" : `exited ${code}: ${whyLine(stderr)}` });
    });
  });
}

export async function main(argv: string[], cwd = process.cwd(), out = (l: string) => console.log(l)): Promise<number> {
  let diffFile: string | undefined;
  try {
    const r = takeValue(argv, "--diff-file");
    assertKnownFlags(r.rest, []);
    if (r.rest.length > 0) throw new Error(`unexpected argument(s): ${r.rest.join(" ")}`);
    diffFile = r.value;
  } catch (e) {
    console.error(`cursorySplit: ${(e as Error).message}`);
  }
  if (diffFile === undefined) {
    console.error("usage: cursorySplit.ts --diff-file <patch>");
    return 2;
  }
  const command = stepCommand(cwd, "size");
  if (command === null) {
    console.error("cursorySplit: the repo maps no size step");
    return 2;
  }
  const files = splitPatch(readFileSync(resolve(cwd, diffFile), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "cursory-split-"));
  const perFile = new Map<string, number>();
  const failed: string[] = [];
  try {
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        const patch = join(dir, `${i}.patch`);
        writeFileSync(patch, files[i]!.text);
        const r = await runSize(command, patch, cwd);
        if ("n" in r) perFile.set(files[i]!.path, (perFile.get(files[i]!.path) ?? 0) + r.n);
        else failed.push(`${files[i]!.path}: \`${command}\` ${r.error}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed.length > 0) {
    const shown = failed.sort().slice(0, 3);
    for (const f of shown) console.error(`cursorySplit: size step failed on ${f}`);
    if (failed.length > shown.length) console.error(`cursorySplit: … and on ${failed.length - shown.length} more files`);
    console.error("cursorySplit: a tsx size step refused inside the sandbox runs outside it (dangerouslyDisableSandbox)");
    return 2;
  }
  const total = [...perFile.values()].reduce((a, b) => a + b, 0);
  const folders = folderCounts(perFile);
  out(`total ${total} counted lines · half ${total / 2}`);
  for (const [folder, n] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) if (n > 0) out(`${folder} ${n}`);
  const cut = bestCut(folders, total);
  out(cut === null ? "cut: none — no folder holds part of the counted lines; slice by file" : `cut: slice 1 = ${cut.folder} (${cut.n}) · slice 2 = the rest (${total - cut.n})`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
