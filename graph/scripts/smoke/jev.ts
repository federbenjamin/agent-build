/**
 * Live smoke for the Jev classifier: one real call with the shipped security setup (about
 * $0.0003). Not run in CI. Needs TYPESAFE_API_KEY.
 *
 *   TYPESAFE_API_KEY=... node graph/scripts/smoke/jev.ts
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Shape } from "../../../runtime/lib/shape.ts";
import { jevClassifier } from "../../adapters/jevClassifier.ts";
import { classifierBinding } from "../../bindings.ts";

const graphDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PRICE_PER_MILLION_INPUT_TOKENS = 0.042;

if ((process.env.TYPESAFE_API_KEY ?? "").trim() === "") {
  console.error("jev smoke: set TYPESAFE_API_KEY");
  process.exit(2);
}

const s = new Shape("smoke");
const binding = classifierBinding(s, { adapter: "jev", setup: "classifiers/security.json" }, "classifier", graphDir);
if (s.issues().length > 0 || binding.adapter !== "jev") throw new Error(s.issues().map((i) => i.message).join("\n"));

const diff = `diff --git a/src/sync.ts b/src/sync.ts
--- a/src/sync.ts
+++ b/src/sync.ts
@@ -1,3 +1,9 @@
+export async function pull(url: string) {
+  const res = await fetch(url);
+  return JSON.parse(await res.text());
+}
`;

let usage: unknown;
const fetch: typeof globalThis.fetch = async (url, init) => {
  const res = await globalThis.fetch(url, init);
  usage = ((await res.clone().json()) as { usage?: unknown }).usage;
  return res;
};

const started = Date.now();
const answer = await jevClassifier(binding, { fetch }).classify({
  question: "security",
  state: { diff: { schema: "text", text: diff } },
  iteration: 0,
  signal: new AbortController().signal,
});
const tokens = (usage as { input_tokens?: number } | undefined)?.input_tokens;
console.log(JSON.stringify({ model: binding.model, answer, cutoff: binding.cutoff, ms: Date.now() - started, usage, costUsd: tokens === undefined ? null : (tokens * PRICE_PER_MILLION_INPUT_TOKENS) / 1e6 }, null, 2));
