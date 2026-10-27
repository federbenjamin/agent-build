import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolve } from "node:path";

import { graphStateDir, parseRunConfig } from "../config.ts";
import type { RunConfig, StubAgentBinding, StubCheckBinding, StubClassifierBinding } from "../contracts.ts";

/** A config whose default bindings are the stubs, as the tests below write them. */
type StubConfig = Omit<RunConfig, "agent" | "classifier" | "check"> & { agent: StubAgentBinding; classifier: StubClassifierBinding; check: StubCheckBinding };
const parseStub = (raw: unknown, base: string) => {
  const loaded = parseRunConfig(raw, base);
  return { graphModule: loaded.graphModule, config: loaded.config as StubConfig };
};

const minimal = () => ({
  graph: "g.ts",
  agent: { adapter: "stub", fixtureDir: "fx" },
  classifier: { adapter: "stub", default: { answer: "no", p: 1 } },
  check: { adapter: "stub", default: "pass" },
});

const message = (raw: unknown): string => {
  try {
    parseRunConfig(raw, "/base");
  } catch (e) {
    return (e as Error).message;
  }
  return assert.fail("did not throw");
};

test("relative graph and fixture paths resolve against the config's folder; absolute ones stay", () => {
  const a = parseStub(minimal(), "/base/dir");
  assert.equal(a.graphModule, "/base/dir/g.ts");
  assert.equal(a.config.agent.fixtureDir, "/base/dir/fx");
  const b = parseStub({ ...minimal(), graph: "/abs/g.ts", agent: { adapter: "stub", fixtureDir: "/abs/fx" } }, "/base/dir");
  assert.equal(b.graphModule, "/abs/g.ts");
  assert.equal(b.config.agent.fixtureDir, "/abs/fx");
});

test("tracker and forge default to the file adapter with no dir, so the run dir is used", () => {
  const { config } = parseRunConfig(minimal(), "/base");
  assert.deepEqual(config.tracker, { adapter: "file" });
  assert.deepEqual(config.forge, { adapter: "file" });
  assert.deepEqual(config.roles, {});
});

test("a tracker dir is resolved against the config folder; a forge without one keeps none", () => {
  const { config } = parseRunConfig({ ...minimal(), tracker: { adapter: "file", dir: "t" }, forge: { adapter: "file" } }, "/base");
  assert.deepEqual(config.tracker, { adapter: "file", dir: "/base/t" });
  assert.deepEqual(config.forge, { adapter: "file" });
});

test("agent ask and hangOnAttempts are kept, and omitted when absent", () => {
  const { config } = parseStub({ ...minimal(), agent: { adapter: "stub", fixtureDir: "fx", ask: "which?", hangOnAttempts: [1, 3] } }, "/base");
  assert.equal(config.agent.ask, "which?");
  assert.deepEqual(config.agent.hangOnAttempts, [1, 3]);
  const plain = parseStub(minimal(), "/base").config.agent;
  assert.ok(!("ask" in plain) && !("hangOnAttempts" in plain));
});

test("role overrides carry only the kinds they name, with paths resolved", () => {
  const { config } = parseRunConfig(
    {
      ...minimal(),
      roles: {
        planner: { agent: { adapter: "stub", fixtureDir: "other" } },
        "needs-review": { classifier: { adapter: "stub", answers: { "needs-review": [{ answer: "yes", p: 0.8 }] }, default: { answer: "no", p: 1 } } },
        tests: { check: { adapter: "stub", answers: { tests: ["fail", "pass"] }, default: "pass" } },
      },
    },
    "/base",
  );
  assert.deepEqual(Object.keys(config.roles.planner!), ["agent"]);
  assert.equal((config.roles.planner!.agent as StubAgentBinding).fixtureDir, "/base/other");
  assert.deepEqual(Object.keys(config.roles["needs-review"]!), ["classifier"]);
  assert.deepEqual((config.roles["needs-review"]!.classifier as StubClassifierBinding).answers, { "needs-review": [{ answer: "yes", p: 0.8 }] });
  assert.deepEqual((config.roles.tests!.check as StubCheckBinding).answers, { tests: ["fail", "pass"] });
});

