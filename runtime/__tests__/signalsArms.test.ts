/** signalsArms: a repo's `--app-code` / `--fix-security` arms, the fallbacks when a repo has none,
 *  and `prCode` over a real fixture repo. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { logicChangedPaths } from "../lib/logicPaths.ts";
import {
  appCodePaths,
  armEnvFailure,
  type ArmDeps,
  diffChangedPaths,
  FIX_SECURITY_FALLBACK_REASON,
  fixSecurity,
  parseArmOutput,
  prCode,
  whyLine,
} from "../lib/signalsArms.ts";

// A new-style arm: app code is `src/**` with a changed line that is not blank or a `//` comment;
// fix security fires on any path holding `auth`. Anything else is refused with exit 2.
const NEW_ARM = `import { readFileSync } from "node:fs";
const [arm, file] = process.argv.slice(2);
if (arm !== "--app-code" && arm !== "--fix-security") {
  console.error("fake: unknown flag(s): " + arm);
  process.exit(2);
}
const logic = new Set();
const paths = new Set();
let path = null;
for (const line of readFileSync(file, "utf8").split("\\n")) {
  const m = /^diff --git a\\/\\S+ b\\/(.+)$/.exec(line);
  if (m) { path = m[1]; paths.add(path); continue; }
  if (line.startsWith("+++") || line.startsWith("---")) continue;
  if (path && (line.startsWith("+") || line.startsWith("-"))) {
    const t = line.slice(1).trim();
    if (t !== "" && !t.startsWith("//")) logic.add(path);
  }
}
const out = arm === "--app-code"
  ? [...logic].filter((p) => p.startsWith("src/")).map((p) => "app-code: " + p)
  : [...paths].filter((p) => p.includes("auth")).map((p) => "fires: path " + p);
console.log(out.length ? out.join("\\n") : arm === "--app-code" ? "none" : "quiet");
`;

// An old-style arm: it knows only --signals and refuses any other flag with exit 2, as a repo's
// own risk-class script did before the two arms existed.
const OLD_ARM = `const [arm] = process.argv.slice(2);
if (arm !== "--signals") {
  console.error("npm warn Unknown project config \\"x\\".");
  console.error("riskClass: unknown flag(s): " + arm + " — known: --signals, --paths, --text");
  process.exit(2);
}
console.log("none");
`;

function withRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "signals-arms-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A repo whose `signals` step is `node <arm file>`. */
function mapSignals(dir: string, armSource: string): void {
  write(dir, "arm.mjs", armSource);
  write(dir, ".claude/build-steps.toml", `signals = "node ${join(dir, "arm.mjs")}"\n`);
}

const fileDiff = (path: string, minus: string, plus: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${minus}`,
    `+${plus}`,
    "",
  ].join("\n");

const MIXED = [
  fileDiff("src/a.ts", "export const a = 1;", "export const a = 2;"),
  fileDiff("src/b.ts", "// old", "// new"),
  fileDiff("docs/x.md", "old", "new"),
  fileDiff("a.test.ts", "x", "y"),
  fileDiff("src/auth.ts", "const t = 1;", "const t = 2;"),
].join("");

// ── the repo's arm ────────────────────────────────────────────────────────────

test("a repo arm that answers is the answer: source repo, its paths, a comment-only file left out", () => {
  withRepo((dir) => {
    mapSignals(dir, NEW_ARM);
    const app = appCodePaths(dir, MIXED);
    assert.deepEqual(app.paths, ["src/a.ts", "src/auth.ts"]);
    assert.equal(app.source, "repo");
    assert.match(app.note, /^repo arm `node .*arm\.mjs --app-code` exited 0$/);
    const sec = fixSecurity(dir, MIXED);
    assert.deepEqual(sec, {
      fires: true,
      reasons: ["path src/auth.ts"],
      source: "repo",
      note: `repo arm \`node ${join(dir, "arm.mjs")} --fix-security\` exited 0`,
      failure: null,
    });
    assert.equal(fixSecurity(dir, fileDiff("src/a.ts", "a", "b")).fires, false, "quiet is not a fire");
  });
});

// ── the fallbacks ─────────────────────────────────────────────────────────────

