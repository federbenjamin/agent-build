/**
 * The mock fixtures hold nothing personal: no home path (`~/` or a macOS one), no email address, no
 * private name or ticket prefix that `make.ts` redacted. The redacted words are read as hashes from
 * each fixture's `redactions.json`, so this file does not name them either.
 */

import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { EMAIL, HOME_PATH, ticketIds, TILDE_HOME } from "../../runtime/lib/privateText.ts";
import { type Redactions, sha256 } from "../mock/make.ts";
import { FIXTURES, NO_FIXTURES } from "./helpers/fixtures.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every file of every fixture (`build-*`). */
const files = (NO_FIXTURES ? [] : readdirSync(FIXTURES))
  .filter((n) => n.startsWith("build-"))
  .flatMap((n) => walk(join(FIXTURES, n)))
  .map((path) => ({ path, rel: relative(FIXTURES, path), text: readFileSync(path, "utf8") }));
const redactions = files.filter((f) => f.rel.endsWith("redactions.json")).map((f) => JSON.parse(f.text) as Redactions);

test("each fixture records what make.ts redacted", { skip: NO_FIXTURES }, () => {
  const fixtures = readdirSync(FIXTURES).filter((n) => n.startsWith("build-"));
  assert.ok(fixtures.length > 0);
  for (const f of fixtures) assert.ok(files.some((x) => x.rel === join(f, "redactions.json")), `${f} has no redactions.json`);
});

test("no fixture file holds a home path or an email address", { skip: NO_FIXTURES }, () => {
  const hits = files.flatMap((f) => [
    ...(TILDE_HOME.test(f.text) ? [`${f.rel}: ~/`] : []),
    ...(HOME_PATH.test(f.text) ? [`${f.rel}: ${HOME_PATH.exec(f.text)![0]}`] : []),
    ...(EMAIL.test(f.text) ? [`${f.rel}: ${EMAIL.exec(f.text)![0]}`] : []),
  ]);
  assert.deepEqual(hits, []);
});

test("no fixture file holds a redacted word or a redacted ticket prefix", { skip: NO_FIXTURES }, () => {
  const words = redactions.flatMap((r) => r.words);
  const tickets = new Set(redactions.flatMap((r) => r.tickets.map((t) => t.sha256)));
  assert.ok(words.length > 0 && tickets.size > 0, "the fixtures name words and ticket prefixes to look for");
  const hits: string[] = [];
  for (const f of files) {
    const lower = f.text.toLowerCase();
    for (const len of new Set(words.map((w) => w.length))) {
      const want = new Set(words.filter((w) => w.length === len).map((w) => w.sha256));
      const grams = new Set<string>();
      for (let i = 0; i + len <= lower.length; i++) grams.add(lower.slice(i, i + len));
      for (const g of grams) if (want.has(sha256(g))) hits.push(`${f.rel}: a redacted word at offset ${lower.indexOf(g)}`);
    }
    for (const t of ticketIds(f.text)) if (tickets.has(sha256(t.prefix.toLowerCase()))) hits.push(`${f.rel}: a redacted ticket id at offset ${t.index}`);
  }
  assert.deepEqual(hits, []);
});
