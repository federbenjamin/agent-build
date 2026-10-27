import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { agentRunnerFor, checkRunnerFor, classifierFor, forgeFor, trackerFor } from "../adapters/bind.ts";
import { parseRunConfig } from "../config.ts";
import { type HaikuBinding, type JevBinding, type RunConfig, type RunPlace, SETUP_STATUSES } from "../contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const graphDir = join(here, "..");

const stubs = {
  graph: "g.ts",
  agent: { adapter: "stub", fixtureDir: "fx" },
  classifier: { adapter: "stub", default: { answer: "no", p: 1 } },
  check: { adapter: "stub", default: "pass" },
};

const parse = (over: Record<string, unknown>, base = graphDir) => parseRunConfig({ ...stubs, ...over }, base).config;
const refused = (over: Record<string, unknown>, base = graphDir): string => {
  try {
    parse(over, base);
  } catch (e) {
    return (e as Error).message;
  }
  return assert.fail("did not throw");
};

test("a binding key no adapter has is refused, not dropped: a misspelled agentFromItem would run the role's own agent", () => {
  assert.match(refused({ roles: { "repo-review": { agent: { adapter: "claude", agentFromitem: true } } } }), /roles\.repo-review\.agent\.agentFromitem: expected no such key: one of adapter, plugin, model, permissionMode, agentFromItem/);
  assert.match(refused({ agent: { adapter: "codex", model: "x" } }), /agent\.model: expected no such key/);
  assert.match(refused({ agent: { adapter: "stub", fixtureDir: "fx", fixturedir: "fy" } }), /agent\.fixturedir: expected no such key/);
  assert.match(refused({ forge: { adapter: "github", dir: "x" } }), /forge\.dir: expected no such key/);
  assert.deepEqual(parse({ roles: { "repo-review": { agent: { adapter: "claude", agentFromItem: true } } } }).roles["repo-review"]?.agent, { adapter: "claude", agentFromItem: true });
});

// ---- the two shipped setups ----

test("every shipped setup loads, through the adapter the real-run config binds it to, and records its status (kept on the binding), its cut-off, and the report it came from", () => {
  const files = readdirSync(join(graphDir, "classifiers")).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["completeness.json", "prior-art.json", "review-codex.json", "review-fix.json", "security.json", "silent-failures.json", "simplifier.json"]);
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(graphDir, "classifiers", f), "utf8")) as Record<string, unknown>;
    assert.ok((SETUP_STATUSES as readonly unknown[]).includes(raw.status), `${f}: status`);
    assert.ok(typeof raw.report === "string" && raw.report.length > 0, `${f}: report`);
    assert.match(raw.report, /\(\d{4}-\d{2}-\d{2}[,)]/, `${f}: the report is named with its date`);
    assert.doesNotMatch(raw.report, /\/|\.md\b/, `${f}: the report is named, not a path`);
    assert.ok(typeof raw.cutoff === "number", `${f}: cutoff`);
    const b = parse({ classifier: { adapter: "jev", setup: `classifiers/${f}` } }).classifier as JevBinding;
    assert.equal(b.cutoff, raw.cutoff, f);
    assert.equal(b.status, raw.status, `${f}: the binding keeps the status`);
    if (raw.status === "initial") assert.equal(b.cutoff, 0.5, `${f}: an initial setup's cut-off is 0.5`);
    if (raw.status === "judgment") assert.match(raw.report, /cost judgment/, `${f}: a judged cut-off says so in its report`);
  }
});

test("prior-art reads the ticket as an optional field, the verifier keeps its brief's deliverables, and security takes the largest answer", () => {
  const load = (f: string) => parse({ classifier: { adapter: "jev", setup: `classifiers/${f}` } }).classifier as JevBinding;
  assert.deepEqual(load("prior-art.json").fields.ticket, { input: "ticket", optional: true, maxChars: 12000 });
  assert.deepEqual(load("completeness.json").fields.brief!.keep, ["Deliverables", "Parts", "Target files"]);
  assert.equal(load("security.json").combine, "max");
  assert.equal(load("review-codex.json").combine, "mean");
});

