/**
 * Work items as a reader sees them: the status in words (`effectiveWorkState`), the
 * ranker's place and dimensions, and, for a caller who may read content, the item's text.
 * Every function here reads and never writes: the run ledger through a fold that takes no
 * lock, the operator record, and the item revisions, contained.
 */
import type {
  WorkContentView,
  WorkHistoryView,
  WorkItemDetail,
  WorkItemView,
  WorkRankDimension,
} from "@crewhaus/control-contract";
import { foldStates, intakeVerdict, runsLedger } from "@crewhaus/control-records";
import type { FoldedWorkItem, WorkCorrection, WorkFold } from "./fold";
import { type RankedItem, rankWork } from "./ranker";
import type { WorkRevision } from "./records";
import { type WorkStateFacts, statusOf } from "./state";
import type { WorkStore } from "./store";

export type WorkViewContext = {
  /** Each run's newest state, by id. */
  readonly runStates: ReadonlyMap<string, string>;
  readonly harness: WorkStateFacts["harness"];
  readonly weights?: Readonly<Partial<Record<WorkRankDimension, number>>>;
  readonly corrections: readonly WorkCorrection[];
};

/** Every run's newest state on the harness's run ledger, read without a lock. */
export function readRunStates(harnessDir: string): ReadonlyMap<string, string> {
  const fold = foldStates(runsLedger(harnessDir));
  const out = new Map<string, string>();
  if (!fold.ok) return out;
  for (const [id, object] of fold.objects) {
    if (object.state !== undefined) out.set(id, object.state);
  }
  return out;
}

/** The harness's intake as the status table reads it. */
export function harnessFacts(harnessDir: string): NonNullable<WorkStateFacts["harness"]> {
  const intake = intakeVerdict(harnessDir);
  if (intake.state === "open") return {};
  return intake.code === "disabled" ? { disabled: true } : { paused: true };
}

/** What a reader needs to say an item's status, gathered once. */
export function viewContext(
  harnessDir: string,
  fold: WorkFold,
  weights?: WorkViewContext["weights"],
): WorkViewContext {
  return {
    runStates: readRunStates(harnessDir),
    harness: harnessFacts(harnessDir),
    ...(weights !== undefined ? { weights } : {}),
    corrections: fold.corrections,
  };
}

/** The status facts of one item. */
export function factsOf(item: FoldedWorkItem, ctx: WorkViewContext): WorkStateFacts {
  return {
    state: item.state,
    ...(item.outcome !== undefined ? { outcome: item.outcome } : {}),
    runs: item.runs.flatMap((run) => {
      const state = ctx.runStates.get(run);
      return state === undefined ? [] : [state];
    }),
    ...(ctx.harness !== undefined ? { harness: ctx.harness } : {}),
  };
}

/**
 * Rank the open items and the proposed items, each among their own. Items of other
 * states have no place.
 */
export function rankFolded(
  items: readonly FoldedWorkItem[],
  revisions: ReadonlyMap<string, WorkRevision | undefined>,
  ctx: WorkViewContext,
): ReadonlyMap<string, RankedItem> {
  const out = new Map<string, RankedItem>();
  for (const state of ["open", "proposed"] as const) {
    const group = items.filter((item) => item.state === state);
    const ranked = rankWork(
      group.map((item) => {
        const assessment = revisions.get(item.id)?.assessment;
        return {
          wi: item.id,
          ...(item.priority !== undefined ? { priority: item.priority } : {}),
          kind: item.kind,
          ...(item.basis !== undefined ? { basis: item.basis } : {}),
          createdAt: item.createdAt,
          ...(assessment !== undefined ? { assessment } : {}),
        };
      }),
      {
        ...(ctx.weights !== undefined ? { weights: ctx.weights } : {}),
        corrections: ctx.corrections,
      },
    );
    for (const row of ranked.items) out.set(row.wi, row);
  }
  return out;
}

