/** A classifier's decision record (the map's d.decision), and the verdict that carries it. */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decisionFileText, decisionRecord, explores, isExplored } from "../adapters/decision.ts";
import { EXPLORE_RATE } from "../constants.ts";
import { gateFails } from "../define.ts";
import { graph as toy } from "../examples/toy.ts";
import { parseRunConfig } from "../config.ts";
import { bindingFor, ContractError, parseDataValue } from "../contracts.ts";

const graphDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

test("a decision names its node, the setup by file name and a hash of the file, the adapter, model and cut-off, and a digest of the state sent", () => {
  const hunterFile = join(graphDir, "classifiers", "silent-failures.json");
  const { config } = parseRunConfig(
    {
      graph: "pipelines/build.ts",
      agent: { adapter: "stub", fixtureDir: "fx" },
      check: { adapter: "stub", default: "pass" },
      roles: {
        "silent-failures": { classifier: { adapter: "jev", setup: "classifiers/silent-failures.json" } },
        security: { classifier: { adapter: "jev", setup: "classifiers/security.json", cutoff: 0.6 } },
        completeness: { classifier: { adapter: "jev", model: "jev-1", cutoff: 0.5, fields: { b: { input: "brief" } }, questions: { q: { type: "noul", instructions: "Q?" } } } },
      },
      classifier: { adapter: "stub", default: { answer: "no", p: 0.1 } },
    },
    graphDir
  );
  const hunter = bindingFor(config, "classifier", "silent-failures")!;
  const sent = JSON.stringify({ summary: "class: R1", diff: "", diff_note: "" });
  const d = decisionRecord("C-silent-failures", hunter, { text: sent, file: "/run/nodes/C-silent-failures/0/out/decision.json" });
  assert.deepEqual(d, {
    node: "C-silent-failures",
    adapter: "jev",
    setup: { name: "silent-failures", sha256: sha(readFileSync(hunterFile, "utf8")) },
    model: "jev-1.14.0",
    cutoff: 0.2228,
    stateDigest: sha(sent),
    decisionFile: "/run/nodes/C-silent-failures/0/out/decision.json",
  });
  assert.deepEqual(decisionRecord("C-security", bindingFor(config, "classifier", "security")!).setup?.overrides, ["cutoff"], "a key set over the file's is named");
  assert.equal(decisionRecord("C-completeness", bindingFor(config, "classifier", "completeness")!).setup?.name, "inline");
  assert.deepEqual(decisionRecord("C-x", bindingFor(config, "classifier", "simplifier")!), { node: "C-x", adapter: "stub" }, "a stub sends nothing");
  const kept = JSON.parse(decisionFileText(d, { answer: "yes", p: 0.4 }, sent)) as Record<string, unknown>;
  assert.deepEqual([kept.answer, kept.p, kept.state, kept.stateDigest], ["yes", 0.4, sent, sha(sent)], "the file holds the record, the call, and the state as sent");
});

test("a verdict keeps its decision through validation; a decision file outside the run dir is refused", () => {
  const decision = { node: "C-silent-failures", adapter: "jev", setup: { name: "silent-failures", sha256: "ab" }, model: "m", cutoff: 0.2228, stateDigest: "cd", decisionFile: "/run/nodes/C-silent-failures/0/out/decision.json" };
  const v = { schema: "verdict", answer: "no", p: 0.25, decision };
  assert.deepEqual(parseDataValue(v, "verdict", "silent-failures-call", "/run"), v);
  assert.throws(() => parseDataValue(v, "verdict", "silent-failures-call", "/elsewhere"), (e: unknown) => e instanceof ContractError && /decision\.decisionFile: expected a path under the run dir/.test(e.message));
  assert.throws(() => parseDataValue({ ...v, decision: { ...decision, adapter: "gpt" } }, "verdict", "silent-failures-call"), /decision\.adapter/);
  assert.deepEqual(parseDataValue({ schema: "verdict", answer: "yes", p: 1 }, "verdict", "x"), { schema: "verdict", answer: "yes", p: 1 }, "a verdict without a record, as a stub data value writes it");
});

test("an initial setup's no in a real run is explored at the coin's rate, opens its gate, and keeps its verdict; a mock, a tuned setup and a yes never are", () => {
  const { config } = parseRunConfig(
    {
      graph: "pipelines/build.ts",
      agent: { adapter: "stub", fixtureDir: "fx" },
      check: { adapter: "stub", default: "pass" },
      roles: { completeness: { classifier: { adapter: "jev", setup: "classifiers/completeness.json" } }, "review-fix": { classifier: { adapter: "jev", setup: "classifiers/review-fix.json" } } },
    },
    graphDir
  );
  const initial = bindingFor(config, "classifier", "completeness")!;
  const tuned = bindingFor(config, "classifier", "review-fix")!;
  const runs = Array.from({ length: 400 }, (_, i) => `g-run-${i}`);
  const explored = runs.filter((runId) => isExplored(initial, { runId, kind: "real" }, "C-completeness", 0, "no"));
  assert.ok(explored.length > 400 * EXPLORE_RATE * 0.75 && explored.length < 400 * EXPLORE_RATE * 1.25, `${explored.length} of 400 explored`);
  assert.deepEqual(explored, runs.filter((runId) => explores(runId, "C-completeness", 0, EXPLORE_RATE)), "the coin is the run, node and iteration's, on every call");
  const runId = explored[0]!;
  assert.equal(isExplored(initial, { runId, kind: "mock" }, "C-completeness", 0, "no"), false);
  assert.equal(isExplored(tuned, { runId, kind: "real" }, "C-completeness", 0, "no"), false);
  assert.equal(isExplored(initial, { runId, kind: "real" }, "C-completeness", 0, "yes"), false);

  const gate = { classifier: "needs-review", answer: "yes" };
  const no = { schema: "verdict" as const, answer: "no", p: 0.2, decision: { node: "needs-review", adapter: "jev" as const } };
  assert.match(gateFails(toy, gate, { "review-call": no }) ?? "", /answered no, not yes/);
  assert.equal(gateFails(toy, gate, { "review-call": { ...no, decision: { ...no.decision, explored: true } } }), null);
  assert.match(gateFails(toy, { classifier: "needs-review", answer: "no" }, { "review-call": { ...no, answer: "yes", decision: { ...no.decision, explored: true } } }) ?? "", /answered yes/);
});