test("optional, keep and combine are parsed and checked: keep needs maxChars and no diff shape, combine is mean or max", () => {
  const field = (over: Record<string, unknown>) => ({ classifier: { adapter: "jev", model: "m", cutoff: 0.5, questions: { q: { type: "noul", instructions: "Q?" } }, fields: { f: { input: "x", ...over } } } });
  assert.equal((parse(field({})).classifier as JevBinding).combine, "mean", "mean by default");
  assert.deepEqual((parse(field({ optional: true, maxChars: 10, keep: ["Deliverables"] })).classifier as JevBinding).fields.f, { input: "x", optional: true, maxChars: 10, keep: ["Deliverables"] });
  assert.match(refused(field({ optional: "yes" })), /classifier\.fields\.f\.optional: expected true or false/);
  assert.match(refused(field({ keep: ["Parts"] })), /classifier\.fields\.f\.keep: expected set only beside maxChars/);
  assert.match(refused(field({ keep: ["Parts"], maxChars: 10, shape: "production-code" })), /classifier\.fields\.f\.keep: expected set only on a field that is not a diff/);
  const c = field({});
  (c.classifier as Record<string, unknown>).combine = "median";
  assert.match(refused(c), /classifier\.combine/);
});

test("the re-review setup loads as a Jev binding: two questions, the production diff, and the decision-line feature", () => {
  const b = parse({ classifier: { adapter: "jev", setup: "classifiers/review-fix.json" } }).classifier as JevBinding;
  assert.equal(b.model, "jev-1.14.0");
  assert.equal(b.cutoff, 0.974);
  assert.deepEqual(Object.keys(b.questions), ["new_edge_cases", "adds_branch"]);
  assert.deepEqual([b.fields.fix_diff!.shape, b.fields.fix_diff!.maxChars], ["production-code", 60000]);
  assert.deepEqual(b.features, [{ input: "fix-file", pattern: "^\\S+ · decision\\b(?: · [0-9a-f]{7,40})?(?: — .*)?$", weight: 0.4 }]);
  assert.ok(new RegExp(b.features[0]!.pattern, "m").test("F2 · decision — which one?"));
  assert.ok(!new RegExp(b.features[0]!.pattern, "m").test("F2 · fixed · abc1234 — a decision was made"));
});

test("a binding's own keys override its setup's, and a setup path is read from the config's folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-bind-"));
  const setup = JSON.parse(JSON.stringify((parse({ classifier: { adapter: "jev", setup: "classifiers/review-fix.json" } }).classifier as JevBinding), null, 1));
  delete setup.adapter;
  delete setup.setup;
  writeFileSync(join(dir, "mine.json"), JSON.stringify(setup));
  const b = parse({ classifier: { adapter: "jev", setup: "mine.json", cutoff: 0.5, model: "jev-latest" } }, dir).classifier as JevBinding;
  assert.deepEqual([b.cutoff, b.model], [0.5, "jev-latest"]);
  assert.equal(Object.keys(b.questions).length, 2);
  rmSync(dir, { recursive: true });
});

// ---- Jev validation ----

const jev = (over: Record<string, unknown> = {}) => ({
  adapter: "jev",
  model: "jev-1.14.0",
  cutoff: 0.5,
  fields: { diff: { input: "diff" } },
  questions: { q: { type: "noul", instructions: "Is it?" } },
  ...over,
});

test("a complete inline Jev binding is accepted, with no features by default", () => {
  assert.deepEqual((parse({ classifier: jev() }).classifier as JevBinding).features, []);
});

test("every problem in a Jev binding is reported together, each at its path", () => {
  const msg = refused({
    classifier: jev({
      model: 3,
      cutoff: 1.2,
      fields: { diff: { input: "d", shape: "tiny", maxChars: 0 }, other: {} },
      questions: { a: { type: "noul" }, b: { type: "score", criteria: ["only one"] }, c: { type: "choice" } },
      features: [{ input: "r", pattern: "(", weight: "x" }],
    }),
  });
  for (const want of [
    "classifier.model: expected a string",
    "classifier.cutoff: expected a number in [0, 1]",
    "classifier.fields.diff.shape: expected one of production-code | risky-hunks",
    "classifier.fields.diff.maxChars: expected a positive integer",
    "classifier.fields.other.input: expected a string",
    "classifier.questions.a: expected instructions or criteria",
    "classifier.questions.b.criteria: expected 2 to 10 levels",
    "classifier.questions.c.type: expected one of noul | score",
    "classifier.features[0].pattern: expected a valid regular expression",
    "classifier.features[0].weight: expected a number",
  ]) {
    assert.ok(msg.includes(want), `${want}\n--- got:\n${msg}`);
  }
});

