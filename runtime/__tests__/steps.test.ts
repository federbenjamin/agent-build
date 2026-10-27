/** steps.ts --template: the build-steps.toml a new repo starts from, and the one writer of it. */
import "./helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FALLBACKS, resolveSteps, stepsTemplate } from "../steps.ts";

const STEPS = join(import.meta.dirname, "..", "steps.ts");

test("--template prints a file that names only known steps, all commented out, and parses as no steps", () => {
  const text = stepsTemplate("acme");
  assert.match(text, /^# acme's build steps/);
  const keys = [...text.matchAll(/^# ([a-z_]+)\s+= ""/gm)].map((m) => m[1]!);
  assert.deepEqual(keys, ["install", "checks", "exit_checks", "tests", "notes"]);
  for (const k of keys) assert.ok(k in FALLBACKS, `${k} is a step steps.ts knows`);
  const dir = mkdtempSync(join(tmpdir(), "build-steps-template-"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude/build-steps.toml"), text);
  const r = resolveSteps(dir);
  assert.equal(r.found, true);
  assert.ok(r.steps.every((s) => s.source === "fallback"), "a template leaves every step on its fallback");

  const cli = spawnSync("node", [STEPS, "--template", "acme"], { encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.equal(cli.stdout, text);
  const noName = spawnSync("node", [STEPS, "--template"], { encoding: "utf8" });
  assert.equal(noName.status, 2);
  assert.match(noName.stderr, /--template needs the repo's name/);
});

test("resolveSteps hands a given env to the git probes it makes", () => {
  const dir = mkdtempSync(join(tmpdir(), "steps-env-"));
  const env = { PATH: process.env.PATH, ONLY: "this" };
  try {
    execFileSync("git", ["init", "-q", dir]);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "env.log");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$ONLY" >> ${log}\nexec ${execFileSync("which", ["git"], { encoding: "utf8" }).trim()} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    process.env.ONLY = "ours-should-not-reach-git";
    resolveSteps(dir, { env: { ...env, PATH: `${bin}:${env.PATH}` } });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(lines.length >= 1);
    assert.ok(lines.every((l) => l === "this"), lines.join(","));
  } finally {
    delete process.env.ONLY;
    rmSync(dir, { recursive: true, force: true });
  }
});
