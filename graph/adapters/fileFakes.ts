/**
 * The file-backed tracker and forge: a mock run files tickets and opens PRs as JSON files under a
 * folder, so nothing real is touched. A ticket to ingest is seeded as `<dir>/tickets/<id>.json`
 * (`{ "title", "body" }`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { gitOut } from "../../runtime/lib/gitOps.ts";
import type { Forge, Tracker } from "./types.ts";

/** Write `value` as the next numbered record in `<dir>/<folder>/`; returns its number and path. */
function appendRecord(dir: string, folder: string, value: unknown): { n: number; path: string } {
  const at = join(dir, folder);
  mkdirSync(at, { recursive: true });
  const n = readdirSync(at).filter((f) => f.endsWith(".json")).length + 1;
  const path = join(at, `${n}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return { n, path };
}

function readRecord(path: string, what: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`${what}: no ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function fileTracker(dir: string): Tracker {
  return {
    async ingest(ref) {
      if (!/^[\w.-]+$/.test(ref)) throw new Error(`file tracker: ${JSON.stringify(ref)} is not a ticket id`);
      const o = readRecord(join(dir, "tickets", `${ref}.json`), `file tracker ticket ${ref}`);
      return { id: ref, title: String(o.title ?? ""), body: String(o.body ?? "") };
    },
    async file(ticket) {
      const { n, path } = appendRecord(dir, "filed", ticket);
      return { schema: "ref", kind: "ticket", id: `T-${n}`, url: pathToFileURL(path).href };
    },
    async comment(ref, body, _signal, key) {
      if (!/^[\w.-]+$/.test(ref)) throw new Error(`file tracker: ${JSON.stringify(ref)} is not a ticket id`);
      if (key !== undefined) {
        const at = join(dir, "comments");
        const files = existsSync(at) ? readdirSync(at).filter((f) => f.endsWith(".json")) : [];
        for (const f of files) {
          const o = readRecord(join(at, f), "file tracker comment");
          if (o.ref === ref && String(o.body).startsWith(key)) return { schema: "ref", kind: "ticket", id: ref, url: pathToFileURL(join(at, f)).href };
        }
      }
      const { path } = appendRecord(dir, "comments", { ref, body });
      return { schema: "ref", kind: "ticket", id: ref, url: pathToFileURL(path).href };
    },
  };
}

export function fileForge(dir: string): Forge {
  return {
    async push({ worktree, branch }) {
      const sha = gitOut(["rev-parse", "HEAD"], { cwd: worktree }).trim();
      appendRecord(dir, "pushes", { branch, sha });
      return { schema: "ref", kind: "commit", id: sha };
    },
    async openPr({ branch, title, body, draft }) {
      const { n, path } = appendRecord(dir, "prs", { branch, title, body, draft: draft ?? false, merged: false });
      return { schema: "ref", kind: "pr", id: String(n), url: pathToFileURL(path).href };
    },
    async merge({ pr }) {
      if (!/^\d+$/.test(pr)) throw new Error(`file forge: ${JSON.stringify(pr)} is not a PR number`);
      const path = join(dir, "prs", `${pr}.json`);
      const o = readRecord(path, `file forge PR ${pr}`);
      writeFileSync(path, `${JSON.stringify({ ...o, merged: true }, null, 2)}\n`);
      return { schema: "ref", kind: "merge", id: pr, url: pathToFileURL(path).href };
    },
    async prState({ pr }) {
      if (!/^\d+$/.test(pr)) throw new Error(`file forge: ${JSON.stringify(pr)} is not a PR number`);
      return readRecord(join(dir, "prs", `${pr}.json`), `file forge PR ${pr}`).merged === true ? "MERGED" : "OPEN";
    },
  };
}
