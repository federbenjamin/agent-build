// agents.json declares the build agents; agents/<name>.md holds each one's prompt. The harness's
// generator reads both, so neither may hold a name the other lacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const declared = JSON.parse(readFileSync(new URL("agents.json", ROOT), "utf8")).agents.map((a) => a.name);
const files = readdirSync(new URL("agents/", ROOT))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -".md".length));

test("agents.json declares each agent once", () => {
  assert.ok(declared.length > 0, "agents.json declares agents");
  assert.deepEqual([...new Set(declared)], declared);
});

test("every agent in agents.json has an agents/<name>.md", () => {
  assert.deepEqual(declared.filter((n) => !files.includes(n)), []);
});

test("every agents/*.md is in agents.json", () => {
  assert.deepEqual(files.filter((n) => !declared.includes(n)), []);
});