test("an unknown top-level key is refused by name", () => {
  assert.match(message({ ...minimal(), agnet: {} }), /config agnet: expected no key agnet/);
});

test("a missing graph or agent is refused, and every problem is reported together", () => {
  const msg = message({ classifier: minimal().classifier, check: minimal().check });
  assert.match(msg, /config graph: expected a string/);
  assert.match(msg, /config agent: expected an object/);
  assert.match(msg, /config agent\.fixtureDir: expected a string/);
});

test("a non-object config is refused", () => {
  assert.match(message([]), /\(root\): expected an object/);
  assert.match(message("x"), /\(root\): expected an object/);
});

test("an adapter outside the known set is refused for each kind, naming the set", () => {
  assert.match(message({ ...minimal(), agent: { adapter: "gemini", fixtureDir: "fx" } }), /agent\.adapter: expected one of stub \| claude \| codex/);
  assert.match(message({ ...minimal(), classifier: { adapter: "llm", default: { answer: "a", p: 1 } } }), /classifier\.adapter: expected one of stub \| jev \| haiku/);
  assert.match(message({ ...minimal(), check: { adapter: "ci", default: "pass" } }), /check\.adapter: expected one of stub \| shell/);
  assert.match(message({ ...minimal(), tracker: { adapter: "jira" } }), /tracker\.adapter: expected one of file \| linear/);
  assert.match(message({ ...minimal(), forge: { adapter: "gitlab" } }), /forge\.adapter: expected one of file \| github/);
});

test("a classifier probability outside [0, 1] is refused, at the default and in a role list, naming the path", () => {
  assert.match(message({ ...minimal(), classifier: { adapter: "stub", default: { answer: "a", p: 1.5 } } }), /classifier\.default\.p: expected a number in \[0, 1\]/);
  const raw = { ...minimal(), roles: { r: { classifier: { adapter: "stub", answers: { r: [{ answer: "a", p: 1 }, { answer: "b", p: -1 }] }, default: { answer: "a", p: 1 } } } } };
  assert.match(message(raw), /roles\.r\.classifier\.answers\.r\[1\]\.p: expected a number in \[0, 1\]/);
});

test("a check answer other than pass or fail is refused", () => {
  assert.match(message({ ...minimal(), check: { adapter: "stub", default: "maybe" } }), /check\.default: expected one of pass \| fail/);
  assert.match(message({ ...minimal(), check: { adapter: "stub", answers: { t: ["pass", "bogus"] }, default: "pass" } }), /check\.answers\.t\[1\]/);
});

test("hangOnAttempts refuses negative, fractional and non-numeric entries, and a non-array", () => {
  const hang = (h: unknown) => ({ ...minimal(), agent: { adapter: "stub", fixtureDir: "fx", hangOnAttempts: h } });
  assert.match(message(hang([-1])), /hangOnAttempts\[0\]: expected a non-negative integer/);
  assert.match(message(hang([1.5])), /hangOnAttempts\[0\]/);
  assert.match(message(hang(["1"])), /hangOnAttempts\[0\]/);
  assert.match(message(hang(1)), /hangOnAttempts: expected an array/);
});

test("a role binding that is not an object is refused", () => {
  assert.match(message({ ...minimal(), roles: { planner: "x" } }), /roles\.planner: expected an object/);
});

test("the state dir is the override when set and non-empty, else under the home directory", () => {
  assert.equal(graphStateDir({ AGENT_BUILD_GRAPH_DIR: "/x/y" }), "/x/y");
  assert.match(graphStateDir({}), /\.local[/\\]state[/\\]agent-build[/\\]graph$/);
  assert.match(graphStateDir({ AGENT_BUILD_GRAPH_DIR: "" }), /\.local[/\\]state[/\\]agent-build[/\\]graph$/);
});

test("a relative state dir is made absolute from the cwd, so git and the worker agree on it", () => {
  assert.equal(graphStateDir({ AGENT_BUILD_GRAPH_DIR: "rel/state" }), resolve("rel/state"));
});
