import "../../runtime/__tests__/helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { linearTargetOf, parseLinearTarget } from "../adapters/linearNotes.ts";
import { linearTracker } from "../adapters/linearTracker.ts";
import { LINEAR_API_URL } from "../constants.ts";
import { RunError } from "../contracts.ts";

const signal = new AbortController().signal;
const reply = (body: unknown, status = 200): Response => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

interface Sent {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: any;
}

/** A GraphQL endpoint that answers each request with the next scripted reply. */
function fakeLinear(replies: (Response | Error)[], target = { team: "DEV", labels: ["bug"] }) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push({ url, headers: init.headers as Record<string, string>, query: body.query, variables: body.variables });
    const next = replies[sent.length - 1];
    if (next === undefined) throw new Error("no reply scripted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  const tracker = linearTracker({ fetch, env: { LINEAR_API_KEY: "lin_key" }, target: () => target });
  return { sent, tracker };
}

const issue = { id: "uuid-1", identifier: "DEV-3", title: "Fix it", description: "Details", url: "https://linear.app/x/issue/DEV-3" };

// ---- ingest ----

test("ingest reads an issue by identifier into its id, title and body, sending the key as the authorization", async () => {
  const { sent, tracker } = fakeLinear([reply({ data: { issue } })]);
  assert.deepEqual(await tracker.ingest("DEV-3", signal), { id: "DEV-3", title: "Fix it", body: "Details" });
  assert.equal(sent[0]!.url, LINEAR_API_URL);
  assert.equal(sent[0]!.headers.Authorization, "lin_key");
  assert.deepEqual(sent[0]!.variables, { id: "DEV-3" });
  assert.match(sent[0]!.query, /issue\(id: \$id\)/);
});

test("an issue with no description ingests with an empty body", async () => {
  const { tracker } = fakeLinear([reply({ data: { issue: { ...issue, description: null } } })]);
  assert.equal((await tracker.ingest("DEV-3", signal)).body, "");
});

test("an identifier that is not one is refused before any request, and a missing issue fails", async () => {
  const { sent, tracker } = fakeLinear([reply({ data: { issue: null } })]);
  for (const bad of ["", "DEV", "DEV-3 OR 1", "../x", "dev-x"]) await assert.rejects(tracker.ingest(bad, signal), RunError, bad);
  assert.equal(sent.length, 0);
  await assert.rejects(tracker.ingest("DEV-99", signal), /no issue DEV-99/);
});

test("a GraphQL error, an HTTP error, and a reply that is not JSON each fail with the status", async () => {
  await assert.rejects(fakeLinear([reply({ errors: [{ message: "Entity not found" }] })]).tracker.ingest("DEV-3", signal), /Linear HTTP 200: Entity not found/);
  await assert.rejects(fakeLinear([reply({ data: null }, 401)]).tracker.ingest("DEV-3", signal), /Linear HTTP 401/);
  await assert.rejects(fakeLinear([reply("<html>bad gateway</html>", 502)]).tracker.ingest("DEV-3", signal), /Linear HTTP 502: the reply is not JSON/);
});

test("a timeout is the fetch's rejection, passed through", async () => {
  const timeout = new Error("aborted due to timeout");
  await assert.rejects(fakeLinear([timeout]).tracker.ingest("DEV-3", signal), (e: unknown) => e === timeout);
});

test("with no key set every call is a run error before any request", async () => {
  const sent: unknown[] = [];
  const fetch = (async () => void sent.push(1)) as unknown as typeof globalThis.fetch;
  const tracker = linearTracker({ fetch, env: {}, target: () => ({ team: "DEV", labels: [] }) });
  await assert.rejects(tracker.ingest("DEV-3", signal), (e: unknown) => e instanceof RunError && /LINEAR_API_KEY/.test(e.message));
  assert.equal(sent.length, 0);
});

// ---- file ----

const team = { data: { teams: { nodes: [{ id: "team-uuid" }] } } };
const page = (nodes: unknown[], next: string | null = null) => ({ data: { issueLabels: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } });
const labels = page([{ id: "label-ws", name: "bug", team: null }, { id: "label-other", name: "bug", team: { key: "OPS" } }]);

