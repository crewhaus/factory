/**
 * Tool approvals and questions: the requests a run parked for a person, read the way
 * Home's approvals view reads them. The file sits in the harness's session root, which
 * must lie inside the harness once every link is followed: a root outside it is
 * unreachable, reported, and nothing under it is read. The file is read from its newest
 * end under caps (truncation reported) and folded with its decision claims; nothing is
 * listed through the store, which compacts.
 *
 * Re-asks fold: pending requests that carry one `askDigest`, in any session, are one item
 * listing every waiting run. A request without one is its own item. A tool input is a
 * body, read at serve time for a caller who may read the content; the saved model keeps
 * none.
 */
import { join } from "node:path";
import type {
  AttentionChoice,
  AttentionKind,
  DecisionClass,
  DecisionRecordView,
} from "@crewhaus/control-contract";
import {
  DEFAULT_APPROVALS_FILENAME,
  DEFAULT_TTL_DAYS,
  type PendingApproval,
  containedSessionRoot,
  foldWithClaims,
} from "@crewhaus/session-store";
import { attRefOf, digestPrefix } from "../ids";
import { classOf, draftItem, higherClass, isoOf, msOf, shellWord } from "../items";
import { effectiveAttentionState } from "../lifecycle";
import { type AttentionReader, READ_CAPS } from "../read";
import type {
  ApprovalFact,
  AttentionModel,
  Drafted,
  HarnessFacts,
  ItemContext,
  MetricDecision,
} from "../types";

/** A request parked longer than this is past the store's time to live. */
export const APPROVAL_TTL_MS = DEFAULT_TTL_DAYS * 86_400_000;

/** A refusal this recent makes the same ask's item recommend refusing again. */
export const REFUSED_WINDOW_MS = 30 * 86_400_000;

/** A settled request stays listable (with `state=all`) this long. */
export const SETTLED_KEPT_MS = 30 * 86_400_000;

type ApprovalsSection = AttentionModel["approvals"];

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The parts of a request the inbox keeps: ids, names, classes and times. */
export function approvalFactOf(record: PendingApproval): ApprovalFact {
  const r = record as unknown as Readonly<Record<string, unknown>>;
  const pick = (name: string) => (str(r[name]) === undefined ? {} : { [name]: r[name] });
  return {
    id: record.id,
    kind: r["kind"] === "input" ? "input" : "tool",
    toolName: record.toolName,
    createdAt: record.createdAt,
    runId: record.runId,
    sessionId: record.sessionId,
    ...pick("askDigest"),
    ...(record.requiredClass !== undefined ? { requiredClass: classOf(record.requiredClass) } : {}),
    ...pick("expiresAt"),
    ...pick("deferredUntil"),
    ...pick("ifUnanswered"),
    ...pick("bindingDigest"),
    ...(record.decision === "grant" || record.decision === "deny"
      ? { decision: record.decision }
      : {}),
    ...pick("decidedAt"),
    ...pick("decidedVia"),
    ...pick("resolvedBy"),
    ...pick("consumedAt"),
    ...pick("supersededBy"),
    ...pick("expiredAt"),
    ...pick("sensitivity"),
  } as ApprovalFact;
}

/**
 * The approvals section, re-read only when the session root or its file changed. Answers
 * `prev` itself when nothing did.
 */
export function readApprovalsSection(
  dir: string,
  facts: HarnessFacts,
  reader: AttentionReader,
  prev: ApprovalsSection | undefined,
): ApprovalsSection {
  const root = containedSessionRoot(dir, facts.envVars(dir));
  if (root === undefined) {
    if (prev?.unreachable === true) return prev;
    return { stamp: "unreachable", facts: [], unreachable: true };
  }
  const relocated = root !== join(dir, ".crewhaus", "sessions");
  const stamp = `${digestPrefix(root, 16)}|${reader.stamp(root, DEFAULT_APPROVALS_FILENAME)}`;
  if (prev !== undefined && prev.stamp === stamp) return prev;
  const read = reader.tail(root, DEFAULT_APPROVALS_FILENAME, READ_CAPS);
  const base = { stamp, ...(relocated ? { relocated: true as const } : {}) };
  if (read.state !== "read") return { ...base, facts: [] };
  const records = foldWithClaims(root, read.records).records;
  return {
    ...base,
    facts: records.map(approvalFactOf),
    ...(read.truncated ? { truncated: true as const } : {}),
  };
}

