/**
 * Access through the API: who has access, invites, grants, tokens, links and devices, and
 * the changes to them, each a workspace command. Only someone who manages access sees
 * everyone's; anyone signed in sees and ends their own tokens, links and devices. A secret
 * leaves only sealed to the key the request carried. A scoped token is minted only by a
 * service, only for runs that exist in the harness each ref names.
 */
import {
  type AccessHandle,
  type AccessSnapshot,
  foldSignIn,
  listDevices,
  listGrants,
  listInvites,
  listLinks,
  listMembers,
  listTokens,
  mintScopedToken,
  openAccess,
  readUsage,
  revokeOwnToken,
  sealSecret,
  unlinkOwn,
} from "@crewhaus/access-control";
import { type ErrorCode, parseRef } from "@crewhaus/control-contract";
import { foldStates, runsLedger } from "@crewhaus/control-records";
import { outcomeOf } from "@crewhaus/control-service";
import { readRunLedger } from "@crewhaus/harness-supervisor";
import { PERSONAL_SELF_MESSAGE } from "../access";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { fleetSnapshot } from "./lists";
import { entryOf, liveDirOf } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

type Seal = { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string };

type Refusal = { readonly ok: false; readonly code: string; readonly reason: string };

function refusalError(refusal: Refusal, receipt?: unknown): V1Error {
  const map: Readonly<Record<string, readonly [number, string]>> = {
    "not-authorized": [403, "forbidden"],
    "not-found": [404, "not_found"],
    invalid: [422, "invalid"],
    "too-large": [422, "invalid"],
    ended: [409, "conflict"],
    conflict: [409, "conflict"],
    lockout: [409, "conflict"],
    "home-owner": [409, "conflict"],
  };
  const [status, code] = map[refusal.code] ?? [503, "unavailable"];
  return new V1Error({
    status,
    code,
    reason: refusal.code,
    message: refusal.reason,
    ...(receipt !== undefined ? { details: { receipt } } : {}),
  });
}

function settleOf(done: { readonly ok: boolean; readonly code?: string }) {
  if (done.ok) return { state: "succeeded" as const };
  const code =
    done.code === "not-authorized"
      ? "forbidden"
      : done.code === "not-found"
        ? "not_found"
        : done.code === "invalid" || done.code === "too-large"
          ? "invalid"
          : done.code === "unreadable" || done.code === "io-error" || done.code === "not-set-up"
            ? "unavailable"
            : "conflict";
  return { state: "rejected" as const, outcome: outcomeOf(code as ErrorCode) };
}

function handleOf(ctx: V1Context): AccessHandle {
  return openAccess(ctx.deps.hangarRoot, {
    now: ctx.deps.now,
    harnesses: () =>
      ctx.deps.registry
        .list()
        .map((entry) => ({ id: entry.id, dir: entry.dir, groups: entry.groups })),
  });
}

function snapshotOf(ctx: V1Context): AccessSnapshot {
  const read = ctx.deps.home.signIn.snapshot();
  if (read.state !== "present") {
    throw new V1Error({
      status: 503,
      code: "unavailable",
      reason: read.state === "absent" ? "access_not_set_up" : "access_unreadable",
      message:
        read.state === "absent"
          ? "Nobody else has access to this Home yet."
          : "Home's access records cannot be read. Run `crewhaus access members` on this computer to see why.",
    });
  }
  return read.snapshot;
}

/** The caller as the access library's actor: a member, or a service by the token it used. */
function actorOf(ctx: V1Context) {
  const caller = ctx.access.caller;
  if (caller.actor !== null) return caller.actor;
  const owner = ctx.deps.home.signIn.snapshot();
  return {
    principal:
      owner.state === "present" ? (owner.snapshot.owner ?? caller.principal) : caller.principal,
  };
}

function manages(ctx: V1Context): boolean {
  return ctx.access.authorize("home.access.manage").allow;
}

