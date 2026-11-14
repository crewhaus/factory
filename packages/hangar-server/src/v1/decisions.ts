/**
 * Decisions through the API: the fold Home's approvals view uses, for the harnesses the
 * caller may read, and the three ways a person settles one, each a receipted command run
 * through the one decision service the CLI and the console use. The tool input is shown
 * only to a caller who may read the harness's content. Resolving with `expect` checks
 * the request's state, or a prefix of its binding digest, first.
 */
import { type ErrorCode, effectiveDecisionState, parseRef } from "@crewhaus/control-contract";
import { type DecisionActor, outcomeOf } from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { readHarnessEnvFiles } from "@crewhaus/harness-supervisor";
import {
  type PendingApproval,
  parseDeferUntil,
  resolveHarnessSessionRoot,
} from "@crewhaus/session-store";
import { permissionMessage } from "../access";
import { foldApprovals } from "../approvals";
import { maskDeep } from "../mask";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { fleetSnapshot } from "./lists";
import { entryOf, liveDirOf, visibleHarnesses } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

const MAX_TTL = Number.MAX_SAFE_INTEGER;

/** One decision as the API serves it. */
export function decisionView(
  record: PendingApproval,
  harness: string,
  content: boolean,
  now: number,
): Record<string, unknown> {
  const effective = effectiveDecisionState(record as never, null, now);
  const fields = record as unknown as Readonly<Record<string, unknown>>;
  const pick = (name: string) => (fields[name] === undefined ? {} : { [name]: fields[name] });
  return {
    id: record.id,
    createdAt: record.createdAt,
    ...pick("toolName"),
    ...pick("inputHash"),
    ...(content ? { input: maskDeep(record.input ?? null) } : { inputWithheld: true }),
    ...pick("runId"),
    ...pick("sessionId"),
    ...pick("surface"),
    ...pick("decision"),
    ...pick("decidedBy"),
    ...pick("decidedAt"),
    ...pick("consumedAt"),
    ...pick("always"),
    ...pick("decidedByPrincipal"),
    ...pick("supersededBy"),
    ...pick("expiresAt"),
    ...pick("deferredUntil"),
    ...pick("bindingDigest"),
    ...pick("sensitivity"),
    state: effective.state,
    ...(effective.overdue ? { overdue: true } : {}),
    harness,
  };
}

type Located = {
  readonly entry: HangarHarnessEntry;
  readonly dir: string;
  readonly record: PendingApproval;
};

/**
 * The decision `{ref}` names, in a harness the caller may read. A bare id is looked up
 * only in the harness `?harness=` names; without one it is 422 `harness_needed` with the
 * candidates the caller may read, never a guess, so every decision is acted on in the
 * harness the request named.
 */
function locate(ctx: V1Context): Located {
  const raw = ctx.params["ref"] ?? "";
  const parsed = parseRef(raw);
  const missing = new V1Error({
    status: 404,
    code: "not_found",
    reason: "decision_unknown",
    message: "No decision has that ref here.",
  });
  const lookIn = (entry: HangarHarnessEntry | undefined, id: string) => {
    const dir = entry === undefined ? undefined : liveDirOf(entry);
    if (entry === undefined || dir === undefined || !ctx.access.canRead(entry.id)) return undefined;
    const record = foldApprovals(dir).approvals.find((a) => a.id === id);
    return record === undefined ? undefined : { entry, dir, record };
  };
  if (!("error" in parsed)) {
    if (parsed.kind !== "decision") throw missing;
    const found = lookIn(entryOf(ctx.deps, parsed.scope), parsed.id);
    if (found === undefined) throw missing;
    return found;
  }
  const hint = ctx.query["harness"];
  if (hint !== undefined) {
    const found = lookIn(entryOf(ctx.deps, hint), raw);
    if (found === undefined) throw missing;
    return found;
  }
  const found = visibleHarnesses(ctx.deps)
    .map((entry) => lookIn(entry, raw))
    .filter((f): f is Located => f !== undefined);
  throw new V1Error({
    status: 422,
    code: "invalid",
    reason: "harness_needed",
    message: "Say which harness with ?harness=, or name the decision as <harness>/decision/<id>.",
    details: {
      candidates: found.map((f) => ({
        kind: "decision",
        ref: `${f.entry.id}/decision/${raw}`,
        href: `/#/i/${f.entry.id}/decision/${raw}`,
      })),
    },
  });
}

