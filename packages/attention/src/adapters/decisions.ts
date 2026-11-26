/**
 * `dec_` decisions: requests to the owner for a standing rule or a delegation, change
 * adoptions, the decisions a delegation rule may settle (a merge, a rollout), and a
 * protected environment's quorum (which, once met, waits for the move it allows). The
 * ledger is folded line by line into each decision's newest row; an item's state is the
 * decision's own (`effectiveDecisionState`). A kind no row of the attention vocabulary
 * claims yet is a `decision` item with its decision kind as a param.
 */
import {
  type AttentionChoice,
  type AttentionKind,
  type AttentionText,
  DELEGABLE_DECISION_KINDS,
  DELEGATION_ACTIONS,
  DEPLOY_QUORUM_KIND,
  type DecisionClass,
  type DecisionRecordView,
  type DeployQuorumSubject,
  ENVIRONMENT_NAME_RE,
  IF_UNANSWERED,
  SPEC_NAME_RE,
  SPEC_REVISION_RE,
  SPEC_VERSION_RE,
  isId,
} from "@crewhaus/control-contract";
import { attIdOf } from "../ids";
import { classOf, decideChoice, draftItem, msOf, timeOf, twinOf, viaOf } from "../items";
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

/** What a decision's kind may be: a lowercase word, so no message or path fits. */
const DECISION_KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The kinds the decision ledger's writers mint. A row of any other kind is a decision of
 * kind `other`: it is listed, and its own word reaches no item and no metric.
 */
export const MINTED_DECISION_KINDS: readonly string[] = Object.freeze([
  "standing-rule-proposal",
  "change-adoption",
  ...DELEGABLE_DECISION_KINDS,
  DEPLOY_QUORUM_KIND,
]);

/** A ledger row's kind as the inbox keeps it. */
export function mintedKindOf(kind: string): string {
  return MINTED_DECISION_KINDS.includes(kind) ? kind : "other";
}

const oneOf = (list: readonly string[], value: unknown): string | undefined =>
  typeof value === "string" && list.includes(value) ? value : undefined;

/**
 * A decisions-ledger row as the inbox keeps it, or `undefined` when it is not one (its
 * creation time included). A kind no writer mints reads `other`; a rule kind, a delegation
 * action or a fallback outside its closed list, and a time that is not one, is left out;
 * a door outside the closed list reads `unknown`.
 */
export function decisionFactOf(
  record: Readonly<Record<string, unknown>>,
): DecisionFact | undefined {
  const id = record["id"];
  const kind = str(record["kind"]);
  const state = str(record["state"]);
  const createdAt = timeOf(record["createdAt"]);
  if (
    !isId("dec", id) ||
    kind === undefined ||
    !DECISION_KIND_RE.test(kind) ||
    state === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }
  const terms = obj(record["terms"]);
  const subject = obj(record["subject"]);
  const time = (name: string) =>
    timeOf(record[name]) === undefined ? {} : { [name]: record[name] };
  const via = viaOf(record["decidedVia"]);
  const ruleKind = oneOf(["allow", "delegate"], terms?.["ruleKind"]);
  const action = oneOf(DELEGATION_ACTIONS, terms?.["action"]);
  const ifUnanswered = oneOf(IF_UNANSWERED, record["ifUnanswered"]);
  const chg = str(subject?.["chg"]);
  const quorum = kind === DEPLOY_QUORUM_KIND ? quorumOf(subject) : undefined;
  return {
    id: id as string,
    // A quorum that names no version that fits a command is a decision of no known kind.
    kind: kind === DEPLOY_QUORUM_KIND && quorum === undefined ? "other" : mintedKindOf(kind),
    state,
    createdAt,
    ...time("expiresAt"),
    ...(record["requiredClass"] !== undefined
      ? { requiredClass: classOf(record["requiredClass"]) }
      : {}),
    ...(record["decision"] === "grant" || record["decision"] === "deny"
      ? { decision: record["decision"] }
      : {}),
    ...time("decidedAt"),
    ...(via !== undefined ? { decidedVia: via } : {}),
    ...(record["resolvedBy"] === "policy" || record["resolvedBy"] === "delegation"
      ? { resolvedBy: record["resolvedBy"] }
      : {}),
    ...time("consumedAt"),
    ...time("supersededAt"),
    ...time("expiredAt"),
    ...time("deferredUntil"),
    ...(ifUnanswered !== undefined ? { ifUnanswered } : {}),
    ...(ruleKind !== undefined ? { ruleKind } : {}),
    ...(ruleKind === "delegate" && action !== undefined ? { delegationAction: action } : {}),
    ...(chg !== undefined && isId("chg", chg) ? { chg } : {}),
    ...(quorum !== undefined ? { quorum } : {}),
  } as DecisionFact;
}

