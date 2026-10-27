import "./helpers/operatorEnv.ts";

import { test } from "node:test";
import assert from "node:assert/strict";

import { disjointSet, setsOf } from "../lib/disjointSet.ts";

test("unions are transitive, a set's root is its smallest index, and the sets list in order of their first member", () => {
  const ds = disjointSet(6);
  assert.equal(ds.union(4, 1), 1);
  assert.equal(ds.union(5, 4), 1, "5 joins 1's set through 4");
  ds.union(3, 2);
  assert.equal(ds.find(5), 1);
  assert.deepEqual(setsOf(ds, 6), [[0], [1, 4, 5], [2, 3]]);
  assert.equal(ds.union(1, 5), 1, "a union inside one set changes nothing");
  assert.deepEqual(setsOf(disjointSet(0), 0), []);
});
