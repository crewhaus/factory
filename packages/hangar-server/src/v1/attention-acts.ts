/**
 * Acting on an inbox item through the API (#517, #513): each operation names the harness in
 * its path, so the router checks its permission there, and the item it acts on must be one
 * about that harness that the caller may see. An act is planned by reading only
 * (`@crewhaus/attention/act`); one that is refused writes nothing, and one that runs runs
 * under its own receipt, through the source's own writer.
 *
 * Home lends the act layer what only it has: the claimed review path its own screen uses,
 * and jobs (an Advisor finding's own closed job, a graph run's resume, an approved version's
 * move), each from a closed vocabulary, carrying the command's receipt and re-checked for
 * the permissions it needed when it starts.
 */
import { idOfItem, readAdvisorSnapshot } from "@crewhaus/attention";
import {
  type ActAnswer,
  type ActDeps,
  type ActPlan,
  type ActRefusal,
  type ActRequest,
  type StartAnswer,
  listMessages,
  planAcknowledge,
  planAssign,
  planDefer,
  planDismiss,
  planMessage,
  planReopen,
  planResolve,
  planSnooze,
  planUnassign,
  planUndefer,
} from "@crewhaus/attention/act";
import {
  ATTENTION_ID_RE,
  type AttentionActionEvent,
  type AttentionItem,
  type DeferReason,
  type DeployQuorumSubject,
  type DismissReason,
  ERROR_CODES,
  attentionRef,
  isId,
} from "@crewhaus/control-contract";
import { intakeRefusal, outcomeOf, runBundleRefusal } from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { RUNS_RESUME_JOB_KIND, runsResumeArgv } from "@crewhaus/harness-supervisor/job-kinds";
import { permissionMessage } from "../access";
import { ADVISOR_JOB_ARGV, ADVISOR_JOB_PERMISSIONS } from "../advisor";
import { adjudicateReview } from "../review";
import type { V1Context, V1Handler } from "./context";
import { actorOf } from "./decisions";
import { V1Error } from "./errors";
import { entryOf, harnessOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, replayedCommand, submitCommand } from "./submit";

/** The item a request names, as the caller may see it; 404 when there is none. */
export type ItemFinder = (ctx: V1Context, raw: string) => Promise<{ readonly item: AttentionItem }>;

type Found = {
  readonly entry: HangarHarnessEntry;
  readonly dir: string;
  readonly item: AttentionItem;
};

const MISSING = (): V1Error =>
  new V1Error({
    status: 404,
    code: "not_found",
    reason: "attention_unknown",
    message: "No item has that ref here.",
  });

/** A refused act as the API's error. */
function errorOf(refusal: ActRefusal, receipt?: unknown): V1Error {
  return new V1Error({
    status: ERROR_CODES[refusal.code].statuses[0] as number,
    code: refusal.code,
    reason: refusal.reason,
    message: refusal.message,
    ...(refusal.current !== undefined ? { current: refusal.current } : {}),
    ...(refusal.verb !== undefined ? { verb: refusal.verb } : {}),
    ...(refusal.needs !== undefined ? { needs: refusal.needs } : {}),
    ...(receipt !== undefined ? { details: { receipt } } : {}),
  });
}

/** The caller, checked for a permission a choice needs beyond the operation's own. */
function requireOn(ctx: V1Context, permission: string, harness: string): void {
  const verdict = ctx.access.authorize(permission, { harness });
  if (verdict.allow) return;
  throw new V1Error({
    status: 403,
    code: "forbidden",
    reason: "permission",
    message: permissionMessage(permission, "harness"),
    needs: permission,
    role: verdict.role,
  });
}

/** The Advisor finding an item is, as Home last gathered it, with its closed job. */
function advisorJobOf(ctx: V1Context, entry: HangarHarnessEntry, itemId: string) {
  const finding = readAdvisorSnapshot(ctx.deps.hangarRoot, entry.id)?.items.find(
    (f) => f.id === itemId && f.status === "open",
  );
  const kind = finding?.action?.kind === "job" ? finding.action.jobKind : null;
  const argv = kind === null ? undefined : ADVISOR_JOB_ARGV[kind];
  if (kind === null || argv === undefined) return undefined;
  return { kind, argv, permission: ADVISOR_JOB_PERMISSIONS[kind] ?? "h.job.run" };
}

