/**
 * One fold, two ways to reach it. The read model folds the harness's decision and run
 * ledgers line by line and refreshes what no ledger holds (its approvals, its review
 * queue and its failure messages) only when their files changed. {@link harnessAttention}
 * turns a model into the harness's items; {@link foldHarness} folds the model from the
 * start on the spot, so a harness with no saved projection reads the same items Home's
 * projection gives. {@link assembleInbox} puts several harnesses into one list: groups
 * merged, filtered, decide before fix before consider, newest evidence first.
 *
 * Reads never mutate: nothing here writes, creates or compacts a file.
 */
import {
  ATTENTION_BANDS,
  type AttentionFreshness,
  type AttentionItem,
  type AttentionOverview,
} from "@crewhaus/control-contract";
import {
  type ResumeItem,
  type ResumeSources,
  decisionsLedger,
  resume,
  runsLedger,
} from "@crewhaus/control-records";
import { advisorItems } from "./adapters/advisor";
import { approvalBodies, approvalItems, readApprovalsSection } from "./adapters/approvals";
import { decisionItems, foldDecisionLine } from "./adapters/decisions";
import { readReviewSection, reviewBodies, reviewItems } from "./adapters/review";
import { foldRunLine, readFailuresSection, runGroups, signaturesOf } from "./adapters/runs";
import { credentialFactsOf } from "./causes";
import { groupAcross } from "./groups";
import { producedItems } from "./producers";
import { type AttentionReader, DEFAULT_READER, READ_CAPS } from "./read";
import type {
  AdvisorSnapshot,
  AttentionModel,
  Drafted,
  HarnessAttention,
  HarnessFacts,
  ItemContext,
  MetricDecision,
} from "./types";

/** A model with nothing folded or read. */
export function emptyModel(): AttentionModel {
  return {
    v: 1,
    decisions: {},
    runs: {},
    approvals: { stamp: "", facts: [] },
    review: { stamp: "", facts: [] },
    failures: { stamp: "", facts: [] },
  };
}

/** The ledgers the model follows. */
export function modelSources(harnessDir: string): ResumeSources {
  return { decisions: decisionsLedger(harnessDir), runs: runsLedger(harnessDir) };
}

/** Fold one ledger line into the model, in place. */
export function foldModelLine(state: AttentionModel, item: ResumeItem): AttentionModel {
  if (item.kind !== "line") return state;
  if (item.source === "decisions") return foldDecisionLine(state, item.record);
  if (item.source === "runs") return foldRunLine(state, item.record);
  return state;
}

/**
 * What no ledger holds, re-read only where its file changed. Answers `state` itself when
 * nothing did, so a projector writes nothing for a harness that did not move.
 */
export function refreshModel(
  state: AttentionModel,
  harnessDir: string,
  facts: HarnessFacts,
  reader: AttentionReader = DEFAULT_READER,
): AttentionModel {
  const approvals = readApprovalsSection(harnessDir, facts, reader, state.approvals);
  const review = readReviewSection(harnessDir, reader, state.review);
  const failures = readFailuresSection(harnessDir, state, facts, reader, state.failures);
  if (approvals === state.approvals && review === state.review && failures === state.failures) {
    return state;
  }
  return { ...state, approvals, review, failures };
}

export type HarnessReadOptions = {
  readonly facts: HarnessFacts;
  readonly reader?: AttentionReader;
  /** The Advisor's findings for this harness, when Home has gathered them. */
  readonly advisor?: AdvisorSnapshot;
};

/** One harness's items from its model. Reads only bodies, and only for a content reader. */
export function harnessAttention(
  model: AttentionModel,
  ctx: ItemContext,
  options: HarnessReadOptions,
): HarnessAttention {
  const reader = options.reader ?? DEFAULT_READER;
  const items: Drafted[] = [];
  const decisions: MetricDecision[] = [];

  const pendingIds = new Set<string>();
  if (ctx.content) {
    for (const fact of model.approvals.facts) {
      if (fact.decision === undefined && fact.supersededBy === undefined) pendingIds.add(fact.id);
    }
  }
  const bodies = ctx.content
    ? approvalBodies(ctx.dir, options.facts, reader, pendingIds)
    : undefined;
  const approvals = approvalItems(model.approvals, ctx, bodies);
  items.push(...approvals.items);
  decisions.push(...approvals.decisions);

  const dec = decisionItems(model, ctx);
  items.push(...dec.items);
  decisions.push(...dec.decisions);

  const hasOpenReview = model.review.facts.some((fact) => fact.status === "open");
  const reviews = ctx.content && hasOpenReview ? reviewBodies(ctx.dir, reader) : undefined;
  items.push(...reviewItems(model.review, ctx, reviews));

  if (options.advisor !== undefined) items.push(...advisorItems(options.advisor, ctx));

  items.push(...producedItems(options.facts, ctx));

  const failing = Object.values(model.runs).some((row) => row.state === "failed");
  const groups = failing
    ? runGroups(model, {
        harness: ctx.harness,
        credential: credentialFactsOf(ctx.dir, ctx.harness, options.facts),
        signatures: signaturesOf(model),
      })
    : [];
  const truncated =
    model.runsTruncated === true ||
    model.approvals.truncated === true ||
    model.review.truncated === true ||
    model.failures.truncated === true;
  return {
    harness: ctx.harness,
    items,
    groups,
    ...(model.approvals.unreachable === true ? { unreachable: true as const } : {}),
    ...(truncated ? { truncated: true as const } : {}),
    ...(options.advisor === undefined ? { advisorUnchecked: true as const } : {}),
    decisions,
    freshness: ctx.freshness,
  };
}