function page<T>(ctx: V1Context, items: readonly T[], epoch: number, remedy: string) {
  const limit = ctx.query["limit"] === undefined ? 50 : Number(ctx.query["limit"]);
  const out = items.slice(0, limit);
  return {
    status: 200,
    body: {
      items: out,
      snapshotAt: fleetSnapshot(epoch),
      ...(items.length > limit
        ? { truncated: { reason: "page_limit", verb: "crewhaus access members" } }
        : {}),
      ...(out.length === 0 ? { empty: { reason: "no-data", remedy } } : {}),
    },
  };
}

const membersList: V1Handler = async (ctx) => {
  const snapshot = snapshotOf(ctx);
  const items = listMembers(snapshot, ctx.deps.now()).map((m) => ({
    id: m.id,
    kind: m.kind,
    ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
    createdAt: m.createdAt,
    homeOwner: m.homeOwner,
  }));
  return page(
    ctx,
    items,
    snapshot.epoch,
    "Invite someone with `crewhaus access invite --role viewer --home`.",
  );
};

const invitesList: V1Handler = async (ctx) => {
  const snapshot = snapshotOf(ctx);
  const items = listInvites(snapshot, ctx.deps.now()).map((i) => ({
    id: i.id,
    role: i.role,
    scope: i.scope,
    createdBy: i.createdBy,
    expiresAt: i.expiresAt,
    ...(i.consumedAt !== undefined ? { consumedAt: i.consumedAt } : {}),
    ...(i.revokedAt !== undefined ? { revokedAt: i.revokedAt } : {}),
    live: i.live,
  }));
  return page(
    ctx,
    items,
    snapshot.epoch,
    "Invite someone with `crewhaus access invite --role viewer --home`.",
  );
};

const grantsList: V1Handler = async (ctx) => {
  const snapshot = snapshotOf(ctx);
  const items = listGrants(snapshot, ctx.deps.now()).map((g) => ({
    id: g.id,
    principal: g.principal,
    role: g.role,
    scope: g.scope,
    grantedBy: g.grantedBy,
    ...(g.expiresAt !== undefined ? { expiresAt: g.expiresAt } : {}),
    ...(g.revokedAt !== undefined ? { revokedAt: g.revokedAt } : {}),
    live: g.live,
  }));
  return page(
    ctx,
    items,
    snapshot.epoch,
    "Give someone a role with `crewhaus access grant --member <name> --role viewer --home`.",
  );
};

const tokensList: V1Handler = async (ctx) => {
  const snapshot = snapshotOf(ctx);
  const mine = !manages(ctx);
  const items = listTokens(snapshot, ctx.deps.now(), readUsage(ctx.deps.hangarRoot))
    .filter((t) => !mine || t.principal === ctx.access.caller.principal)
    .map((t) => ({
      id: t.id,
      principal: t.principal,
      kind: t.kind,
      ...(t.prefixHint !== undefined ? { prefixHint: t.prefixHint } : {}),
      ...(t.permissions !== undefined ? { permissions: t.permissions } : {}),
      ...(t.harnesses !== undefined ? { harnesses: t.harnesses } : {}),
      ...(t.readOnly === true ? { readOnly: true } : {}),
      ...(t.lastUsedAt !== undefined ? { lastUsedAt: t.lastUsedAt } : {}),
      ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
      ...(t.revokedAt !== undefined ? { revokedAt: t.revokedAt } : {}),
      live: t.live,
    }));
  return page(
    ctx,
    items,
    snapshot.epoch,
    "Sign in from another computer with `crewhaus login --server <url>`.",
  );
};

const linksList: V1Handler = async (ctx) => {
  const snapshot = snapshotOf(ctx);
  const mine = !manages(ctx);
  const items = listLinks(snapshot).filter(
    (l) => !mine || l.principal === ctx.access.caller.principal,
  );
  return page(
    ctx,
    items,
    snapshot.epoch,
    "Link an outside account with `crewhaus access link <account> --member <name>`.",
  );
};