/** The tool inputs of these requests, read now, for a caller who may read the content. */
export function approvalBodies(
  dir: string,
  facts: HarnessFacts,
  reader: AttentionReader,
  ids: ReadonlySet<string>,
): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  if (ids.size === 0) return out;
  const root = containedSessionRoot(dir, facts.envVars(dir));
  if (root === undefined) return out;
  const read = reader.tail(root, DEFAULT_APPROVALS_FILENAME, READ_CAPS);
  if (read.state !== "read") return out;
  for (const record of foldWithClaims(root, read.records).records) {
    if (ids.has(record.id)) out.set(record.id, record.input ?? null);
  }
  return out;
}

function viewOf(fact: ApprovalFact): DecisionRecordView {
  return fact as unknown as DecisionRecordView;
}

/** The kind of item a request is. */
export function approvalKindOf(fact: Pick<ApprovalFact, "kind">): AttentionKind {
  return fact.kind === "input" ? "question" : "permission";
}

/** The key of the item a request belongs to: its ask, or its own id. */
export function approvalKeyOf(fact: Pick<ApprovalFact, "id" | "askDigest">): string {
  return fact.askDigest !== undefined ? `ask:${fact.askDigest}` : `appr:${fact.id}`;
}

/** The ref of the item a request belongs to, open or settled. */
export function approvalItemRef(
  harness: string,
  fact: Pick<ApprovalFact, "id" | "askDigest" | "kind">,
): string {
  return attRefOf(harness, approvalKindOf(fact), approvalKeyOf(fact));
}

function ttlAtOf(fact: ApprovalFact): number | undefined {
  const created = msOf(fact.createdAt);
  return created === undefined ? undefined : created + APPROVAL_TTL_MS;
}

function stateOf(fact: ApprovalFact, now: number) {
  const ttlAt = ttlAtOf(fact);
  return effectiveAttentionState(
    { source: "decision", record: viewOf(fact), ...(ttlAt !== undefined ? { ttlAt } : {}) },
    now,
  );
}

function choicesOf(
  records: readonly ApprovalFact[],
  dir: string,
  relocated: boolean,
  needs: DecisionClass,
): AttentionChoice[] {
  const one = records.length === 1 ? records[0] : undefined;
  return (["grant", "deny"] as const).map((choice) => {
    if (one === undefined) {
      return {
        id: choice,
        needs,
        cliTwin: null,
        nullReason: "Decide each request: `crewhaus approvals list`.",
      };
    }
    if (relocated) {
      return {
        id: choice,
        needs,
        cliTwin: null,
        nullReason: "This harness keeps its sessions folder elsewhere; decide it in Home.",
      };
    }
    return {
      id: choice,
      needs,
      cliTwin: `crewhaus approvals ${choice} ${one.id} --dir ${shellWord(dir)}`,
    };
  });
}

/**
 * The items of one harness's requests: one per ask (open while any request of it waits),
 * and, settled, one per ask decided in the last 30 days. Pure over the section, except
 * the bodies a content reader is handed.
 */