test("no fields or no questions is refused, and so is a setup file that cannot be read", () => {
  assert.match(refused({ classifier: jev({ fields: {} }) }), /classifier\.fields: expected at least one field/);
  assert.match(refused({ classifier: jev({ questions: {} }) }), /classifier\.questions: expected at least one question/);
  assert.match(refused({ classifier: { adapter: "jev", setup: "nope.json" } }), /classifier\.setup: expected a readable JSON file/);
});

test("a role's own Jev classifier is validated like the default, with its path", () => {
  assert.match(refused({ roles: { hunter: { classifier: jev({ cutoff: 2 }) } } }), /roles\.hunter\.classifier\.cutoff: expected a number in \[0, 1\]/);
});

test("a Haiku binding whose setup carries Jev questions, a combination or features is refused, not silently cut down", () => {
  const msg = refused({ classifier: { adapter: "haiku", setup: "classifiers/review-fix.json", system: "S", prompt: "{{fix_diff}}" } });
  assert.match(msg, /classifier\.questions: expected no such key for haiku/);
  assert.match(msg, /classifier\.features: expected no such key for haiku/);
  assert.match(msg, /classifier\.combine: expected no such key for haiku/);
  assert.match(refused({ classifier: haiku({ question: "Q?" }) }), /classifier\.question: expected no such key for haiku/);
});

// ---- the other bindings ----

const haiku = (over: Record<string, unknown> = {}) => ({ adapter: "haiku", fields: { diff: { input: "diff", note: { field: "diff_note", text: "" } } }, system: "S", prompt: "{{diff_note}}{{diff}}", cutoff: 0.6, ...over });

test("a Haiku binding takes the same fields, a system prompt, a prompt over them, a cut-off, and one call by default", () => {
  const inline = parse({ classifier: haiku() }).classifier as HaikuBinding;
  assert.equal(inline.setup.name, "inline");
  assert.deepEqual({ ...inline, setup: undefined }, { adapter: "haiku", setup: undefined, model: "haiku", fields: { diff: { input: "diff", note: { field: "diff_note", text: "" } } }, system: "S", prompt: "{{diff_note}}{{diff}}", calls: 1, cutoff: 0.6 });
  assert.equal((parse({ classifier: haiku({ calls: 2, model: "claude-haiku-5-5" }) }).classifier as HaikuBinding).calls, 2);
  assert.match(refused({ classifier: haiku({ system: undefined }) }), /classifier\.system: expected a string/);
  assert.match(refused({ classifier: haiku({ prompt: "{{brief}}" }) }), /classifier\.prompt: expected placeholders that name a field or a note; \{\{brief\}\} names neither/);
  for (const calls of [0, 6, 1.5]) assert.match(refused({ classifier: haiku({ calls }) }), /classifier\.calls/, String(calls));
});

test("a misspelled setup key is refused, not dropped for its default: a field's sample, a Jev combine, a Haiku call count", () => {
  const sampled = { diff: { input: "diff", maxChars: 100, sampel: "head" } };
  assert.match(refused({ classifier: jev({ fields: sampled }) }), /classifier\.fields\.diff\.sampel: expected no such key: one of input, optional, cutBefore, shape, maxChars, sample, keep, note/);
  assert.match(refused({ classifier: haiku({ fields: { diff: { input: "diff", maxChars: 100, sampel: "head" } }, prompt: "{{diff}}" }) }), /classifier\.fields\.diff\.sampel: expected no such key/);
  assert.match(refused({ classifier: jev({ combin: "max" }) }), /classifier\.combin: expected no such key/);
  assert.match(refused({ classifier: haiku({ cals: 3 }) }), /classifier\.cals: expected no such key/);
  assert.match(refused({ classifier: haiku({ fields: { diff: { input: "diff", note: { field: "n", txt: "" } } }, prompt: "{{diff}}" }) }), /classifier\.fields\.diff\.note\.txt: expected no such key/);
  assert.equal(parse({ classifier: jev({ status: "tuned", report: "a report (2026-10-22)" }) }).classifier?.adapter, "jev", "a setup's own record keys are allowed");
});

test("a Haiku prompt may not place an optional field or its note: a run without the input would have nothing to put there", () => {
  const fields = { diff: { input: "diff" }, ticket: { input: "ticket", optional: true, note: { field: "ticket_note", text: "" } } };
  for (const name of ["ticket", "ticket_note"]) {
    assert.match(refused({ classifier: haiku({ fields, prompt: `{{diff}}{{${name}}}` }) }), new RegExp(`classifier\\.prompt: expected placeholders that name a field every run has; \\{\\{${name}\\}\\} names an optional field`), name);
  }
  assert.equal((parse({ classifier: haiku({ fields, prompt: "{{diff}}" }) }).classifier as HaikuBinding).prompt, "{{diff}}");
});

