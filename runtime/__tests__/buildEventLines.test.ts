/**
 * The stop files' `buildEvent.ts` lines, run the way the session runs them: each template filled by
 * SKILL's quoting rule and handed to a shell. A value holding `$(…)`, a backtick, or a `'` must reach
 * the event as data and never run; and no line names a fixed unit id, so two units never share one.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BUILD_EVENT_CMD } from "../buildEvent.ts";
import { type BuildEvent, readBuildEvent } from "../lib/buildEvents.ts";
import { spawnSmoke } from "./helpers/spawnSmoke.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_DIR = join(REPO, "skills", "build");
const SCRIPT = join(REPO, "runtime", "buildEvent.ts");
const INSTALLED = "node ~/.agent-build/runtime/buildEvent.ts";

function templates(): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  for (const file of readdirSync(SKILL_DIR).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(SKILL_DIR, file), "utf8");
    for (const m of text.matchAll(/node ~\/\.agent-build\/runtime\/buildEvent\.ts [^`\n]*/g)) {
      out.push({ file, line: m[0].trim() });
    }
  }
  return out;
}

/** SKILL's rule: the value goes inside the template's single quotes, each `'` typed `'\''`. */
const quoteInner = (value: string): string => value.replaceAll("'", `'\\''`);

function hostile(dir: string): Record<string, string> {
  const canary = (tag: string) => join(dir, `ran-${tag}`);
  const noSpace = (tag: string) => `x'$(touch\${IFS}${canary(`${tag}-a`)})\`touch\${IFS}${canary(`${tag}-b`)}\``;
  const spaced = (tag: string) =>
    `it's $(touch ${canary(`${tag}-a`)}) \`touch ${canary(`${tag}-b`)}\` "q" \\ ; a=b`;
  const values = {
    runid: noSpace("runid"),
    id: `feat/${noSpace("id")}`,
    "unit id": `feat/${noSpace("unitid")}`,
    branch: `feat/a=b${noSpace("branch")}`,
    title: spaced("title"),
    "what the operator must do": spaced("needs"),
    n: "12",
  };
  return values;
}

function fill(line: string, values: Record<string, string>): { command: string; used: string[] } {
  const used: string[] = [];
  const body = line
    .replace(INSTALLED, `'${process.execPath}' '${SCRIPT}'`)
    .replaceAll("…", "")
    .replace(/\[([^\]]*)\]/g, "$1")
    .replace(/<([^<>]+)>/g, (_, name: string) => {
      const value = values[name];
      assert.ok(value !== undefined, `no test value for <${name}> in: ${line}`);
      used.push(value);
      return quoteInner(value);
    });
  return { command: body, used };
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (typeof v === "object" && v !== null) return Object.values(v).flatMap(strings);
  return [];
}

interface LineRun {
  ran: string[];
  status: number;
  stderr: string;
  event: BuildEvent | undefined;
  used: string[];
}

/** One template, filled by SKILL's rule and run through `/bin/sh` with a `tee` consumer, as a session runs it. */
function runLine(line: string, values: (dir: string) => Record<string, string>): LineRun {
  const dir = mkdtempSync(join(tmpdir(), "build-event-line-"));
  const out = join(dir, "event.json");
  const { command, used } = fill(line, values(dir));
  const run = spawnSmoke("/bin/sh", ["-c", command], {
    cwd: dir,
    env: { ...process.env, [BUILD_EVENT_CMD]: `tee ${out}` },
  });
  const ran = readdirSync(dir).filter((f) => f.startsWith("ran-"));
  const event = existsSync(out) ? readBuildEvent(readFileSync(out, "utf8")) : undefined;
  return { ran, status: run.status, stderr: run.stderr, event, used };
}

function linesOf(file: string, event: string): string[] {
  return templates()
    .filter((t) => t.file === file && t.line.startsWith(`${INSTALLED} ${event} `))
    .map((t) => t.line);
}

test("emit lines: every stop-file line carries shell-active values as data and runs none of them", () => {
  const lines = templates();
  assert.ok(lines.length >= 7,`expected the stop files' emit lines, found ${lines.length}`);
  for (const { file, line } of lines) {
    const { ran, status, stderr, event, used } = runLine(line, hostile);
    assert.deepEqual(ran, [], `${file}: the shell ran a value in: ${line}`);
    assert.equal(status, 0, `${file}: ${line}\n${stderr}`);
    assert.equal(stderr, "", `${file}: ${line}`);
    assert.ok(event !== undefined, `${file}: no event reached the consumer: ${line}`);
    const fields = strings(event);
    for (const value of used) assert.ok(fields.includes(value), `${file}: ${JSON.stringify(value)} did not arrive literally`);
  }
});