test("file resolves the notes' team and labels to ids, then creates the issue with the title and body", async () => {
  const created = { data: { issueCreate: { success: true, issue: { identifier: "DEV-7", url: "https://linear.app/x/issue/DEV-7" } } } };
  const { sent, tracker } = fakeLinear([reply(team), reply(labels), reply(created)]);
  const ref = await tracker.file({ title: "Leftover", body: "## findings\n\nx" }, signal);
  assert.deepEqual(ref, { schema: "ref", kind: "ticket", id: "DEV-7", url: "https://linear.app/x/issue/DEV-7" });
  assert.deepEqual(sent[0]!.variables, { key: "DEV" });
  assert.deepEqual(sent[1]!.variables, { names: ["bug"], after: null });
  assert.deepEqual(sent[2]!.variables, { input: { teamId: "team-uuid", title: "Leftover", description: "## findings\n\nx", labelIds: ["label-ws"] } });
});

test("a repo with no labels files without the label lookup", async () => {
  const created = { data: { issueCreate: { success: true, issue: { identifier: "DEV-8", url: "u" } } } };
  const { sent, tracker } = fakeLinear([reply(team), reply(created)], { team: "DEV", labels: [] });
  await tracker.file({ title: "t", body: "b" }, signal);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.variables.input.labelIds, []);
});

test("an unknown team or a label the team cannot use stops the filing before the issue is created", async () => {
  const none = fakeLinear([reply({ data: { teams: { nodes: [] } } })]);
  await assert.rejects(none.tracker.file({ title: "t", body: "b" }, signal), (e: unknown) => e instanceof RunError && /no team with key DEV/.test(e.message));
  const nolabel = fakeLinear([reply(team), reply(page([{ id: "x", name: "bug", team: { key: "OPS" } }]))]);
  await assert.rejects(nolabel.tracker.file({ title: "t", body: "b" }, signal), (e: unknown) => e instanceof RunError && /no label "bug" for team DEV/.test(e.message));
  assert.equal(nolabel.sent.length, 2, "no create request");
});

test("a team's label on a later page is found: every page is read before a label is called missing", async () => {
  const created = { data: { issueCreate: { success: true, issue: { identifier: "DEV-9", url: "u" } } } };
  const other = Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, name: "bug", team: { key: "OPS" } }));
  const { sent, tracker } = fakeLinear([reply(team), reply(page(other, "cursor-1")), reply(page([{ id: "mine", name: "bug", team: { key: "DEV" } }])), reply(created)]);
  await tracker.file({ title: "t", body: "b" }, signal);
  assert.deepEqual(sent[1]!.variables, { names: ["bug"], after: null });
  assert.deepEqual(sent[2]!.variables, { names: ["bug"], after: "cursor-1" });
  assert.deepEqual(sent[3]!.variables.input.labelIds, ["mine"]);
});

test("a create that reports no success fails", async () => {
  const { tracker } = fakeLinear([reply(team), reply(labels), reply({ data: { issueCreate: { success: false, issue: null } } })]);
  await assert.rejects(tracker.file({ title: "t", body: "b" }, signal), /was not created/);
});

// ---- comment ----

test("comment resolves the issue by identifier, then adds the comment and returns the issue with the comment's url", async () => {
  const done = { data: { commentCreate: { success: true, comment: { url: "https://linear.app/x/issue/DEV-3#comment-1" } } } };
  const { sent, tracker } = fakeLinear([reply({ data: { issue } }), reply(done)]);
  const ref = await tracker.comment("DEV-3", "PR is open", signal);
  assert.deepEqual(ref, { schema: "ref", kind: "ticket", id: "DEV-3", url: "https://linear.app/x/issue/DEV-3#comment-1" });
  assert.deepEqual(sent[1]!.variables, { input: { issueId: "uuid-1", body: "PR is open" } });
});

test("a comment that reports no success fails, and a bad identifier never reaches the API", async () => {
  const { sent, tracker } = fakeLinear([reply({ data: { issue } }), reply({ data: { commentCreate: { success: false, comment: null } } })]);
  await assert.rejects(tracker.comment("DEV-3", "x", signal), /was not created/);
  await assert.rejects(tracker.comment("nope", "x", signal), RunError);
  assert.equal(sent.length, 2);
});

