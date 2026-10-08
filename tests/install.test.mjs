// install.sh against a temp HOME: never the real ~/.agent-build, whose links running builds use.
// Every run gets a PATH of the temp HOME's bin plus the system dirs, so the real `claude` never
// runs against the operator's plugin config; a test that wants one writes a stub there.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = realpathSync(new URL("..", import.meta.url).pathname);
const SCRIPT = join(REPO, "install.sh");
const NAMES = ["runtime", "skills", "agents"];

/** A fresh temp HOME, removed after `fn`; `fn` gets it and its `.agent-build` path. */
function withHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-build-install-")));
  assert.notEqual(home, realpathSync(homedir()), "the test HOME must never be the real one");
  try {
    fn(home, join(home, ".agent-build"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function run(home, ...args) {
  const PATH = `${join(home, "bin")}:/usr/bin:/bin`;
  const r = spawnSync("/bin/sh", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, PATH } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const PLUGIN = "agent-build@agent-build";

// A `claude` stub that keeps its plugin config in $HOME/claude-state and acts as the real CLI
// does (checked under a scratch CLAUDE_CONFIG_DIR): `marketplace add` of a registered path exits
// 0, of a new path for the same name repoints it and the installed plugin then reads from there;
// `install` installs and enables. `marketplace add` and `install` default to user scope; `enable`
// auto-detects it (its --help), modeled as the same-id install at the other scope winning. Its
// `plugin list --json` always carries two decoys: a plugin whose id contains this one's, and this
// plugin installed at project scope (or `other.scope`), disabled unless `other.enabled`, elsewhere.
// `fail` (a command prefix) exits 1 with output; `noop` (a prefix) exits 0 and changes nothing.
const STUB = `#!/bin/sh
s="$HOME/claude-state"
echo "$*" >> "$HOME/claude-calls.log"
if [ -f "$s/fail" ]; then case "$*" in "$(cat "$s/fail")"*) echo "stub refused: $*"; exit 1 ;; esac; fi
if [ -f "$s/noop" ]; then case "$*" in "$(cat "$s/noop")"*) exit 0 ;; esac; fi
scope=; arg=; prev=
for a in "$@"; do
  case "$prev" in --scope|-s) scope=$a; prev=; continue ;; esac
  case "$a" in --scope=*) scope=\${a#--scope=} ;; -*) ;; *) arg=$a ;; esac
  prev=$a
done
other=$(cat "$s/other-scope")
case "$1 $2" in
  "plugin list")
    if [ -f "$s/list" ]; then cat "$s/list"; exit 0; fi
    printf '[{"id":"${PLUGIN}-fork","scope":"user","enabled":true,"readFromFolder":"/fork"},'
    printf '{"id":"${PLUGIN}","scope":"%s","enabled":%s,"readFromFolder":"/other-project"}' "$other" "$(cat "$s/other-enabled")"
    from=; [ -s "$s/marketplace" ] && from=",\\"readFromFolder\\":\\"$(cat "$s/marketplace")\\""
    [ -f "$s/installed" ] && printf ',{"id":"${PLUGIN}","scope":"user","enabled":%s%s}' "$(cat "$s/enabled")" "$from"
    echo ']' ;;
  "plugin marketplace")
    [ "\${scope:-user}" = user ] || { echo "stub: unexpected $*"; exit 1; }
    printf '%s' "$arg" > "$s/marketplace" ;;
  "plugin install")
    [ "\${scope:-user}" = user ] || { echo "stub: unexpected $*"; exit 1; }
    [ -f "$s/marketplace" ] || { echo "plugin not found in any marketplace"; exit 1; }
    : > "$s/installed"; echo true > "$s/enabled" ;;
  "plugin enable")
    case "\${scope:-$other}" in
      user) [ -f "$s/installed" ] || { echo "plugin not installed"; exit 1; }; echo true > "$s/enabled" ;;
      "$other") echo true > "$s/other-enabled" ;;
      *) echo "plugin not installed at scope $scope"; exit 1 ;;
    esac ;;
  *) echo "stub: unexpected $*"; exit 1 ;;
esac
`;

/**
 * Puts the stub `claude` (and `node`, which install.sh parses the list with) in the temp HOME's
 * bin, seeded with `state`: `{ marketplace, enabled }` makes the plugin installed from that
 * folder, or with `marketplace: ""` from no folder (a copy in Claude's plugin cache, which
 * `plugin list --json` gives no `readFromFolder`); `other: { scope, enabled }` sets the same-id
 * decoy; `fail`, `noop`, and `list` (a raw `plugin list` output) as STUB says. Returns readers
 * for the argv lines so far and for the plugin's state.
 */
function stubClaude(home, state = {}) {
  const bin = join(home, "bin");
  const dir = join(home, "claude-state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(join(bin, "claude"), STUB);
  chmodSync(join(bin, "claude"), 0o755);
  if (state.marketplace !== undefined) writeFileSync(join(dir, "marketplace"), state.marketplace);
  if (state.enabled !== undefined) {
    writeFileSync(join(dir, "installed"), "");
    writeFileSync(join(dir, "enabled"), `${state.enabled}\n`);
  }
  writeFileSync(join(dir, "other-scope"), state.other?.scope ?? "project");
  writeFileSync(join(dir, "other-enabled"), `${state.other?.enabled ?? false}\n`);
  for (const key of ["fail", "noop", "list"]) if (state[key] !== undefined) writeFileSync(join(dir, key), state[key]);
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  return {
    calls: () => read(join(home, "claude-calls.log")),
    plugin: () => ({
      installed: existsSync(join(dir, "installed")),
      enabled: read(join(dir, "enabled")).trim(),
      from: read(join(dir, "marketplace")),
    }),
    otherEnabled: () => read(join(dir, "other-enabled")).trim(),
    unfail: () => rmSync(join(dir, "fail")),
  };
}

function assertLinked(dest) {
  for (const name of NAMES) {
    const link = join(dest, name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${link} is a symlink`);
    assert.equal(readlinkSync(link), join(REPO, name), `${link} aims at this repo's ${name}`);
  }
}

test("fresh install makes the three links into this repo", () => {
  withHome((home, dest) => {
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assertLinked(dest);
    for (const name of NAMES) assert.ok(r.out.includes(`${join(dest, name)}: linked`), r.out);
  });
});

test("a second run leaves every link alone and reports it unchanged", () => {
  withHome((home, dest) => {
    assert.equal(run(home).status, 0);
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assertLinked(dest);
    for (const name of NAMES) assert.ok(r.out.includes(`${join(dest, name)}: unchanged`), r.out);
  });
});

test("a real folder at a link's path is refused, and nothing is made or replaced", () => {
  withHome((home, dest) => {
    mkdirSync(join(dest, "skills"), { recursive: true });
    writeFileSync(join(dest, "skills", "keep.txt"), "mine");
    const r = run(home);
    assert.equal(r.status, 1);
    assert.match(r.err, /\.agent-build\/skills exists and is not a symlink/);
    assert.ok(!lstatSync(join(dest, "skills")).isSymbolicLink(), "the folder is still a folder");
    assert.ok(existsSync(join(dest, "skills", "keep.txt")), "its contents are untouched");
    for (const name of ["runtime", "agents"]) assert.ok(!existsSync(join(dest, name)), `${name} was not linked`);
  });
});

test("a link that aims elsewhere is repointed at this repo, and its old target is untouched", () => {
  withHome((home, dest) => {
    const elsewhere = join(home, "old-runtime");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "x.ts"), "old");
    mkdirSync(dest);
    symlinkSync(elsewhere, join(dest, "runtime"));
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assertLinked(dest);
    assert.ok(r.out.includes(`${join(dest, "runtime")}: repointed (was ${elsewhere})`), r.out);
    assert.ok(existsSync(join(elsewhere, "x.ts")), "the old target keeps its files");
  });
});

test("--check prints each state, changes nothing, and exits non-zero unless all three are ok", () => {
  withHome((home, dest) => {
    // All missing.
    let r = run(home, "--check");
    assert.equal(r.status, 1);
    for (const name of NAMES) assert.ok(r.out.includes(`${join(dest, name)}: missing`), r.out);
    assert.ok(!existsSync(dest), "--check made nothing");

    // All ok.
    assert.equal(run(home).status, 0);
    r = run(home, "--check");
    assert.equal(r.status, 0, r.out);
    for (const name of NAMES) assert.ok(r.out.includes(`${join(dest, name)}: ok`), r.out);

    // One aims elsewhere, one is a real folder, one is missing.
    const elsewhere = join(home, "old-agents");
    mkdirSync(elsewhere);
    rmSync(join(dest, "agents"));
    symlinkSync(elsewhere, join(dest, "agents"));
    rmSync(join(dest, "skills"));
    mkdirSync(join(dest, "skills"));
    rmSync(join(dest, "runtime"));
    r = run(home, "--check");
    assert.equal(r.status, 1);
    assert.ok(r.out.includes(`${join(dest, "agents")}: points at ${elsewhere}`), r.out);
    assert.ok(r.out.includes(`${join(dest, "skills")}: not a symlink`), r.out);
    assert.ok(r.out.includes(`${join(dest, "runtime")}: missing`), r.out);
    assert.equal(readlinkSync(join(dest, "agents")), elsewhere, "--check left the stray link alone");
    assert.ok(!lstatSync(join(dest, "skills")).isSymbolicLink(), "--check left the folder alone");
    assert.ok(!existsSync(join(dest, "runtime")), "--check made no link");
  });
});

const LIST = "plugin list --json\n";
const ADD = `plugin marketplace add --scope user ${REPO}\n`;
const INSTALL = `plugin install --scope user ${PLUGIN}\n`;
const ENABLE = `plugin enable --scope user ${PLUGIN}\n`;
const ENABLED_HERE = { installed: true, enabled: "true", from: REPO };

test("with claude on PATH and a fresh config, the links are made, then the marketplace add and the install run in order", () => {
  withHome((home, dest) => {
    const claude = stubClaude(home);
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assertLinked(dest);
    assert.equal(claude.calls(), `${LIST}${ADD}${INSTALL}${LIST}`);
    assert.deepEqual(claude.plugin(), ENABLED_HERE);
    assert.ok(r.out.endsWith("plugin: registered and enabled\n"), r.out);
  });
});

test("a plugin already enabled from this checkout makes no further claude call", () => {
  withHome((home) => {
    const claude = stubClaude(home, { marketplace: REPO, enabled: true });
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assert.equal(claude.calls(), LIST);
    assert.ok(r.out.endsWith("plugin: already installed\n"), r.out);
  });
});

test("a disabled plugin is enabled and said so, never reported already installed", () => {
  withHome((home) => {
    const claude = stubClaude(home, { marketplace: REPO, enabled: false });
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assert.equal(claude.calls(), `${LIST}${ENABLE}${LIST}`);
    assert.deepEqual(claude.plugin(), ENABLED_HERE);
    assert.ok(r.out.endsWith("plugin: enabled (was disabled)\n"), r.out);
    assert.ok(!r.out.includes("already installed"), r.out);
  });
});

test("a plugin read from another clone is repointed at this checkout", () => {
  withHome((home) => {
    const old = join(home, "old-clone");
    const claude = stubClaude(home, { marketplace: old, enabled: true });
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assert.equal(claude.calls(), `${LIST}${ADD}${LIST}`);
    assert.deepEqual(claude.plugin(), ENABLED_HERE);
    assert.ok(r.out.endsWith(`plugin: repointed (was ${old})\n`), r.out);
  });
});

test("a plugin both disabled and read from another clone is repointed, then enabled", () => {
  withHome((home) => {
    const old = join(home, "old-clone");
    const claude = stubClaude(home, { marketplace: old, enabled: false });
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assert.equal(claude.calls(), `${LIST}${ADD}${ENABLE}${LIST}`);
    assert.deepEqual(claude.plugin(), ENABLED_HERE);
    assert.ok(r.out.endsWith(`plugin: repointed (was ${old})\nplugin: enabled (was disabled)\n`), r.out);
  });
});

test("a disabled user install is enabled at user scope, never the same plugin's project or local install", () => {
  for (const scope of ["project", "local"]) {
    for (const enabled of [false, true]) {
      withHome((home) => {
        const claude = stubClaude(home, { marketplace: REPO, enabled: false, other: { scope, enabled } });
        const r = run(home);
        const which = `${scope} install enabled=${enabled}`;
        assert.equal(r.status, 0, `${which}: ${r.err}`);
        assert.equal(claude.calls(), `${LIST}${ENABLE}${LIST}`, which);
        assert.deepEqual(claude.plugin(), ENABLED_HERE, which);
        assert.equal(claude.otherEnabled(), `${enabled}`, `${which}: the ${scope} install is left as it was`);
        assert.ok(r.out.endsWith("plugin: enabled (was disabled)\n"), `${which}: ${r.out}`);
      });
    }
  }
});

test("a rerun after the install failed past the marketplace add completes the install", () => {
  withHome((home, dest) => {
    const claude = stubClaude(home, { fail: "plugin install" });
    assert.equal(run(home).status, 1);
    claude.unfail();
    const before = claude.calls();
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assertLinked(dest);
    assert.equal(claude.calls().slice(before.length), `${LIST}${ADD}${INSTALL}${LIST}`);
    assert.deepEqual(claude.plugin(), ENABLED_HERE);
    assert.ok(r.out.endsWith("plugin: registered and enabled\n"), r.out);
  });
});

test("each failing claude call exits 1 with its output on stderr, the links already made", () => {
  const cases = [
    { fail: "plugin list", state: {} },
    { fail: "plugin marketplace add", state: {} },
    { fail: "plugin install", state: {} },
    { fail: "plugin enable", state: { marketplace: REPO, enabled: false } },
  ];
  for (const { fail, state } of cases) {
    withHome((home, dest) => {
      const claude = stubClaude(home, { ...state, fail });
      const r = run(home);
      assert.equal(r.status, 1, `${fail}: ${r.out}`);
      assertLinked(dest);
      assert.ok(claude.calls().trimEnd().split("\n").at(-1).startsWith(fail), `${fail} is the last call: ${claude.calls()}`);
      assert.match(r.err, new RegExp(`^stub refused: ${fail}`, "m"), fail);
      assert.match(r.err, /install\.sh: claude plugin .* failed; the links are made/, fail);
      assert.ok(!/^plugin: /m.test(r.out), `${fail}: no plugin line on a failure: ${r.out}`);
    });
  }
});

test("a plugin installed from the plugin cache is repointed at this checkout", () => {
  withHome((home) => {
    const claude = stubClaude(home, { marketplace: "", enabled: true });
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assert.equal(claude.calls(), `${LIST}${ADD}${LIST}`);
    assert.deepEqual(claude.plugin(), ENABLED_HERE);
    assert.ok(r.out.endsWith("plugin: repointed (was the plugin cache)\n"), r.out);
  });
});

test("a plugin still not enabled from this checkout after the install exits 1 and says how it stands", () => {
  const cases = [
    { state: { marketplace: REPO, enabled: false, noop: "plugin enable" }, now: `enabled=false, reads from ${REPO}` },
    { state: { noop: "plugin install" }, now: "not installed" },
  ];
  for (const { state, now } of cases) {
    withHome((home, dest) => {
      stubClaude(home, state);
      const r = run(home);
      assert.equal(r.status, 1, r.out);
      assertLinked(dest);
      assert.ok(
        r.err.includes(`install.sh: ${PLUGIN} is not enabled from ${REPO} after the install (${now}); the links are made\n`),
        r.err
      );
      assert.ok(!/^plugin: /m.test(r.out), r.out);
    });
  }
});

test("a plugin list that is not JSON exits 1 and names the command", () => {
  withHome((home, dest) => {
    stubClaude(home, { list: "Installed plugins:\n" });
    const r = run(home);
    assert.equal(r.status, 1, r.out);
    assertLinked(dest);
    assert.match(r.err, /install\.sh: could not read `claude plugin list --json`; the links are made/);
  });
});

test("with no claude on PATH, the links are made and the two plugin commands are printed for later", () => {
  withHome((home, dest) => {
    const r = run(home);
    assert.equal(r.status, 0, r.err);
    assertLinked(dest);
    assert.ok(
      r.out.endsWith(`plugin: run later: claude plugin marketplace add ${REPO} && claude plugin install agent-build@agent-build\n`),
      r.out
    );
  });
});

test("an unknown argument is refused with usage and changes nothing", () => {
  withHome((home, dest) => {
    const r = run(home, "--force");
    assert.equal(r.status, 2);
    assert.match(r.err, /usage: install\.sh \[--check\]/);
    assert.ok(!existsSync(dest));
  });
});
