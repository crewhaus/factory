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
import {
  APPROVAL_ID_RE,
  type AttentionChoice,
  type AttentionKind,
  CANONICAL_RUN_ID_RE,
  type DecisionClass,
  type DecisionRecordView,
  EXECUTION_RUN_ID_RE,
  GRAPH_RUN_ID_RE,
  IF_UNANSWERED,
  SESSION_ID_RE,
} from "@crewhaus/control-contract";
import {
  DEFAULT_APPROVALS_FILENAME,
  DEFAULT_TTL_DAYS,
  type PendingApproval,
  containedSessionRoot,
  foldWithClaims,
} from "@crewhaus/session-store";
import { attIdOf, attRefOf, digestPrefix } from "../ids";
import {
  classOf,
  decideChoice,
  draftItem,
  higherClass,
  isoOf,
  msOf,
  timeOf,
  viaOf,
} from "../items";
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

/** What a digest a request carries may hold: the characters of an item key, nothing else. */
const DIGEST_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** What a tool's name may be: no space, quote or control character. */
const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

/** The run ids a park carries: a ledger run, an execution, or a graph run. */
const RUN_ID_RES = [CANONICAL_RUN_ID_RE, EXECUTION_RUN_ID_RE, GRAPH_RUN_ID_RE] as const;

/** Whether a request's id is one the store mints, and its time one: only those become items. */
export function isApprovalRecord(record: Pick<PendingApproval, "id" | "createdAt">): boolean {
  return (
    typeof record.id === "string" &&
    APPROVAL_ID_RE.test(record.id) &&
    timeOf(record.createdAt) !== undefined
  );
}

/**
 * The parts of a request the inbox keeps: ids, names, classes and times. A tool name, an
 * id or a digest outside its grammar, a time that is not one, and a fallback, a door or a
 * mark outside its closed list are left out (an unlisted door reads `unknown`).
 */
export function approvalFactOf(record: PendingApproval): ApprovalFact {
  const r = record as unknown as Readonly<Record<string, unknown>>;
  const time = (name: string) => (timeOf(r[name]) === undefined ? {} : { [name]: r[name] });
  const token = (name: string) =>
    typeof r[name] === "string" && DIGEST_RE.test(r[name] as string) ? { [name]: r[name] } : {};
  const runId = str(r["runId"]);
  const sessionId = str(r["sessionId"]);
  const via = viaOf(r["decidedVia"]);
  return {
    id: record.id,
    kind: r["kind"] === "input" ? "input" : "tool",
    ...(typeof r["toolName"] === "string" && TOOL_NAME_RE.test(r["toolName"])
      ? { toolName: r["toolName"] }
      : {}),
    createdAt: record.createdAt,
    ...(runId !== undefined && RUN_ID_RES.some((re) => re.test(runId)) ? { runId } : {}),
    ...(sessionId !== undefined && SESSION_ID_RE.test(sessionId) ? { sessionId } : {}),
    ...token("askDigest"),
    ...(record.requiredClass !== undefined ? { requiredClass: classOf(record.requiredClass) } : {}),
    ...time("expiresAt"),
    ...time("deferredUntil"),
    ...((IF_UNANSWERED as readonly unknown[]).includes(r["ifUnanswered"])
      ? { ifUnanswered: r["ifUnanswered"] }
      : {}),
    ...token("bindingDigest"),
    ...(record.decision === "grant" || record.decision === "deny"
      ? { decision: record.decision }
      : {}),
    ...time("decidedAt"),
    ...(via !== undefined ? { decidedVia: via } : {}),
    ...(r["resolvedBy"] === "policy" || r["resolvedBy"] === "delegation"
      ? { resolvedBy: r["resolvedBy"] }
      : {}),
    ...time("consumedAt"),
    ...(str(r["supersededBy"]) !== undefined ? { supersededBy: "superseded" } : {}),
    ...time("expiredAt"),
    ...(r["sensitivity"] === "people" ? { sensitivity: "people" } : {}),
  } as ApprovalFact;
}

/** A kept fact held to the grammars a fresh read holds it to, or `undefined`. */
export function closedApprovalFact(fact: ApprovalFact): ApprovalFact | undefined {
  const record = fact as unknown as PendingApproval;
  return isApprovalRecord(record) ? approvalFactOf(record) : undefined;
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
  const records = foldWithClaims(root, read.records).records.filter(isApprovalRecord);
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
    if (isApprovalRecord(record) && ids.has(record.id)) out.set(record.id, record.input ?? null);
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

/**
 * What may be done about a request: allow or refuse it, and for one request alone, allow
 * it from now on (an owner's narrow rule) or allow it once and ask the owner for that. A
 * question is answered, never allowed or refused.
 */
function choicesOf(
  kind: AttentionKind,
  att: string,
  count: number,
  needs: DecisionClass,
): AttentionChoice[] {
  if (kind === "question") return [];
  const ids =
    count === 1
      ? (["grant", "deny", "grant-always", "grant-propose"] as const)
      : (["grant", "deny"] as const);
  return ids.map((id) => decideChoice(att, id, id === "grant-always" ? "owner" : needs));
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
    const runs = [
      ...new Set(
        [...shown].reverse().flatMap((fact) => (fact.runId === undefined ? [] : [fact.runId])),
      ),
    ];
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
    const deferredUntil = open
      ? shown
          .map((fact) => fact.deferredUntil)
          .filter((at): at is string => (msOf(at) ?? 0) > now)
          .sort((a, b) => (msOf(a) ?? 0) - (msOf(b) ?? 0))[0]
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
          params: first.toolName !== undefined ? { tool: first.toolName } : {},
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
          label: fact.toolName ?? "tool",
        })),
        revision: sorted.map((fact) => ({
          id: fact.id,
          state: stateOf(fact, now).state,
        })),
        choices: open
          ? choicesOf(kind, attIdOf(harness, kind, approvalKeyOf(first)), shown.length, needs)
          : [],
        ...(open && kind === "permission" && refused !== undefined && needs !== "owner"
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
        // Put off: its own deadline moved with it, so it stays in the list.
        ...(deferredUntil !== undefined
          ? { deferral: { until: deferredUntil, deadlineMoved: true } }
          : {}),
        state: open
          ? deferredUntil !== undefined
            ? "deferred"
            : "open"
          : (settled?.state ?? "expired"),
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