test("a signals step that exits 2 on the unknown flag gives the fallback, and the note names the exit", () => {
  withRepo((dir) => {
    mapSignals(dir, OLD_ARM);
    const app = appCodePaths(dir, MIXED);
    assert.equal(app.source, "fallback");
    assert.deepEqual(app.paths, ["src/a.ts", "src/auth.ts", "src/b.ts"], "no comment detection in the fallback");
    assert.match(app.note, /^fallback — `node .*arm\.mjs --app-code` exited 2: riskClass: unknown flag\(s\): --app-code/);
    const sec = fixSecurity(dir, MIXED);
    assert.equal(sec.source, "fallback");
    assert.equal(sec.fires, true);
    assert.deepEqual(sec.reasons, [FIX_SECURITY_FALLBACK_REASON]);
    assert.match(sec.note, /exited 2: riskClass: unknown flag\(s\): --fix-security.*; any changed path fires$/);
  });
});

test("a repo with no signals step gives the fallback: every changed path but tests, prose, and lockfiles", () => {
  withRepo((dir) => {
    const diff = [fileDiff("src/a.ts", "a", "b"), fileDiff("docs/x.md", "a", "b"), fileDiff("a.test.ts", "a", "b")].join("");
    const app = appCodePaths(dir, diff);
    assert.deepEqual(app, {
      paths: ["src/a.ts"],
      source: "fallback",
      note: "fallback — the repo maps no signals step; every changed path outside tests, prose, and lockfiles, no comment detection",
      failure: null,
    });
    const sec = fixSecurity(dir, diff);
    assert.equal(sec.source, "fallback");
    assert.deepEqual(sec.reasons, [FIX_SECURITY_FALLBACK_REASON]);
  });
});

test("an arm whose output fits neither grammar, or that cannot run, gives the fallback", () => {
  const says = (stdout: string): ArmDeps => ({
    signalsCommand: () => "arm",
    runArm: () => ({ status: 0, stdout, stderr: "" }),
  });
  const misfit = appCodePaths("/nowhere", MIXED, says("security-path: src/auth.ts\n"));
  assert.equal(misfit.source, "fallback");
  assert.match(misfit.note, /printed neither `app-code: <path>` lines nor `none`/);
  assert.equal(fixSecurity("/nowhere", MIXED, says("none\n")).source, "fallback", "`none` is not the fix-security grammar");
  assert.equal(fixSecurity("/nowhere", MIXED, says("")).source, "fallback", "empty stdout fits no grammar");
  const hung = fixSecurity("/nowhere", MIXED, {
    signalsCommand: () => "arm",
    runArm: () => ({ status: null, stdout: "", stderr: "", error: "spawnSync /bin/sh ETIMEDOUT" }),
  });
  assert.equal(hung.source, "fallback");
  assert.match(hung.note, /^fallback — `arm --fix-security` did not run: spawnSync \/bin\/sh ETIMEDOUT/);
});

test("the fix-security fallback fires on any changed path and on nothing for an empty diff", () => {
  const none: ArmDeps = { signalsCommand: () => null };
  assert.equal(fixSecurity("/nowhere", fileDiff("README.md", "a", "b"), none).fires, true);
  const empty = fixSecurity("/nowhere", "", none);
  assert.equal(empty.fires, false);
  assert.deepEqual(empty.reasons, []);
  assert.match(empty.note, /an empty diff fires nothing$/);
});

test("parseArmOutput: the empty word alone, or only item lines; anything mixed is no arm", () => {
  assert.deepEqual(parseArmOutput("--app-code", "none\n"), []);
  assert.deepEqual(parseArmOutput("--app-code", "app-code: a b.ts\n\napp-code: c.ts\n"), ["a b.ts", "c.ts"]);
  assert.equal(parseArmOutput("--app-code", "none\napp-code: c.ts\n"), null);
  assert.equal(parseArmOutput("--fix-security", "fires: path x\nquiet\n"), null);
  assert.deepEqual(parseArmOutput("--fix-security", "quiet"), []);
});

test("whyLine skips npm warnings and prefers the line that opens with an error name", () => {
  assert.equal(whyLine("npm warn Unknown config\nriskClass: unknown flag(s): --x\n"), "riskClass: unknown flag(s): --x");
  assert.equal(
    whyLine("npm warn x\nnode:net:1917\n      const error = new UVException(rval);\nError: listen EPERM: operation not permitted\n"),
    "Error: listen EPERM: operation not permitted"
  );
});

