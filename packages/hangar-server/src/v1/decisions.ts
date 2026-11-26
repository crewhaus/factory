/**
 * Decisions through the API: the fold Home's approvals view uses, for the harnesses the
 * caller may read, and the three ways a person settles one, each a receipted command run
 * through the one decision service the CLI and the console use. A harness's decisions are
 * its tool approvals (`appr_`) and the merges and rollouts an owner's delegation rule may
 * decide (`dec_`): both kinds are read only in harnesses the caller may read, before
 * anything is counted. Every decided row says who decided in the server's words
 * (`decidedByText`): a delegated one names its rule and revision, a person's names the
 * person. The tool input is shown only to a caller who may read the harness's content.
 * A decision about a person is not found by a caller who may not see people's records.
 * `?state=pending` keeps only what waits, before the page is cut. On a harness Home
 * governs, a decision is made only while the harness's own list of who may decide is in
 * place. Resolving with `expect` checks the request's state, or a prefix of its binding
 * digest, first.
 */
import {
  type ErrorCode,
  RECEIPT_VIA,
  effectiveDecisionState,
  isId,
  parseRef,
} from "@crewhaus/control-contract";
import {
  type ActionDecisionRow,
  actionDecisionState,
  createApproverReader,
  readActionDecisions,
} from "@crewhaus/control-records";
import { type DecisionActor, outcomeOf } from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { readHarnessEnvFiles } from "@crewhaus/harness-supervisor";
import {
  type PendingApproval,
  containedSessionRoot,
  parseDeferUntil,
} from "@crewhaus/session-store";
import { PEOPLE_SENSITIVITY, permissionMessage } from "../access";
import { foldApprovals } from "../approvals";
import { maskDeep } from "../mask";
import type { V1Context, V1Handler } from "./context";
import { type DecidedByReader, decidedByReader } from "./decided-by";
import { V1Error } from "./errors";
import { fleetSnapshot } from "./lists";
import { entryOf, liveDirOf, visibleHarnesses } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

const MAX_TTL = Number.MAX_SAFE_INTEGER;

/** The door a decision came through, as a closed word: `unknown` for any other value. */
function viaOf(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  return {
    decidedVia: (RECEIPT_VIA as readonly unknown[]).includes(value) ? String(value) : "unknown",
  };
}

/** One tool approval as the API serves it. */
export function decisionView(
  record: PendingApproval,
  harness: string,
  content: boolean,
  now: number,
  decidedByText?: string,
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
    ...viaOf(fields["decidedVia"]),
    ...pick("resolvedBy"),
    ...pick("delegation"),
    ...pick("appliedBy"),
    ...pick("supersededBy"),
    ...pick("expiresAt"),
    ...pick("deferredUntil"),
    ...pick("bindingDigest"),
    ...pick("sensitivity"),
    state: effective.state,
    ...(effective.overdue ? { overdue: true } : {}),
    ...(decidedByText !== undefined ? { decidedByText } : {}),
    harness,
    ref: `${harness}/decision/${record.id}`,
  };
}

/** One merge or rollout decision as the API serves it: ids, classes, states and times only. */
export function actionDecisionView(
  row: ActionDecisionRow,
  harness: string,
  now: number,
  decidedByText?: string,
): Record<string, unknown> {
  const fields = row as unknown as Readonly<Record<string, unknown>>;
  const pick = (name: string) => (fields[name] === undefined ? {} : { [name]: fields[name] });
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.createdAt,
    actionClass: row.actionClass,
    requiredClass: row.requiredClass,
    subject: { ref: row.subject.ref, revision: row.subject.revision },
    expiresAt: row.expiresAt,
    proposedBy: row.proposedBy,
    ...pick("decision"),
    ...pick("decidedAt"),
    ...pick("decidedByPrincipal"),
    ...pick("resolvedBy"),
    ...pick("delegation"),
    ...pick("appliedBy"),
    ...pick("consumedAt"),
    ...pick("supersededBy"),
    ...pick("supersededReason"),
    state: actionDecisionState(row, now),
    ...(decidedByText !== undefined ? { decidedByText } : {}),
    harness,
    ref: `${harness}/decision/${row.id}`,
  };
}

type Located = {
  readonly entry: HangarHarnessEntry;
  readonly dir: string;
} & (
  | { readonly record: PendingApproval; readonly action?: undefined }
  | { readonly record?: undefined; readonly action: ActionDecisionRow }
);

/** The decision's id, whichever kind it is. */
const idOf = (located: Located): string =>
  located.record !== undefined ? located.record.id : located.action.id;

