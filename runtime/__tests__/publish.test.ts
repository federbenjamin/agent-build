// Tests for publish.ts: the REAL script, run on a temp repo whose `origin` is a local bare repo, with
// a logging `git` (which runs the real one) and a fake `gh` first on PATH. The fake gh's `repo clone`
// clones another local bare repo, standing in for the public one, and then runs ON_CLONE, so a test
// can change the working tree while the clone is in flight; nothing reaches a real remote. Both
// append each call to FAKE_LOG, so a test sees what ran and whether anything reached the public repo.

import "./helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../publish.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "publish-"));
after(() => rmSync(root, { recursive: true, force: true }));

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const fakeBin = join(root, "bin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "git"), '#!/bin/sh\necho "git $*" >> "$FAKE_LOG"\nexec "$REAL_GIT" "$@"\n');
writeFileSync(join(fakeBin, "gh"), [
  "#!/bin/sh",
  'echo "gh $*" >> "$FAKE_LOG"',
  'case "$1 $2" in',
  '  "repo clone") "$REAL_GIT" clone -q "$PUBLIC_REMOTE" "$4" || exit 1; if [ -n "$ON_CLONE" ]; then sh -c "$ON_CLONE" || exit 1; fi ;;',
  '  "pr create") echo "https://example.invalid/pr/1" ;;',
  "esac",
  "exit 0",
  "",
].join("\n"));
chmodSync(join(fakeBin, "git"), 0o755);
chmodSync(join(fakeBin, "gh"), 0o755);

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function write(dir: string, files: Record<string, string>): void {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

let n = 0;
/** A private repo holding `files` (and the plugin manifest) committed on main and pushed to its bare
 *  `origin`, and a bare stand-in for the public repo whose main holds one file of its own. */
function world(files: Record<string, string>) {
  const dir = join(root, `w-${++n}`);
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const pub = join(dir, "public.git");
  const seed = join(dir, "seed");
  for (const bare of [origin, pub]) execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  for (const [tree, remote] of [[repo, origin], [seed, pub]] as const) {
    execFileSync("git", ["init", "-q", "-b", "main", tree]);
    git(tree, "remote", "add", "origin", remote);
  }
  write(seed, { "old.md": "only the public repo has this\n" });
  write(repo, { ".claude-plugin/plugin.json": '{"repository": "https://github.com/someone/public"}', ...files });
  for (const tree of [seed, repo]) {
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "init");
    git(tree, "push", "-q", "origin", "main");
  }
  return { repo, pub };
}

function run(w: { repo: string; pub: string }, opts: { onClone?: string; env?: Record<string, string>; args?: string[] } = {}) {
  const log = join(root, `log-${++n}`);
  writeFileSync(log, "");
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, FAKE_LOG: log, REAL_GIT, PUBLIC_REMOTE: w.pub, ON_CLONE: opts.onClone ?? "", ...opts.env };
  const r = spawnSync(process.execPath, [SCRIPT, w.repo, ...(opts.args ?? [])], { env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: readFileSync(log, "utf8").trim().split("\n") };
}

const ghCalls = (calls: string[]) => calls.filter((c) => c.startsWith("gh "));

test("a dirty tree is refused before anything is read or published", () => {
  const w = world({ "a.ts": "export {};\n" });
  writeFileSync(join(w.repo, "a.ts"), "export const x = 1;\n");
  const r = run(w);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the tree is dirty/);
  assert.match(r.stderr, / M a\.ts/);
  assert.deepEqual(r.calls, ["git status --porcelain"]);
});

test("a file holding a macOS home path is refused, by name, before the public repo is cloned, on a dry run too", () => {
  const home = ["", "Users", "someone", "code"].join("/");
  const w = world({ "a.ts": "export {};\n", "docs/notes.md": `see ${home}/x\n`, "graph/fixtures/run/log.md": `${home}\n` });
  for (const args of [[], ["--dry-run"]]) {
    const r = run(w, { args });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /macOS home path/);
    assert.match(r.stderr, /docs\/notes\.md/);
    assert.doesNotMatch(r.stderr, /graph\/fixtures/, "an excluded file is never scanned");
    assert.deepEqual(ghCalls(r.calls), []);
  }
});

test("a citation in prose is refused while test data and excluded run fixtures are not scanned", () => {
  const key = ["D", "EV"].join("");
  const id = `${key}-42`;
  const w = world({
    "docs/notes.md": `reference (${id})\n`,
    "runtime/__tests__/x.test.ts": `ingest("${id}")\n`,
    "graph/fixtures/run/log.md": `reference (${id})\n`,
  });
  for (const args of [[], ["--dry-run"]]) {
    const r = run(w, { args });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /real-ticket citation/);
    assert.match(r.stderr, /docs\/notes\.md:1/);
    assert.doesNotMatch(r.stderr, /runtime\/__tests__/, "test data is not a citation");
    assert.doesNotMatch(r.stderr, /graph\/fixtures/, "an excluded file is never scanned");
    assert.deepEqual(ghCalls(r.calls), []);
  }
});

test("a HEAD that is not origin/main is refused, naming both, before anything is exported or published", () => {
  const w = world({ "a.ts": "export {};\n" });
  const main = git(w.repo, "rev-parse", "HEAD");
  git(w.repo, "switch", "-q", "-c", "feat/x");
  write(w.repo, { "a.ts": "export const unreviewed = 1;\n" });
  git(w.repo, "commit", "-q", "-am", "not on main");
  const head = git(w.repo, "rev-parse", "HEAD");
  const r = run(w);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`HEAD is ${head}, not origin/main \\(${main}\\)`));
  assert.deepEqual(ghCalls(r.calls), []);
  assert.ok(!r.calls.some((c) => c.startsWith("git archive")), r.calls.join("\n"));
});

test("the published tree is the commit's, as scanned: an edit to the working tree during the clone is not in it", () => {
  const w = world({ "a.ts": "committed\n", "bin/run.sh": "#!/bin/sh\necho hi\n" });
  chmodSync(join(w.repo, "bin/run.sh"), 0o755);
  git(w.repo, "commit", "-q", "-am", "run.sh is executable");
  git(w.repo, "push", "-q", "origin", "main");
  const edit = `edited during the clone, ${["", "Users", "someone"].join("/")}/x`;
  const r = run(w, { onClone: `printf '%s\\n' "$EDIT" > "$SOURCE_FILE"`, env: { EDIT: edit, SOURCE_FILE: join(w.repo, "a.ts") } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(w.repo, "a.ts"), "utf8"), `${edit}\n`, "the edit happened mid-run");
  const sha = git(w.repo, "rev-parse", "--short", "HEAD");
  const branch = `chore/sync-${sha}`;
  assert.equal(git(w.pub, "show", `${branch}:a.ts`), "committed");
  assert.match(git(w.pub, "ls-tree", branch, "bin/run.sh"), /^100755 /);
  assert.equal(git(w.pub, "ls-tree", "--name-only", branch, "old.md"), "", "a file only the public repo had is gone");
  assert.equal(git(w.pub, "log", "-1", "--format=%s", branch), `chore: sync from origin main at ${sha}`);
  assert.deepEqual(ghCalls(r.calls).map((c) => c.split(" ").slice(0, 3).join(" ")), ["gh repo clone", "gh pr create"]);
});