/**
 * SKILL's `<runid>` mint, run as a session runs it: every mint in one shell (one `$$`), the first
 * `inOrder` one after another and the rest at once, with `date` pinned to one second and `TMPDIR`
 * a fresh temp dir holding nothing, as on a machine that has never run a build. Returns each
 * runid: the minted dir's name after `build-`.
 */
function mintRunids(inOrder: number, atOnce: number): string[] {
  const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const mint = /Mint `<runid>` once per unit[^`]*`([^`]+)`/.exec(skill)?.[1];
  assert.ok(mint !== undefined, "SKILL.md names the command that mints `<runid>`");
  const root = mkdtempSync(join(tmpdir(), "build-mint-"));
  const bin = join(root, "bin");
  const scratch = join(root, "tmp");
  mkdirSync(bin);
  mkdirSync(scratch);
  writeFileSync(join(bin, "date"), "#!/bin/sh\necho 1791266702\n", { mode: 0o755 });
  const script = [...Array<string>(inOrder).fill(mint), ...Array<string>(atOnce).fill(`(${mint}) &`), "wait"].join("\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: scratch };
  const run = spawnSmoke("/bin/sh", ["-c", script], { cwd: root, env });
  assert.equal(run.status, 0, `the mint failed: ${mint}\n${run.stderr}`);
  const dirs = run.stdout.split("\n").filter((l) => l !== "");
  assert.equal(dirs.length, inOrder + atOnce, run.stdout);
  const prefix = join(scratch, "build-");
  return dirs.map((dir) => {
    assert.ok(dir.startsWith(prefix) && existsSync(dir), `the mint did not make its inputs dir: ${dir}`);
    return dir.slice(prefix.length);
  });
}

test("emit lines: a unit outside the plan keeps one id, distinct from every other unit's, whatever its branch holds", () => {
  const [planLine, ...extraPlan] = linesOf("FROM-BRANCH.md", "plan");
  assert.ok(planLine !== undefined && extraPlan.length === 0, "FROM-BRANCH.md fires one plan line");
  const later = [...linesOf("CLOSE.md", "blocked"), ...linesOf("SHIP.md", "unit-merged")];
  assert.equal(later.length, 2, "CLOSE's blocked line and SHIP's unit-merged line");
  // Every runid minted in one shell in one second, in order and at once; a branch may hold `=`, and one
  // branch may equal another's text before its `=`.
  const runids = mintRunids(3, 2);
  assert.equal(new Set(runids).size, runids.length, `two mints in one shell and one second share a runid: ${runids.join(", ")}`);
  const branches = ["feat/a=b", "feat/a", "fix/=x==y=", "feat/a=b", "chore/x"];
  const runs = runids.map((runid, i) => ({ runid, branch: branches[i]! }));
  const ids = runs.map(({ runid, branch }) => {
    const plan = runLine(planLine, () => ({ runid, branch }));
    assert.equal(plan.status, 0, `${branch}: ${plan.stderr}`);
    assert.ok(plan.event?.event === "plan", `${branch}: no plan event`);
    assert.equal(plan.event.units.length, 1, branch);
    const id = plan.event.units[0]!.id;
    assert.equal(plan.event.units[0]!.title, branch, `${branch}: the plan split the branch`);
    for (const line of later) {
      const r = runLine(line, () => ({ runid, "unit id": id, "what the operator must do": "answer Q1", n: "12" }));
      assert.equal(r.status, 0, `${branch}: the plan's id ${id} is refused by: ${line}\n${r.stderr}`);
      assert.ok(r.event !== undefined && "id" in r.event && r.event.id === id, `${branch}: ${line}`);
    }
    return id;
  });
  assert.equal(new Set(ids).size, ids.length, `two units share an id: ${ids.join(", ")}`);
});

test("emit lines: no line names a fixed unit id, so two units of one session never share one", () => {
  for (const { file, line } of templates()) {
    for (const m of line.matchAll(/--(?:id|unit) ('[^']*'…?|\S+)/g)) {
      assert.match(m[1]!, /^'<[^<>]+>(=<[^<>]+>)?'…?$/, `${file}: a literal unit id in: ${line}`);
    }
  }
  const brief = readFileSync(join(SKILL_DIR, "BRIEF.md"), "utf8");
  assert.match(brief, /any other unit \(work with no plan, the batch, a `--from-branch` run\) takes its run's `<runid>`/);
  assert.doesNotMatch(brief, /no plan is `u1`/);
  assert.match(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"), /Mint `<runid>` once per unit /);
});

test("emit lines: SKILL states the quoting rule the lines rely on", () => {
  const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  assert.ok(skill.includes("every value goes in single quotes, each `'` in it typed `'\\''`"), "SKILL.md quoting rule");
});