/** A tool approval or a merge or rollout decision of one harness, by id. */
function findIn(
  dir: string,
  id: string,
): { record: PendingApproval } | { action: ActionDecisionRow } | undefined {
  if (isId("dec", id)) {
    const read = readActionDecisions(dir);
    const action = read.state === "present" ? read.rows.find((r) => r.id === id) : undefined;
    return action === undefined ? undefined : { action };
  }
  const record = foldApprovals(dir).approvals.find((a) => a.id === id);
  return record === undefined ? undefined : { record };
}

/** Whether a record marked as about people may be released to this caller. */
export function peopleReleased(
  ctx: V1Context,
  harness: string,
  id: string,
  sensitivity: unknown,
): boolean {
  if (sensitivity !== PEOPLE_SENSITIVITY) return true;
  return ctx.access.peopleAllowed({ ref: `${harness}/decision/${id}`, sensitivity });
}

/** The answer for a decision this Home does not have, or the caller may not find. */
const MISSING = () =>
  new V1Error({
    status: 404,
    code: "not_found",
    reason: "decision_unknown",
    message: "No decision has that ref here.",
  });

/**
 * The decision `{ref}` names, in a harness the caller may read. A bare id is looked up
 * only in the harness `?harness=` names; without one it is 422 `harness_needed` with the
 * candidates the caller may read, never a guess, so every decision is acted on in the
 * harness the request named. A decision about a person that the caller may not see
 * answers the same 404 as one that does not exist.
 */