test("diffChangedPaths takes the post-image path, the pre-image one for a deletion, and a rename's target", () => {
  const diff = [
    fileDiff("src/a.ts", "a", "b"),
    // A name holding " b/" defeats the header line; the `---` line still names it.
    "diff --git a/src/x b/gone.ts b/src/x b/gone.ts\ndeleted file mode 100644\n--- a/src/x b/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
    "diff --git a/src/o b/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/o b/old.ts\nrename to src/new.ts\n",
  ].join("");
  assert.deepEqual(diffChangedPaths(diff), ["src/a.ts", "src/x b/gone.ts", "src/new.ts"]);
});

// ── prCode over a fixture repo ────────────────────────────────────────────────

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

test("prCode: a comment-only change and a main commit merged in do not count, on a target too; a target's logic change counts", () => {
  withRepo((dir) => {
    git(dir, "init", "-q", "-b", "main");
    mapSignals(dir, NEW_ARM);
    const start = commit(
      dir,
      {
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "// b\nexport const b = 1;\n",
        "src/t.ts": "// t\nexport const t = 1;\n",
        "src/c.ts": "export const c = 1;\n",
      },
      "base"
    );
    git(dir, "checkout", "-q", "-b", "quick/x");
    commit(dir, { "src/b.ts": "// b, reworded\nexport const b = 1;\n" }, "comment only");
    git(dir, "checkout", "-q", "main");
    commit(dir, { "src/c.ts": "export const c = 2;\n" }, "main moves on");
    git(dir, "checkout", "-q", "quick/x");
    git(dir, "-c", "user.name=t", "merge", "-q", "--no-edit", "main");
    commit(dir, { "src/t.ts": "// t, reworded\nexport const t = 1;\n" }, "comment on a target");

    const r = prCode(dir, start, "HEAD", "main", ["src/t.ts"], null);
    assert.equal(r.source, "repo");
    assert.equal(r.commits.length, 2, "the merge and main's commit are not branch-own");
    assert.deepEqual(r.appCode, []);
    assert.deepEqual(r.targets, [], "a comment-only change to a target is no change");
    assert.deepEqual(r.paths, []);

    const noTargets = prCode(dir, start, "HEAD", "main", [], null);
    assert.deepEqual(noTargets.paths, [], "comment-only changes outside the targets are not the PR's code");

    const all = prCode(dir, start, "HEAD", "main", "all", null);
    assert.deepEqual(all.paths, [], "--from-branch: every path is a target, and the branch changed only comments; main's src/c.ts is not branch-own");

    const mid = git(dir, "rev-parse", "HEAD");
    commit(dir, { "src/a.ts": "export const a = 2;\n", "src/t.ts": "// t, reworded\nexport const t = 2;\n" }, "logic");
    const after = prCode(dir, mid, "HEAD", "main", ["src/t.ts"], null);
    assert.deepEqual(after.paths, ["src/a.ts", "src/t.ts"]);
    assert.deepEqual(after.targets, ["src/t.ts"], "a target's logic change counts");
    assert.deepEqual(prCode(dir, "HEAD", "HEAD", "main", [], null).paths, [], "an empty range changed nothing");
  });
});

