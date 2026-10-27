import "./helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runStateFile } from "../lib/runState.ts";
import { withTmpDir } from "./helpers/tmpDir.ts";

test("runStateFile: the file lives in the git common dir; 0.1.0's copy in the checkout is appended and removed", () =>
  withTmpDir("runstate-", (repo) => {
    const git = join(repo, ".git");
    const legacyDir = join(repo, ".claude", "run-state");
    mkdirSync(join(git, "agent-build"), { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(git, "agent-build", "log.jsonl"), '{"a":1}\n');
    writeFileSync(join(legacyDir, "log.jsonl"), '{"b":2}');

    const file = runStateFile("log.jsonl", () => git);

    assert.equal(file, join(git, "agent-build", "log.jsonl"));
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"b":2}\n');
    assert.equal(existsSync(legacyDir), false);
    assert.equal(runStateFile("log.jsonl", () => git), file);
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"b":2}\n');
  }));

test("runStateFile: the checkout's run-state dir stays while another file lives in it", () =>
  withTmpDir("runstate-", (repo) => {
    const legacyDir = join(repo, ".claude", "run-state");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "log.jsonl"), '{"b":2}\n');
    writeFileSync(join(legacyDir, "other.md"), "x\n");

    const file = runStateFile("log.jsonl", () => join(repo, ".git"));

    assert.equal(readFileSync(file, "utf8"), '{"b":2}\n');
    assert.equal(existsSync(join(legacyDir, "log.jsonl")), false);
    assert.equal(existsSync(join(legacyDir, "other.md")), true);
  }));
