/** ledgerLine: the ledger's writer builds each line, checks it with the gate's parser, and never leaves a ledger the gate cannot read. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { applyLine, composeLine, main, parseArgs } from "../ledgerLine.ts";
import { parseLedger } from "../lib/ledger.ts";
import { withCapturedConsole } from "./helpers/captureConsole.ts";

const execFileAsync = promisify(execFile);

const A = "aaaaaaa";
const B = "bbbbbbb";
const HEAD_SHA = "1234567890abcdef1234567890abcdef12345678";
const CLASS = "class: R1 — operator, 2026-10-01 | measured-at=1111111";
const BASE = `${CLASS}\nflow: 2\n`;

interface Run {
  code: number;
  out: string[];
  errors: string[];
}

/** Runs `main` in `dir` with HEAD pinned to `HEAD_SHA`, its output captured. */
function run(dir: string, ...argv: string[]): Run {
  const out: string[] = [];
  let code = -1;
  const errors = withCapturedConsole((captured) => {
    code = main(["--ledger", "ship.md", ...argv], dir, (l) => out.push(l), { head: () => HEAD_SHA });
    return captured.errors;
  });
  return { code, out, errors };
}

function inTmp(fn: (dir: string, read: () => string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ledger-line-"));
  try {
    fn(dir, () => readFileSync(join(dir, "ship.md"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("composeLine: text segments, then fields, joined by ` | `; a move with no text starts at its first field and reads the same", () => {
  assert.equal(
    composeLine("wave", ["review-cursory, build-verifier", "skipped: simplifier — 40 < 100"], [["sha", A]]),
    `wave: review-cursory, build-verifier | skipped: simplifier — 40 < 100 | sha=${A}`
  );
  assert.equal(composeLine("build", [], [["model", "session"], ["agent", "none"], ["sha", A]]), `build: model=session | agent=none | sha=${A}`);
  assert.equal(composeLine("flow", ["2"], []), "flow: 2");
  const merge = composeLine("drift-merge", [], [["from", A], ["sha", B]]);
  assert.equal(merge, `drift-merge: from=${A} | sha=${B}`);
  const read = `drift-read: review-cursory | from=${A} | files=2 | sha=${A}`;
  assert.deepEqual(parseLedger(`${BASE}${read}\n${merge}\n`).driftMerges, parseLedger(`${BASE}${read}\ndrift-merge: | from=${A} | sha=${B}\n`).driftMerges);
  assert.deepEqual(parseLedger(`${BASE}${read}\n${merge}\n`).driftMerges, [{ from: A, sha: B }]);
});

test("parseArgs: the move, its text, and its fields in the order given", () => {
  assert.deepEqual(parseArgs(["--ledger", "l.md", "fix-1", "3/4", "--model", "opus", "--agent", "f1", "--from", A, "--sha", "head"]), {
    ledger: "l.md",
    mode: "add",
    move: "fix-1",
    text: ["3/4"],
    fields: [["model", "opus"], ["agent", "f1"], ["from", A], ["sha", "head"]],
  });
  assert.equal(parseArgs(["--replace", "--ledger", "l.md", "hand-test-2", "2/2", "--sha", A]).mode, "replace");
  assert.equal(parseArgs(["--ledger", "l.md", "--remove", "leftovers"]).mode, "remove");
});

test("parseArgs refuses what a typo could turn into a wrong line", () => {
  const refuses = (argv: string[], why: RegExp) => assert.throws(() => parseArgs(argv), why);
  refuses(["wave", "review-cursory", "--sha", A], /needs --ledger/);
  refuses(["--ledger", "l.md"], /names no move/);
  refuses(["--ledger", "l.md", "waves", "x"], /`waves` is not a ledger move/);
  refuses(["--ledger", "l.md", "hand-test-<n>", "1/1"], /is not a ledger move/);
  refuses(["--ledger", "l.md", "wave", "x", "--shaa", A], /unknown flag\(s\): --shaa/);
  refuses(["--ledger", "l.md", "wave", "x", "--sha"], /--sha requires a value/);
  refuses(["--ledger", "l.md", "wave", "x", "--sha", A, "--sha", B], /--sha is given twice/);
  refuses(["--ledger", "l.md", "wave", "review-cursory | sha=x"], /pass each `\|`-separated segment as its own argument/);
  refuses(["--ledger", "l.md", "wave", " "], /a text segment is empty/);
  refuses(["--ledger", "l.md", "--replace", "--remove", "wave"], /two actions/);
  refuses(["--ledger", "l.md", "--remove", "wave", "x"], /--remove takes the move alone/);
  refuses(["--ledger", "l.md", "banked", "CODEX.1", "--sha", A], /`banked:` takes no fields/);
  refuses(["--ledger", "l.md", "class", "R1 — operator, 2026-10-01", "--sha", A], /`class:` takes only --measured-at/);
});

test("a ledger whose `leftovers:` line predates `scope=` still takes lines; a new `leftovers:` line must name its scope", () => {
  inTmp((dir, read) => {
    const old = `${BASE}leftovers: pr-body | rows=2\n`;
    writeFileSync(join(dir, "ship.md"), old);
    const banked = run(dir, "banked", "CODEX.4 (awaiting operator)");
    assert.equal(banked.code, 0, banked.errors.join("\n"));
    assert.equal(read(), `${old}banked: CODEX.4 (awaiting operator)\n`);

    for (const mode of [[], ["--replace"]]) {
      const unscoped = run(dir, ...mode, "leftovers", "pr-body", "--rows", "3");
      assert.equal(unscoped.code, 2, mode.join(" "));
      assert.match(unscoped.errors.join("\n"), /a `leftovers:` line names its plan or session — --scope plan-<the plan's epic id> or --scope session-/);
    }
    assert.equal(read(), `${old}banked: CODEX.4 (awaiting operator)\n`, "a refused line leaves the file as it was");

    assert.equal(run(dir, "--replace", "leftovers", "pr-body", "--rows", "3", "--scope", "session-1a2b3c4d").code, 0);
    assert.equal(read(), `${BASE}leftovers: pr-body | rows=3 | scope=session-1a2b3c4d\nbanked: CODEX.4 (awaiting operator)\n`);
    assert.equal(run(dir, "--remove", "leftovers").code, 0);
    assert.equal(read(), `${BASE}banked: CODEX.4 (awaiting operator)\n`);
  });
});

test("the class line creates the ledger with `flow: 2` under it; nothing else can be the first line", () => {
  inTmp((dir, read) => {
    const early = run(dir, "wave", "review-cursory", "--sha", A);
    assert.equal(early.code, 1);
    assert.match(early.errors.join("\n"), /there is no ledger yet — its first line is the class line/);
    assert.equal(existsSync(join(dir, "ship.md")), false, "a refusal writes no file");

    const made = run(dir, "class", "R1 — agent (unconfirmed), 2026-10-01", "--measured-at", "head");
    assert.equal(made.code, 0, made.errors.join("\n"));
    assert.equal(read(), `class: R1 — agent (unconfirmed), 2026-10-01 | measured-at=${HEAD_SHA}\nflow: 2\n`);
    assert.deepEqual(made.out, [`wrote: class: R1 — agent (unconfirmed), 2026-10-01 | measured-at=${HEAD_SHA}`, "wrote: flow: 2"]);
    const ledger = parseLedger(read());
    assert.equal(ledger.pinned, false);
    assert.equal(ledger.measuredAt, HEAD_SHA);
  });
});

test("a class line that is no class line is refused with the parser's words, and no file is made", () => {
  inTmp((dir) => {
    const bad = run(dir, "class", "# Ship ledger — QRK-664");
    assert.equal(bad.code, 1);
    assert.match(bad.errors.join("\n"), /first line must be `class: R<n> — <who>, <date>`/);
    assert.equal(existsSync(join(dir, "ship.md")), false);
  });
});

test("`head` in a sha field is the tree's HEAD; a full line lands as the skill writes it", () => {
  inTmp((dir, read) => {
    writeFileSync(join(dir, "ship.md"), BASE);
    const wave = run(dir, "wave", "review-cursory, build-verifier", "skipped: simplifier — 40 < 100", "repo: comment-reader", "--sha", "head");
    assert.equal(wave.code, 0, wave.errors.join("\n"));
    const fix = run(dir, "fix-1", "3/4", "--model", "opus", "--agent", "f1", "--from", "HEAD", "--sha", B);
    assert.equal(fix.code, 0, fix.errors.join("\n"));
    assert.equal(
      read(),
      `${BASE}wave: review-cursory, build-verifier | skipped: simplifier — 40 < 100 | repo: comment-reader | sha=${HEAD_SHA}\n` +
        `fix-1: 3/4 | model=opus | agent=f1 | from=${HEAD_SHA} | sha=${B}\n`
    );
    const ledger = parseLedger(read());
    assert.deepEqual(ledger.waveReaders, ["review-cursory", "build-verifier"]);
    assert.deepEqual(ledger.waveRepoReaders, ["comment-reader"]);
    assert.equal(ledger.fixes.get("fix-1")?.from, HEAD_SHA);
  });
});

test("a line the gate could not read is refused with the parser's message, and the file is untouched", () => {
  inTmp((dir, read) => {
    writeFileSync(join(dir, "ship.md"), BASE);
    const cases: [string[], RegExp][] = [
      [["wave", "review-cursory (split ×2), build-verifier", "--sha", A], /`\(split` is not a reader name/],
      [["ship", "https://github.com/o/r/pull/9", "--sha", "83c5b6a70 (gate fixes after the second freshen)"], /holds a space/],
      [["ship", "https://github.com/o/r/pull/9", "--sha", "pending"], /sha=pending is not a git sha/],
      [["confirm-1", "review-cursory-codex"], /needs a `sha=` field/],
      [["fix-1", "5/4", "--model", "opus", "--agent", "f1", "--from", A, "--sha", B], /fixed 5 is more than its 4 rows/],
      [["hand-test-1", "skipped — no claims", "--sha", A], /a skipped hand test tested no head/],
      [["leftovers", "somewhere", "--rows", "2", "--scope", "plan-QRK-5"], /is neither a ticket id/],
    ];
    for (const [argv, why] of cases) {
      const r = run(dir, ...argv);
      assert.equal(r.code, 1, argv.join(" "));
      assert.match(r.errors.join("\n"), why);
      assert.match(r.errors.join("\n"), /^ledgerLine: refused — /);
      assert.equal(read(), BASE, `${argv[0]} left the file as it was`);
    }
  });
});

test("a move that already has a different line is refused and names it; --replace rewrites it in place", () => {
  inTmp((dir, read) => {
    const freshen = `freshen: ${A} | base=origin/main | branch=quick/x | sha=${A}`;
    writeFileSync(join(dir, "ship.md"), `${BASE}brief: docs/build/briefs/x.md\n${freshen}\nwave: review-cursory | sha=${A}\n`);
    const before = read();

    const again = run(dir, "freshen", B, "--base", "origin/main", "--branch", "quick/x", "--sha", B);
    assert.equal(again.code, 1);
    assert.match(again.errors.join("\n"), /two `freshen:` lines — one line per move/);
    assert.match(again.errors.join("\n"), new RegExp(`the ledger holds \`freshen: ${A} \\| base=origin/main \\| branch=quick/x \\| sha=${A}\`; \`--replace\` rewrites it`));
    assert.equal(read(), before);

    const replaced = run(dir, "--replace", "freshen", B, "--base", "origin/main", "--branch", "quick/x", "--sha", B);
    assert.equal(replaced.code, 0, replaced.errors.join("\n"));
    assert.deepEqual(replaced.out, [`replaced: ${freshen}`, `wrote: freshen: ${B} | base=origin/main | branch=quick/x | sha=${B}`]);
    assert.equal(
      read(),
      `${BASE}brief: docs/build/briefs/x.md\nfreshen: ${B} | base=origin/main | branch=quick/x | sha=${B}\nwave: review-cursory | sha=${A}\n`,
      "the line keeps its place; the others are untouched"
    );
  });
});

test("a bad line for a move that already has one is refused for what is wrong with it, not for the standing line", () => {
  inTmp((dir) => {
    writeFileSync(join(dir, "ship.md"), `${BASE}leftovers: QRK-12 | rows=2 | scope=plan-QRK-5\n`);
    const bad = run(dir, "leftovers", "QRK-12", "--rows", "two", "--scope", "plan-QRK-5");
    assert.equal(bad.code, 1);
    assert.match(bad.errors.join("\n"), /rows=two is not a count/);
    assert.doesNotMatch(bad.errors.join("\n"), /--replace/);
  });
});

test("a bad line for a once-only move that has a line names the line's own fault first, then the standing line", () => {
  inTmp((dir, read) => {
    writeFileSync(join(dir, "ship.md"), `${BASE}wave: review-cursory | sha=${A}\n`);
    const before = read();
    const bad = run(dir, "wave", "review-cursory (split ×2), build-verifier", "--sha", B);
    assert.equal(bad.code, 1);
    const said = bad.errors.join("\n");
    assert.match(said, /refused — .*`\(split` is not a reader name/);
    assert.doesNotMatch(said, /two `wave:` lines/);
    assert.match(said, new RegExp(`and the ledger holds \`wave: review-cursory \\| sha=${A}\`: once the line reads, \`--replace\` rewrites it`));
    assert.equal(read(), before);

    const title = run(dir, "class", "# Ship ledger — QRK-664");
    assert.equal(title.code, 1);
    assert.match(title.errors.join("\n"), /first line must be `class: R<n> — <who>, <date>`.* — and the ledger holds `class: R1 — operator/);
  });
});

test("the same line written twice is left alone; a repeatable move takes a second, different line", () => {
  inTmp((dir, read) => {
    writeFileSync(join(dir, "ship.md"), `${BASE}wave: review-cursory | sha=${A}\n`);
    const same = run(dir, "wave", "review-cursory", "--sha", A);
    assert.equal(same.code, 0);
    assert.deepEqual(same.out, [`unchanged: wave: review-cursory | sha=${A}`]);

    assert.equal(run(dir, "leftovers", "QRK-12", "--rows", "2", "--scope", "plan-QRK-5").code, 0);
    assert.equal(run(dir, "leftovers", "QRK-12", "--rows", "5", "--scope", "plan-QRK-5").code, 0);
    assert.equal(read(), `${BASE}wave: review-cursory | sha=${A}\nleftovers: QRK-12 | rows=2 | scope=plan-QRK-5\nleftovers: QRK-12 | rows=5 | scope=plan-QRK-5\n`);
    assert.equal(parseLedger(read()).leftovers?.rows, 5);
  });
});

test("the class line is replaced in place, as an operator's veto needs", () => {
  inTmp((dir, read) => {
    writeFileSync(join(dir, "ship.md"), `class: R0 — agent (unconfirmed), 2026-10-01 | measured-at=${A}\nflow: 2\nbrief: docs/build/briefs/x.md\n`);
    const twice = run(dir, "class", "R1 — operator, 2026-10-01", "--measured-at", A);
    assert.equal(twice.code, 1);
    assert.match(twice.errors.join("\n"), /--replace` rewrites it/);
    const veto = run(dir, "--replace", "class", "R1 — operator, 2026-10-01", "--measured-at", A);
    assert.equal(veto.code, 0, veto.errors.join("\n"));
    assert.equal(read(), `class: R1 — operator, 2026-10-01 | measured-at=${A}\nflow: 2\nbrief: docs/build/briefs/x.md\n`);
    assert.equal(parseLedger(read()).pinned, true);
  });
});

test("--remove deletes the move's last line; never the class or flow line, never a move that is not there", () => {
  inTmp((dir, read) => {
    writeFileSync(join(dir, "ship.md"), `${BASE}leftovers: QRK-12 | rows=2 | scope=plan-QRK-5\nleftovers: QRK-12 | rows=5 | scope=plan-QRK-5\n`);
    const removed = run(dir, "--remove", "leftovers");
    assert.equal(removed.code, 0, removed.errors.join("\n"));
    assert.deepEqual(removed.out, ["removed: leftovers: QRK-12 | rows=5 | scope=plan-QRK-5"]);
    assert.equal(read(), `${BASE}leftovers: QRK-12 | rows=2 | scope=plan-QRK-5\n`);
    for (const [move, why] of [["class", /never removed/], ["flow", /never removed/], ["wave", /has no `wave:` line to remove/]] as const) {
      const r = run(dir, "--remove", move);
      assert.equal(r.code, 1, move);
      assert.match(r.errors.join("\n"), why);
    }
    assert.equal(run(dir, "--replace", "wave", "review-cursory", "--sha", A).code, 1, "nothing to replace");
  });
});

test("a ledger that was unreadable before the change says so, and --replace on the bad line mends it", () => {
  inTmp((dir, read) => {
    writeFileSync(join(dir, "ship.md"), `${BASE}ship: https://github.com/o/r/pull/9 | sha=not-a-sha\n`);
    const blocked = run(dir, "leftovers", "QRK-12", "--rows", "2", "--scope", "plan-QRK-5");
    assert.equal(blocked.code, 1);
    assert.match(blocked.errors.join("\n"), /the ledger could not be read before this line: .*sha=not-a-sha is not a git sha/);
    const mended = run(dir, "--replace", "ship", "https://github.com/o/r/pull/9", "--sha", A);
    assert.equal(mended.code, 0, mended.errors.join("\n"));
    assert.equal(read(), `${BASE}ship: https://github.com/o/r/pull/9 | sha=${A}\n`);
  });
});

test("applyLine keeps prose and blank lines it did not write, and an empty file is no ledger", () => {
  const withProse = `${CLASS}\nflow: 2\n\nA note the session left.\nwave: review-cursory | sha=${A}\n`;
  const next = applyLine(withProse, "add", "verifier", `verifier: CLEAN | sha=${A}`);
  assert.ok(next.ok);
  assert.equal(next.text, `${withProse}verifier: CLEAN | sha=${A}\n`);
  assert.deepEqual(applyLine("\n", "add", "wave", `wave: review-cursory | sha=${A}`), {
    ok: false,
    why: 'there is no ledger yet — its first line is the class line: `class "R<n> — <who>, <YYYY-MM-DD>" --measured-at head`',
  });
});

test("usage errors exit 2 and print the usage line", () => {
  inTmp((dir) => {
    const r = run(dir, "wave", "x", "--shaa", A);
    assert.equal(r.code, 2);
    assert.match(r.errors.join("\n"), /unknown flag\(s\): --shaa/);
    assert.match(r.errors.join("\n"), /usage: ledgerLine\.ts --ledger/);
  });
});

test("a call that finds the lock held waits, then exits 2 with the file untouched and the lock left for its holder", () => {
  inTmp((dir, read) => {
    writeFileSync(join(dir, "ship.md"), BASE);
    writeFileSync(join(dir, "ship.md.lock"), "");
    const out: string[] = [];
    let code = -1;
    const errors = withCapturedConsole((captured) => {
      code = main(["--ledger", "ship.md", "leftovers", "QRK-12", "--rows", "2", "--scope", "plan-QRK-5"], dir, (l) => out.push(l), { lockWaitMs: 60 });
      return captured.errors;
    });
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /another ledgerLine call holds .*ship\.md\.lock — nothing was written/);
    assert.deepEqual(out, []);
    assert.equal(read(), BASE);
    assert.equal(existsSync(join(dir, "ship.md.lock")), true, "another call's lock is not removed");

    rmSync(join(dir, "ship.md.lock"));
    assert.equal(run(dir, "leftovers", "QRK-12", "--rows", "2", "--scope", "plan-QRK-5").code, 0);
    assert.equal(existsSync(join(dir, "ship.md.lock")), false, "a call removes its own lock");
    assert.equal(run(dir, "leftovers", "nowhere", "--rows", "2", "--scope", "plan-QRK-5").code, 1);
    assert.equal(existsSync(join(dir, "ship.md.lock")), false, "a refused call removes its lock too");
  });
});

test("calls run side by side all land: every line a call reports as written is in the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-line-race-"));
  const script = join(import.meta.dirname, "..", "ledgerLine.ts");
  const ids = Array.from({ length: 12 }, (_, i) => `QRK-${i + 1}`);
  try {
    writeFileSync(join(dir, "ship.md"), BASE);
    const outs = await Promise.all(
      ids.map((id) => execFileAsync(process.execPath, ["--no-warnings", script, "--ledger", "ship.md", "leftovers", id, "--rows", "1", "--scope", "plan-QRK-5"], { cwd: dir }))
    );
    const text = readFileSync(join(dir, "ship.md"), "utf8");
    for (const [i, id] of ids.entries()) {
      assert.equal(outs[i]!.stdout, `wrote: leftovers: ${id} | rows=1 | scope=plan-QRK-5\n`);
      assert.ok(text.includes(`leftovers: ${id} | rows=1 | scope=plan-QRK-5\n`), `${id}'s line was lost`);
    }
    assert.equal(text.split("\n").length, 2 + ids.length + 1);
    parseLedger(text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a first line that is refused makes no folder", () => {
  inTmp((dir) => {
    assert.equal(run(dir, "wave", "review-cursory", "--sha", A).code, 1);
    const nested = main(["--ledger", "run/ship.md", "wave", "review-cursory", "--sha", A], dir, () => {}, { head: () => HEAD_SHA });
    assert.equal(nested, 1);
    assert.equal(existsSync(join(dir, "run")), false);
  });
});

test("run as a script: `head` is read from the cwd's real HEAD, and a tree with no HEAD exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-line-git-"));
  const script = join(import.meta.dirname, "..", "ledgerLine.ts");
  const node = (...argv: string[]) =>
    execFileSync(process.execPath, ["--no-warnings", script, ...argv], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = (...argv: string[]) => execFileSync("git", argv, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q");
    assert.throws(
      () => node("--ledger", "ship.md", "class", "R0 — operator, 2026-10-01", "--measured-at", "head"),
      (err: { status?: number; stderr?: string }) => err.status === 2 && /could not read HEAD here/.test(err.stderr ?? "")
    );
    writeFileSync(join(dir, "f.txt"), "x\n");
    git("add", "f.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    const head = git("rev-parse", "HEAD").trim();
    const out = node("--ledger", "run/ship.md", "class", "R0 — operator, 2026-10-01", "--measured-at", "head");
    assert.equal(out, `wrote: class: R0 — operator, 2026-10-01 | measured-at=${head}\nwrote: flow: 2\n`);
    assert.equal(readFileSync(join(dir, "run", "ship.md"), "utf8"), `class: R0 — operator, 2026-10-01 | measured-at=${head}\nflow: 2\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
