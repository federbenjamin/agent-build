/** The neutral publishing defaults: state roots, contract thresholds, and an opt-in session log. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runRoot, storeRoot } from "../lib/repoId.ts";
import { DEFAULTS } from "../thresholds.ts";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";
import { TSX_BIN } from "./helpers/tsxBin.ts";

const REPO_ID = fileURLToPath(new URL("../lib/repoId.ts", import.meta.url));
const SESSION_LOG_PRUNE = fileURLToPath(new URL("../sessionLogPrune.ts", import.meta.url));

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

function sessionLog(branch: string): string {
  return [
    "# Session log — sid-publish",
    "",
    "## Work log",
    "",
    `- 14:00Z [${branch}] shipped`,
    "",
    "## Todo",
    "",
    "## Decisions",
    "",
  ].join("\n");
}

test("empty state-root variables use local-state defaults while non-empty values win", () => {
  const state = join(homedir(), ".local", "state", "agent-build");
  for (const value of [undefined, ""]) {
    withEnv("AGENT_BUILD_STORE", value, () => assert.equal(storeRoot(), join(state, "store"), `store ${value ?? "unset"}`));
    withEnv("AGENT_BUILD_RUN_ROOT", value, () => assert.equal(runRoot(), join(state, "runs"), `runs ${value ?? "unset"}`));
  }
  withEnv("AGENT_BUILD_STORE", "/state/store", () => assert.equal(storeRoot(), "/state/store"));
  withEnv("AGENT_BUILD_RUN_ROOT", "/state/runs", () => assert.equal(runRoot(), "/state/runs"));
});

test("the repo-id CLI ends its four-line report with the configured run root", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-id-cli-"));
  try {
    const r = spawnSync(process.execPath, [REPO_ID, dir], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BUILD_STORE: "/state/store", AGENT_BUILD_RUN_ROOT: "/state/runs", NODE_NO_WARNINGS: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "repo: none\nprofile: unset\nstore: none\nrun-root: /state/runs\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract concurrency and Codex-pair defaults are published as valid thresholds", () => {
  const values = DEFAULTS as Record<string, unknown>;
  assert.equal(values.SUBAGENT_MAX, 4);
  assert.equal(values.CODEX_MAX, 4);
  assert.equal(values.CODEX_PAIR_MIN_SIZE, "M");
  assert.equal(values.CODEX_PAIR_MIN_CLASS, "R1");
  assert.ok(
    (DEFAULTS.PR_SIZE_BUCKETS as readonly { name: string }[]).some((bucket) => bucket.name === values.CODEX_PAIR_MIN_SIZE),
    "CODEX_PAIR_MIN_SIZE names a PR_SIZE_BUCKETS entry"
  );
  assert.match(values.CODEX_PAIR_MIN_CLASS as string, /^R[0-2]$/);
});

test("a merge prune without a log or SESSION_LOGS_DIR refuses instead of searching a personal default", () => {
  const r = spawnSmoke(TSX_BIN, [SESSION_LOG_PRUNE, "--branch", "feat/publish", "--pr", "7", "--sha", "abc1234"], {
    env: withEnv("SESSION_LOGS_DIR", undefined, () => ({ ...process.env })),
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no session-logs dir: set SESSION_LOGS_DIR or pass <log>/);
});

test("a configured session-log directory still finds and prunes the branch log", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-defaults-"));
  try {
    const log = join(dir, "sid-publish.md");
    writeFileSync(log, sessionLog("feat/publish"));
    const r = spawnSmoke(TSX_BIN, [SESSION_LOG_PRUNE, "--branch", "feat/publish", "--pr", "7", "--sha", "abc1234"], {
      env: { ...process.env, SESSION_LOGS_DIR: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `pruned 1 lines → ${join(dir, "sid-publish.archive.md")}`);
    assert.match(readFileSync(log, "utf8"), /\[feat\/publish\] merged #7 \(abc1234\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