/** Whether a resume stopped at its caps on some source. */
function hitCaps(items: readonly ResumeItem[], maxLines: number): boolean {
  const per = new Map<string, number>();
  for (const item of items) per.set(item.source, (per.get(item.source) ?? 0) + 1);
  return [...per.values()].some((n) => n >= maxLines);
}

/** The model of one harness folded from the start, in memory, under the read caps. */
export function foldModel(
  harnessDir: string,
  facts: HarnessFacts,
  reader: AttentionReader = DEFAULT_READER,
): { readonly model: AttentionModel; readonly stale: boolean } {
  const answer = resume(modelSources(harnessDir), undefined, READ_CAPS);
  let model = emptyModel();
  for (const item of answer.items) model = foldModelLine(model, item);
  model = refreshModel(model, harnessDir, facts, reader);
  return { model, stale: hitCaps(answer.items, READ_CAPS.maxLines) };
}

export type FoldHarnessOptions = {
  readonly harness: string;
  readonly content?: boolean;
  readonly reader?: AttentionReader;
};

/**
 * One harness's items folded on the spot (`freshness.mode: "direct-fold"`): for a harness
 * with no saved projection, and for the CLI without Home. The Advisor's findings come from
 * `facts.advisorSnapshot` when it has one.
 */
export function foldHarness(
  harnessDir: string,
  facts: HarnessFacts,
  now: number,
  options: FoldHarnessOptions,
): HarnessAttention {
  const reader = options.reader ?? DEFAULT_READER;
  const { model, stale } = foldModel(harnessDir, facts, reader);
  const freshness: AttentionFreshness = {
    asOf: new Date(now).toISOString(),
    mode: "direct-fold",
    ...(stale ? { stale: true } : {}),
  };
  const advisor = facts.advisorSnapshot?.(harnessDir);
  return harnessAttention(
    model,
    {
      harness: options.harness,
      dir: harnessDir,
      now,
      content: options.content ?? false,
      freshness,
    },
    { facts, reader, ...(advisor !== undefined ? { advisor } : {}) },
  );
}

export type InboxFilter = {
  /** `open` (the default) keeps what still needs a person; `all` keeps everything. */
  readonly state?: "open" | "all";
  readonly kind?: string;
  readonly band?: string;
};

export type Inbox = {
  readonly items: readonly AttentionItem[];
  /** Harnesses whose session root lies outside them. */
  readonly unreachable: readonly string[];
  /** Harnesses some source of which stopped at its caps. */
  readonly truncated: readonly string[];
  /** Harnesses with no Advisor findings gathered yet. */
  readonly advisorUnchecked: readonly string[];
  /** Every item before the filter, open ones and settled. */
  readonly all: readonly AttentionItem[];
  readonly decisions: readonly MetricDecision[];
};

const OPEN_STATES = new Set(["open", "assigned", "deferred"]);

/**
 * Several harnesses as one list. Callers pass only the harnesses the caller may read, so
 * a group never names or counts one it may not. Pure.
 */
export function assembleInbox(
  perHarness: readonly HarnessAttention[],
  now: number,
  filter: InboxFilter = {},
): Inbox {
  const drafted: Drafted[] = perHarness.flatMap((h) => h.items);
  drafted.push(...groupAcross(perHarness, now));
  const band = new Map<string, number>(ATTENTION_BANDS.map((b, i) => [b, i]));
  drafted.sort(
    (a, b) =>
      (band.get(a.item.band) ?? 9) - (band.get(b.item.band) ?? 9) ||
      b.latestAt - a.latestAt ||
      (a.item.ref < b.item.ref ? -1 : a.item.ref > b.item.ref ? 1 : 0),
  );
  const all = drafted.map((d) => d.item);
  const items = all.filter(
    (item) =>
      (filter.state === "all" || OPEN_STATES.has(item.state)) &&
      (filter.kind === undefined || item.kind === filter.kind) &&
      (filter.band === undefined || item.band === filter.band),
  );
  return {
    items,
    all,
    unreachable: perHarness.filter((h) => h.unreachable === true).map((h) => h.harness),
    truncated: perHarness.filter((h) => h.truncated === true).map((h) => h.harness),
    advisorUnchecked: perHarness.filter((h) => h.advisorUnchecked === true).map((h) => h.harness),
    decisions: perHarness.flatMap((h) => h.decisions),
  };
}

/** A placeholder harness id for counts that name no harness. */
const COUNTING_HARNESS = "hrn_0000000000000000";

/** How many open items a harness's model holds, by band: its overview row's counts. */
export function overviewOf(
  model: AttentionModel,
  harnessDir: string,
  now: number,
  options: HarnessReadOptions,
): AttentionOverview {
  const freshness: AttentionFreshness = { asOf: new Date(now).toISOString(), mode: "projection" };
  const one = harnessAttention(
    model,
    { harness: COUNTING_HARNESS, dir: harnessDir, now, content: false, freshness },
    options,
  );
  const inbox = assembleInbox([one], now);
  const count = (b: string) => inbox.items.filter((item) => item.band === b).length;
  return {
    decide: count("decide"),
    fix: count("fix"),
    consider: count("consider"),
    ...(one.unreachable === true ? { unreachable: true as const } : {}),
  };
}
