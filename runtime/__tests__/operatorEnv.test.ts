import { STRIPPED_ENV_NAMES, STRIPPED_ENV_PREFIXES } from "./helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { firstImport } from "./helpers/firstImport.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SETUP_URL = new URL("./helpers/operatorEnv.ts", import.meta.url).href;
const SETUP = fileURLToPath(SETUP_URL);
const GLOBS = ["runtime/**/*.test.ts", "tests/**/*.test.mjs", "tests/**/*.test.ts", "graph/__tests__/*.test.ts"];
const cut = (k: string): boolean => STRIPPED_ENV_NAMES.includes(k) || STRIPPED_ENV_PREFIXES.some((p) => k.startsWith(p));

test("every test file's first import is the setup module", () => {
  const files = GLOBS.flatMap((g) => globSync(g, { cwd: root })).sort();
  assert.ok(files.includes("runtime/__tests__/buildEvent.test.ts"), "the listing finds a runtime file known to be there");
  assert.ok(files.includes("graph/__tests__/workflow.test.ts"), "the listing finds a graph file known to be there");
  const offenders = files.filter((f) => {
    const spec = firstImport(readFileSync(join(root, f), "utf8"));
    return spec === null || resolve(root, dirname(f), spec) !== SETUP;
  });
  assert.deepEqual(offenders, []);
});

test("firstImport reads the first import statement's specifier, past comments, or null", () => {
  assert.equal(firstImport('// import "./not.ts";\nconst x = "import \\"y\\"";\nexport const z = x;\n'), null);
  assert.equal(firstImport('import { a } from "./other.ts";\nimport "./helpers/operatorEnv.ts";\n'), "./other.ts");
  assert.equal(firstImport('/**\n * A doc comment that says import "x".\n */\n\nimport "./helpers/operatorEnv.ts";\nimport type { T } from "./t.ts";\n'), "./helpers/operatorEnv.ts");
});

test("after the setup, HOME is a dir of this process's own under the repo's .test-home", () => {
  assert.ok(homedir().startsWith(join(root, ".test-home") + "/"), homedir());
  assert.notEqual(homedir(), userInfo().homedir);
});

test("after the setup, git under HOME finds no repo: the ceiling keeps it out of the checkout", () => {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: process.env.HOME, encoding: "utf8" });
  assert.notEqual(r.status, 0, r.stdout);
});

test("after the setup, no variable of a cut family is set but the two the setup writes", () => {
  const left = Object.keys(process.env).filter((k) => cut(k) && k !== "GIT_CONFIG_NOSYSTEM" && k !== "GIT_CEILING_DIRECTORIES");
  assert.deepEqual(left, []);
});

test("the setup deletes a variable of every family it lists, whatever the env it starts from", () => {
  const probes = [...STRIPPED_ENV_PREFIXES.map((p) => `${p}PROBE`), ...STRIPPED_ENV_NAMES];
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(SETUP_URL)}); console.log(JSON.stringify(Object.keys(process.env)));`], {
    env: { ...process.env, ...Object.fromEntries(probes.map((k) => [k, "x"])) },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const left = (JSON.parse(r.stdout) as string[]).filter((k) => probes.includes(k));
  assert.deepEqual(left, []);
});

test("after the setup, git reads commit.gpgsign = false from HOME's gitconfig", () => {
  const repo = mkdtempSync(join(tmpdir(), "operator-env-git-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    const r = spawnSync("git", ["config", "--show-origin", "--get", "commit.gpgsign"], { cwd: repo, encoding: "utf8" });
    assert.equal(r.stdout.trim(), `file:${join(process.env.HOME!, ".gitconfig")}\tfalse`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
