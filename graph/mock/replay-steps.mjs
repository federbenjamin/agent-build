#!/usr/bin/env node
// A mock stand-in repo's steps (its .claude/build-steps.toml names this script). Each call of a step
// prints and exits as the recorded run's call of that step did (.build/replay.json: `steps`, by step,
// a list of { exit, out }, read by call number, the last repeating), and where the recorded run saw
// main move, this call moves the stand-in's main to that move's tag (`moves`: { on, call, tag }).
// The call counts live in the repo's git dir, so every worktree of one stand-in shares them.
//   node .build/replay-steps.mjs <step>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const step = process.argv[2];
if (!step) {
  console.error("usage: replay-steps.mjs <step>");
  process.exit(2);
}
const replay = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "replay.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const countsFile = join(resolve(git("rev-parse", "--git-common-dir")), "mock-replay-counts.json");
const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, "utf8")) : {};
const call = (counts[step] ?? 0) + 1;
counts[step] = call;
writeFileSync(countsFile, `${JSON.stringify(counts)}\n`);

for (const m of replay.moves ?? []) {
  if (m.on === step && m.call === call) git("update-ref", "refs/heads/main", `${m.tag}^{commit}`);
}
const list = replay.steps?.[step] ?? [{ exit: 0, out: `${step}: ok (no recorded output)` }];
const r = list[Math.min(call, list.length) - 1];
process.stdout.write(`${r.out}\n`);
process.exit(r.exit);
