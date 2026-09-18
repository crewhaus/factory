/**
 * Box-and-arrow diagrams from a node and edge list, laid out in layers.
 *
 * ## The layout, and why it is this one
 *
 * Each node is assigned to a layer one past its deepest predecessor, and
 * layers are drawn in order — downward for `TB`, rightward for `LR`. Within
 * a layer, nodes keep the order they were declared in. That is the whole
 * algorithm: no force simulation, no crossing minimisation, no iteration.
 * It is reproducible to the byte, it fits in a sentence, and it is right
 * for the pipelines, state machines and architecture sketches this is for.
 *
 * It is NOT general graph layout, and does not pretend to be. A dense graph
 * will have crossing edges and this will not untangle them. A cycle is
 * broken by ignoring the edge that closes it when layers are assigned; that
 * edge is still drawn — dashed, curving back — and is reported in
 * `backEdges`, so a caller can see what happened rather than wonder why the
 * picture looks the way it does.
 */
import { MediaFormatError } from "./bytes";
import { escapeXml, estimateTextWidth, num, rect, svgDocument, text } from "./svg";

export type DiagramNode = { readonly id: string; readonly label?: string };
export type DiagramEdge = { readonly from: string; readonly to: string; readonly label?: string };

export type DiagramSpec = {
  readonly nodes: ReadonlyArray<DiagramNode>;
  readonly edges: ReadonlyArray<DiagramEdge>;
  /** `"TB"` stacks layers downward; `"LR"` runs them left to right. */
  readonly direction?: "TB" | "LR";
  readonly title?: string;
  readonly background?: string;
  readonly nodeFill?: string;
  readonly nodeStroke?: string;
};

export type DiagramResult = {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  /** Layer index per node id, in declaration order. */
  readonly layers: ReadonlyArray<{ id: string; layer: number }>;
  /** Edges that close a cycle: drawn dashed, and not used for layering. */
  readonly backEdges: ReadonlyArray<{ from: string; to: string }>;
};

const FONT = 13;
const PADDING_X = 14;
const BOX_HEIGHT = 40;
const LAYER_GAP = 60;
const SIBLING_GAP = 24;
const MARGIN = 24;
const TITLE_SIZE = 16;
const INK = "#1f2329";
const EDGE = "#5a6069";

const key = (from: string, to: string): string => `${from} -> ${to}`;

/**
 * Layer assignment. A depth-first pass in declaration order finds the edges
 * that close a cycle; the rest form a DAG, and each node's layer is one
 * past its deepest remaining predecessor.
 */