/** A quorum's subject when every part of it fits its grammar. */
function quorumOf(
  subject: Readonly<Record<string, unknown>> | undefined,
): DeployQuorumSubject | undefined {
  const fits = (name: string, re: RegExp): string | undefined => {
    const value = subject?.[name];
    return typeof value === "string" && re.test(value) ? value : undefined;
  };
  const spec = fits("spec", SPEC_NAME_RE);
  const environment = fits("environment", ENVIRONMENT_NAME_RE);
  const version = fits("version", SPEC_VERSION_RE);
  const specHash = fits("specHash", SPEC_REVISION_RE);
  return spec !== undefined &&
    environment !== undefined &&
    version !== undefined &&
    specHash !== undefined
    ? { spec, environment, version, specHash }
    : undefined;
}

/** A kept fact held to the grammars a fresh read holds it to, or `undefined`. */
export function closedDecisionFact(fact: DecisionFact): DecisionFact | undefined {
  if (!isId("dec", fact.id) || timeOf(fact.createdAt) === undefined) return undefined;
  const { decidedVia, resolvedBy, ...rest } = fact;
  const out: Record<string, unknown> = { ...rest, kind: mintedKindOf(fact.kind) };
  for (const name of [
    "expiresAt",
    "decidedAt",
    "consumedAt",
    "supersededAt",
    "expiredAt",
    "deferredUntil",
  ]) {
    if (out[name] !== undefined && timeOf(out[name]) === undefined) {
      Reflect.deleteProperty(out, name);
    }
  }
  const via = viaOf(decidedVia);
  return {
    ...out,
    ...(via !== undefined ? { decidedVia: via } : {}),
    ...(resolvedBy === "policy" || resolvedBy === "delegation" ? { resolvedBy } : {}),
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
  if (fact.kind === DEPLOY_QUORUM_KIND) return "deploy-approval";
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

function choicesOf(fact: DecisionFact, harness: string, needs: DecisionClass): AttentionChoice[] {
  const att = attIdOf(harness, decisionKindOf(fact), `dec:${fact.id}`);
  const decides = (ids: readonly string[]) => ids.map((id) => decideChoice(att, id, needs));
  if (fact.kind === "standing-rule-proposal" && fact.ruleKind === "delegate") {
    const cliTwin =
      fact.delegationAction === undefined
        ? undefined
        : twinOf(DELEGATIONS_PREVIEW, { delegationAction: fact.delegationAction, hrn: harness });
    // A rule is turned on from its consequences page; refusing the request is decided here.
    return [
      cliTwin !== undefined
        ? { id: "review", needs, cliTwin }
        : {
            id: "review",
            needs,
            cliTwin: null,
            nullReason: "This request names no action a rule may cover, so nothing can preview it.",
          },
      ...decides(["deny"]),
    ];
  }
  if (fact.kind === "standing-rule-proposal") return decides(["grant", "deny"]);
  if (fact.kind === "change-adoption") {
    return [
      ...decides(["grant", "deny"]),
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
  if (fact.kind === DEPLOY_QUORUM_KIND) {
    if (fact.state === "granted") return [promoteChoice(fact, needs)];
    return decides(["approve", "deny"]);
  }
  // A kind no writer mints is settled by no one here.
  return fact.kind === "other" ? [] : decides(["grant", "deny"]);
}

/**
 * The move an approved version waits for: its own pin, or its own activation. Both pass
 * the environment's gate again, which now finds its approvals.
 */
function promoteChoice(fact: DecisionFact, needs: DecisionClass): AttentionChoice {
  const quorum = fact.quorum;
  const cliTwin =
    quorum === undefined
      ? undefined
      : isId("dep", quorum.version)
        ? twinOf(ACTIVATE, { dep: quorum.version, env: quorum.environment })
        : twinOf(PIN, { specName: quorum.spec, env: quorum.environment, version: quorum.version });
  return {
    id: "promote",
    needs,
    permission: "h.deploy",
    ...(cliTwin !== undefined ? { cliTwin } : { cliTwin: null, nullReason: "Promote it in Home." }),
  };
}

/** The command that pins a version into an environment, run in the harness's folder. */
const PIN = { argv: ["spec", "pin", "{specName}", "{env}", "{version}"] } as const;

/** The command that activates a build into an environment, run in the harness's folder. */
const ACTIVATE = { argv: ["deploy", "activate", "{dep}", "--environment", "{env}"] } as const;

/** An approved version that no move has used yet, and that has not run out. */
function readyToPromote(fact: DecisionFact, now: number): boolean {
  if (fact.kind !== DEPLOY_QUORUM_KIND || fact.state !== "granted") return false;
  const ends = msOf(fact.expiresAt);
  return ends === undefined || now < ends;
}

/** The command that shows what a delegation rule would allow: the delegation area's own. */
const DELEGATIONS_PREVIEW = {
  argv: ["delegations", "preview", "{delegationAction}", "--harness", "{hrn}"],
} as const;

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
    // An approved version waits for the move it was approved for.
    const ready = readyToPromote(fact, ctx.now);
    const open = effective.state === "open" || ready;
    const settledAt = msOf(effective.resolution?.at ?? fact.decidedAt ?? fact.createdAt) ?? 0;
    if (!open && ctx.now - settledAt > SETTLED_KEPT_MS) continue;
    const needs = classOf(
      fact.requiredClass ??
        (fact.kind === "standing-rule-proposal"
          ? "owner"
          : fact.kind === DEPLOY_QUORUM_KIND
            ? "maintainer"
            : "operator"),
    );
    const delegation = fact.kind === "standing-rule-proposal" && fact.ruleKind === "delegate";
    const quorum = fact.quorum;
    const title: AttentionText =
      quorum !== undefined
        ? {
            template: ready ? "deploy-approval.ready" : "deploy-approval.pending",
            params: {
              spec: quorum.spec,
              environment: quorum.environment,
              version: quorum.version,
            },
          }
        : fact.kind === "standing-rule-proposal"
          ? delegation
            ? {
                template: "delegation-proposal.pending",
                params:
                  fact.delegationAction !== undefined
                    ? { delegationAction: fact.delegationAction }
                    : {},
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
        whyNow:
          quorum === undefined
            ? { template: "why.decision-open", params: { decisionKind: fact.kind } }
            : { template: ready ? "why.deploy-approved" : "why.deploy-blocked", params: {} },
        runs: [],
        count: 0,
        evidence: [
          { kind: "decision", ref: `${ctx.harness}/decision/${fact.id}`, label: fact.kind },
        ],
        revision: [{ id: fact.id, state: fact.state }],
        choices: open ? choicesOf(fact, ctx.harness, needs) : [],
        ...(fact.expiresAt !== undefined && open
          ? { deadline: { at: fact.expiresAt, source: "ttl" as const } }
          : {}),
        ...(fact.ifUnanswered !== undefined
          ? { ifUnanswered: { template: `if-unanswered.${fact.ifUnanswered}` } }
          : {}),
        requiredClass: needs,
        state: ready ? "open" : effective.state,
        ...(!ready && effective.resolution !== undefined
          ? { resolution: effective.resolution }
          : {}),
        since: fact.createdAt,
        latestAt: msOf(fact.decidedAt ?? fact.createdAt) ?? 0,
        freshness: ctx.freshness,
      }),
    );
  }
  return { items, decisions };
}
