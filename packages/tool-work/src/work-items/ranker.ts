/**
 * The one ranker: priority first (1 before 4), then, only when the owner declared ranking
 * weights, the weighted dimensions, then age (older first), then id. Pure and
 * deterministic.
 *
 * Each item's dimensions are shown with their levels and the owner's weights. The
 * weighted sum is a sort key and nothing else: it is never a field of the output, so no
 * reader can take one number for a likelihood.
 *
 * A person corrects the order by example: "this item above that one", recorded with how
 * far it reaches. `item` moves the one item above the other; `similar` moves the items of
 * the same kind and basis as it above those of the other's kind and basis; `all` moves the
 * items of its basis above those of the other's basis. A correction never crosses priority
 * bands, and accepts nothing. The newest correction wins: an older one that would make a
 * cycle with newer ones is dropped and counted.
 */
import {
  type CorrectionScope,
  WORK_RANK_DIMENSIONS,
  type WorkAssessment,
  type WorkBasis,
  type WorkCorrectionView,
  type WorkDimensionView,
  type WorkKind,
  type WorkRankDimension,
} from "@crewhaus/control-contract";
import { demandEvidence } from "./assessment";
import type { WorkCorrection } from "./fold";

/** An item as the ranker reads it. */
export type RankInput = {
  readonly wi: string;
  readonly priority?: number;
  readonly kind: WorkKind;
  readonly basis?: WorkBasis;
  readonly createdAt: string;
  readonly assessment?: WorkAssessment;
};

export type RankedItem = {
  readonly wi: string;
  readonly position: number;
  readonly dimensions: readonly WorkDimensionView[];
  readonly ranking: "priority" | "weights";
  readonly corrected?: WorkCorrectionView;
};

export type RankAnswer = {
  readonly items: readonly RankedItem[];
  /** Corrections dropped because a newer one made them a cycle. */
  readonly dropped: number;
};

/** An item with no priority ranks as this. */
export const DEFAULT_PRIORITY = 3;

/** Which way each dimension counts: a higher level is better (+1) or worse (-1). */
const DIRECTION: Readonly<Record<WorkRankDimension, 1 | -1>> = {
  evidence: 1,
  cost: -1,
  upkeep: -1,
  uncertainty: -1,
  reversibility: 1,
  fit: 1,
};

/** The fit of an item with the harness's purpose: 2 supports it, 1 says neither, 0 conflicts. */
function fitLevel(assessment: WorkAssessment | undefined): number {
  const fit = assessment?.intentFit;
  if (fit?.conflicts !== undefined) return fit.supports !== undefined ? 1 : 0;
  return fit?.supports !== undefined ? 2 : 1;
}

/** Each dimension's level for one item. */
export function dimensionLevels(input: RankInput): Readonly<Record<WorkRankDimension, number>> {
  const a = input.assessment;
  return {
    evidence: demandEvidence(a).length,
    cost: a?.cost ?? 0,
    upkeep: a?.upkeep ?? 0,
    uncertainty: a?.uncertainty ?? 0,
    reversibility: a?.reversibility ?? 0,
    fit: fitLevel(a),
  };
}

function scoreOf(
  levels: Readonly<Record<WorkRankDimension, number>>,
  weights: Readonly<Partial<Record<WorkRankDimension, number>>>,
): number {
  let total = 0;
  for (const name of WORK_RANK_DIMENSIONS) {
    total += (weights[name] ?? 0) * DIRECTION[name] * levels[name];
  }
  return total;
}

/** The items a correction's side moves, by its scope. */
function groupOf(
  anchor: RankInput,
  scope: CorrectionScope,
  band: readonly RankInput[],
): ReadonlySet<string> {
  if (scope === "item") return new Set([anchor.wi]);
  return new Set(
    band
      .filter((other) =>
        scope === "similar"
          ? other.kind === anchor.kind && other.basis === anchor.basis
          : other.basis === anchor.basis,
      )
      .map((other) => other.wi),
  );
}

/** Whether `to` is reachable from `from` over `edges`. */
function reaches(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  from: string,
  to: string,
): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (next === to) return true;
    for (const out of edges.get(next) ?? []) {
      if (!seen.has(out)) {
        seen.add(out);
        queue.push(out);
      }
    }
  }
  return false;
}

