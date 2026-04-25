import { describe, expect, test } from "bun:test";
import { countNodes, truncateAxTree } from "../src/axtree.ts";

describe("axtree", () => {
  test("truncates to max nodes", () => {
    const tree = makeBigTree(500);
    const truncated = truncateAxTree(tree, { maxNodes: 200, maxDepth: 6 });
    expect(countNodes(truncated)).toBeLessThanOrEqual(200);
  });

  test("truncates to max depth", () => {
    const deep = makeDeepTree(20);
    const truncated = truncateAxTree(deep, { maxNodes: 1000, maxDepth: 6 });
    expect(maxDepth(truncated)).toBeLessThanOrEqual(6);
  });
});

// biome-ignore lint/suspicious/noExplicitAny: helper makes minimal nodes for tests
function makeBigTree(n: number): any {
  const children = Array.from({ length: n - 1 }, (_, i) => ({
    role: "AXLink",
    title: `n${i}`,
    children: [],
  }));
  return { role: "AXWindow", title: "root", children };
}
// biome-ignore lint/suspicious/noExplicitAny: helper makes minimal nodes for tests
function makeDeepTree(d: number): any {
  if (d === 0) return { role: "AXLeaf", title: null, children: [] };
  return { role: "AXGroup", title: null, children: [makeDeepTree(d - 1)] };
}
// biome-ignore lint/suspicious/noExplicitAny: tree shape is generic
function maxDepth(t: any): number {
  if (!t.children?.length) return 1;
  return 1 + Math.max(...t.children.map(maxDepth));
}
