import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexOnPath, FALLBACKS, resolveSteps } from "../steps.ts";
import { verdicts } from "../size.ts";
import { DEFAULTS } from "../thresholds.ts";
import { withTmpDir } from "./helpers/tmpDir.ts";

const STEPS = join(import.meta.dirname, "..", "steps.ts");

function codexStep(repo: string, env: NodeJS.ProcessEnv): { command: string | null; source: string } {
  const step = resolveSteps(repo, { env }).steps.find((entry) => entry.step === "codex_role");
  assert.ok(step, "the steps table contains codex_role");
  return step;
}

test("a missing or non-executable codex never makes the optional step available", () => {
  withTmpDir("codex-path-", (dir) => {
    assert.equal(codexOnPath({ PATH: dir }), false, "an empty PATH entry has no codex");
    writeFileSync(join(dir, "codex"), "not executable\n");
    chmodSync(join(dir, "codex"), 0o644);
    assert.equal(codexOnPath({ PATH: dir }), false, "a non-executable file cannot launch Codex");
  });
});

test("an executable codex in any PATH entry enables the optional fallback", () => {
  withTmpDir("codex-path-", (dir) => {
    writeFileSync(join(dir, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "codex"), 0o755);
    assert.equal(codexOnPath({ PATH: `/missing:${dir}` }), true);
  });
});

test("only the unmapped codex role disappears without Codex; every other step stays resolved", () => {
  withTmpDir("codex-steps-", (repo) => {
    const noCodex = resolveSteps(repo, { env: { PATH: join(repo, "empty") } });
    const codexDir = join(repo, "bin");
    mkdirSync(codexDir);
    writeFileSync(join(codexDir, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(codexDir, "codex"), 0o755);
    const withCodex = resolveSteps(repo, { env: { PATH: codexDir } });

    assert.deepEqual(
      noCodex.steps.filter((step) => step.step !== "codex_role"),
      withCodex.steps.filter((step) => step.step !== "codex_role")
    );
    assert.deepEqual(codexStep(repo, { PATH: join(repo, "empty") }), {
      step: "codex_role",
      command: null,
      source: "fallback",
    });
    assert.deepEqual(codexStep(repo, { PATH: codexDir }), {
      step: "codex_role",
      command: FALLBACKS.codex_role,
      source: "fallback",
    });
  });
});

test("a repository-mapped Codex role stays available even when Codex is absent", () => {
  withTmpDir("codex-steps-", (repo) => {
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "build-steps.toml"), 'codex_role = "node scripts/role.ts"\n');
    for (const env of [{ PATH: join(repo, "empty") }, { PATH: join(repo, "also-empty") }]) {
      assert.deepEqual(codexStep(repo, env), {
        step: "codex_role",
        command: "node scripts/role.ts",
        source: "repo",
      });
    }
  });
});

test("the absent-Codex CLI table and get command say the step is unavailable", () => {
  withTmpDir("codex-steps-", (repo) => {
    const env = { ...process.env, PATH: join(repo, "empty") };
    const table = spawnSync(process.execPath, [STEPS, repo], { encoding: "utf8", env });
    assert.equal(table.status, 0, table.stderr);
    assert.match(table.stdout, /^codex_role\s+fallback\s+\(none: codex not on PATH\)$/m);

    const get = spawnSync(process.execPath, [STEPS, repo, "--get", "codex_role"], {
      encoding: "utf8",
      env,
    });
    assert.equal(get.status, 0, get.stderr);
    assert.equal(get.stdout, "(none)\n");
  });
});

test("a missing codex role skips paired reads before class and size can decide", () => {
  const buckets = DEFAULTS.PR_SIZE_BUCKETS;
  for (const [counted, cls] of [
    [0, null],
    [2_000, "R2"],
  ] as const) {
    assert.equal(
      verdicts({ counted, byDir: {} }, buckets, "M", cls, "M", "R1", false).pair,
      "codex pair: skipped (no codex_role step)"
    );
  }
});

test("an available codex role keeps the established class-and-size pair verdicts", () => {
  const buckets = DEFAULTS.PR_SIZE_BUCKETS;
  assert.equal(
    verdicts({ counted: 12, byDir: { src: 12 } }, buckets, "M", "R0", "M", "R1", true).pair,
    "codex pair: skipped (R0, S — needs ≥ R1 and ≥ M)"
  );
  assert.equal(
    verdicts({ counted: 150, byDir: { src: 150 } }, buckets, "M", "R1", "M", "R1", true).pair,
    "codex pair: fires (R1, M)"
  );
  assert.equal(
    verdicts({ counted: 0, byDir: {} }, buckets, "M", null, "M", "R1", true).pair,
    "codex pair: undecided — pass --class R<n>"
  );
});
