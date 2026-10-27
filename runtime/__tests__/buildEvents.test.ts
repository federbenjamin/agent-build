import "./helpers/operatorEnv.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILD_EVENT_NAMES,
  BuildEventError,
  formatBuildEvent,
  isBuildEventName,
  parseBuildEvent,
  readBuildEvent,
  type BuildEvent,
} from "../lib/buildEvents.ts";

const BASE = { schema: 4, runid: "build-7", at: "2026-10-06T12:00:00.000Z" } as const;

const EVENTS: readonly BuildEvent[] = [
  { ...BASE, event: "plan", repo: "octo/app", units: [{ id: "unit-1", title: "Install" }] },
  { ...BASE, event: "unit-merged", id: "unit-1", pr: 42 },
  { ...BASE, event: "blocked", id: "unit-1", needs: "database access" },
  { ...BASE, event: "finished", outcome: "merged", pr: 42 },
  {
    ...BASE,
    event: "plan",
    plan: "Setup",
    plan_path: "/plans/setup.md",
    repo: "octo/app",
    units: [{ id: "u1", title: "Install" }],
  },
  { ...BASE, event: "unit-started", id: "u1", plan_path: "/plans/setup.md", repo: "octo/app" },
  { ...BASE, event: "unit-started", id: "build-7", repo: "octo/app" },
  { ...BASE, event: "finished", outcome: "abandoned", pr: 7, branch: "graph/g-1", worktrees: ["/runs/g-1/worktree", "/runs/g-1/worktrees/A-fixer"] },
];

const WIRES = [
  '{"schema":4,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"plan","repo":"octo/app","units":[{"id":"unit-1","title":"Install"}]}\n',
  '{"schema":4,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"unit-merged","id":"unit-1","pr":42}\n',
  '{"schema":4,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"blocked","id":"unit-1","needs":"database access"}\n',
  '{"schema":4,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"finished","outcome":"merged","pr":42}\n',
  '{"schema":4,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"plan","plan":"Setup","plan_path":"/plans/setup.md","repo":"octo/app","units":[{"id":"u1","title":"Install"}]}\n',
  '{"schema":4,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"unit-started","id":"u1","plan_path":"/plans/setup.md","repo":"octo/app"}\n',
  '{"schema":4,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"unit-started","id":"build-7","repo":"octo/app"}\n',
  '{"schema":4,"runid":"build-7","at":"2026-10-06T12:00:00.000Z","event":"finished","outcome":"abandoned","pr":7,"branch":"graph/g-1","worktrees":["/runs/g-1/worktree","/runs/g-1/worktrees/A-fixer"]}\n',
] as const;

test("build events: every declared event parses and its wire form round-trips in fixed key order", () => {
  for (const [index, event] of EVENTS.entries()) {
    assert.deepEqual(parseBuildEvent(event), event, event.event);
    const wire = formatBuildEvent(event);
    assert.ok(wire.endsWith("\n"), event.event);
    assert.equal(wire.split("\n").length, 2, event.event);
    assert.equal(wire, WIRES[index], event.event);
    assert.deepEqual(readBuildEvent(wire), event, event.event);
  }
});

test("build events: malformed JSON is reported as a BuildEventError", () => {
  assert.throws(
    () => readBuildEvent("not json"),
    (error: unknown) => {
      assert.ok(error instanceof BuildEventError);
      assert.match(error.message, /^build event is not JSON:/);
      return true;
    }
  );
});

