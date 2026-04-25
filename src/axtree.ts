export interface AxNode {
  role: string;
  title: string | null;
  children: AxNode[];
}

export interface TruncateOpts {
  maxNodes: number;
  maxDepth: number;
}

export function countNodes(t: AxNode): number {
  return 1 + (t.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

export function truncateAxTree(t: AxNode, opts: TruncateOpts): AxNode {
  let budget = opts.maxNodes;
  // depth is 1-based: root counts as depth 1. We stop descending once the
  // *next* depth would exceed maxDepth, so the resulting tree has at most
  // `maxDepth` levels (matching the test helper's 1-based counting).
  function trunc(node: AxNode, depth: number): AxNode {
    if (budget <= 0 || depth >= opts.maxDepth) {
      budget = Math.max(0, budget - 1);
      return { ...node, children: [] };
    }
    budget--;
    const kids: AxNode[] = [];
    for (const child of node.children ?? []) {
      if (budget <= 0) break;
      kids.push(trunc(child, depth + 1));
    }
    return { ...node, children: kids };
  }
  return trunc(t, 1);
}
