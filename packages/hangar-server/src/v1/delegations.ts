/**
 * Delegation rules through the API (#517, module brief 301's area slot): an owner's rule
 * that lets this harness decide one narrow kind of `ship` decision on its own. The reads
 * (`list`, `get`, `preview`) write nothing; every change is a receipted command whose
 * effect is the control service's own write. Turning a rule on, changing, resuming and
 * ending one are the owner's; a maintainer proposes and pauses. A chat surface never
 * turns a rule on, and the library refuses a service credential and a system actor.
 *
 * Home's minute sweep applies the rules of every live harness, under its own system
 * principal: it calls the control service's port directly, never a handler here.
 */
import { BOOTSTRAP_PRINCIPAL } from "@crewhaus/access-control";
import type { DelegationTermsRequest } from "@crewhaus/control-contract";
import {
  type DecisionActor,
  type DelegationHarness,
  type DelegationRefusal,
  type DelegationWrite,
  type Settlement,
  outcomeOf,
} from "@crewhaus/control-service";
import { slugOf } from "@crewhaus/harness-registry";
import type { Sweep } from "../scheduler-host";
import type { HomePorts } from "../sweeps";
import type { HomeAreaRuntime } from "./areas";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { fleetSnapshot } from "./lists";
import { harnessOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

/** The caller as the delegation service takes them. Home's own key acts as its owner. */
function actorOf(ctx: V1Context): DecisionActor {
  return ctx.access.caller.actor === null
    ? { kind: "principal", principal: BOOTSTRAP_PRINCIPAL }
    : { kind: "principal", principal: ctx.access.caller.principal };
}

function harnessFor(ctx: V1Context): DelegationHarness {
  const entry = harnessOf(ctx);
  return { dir: liveDirOr409(entry), id: entry.id, name: entry.slug ?? slugOf(entry.specName) };
}

const STATUS: Readonly<Record<DelegationRefusal["code"], readonly [number, string]>> = {
  forbidden: [403, "forbidden"],
  invalid: [422, "invalid"],
  unsupported: [501, "unsupported"],
  "not-allowed": [409, "conflict"],
  "precondition-failed": [412, "precondition_failed"],
  "not-found": [404, "not_found"],
  conflict: [409, "conflict"],
  "already-decided": [409, "already_decided"],
  unavailable: [503, "unavailable"],
};

const SETTLE: Readonly<Record<DelegationRefusal["code"], Settlement>> = {
  forbidden: { state: "rejected", outcome: outcomeOf("forbidden") },
  invalid: { state: "rejected", outcome: outcomeOf("invalid") },
  unsupported: { state: "rejected", outcome: outcomeOf("unsupported") },
  "not-allowed": { state: "rejected", outcome: outcomeOf("conflict") },
  "precondition-failed": { state: "rejected", outcome: outcomeOf("precondition_failed") },
  "not-found": { state: "rejected", outcome: outcomeOf("not_found") },
  conflict: { state: "rejected", outcome: outcomeOf("conflict") },
  "already-decided": { state: "rejected", outcome: outcomeOf("already_decided") },
  unavailable: { state: "failed", outcome: outcomeOf("unavailable") },
};

function refusalError(refusal: DelegationRefusal, extra: Record<string, unknown> = {}): V1Error {
  const [status, code] = STATUS[refusal.code];
  return new V1Error({
    status,
    code,
    reason:
      refusal.code === "forbidden" && refusal.needs === "h.standing-rule.manage"
        ? "owner_only"
        : refusal.code.replace(/-/g, "_"),
    message: refusal.reason,
    ...(refusal.needs !== undefined ? { needs: refusal.needs } : {}),
    details: {
      ...extra,
      ...(refusal.page !== undefined
        ? {
            page: refusal.page,
            ...(refusal.page.consequencesDigest !== undefined
              ? { consequencesDigest: refusal.page.consequencesDigest }
              : {}),
          }
        : {}),
    },
  });
}

/** A chat surface's buttons never turn a rule on, change, resume or end one. */
function notFromChat(ctx: V1Context): void {
  if (ctx.via === "slack") {
    throw new V1Error({
      status: 403,
      code: "forbidden",
      reason: "human_only",
      message: "Delegation rules are managed in Home or with the CLI, not from a chat.",
      verb: "crewhaus delegations list",
    });
  }
}

/** The owner's acts: refused before a receipt when the caller is not the owner. */
function ownerFirst(ctx: V1Context, harness: DelegationHarness): void {
  if (!ctx.deps.control.decisions.mayManageRules(harness.dir, actorOf(ctx))) {
    throw new V1Error({
      status: 403,
      code: "forbidden",
      reason: "owner_only",
      needs: "h.standing-rule.manage",
      message: "Only this harness's owner turns a delegation rule on, changes it or ends it.",
    });
  }
}

type WriteAnswer = DelegationWrite | DelegationRefusal;

/** Run one write as the operation's own receipted command, and answer its receipt. */
async function receipted(
  ctx: V1Context,
  harness: DelegationHarness,
  target: string,
  write: (cmd: string) => Promise<WriteAnswer>,
) {
  const submitted = await submitCommand<WriteAnswer>(ctx, {
    target,
    ledger: { harness: harness.dir },
    effect: async (receipt) => {
      const answer = await write(receipt.id);
      return {
        settle: answer.ok ? { state: "succeeded" } : SETTLE[answer.code],
        value: answer,
      };
    },
  });
  const answer = submitted.value;
  if (answer !== undefined && !answer.ok) {
    throw refusalError(answer, { receipt: submitted.receipt });
  }
  return acceptedAnswer(
    submitted,
    {
      ...(answer?.ok === true && answer.view !== undefined ? { rule: answer.view } : {}),
      ...(answer?.ok === true && answer.proposal !== undefined
        ? { proposal: answer.proposal }
        : {}),
    },
    harness.dir,
  );
}

const termsOf = (ctx: V1Context): DelegationTermsRequest | undefined =>
  ctx.body["terms"] as DelegationTermsRequest | undefined;

const list: V1Handler = async (ctx) => {
  const harness = harnessFor(ctx);
  const { unreadable, ...listing } = ctx.deps.control.delegations.list(harness);
  const holds = (permission: string) =>
    ctx.access.authorize(permission, { harness: harness.id }).allow;
  const actor = actorOf(ctx);
  // What the screen offers: what Home's access allows and the library would accept.
  const you = {
    manage:
      holds("h.standing-rule.manage") &&
      ctx.deps.control.decisions.mayManageRules(harness.dir, actor),
    propose: holds("h.delegation.propose"),
    suspend: holds("h.delegation.suspend"),
  };
  return {
    status: 200,
    body: {
      ...listing,
      you,
      snapshotAt: fleetSnapshot(0),
      ...(unreadable.length > 0 && listing.truncated === undefined
        ? {
            truncated: {
              reason: unreadable[0] as string,
              verb: `crewhaus delegations list --harness ${harness.id}`,
            },
          }
        : {}),
    },
    scrubDir: harness.dir,
  };
};

const get: V1Handler = async (ctx) => {
  const harness = harnessFor(ctx);
  const answer = ctx.deps.control.delegations.get(harness, String(ctx.params["rule"]));
  if (!answer.ok) throw refusalError(answer);
  return { status: 200, body: answer.detail, scrubDir: harness.dir };
};

const preview: V1Handler = async (ctx) => {
  const harness = harnessFor(ctx);
  const rule = ctx.body["rule"];
  const terms = termsOf(ctx);
  const answer =
    typeof rule === "string"
      ? await ctx.deps.control.delegations.previewRule(harness, {
          rule,
          mode: ctx.body["mode"] === "resume" ? "resume" : "change",
          ...(terms !== undefined ? { terms } : {}),
        })
      : await ctx.deps.control.delegations.preview(harness, {
          action: ctx.body["action"] as never,
          ...(terms !== undefined ? { terms } : {}),
        });
  if (!answer.ok) throw refusalError(answer);
  return { status: 200, body: answer.page, scrubDir: harness.dir };
};

const enable: V1Handler = async (ctx) => {
  notFromChat(ctx);
  const harness = harnessFor(ctx);
  ownerFirst(ctx, harness);
  return receipted(ctx, harness, `home/harness/${harness.id}`, (cmd) =>
    ctx.deps.control.delegations.enable(harness, {
      action: ctx.body["action"] as never,
      ...(termsOf(ctx) !== undefined ? { terms: termsOf(ctx) as DelegationTermsRequest } : {}),
      consequencesDigest: String(ctx.body["consequencesDigest"]),
      confirm: String(ctx.body["confirm"]),
      ...(typeof ctx.body["proposal"] === "string" ? { proposal: ctx.body["proposal"] } : {}),
      actor: actorOf(ctx),
      cmd,
    }),
  );
};

const propose: V1Handler = async (ctx) => {
  notFromChat(ctx);
  const harness = harnessFor(ctx);
  return receipted(ctx, harness, `home/harness/${harness.id}`, (cmd) =>
    ctx.deps.control.delegations.propose(harness, {
      action: ctx.body["action"] as never,
      ...(termsOf(ctx) !== undefined ? { terms: termsOf(ctx) as DelegationTermsRequest } : {}),
      actor: actorOf(ctx),
      cmd,
    }),
  );
};

const update: V1Handler = async (ctx) => {
  notFromChat(ctx);
  const harness = harnessFor(ctx);
  ownerFirst(ctx, harness);
  const rule = String(ctx.params["rule"]);
  return receipted(ctx, harness, `${harness.id}/rule/${rule}`, (cmd) =>
    ctx.deps.control.delegations.update(harness, {
      rule,
      expect: Number(ctx.body["expect"]),
      ...(termsOf(ctx) !== undefined ? { terms: termsOf(ctx) as DelegationTermsRequest } : {}),
      consequencesDigest: String(ctx.body["consequencesDigest"]),
      confirm: String(ctx.body["confirm"]),
      actor: actorOf(ctx),
      cmd,
    }),
  );
};

const resume: V1Handler = async (ctx) => {
  notFromChat(ctx);
  const harness = harnessFor(ctx);
  ownerFirst(ctx, harness);
  const rule = String(ctx.params["rule"]);
  return receipted(ctx, harness, `${harness.id}/rule/${rule}`, (cmd) =>
    ctx.deps.control.delegations.resume(harness, {
      rule,
      expect: Number(ctx.body["expect"]),
      consequencesDigest: String(ctx.body["consequencesDigest"]),
      confirm: String(ctx.body["confirm"]),
      actor: actorOf(ctx),
      cmd,
    }),
  );
};

const revoke: V1Handler = async (ctx) => {
  notFromChat(ctx);
  const harness = harnessFor(ctx);
  ownerFirst(ctx, harness);
  const rule = String(ctx.params["rule"]);
  const expect = ctx.body["expect"];
  return receipted(ctx, harness, `${harness.id}/rule/${rule}`, (cmd) =>
    ctx.deps.control.delegations.revoke(harness, {
      rule,
      ...(typeof expect === "number" ? { expect } : {}),
      actor: actorOf(ctx),
      cmd,
    }),
  );
};

const pause: V1Handler = async (ctx) => {
  const harness = harnessFor(ctx);
  const rule = String(ctx.params["rule"]);
  return receipted(ctx, harness, `${harness.id}/rule/${rule}`, (cmd) =>
    ctx.deps.control.delegations.pause(harness, {
      rule,
      reason: "paused-by-member",
      actor: actorOf(ctx),
      cmd,
    }),
  );
};

const keep: V1Handler = async (ctx) => {
  const harness = harnessFor(ctx);
  const watch = String(ctx.params["cmd"]);
  return receipted(ctx, harness, `${harness.id}/cmd/${watch}`, (cmd) =>
    ctx.deps.control.delegations.keepWatch(harness, { watch, actor: actorOf(ctx), cmd }),
  );
};

const apply: V1Handler = async (ctx) => {
  const harness = harnessFor(ctx);
  const appliedBy = await ctx.deps.control.decisions.storedActorOf(harness.dir, actorOf(ctx));
  const submitted = await submitCommand(ctx, {
    target: `home/harness/${harness.id}`,
    ledger: { harness: harness.dir },
    effect: async (receipt) => {
      const value = await ctx.deps.control.delegations.apply(harness, {
        appliedBy,
        cmd: receipt.id,
      });
      return { settle: { state: "succeeded" }, value };
    },
  });
  return acceptedAnswer(submitted, {}, harness.dir);
};

/** Home's minute sweep: one pass over every live harness, as the scheduler. */
export const DELEGATIONS_SWEEP: Sweep<HomePorts> = {
  name: "delegations",
  everyMs: 60_000,
  run: async ({ home, warn }) => {
    for (const harness of home.liveHarnesses()) {
      try {
        await home.delegations.apply(
          { dir: harness.dir, id: harness.id },
          // The sweep's own principal is no actor a record names: the scheduler is.
          { appliedBy: "sys:scheduler" },
        );
      } catch (err) {
        warn(
          `the delegation rules of ${harness.id} were not applied: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  },
};

export const DELEGATION_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "delegations.list": list,
  "delegations.get": get,
  "delegations.preview": preview,
  "delegations.enable": enable,
  "delegations.propose": propose,
  "delegations.update": update,
  "delegations.resume": resume,
  "delegations.revoke": revoke,
  "delegations.pause": pause,
  "delegations.apply": apply,
  "delegations.watches.keep": keep,
};

/** The delegation area's slot in Home. */
export const HOME_DELEGATION: HomeAreaRuntime = {
  area: "delegation",
  sweeps: [DELEGATIONS_SWEEP],
  handlers: DELEGATION_HANDLERS,
};