test("prCode on targets outside app code: an identical rename is no change; a rename with an edit and a changed path string count", () => {
  withRepo((dir) => {
    git(dir, "init", "-q", "-b", "main");
    mapSignals(dir, NEW_ARM);
    const body = (n: number) => Array.from({ length: 20 }, (_, i) => `test("case ${i}", () => ${n});`).join("\n") + "\n";
    const start = commit(
      dir,
      {
        "scripts/a.test.ts": body(1),
        "scripts/b.test.ts": body(2),
        "scripts/map.json": '{ "suite": "scripts/a.test.ts" }\n',
        "scripts/c.ts": "/* c\n   the c helper */\nexport const c = 1;\n",
      },
      "base"
    );
    git(dir, "checkout", "-q", "-b", "quick/x");
    const targets = ["scripts/**"];
    const since = (from: string) => prCode(dir, from, "HEAD", "main", targets, null);

    git(dir, "mv", "scripts/a.test.ts", "scripts/a2.test.ts");
    git(dir, "commit", "-q", "-m", "rename a at 100%");
    assert.deepEqual(since(start).targets, [], "an identical rename changes neither path");
    assert.deepEqual(prCode(dir, start, "HEAD", "main", ["scripts/a.test.ts"], null).targets, [], "listed by its old path");
    assert.deepEqual(prCode(dir, start, "HEAD", "main", ["scripts/a2.test.ts"], null).targets, [], "listed by its new path");

    let from = git(dir, "rev-parse", "HEAD");
    commit(dir, { "scripts/c.ts": "/* c\n   the c helper, reworded */\n\nexport const c = 1;\n" }, "block comment and a blank line");
    assert.deepEqual(since(from).targets, [], "a block-comment and blank-line change is no change");

    from = git(dir, "rev-parse", "HEAD");
    git(dir, "mv", "scripts/b.test.ts", "scripts/b2.test.ts");
    commit(dir, { "scripts/b2.test.ts": body(2).replace("case 0", "case zero") }, "rename b with one line changed");
    assert.deepEqual(since(from).targets, ["scripts/b.test.ts", "scripts/b2.test.ts"], "a rename below 100% counts, both paths");

    from = git(dir, "rev-parse", "HEAD");
    commit(dir, { "scripts/map.json": '{ "suite": "scripts/a2.test.ts" }\n' }, "repoint the map");
    assert.deepEqual(since(from).targets, ["scripts/map.json"], "a changed path string counts");
    assert.deepEqual(since(start).appCode, [], "none of it is app code");
  });
});

test("logicChangedPaths: comments, blanks, and identical renames hold no logic; code, markdown, a mode change, and an empty file do", () => {
  const section = (path: string, lines: string[], context: string[] = []) =>
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,2 @@", ...context.map((c) => ` ${c}`), ...lines].join("\n");
  assert.deepEqual(logicChangedPaths(section("a.ts", ["-// old", "+// new", "+", "+  /* one line */"])), []);
  assert.deepEqual(logicChangedPaths(section("a.ts", ["+/* a", "+ b", "+*/"])), [], "a block comment opened in the hunk");
  assert.deepEqual(logicChangedPaths(section("a.ts", ["+ b */ export const x = 1;"], ["/* a"])), ["a.ts"], "code after a closer on a context-opened block");
  assert.deepEqual(logicChangedPaths(section("a.ts", ["+/* a */ const x = 1;"])), ["a.ts"], "code after a one-line block");
  assert.deepEqual(logicChangedPaths(section("run.sh", ["+# note"])), []);
  assert.deepEqual(logicChangedPaths(section("q.sql", ["+-- note"])), []);
  assert.deepEqual(logicChangedPaths(section("a.md", ["+# Heading"])), ["a.md"], "markdown has no comment syntax here");
  assert.deepEqual(logicChangedPaths(section("x.ts", ["+--- not a header"])), ["x.ts"], "a body line opening --- is a changed line");
  const rename = ["diff --git a/o.ts b/n.ts", "similarity index 100%", "rename from o.ts", "rename to n.ts"].join("\n");
  assert.deepEqual(logicChangedPaths(rename), []);
  assert.deepEqual(logicChangedPaths(`${rename.replace("similarity index 100%", "old mode 100644\nnew mode 100755\nsimilarity index 100%")}`), ["o.ts", "n.ts"], "a rename that changes the mode");
  assert.deepEqual(logicChangedPaths("diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755"), ["s.sh"]);
  assert.deepEqual(logicChangedPaths("diff --git a/e.ts b/e.ts\nnew file mode 100644\nindex 0000000..e69de29"), ["e.ts"], "an empty file added");
  assert.deepEqual(logicChangedPaths("diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ"), ["i.png"]);
});

