/**
 * Standing rules through the API: the live rules of a harness, making one from a
 * decision, and ending one. Only the harness's owner makes or ends a rule, and never a
 * service. A rule is made from a decision the request names: its tool, and the narrowest
 * pattern that covers the call, unless the owner names a wider one the rule allows.
 */
import {
  DEFAULT_RULE_DAYS,
  type DecisionActor,
  MAX_RULE_DAYS,
  type Settlement,
  createStandingRule,
  outcomeOf,
  standingPatternFor,
  widenedPatternProblem,
} from "@crewhaus/control-service";
import { foldApprovals } from "../approvals";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { fleetSnapshot } from "./lists";
import { harnessOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

const DAY_MS = 86_400_000;

function actorOf(ctx: V1Context): DecisionActor {
  return { kind: "principal", principal: ctx.access.caller.principal };
}

function ownerOnly(ctx: V1Context, dir: string): void {
  if (!ctx.deps.control.decisions.mayManageRules(dir, actorOf(ctx))) {
    throw new V1Error({
      status: 403,
      code: "forbidden",
      reason: "owner_only",
      needs: "h.standing-rule.manage",
      message: "Only this harness's owner makes or ends a standing rule.",
    });
  }
}

const list: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const listing = ctx.deps.control.rules.list(dir);
  const limit = ctx.query["limit"] === undefined ? 50 : Number(ctx.query["limit"]);
  const items = listing.rules.slice(0, limit);
  return {
    status: 200,
    body: {
      items,
      snapshotAt: fleetSnapshot(0),
      ...(listing.rules.length > limit || listing.unreadable.length > 0
        ? {
            truncated: {
              reason: listing.unreadable[0] ?? "page_limit",
              verb: `crewhaus approvals rules --dir ${dir}`,
            },
          }
        : {}),
      ...(items.length === 0
        ? {
            empty: {
              reason: "no-data",
              remedy: "A standing rule is made when the owner grants a request with --always.",
            },
          }
        : {}),
    },
    scrubDir: dir,
  };
};

const create: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  ownerOnly(ctx, dir);
  const from = ctx.body["derivedFrom"];
  const record =
    typeof from === "string" ? foldApprovals(dir).approvals.find((a) => a.id === from) : undefined;
  if (record === undefined) {
    throw new V1Error({
      status: 422,
      code: "invalid",
      reason: "derived_from",
      message: "A standing rule is made from a decision: name it in derivedFrom.",
      verb: "crewhaus approvals grant <id> --always",
    });
  }
  const tool = String(ctx.body["tool"]);
  const pattern = String(ctx.body["pattern"]);
  if (tool !== record.toolName) {
    throw new V1Error({
      status: 422,
      code: "invalid",
      reason: "tool",
      message: `That decision is about ${record.toolName}.`,
    });
  }
  const narrow = standingPatternFor(record.toolName, record.input, dir);
  if ("refused" in narrow) {
    throw new V1Error({
      status: 422,
      code: "invalid",
      reason: narrow.refused,
      message: "No standing rule can name this call.",
    });
  }
  if ("pattern" in narrow && narrow.pattern !== pattern) {
    const problem = widenedPatternProblem(record.toolName, record.input, pattern, dir);
    if (problem !== undefined) {
      throw new V1Error({ status: 422, code: "invalid", reason: "pattern", message: problem });
    }
  }
  const now = ctx.deps.now();
  const expires = ctx.body["expiresAt"];
  const expiresAt =
    typeof expires === "string" ? Date.parse(expires) : now + DEFAULT_RULE_DAYS * DAY_MS;
  if (Number.isNaN(expiresAt) || expiresAt <= now || expiresAt > now + MAX_RULE_DAYS * DAY_MS) {
    throw new V1Error({
      status: 422,
      code: "invalid",
      reason: "expires_at",
      message: `A standing rule lasts from now to at most ${MAX_RULE_DAYS} days.`,
    });
  }
  const by = await ctx.deps.control.decisions.storedActorOf(dir, actorOf(ctx));
  const submitted = await submitCommand<Awaited<ReturnType<typeof createStandingRule>>>(ctx, {
    target: `home/harness/${entry.id}`,
    ledger: { harness: dir },
    effect: async (receipt) => {
      const made = await createStandingRule({
        harnessDir: dir,
        tool,
        pattern,
        reason: "approval",
        derivedFrom: record.id,
        createdBy: by,
        expiresAt: new Date(expiresAt).toISOString(),
        cmd: receipt.id,
        now,
      });
      return {
        settle: made.ok
          ? { state: "succeeded" }
          : { state: "failed", outcome: outcomeOf("unavailable") },
        value: made,
      };
    },
  });
  const made = submitted.value;
  if (made !== undefined && !made.ok) {
    throw new V1Error({
      status: 503,
      code: "unavailable",
      reason: "rule_write",
      message: made.reason,
      details: { receipt: submitted.receipt },
    });
  }
  return acceptedAnswer(submitted, made?.ok === true ? { rule: made.rule } : {}, dir);
};

const revoke: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  ownerOnly(ctx, dir);
  const id = String(ctx.params["rule"]);
  const submitted = await submitCommand<
    Awaited<ReturnType<V1Context["deps"]["control"]["rules"]["revoke"]>>
  >(ctx, {
    target: `${entry.id}/rule/${id}`,
    ledger: { harness: dir },
    effect: async () => {
      const answer = await ctx.deps.control.rules.revoke({
        harnessDir: dir,
        id,
        actor: actorOf(ctx),
      });
      const settle: Settlement =
        answer.outcome === "revoked"
          ? { state: "succeeded" }
          : answer.outcome === "not-found"
            ? { state: "rejected", outcome: outcomeOf("not_found") }
            : answer.outcome === "ended"
              ? { state: "rejected", outcome: outcomeOf("conflict") }
              : answer.outcome === "forbidden"
                ? { state: "rejected", outcome: outcomeOf("forbidden") }
                : { state: "failed", outcome: outcomeOf("unavailable") };
      return { settle, value: answer };
    },
  });
  const answer = submitted.value;
  if (answer !== undefined && answer.outcome !== "revoked") {
    const status =
      answer.outcome === "not-found"
        ? 404
        : answer.outcome === "ended"
          ? 409
          : answer.outcome === "forbidden"
            ? 403
            : 503;
    throw new V1Error({
      status,
      code:
        status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 403
              ? "forbidden"
              : "unavailable",
      reason: answer.outcome,
      message:
        answer.outcome === "not-found"
          ? "This harness has no standing rule by that id."
          : answer.outcome === "ended"
            ? "That standing rule has already ended."
            : "reason" in answer
              ? answer.reason
              : "The rule could not be ended.",
      details: { receipt: submitted.receipt },
    });
  }
  return acceptedAnswer(submitted, answer?.outcome === "revoked" ? { rule: answer.rule } : {}, dir);
};

export const RULE_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "rules.list": list,
  "rules.create": create,
  "rules.revoke": revoke,
};
