/**
 * `dec_` decisions: requests to the owner for a standing rule or a delegation, change
 * adoptions, and the decisions a delegation rule may settle (a merge, a rollout). The
 * ledger is folded line by line into each decision's newest row; an item's state is the
 * decision's own (`effectiveDecisionState`). A kind no row of the attention vocabulary
 * claims yet is a `decision` item with its decision kind as a param.
 */
import {
  type AttentionChoice,
  type AttentionKind,
  type AttentionText,
  type DecisionClass,
  type DecisionRecordView,
  isId,
} from "@crewhaus/control-contract";
import { classOf, draftItem, msOf, shellWord } from "../items";
import { effectiveAttentionState } from "../lifecycle";
import type { AttentionModel, DecisionFact, Drafted, ItemContext, MetricDecision } from "../types";

/** A settled decision stays listable (with `state=all`) this long. */
const SETTLED_KEPT_MS = 30 * 86_400_000;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const obj = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** A decisions-ledger row as the inbox keeps it, or `undefined` when it is not one. */
export function decisionFactOf(
  record: Readonly<Record<string, unknown>>,
): DecisionFact | undefined {
  const id = record["id"];
  const kind = str(record["kind"]);
  const state = str(record["state"]);
  const createdAt = str(record["createdAt"]);
  if (!isId("dec", id) || kind === undefined || state === undefined || createdAt === undefined) {
    return undefined;
  }
  const terms = obj(record["terms"]);
  const subject = obj(record["subject"]);
  const pick = (name: string) => (str(record[name]) === undefined ? {} : { [name]: record[name] });
  const ruleKind = str(terms?.["ruleKind"]);
  const action = str(terms?.["action"]);
  const chg = str(subject?.["chg"]);
  return {
    id: id as string,
    kind,
    state,
    createdAt,
    ...pick("expiresAt"),
    ...(record["requiredClass"] !== undefined
      ? { requiredClass: classOf(record["requiredClass"]) }
      : {}),
    ...(record["decision"] === "grant" || record["decision"] === "deny"
      ? { decision: record["decision"] }
      : {}),
    ...pick("decidedAt"),
    ...pick("decidedVia"),
    ...pick("resolvedBy"),
    ...pick("consumedAt"),
    ...pick("supersededAt"),
    ...pick("expiredAt"),
    ...pick("deferredUntil"),
    ...pick("ifUnanswered"),
    ...(ruleKind !== undefined ? { ruleKind } : {}),
    ...(ruleKind === "delegate" && action !== undefined ? { delegationAction: action } : {}),
    ...(chg !== undefined && isId("chg", chg) ? { chg } : {}),
  } as DecisionFact;
}

/** Fold one ledger line into the model: the newest row of each decision wins. */
export function foldDecisionLine(
  state: AttentionModel,
  record: Readonly<Record<string, unknown>>,
): AttentionModel {
  const fact = decisionFactOf(record);
  if (fact === undefined) return state;
  state.decisions[fact.id] = fact;
  return state;
}

/** The item kind a decision is. */
export function decisionKindOf(fact: Pick<DecisionFact, "kind">): AttentionKind {
  if (fact.kind === "standing-rule-proposal") return "standing-rule-proposal";
  if (fact.kind === "change-adoption") return "quality-adoption";
  return "decision";
}

function viewOf(fact: DecisionFact): DecisionRecordView {
  return {
    id: fact.id,
    createdAt: fact.createdAt,
    ...(fact.decision !== undefined ? { decision: fact.decision } : {}),
    ...(fact.decidedAt !== undefined ? { decidedAt: fact.decidedAt } : {}),
    ...(fact.decidedVia !== undefined ? { decidedVia: fact.decidedVia } : {}),
    ...(fact.consumedAt !== undefined || fact.state === "consumed"
      ? { consumedAt: fact.consumedAt ?? fact.decidedAt ?? fact.createdAt }
      : {}),
    ...(fact.supersededAt !== undefined || fact.state === "superseded"
      ? { supersededBy: "superseded" }
      : {}),
    ...(fact.expiredAt !== undefined || fact.state === "expired"
      ? { expiredAt: fact.expiredAt ?? fact.createdAt }
      : {}),
    ...(fact.expiresAt !== undefined ? { expiresAt: fact.expiresAt } : {}),
    ...(fact.deferredUntil !== undefined ? { deferredUntil: fact.deferredUntil } : {}),
    ...(fact.ifUnanswered !== undefined ? { ifUnanswered: fact.ifUnanswered as never } : {}),
    ...(fact.resolvedBy === "policy" || fact.resolvedBy === "delegation"
      ? { resolvedBy: fact.resolvedBy }
      : {}),
  };
}