/** The permission a choice needs beyond deciding, when it does something more. */
function extraPermission(ctx: V1Context, found: Found, choice: string): string | undefined {
  if (choice === "promote") return "h.deploy";
  if (choice === "act" && found.item.source.kind === "advisor") {
    return advisorJobOf(ctx, found.entry, found.item.source.id)?.permission;
  }
  return undefined;
}

/** The closed command an approved version's move is, run in the harness's folder. */
function moveArgv(subject: DeployQuorumSubject): { kind: string; argv: string[] } {
  return isId("dep", subject.version)
    ? {
        kind: "deploy-activate",
        argv: ["deploy", "activate", subject.version, "--environment", subject.environment],
      }
    : {
        kind: "spec-pin",
        argv: ["spec", "pin", subject.spec, subject.environment, subject.version],
      };
}

/** Queue one closed job for an act, carrying the command's receipt. */
function queue(
  ctx: V1Context,
  entry: HangarHarnessEntry,
  job: {
    readonly kind: string;
    readonly argv: readonly string[];
    readonly needs: readonly string[];
  },
  cmd: string | undefined,
): StartAnswer {
  const submit = ctx.deps.submitItemJob;
  // Who the job acts for is who the command's receipt names.
  const by =
    cmd === undefined
      ? undefined
      : ctx.deps.control.commands.get({ harness: entry.dir }, cmd)?.actor;
  if (submit === undefined || cmd === undefined || by === undefined) {
    return {
      ok: false,
      code: "unavailable",
      reason: "no_jobs",
      message: "This Home starts no jobs, so nothing was started.",
    };
  }
  try {
    const record = submit(entry, job, { commandId: cmd, by });
    return { ok: true, job: record.jobId, detail: "It is queued." };
  } catch (err) {
    return {
      ok: false,
      code: "conflict",
      reason: "job_refused",
      message: `The job could not be queued: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The names of the members an answer mentions by id, as Home's sign-in records hold them:
 * only those the answer already names, and only members (a local actor has no name here).
 */
export function peopleOf(
  ctx: V1Context,
  ids: Iterable<string | undefined>,
): Array<{ id: string; name: string }> {
  const read = ctx.deps.home.signIn.snapshot();
  if (read.state !== "present") return [];
  const principals = read.snapshot.subjects.principals;
  const wanted = [...new Set(ids)].filter(
    (id): id is string => typeof id === "string" && isId("prn", id),
  );
  return wanted.sort().flatMap((id) => {
    const name = Object.hasOwn(principals, id) ? principals[id]?.displayName : undefined;
    return typeof name === "string" && name !== "" ? [{ id, name }] : [];
  });
}

/** The name the approvals file shows for the caller: a member's own, else their id. */
function displayOf(ctx: V1Context): string {
  const read = ctx.deps.home.signIn.snapshot();
  const principal = ctx.access.caller.principal;
  const named =
    read.state === "present"
      ? read.snapshot.subjects.principals[principal]?.displayName
      : undefined;
  return named ?? principal;
}

function depsOf(ctx: V1Context, entry: HangarHarnessEntry): ActDeps {
  return {
    decisions: ctx.deps.control.decisions,
    now: ctx.deps.now,
    displayOf: () => displayOf(ctx),
    members: {
      hangarRoot: ctx.deps.hangarRoot,
      harness: { id: entry.id, dir: entry.dir, groups: entry.groups },
    },
    reviewWriter: async (request) => {
      const answer = await adjudicateReview({
        harnessDir: request.dir,
        itemId: request.id,
        verdict: request.verdict,
        ...(request.note !== undefined ? { note: request.note } : {}),
        by: ctx.access.caller.principal,
        actor: { by: request.by, via: request.via },
        nowIso: request.nowIso,
      });
      return answer.outcome === "rejected"
        ? { outcome: "rejected", reason: answer.reason }
        : { outcome: answer.outcome };
    },
    advisorAct: async ({ itemId, cmd }) => {
      const job = advisorJobOf(ctx, entry, itemId);
      if (job === undefined) {
        return {
          ok: false,
          code: "conflict",
          reason: "finding_cleared",
          message: "This finding has no job any more. Reload the list.",
        };
      }
      return queue(ctx, entry, { kind: job.kind, argv: job.argv, needs: [job.permission] }, cmd);
    },
    resumeGraph: async ({ dir, grun, ckpt, decision, cmd }) => {
      const refused = intakeRefusal(dir) ?? runBundleRefusal(dir, "graph");
      if (refused !== undefined) {
        return {
          ok: false,
          code: refused.code,
          reason: refused.reason,
          message: refused.message,
          ...(refused.verb !== undefined ? { verb: refused.verb } : {}),
        };
      }
      const argv = runsResumeArgv(grun, ckpt, decision);
      return queue(ctx, entry, { kind: RUNS_RESUME_JOB_KIND, argv, needs: [] }, cmd);
    },
    promote: async ({ subject, cmd }) => {
      const move = moveArgv(subject);
      return queue(ctx, entry, { ...move, needs: ["h.deploy"] }, cmd);
    },
  };
}

/** How an act ends, as its receipt records it. A job it queued moves the receipt itself. */
function settlementOf(answer: ActAnswer) {
  if (!answer.ok) {
    return {
      settle: { state: "rejected" as const, outcome: outcomeOf(answer.code) },
      value: answer,
    };
  }
  return answer.job !== undefined
    ? { value: answer }
    : { settle: { state: "succeeded" as const }, value: answer };
}

/** Plan, submit and answer one act, replays first. */
async function carriedOut(
  ctx: V1Context,
  entry: HangarHarnessEntry,
  event: AttentionActionEvent,
  find: ItemFinder,
  plan: (found: Found, request: ActRequest, deps: ActDeps) => ActPlan,
) {
  const dir = liveDirOr409(entry);
  const raw = ctx.params["ref"] ?? "";
  const command = { target: `home/harness/${entry.id}`, ledger: { harness: dir } } as const;
  const answerOf = (ref: string, state: AttentionItem["state"], extra: object = {}) => ({
    ref,
    harness: entry.id,
    event,
    state,
    ...extra,
  });
  const replay = await replayedCommand(ctx, command);
  if (replay !== undefined) {
    const id = raw.slice(raw.lastIndexOf("/") + 1);
    // What it did is on its receipt; the item is shown as it stands now.
    let state: AttentionItem["state"] = "resolved";
    try {
      state = (await find(ctx, raw)).item.state;
    } catch (err) {
      if (!(err instanceof V1Error) || !ATTENTION_ID_RE.test(id)) throw err;
    }
    return acceptedAnswer(replay, answerOf(attentionRef(id), state), dir);
  }
  const { item } = await find(ctx, raw);
  // An item is acted on in a harness it is about; anywhere else it is an item nobody has.
  if (item.harness !== entry.id && !(item.harnesses ?? []).includes(entry.id)) throw MISSING();
  const found: Found = { entry, dir, item };
  const expect = ctx.body["expect"];
  const planned = plan(
    found,
    {
      dir,
      item,
      actor: actorOf(ctx),
      via: ctx.via,
      ...(typeof expect === "string" ? { expect } : {}),
    },
    depsOf(ctx, entry),
  );
  if (!planned.ok) throw errorOf(planned);
  const submitted = await submitCommand<ActAnswer>(ctx, {
    ...command,
    effect: async (receipt) => settlementOf(await planned.run(receipt.id)),
  });
  const answer = submitted.value;
  if (answer !== undefined && !answer.ok) throw errorOf(answer, submitted.receipt);
  return acceptedAnswer(
    submitted,
    answerOf(item.ref, answer?.state ?? item.state, {
      ...(answer?.detail !== undefined ? { detail: answer.detail } : {}),
      ...(answer?.job !== undefined ? { job: answer.job } : {}),
    }),
    dir,
  );
}

const text = (ctx: V1Context, name: string): string | undefined => {
  const value = ctx.body[name];
  return typeof value === "string" ? value : undefined;
};

/** The handlers of everything a person does about an item. */
export function attentionActHandlers(find: ItemFinder): Readonly<Record<string, V1Handler>> {
  const on =
    (
      event: AttentionActionEvent,
      plan: (ctx: V1Context, found: Found, request: ActRequest, deps: ActDeps) => ActPlan,
    ): V1Handler =>
    async (ctx) =>
      carriedOut(ctx, harnessOf(ctx), event, find, (found, request, deps) =>
        plan(ctx, found, request, deps),
      );
  const noteOf = (ctx: V1Context) => {
    const note = text(ctx, "note");
    return note !== undefined ? { note } : {};
  };
  return {
    "attention.resolve": on("resolved", (ctx, found, request, deps) => {
      const choice = text(ctx, "choice") ?? "";
      const planned = planResolve({ ...request, choice, ...noteOf(ctx) }, deps);
      const permission = planned.ok ? extraPermission(ctx, found, choice) : undefined;
      if (permission !== undefined) requireOn(ctx, permission, found.entry.id);
      return planned;
    }),
    "attention.assign": on("assigned", (ctx, _found, request, deps) =>
      planAssign({ ...request, to: text(ctx, "to") ?? "" }, deps),
    ),
    "attention.unassign": on("unassigned", (_ctx, _found, request, deps) =>
      planUnassign(request, deps),
    ),
    "attention.defer": on("deferred", (ctx, _found, request, deps) =>
      planDefer(
        { ...request, until: text(ctx, "until") ?? "", reason: text(ctx, "reason") as DeferReason },
        deps,
      ),
    ),
    "attention.undefer": on("undeferred", (_ctx, _found, request, deps) =>
      planUndefer(request, deps),
    ),
    "attention.snooze": async (ctx) => {
      const entry = entryOf(ctx.deps, text(ctx, "harness"));
      // The row's permission is the caller's own preferences: the harness is checked here.
      if (entry === undefined || !ctx.access.canRead(entry.id)) throw MISSING();
      return carriedOut(ctx, entry, "snoozed", find, (_found, request, deps) =>
        planSnooze({ ...request, until: text(ctx, "until") ?? "" }, deps),
      );
    },
    "attention.dismiss": on("dismissed", (ctx, _found, request, deps) =>
      planDismiss(
        { ...request, reasonCode: text(ctx, "reasonCode") as DismissReason, ...noteOf(ctx) },
        deps,
      ),
    ),
    "attention.reopen": on("reopened", (ctx, _found, request, deps) =>
      planReopen({ ...request, ...noteOf(ctx) }, deps),
    ),
    "attention.acknowledge": on("acknowledged", (ctx, _found, request, deps) =>
      planAcknowledge({ ...request, ...noteOf(ctx) }, deps),
    ),
    "attention.messages.add": on("message", (ctx, _found, request, deps) =>
      planMessage({ ...request, text: text(ctx, "text") ?? "" }, deps),
    ),
    "attention.messages.list": async (ctx) => {
      const entry = harnessOf(ctx);
      const dir = liveDirOr409(entry);
      const { item } = await find(ctx, ctx.params["ref"] ?? "");
      if (item.harness !== entry.id && !(item.harnesses ?? []).includes(entry.id)) throw MISSING();
      const thread = listMessages(dir, idOfItem(item));
      const people = peopleOf(
        ctx,
        thread.messages.map((m) => m.by),
      );
      return {
        status: 200,
        body: {
          ref: item.ref,
          items: thread.messages,
          ...(people.length > 0 ? { people } : {}),
          ...(thread.truncated
            ? {
                truncated: {
                  reason: "older_left_out",
                  verb: `crewhaus inbox show ${idOfItem(item)} --messages`,
                },
              }
            : {}),
          ...(thread.messages.length === 0
            ? { empty: { reason: "no-data", remedy: "No one has said anything here yet." } }
            : {}),
        },
        scrubDir: dir,
      };
    },
  };
}