test("the hunter setup is round 5's J5-sampled arm on Jev: four exposure questions and a render-or-readiness question over the cut risk moment and the sampled diff, their mean, its cut-off", () => {
  const b = parse({ classifier: { adapter: "jev", setup: "classifiers/silent-failures.json" } }).classifier as JevBinding;
  assert.deepEqual([b.model, b.combine, b.cutoff, b.status, b.features], ["jev-1.14.0", "mean", 0.2228, "tuned", []]);
  assert.deepEqual(Object.entries(b.fields).map(([k, f]) => [k, f.input, f.cutBefore, f.shape, f.maxChars, f.sample, f.note?.field]), [
    ["summary", "risk-moment", "^(size|signals|model|metrics|decisions):", undefined, undefined, undefined, undefined],
    ["diff", "diff", undefined, "no-tests-docs-locks", 75000, undefined, "diff_note"],
  ]);
  assert.deepEqual(Object.entries(b.questions).map(([k, q]) => [k, q.type]), [
    ["calls_outside", "noul"],
    ["new_outside_code", "noul"],
    ["outside_dependence", "score"],
    ["many_failure_points", "noul"],
    ["render_or_readiness", "noul"],
  ]);
  assert.equal((b.questions.outside_dependence?.criteria as string[]).length, 5);
});

test("Claude, Codex, shell, Linear and GitHub bindings parse; a Claude plugin, model and permission mode are optional", () => {
  const c = parse({
    agent: { adapter: "claude", plugin: "agent-build", model: "sonnet", permissionMode: "acceptEdits" },
    check: { adapter: "shell" },
    tracker: { adapter: "linear" },
    forge: { adapter: "github" },
    roles: { reviewer: { agent: { adapter: "codex" } }, fixer: { agent: { adapter: "claude" } } },
  });
  assert.deepEqual(c.agent, { adapter: "claude", plugin: "agent-build", model: "sonnet", permissionMode: "acceptEdits" });
  assert.deepEqual(c.check, { adapter: "shell" });
  assert.deepEqual([c.tracker, c.forge], [{ adapter: "linear" }, { adapter: "github" }]);
  assert.deepEqual(c.roles.reviewer, { agent: { adapter: "codex" } });
  assert.deepEqual(c.roles.fixer, { agent: { adapter: "claude" } });
});

// ---- binding to adapters ----

const place: RunPlace = { runDir: "/run", worktree: "/run/worktree", branch: "graph/g-1", baseSha: "0" };

test("each seam is bound to the adapter its binding names, a role's own binding winning over the default", async () => {
  const config: RunConfig = {
    ...parse({
      agent: { adapter: "claude" },
      classifier: jev(),
      check: { adapter: "shell" },
      tracker: { adapter: "linear" },
      forge: { adapter: "github" },
      roles: { reviewer: { agent: { adapter: "codex" } }, quick: { classifier: haiku() } },
    }),
  };
  for (const r of [agentRunnerFor(config, "builder"), agentRunnerFor(config, "reviewer"), classifierFor(config, "hunter"), classifierFor(config, "quick"), await checkRunnerFor(config, "tests")]) {
    assert.equal(typeof (r as { run?: unknown; classify?: unknown }).run === "function" || typeof (r as { classify?: unknown }).classify === "function", true);
  }
  const key = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  try {
    await assert.rejects(trackerFor(config, place).ingest("DEV-1", new AbortController().signal), /LINEAR_API_KEY/);
  } finally {
    if (key !== undefined) process.env.LINEAR_API_KEY = key;
  }
  await assert.rejects(forgeFor(config, place).merge({ worktree: "/w", pr: "x", signal: new AbortController().signal }), /github forge: "x" is not a PR number/);
});

test("the stub and file bindings still bind the stubs and the file fakes", async () => {
  const config = parse({ tracker: { adapter: "file", dir: "/nonexistent-tracker" } });
  assert.equal(typeof agentRunnerFor(config, "x").run, "function");
  await assert.rejects(trackerFor(config, place).ingest("T-1", new AbortController().signal), /file tracker ticket T-1: no \/nonexistent-tracker\/tickets\/T-1\.json/);
});