const devicesList: V1Handler = async (ctx) => {
  const snapshot = snapshotOf(ctx);
  const mine = !manages(ctx);
  const fold = foldSignIn(ctx.deps.hangarRoot);
  const devices = fold.ok ? [...fold.devices.values()] : [];
  const items = listDevices(devices, readUsage(ctx.deps.hangarRoot)).filter(
    (d) => !mine || d.principal === ctx.access.caller.principal,
  );
  return page(ctx, items, snapshot.epoch, "A browser that signs in to Home is listed here.");
};

/** A workspace command that runs one access change; its refusal becomes the answer. */
async function accessCommand<T>(
  ctx: V1Context,
  change: () => Promise<{ readonly ok: true; readonly result: T } | Refusal>,
  target?: string,
) {
  const submitted = await submitCommand<{ readonly ok: true; readonly result: T } | Refusal>(ctx, {
    ...(target !== undefined ? { target } : {}),
    ledger: "workspace",
    effect: async () => {
      const done = await change();
      return { settle: settleOf(done), value: done };
    },
  });
  const done = submitted.value;
  if (done !== undefined && !done.ok) throw refusalError(done, submitted.receipt);
  return { submitted, result: done?.ok === true ? done.result : undefined };
}

const invitesCreate: V1Handler = async (ctx) => {
  const access = handleOf(ctx);
  const expires = ctx.body["expiresAt"];
  const ttlMs = typeof expires === "string" ? Date.parse(expires) - ctx.deps.now() : undefined;
  const { submitted, result } = await accessCommand(ctx, () =>
    access.createInvite(actorOf(ctx), {
      role: String(ctx.body["role"]),
      scope: String(ctx.body["scope"]),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    }),
  );
  if (result === undefined) return acceptedAnswer(submitted);
  return {
    status: 200,
    body: {
      invite: {
        id: result.invite.id,
        role: result.invite.role,
        scope: result.invite.scope,
        createdBy: result.invite.createdBy,
        expiresAt: result.invite.expiresAt,
      },
      issued: await sealSecret(ctx.body["seal"] as Seal, result.code, "access.invites.create"),
      receipt: submitted.receipt,
    },
  };
};

const grantsCreate: V1Handler = async (ctx) => {
  const access = handleOf(ctx);
  const principal = String(ctx.body["principal"]);
  const { submitted, result } = await accessCommand(
    ctx,
    () =>
      access.grant(actorOf(ctx), {
        member: principal,
        role: String(ctx.body["role"]),
        scope: String(ctx.body["scope"]),
        ...(typeof ctx.body["expiresAt"] === "string" ? { expiresAt: ctx.body["expiresAt"] } : {}),
      }),
    `home/principal/${principal}`,
  );
  return acceptedAnswer(submitted, result !== undefined ? { grant: result.grant } : {});
};

