/**
 * Catalog F4 `graph-visualizer` — Section 26 Studio.
 *
 * Deterministic 2D layout for `IrGraphV0`. v0 ships a layered DAG
 * layout (entry on the left, BFS columns to the right) — produces
 * stable, readable positions for the typical small graphs the
 * meta-harness emits without pulling in D3 as a runtime dep.
 *
 * The kickoff describes a "D3 force-directed layout" — that's the UI
 * runtime layer. This module hands the UI a deterministic seed
 * positioning that the force simulation can refine if it wants. T1
 * stability test: same graph → same positions ±1 px (we hand back
 * ±0 px because we're deterministic).
 */
import type { IrGraphV0 } from "@crewhaus/ir";

export type NodePosition = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
};

export type EdgeView = {
  readonly from: string;
  readonly to: string;
  /** Resolved positions for convenient SVG path emission. */
  readonly fromXY: { x: number; y: number };
  readonly toXY: { x: number; y: number };
};

export type Layout = {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<NodePosition>;
  readonly edges: ReadonlyArray<EdgeView>;
};

export type LayoutOptions = {
  readonly columnGap?: number;
  readonly rowGap?: number;
  readonly margin?: number;
};

const DEFAULT_COLUMN_GAP = 180;
const DEFAULT_ROW_GAP = 80;
const DEFAULT_MARGIN = 40;

/**
 * Layered BFS positioning:
 *   1. Compute each node's column = shortest-path distance from
 *      `entry` (BFS over outgoing edges). Unreachable nodes fall back
 *      to column = max-reachable-column + 1.
 *   2. Within a column, sort nodes by their original IR insertion
 *      order so generated bundles diff cleanly.
 *   3. Position: x = margin + col * columnGap, y = margin + row * rowGap.
 */
export function layoutGraph(ir: IrGraphV0, opts: LayoutOptions = {}): Layout {
  const columnGap = opts.columnGap ?? DEFAULT_COLUMN_GAP;
  const rowGap = opts.rowGap ?? DEFAULT_ROW_GAP;
  const margin = opts.margin ?? DEFAULT_MARGIN;

  const adj = new Map<string, string[]>();
  for (const n of ir.nodes) adj.set(n.name, []);
  for (const e of ir.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }

  const distance = new Map<string, number>();
  distance.set(ir.entry, 0);
  const queue: string[] = [ir.entry];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    const d = distance.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      if (distance.has(next)) continue;
      distance.set(next, d + 1);
      queue.push(next);
    }
  }

  // Unreachable nodes: place after the last reachable column
  let maxColumn = 0;
  for (const d of distance.values()) maxColumn = Math.max(maxColumn, d);
  for (const n of ir.nodes) {
    if (!distance.has(n.name)) {
      maxColumn += 1;
      distance.set(n.name, maxColumn);
    }
  }

  // Bucket by column, preserving IR order.
  const byColumn = new Map<number, string[]>();
  for (const n of ir.nodes) {
    const c = distance.get(n.name) ?? 0;
    const list = byColumn.get(c) ?? [];
    list.push(n.name);
    byColumn.set(c, list);
  }

  const nodes: NodePosition[] = [];
  const positionById = new Map<string, { x: number; y: number }>();
  for (const [col, ids] of [...byColumn.entries()].sort((a, b) => a[0] - b[0])) {
    for (let row = 0; row < ids.length; row++) {
      const id = ids[row];
      if (id === undefined) continue;
      const x = margin + col * columnGap;
      const y = margin + row * rowGap;
      nodes.push({ id, x, y });
      positionById.set(id, { x, y });
    }
  }

  const edges: EdgeView[] = ir.edges.map((e) => {
    const fromXY = positionById.get(e.from) ?? { x: 0, y: 0 };
    const toXY = positionById.get(e.to) ?? { x: 0, y: 0 };
    return { from: e.from, to: e.to, fromXY, toXY };
  });

  // Total dimensions
  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  return {
    width: maxX + margin * 2,
    height: maxY + margin * 2,
    nodes,
    edges,
  };
}

/**
 * Tiny SVG renderer for the layout — handy for the smoke (writes a
 * `.svg` artefact) and for studio-ui's first-paint while the dynamic
 * client-side renderer initialises.
 */
export function renderSvg(layout: Layout): string {
  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">`,
  );
  for (const e of layout.edges) {
    lines.push(
      `  <line x1="${e.fromXY.x + 30}" y1="${e.fromXY.y}" x2="${e.toXY.x - 30}" y2="${e.toXY.y}" stroke="#666" stroke-width="2" />`,
    );
  }
  for (const n of layout.nodes) {
    lines.push(`  <g transform="translate(${n.x},${n.y})">`);
    lines.push(`    <circle r="28" fill="#e0eaff" stroke="#5b80c8" stroke-width="2" />`);
    lines.push(
      `    <text x="0" y="4" text-anchor="middle" font-family="sans-serif" font-size="11">${escapeText(n.id)}</text>`,
    );
    lines.push("  </g>");
  }
  lines.push("</svg>");
  return lines.join("\n");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