test("build events: every validation rule refuses its bad field path", () => {
  const cases: ReadonlyArray<{ name: string; raw: unknown; path: string }> = [
    { name: "schema 1", raw: { ...EVENTS[0], schema: 1 }, path: "schema" },
    { name: "schema 2", raw: { ...EVENTS[0], schema: 2 }, path: "schema" },
    { name: "schema 3", raw: { ...EVENTS[0], schema: 3 }, path: "schema" },
    { name: "unit-started without id", raw: { ...EVENTS[5], id: undefined }, path: "id" },
    { name: "unit-started id with =", raw: { ...EVENTS[5], id: "u=1" }, path: "id" },
    { name: "unit-started without repo", raw: { ...EVENTS[5], repo: undefined }, path: "repo" },
    { name: "unit-started empty plan path", raw: { ...EVENTS[5], plan_path: "" }, path: "plan_path" },
    { name: "pr field on unit-started", raw: { ...EVENTS[5], pr: 3 }, path: "pr" },
    { name: "plan without repo", raw: { ...EVENTS[0], repo: undefined }, path: "repo" },
    { name: "repo as a URL", raw: { ...EVENTS[0], repo: "git@github.com:octo/app.git" }, path: "repo" },
    { name: "repo with no owner", raw: { ...EVENTS[0], repo: "/app" }, path: "repo" },
    { name: "repo with a dot-dot part", raw: { ...EVENTS[0], repo: "octo/.." }, path: "repo" },
    { name: "repo with a shell character", raw: { ...EVENTS[0], repo: "octo/$(app)" }, path: "repo" },
    { name: "empty plan title", raw: { ...EVENTS[4], plan: "" }, path: "plan" },
    { name: "empty plan path", raw: { ...EVENTS[4], plan_path: "" }, path: "plan_path" },
    { name: "plan field on another event", raw: { ...EVENTS[1], plan: "Setup" }, path: "plan" },
    { name: "empty runid", raw: { ...EVENTS[0], runid: "" }, path: "runid" },
    { name: "bad timestamp", raw: { ...EVENTS[0], at: "not-a-date" }, path: "at" },
    { name: "unknown event", raw: { ...EVENTS[0], event: "queued" }, path: "event" },
    { name: "unknown top-level key", raw: { ...EVENTS[0], extra: true }, path: "extra" },
    { name: "empty plan", raw: { ...EVENTS[0], units: [] }, path: "units" },
    {
      name: "duplicate unit id",
      raw: { ...EVENTS[0], units: [{ id: "unit-1", title: "Install" }, { id: "unit-1", title: "Test" }] },
      path: "units[1].id",
    },
    { name: "whitespace in id", raw: { ...EVENTS[1], id: "unit 1" }, path: "id" },
    { name: "zero PR", raw: { ...EVENTS[1], pr: 0 }, path: "pr" },
    { name: "bad finished outcome", raw: { ...EVENTS[3], outcome: "timed-out" }, path: "outcome" },
    { name: "empty finished branch", raw: { ...EVENTS[3], branch: "" }, path: "branch" },
    { name: "an empty worktree path", raw: { ...EVENTS[3], worktrees: ["/a", ""] }, path: "worktrees[1]" },
    { name: "worktrees not a list", raw: { ...EVENTS[3], worktrees: "/a" }, path: "worktrees" },
    { name: "branch field on blocked", raw: { ...EVENTS[2], branch: "graph/g-1" }, path: "branch" },
  ];

  for (const { name, raw, path } of cases) {
    assert.throws(
      () => parseBuildEvent(raw),
      (error: unknown) => {
        assert.ok(error instanceof BuildEventError, name);
        assert.ok(
          error.issues.some((issue) => issue.message.startsWith(`build event ${path}:`)),
          `${name}: ${error.message}`
        );
        return true;
      },
      name
    );
  }
});

test("build events: isBuildEventName holds for each event name and nothing else", () => {
  for (const name of BUILD_EVENT_NAMES) assert.equal(isBuildEventName(name), true, name);
  for (const v of ["queued", "", "Plan", undefined, null, 1, ["plan"]]) assert.equal(isBuildEventName(v), false, String(v));
});

test("build events: an unknown key is refused at its own path, an unknown event once at event", () => {
  const unknownKey = (raw: unknown) => {
    try {
      parseBuildEvent(raw);
    } catch (e) {
      assert.ok(e instanceof BuildEventError);
      return e.issues.map((i) => i.message);
    }
    return [];
  };
  assert.deepEqual(unknownKey({ ...BASE, event: "finished", outcome: "merged", extra: 1 }), [
    "build event extra: expected no key extra",
  ]);
  assert.deepEqual(unknownKey({ ...BASE, event: "queued" }), [
    "build event event: expected one of plan | unit-started | unit-merged | blocked | finished",
  ]);
});
