// Disjoint sets over the indices 0..n-1: the one union-find the fix table's merge (`table.ts`) and the
// build graph's fix slices (`graph/pipelines/build/slices.ts`) share.

export interface DisjointSet {
  /** The root of `i`'s set: its smallest index. */
  find(i: number): number;
  /** Join the sets of `a` and `b`; returns the joined set's root. */
  union(a: number, b: number): number;
}

export function disjointSet(n: number): DisjointSet {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  return {
    find,
    union(a, b) {
      const [ra, rb] = [find(a), find(b)];
      const root = Math.min(ra, rb);
      parent[Math.max(ra, rb)] = root;
      return root;
    },
  };
}

/** The sets of `ds` over 0..n-1, each its members in index order, the sets in the order of their
 *  first member. */
export function setsOf(ds: DisjointSet, n: number): number[][] {
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = ds.find(i);
    byRoot.set(root, [...(byRoot.get(root) ?? []), i]);
  }
  return [...byRoot.values()];
}
