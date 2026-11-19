/**
 * The Advisor's findings, as Home's sweep last gathered them for a harness (its
 * snapshot): this adapter derives nothing and runs no check. A finding becomes an item by
 * its evidence-keyed id: quality, budget, security and spec findings by their id's
 * family, every other one as setup. The pending-approvals finding is left out: each
 * request is an item of its own.
 */
import type { AttentionChoice, AttentionKind } from "@crewhaus/control-contract";
import { draftItem, msOf } from "../items";
import type { AdvisorFinding, AdvisorSnapshot, Drafted, ItemContext } from "../types";

/** The item kind an Advisor finding is, or `null` for one the inbox leaves out. */
export function advisorKindOf(id: string): AttentionKind | null {
  if (id === "approvals-pending" || id.startsWith("approvals-pending-")) return null;
  if (id === "eval-below-baseline") return "quality-regression";
  if (id.startsWith("budget-")) return "budget";
  if (id.startsWith("incident-") || id === "incidents-open") return "security";
  if (id.startsWith("spec-")) return "spec";
  return "setup";
}

const DECILE_RE = /^budget-near-(\d+)-(.+)$/;
const EXCEEDED_RE = /^budget-exceeded-(.+)$/;

/** The closed title a finding shows, with its params: ids and names from its id only. */
export function advisorTitleOf(item: AdvisorFinding): {
  readonly template: string;
  readonly params: Readonly<Record<string, string | number>>;
} {
  const id = item.id;
  const rest = (prefix: string) => id.slice(prefix.length);
  if (id === "spec-unreadable") return { template: "advisor.spec-unreadable", params: {} };
  if (id.startsWith("preflight-")) {
    return { template: "advisor.preflight-blocked", params: { check: rest("preflight-") } };
  }
  if (id === "proc-crash-looping") return { template: "advisor.crash-looping", params: {} };
  if (id === "proc-parked") return { template: "advisor.parked", params: {} };
  if (id === "proc-terminal") return { template: "advisor.terminal", params: {} };
  if (id === "eval-below-baseline") return { template: "advisor.quality-regressed", params: {} };
  if (id.startsWith("incident-")) {
    return { template: "advisor.incident-open", params: { incident: rest("incident-") } };
  }
  if (id.startsWith("dream-overdue-")) {
    return { template: "advisor.dream-overdue", params: { spec: rest("dream-overdue-") } };
  }
  const near = DECILE_RE.exec(id);
  if (near !== null) {
    return {
      template: "advisor.budget-near",
      params: { percent: Number(near[1]) * 10, period: near[2] as string },
    };
  }
  const exceeded = EXCEEDED_RE.exec(id);
  if (exceeded !== null) {
    return { template: "advisor.budget-exceeded", params: { period: exceeded[1] as string } };
  }
  if (id === "budget-absent") return { template: "advisor.budget-absent", params: {} };
  if (id.startsWith("spec-issue-")) return { template: "advisor.spec-issue", params: {} };
  if (id === "evals-none") return { template: "advisor.evals-none", params: {} };
  if (id === "evals-no-baseline") return { template: "advisor.evals-no-baseline", params: {} };
  if (id === "advice-waiting") return { template: "advisor.advice-waiting", params: {} };
  if (id === "policy-flip-ready") return { template: "advisor.policy-flip-ready", params: {} };
  if (id.startsWith("candidate-underperforming-")) {
    return { template: "advisor.candidate-underperforming", params: {} };
  }
  if (id.startsWith("audition-ready-")) return { template: "advisor.audition-ready", params: {} };
  if (id === "escalation-rate-high")
    return { template: "advisor.escalation-rate-high", params: {} };
  if (id === "judge-spend-dominates") {
    return { template: "advisor.judge-spend-dominates", params: {} };
  }
  if (id.startsWith("sunset-in-roster-")) {
    return { template: "advisor.model-retiring", params: { model: rest("sunset-in-roster-") } };
  }
  if (id.startsWith("restart-to-serve-pin-")) {
    return {
      template: "advisor.pin-not-served",
      params: { environment: rest("restart-to-serve-pin-") },
    };
  }
  return { template: "advisor.other", params: { screen: item.screen } };
}

function choicesOf(item: AdvisorFinding): AttentionChoice[] {
  const action = item.action;
  if (action === null) return [];
  return [
    {
      id: action.kind === "job" ? "act" : "open",
      needs: "operator",
      cliTwin: action.cliTwin,
      ...(action.cliTwin === null
        ? { nullReason: `Open the ${item.screen} screen in Home; there is no command for this.` }
        : {}),
    },
  ];
}

/** The items of one harness's Advisor snapshot. */
export function advisorItems(snapshot: AdvisorSnapshot, ctx: ItemContext): Drafted[] {
  const out: Drafted[] = [];
  for (const finding of snapshot.items) {
    if (finding.status !== "open") continue;
    const kind = advisorKindOf(finding.id);
    if (kind === null) continue;
    const at = finding.evidenceAt ?? snapshot.at;
    out.push(
      draftItem({
        scope: ctx.harness,
        kind,
        key: `adv:${finding.id}`,
        harness: ctx.harness,
        source: { kind: "advisor", id: finding.id },
        title: advisorTitleOf(finding),
        whyNow: { template: `why.advisor-${finding.severity}`, params: {} },
        runs: [],
        count: 0,
        evidence: [{ kind: "advisor", ref: finding.id, label: finding.source }],
        revision: [{ id: finding.id, state: `${finding.severity}@${at}` }],
        choices: choicesOf(finding),
        requiredClass: "operator",
        state: "open",
        since: at,
        latestAt: msOf(at) ?? 0,
        freshness: ctx.freshness,
      }),
    );
  }
  return out;
}