const tokensMint: V1Handler = async (ctx) => {
  const access = handleOf(ctx);
  const principal = String(ctx.body["principal"]);
  // A token is minted for a service by its id; the access library names a service by name.
  const snapshot = snapshotOf(ctx);
  const named = snapshot.principals.find((p) => p.id === principal);
  const name = snapshot.subjects.principals[principal]?.displayName;
  if (
    named === undefined ||
    named.state !== "active" ||
    named.kind !== "service" ||
    name === undefined
  ) {
    throw new V1Error({
      status: 422,
      code: "invalid",
      reason: "principal",
      message:
        "A token is minted for a service this Home has. Make one with `crewhaus access mint --service <name> --permission h.read`.",
    });
  }
  const expires = ctx.body["expiresAt"];
  const ttlMs = typeof expires === "string" ? Date.parse(expires) - ctx.deps.now() : undefined;
  const { submitted, result } = await accessCommand(
    ctx,
    () =>
      access.mintServiceToken(actorOf(ctx), {
        service: name,
        permissions: (ctx.body["permissions"] as string[] | undefined) ?? [],
        harnesses: (ctx.body["harnesses"] as string[] | undefined) ?? [],
        ...(ctx.body["contentRead"] === true ? { contentRead: true } : {}),
        ...(ctx.body["subjectAssert"] === true ? { subjectAssert: true } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      }),
    `home/principal/${principal}`,
  );
  if (result === undefined) return acceptedAnswer(submitted);
  return {
    status: 200,
    body: {
      issued: await sealSecret(ctx.body["seal"] as Seal, result.secret, "access.tokens.mint"),
      credentialRef: result.token.id,
      ...(result.token.prefixHint !== undefined ? { prefixHint: result.token.prefixHint } : {}),
      ...(result.token.expiresAt !== undefined ? { expiresAt: result.token.expiresAt } : {}),
      receipt: submitted.receipt,
    },
  };
};

const linksCreate: V1Handler = async (ctx) => {
  const access = handleOf(ctx);
  const principal = String(ctx.body["principal"]);
  const { submitted, result } = await accessCommand(
    ctx,
    () => access.link(actorOf(ctx), { subject: String(ctx.body["subject"]), member: principal }),
    `home/principal/${principal}`,
  );
  return acceptedAnswer(submitted, result !== undefined ? { link: result.link } : {});
};

function revoker(param: "inv" | "grt" | "crd"): V1Handler {
  return async (ctx) => {
    const id = String(ctx.params[param]);
    const access = handleOf(ctx);
    const manager = manages(ctx);
    if (param === "crd" && !manager) {
      // A personal token revokes only itself; a session, any of its member's own.
      const actor = ctx.access.caller.actor;
      if (ctx.access.caller.via === "personal") {
        const own = actor !== null && "credential" in actor ? actor.credential : undefined;
        if (id !== own) {
          throw new V1Error({
            status: 404,
            code: "not_found",
            reason: "not_found",
            message: "Nothing of yours has that id.",
          });
        }
      }
      // One's own personal token, which `crewhaus logout` ends.
      const { submitted } = await accessCommand(ctx, () =>
        revokeOwnToken(
          { root: ctx.deps.hangarRoot, now: ctx.deps.now, harnesses: () => [], domains: new Map() },
          ctx.access.caller.principal,
          id,
        ),
      );
      return acceptedAnswer(submitted);
    }
    if (!manager) {
      throw new V1Error({
        status: 404,
        code: "not_found",
        reason: "not_found",
        message: "Nothing of yours has that id.",
      });
    }
    const { submitted } = await accessCommand(ctx, () => access.revoke(actorOf(ctx), id));
    return acceptedAnswer(submitted);
  };
}

/** A personal token revokes itself only: never its member's links or devices. */
function refusePersonal(ctx: V1Context): void {
  if (ctx.access.caller.via !== "personal") return;
  throw new V1Error({
    status: 403,
    code: "forbidden",
    reason: "permission",
    message: PERSONAL_SELF_MESSAGE,
  });
}

const linksRevoke: V1Handler = async (ctx) => {
  refusePersonal(ctx);
  const id = String(ctx.params["lnk"]);
  const ctxOf = {
    root: ctx.deps.hangarRoot,
    now: ctx.deps.now,
    harnesses: () => [],
    domains: new Map(),
  };
  const { submitted } = await accessCommand<unknown>(ctx, () =>
    manages(ctx)
      ? handleOf(ctx).unlink(actorOf(ctx), id)
      : unlinkOwn(ctxOf, ctx.access.caller.principal, id),
  );
  return acceptedAnswer(submitted);
};

const devicesRevoke: V1Handler = async (ctx) => {
  refusePersonal(ctx);
  const id = String(ctx.params["dev"]);
  const caller = ctx.access.caller.principal;
  const manager = manages(ctx);
  const submitted = await submitCommand<
    Awaited<ReturnType<V1Context["deps"]["home"]["signIn"]["revokeDevice"]>>
  >(ctx, {
    ledger: "workspace",
    effect: async () => {
      const answer = await ctx.deps.home.signIn.revokeDevice(id, {
        by: actorOf(ctx).principal,
        ...(manager ? {} : { owner: caller }),
      });
      return {
        settle: answer.ok
          ? { state: "succeeded" }
          : { state: "rejected", outcome: outcomeOf(answer.code as ErrorCode) },
        value: answer,
      };
    },
  });
  const answer = submitted.value;
  if (answer !== undefined && !answer.ok) {
    throw new V1Error({
      status: answer.reason === "device_unknown" ? 404 : answer.status === 503 ? 503 : 409,
      code:
        answer.reason === "device_unknown"
          ? "not_found"
          : answer.status === 503
            ? "unavailable"
            : "conflict",
      reason: answer.reason,
      message: answer.message,
      details: { receipt: submitted.receipt },
    });
  }
  return acceptedAnswer(submitted);
};

/** Whether each ref names a run this Home has: a run row, or a supervisor's execution. */
function unknownRefs(ctx: V1Context, refs: readonly string[]): string[] {
  return refs.filter((ref) => {
    const parsed = parseRef(ref);
    if ("error" in parsed) return true;
    const entry = entryOf(ctx.deps, parsed.scope);
    const dir = entry === undefined ? undefined : liveDirOf(entry);
    if (dir === undefined) return true;
    if (parsed.kind === "run") {
      const fold = foldStates(runsLedger(dir));
      return !(fold.ok && fold.objects.has(parsed.id));
    }
    if (parsed.kind === "exec") {
      try {
        return !readRunLedger(dir).some((row) => row.runId === parsed.id);
      } catch {
        return true;
      }
    }
    return true;
  });
}

const scopedMint: V1Handler = async (ctx) => {
  const caller = ctx.access.caller;
  const credential =
    caller.actor !== null && "credential" in caller.actor ? caller.actor.credential : undefined;
  if (caller.via !== "service" || credential === undefined) {
    throw new V1Error({
      status: 403,
      code: "forbidden",
      reason: "service_only",
      message: "Only a service mints these, for the browsers it serves.",
    });
  }
  const refs = (ctx.body["refs"] as string[] | undefined) ?? [];
  const missing = unknownRefs(ctx, refs);
  if (missing.length > 0) {
    throw new V1Error({
      status: 422,
      code: "invalid",
      reason: "refs",
      message:
        "Each ref must name a run this Home has, as <harness>/run/<id> or <harness>/exec/<id>.",
      details: { refs: missing },
    });
  }
  const ttl = ctx.body["ttlSeconds"];
  const answer = await mintScopedToken(
    ctx.deps.hangarRoot,
    {
      credential,
      refs,
      acts: (ctx.body["acts"] as string[] | undefined) ?? [],
      ...(typeof ttl === "number" ? { ttlMs: ttl * 1000 } : {}),
      ...(typeof ctx.body["subject"] === "string" ? { subjectRef: ctx.body["subject"] } : {}),
    },
    { now: ctx.deps.now },
  );
  if (!answer.ok) {
    throw new V1Error({
      status: answer.reason === "not-held" || answer.reason === "credential" ? 403 : 422,
      code:
        answer.reason === "not-held" || answer.reason === "credential" ? "forbidden" : "invalid",
      reason: answer.reason,
      message: answer.message,
      ...(answer.reason === "ref" ? { details: { refs } } : {}),
    });
  }
  return {
    status: 200,
    body: {
      issued: await sealSecret(ctx.body["seal"] as Seal, answer.token, "access.scopedTokens.mint"),
      expiresAt: answer.expiresAt,
    },
  };
};

export const ACCESS_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "access.members.list": membersList,
  "access.invites.list": invitesList,
  "access.grants.list": grantsList,
  "access.tokens.list": tokensList,
  "access.links.list": linksList,
  "access.devices.list": devicesList,
  "access.invites.create": invitesCreate,
  "access.grants.create": grantsCreate,
  "access.tokens.mint": tokensMint,
  "access.links.create": linksCreate,
  "access.invites.revoke": revoker("inv"),
  "access.grants.revoke": revoker("grt"),
  "access.tokens.revoke": revoker("crd"),
  "access.links.revoke": linksRevoke,
  "access.devices.revoke": devicesRevoke,
  "access.scopedTokens.mint": scopedMint,
};