function actorOf(ctx: V1Context): DecisionActor {
  const caller = ctx.access.caller;
  return {
    kind: "principal",
    principal: caller.principal,
    ...(caller.via === "service" ? { service: true as const } : {}),
    display: caller.principal,
  };
}

function sessionRootOf(dir: string): string {
  return resolveHarnessSessionRoot(dir, readHarnessEnvFiles(dir).vars).root;
}

const list: V1Handler = async (ctx) => {
  const limit = ctx.query["limit"] === undefined ? 50 : Number(ctx.query["limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || ctx.query["cursor"] !== undefined) {
    throw new V1Error({
      status: 400,
      code: "invalid",
      reason: ctx.query["cursor"] !== undefined ? "cursor" : "limit",
      message: "limit is 1 to 500; this list is one page and takes no cursor.",
    });
  }
  const now = ctx.deps.now();
  const rows: Record<string, unknown>[] = [];
  const cut: string[] = [];
  for (const entry of visibleHarnesses(ctx.deps)) {
    const dir = liveDirOf(entry);
    if (dir === undefined) continue;
    const folded = foldApprovals(dir);
    if (folded.truncated) cut.push(entry.id);
    const content = ctx.access.canReadContent(entry.id);
    for (const record of folded.approvals) rows.push(decisionView(record, entry.id, content, now));
  }
  rows.sort((a, b) => (String(a["createdAt"]) < String(b["createdAt"]) ? 1 : -1));
  const items = rows.slice(0, limit);
  const read = ctx.deps.home.signIn.snapshot();
  return {
    status: 200,
    body: {
      items,
      snapshotAt: fleetSnapshot(read.state === "present" ? read.snapshot.epoch : 0),
      ...(rows.length > limit || cut.length > 0
        ? {
            truncated: {
              reason: rows.length > limit ? "page_limit" : "harness_capped",
              verb: "crewhaus approvals list",
            },
          }
        : {}),
      ...(items.length === 0
        ? { empty: { reason: "no-data", remedy: "Nothing is waiting for a decision." } }
        : {}),
    },
  };
};

const get: V1Handler = async (ctx) => {
  const { entry, dir, record } = locate(ctx);
  return {
    status: 200,
    body: decisionView(record, entry.id, ctx.access.canReadContent(entry.id), ctx.deps.now()),
    scrubDir: dir,
  };
};

/** How a decision ends, as its receipt records it. */
function settleOf(outcome: string) {
  const rejected = (code: ErrorCode) => ({ state: "rejected" as const, outcome: outcomeOf(code) });
  switch (outcome) {
    case "decided":
    case "superseded":
    case "deferred":
      return { state: "succeeded" as const };
    case "forbidden":
      return rejected("forbidden");
    case "not-found":
      return rejected("not_found");
    case "invalid":
      return rejected("invalid");
    case "expired":
      return rejected("precondition_failed");
    case "stale":
      return rejected("conflict");
    default:
      return rejected("already_decided");
  }
}

/** A refused decision, in the API's words; the receipt that recorded it rides along. */
function refusalOf(
  outcome: string,
  located: Located,
  answer: {
    readonly reason?: string;
    readonly winner?: PendingApproval;
    readonly record: PendingApproval | null;
  },
  receipt: unknown,
): V1Error {
  const winner = answer.winner ?? answer.record ?? located.record;
  const details = { receipt };
  switch (outcome) {
    case "forbidden":
      return new V1Error({
        status: 403,
        code: "forbidden",
        reason: "decider",
        message: answer.reason ?? "You may not decide this request.",
        details,
      });
    case "not-found":
      return new V1Error({
        status: 404,
        code: "not_found",
        reason: "decision_unknown",
        message: "No such decision.",
        details,
      });
    case "invalid":
      return new V1Error({
        status: 400,
        code: "invalid",
        reason: "invalid",
        message: answer.reason ?? "Not valid.",
        details,
      });
    case "expired":
      return new V1Error({
        status: 412,
        code: "precondition_failed",
        reason: "expired",
        message: "This request has expired.",
        current: { state: "expired" },
        details,
      });
    default:
      return new V1Error({
        status: 409,
        code: "already_decided",
        reason: "already_decided",
        message: "This request was already settled.",
        current: {
          state: effectiveDecisionState(winner as never, null, Date.now()).state,
          ...(winner.decision !== undefined ? { decision: winner.decision } : {}),
          ...(winner.decidedAt !== undefined ? { decidedAt: winner.decidedAt } : {}),
          ...(winner.decidedVia !== undefined ? { surface: winner.decidedVia } : {}),
          ...(winner.supersededBy !== undefined ? { supersededBy: winner.supersededBy } : {}),
        },
        details,
      });
  }
}

type Settled = {
  readonly outcome: string;
  readonly record: PendingApproval | null;
  readonly reason?: string;
  readonly winner?: PendingApproval;
};

function decisionCommand(
  run: (ctx: V1Context, located: Located) => Promise<Settled>,
  check?: (ctx: V1Context, located: Located) => void,
): V1Handler {
  return async (ctx) => {
    const located = locate(ctx);
    // The row's permission, on the harness the decision lives in, before anything is written.
    const verdict = ctx.access.authorize(ctx.op.permission, { harness: located.entry.id });
    if (!verdict.allow) {
      throw new V1Error({
        status: 403,
        code: "forbidden",
        reason: "permission",
        message: permissionMessage(ctx.op.permission, "harness"),
        needs: ctx.op.permission,
        role: verdict.role,
      });
    }
    check?.(ctx, located);
    const submitted = await submitCommand<Settled>(ctx, {
      target: `${located.entry.id}/decision/${located.record.id}`,
      ledger: { harness: located.dir },
      effect: async () => {
        const answer = await run(ctx, located);
        return { settle: settleOf(answer.outcome), value: answer };
      },
    });
    const answer = submitted.value;
    if (answer !== undefined && settleOf(answer.outcome).state !== "succeeded") {
      throw refusalOf(answer.outcome, located, answer, submitted.receipt);
    }
    const record = answer?.record ?? located.record;
    return acceptedAnswer(
      submitted,
      {
        decision: decisionView(
          record,
          located.entry.id,
          ctx.access.canReadContent(located.entry.id),
          ctx.deps.now(),
        ),
        ...(answer !== undefined && "fresh" in answer && answer.fresh !== undefined
          ? {
              fresh: decisionView(
                answer.fresh as PendingApproval,
                located.entry.id,
                ctx.access.canReadContent(located.entry.id),
                ctx.deps.now(),
              ),
            }
          : {}),
      },
      located.dir,
    );
  };
}

/** `expect`: the request's state now, or a prefix of its binding digest. */
function checkExpect(ctx: V1Context, located: Located): void {
  const expect = ctx.body["expect"];
  if (typeof expect !== "string") return;
  const state = effectiveDecisionState(located.record as never, null, ctx.deps.now()).state;
  const digest = located.record.bindingDigest;
  const holds = expect === state || (typeof digest === "string" && digest.startsWith(expect));
  if (!holds) {
    throw new V1Error({
      status: 412,
      code: "precondition_failed",
      reason: "expect",
      message: "This request has changed since you read it. Read it again, then decide.",
      current: {
        state,
        ...(typeof digest === "string" ? { bindingDigest: digest } : {}),
      },
    });
  }
}

const resolve = decisionCommand(
  async (ctx, located) =>
    ctx.deps.control.decisions.resolve({
      harnessDir: located.dir,
      rootDir: sessionRootOf(located.dir),
      ref: located.record.id,
      choice: ctx.body["choice"] === "grant" ? "grant" : "deny",
      actor: actorOf(ctx),
      via: ctx.via,
      ttlDays: MAX_TTL,
    }),
  checkExpect,
);

const supersede = decisionCommand(async (ctx, located) =>
  ctx.deps.control.decisions.supersede({
    harnessDir: located.dir,
    rootDir: sessionRootOf(located.dir),
    ref: located.record.id,
    reason: String(ctx.body["reason"]),
    actor: actorOf(ctx),
    via: ctx.via,
  }),
);

const defer = decisionCommand(
  async (ctx, located) =>
    ctx.deps.control.decisions.defer({
      harnessDir: located.dir,
      rootDir: sessionRootOf(located.dir),
      ref: located.record.id,
      until: String(ctx.body["until"]),
      reason: String(ctx.body["reason"]),
      actor: actorOf(ctx),
      via: ctx.via,
    }),
  (ctx) => {
    const when = parseDeferUntil(String(ctx.body["until"]), ctx.deps.now());
    if (typeof when === "string") {
      throw new V1Error({ status: 400, code: "invalid", reason: "until", message: when });
    }
  },
);

export const DECISION_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "decisions.list": list,
  "decisions.get": get,
  "decisions.resolve": resolve,
  "decisions.supersede": supersede,
  "decisions.defer": defer,
};