/** One item as a list shows it. Its title is from its latest revision. */
export function itemView(
  item: FoldedWorkItem,
  revision: WorkRevision | undefined,
  ctx: WorkViewContext,
  ranked?: RankedItem,
): WorkItemView {
  return {
    id: item.id,
    state: item.state,
    ...statusOf(factsOf(item, ctx)),
    title: revision?.title ?? "(content unreadable)",
    kind: item.kind,
    ...(item.basis !== undefined ? { basis: item.basis } : {}),
    ...(item.priority !== undefined ? { priority: item.priority } : {}),
    rev: item.rev,
    ...(item.sourceKind !== undefined ? { sourceKind: item.sourceKind } : {}),
    ...(item.parent !== undefined ? { parent: item.parent } : {}),
    ...(item.outcome !== undefined ? { outcome: item.outcome } : {}),
    ...(item.reasonCode !== undefined ? { reasonCode: item.reasonCode } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(ranked !== undefined
      ? {
          position: ranked.position,
          ranking: ranked.ranking,
          dimensions: ranked.dimensions,
          ...(ranked.corrected !== undefined ? { corrected: ranked.corrected } : {}),
        }
      : {}),
    runs: [...item.runs],
  };
}

/** Every item's view, ranked, newest first unless ranked. */
export function itemViews(
  store: WorkStore,
  items: readonly FoldedWorkItem[],
  ctx: WorkViewContext,
): WorkItemView[] {
  const revisions = new Map(items.map((item) => [item.id, store.revision(item.id, item.rev)]));
  const ranked = rankFolded(items, revisions, ctx);
  return items.map((item) => itemView(item, revisions.get(item.id), ctx, ranked.get(item.id)));
}

/** One log line, as the item's history shows it. */
export function historyOf(item: FoldedWorkItem): WorkHistoryView[] {
  return item.history.map((line) => ({
    at: line.at,
    event: line.event,
    by: line.by,
    via: line.via,
    ...(line.rev !== undefined ? { rev: line.rev } : {}),
    ...(line.event === "linked" && line.run !== undefined ? { run: line.run } : {}),
    ...(line.outcome !== undefined ? { outcome: line.outcome } : {}),
    ...(line.reasonCode !== undefined ? { reasonCode: line.reasonCode } : {}),
    ...(line.event === "ranked" &&
    (line.scope === "item" || line.scope === "similar" || line.scope === "all")
      ? { scope: line.scope }
      : {}),
  }));
}

/** An item's content, for a caller who may read it. */
export function contentOf(revision: WorkRevision): WorkContentView {
  return {
    ...(revision.goal !== undefined ? { goal: revision.goal } : {}),
    ...(revision.acceptance !== undefined ? { acceptance: [...revision.acceptance] } : {}),
    ...(revision.assessment !== undefined ? { assessment: revision.assessment } : {}),
    ...(revision.notes !== undefined && revision.notes.length > 0
      ? {
          notes: revision.notes.map((n) => ({
            by: n.by,
            at: n.at,
            text: n.text,
            origin: n.origin,
          })),
        }
      : {}),
    ...(revision.source !== undefined
      ? {
          source: {
            kind: revision.source.kind,
            ...(revision.source.ref !== undefined ? { ref: revision.source.ref } : {}),
            ...(revision.source.url !== undefined ? { url: revision.source.url } : {}),
          },
        }
      : {}),
    ...(revision.delivered !== undefined && revision.delivered.length > 0
      ? { delivered: revision.delivered.map((d) => ({ kind: d.kind, ref: d.ref })) }
      : {}),
  };
}

/** One item in full: its view, its history and, when `content`, its text. */
export function itemDetail(
  store: WorkStore,
  item: FoldedWorkItem,
  fold: WorkFold,
  ctx: WorkViewContext,
  options: { readonly content: boolean },
): WorkItemDetail {
  const revision = store.revision(item.id, item.rev);
  const siblings = [...fold.items.values()].filter((other) => other.state === item.state);
  const revisions = new Map(
    siblings.map((other) => [other.id, store.revision(other.id, other.rev)]),
  );
  const ranked = rankFolded(siblings, revisions, ctx).get(item.id);
  return {
    item: itemView(item, revision, ctx, ranked),
    ...(options.content && revision !== undefined ? { content: contentOf(revision) } : {}),
    ...(options.content ? {} : { hidden: ["content" as const] }),
    history: historyOf(item),
    ...(revision === undefined
      ? { truncated: { reason: "The item's content could not be read." } }
      : {}),
  };
}