export function approvalItems(
  section: ApprovalsSection,
  ctx: ItemContext,
  bodies: ReadonlyMap<string, unknown> | undefined,
): { readonly items: Drafted[]; readonly decisions: MetricDecision[] } {
  const { now, harness } = ctx;
  const items: Drafted[] = [];
  const decisions: MetricDecision[] = [];
  const groups = new Map<string, ApprovalFact[]>();
  const refusedAt = new Map<string, number>();
  for (const fact of section.facts) {
    decisions.push({
      kind: approvalKindOf(fact),
      createdAt: fact.createdAt,
      ...(fact.decidedAt !== undefined ? { decidedAt: fact.decidedAt } : {}),
      ...(fact.decidedVia !== undefined ? { decidedVia: fact.decidedVia } : {}),
      ...(fact.resolvedBy !== undefined ? { resolvedBy: fact.resolvedBy } : {}),
      ...(fact.askDigest !== undefined ? { askDigest: fact.askDigest } : {}),
    });
    if (fact.askDigest !== undefined && fact.decision === "deny") {
      const at = msOf(fact.decidedAt) ?? msOf(fact.createdAt);
      if (at !== undefined && now - at <= REFUSED_WINDOW_MS) {
        refusedAt.set(fact.askDigest, Math.max(refusedAt.get(fact.askDigest) ?? 0, at));
      }
    }
    const created = msOf(fact.createdAt);
    if (created === undefined || now - created > SETTLED_KEPT_MS + APPROVAL_TTL_MS) continue;
    const key = `${approvalKindOf(fact)}|${approvalKeyOf(fact)}`;
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }
  for (const all of groups.values()) {
    const sorted = [...all].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const states = sorted.map((fact) => ({ fact, effective: stateOf(fact, now) }));
    const waiting = states.filter((s) => s.effective.state === "open").map((s) => s.fact);
    const newest = sorted[sorted.length - 1] as ApprovalFact;
    const open = waiting.length > 0;
    const shown = open ? waiting : [newest];
    const settled = open ? undefined : (states[states.length - 1]?.effective ?? undefined);
    if (!open) {
      const at = msOf(settled?.resolution?.at ?? newest.decidedAt ?? newest.createdAt);
      if (at !== undefined && now - at > SETTLED_KEPT_MS) continue;
    }
    const first = shown[0] as ApprovalFact;
    const kind = approvalKindOf(first);
    const needs = shown.reduce<DecisionClass>(
      (cls, fact) => higherClass(cls, classOf(fact.requiredClass)),
      "operator",
    );
    const runs = [...new Set([...shown].reverse().map((fact) => fact.runId))];
    const askDigest = first.askDigest;
    const refused = askDigest === undefined ? undefined : refusedAt.get(askDigest);
    const asked = askDigest === undefined ? 1 : sorted.length;
    const since = first.createdAt;
    const latestAt = msOf(shown[shown.length - 1]?.createdAt) ?? 0;
    const agreement = shown
      .map((fact) => msOf(fact.expiresAt))
      .filter((ms): ms is number => ms !== undefined)
      .sort((a, b) => a - b)[0];
    const ttl = ttlAtOf(first);
    const deadline =
      agreement !== undefined
        ? { at: isoOf(agreement), source: "agreement" as const }
        : ttl !== undefined && open
          ? { at: isoOf(ttl), source: "ttl" as const }
          : undefined;
    const fallback = shown.find((fact) => fact.ifUnanswered !== undefined)?.ifUnanswered;
    const binding = shown.length === 1 ? first.bindingDigest : undefined;
    // An ask about people carries the mark Home's exit withholds such items by.
    const people = shown.some((fact) => fact.sensitivity === "people");
    const content = ctx.content && open;
    const body =
      content && bodies !== undefined
        ? shown.length === 1
          ? { input: bodies.get(first.id) ?? null }
          : { requests: shown.map((fact) => ({ id: fact.id, input: bodies.get(fact.id) ?? null })) }
        : undefined;
    items.push(
      draftItem({
        scope: harness,
        kind,
        key: approvalKeyOf(first),
        harness,
        source: { kind: "approval", id: shown.length === 1 ? first.id : (askDigest ?? first.id) },
        title: {
          template: kind === "question" ? "question.ask" : "permission.ask",
          params: { tool: first.toolName },
        },
        whyNow:
          asked > 1 || refused !== undefined
            ? { template: "why.asked-again", params: { runs: runs.length, asks: asked } }
            : { template: "why.waiting", params: { runs: runs.length } },
        runs,
        count: runs.length,
        evidence: shown.map((fact) => ({
          kind: "decision",
          ref: `${harness}/decision/${fact.id}`,
          label: fact.toolName,
        })),
        revision: sorted.map((fact) => ({
          id: fact.id,
          state: stateOf(fact, now).state,
        })),
        choices: open ? choicesOf(shown, ctx.dir, section.relocated === true, needs) : [],
        ...(open && refused !== undefined && needs !== "owner"
          ? {
              recommendation: {
                choiceId: "deny",
                reason: { template: "recommend.refused-before", params: {} },
              },
            }
          : {}),
        ...(deadline !== undefined ? { deadline } : {}),
        ...(fallback !== undefined
          ? { ifUnanswered: { template: `if-unanswered.${fallback}` } }
          : {}),
        requiredClass: needs,
        state: open ? "open" : (settled?.state ?? "expired"),
        ...(settled?.resolution !== undefined ? { resolution: settled.resolution } : {}),
        ...(binding !== undefined ? { binding: { digestPrefix: binding.slice(0, 12) } } : {}),
        ...(people ? { sensitivity: "people" as const } : {}),
        ...(asked > 1 || refused !== undefined
          ? {
              asks: {
                count: asked,
                ...(refused !== undefined ? { refusedAt: isoOf(refused) } : {}),
              },
            }
          : {}),
        ...(body !== undefined ? { body } : {}),
        ...(ctx.content || !open ? {} : { bodyWithheld: true as const }),
        since,
        latestAt,
        freshness: ctx.freshness,
      }),
    );
  }
  return { items, decisions };
}