test("fix4: the brief (or a --from-branch hand-test file) is never the PR's code, even listed as a target", () => {
  withRepo((dir) => {
    git(dir, "init", "-q", "-b", "main");
    mapSignals(dir, NEW_ARM);
    commit(dir, { "src/a.ts": "export const a = 1;\n" }, "base");
    git(dir, "checkout", "-q", "-b", "quick/x");
    const briefed = commit(dir, { "docs/briefs/quick-x.md": "class: R1\n" }, "brief: quick-x");
    commit(dir, { "docs/briefs/quick-x.md": "class: R1\n\n## Hand test\n" }, "amend brief: the claim named a missing event");
    const targets = ["docs/briefs/quick-x.md", "src/a.ts"];
    assert.deepEqual(prCode(dir, briefed, "HEAD", "main", targets, "docs/briefs/quick-x.md").paths, [], "an amend brief: is not a code change");
    assert.deepEqual(prCode(dir, briefed, "HEAD", "main", "all", "docs/briefs/quick-x.md").paths, [], "nor on --from-branch, where every path is a target");
    assert.deepEqual(prCode(dir, briefed, "HEAD", "main", targets, null).paths, ["docs/briefs/quick-x.md"], "control: with no brief named, the target counts");
    commit(dir, { "src/a.ts": "export const a = 2;\n" }, "logic");
    assert.deepEqual(prCode(dir, briefed, "HEAD", "main", targets, "docs/briefs/quick-x.md").paths, ["src/a.ts"]);
  });
});

// ── armEnvFailure: a fallback the environment caused, not the repo ────────────

test("armEnvFailure names an arm that could not run here, and stays silent on a fallback the repo owes", () => {
  const through = (run: ArmDeps["runArm"], command: string | null = "npx tsx scripts/lib/riskClass.ts") => {
    const deps: ArmDeps = { signalsCommand: () => command, ...(run ? { runArm: run } : {}) };
    return [appCodePaths("/nowhere", MIXED, deps), fixSecurity("/nowhere", MIXED, deps)];
  };
  const ran = (status: number | null, stderr: string, error?: string) => () => ({
    status,
    stdout: "",
    stderr,
    ...(error ? { error } : {}),
  });
  const env = [
    ran(1, "npm warn exec x\nError: listen EPERM: operation not permitted /var/folders/x/tsx-501/12.pipe\n    at Server.setupListenHandle"),
    ran(null, "", "spawnSync /bin/sh EPERM"),
    ran(127, "sh: npx: command not found"),
    ran(1, "Error: connect EACCES /tmp/x.sock"),
  ];
  for (const run of env) {
    for (const r of through(run)) {
      assert.equal(r.source, "fallback");
      assert.match(armEnvFailure(r) ?? "", /^the signals arm could not run here \(`npx tsx scripts\/lib\/riskClass\.ts --(app-code|fix-security)` (exited \d+|did not run): .+\) — re-run outside the sandbox$/, r.note);
    }
  }
  const owed = [
    through(undefined, null),
    through(ran(2, "riskClass: unknown flag(s): --app-code — known: --signals, --paths, --text")),
    through(() => ({ status: 0, stdout: "something else\n", stderr: "" })),
    through(() => ({ status: 0, stdout: "none\n", stderr: "" })),
  ];
  for (const results of owed) for (const r of results) assert.equal(armEnvFailure(r), null, r.note);
});

test("CODEX.6: an arm that crashes (exit 1, a plain exception), is killed, or exits 3 stops loudly; only exit 2 falls back quietly", () => {
  const through = (run: ArmDeps["runArm"]) => {
    const deps: ArmDeps = { signalsCommand: () => "node scripts/signals.ts", runArm: run };
    return [appCodePaths("/nowhere", MIXED, deps), fixSecurity("/nowhere", MIXED, deps)];
  };
  const loud = [
    () => ({ status: 1, stdout: "", stderr: "TypeError: Cannot read properties of undefined (reading 'split')\n    at main" }),
    () => ({ status: 1, stdout: "", stderr: "" }),
    () => ({ status: 3, stdout: "", stderr: "bad config" }),
    () => ({ status: null, stdout: "", stderr: "", error: "killed by SIGTERM" }),
  ];
  for (const run of loud) {
    for (const r of through(run)) {
      assert.equal(r.source, "fallback");
      assert.match(armEnvFailure(r) ?? "", /^the signals arm could not run here \(`node scripts\/signals\.ts --(app-code|fix-security)` (exited \d+|did not run)/, r.note);
    }
  }
  for (const r of through(() => ({ status: 2, stdout: "", stderr: "unknown flag(s): --fix-security" }))) {
    assert.equal(r.failure, null, r.note);
    assert.equal(armEnvFailure(r), null);
  }
});
