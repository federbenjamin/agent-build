/**
 * The Linear tracker over its GraphQL API, key from `LINEAR_API_KEY`. Ingest reads an issue by
 * identifier; file and comment write, once (the activity never retries them; a comment given a key
 * first looks for one that starts with it, so its caller may retry). The team and labels a
 * ticket gets come from the target repo's notes (`linearNotes.ts`), read when one is filed.
 */

import { LINEAR_API_URL, LINEAR_REQUEST_TIMEOUT_MS } from "../constants.ts";
import { RunError } from "../contracts.ts";
import type { LinearTarget } from "./linearNotes.ts";
import type { Tracker } from "./types.ts";

export interface LinearDeps {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  /** The team and labels of the repo the run works on. */
  target: () => LinearTarget;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
}

export function linearTracker(deps: LinearDeps): Tracker {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;

  async function gql<T>(query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const key = env.LINEAR_API_KEY?.trim();
    if (key === undefined || key === "") throw new RunError("Linear tracker: LINEAR_API_KEY is not set");
    const res = await doFetch(LINEAR_API_URL, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(LINEAR_REQUEST_TIMEOUT_MS)]),
    });
    const text = await res.text();
    let body: { data?: T; errors?: { message?: string }[] };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Linear HTTP ${res.status}: the reply is not JSON`);
    }
    if (body.errors !== undefined && body.errors.length > 0) {
      throw new Error(`Linear HTTP ${res.status}: ${body.errors.map((e) => e.message ?? "error").join("; ").slice(0, 300)}`);
    }
    if (!res.ok || body.data === undefined) throw new Error(`Linear HTTP ${res.status}: no data in the reply`);
    return body.data;
  }

  async function issueOf(ref: string, signal: AbortSignal): Promise<Issue> {
    if (!IDENTIFIER.test(ref)) throw new RunError(`Linear tracker: ${JSON.stringify(ref)} is not an issue identifier`);
    const data = await gql<{ issue: Issue | null }>(
      "query($id: String!) { issue(id: $id) { id identifier title description url } }",
      { id: ref },
      signal
    );
    if (data.issue === null) throw new Error(`Linear tracker: no issue ${ref}`);
    return data.issue;
  }

  async function teamId(key: string, signal: AbortSignal): Promise<string> {
    const data = await gql<{ teams: { nodes: { id: string }[] } }>(
      "query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }",
      { key },
      signal
    );
    const id = data.teams.nodes[0]?.id;
    if (id === undefined) throw new RunError(`Linear tracker: no team with key ${key}`);
    return id;
  }

  /** The id of each label name: a workspace label or one of the team's; a missing one is an error.
   *  The name filter is the server's; the team is chosen here, so every page is read before a label is
   *  called missing (the same name can exist on many teams). */
  async function labelIds(names: string[], teamKey: string, signal: AbortSignal): Promise<string[]> {
    if (names.length === 0) return [];
    type Label = { id: string; name: string; team: { key: string } | null };
    const found: Label[] = [];
    let after: string | null = null;
    for (;;) {
      const data: { issueLabels: { nodes: Label[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
        "query($names: [String!], $after: String) { issueLabels(first: 100, after: $after, filter: { name: { in: $names } }) { nodes { id name team { key } } pageInfo { hasNextPage endCursor } } }",
        { names, after },
        signal
      );
      found.push(...data.issueLabels.nodes);
      const page = data.issueLabels.pageInfo;
      if (!page.hasNextPage || page.endCursor === null) break;
      after = page.endCursor;
    }
    return names.map((name) => {
      const hit = found.find((l) => l.name === name && (l.team === null || l.team.key === teamKey));
      if (hit === undefined) throw new RunError(`Linear tracker: no label ${JSON.stringify(name)} for team ${teamKey}`);
      return hit.id;
    });
  }

  /** The url of the first comment on the issue whose body starts with `key`, or null; every page is read. */
  async function commentStartingWith(issueId: string, key: string, signal: AbortSignal): Promise<string | null> {
    type Page = { issue: { comments: { nodes: { body: string; url: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null };
    let after: string | null = null;
    for (;;) {
      const data: Page = await gql(
        "query($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { body url } pageInfo { hasNextPage endCursor } } } }",
        { id: issueId, after },
        signal
      );
      if (data.issue === null) throw new Error("Linear tracker: the issue is gone");
      const { nodes, pageInfo } = data.issue.comments;
      const hit = nodes.find((c) => c.body.startsWith(key));
      if (hit !== undefined) return hit.url;
      if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return null;
      after = pageInfo.endCursor;
    }
  }

  return {
    async ingest(ref, signal) {
      const issue = await issueOf(ref, signal);
      return { id: issue.identifier, title: issue.title, body: issue.description ?? "" };
    },

    async file(ticket, signal) {
      const target = deps.target();
      const input = {
        teamId: await teamId(target.team, signal),
        title: ticket.title,
        description: ticket.body,
        labelIds: await labelIds(target.labels, target.team, signal),
      };
      const data = await gql<{ issueCreate: { success: boolean; issue: { identifier: string; url: string } | null } }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
        { input },
        signal
      );
      const issue = data.issueCreate.issue;
      if (!data.issueCreate.success || issue === null) throw new Error("Linear tracker: the issue was not created");
      return { schema: "ref", kind: "ticket", id: issue.identifier, url: issue.url };
    },

    async comment(ref, body, signal, key) {
      const issue = await issueOf(ref, signal);
      if (key !== undefined) {
        const url = await commentStartingWith(issue.id, key, signal);
        if (url !== null) return { schema: "ref", kind: "ticket", id: issue.identifier, url };
      }
      const data = await gql<{ commentCreate: { success: boolean; comment: { url: string } | null } }>(
        "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }",
        { input: { issueId: issue.id, body } },
        signal
      );
      const comment = data.commentCreate.comment;
      if (!data.commentCreate.success || comment === null) throw new Error("Linear tracker: the comment was not created");
      return { schema: "ref", kind: "ticket", id: issue.identifier, url: comment.url };
    },
  };
}