test("a comment with a key that an existing comment starts with is reused: nothing is posted", async () => {
  const comments = (nodes: { body: string; url: string }[], next: string | null = null) =>
    reply({ data: { issue: { comments: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } } });
  const key = "Work started: run r-1,";
  const earlier = { body: `${key} brief x at abc.`, url: "https://linear.app/x/issue/DEV-3#comment-old" };
  const { sent, tracker } = fakeLinear([reply({ data: { issue } }), comments([{ body: "Work started: run r-10, brief x", url: "u" }], "cursor-1"), comments([earlier])]);
  const ref = await tracker.comment("DEV-3", `${key} brief x at def.`, signal, key);
  assert.deepEqual(ref, { schema: "ref", kind: "ticket", id: "DEV-3", url: earlier.url });
  assert.equal(sent.length, 3, "no create request");
  assert.deepEqual(sent[1]!.variables, { id: "uuid-1", after: null });
  assert.deepEqual(sent[2]!.variables, { id: "uuid-1", after: "cursor-1" });
});

test("a comment with a key that no comment starts with is posted after every page is read", async () => {
  const none = { data: { issue: { comments: { nodes: [{ body: "something else", url: "u" }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
  const done = { data: { commentCreate: { success: true, comment: { url: "https://linear.app/x/issue/DEV-3#comment-1" } } } };
  const { sent, tracker } = fakeLinear([reply({ data: { issue } }), reply(none), reply(done)]);
  const ref = await tracker.comment("DEV-3", "Work started: run r-1, brief x.", signal, "Work started: run r-1,");
  assert.equal(ref.url, "https://linear.app/x/issue/DEV-3#comment-1");
  assert.deepEqual(sent[2]!.variables, { input: { issueId: "uuid-1", body: "Work started: run r-1, brief x." } });
});

// ---- the repo's notes ----

const NOTES = `# notes\n\n## build\n\n- team: WRONG\n\n## tracker\n\nSome prose.\n\n- team: DEV\n- labels: bug, tech-debt\n\n## simplifier\n\nlabels: nope\n`;

test("the team and labels come from the notes' tracker section only", () => {
  assert.deepEqual(parseLinearTarget(NOTES, "notes.md"), { team: "DEV", labels: ["bug", "tech-debt"] });
  assert.deepEqual(parseLinearTarget("## Tracker\nTeam: ENG\n", "n"), { team: "ENG", labels: [] });
});

test("notes with no tracker section, or one with no team, are a run error naming the file", () => {
  assert.throws(() => parseLinearTarget("## build\n- team: DEV\n", "/r/notes.md"), (e: unknown) => e instanceof RunError && /\/r\/notes\.md has no "## tracker" section/.test(e.message));
  assert.throws(() => parseLinearTarget("## tracker\n- labels: bug\n", "n"), (e: unknown) => e instanceof RunError && /no "team:" line/.test(e.message));
});

test("the target is read from the notes as of the base commit, through the base-commit reader", () => {
  const asked: string[][] = [];
  const target = linearTargetOf("/w", "abc123", { notesAtBase: (w, b) => (asked.push([w, b]), { path: "/w/docs/n.md", text: NOTES }) });
  assert.deepEqual(target, { team: "DEV", labels: ["bug", "tech-debt"] });
  assert.deepEqual(asked, [["/w", "abc123"]]);
  assert.throws(() => linearTargetOf("/w", "abc123", { notesAtBase: () => null }), (e: unknown) => e instanceof RunError && /no notes step/.test(e.message));
});

test("the target is read only when something is filed, so an ingest needs no notes", async () => {
  const fetch = (async () => reply({ data: { issue } })) as unknown as typeof globalThis.fetch;
  const tracker = linearTracker({
    fetch,
    env: { LINEAR_API_KEY: "k" },
    target: () => {
      throw new Error("notes were read");
    },
  });
  assert.equal((await tracker.ingest("DEV-3", signal)).id, "DEV-3");
});