export function assignLayers(
  nodes: ReadonlyArray<DiagramNode>,
  edges: ReadonlyArray<DiagramEdge>,
): { layers: Map<string, number>; backEdges: Array<{ from: string; to: string }> } {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const outgoing = new Map<string, string[]>();
  for (const id of ids) outgoing.set(id, []);
  for (const edge of edges) {
    if (known.has(edge.from) && known.has(edge.to)) {
      (outgoing.get(edge.from) as string[]).push(edge.to);
    }
  }

  const backEdges: Array<{ from: string; to: string }> = [];
  const backSet = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  for (const id of ids) state.set(id, 0);
  // Iterative depth-first search: a deep chain must not overflow the stack.
  for (const root of ids) {
    if (state.get(root) !== 0) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const children = outgoing.get(frame.id) as string[];
      if (frame.next >= children.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const child = children[frame.next] as string;
      frame.next++;
      const seen = state.get(child);
      if (seen === 1) {
        const k = key(frame.id, child);
        if (!backSet.has(k)) {
          backSet.add(k);
          backEdges.push({ from: frame.id, to: child });
        }
      } else if (seen === 0) {
        state.set(child, 1);
        stack.push({ id: child, next: 0 });
      }
    }
  }

  const incoming = new Map<string, string[]>();
  for (const id of ids) incoming.set(id, []);
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    if (backSet.has(key(edge.from, edge.to))) continue;
    (incoming.get(edge.to) as string[]).push(edge.from);
  }

  // Longest path to each node, memoised. The graph is acyclic now, so the
  // recursion terminates; `resolving` is a belt-and-braces guard.
  const layers = new Map<string, number>();
  const resolving = new Set<string>();
  const depth = (id: string): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (resolving.has(id)) return 0;
    resolving.add(id);
    let best = 0;
    for (const parent of incoming.get(id) as string[]) best = Math.max(best, depth(parent) + 1);
    resolving.delete(id);
    layers.set(id, best);
    return best;
  };
  for (const id of ids) depth(id);
  return { layers, backEdges };
}

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** Render a node and edge list to SVG with a layered layout. */
export function renderDiagram(spec: DiagramSpec): DiagramResult {
  if (spec.nodes.length === 0) throw new MediaFormatError("a diagram needs at least one node");
  if (spec.nodes.length > 200) {
    throw new MediaFormatError(
      `${spec.nodes.length} nodes is past what a layered layout renders readably; the cap is 200`,
    );
  }
  const seen = new Set<string>();
  for (const node of spec.nodes) {
    if (node.id === "") throw new MediaFormatError("a node id cannot be empty");
    if (seen.has(node.id)) throw new MediaFormatError(`node id "${node.id}" appears twice`);
    seen.add(node.id);
  }
  for (const edge of spec.edges) {
    if (!seen.has(edge.from)) throw new MediaFormatError(`edge from unknown node "${edge.from}"`);
    if (!seen.has(edge.to)) throw new MediaFormatError(`edge to unknown node "${edge.to}"`);
  }

  const direction = spec.direction ?? "TB";
  const { layers, backEdges } = assignLayers(spec.nodes, spec.edges);
  const labelOf = (node: DiagramNode): string => node.label ?? node.id;
  // One box width for every node, so layers line up and edges stay short.
  const boxWidth = Math.ceil(
    Math.max(64, ...spec.nodes.map((n) => estimateTextWidth(labelOf(n), FONT) + PADDING_X * 2)),
  );

  const maxLayer = Math.max(...[...layers.values()]);
  const byLayer: DiagramNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const node of spec.nodes) {
    (byLayer[layers.get(node.id) as number] as DiagramNode[]).push(node);
  }
  const widest = Math.max(...byLayer.map((row) => row.length));
  const titleOffset = spec.title === undefined ? 0 : TITLE_SIZE + 14;
  // A back edge loops outside the boxes; reserve the room up front.
  const loopRoom = backEdges.length > 0 ? 34 : 0;

  const boxes = new Map<string, Box>();
  let width: number;
  let height: number;

  if (direction === "TB") {
    const rowSpan = widest * boxWidth + (widest - 1) * SIBLING_GAP;
    width = rowSpan + MARGIN * 2 + loopRoom;
    height = titleOffset + (maxLayer + 1) * BOX_HEIGHT + maxLayer * LAYER_GAP + MARGIN * 2;
    const centre = MARGIN + rowSpan / 2;
    for (let layer = 0; layer <= maxLayer; layer++) {
      const row = byLayer[layer] as DiagramNode[];
      const span = row.length * boxWidth + (row.length - 1) * SIBLING_GAP;
      let x = centre - span / 2;
      const y = MARGIN + titleOffset + layer * (BOX_HEIGHT + LAYER_GAP);
      for (const node of row) {
        boxes.set(node.id, { x, y, w: boxWidth, h: BOX_HEIGHT });
        x += boxWidth + SIBLING_GAP;
      }
    }
  } else {
    width = (maxLayer + 1) * boxWidth + maxLayer * LAYER_GAP + MARGIN * 2;
    const columnSpan = widest * BOX_HEIGHT + (widest - 1) * SIBLING_GAP;
    height = columnSpan + MARGIN * 2 + titleOffset + loopRoom;
    const centre = MARGIN + titleOffset + loopRoom + columnSpan / 2;
    for (let layer = 0; layer <= maxLayer; layer++) {
      const column = byLayer[layer] as DiagramNode[];
      const span = column.length * BOX_HEIGHT + (column.length - 1) * SIBLING_GAP;
      let y = centre - span / 2;
      const x = MARGIN + layer * (boxWidth + LAYER_GAP);
      for (const node of column) {
        boxes.set(node.id, { x, y, w: boxWidth, h: BOX_HEIGHT });
        y += BOX_HEIGHT + SIBLING_GAP;
      }
    }
  }

  const background = spec.background ?? "#ffffff";
  const fill = spec.nodeFill ?? "#eef2fb";
  const stroke = spec.nodeStroke ?? "#3b6fd4";
  const body: string[] = [
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(EDGE)}"/></marker></defs>`,
  ];
  if (spec.title !== undefined) {
    body.push(
      text(width / 2, MARGIN + TITLE_SIZE - 4, spec.title, TITLE_SIZE, {
        fill: INK,
        anchor: "middle",
        weight: "bold",
      }),
    );
  }

  const backSet = new Set(backEdges.map((e) => key(e.from, e.to)));
  // Edges first, so a box always sits on top of the line that reaches it.
  for (const edge of spec.edges) {
    const from = boxes.get(edge.from) as Box;
    const to = boxes.get(edge.to) as Box;
    const isBack = backSet.has(key(edge.from, edge.to));
    const forward = (layers.get(edge.to) as number) > (layers.get(edge.from) as number);

    let path: string;
    let midX: number;
    let midY: number;
    if (forward) {
      const [x1, y1] =
        direction === "TB"
          ? [from.x + from.w / 2, from.y + from.h]
          : [from.x + from.w, from.y + from.h / 2];
      const [x2, y2] = direction === "TB" ? [to.x + to.w / 2, to.y] : [to.x, to.y + to.h / 2];
      path = `M ${num(x1)} ${num(y1)} L ${num(x2)} ${num(y2)}`;
      midX = (x1 + x2) / 2;
      midY = (y1 + y2) / 2;
    } else {
      // Back or sideways: leave and enter on the outside edge, bowing away
      // from the boxes so the line is followable.
      const [x1, y1] =
        direction === "TB"
          ? [from.x + from.w, from.y + from.h / 2]
          : [from.x + from.w / 2, from.y + from.h];
      const [x2, y2] =
        direction === "TB" ? [to.x + to.w, to.y + to.h / 2] : [to.x + to.w / 2, to.y + to.h];
      const bow = 28;
      const [cx, cy] =
        direction === "TB"
          ? [Math.max(x1, x2) + bow, (y1 + y2) / 2]
          : [(x1 + x2) / 2, Math.max(y1, y2) + bow];
      path = `M ${num(x1)} ${num(y1)} Q ${num(cx)} ${num(cy)} ${num(x2)} ${num(y2)}`;
      // The midpoint of a quadratic at t = 0.5.
      midX = 0.25 * x1 + 0.5 * cx + 0.25 * x2;
      midY = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
    }
    body.push(
      `<path d="${path}" fill="none" stroke="${escapeXml(EDGE)}" stroke-width="1.5"${isBack ? ' stroke-dasharray="5 3"' : ""} marker-end="url(#arrow)"/>`,
    );
    if (edge.label !== undefined && edge.label !== "") {
      const w = estimateTextWidth(edge.label, 11) + 8;
      body.push(rect(midX - w / 2, midY - 8, w, 16, background, 'rx="3"'));
      body.push(
        text(midX, midY, edge.label, 11, { fill: EDGE, anchor: "middle", baseline: "middle" }),
      );
    }
  }

  for (const node of spec.nodes) {
    const box = boxes.get(node.id) as Box;
    body.push(
      `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="6" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="1.5"/>`,
    );
    body.push(
      text(box.x + box.w / 2, box.y + box.h / 2, labelOf(node), FONT, {
        fill: INK,
        anchor: "middle",
        baseline: "middle",
      }),
    );
  }

  return {
    svg: svgDocument(width, height, background, body, spec.title),
    width,
    height,
    layers: spec.nodes.map((n) => ({ id: n.id, layer: layers.get(n.id) as number })),
    backEdges,
  };
}
