/**
 * The fixture generator (`mock/make.ts`): what its redaction and sanitising leave of a recorded
 * file, and the fixture it makes when the brief is kept in the run's store (no `at`) or in the tree.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { make, PLACEHOLDER_TEAM, redactTicket, redactWord, sanitise, sha256, type Spec } from "../mock/make.ts";

// ---- redactTicket ----

test("a private tracker's ticket ids become TEAM-<n>, keeping each match's case", () => {
  assert.equal(redactTicket("see ENG-123, eng-45 and Eng-7", "eng"), "see TEAM-123, team-45 and Team-7");
  assert.equal(PLACEHOLDER_TEAM, "team");
});

test("a ticket id is rewritten only whole: a longer prefix, a longer number or no number stays", () => {
  assert.equal(redactTicket("XENG-1 ENG-12abc ENG- ENG-x", "ENG"), "XENG-1 ENG-12abc ENG- ENG-x");
  assert.equal(redactTicket("ENG-1ENG-2", "ENG"), "ENG-1ENG-2", "no boundary between the two");
  assert.equal(redactTicket("(ENG-10)", "ENG"), "(TEAM-10)");
});

test("a ticket prefix is matched literally, not as a pattern", () => {
  assert.equal(redactTicket("a.b-1 axb-2", "a.b"), "team-1 axb-2");
});

test("a ticket prefix that is not there changes nothing", () => {
  assert.equal(redactTicket("OPS-9 is unrelated", "ENG"), "OPS-9 is unrelated");
});

// ---- redactWord ----

test("a redacted word keeps the case of each match: lower, Capitalised and UPPER", () => {
  assert.equal(redactWord("acme Acme ACME aCmE", "acme", "corp"), "corp Corp CORP corp");
});

test("a redacted word with regex characters is matched literally", () => {
  assert.equal(redactWord("a.b axb", "a.b", "zz"), "zz axb");
});

// ---- sanitise ----

const HOME = "/home/someone";

test("sanitise replaces the home path, absolute or as ~/, with <home>", () => {
  assert.equal(sanitise(`${HOME}/code/x and ~/code/y`, HOME), "<home>/code/x and <home>/code/y");
});

test("sanitise replaces ~/ wherever it stands in a path-like token, and a tilde not followed by a slash stays", () => {
  assert.equal(sanitise("cd ~/a; ls ~/b/c; echo ~user ~", HOME), "cd <home>/a; ls <home>/b/c; echo ~user ~");
});

test("sanitise replaces claude temp paths and macOS var/folders paths, up to a quote, backtick or space", () => {
  assert.equal(sanitise("`/tmp/claude-501/x/y` and /private/tmp/claude/z ok", HOME), "`<tmp>` and <tmp> ok");
  assert.equal(sanitise("at '/private/var/folders/g4/c9/T/graph-x/y' ok", HOME), "at '<tmp>' ok");
  assert.equal(sanitise("/tmp/other stays", HOME), "/tmp/other stays", "only claude's temp folders are placeholders");
});

test("sanitise replaces email addresses and the forge and tracker URLs", () => {
  assert.equal(sanitise("mail me@example.com or a.b+c@sub.host.org", HOME), "mail <email> or <email>");
  assert.equal(sanitise("see https://github.com/org/repo/pull/3 and https://linear.app/team/issue/ENG-1/x)", HOME), "see <forge-url> and <tracker-url>)");
});

test("sanitise applies the redacted words and ticket prefixes before the path rules", () => {
  const out = sanitise("ENG-12: acme lives in ~/acme", HOME, [["acme", "corp"]], ["ENG"]);
  assert.equal(out, "TEAM-12: corp lives in <home>/corp");
});

test("sanitise redacts a private word inside a home path, so the placeholder path does not carry it", () => {
  assert.equal(sanitise(`${HOME}/acme-repo/x`, HOME, [["acme", "corp"]]), "<home>/corp-repo/x");
});

// ---- make: a brief kept in the run's store ----

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string => execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" }).trim();
const put = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** A source repo with one commit, a store repo holding a brief in two versions, and a fixture dir with a spec. */
function makeWorld(spec: (store: { v1: string; v2: string }) => Spec) {
  const root = mkdtempSync(join(tmpdir(), "graph-make-"));
  const home = process.env.HOME ?? "/nonexistent-home";
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  put(join(source, "README.md"), "src\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const store = join(root, "store");
  mkdirSync(store);
  git(store, "init", "-q", "-b", "main");
  put(join(store, "briefs", "x.md"), `# Brief\nclass: R1 — ENG-12 acme work in ${home}/proj\n`);
  git(store, "add", "-A");
  git(store, "commit", "-q", "-m", "brief: x");
  const v1 = git(store, "rev-parse", "HEAD");
  put(join(store, "briefs", "x.md"), `# Brief\nclass: R1 — ENG-12 acme work in ${home}/proj, amended\n`);
  git(store, "commit", "-q", "-am", "amend brief: ENG-12 acme says amended");
  const v2 = git(store, "rev-parse", "HEAD");
  const fixture = join(root, "fixture");
  put(join(fixture, "spec.json"), JSON.stringify(spec({ v1, v2 })));
  put(join(fixture, "repo", "control", "build-steps.toml"), "[steps]\n");
  put(join(fixture, "repo", "control", "notes.md"), "## build\n");
  put(join(fixture, "repo", "control", "replay.json"), "{}\n");
  const args = { fixture, redact: [["acme", "corp"]] as [string, string][], tickets: ["ENG"], source, store, runDir: join(root, "run"), files: {} };
  return { root, fixture, args, source, store, home };
}

const specFor = (at?: string) => ({ v1, v2 }: { v1: string; v2: string }): Spec => ({
  run: "r",
  base: "HEAD",
  brief: { repo: "store", path: "briefs/x.md", versions: [v1, v2], ...(at === undefined ? {} : { at }) },
  main: [],
  writers: [{ role: "amender", output: "amend-commit", key: "Q1", brief: 1 }],
  files: [],
});

const patchesIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".patch"));