/** Rank items. `weights` absent: priority, then age, then id. Pure. */
export function rankWork(
  items: readonly RankInput[],
  options: {
    readonly weights?: Readonly<Partial<Record<WorkRankDimension, number>>>;
    readonly corrections?: readonly WorkCorrection[];
  } = {},
): RankAnswer {
  const weights = options.weights;
  const levels = new Map(items.map((item) => [item.wi, dimensionLevels(item)]));
  const score = new Map(
    items.map((item) => [
      item.wi,
      weights === undefined
        ? 0
        : scoreOf(levels.get(item.wi) as Record<WorkRankDimension, number>, weights),
    ]),
  );
  const base = [...items].sort((a, b) => {
    const pa = a.priority ?? DEFAULT_PRIORITY;
    const pb = b.priority ?? DEFAULT_PRIORITY;
    if (pa !== pb) return pa - pb;
    const sa = score.get(a.wi) as number;
    const sb = score.get(b.wi) as number;
    if (sa !== sb) return sb - sa;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.wi < b.wi ? -1 : a.wi > b.wi ? 1 : 0;
  });

  const bands = new Map<number, RankInput[]>();
  for (const item of base) {
    const p = item.priority ?? DEFAULT_PRIORITY;
    bands.set(p, [...(bands.get(p) ?? []), item]);
  }

  const newestFirst = [...(options.corrections ?? [])].sort((a, b) => b.seq - a.seq);
  const corrected = new Map<string, WorkCorrectionView>();
  let dropped = 0;
  const ordered: RankInput[] = [];
  for (const band of [...bands.keys()].sort((a, b) => a - b)) {
    const members = bands.get(band) as RankInput[];
    const byId = new Map(members.map((m) => [m.wi, m]));
    const edges = new Map<string, Set<string>>();
    for (const correction of newestFirst) {
      const ahead = byId.get(correction.wi);
      const behind = byId.get(correction.below);
      // A correction between two bands never moves either.
      if (ahead === undefined || behind === undefined) continue;
      const aheadGroup = groupOf(ahead, correction.scope, members);
      const behindGroup = groupOf(behind, correction.scope, members);
      const front = [...aheadGroup].filter((wi) => wi === ahead.wi || !behindGroup.has(wi));
      const back = [...behindGroup].filter((wi) => wi === behind.wi || !aheadGroup.has(wi));
      const pairs = front.flatMap((f) => back.filter((b) => b !== f).map((b) => [f, b] as const));
      // Newer corrections win: one that would close a cycle with them is dropped whole.
      if (pairs.some(([f, b]) => reaches(edges, b, f))) {
        dropped += 1;
        continue;
      }
      for (const [f, b] of pairs) {
        const out = edges.get(f) ?? new Set<string>();
        out.add(b);
        edges.set(f, out);
      }
      for (const wi of front) {
        if (!corrected.has(wi)) {
          corrected.set(wi, { scope: correction.scope, by: correction.by, at: correction.at });
        }
      }
    }
    // The base order, with each item's corrected predecessors pulled in just before it:
    // a moved item lands right above the item it was put above, not at the band's top.
    const before = new Map<string, string[]>();
    for (const [from, outs] of edges) {
      for (const to of outs) before.set(to, [...(before.get(to) ?? []), from]);
    }
    const rank = new Map(members.map((m, i) => [m.wi, i]));
    const emitted = new Set<string>();
    const emit = (wi: string): void => {
      if (emitted.has(wi)) return;
      emitted.add(wi);
      const firsts = [...(before.get(wi) ?? [])].sort(
        (a, b) => (rank.get(a) as number) - (rank.get(b) as number),
      );
      for (const first of firsts) emit(first);
      // A predecessor's own predecessors came first; then it, then this item.
      ordered.push(byId.get(wi) as RankInput);
    };
    for (const member of members) emit(member.wi);
  }

  return {
    items: ordered.map((item, i) => {
      const itemLevels = levels.get(item.wi) as Record<WorkRankDimension, number>;
      const fix = corrected.get(item.wi);
      return {
        wi: item.wi,
        position: i + 1,
        dimensions: WORK_RANK_DIMENSIONS.map((name) => ({
          name,
          level: itemLevels[name],
          ...(weights?.[name] !== undefined ? { weight: weights[name] as number } : {}),
        })),
        ranking: weights === undefined ? "priority" : "weights",
        ...(fix !== undefined ? { corrected: fix } : {}),
      };
    }),
    dropped,
  };
}
