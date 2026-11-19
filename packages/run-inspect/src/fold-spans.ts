/**
 * The run's spans as a tree: runs, turns, model calls, tools, compactions, judges,
 * proof passes and helpers, each with its status, duration and cost.
 *
 * A span whose parent is not one of the run's spans sits under the run, marked
 * `orphan`, and a span lines name but nothing closes is marked `unfinished`: nothing
 * here throws on a tree the records leave incomplete. A compaction shows its duration
 * only when it is the reactive one, which does its work inside its span; the span of a
 * compaction before a turn opens after the work is done, so its duration is not one.
 */
import type { LoadedRun } from "./load";
import {
  type Provenance,
  type SpanNode,
  type SpanTree,
  notRecorded,
  reconstructed,
  recorded,
} from "./model";
import { type RunIndex, type SpanInfo, attributed, costFold, indexRun } from "./records";

/** A span's duration, when the span measures the work. */
export function spanDuration(index: RunIndex, span: SpanInfo | undefined): Provenance<number> {
  if (span === undefined) return notRecorded({ reason: "unfinished" });
  if (span.kind === "compaction" && index.compactionKind.get(span.id) !== "reactive") {
    return notRecorded({ reason: "not-recorded" }, [span.lineId]);
  }
  if (span.durationMs === undefined) return notRecorded({ reason: "not-recorded" }, [span.lineId]);
  return attributed(index.attribution, span.durationMs, [span.lineId]);
}

type MutableNode = Omit<SpanNode, "children"> & { children: MutableNode[] };

function nodeOf(index: RunIndex, id: string): MutableNode {
  const info = index.spans.get(id);
  const own = index.lines.filter((line) => line.span === id);
  const cost = own.length > 0 ? costFold(own, index.attribution)?.value : undefined;
  if (info === undefined) {
    return {
      id,
      kind: id === index.rootSpan ? "run" : "unknown",
      durationMs: spanDuration(index, undefined),
      ...(cost !== undefined ? { cost } : {}),
      unfinished: true,
      children: [],
    };
  }
  return {
    id,
    kind: info.kind,
    ...(info.status !== undefined ? { status: info.status } : {}),
    ...(info.startedAt !== undefined ? { startedAt: info.startedAt } : {}),
    durationMs: spanDuration(index, info),
    ...(cost !== undefined ? { cost } : {}),
    ...(info.toolUseId !== undefined ? { toolUseId: info.toolUseId } : {}),
    ...(info.call !== undefined ? { call: info.call } : {}),
    ...(info.turn !== undefined ? { turn: info.turn } : {}),
    ...(info.attempt !== undefined ? { attempt: info.attempt } : {}),
    children: [],
  };
}

/** Build the tree from an index. */
export function spanTreeOf(index: RunIndex): SpanTree {
  const withoutSpan = index.lines.filter((line) => line.span === undefined).length;
  const byPosition: Provenance<number> =
    withoutSpan > 0 ? reconstructed(withoutSpan, "span-by-position", []) : recorded(0, []);
  const ids = [...index.spans.keys(), ...index.unfinished.keys()];
  if (ids.length === 0 && index.rootSpan === undefined) {
    return { byPosition, gaps: index.gaps };
  }
  const rootId = index.rootSpan ?? "run";
  const nodes = new Map<string, MutableNode>();
  for (const id of ids) nodes.set(id, nodeOf(index, id));
  const root =
    nodes.get(rootId) ??
    ({
      id: rootId,
      kind: "run",
      durationMs: notRecorded({ reason: "not-recorded" }),
      children: [],
    } satisfies MutableNode);
  nodes.set(rootId, root);

  const attach = (child: MutableNode, parent: MutableNode, orphan: boolean): void => {
    parent.children.push(orphan ? { ...child, orphan: true } : child);
  };
  // An unfinished span has no recorded parent: it sits under the run, and so do its
  // children through it.
  const parentOf = (id: string): string | undefined =>
    index.spans.get(id)?.parent ?? (index.unfinished.has(id) ? rootId : undefined);
  const reachesRoot = (id: string): boolean => {
    const seen = new Set<string>();
    let at: string | undefined = id;
    while (at !== undefined && !seen.has(at)) {
      if (at === rootId) return true;
      seen.add(at);
      at = parentOf(at);
    }
    return false;
  };
  for (const id of ids) {
    if (id === rootId) continue;
    const node = nodes.get(id) as MutableNode;
    const parent = parentOf(id);
    if (parent !== undefined && parent !== id && nodes.has(parent) && reachesRoot(id)) {
      attach(node, nodes.get(parent) as MutableNode, false);
    } else {
      // No parent among the run's spans (or a loop): it sits under the run.
      attach(node, root, index.spans.has(id));
    }
  }
  return { root: root as SpanNode, byPosition, gaps: index.gaps };
}

/** The span tree of a loaded run. */
export function foldSpanTree(loaded: LoadedRun): SpanTree {
  return spanTreeOf(indexRun(loaded));
}
