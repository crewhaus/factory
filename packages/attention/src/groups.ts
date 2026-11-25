/**
 * Failure groups as items. A group whose cause may span harnesses (a credential, a
 * provider limit, a deployment) is home-scoped: the groups of every harness the caller
 * may read that share its cause are one item, listing those harnesses, the newest 50
 * runs and how many there are. Every other group is its harness's own. Callers pass only
 * the harnesses the caller may read, so a group never names or counts another.
 */
import {
  type AttentionChoice,
  type AttentionFreshness,
  type AttentionKind,
  CROSS_HARNESS_CAUSES,
} from "@crewhaus/control-contract";
import { newestEpisode } from "./adapters/runs";
import { attRefOf } from "./ids";
import { decideChoice, draftItem, msOf, showTwin } from "./items";
import { effectiveAttentionState } from "./lifecycle";
import type { Drafted, GroupDraft, GroupRun } from "./types";

/** One harness's groups, with how its records were read. */
export type HarnessGroups = {
  readonly harness: string;
  readonly groups: readonly GroupDraft[];
  readonly freshness: AttentionFreshness;
};

function crossHarness(draft: GroupDraft): boolean {
  return (CROSS_HARNESS_CAUSES as readonly string[]).includes(draft.cause.kind);
}

/** The freshness of an item read from several harnesses: the oldest and least fresh. */
function combined(list: readonly AttentionFreshness[]): AttentionFreshness {
  const first = list[0] as AttentionFreshness;
  let asOf = first.asOf;
  let mode = first.mode;
  let stale = first.stale === true;
  for (const f of list.slice(1)) {
    if (f.asOf < asOf) asOf = f.asOf;
    if (f.mode === "direct-fold") mode = "direct-fold";
    if (f.stale === true) stale = true;
  }
  return { asOf, mode, ...(stale ? { stale: true } : {}) };
}

/** Said where an amount is the person's to choose, so no command is made for it. */
const EXTEND_REASON = "The amount and reason are yours to choose: `crewhaus budget extend`.";

/** What may be done about failing runs: look, say it is known, or, for a budget, raise it or wait. */
function choicesOf(kind: AttentionKind, ref: string): AttentionChoice[] {
  const att = ref.slice(ref.lastIndexOf("/") + 1);
  const inspect: AttentionChoice = { id: "inspect", needs: "operator", cliTwin: showTwin(ref) };
  const acknowledge = decideChoice(att, "acknowledge", "operator");
  if (kind !== "budget") return [inspect, acknowledge];
  return [
    {
      id: "raise-spec",
      needs: "maintainer",
      cliTwin: null,
      nullReason: "The limit is in the spec: change it in Home's budget setup.",
      permission: "h.spec.edit",
    },
    {
      id: "raise-period",
      needs: "maintainer",
      cliTwin: null,
      nullReason: EXTEND_REASON,
      permission: "h.budget.extend",
    },
    decideChoice(att, "wait-for-renewal", "operator"),
    acknowledge,
  ];
}

function itemOfGroup(
  scope: string,
  draft: GroupDraft,
  runs: readonly GroupRun[],
  clearedAt: string | undefined,
  freshness: AttentionFreshness,
  now: number,
): Drafted {
  const sorted = [...runs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const harnesses = [...new Set(sorted.map((run) => run.harness))].sort();
  const latestAt = msOf(sorted[0]?.at) ?? 0;
  const since = sorted[sorted.length - 1]?.at ?? new Date(now).toISOString();
  const kind = draft.kind as AttentionKind;
  const ref = attRefOf(scope, kind, draft.cause.id);
  const cleared = msOf(clearedAt);
  const effective = effectiveAttentionState(
    {
      source: "problem",
      latestAt,
      ...(cleared !== undefined ? { clearedAt: cleared } : {}),
      ...(draft.superseded === true ? { superseded: true } : {}),
    },
    now,
  );
  const single = harnesses.length === 1 ? harnesses[0] : undefined;
  return draftItem({
    scope,
    kind,
    key: draft.cause.id,
    ...(single !== undefined ? { harness: single } : {}),
    ...(scope === "home" ? { harnesses } : {}),
    source: { kind: "runs", id: draft.cause.id },
    title: {
      template: draft.titleTemplate,
      params: { ...draft.params, runs: sorted.length, harnesses: harnesses.length },
    },
    whyNow: { template: "why.runs-failed", params: { runs: sorted.length } },
    runs: sorted.map((run) => run.id),
    count: sorted.length,
    evidence: sorted.map((run) => ({
      kind: "run",
      ref: `${run.harness}/run/${run.id}`,
      label: run.id,
    })),
    revision: sorted.map((run) => ({ id: `${run.harness}/${run.id}`, state: "failed" })),
    choices: effective.state === "open" ? choicesOf(kind, ref) : [],
    requiredClass: "operator",
    state: effective.state,
    ...(effective.resolution !== undefined ? { resolution: effective.resolution } : {}),
    cause: draft.cause,
    ...(draft.previousKey !== undefined
      ? { previous: attRefOf(scope, kind, draft.previousKey) }
      : {}),
    since,
    latestAt,
    freshness: draft.note !== undefined ? { ...freshness, note: draft.note } : freshness,
  });
}

/**
 * Every group of these harnesses as items: a home-scoped cause merged across the harnesses
 * given, every other group its harness's own. Pure.
 */
export function groupAcross(perHarness: readonly HarnessGroups[], now: number): Drafted[] {
  const out: Drafted[] = [];
  const merged = new Map<
    string,
    {
      draft: GroupDraft;
      open: GroupRun[];
      cleared: GroupRun[];
      clearedAt: string | undefined;
      freshness: AttentionFreshness[];
    }
  >();
  for (const { harness, groups, freshness } of perHarness) {
    for (const draft of groups) {
      if (!crossHarness(draft)) {
        out.push(itemOfGroup(harness, draft, draft.runs, draft.clearedAt, freshness, now));
        continue;
      }
      const entry = merged.get(draft.cause.id) ?? {
        draft,
        open: [],
        cleared: [],
        clearedAt: undefined,
        freshness: [],
      };
      if (draft.clearedAt !== undefined) {
        entry.cleared.push(...draft.runs);
        if (entry.clearedAt === undefined || draft.clearedAt > entry.clearedAt) {
          entry.clearedAt = draft.clearedAt;
        }
      } else {
        entry.open.push(...draft.runs);
      }
      entry.freshness.push(freshness);
      merged.set(draft.cause.id, entry);
    }
  }
  for (const { draft, open, cleared, clearedAt, freshness } of merged.values()) {
    const live = draft.cause.kind === "provider-limit" ? newestEpisode(open) : open;
    const runs = live.length > 0 ? live : cleared;
    out.push(
      itemOfGroup(
        "home",
        draft,
        runs,
        live.length > 0 ? undefined : clearedAt,
        combined(freshness),
        now,
      ),
    );
  }
  return out;
}