function choicesOf(
  fact: DecisionFact,
  harness: string,
  dir: string,
  needs: DecisionClass,
): AttentionChoice[] {
  if (fact.kind === "standing-rule-proposal" && fact.ruleKind === "delegate") {
    return [
      {
        id: "review",
        needs,
        cliTwin:
          fact.delegationAction !== undefined
            ? `crewhaus delegations preview ${fact.delegationAction} --harness ${harness}`
            : null,
        ...(fact.delegationAction === undefined
          ? { nullReason: "Open the request in Home to see what it would allow." }
          : {}),
      },
    ];
  }
  if (fact.kind === "standing-rule-proposal") {
    return (["grant", "deny"] as const).map((choice) => ({
      id: choice,
      needs,
      cliTwin: `crewhaus approvals ${choice} ${fact.id} --dir ${shellWord(dir)}`,
    }));
  }
  if (fact.kind === "change-adoption") {
    return [
      {
        id: "adopt",
        needs,
        cliTwin: null,
        nullReason:
          fact.chg !== undefined
            ? `Review the change first: \`crewhaus changes show ${fact.chg}\`.`
            : "Review the change in Home.",
      },
    ];
  }
  return (["grant", "deny"] as const).map((choice) => ({
    id: choice,
    needs,
    cliTwin: null,
    nullReason: "Home decides this request; the CLI has no command for it.",
  }));
}

/** The items of one harness's `dec_` decisions, open and (settled) from the last 30 days. */
export function decisionItems(
  model: AttentionModel,
  ctx: ItemContext,
): { readonly items: Drafted[]; readonly decisions: MetricDecision[] } {
  const items: Drafted[] = [];
  const decisions: MetricDecision[] = [];
  for (const fact of Object.values(model.decisions)) {
    const kind = decisionKindOf(fact);
    decisions.push({
      kind,
      createdAt: fact.createdAt,
      ...(fact.decidedAt !== undefined ? { decidedAt: fact.decidedAt } : {}),
      ...(fact.decidedVia !== undefined ? { decidedVia: fact.decidedVia } : {}),
      ...(fact.resolvedBy !== undefined ? { resolvedBy: fact.resolvedBy } : {}),
    });
    const effective = effectiveAttentionState(
      { source: "decision", record: viewOf(fact) },
      ctx.now,
    );
    const open = effective.state === "open";
    const settledAt = msOf(effective.resolution?.at ?? fact.decidedAt ?? fact.createdAt) ?? 0;
    if (!open && ctx.now - settledAt > SETTLED_KEPT_MS) continue;
    const needs = classOf(
      fact.requiredClass ?? (fact.kind === "standing-rule-proposal" ? "owner" : "operator"),
    );
    const delegation = fact.kind === "standing-rule-proposal" && fact.ruleKind === "delegate";
    const title: AttentionText =
      fact.kind === "standing-rule-proposal"
        ? delegation
          ? {
              template: "delegation-proposal.pending",
              params: { delegationAction: fact.delegationAction ?? "unknown" },
            }
          : {
              template: "standing-rule-proposal.pending",
              params: { ruleKind: fact.ruleKind ?? "allow" },
            }
        : fact.kind === "change-adoption"
          ? {
              template: "quality-adoption.pending",
              params: fact.chg !== undefined ? { change: fact.chg } : {},
            }
          : { template: "decision.pending", params: { decisionKind: fact.kind } };
    items.push(
      draftItem({
        scope: ctx.harness,
        kind,
        key: `dec:${fact.id}`,
        harness: ctx.harness,
        source: { kind: "decision", id: fact.id },
        title,
        whyNow: { template: "why.decision-open", params: { decisionKind: fact.kind } },
        runs: [],
        count: 0,
        evidence: [
          { kind: "decision", ref: `${ctx.harness}/decision/${fact.id}`, label: fact.kind },
        ],
        revision: [{ id: fact.id, state: fact.state }],
        choices: open ? choicesOf(fact, ctx.harness, ctx.dir, needs) : [],
        ...(fact.expiresAt !== undefined && open
          ? { deadline: { at: fact.expiresAt, source: "ttl" as const } }
          : {}),
        ...(fact.ifUnanswered !== undefined
          ? { ifUnanswered: { template: `if-unanswered.${fact.ifUnanswered}` } }
          : {}),
        requiredClass: needs,
        state: effective.state,
        ...(effective.resolution !== undefined ? { resolution: effective.resolution } : {}),
        since: fact.createdAt,
        latestAt: msOf(fact.decidedAt ?? fact.createdAt) ?? 0,
        freshness: ctx.freshness,
      }),
    );
  }
  return { items, decisions };
}