function locate(ctx: V1Context): Located {
  const raw = ctx.params["ref"] ?? "";
  const parsed = parseRef(raw);
  const lookIn = (entry: HangarHarnessEntry | undefined, id: string): Located | undefined => {
    const dir = entry === undefined ? undefined : liveDirOf(entry);
    if (entry === undefined || dir === undefined || !ctx.access.canRead(entry.id)) return undefined;
    const found = findIn(dir, id);
    if (found === undefined) return undefined;
    if ("record" in found) {
      const sensitivity = (found.record as { sensitivity?: unknown }).sensitivity;
      if (!peopleReleased(ctx, entry.id, id, sensitivity)) return undefined;
      return { entry, dir, record: found.record };
    }
    return { entry, dir, action: found.action };
  };
  if (!("error" in parsed)) {
    if (parsed.kind !== "decision") throw MISSING();
    const found = lookIn(entryOf(ctx.deps, parsed.scope), parsed.id);
    if (found === undefined) throw MISSING();
    return found;
  }
  const hint = ctx.query["harness"];
  if (hint !== undefined) {
    const found = lookIn(entryOf(ctx.deps, hint), raw);
    if (found === undefined) throw MISSING();
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

/** The located decision as the API serves it, with who decided it. */
function viewOf(
  ctx: V1Context,
  located: Located,
  who: DecidedByReader,
  record?: PendingApproval | ActionDecisionRow,
): Record<string, unknown> {
  const now = ctx.deps.now();
  const { entry, dir } = located;
  if (located.action !== undefined) {
    const row = (record as ActionDecisionRow | undefined) ?? located.action;
    return actionDecisionView(row, entry.id, now, who.textOf(entry, dir, row));
  }
  const row = (record as PendingApproval | undefined) ?? located.record;
  return decisionView(
    row,
    entry.id,
    ctx.access.canReadContent(entry.id),
    now,
    who.textOf(entry, dir, row as never),
  );
}

/** The caller as the decision service judges them. */
export function actorOf(ctx: V1Context): DecisionActor {
  const caller = ctx.access.caller;
  return {
    kind: "principal",
    principal: caller.principal,
    ...(caller.via === "service" ? { service: true as const } : {}),
    display: caller.principal,
  };
}

/** The harness's session root when it lies inside the harness, else `undefined`. */
function sessionRootOf(dir: string): string | undefined {
  return containedSessionRoot(dir, readHarnessEnvFiles(dir).vars);
}

/** A decision in a sessions folder outside its harness: nothing is decided, and it answers 404. */
const UNREACHABLE: Settled = { outcome: "not-found", record: null };

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
  const wanted = ctx.query["state"];
  if (wanted !== undefined && wanted !== "pending") {
    throw new V1Error({
      status: 400,
      code: "invalid",
      reason: "state",
      message: "state is pending, or left out for every state.",
    });
  }
  const now = ctx.deps.now();
  const who = decidedByReader(ctx);
  // One harness when the query names one the caller may read; a harness the caller may not
  // read answers as one with nothing pending, never a refusal that says it exists.
  const hint = ctx.query["harness"];
  const named = hint === undefined ? undefined : entryOf(ctx.deps, hint);
  const harnesses = visibleHarnesses(ctx.deps).filter(
    (entry) => hint === undefined || entry.id === named?.id,
  );
  const rows: Record<string, unknown>[] = [];
  const cut: string[] = [];
  const unreachable: string[] = [];
  let withheld = false;
  for (const entry of harnesses) {
    const dir = liveDirOf(entry);
    if (dir === undefined) continue;
    const folded = foldApprovals(dir);
    if (folded.truncated) cut.push(entry.id);
    if (folded.unreachable === true) unreachable.push(entry.id);
    const content = ctx.access.canReadContent(entry.id);
    for (const record of folded.approvals) {
      const sensitivity = (record as { sensitivity?: unknown }).sensitivity;
      if (!peopleReleased(ctx, entry.id, record.id, sensitivity)) {
        withheld = true;
        continue;
      }
      rows.push(
        decisionView(record, entry.id, content, now, who.textOf(entry, dir, record as never)),
      );
    }
    const actions = readActionDecisions(dir);
    if (actions.state === "present") {
      for (const row of actions.rows) {
        rows.push(actionDecisionView(row, entry.id, now, who.textOf(entry, dir, row)));
      }
    }
  }
  // Only what waits, when asked, before the page is cut: an older request is never lost
  // behind newer settled ones.
  const kept = wanted === undefined ? rows : rows.filter((row) => row["state"] === wanted);
  kept.sort((a, b) => (String(a["createdAt"]) < String(b["createdAt"]) ? 1 : -1));
  const items = kept.slice(0, limit);
  const read = ctx.deps.home.signIn.snapshot();
  return {
    status: 200,
    body: {
      items,
      snapshotAt: fleetSnapshot(read.state === "present" ? read.snapshot.epoch : 0),
      ...(kept.length > limit || cut.length > 0
        ? {
            truncated: {
              reason: kept.length > limit ? "page_limit" : "harness_capped",
              verb: "crewhaus approvals list",
            },
          }
        : {}),
      // The harnesses whose approvals were capped, by id, so a short list names them.
      ...(cut.length > 0 ? { truncatedHarnesses: cut } : {}),
      // Named whether or not anything is listed, so a short list never reads as complete.
      ...(unreachable.length > 0 ? { unreachable } : {}),
      ...(withheld ? { hidden: [PEOPLE_SENSITIVITY] } : {}),
      ...(items.length === 0
        ? {
            empty:
              unreachable.length > 0
                ? {
                    reason: "unreachable",
                    remedy:
                      "A harness keeps its sessions folder outside its own folder, so Home shows no decisions from it. Keep the sessions folder inside the harness folder.",
                  }
                : { reason: "no-data", remedy: "Nothing is waiting for a decision." },
          }
        : {}),
    },
  };
};

const get: V1Handler = async (ctx) => {
  const located = locate(ctx);
  return {
    status: 200,
    body: viewOf(ctx, located, decidedByReader(ctx)),
    scrubDir: located.dir,
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
    case "unsynced":
      return rejected("conflict");
    default:
      return rejected("already_decided");
  }
}

/** A refused decision, in the API's words; the receipt that recorded it rides along. */
function refusalOf(
  outcome: string,
  located: Located,
  answer: Settled,
  receipt: unknown,
  who: DecidedByReader,
): V1Error {
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
    case "unsynced":
      return new V1Error({
        status: 409,
        code: "conflict",
        reason: "approvers_unsynced",
        message:
          "This harness's list of who may decide is not in place, so nothing is decided here until it is.",
        remedy: "Run `crewhaus access sync`, then decide again.",
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
    default: {
      const winner: PendingApproval | ActionDecisionRow | undefined =
        located.action !== undefined
          ? (answer.actionDecision ?? located.action)
          : (answer.winner ?? answer.record ?? located.record);
      const fields = winner as unknown as Readonly<Record<string, unknown>>;
      const text = who.textOf(located.entry, located.dir, winner as never);
      return new V1Error({
        status: 409,
        code: "already_decided",
        reason: "already_decided",
        message: "This request was already settled.",
        current: {
          state:
            located.action !== undefined
              ? actionDecisionState(winner as ActionDecisionRow, Date.now())
              : effectiveDecisionState(winner as never, null, Date.now()).state,
          ...(fields["decision"] !== undefined ? { decision: fields["decision"] } : {}),
          ...(fields["decidedAt"] !== undefined ? { decidedAt: fields["decidedAt"] } : {}),
          ...(fields["decidedVia"] !== undefined
            ? { surface: viaOf(fields["decidedVia"])["decidedVia"] }
            : {}),
          ...(fields["supersededBy"] !== undefined ? { supersededBy: fields["supersededBy"] } : {}),
          ...(text !== undefined ? { decidedByText: text } : {}),
        },
        details,
      });
    }
  }
}

/**
 * Whether the harness's own list of who may decide stands where Home's access records say
 * it must: a harness Home governs is decided only while its list is present, read fresh,
 * so nothing it holds or lacks lets a request be decided as if one person owned it.
 */
function approversHeld(ctx: V1Context, located: Located): boolean {
  let governed = false;
  try {
    const read = ctx.deps.home.signIn.snapshot();
    governed =
      read.state === "present" && read.snapshot.governed.some((row) => row.id === located.entry.id);
  } catch {
    return false;
  }
  return !governed || createApproverReader()(located.dir).state === "present";
}

/** A decision on a governed harness whose list of who may decide is not in place. */
const UNSYNCED: Settled = { outcome: "unsynced", record: null };

type Settled = {
  readonly outcome: string;
  readonly record: PendingApproval | null;
  readonly reason?: string;
  readonly winner?: PendingApproval;
  /** The merge or rollout decision as it now stands. */
  readonly actionDecision?: ActionDecisionRow;
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
      target: `${located.entry.id}/decision/${idOf(located)}`,
      ledger: { harness: located.dir },
      effect: async () => {
        const answer = approversHeld(ctx, located) ? await run(ctx, located) : UNSYNCED;
        return { settle: settleOf(answer.outcome), value: answer };
      },
    });
    const answer = submitted.value;
    const who = decidedByReader(ctx);
    if (answer !== undefined && settleOf(answer.outcome).state !== "succeeded") {
      throw refusalOf(answer.outcome, located, answer, submitted.receipt, who);
    }
    const now =
      located.action !== undefined
        ? (answer?.actionDecision ?? located.action)
        : (answer?.record ?? located.record);
    return acceptedAnswer(
      submitted,
      {
        decision: viewOf(ctx, located, who, now),
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
  const state =
    located.action !== undefined
      ? actionDecisionState(located.action, ctx.deps.now())
      : effectiveDecisionState(located.record as never, null, ctx.deps.now()).state;
  const digest = located.record?.bindingDigest;
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

const resolve = decisionCommand(async (ctx, located) => {
  // A merge or rollout decision is kept in the harness's own records, not beside its sessions.
  const rootDir =
    sessionRootOf(located.dir) ?? (located.action !== undefined ? located.dir : undefined);
  if (rootDir === undefined) return UNREACHABLE;
  return ctx.deps.control.decisions.resolve({
    harnessDir: located.dir,
    rootDir,
    ref: idOf(located),
    choice: ctx.body["choice"] === "grant" ? "grant" : "deny",
    actor: actorOf(ctx),
    via: ctx.via,
    ttlDays: MAX_TTL,
  });
}, checkExpect);

/** A merge or rollout decision is granted or denied: refused before a receipt is written. */
function grantOrDenyOnly(_ctx: V1Context, located: Located): void {
  if (located.action === undefined) return;
  throw new V1Error({
    status: 422,
    code: "invalid",
    reason: "grant_or_deny",
    message: "A merge or rollout decision is granted or denied; it is not deferred or superseded.",
  });
}

const supersede = decisionCommand(async (ctx, located) => {
  const rootDir = sessionRootOf(located.dir);
  if (rootDir === undefined) return UNREACHABLE;
  return ctx.deps.control.decisions.supersede({
    harnessDir: located.dir,
    rootDir,
    ref: idOf(located),
    reason: String(ctx.body["reason"]),
    actor: actorOf(ctx),
    via: ctx.via,
  });
}, grantOrDenyOnly);

const defer = decisionCommand(
  async (ctx, located) => {
    const rootDir = sessionRootOf(located.dir);
    if (rootDir === undefined) return UNREACHABLE;
    return ctx.deps.control.decisions.defer({
      harnessDir: located.dir,
      rootDir,
      ref: idOf(located),
      until: String(ctx.body["until"]),
      reason: String(ctx.body["reason"]),
      actor: actorOf(ctx),
      via: ctx.via,
    });
  },
  (ctx, located) => {
    grantOrDenyOnly(ctx, located);
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