test("a store brief (no `at`) is kept out of the stand-in tree: the amend is an empty commit with the recorded subject", () => {
  const w = makeWorld(specFor());
  make(w.args);
  const patchDir = join(w.fixture, "agents", "amender", "amend-commit", "@Q1");
  const [patch] = patchesIn(patchDir);
  assert.ok(patch, "the amend writer has its commit as a patch");
  const text = readFileSync(join(patchDir, patch), "utf8");
  assert.match(text, /^Subject: \[PATCH\] amend brief: TEAM-12 corp says amended$/m, "the store commit's subject, redacted");
  assert.ok(!text.includes("diff --git"), "an empty commit changes no file");
  const base = JSON.parse(readFileSync(join(w.fixture, "repo", "base.json"), "utf8")) as Record<string, string>;
  assert.ok(!Object.keys(base).some((p) => p.endsWith("x.md")), "the base tree does not hold the brief");
  rmSync(w.root, { recursive: true });
});

test("a store brief's two versions go to the stub agents' files, cleaned of paths, names and tickets", () => {
  const w = makeWorld(specFor());
  make(w.args);
  const first = readFileSync(join(w.fixture, "agents", "write-brief", "brief", "x.md"), "utf8");
  const second = readFileSync(join(w.fixture, "agents", "amender", "brief-amended", "@Q1", "x.md"), "utf8");
  assert.equal(first, "# Brief\nclass: R1 — TEAM-12 corp work in <home>/proj\n");
  assert.equal(second, "# Brief\nclass: R1 — TEAM-12 corp work in <home>/proj, amended\n");
  rmSync(w.root, { recursive: true });
});

test("the fixture holds no trace of what was redacted, only its hashes", () => {
  const w = makeWorld(specFor());
  make(w.args);
  const redactions = JSON.parse(readFileSync(join(w.fixture, "redactions.json"), "utf8")) as { words: { sha256: string; length: number }[]; tickets: { sha256: string }[] };
  assert.deepEqual(redactions, { words: [{ sha256: sha256("acme"), length: 4 }], tickets: [{ sha256: sha256("eng") }] });
  for (const f of walk(w.fixture)) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/acme|ENG-/i.test(text), `${f} still names a redacted word`);
    assert.ok(!text.includes(w.home) || w.home === "/nonexistent-home", `${f} holds the home path`);
  }
  rmSync(w.root, { recursive: true });
});

test("a brief kept in the tree (`at`) is committed there, and its amend is a real change to that file", () => {
  const w = makeWorld(specFor(".briefs/x.md"));
  make(w.args);
  const patchDir = join(w.fixture, "agents", "amender", "amend-commit", "@Q1");
  const text = readFileSync(join(patchDir, patchesIn(patchDir)[0]!), "utf8");
  assert.match(text, /^diff --git a\/\.briefs\/x\.md b\/\.briefs\/x\.md$/m);
  assert.match(text, /^\+class: R1 — TEAM-12 corp work in <home>\/proj, amended$/m);
  rmSync(w.root, { recursive: true });
});

test("a brief in the store needs --store: without it the generator refuses before writing the base", () => {
  const w = makeWorld(specFor());
  assert.throws(() => make({ ...w.args, store: null }), /the brief lives in the store: pass --store <repo>/);
  assert.ok(!existsSync(join(w.fixture, "repo", "base.json")));
  rmSync(w.root, { recursive: true });
});

test("a recorded file the spec names but the run dir lacks is an error naming it", () => {
  const w = makeWorld((v) => ({ ...specFor()(v), files: [{ from: "run:missing.txt", to: "x/y.txt" }] }));
  assert.throws(() => make(w.args), /run:missing\.txt: no such recorded file/);
  rmSync(w.root, { recursive: true });
});

test("an edit whose old text is not in the recorded file, and a dropLines prefix that matches no line, are errors", () => {
  const w = makeWorld((v) => ({ ...specFor()(v), files: [{ from: "run:a.txt", to: "x/a.txt", replace: [["absent", "x"]] }] }));
  put(join(w.args.runDir, "a.txt"), "line one\nline two\n");
  assert.throws(() => make(w.args), /the edit's text is not there: absent/);
  const v = makeWorld((s) => ({ ...specFor()(s), files: [{ from: "run:a.txt", to: "x/a.txt", dropLines: ["nope"] }] }));
  put(join(v.args.runDir, "a.txt"), "line one\n");
  assert.throws(() => make(v.args), /no line starts with nope/);
  rmSync(w.root, { recursive: true });
  rmSync(v.root, { recursive: true });
});
