/**
 * Home's one authentication step and its one authorization step, over
 * `@crewhaus/access-control`.
 *
 * `handle()` calls `checkAccess` for every `/api` request, after the Host allowlist and
 * before the read-only gate. It hands in the peer the listener saw (the TCP address, or
 * which socket), gets a principal or a refusal back, and, when a proxy identity header
 * arrived from somewhere that could not prove it is the proxy, strips that header and
 * the proxy secret before anything else reads the request, and notes it, content-free.
 *
 * Then `authorizeRequest` decides the matched route-table row for that principal, before
 * any handler runs: the row's permission, on the harness its `:id` names (or the whole
 * Home), with the row's object ref handed to a domain's checker. A scoped token reads only
 * the run it names, a tab-only session never manages access or Home's settings, and
 * Home's own key and a Home with sign-in turned off act as its owner. The request's
 * authority then travels with it (`requestAccess`), so a fleet fold counts and quotes only
 * the harnesses the caller may read, and a handler whose permission depends on what is
 * asked checks it with the same rule.
 *
 * A refusal answers in the envelope of the route it refused: the v1 envelope
 * (`{error: {code, message, retryable, details}}`) under `/api/v1`, and the legacy
 * `{error: <message>}` elsewhere, with `code` and `reason` beside it so the console and
 * older tests that read `error` keep working.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type AccessActor,
  type AccessSnapshotRead,
  type AccessTarget,
  type AuthVia,
  type AuthenticateConfig,
  type Authenticated,
  type AuthorizeVerdict,
  type DomainChecker,
  PROXY_SECRET_HEADER,
  type Peer,
  SCOPED_ACT_PERMISSIONS,
  type ScopedGrant,
  type SignInHandle,
  TOKEN_FILENAME,
  authenticate,
  authorize,
  domainOf,
  effectiveRole,
  loadAccessSnapshot,
  registerDomainIn,
} from "@crewhaus/access-control";
import {
  PERMISSION_DECLS,
  ROLE_PERMISSIONS,
  type Role,
  isPermission,
  parseRef,
} from "@crewhaus/control-contract";
import { json } from "./http";
import type { RouteRow } from "./route-table";

export type AccessCheck = {
  readonly answer: Authenticated;
  /** The request to dispatch: the one given, or a copy without ignored proxy headers. */
  readonly request: Request;
};

export type HomeAccess = {
  readonly signIn: SignInHandle;
  readonly config: AuthenticateConfig;
  /** The token Home read at boot. */
  readonly bootToken: string | undefined;
  readonly now: () => number;
  /**
   * Home's domain table: a permission `<name>.…` goes to the checker registered under its
   * name, with the route's object ref. Fill it through {@link registerHomeDomain}.
   */
  readonly domains: Map<string, DomainChecker>;
};

/**
 * Register a domain's checker in Home's table, under the rules every domain table keeps
 * (a lower-case name, never a core permission prefix, never twice). A broken rule throws.
 *
 * First consumer: `startHangarServer`'s `domains` option.
 */
export function registerHomeDomain(home: HomeAccess, name: string, checker: DomainChecker): void {
  registerDomainIn(home.domains, name, checker);
}

/** A copy of `req` without the proxy identity header and the proxy secret. */
function stripProxyHeaders(req: Request, identityHeader: string | undefined): Request {
  const headers = new Headers(req.headers);
  headers.delete(PROXY_SECRET_HEADER);
  if (identityHeader !== undefined) headers.delete(identityHeader);
  return new Request(req, { headers });
}

/**
 * Authenticate one request.
 *
 * First consumer: `handle` in `server.ts`, and the sign-in routes that need a session.
 */
export async function checkAccess(
  home: HomeAccess,
  req: Request,
  peer: Peer,
): Promise<AccessCheck> {
  const answer = await authenticate(req, peer, home.config, {
    signIn: home.signIn,
    bootToken: home.bootToken,
    now: home.now,
  });
  if (answer.ignoredProxyHeaders !== true) return { answer, request: req };
  await home.signIn.noteIgnoredIdentity(peer.listener, peer.address).catch(() => {});
  return { answer, request: stripProxyHeaders(req, home.config.trustedProxy?.header) };
}

/** Whether a path is under the v1 API, which answers in the v1 envelope. */
export function isV1Path(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

export type RefusalBody = {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly reason: string;
  /** For a refused permission: what was missing, and the role the caller has there. */
  readonly needs?: string;
  readonly role?: Role | null;
};

/**
 * The response for a refusal, in the envelope of the path it refused.
 *
 * First consumer: `handle` in `server.ts`.
 */
export function refusalResponse(pathname: string, refusal: RefusalBody): Response {
  const headers: Record<string, string> =
    refusal.status === 401 ? { "www-authenticate": "Bearer" } : {};
  const needs = {
    ...(refusal.needs !== undefined ? { needs: refusal.needs } : {}),
    ...(refusal.role !== undefined ? { role: refusal.role } : {}),
  };
  if (isV1Path(pathname)) {
    return json(
      {
        error: {
          code: refusal.code,
          message: refusal.message,
          retryable: refusal.status === 503,
          details: { reason: refusal.reason, ...needs },
        },
      },
      refusal.status,
      headers,
    );
  }
  return json(
    { error: refusal.message, code: refusal.code, reason: refusal.reason, ...needs },
    refusal.status,
    headers,
  );
}

/** The refusal for a request that names nobody. */
export const NOBODY: RefusalBody = Object.freeze({
  status: 401,
  code: "unauthenticated",
  message: "missing or invalid bearer token",
  reason: "no_credential",
});

/** A refusal body from a refused or anonymous answer. */
export function refusalOf(answer: Authenticated): RefusalBody | undefined {
  if (answer.kind === "anonymous") return NOBODY;
  if (answer.kind === "refused") {
    return {
      status: answer.status,
      code: answer.code,
      message: answer.message,
      reason: answer.reason,
    };
  }
  return undefined;
}

/**
 * Why Home must not boot with the key in `<hangarRoot>/token`, or `undefined`.
 *
 * Once the access records hold Home's own key (the first sign-in or rotation records it),
 * that record is the key, not the file. When the file no longer matches it (deleted and
 * minted again at this boot, replaced, or restored from an old copy), the file's key
 * would be refused on every request and `crewhaus hangar open` could not mint a link, so
 * Home stops at boot and names the one verb that makes file and record agree again.
 *
 * First consumer: `startHangarServer`.
 */
export function bootstrapKeyMismatch(hangarRoot: string, token: string): string | undefined {
  const read = loadAccessSnapshot(hangarRoot);
  if (read.state !== "present") return undefined;
  const recorded = read.snapshot.tokens.filter((row) => row.kind === "bootstrap");
  if (recorded.length === 0) return undefined;
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  if (recorded.some((row) => row.state === "active" && row.sha256 === digest)) return undefined;
  return `hangar-server: ${join(hangarRoot, TOKEN_FILENAME)} is not the key Home recorded (it was deleted, replaced or restored from an old copy), so it would be refused — run \`crewhaus hangar rotate-token\` to make a new one, then start Home again`;
}

// ---------------------------------------------------------------------------
// Authorization: one choke point, then the request's authority travels with it
// ---------------------------------------------------------------------------

/** Who a request acts as, once it is admitted. */
export type Caller = {
  /**
   * The principal every record this request writes names as its actor: the `prn_…` it
   * authenticated as, the owner's for Home's own key and a Home with sign-in turned off,
   * or Home's own label while no access records exist.
   */
  readonly principal: string;
  /**
   * What `authorize()` is asked about. `null` for Home's own key and a Home with sign-in
   * turned off: those act as the owner, for every core permission and no domain's.
   */
  readonly actor: AccessActor | null;
  /** How the caller came in; `system` for Home's own background work ({@link systemAccess}). */
  readonly via: AuthVia | "no-auth" | "system";
  /** For a scoped token: exactly what it may read. */
  readonly scoped?: ScopedGrant;
  /** A session a page on plain HTTP made for itself. */
  readonly tabOnly?: true;
};

/** The access records and the registry, as one request's authorization sees them. */
export type AccessView = {
  readonly read: AccessSnapshotRead;
  readonly now: number;
  readonly domains: ReadonlyMap<string, DomainChecker>;
  /** A registered harness's registry groups; `undefined` when the id is not registered. */
  readonly groupsOf: (harness: string) => readonly string[] | undefined;
  /** Every registered harness's id. */
  readonly harnessIds: () => readonly string[];
};

/**
 * The caller an authenticated answer (or a Home with sign-in turned off, `undefined`)
 * acts as. `ownerLabel` names the actor while no access records exist.
 *
 * First consumer: `handle` in `server.ts`.
 */
export function callerOf(
  answer: Authenticated | undefined,
  read: AccessSnapshotRead,
  ownerLabel: string,
): Caller | undefined {
  const owner = read.state === "present" ? read.snapshot.owner : undefined;
  if (answer === undefined) return { principal: owner ?? ownerLabel, actor: null, via: "no-auth" };
  if (answer.kind !== "principal") return undefined;
  if (answer.via === "bootstrap") {
    return { principal: owner ?? ownerLabel, actor: null, via: "bootstrap" };
  }
  return {
    principal: answer.principal,
    actor:
      answer.credential !== undefined
        ? { principal: answer.principal, credential: answer.credential }
        : { principal: answer.principal },
    via: answer.via,
    ...(answer.scoped !== undefined ? { scoped: answer.scoped } : {}),
    ...(answer.tabOnly === true ? { tabOnly: true as const } : {}),
  };
}

/** Whether the caller is the Home's owner: by Home's own key, or as the owner principal. */
export function isOwnerCaller(caller: Caller, read: AccessSnapshotRead): boolean {
  if (caller.actor === null) return true;
  return read.state === "present" && read.snapshot.owner === caller.principal;
}

/** The harness a route names, with its registry groups. */
export function harnessTarget(view: AccessView, harness: string): AccessTarget {
  return { scope: "harness", harness, groups: view.groupsOf(harness) ?? [] };
}

/** Permissions a tab-only session never holds, whatever its role. */
const NOT_FROM_A_TAB: ReadonlySet<string> = new Set(["home.access.manage", "home.settings.manage"]);

/** What a tab-only session hears when it asks for a permission it never holds. */
export const TAB_ONLY_MESSAGE =
  "Open Home on its own computer or over HTTPS to manage access or Home's settings.";

/**
 * A verdict for a caller: `authorize()`'s, or a refusal that is about how the caller
 * connected (`tab_only`) rather than about its role.
 */
export type CallerVerdict =
  | AuthorizeVerdict
  | {
      readonly allow: false;
      readonly needs: string;
      readonly role: Role | null;
      readonly reason: "tab_only";
    };

/**
 * `authorize()` for a caller: Home's own key and a Home with sign-in turned off hold every
 * core permission and no domain's, and a tab-only session never manages access or Home's
 * settings, whatever its role. Every check a request makes, at the choke point and in a
 * handler, goes through here.
 *
 * First consumers: {@link authorizeRequest}, and the handlers' `ctx.authorize`.
 */
export function authorizeCaller(
  caller: Caller,
  view: AccessView,
  permission: string,
  target: AccessTarget,
  ref?: { readonly kind: string; readonly id: string },
): CallerVerdict {
  if (caller.tabOnly === true && NOT_FROM_A_TAB.has(permission)) {
    return { allow: false, needs: permission, role: null, reason: "tab_only" };
  }
  if (caller.actor === null) {
    return domainOf(permission) === undefined && isPermission(permission)
      ? { allow: true, grant: "home-key" }
      : { allow: false, needs: permission, role: null };
  }
  return authorize(view.read, caller.actor, permission, target, {
    now: view.now,
    domains: view.domains,
    ...(ref !== undefined ? { ref } : {}),
  });
}

/**
 * Whether the caller holds a harness permission on at least one registered harness, or
 * through its grant over the whole Home: the rule for a route about several harnesses,
 * whose handler then narrows to each one it acts on.
 */
function holdsOnSomeHarness(caller: Caller, view: AccessView, permission: string): boolean {
  if (caller.actor === null) return true;
  if (view.read.state === "present") {
    const role = effectiveRole(view.read.snapshot, caller.principal, { scope: "home" }, view.now);
    if (role !== null && (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission)) {
      return true;
    }
  }
  return view
    .harnessIds()
    .some((id) => authorizeCaller(caller, view, permission, harnessTarget(view, id)).allow);
}

/**
 * What a refusal for a missing permission says, in plain words: the role that holds it,
 * never a permission id.
 *
 * First consumers: {@link permissionRefusal}, and the handlers' own escalations.
 */
export function permissionMessage(permission: string, where: "harness" | "home"): string {
  const floor = isPermission(permission) ? PERMISSION_DECLS[permission].floor : "none";
  const place = where === "harness" ? "this harness" : "this Home";
  if (floor === "none") return `Ask the owner of this Home for access to ${place}.`;
  if (floor === "owner") return `Only an owner of ${place} can do this.`;
  return `Ask the owner for ${floor} access to ${place}.`;
}

/** The refusal for a permission the caller does not hold, in plain words. */
export function permissionRefusal(
  caller: Caller,
  permission: string,
  role: Role | null,
  where: "harness" | "home",
): RefusalBody {
  return {
    status: 403,
    code: "forbidden",
    reason: "permission",
    message:
      caller.via === "service" || caller.via === "scoped"
        ? "This token cannot do that."
        : permissionMessage(permission, where),
    needs: permission,
    role,
  };
}

const SCOPED_REFUSAL: RefusalBody = Object.freeze({
  status: 403,
  code: "forbidden",
  reason: "scoped",
  message: "This link can read only the run it was made for.",
});

const TAB_ONLY_REFUSAL: RefusalBody = Object.freeze({
  status: 403,
  code: "forbidden",
  reason: "tab_only",
  message: TAB_ONLY_MESSAGE,
});

export type RequestAuthorization =
  | { readonly allow: true }
  | { readonly allow: false; readonly refusal: RefusalBody };

export type AuthorizeRequestInput = {
  readonly row: RouteRow;
  readonly params: Readonly<Record<string, string>>;
  readonly caller: Caller;
  readonly view: AccessView;
  /** For the proof route: the harness that owns the run, resolved first; `null` when none does. */
  readonly runProofHarness?: string | null;
  /** The request's `Origin` header. */
  readonly origin?: string | null;
  /** Whether an origin is Home's own. */
  readonly ownOrigin?: (origin: string) => boolean;
};

/**
 * Decide one matched row for one caller, before any handler runs. Pure over the view.
 *
 * - `public` rows answer anyone; `authenticated` rows any admitted principal.
 * - A scoped token reads only a GET row that names its act and its run, from no foreign
 *   `Origin`, and only while its minting service still holds the act's permission and the
 *   row's own; every other row refuses it (`scoped`).
 * - A tab-only session never manages access or Home's settings (`tab_only`).
 * - A row with `:id` is decided on that harness (an unregistered one only for the owner,
 *   whose handler answers 404); a harness permission on a row with no `:id` needs that
 *   permission on some harness, and its handler narrows per harness; anything else is
 *   decided on the whole Home. A domain's permission reaches its checker with the row's
 *   object ref.
 *
 * First consumer: `handle` in `server.ts`.
 */
export function authorizeRequest(input: AuthorizeRequestInput): RequestAuthorization {
  const { row, params, caller, view } = input;
  if (row.permission === "public") return { allow: true };
  if (caller.scoped !== undefined) return authorizeScoped(input);
  if (row.permission === "authenticated") return { allow: true };
  // Before the target is chosen: the refusal is about the connection, not the harness.
  if (caller.tabOnly === true && NOT_FROM_A_TAB.has(row.permission)) {
    return { allow: false, refusal: TAB_ONLY_REFUSAL };
  }
  const ref =
    row.ref !== undefined && params[row.ref.param] !== undefined
      ? { kind: row.ref.kind, id: params[row.ref.param] as string }
      : undefined;
  const owner = isOwnerCaller(caller, view.read);
  let target: AccessTarget;
  if (row.key === "runProof") {
    const harness = input.runProofHarness;
    if (harness === undefined || harness === null) {
      // Nothing to authorize against: the owner hears the handler's 404, others the same 403.
      return owner
        ? { allow: true }
        : { allow: false, refusal: permissionRefusal(caller, row.permission, null, "harness") };
    }
    target = harnessTarget(view, harness);
  } else if (params["id"] !== undefined) {
    if (view.groupsOf(params["id"]) === undefined && !owner) {
      // An id this Home does not have and one the caller may not see answer alike.
      return { allow: false, refusal: permissionRefusal(caller, row.permission, null, "harness") };
    }
    target = harnessTarget(view, params["id"]);
  } else if (isPermission(row.permission) && PERMISSION_DECLS[row.permission].scope === "harness") {
    return holdsOnSomeHarness(caller, view, row.permission)
      ? { allow: true }
      : { allow: false, refusal: permissionRefusal(caller, row.permission, null, "harness") };
  } else {
    target = { scope: "home" };
  }
  const verdict = authorizeCaller(caller, view, row.permission, target, ref);
  if (verdict.allow) return { allow: true };
  if ("reason" in verdict) return { allow: false, refusal: TAB_ONLY_REFUSAL };
  return {
    allow: false,
    refusal: permissionRefusal(
      caller,
      verdict.needs,
      verdict.role,
      target.scope === "harness" ? "harness" : "home",
    ),
  };
}

function authorizeScoped(input: AuthorizeRequestInput): RequestAuthorization {
  const { row, params, caller, view } = input;
  const scoped = caller.scoped as ScopedGrant;
  const refused = { allow: false, refusal: SCOPED_REFUSAL } as const;
  // Its end is checked here too, so a stream it opened closes when it ends.
  if (view.now >= scoped.exp) return refused;
  if (row.method !== "GET" || row.scopedAct === undefined || row.ref === undefined) return refused;
  if (!scoped.acts.includes(row.scopedAct)) return refused;
  if (
    input.origin !== undefined &&
    input.origin !== null &&
    (input.ownOrigin === undefined || !input.ownOrigin(input.origin))
  ) {
    return refused;
  }
  const harness = params["id"];
  const id = params[row.ref.param];
  if (harness === undefined || id === undefined) return refused;
  const ref = `${harness}/${row.ref.kind}/${id}`;
  const parsed = parseRef(ref);
  if ("error" in parsed || parsed.kind !== "run" || !scoped.refs.includes(ref)) return refused;
  // The minter's authority, now: the act's permission and the row's own, on this harness.
  const target = harnessTarget(view, harness);
  const act = row.scopedAct as keyof typeof SCOPED_ACT_PERMISSIONS;
  for (const permission of [SCOPED_ACT_PERMISSIONS[act], row.permission]) {
    if (permission === undefined || !authorizeCaller(caller, view, permission, target).allow) {
      return refused;
    }
  }
  return { allow: true };
}

/** One request's authority, for the handlers that act on several harnesses or escalate. */
export type RequestAccess = {
  readonly caller: Caller;
  /** Whether the caller holds `permission` on one harness, or on the whole Home. */
  authorize(permission: string, target?: { readonly harness: string }): CallerVerdict;
  /** Whether the caller may read this harness at all (`h.read`). */
  canRead(harness: string): boolean;
  /** Whether the caller may read this harness's content (`h.read.content`). */
  canReadContent(harness: string): boolean;
  /** Whether an item marked `people` may be released: a people domain allows it on its ref. */
  peopleAllowed(item: Readonly<Record<string, unknown>>): boolean;
};

/**
 * A caller's authority over one view, memoized per harness: built once per request.
 *
 * First consumer: `handle` in `server.ts`.
 */
export function requestAccessFor(caller: Caller, view: AccessView): RequestAccess {
  const memo = new Map<string, boolean>();
  const check = (permission: string, harness: string): boolean => {
    const key = `${permission}\u0000${harness}`;
    let held = memo.get(key);
    if (held === undefined) {
      held = authorizeCaller(caller, view, permission, harnessTarget(view, harness)).allow;
      memo.set(key, held);
    }
    return held;
  };
  return {
    caller,
    authorize: (permission, target) =>
      authorizeCaller(
        caller,
        view,
        permission,
        target === undefined ? { scope: "home" } : harnessTarget(view, target.harness),
      ),
    canRead: (harness) => check("h.read", harness),
    canReadContent: (harness) => check("h.read.content", harness),
    peopleAllowed: (item) => {
      const ref = objectRefOf(item["ref"]);
      if (ref === undefined) return false;
      return authorizeCaller(caller, view, "people.derived.read", { scope: "home" }, ref).allow;
    },
  };
}

/** An item's `ref` as a domain names objects: `{kind, id}`, or a `<scope>/<kind>/<id>` string. */
function objectRefOf(value: unknown): { kind: string; id: string } | undefined {
  if (typeof value === "string") {
    const parsed = parseRef(value);
    if (!("error" in parsed)) return { kind: parsed.kind, id: parsed.id };
    const parts = value.split("/");
    return parts.length === 3 && parts[1] !== "" && parts[2] !== ""
      ? { kind: parts[1] as string, id: parts[2] as string }
      : undefined;
  }
  if (typeof value === "object" && value !== null) {
    const { kind, id } = value as Record<string, unknown>;
    if (typeof kind === "string" && typeof id === "string") return { kind, id };
  }
  return undefined;
}

const requestScope = new AsyncLocalStorage<RequestAccess>();

/**
 * Run `fn` with this request's authority available to everything it calls.
 *
 * First consumer: `handle` in `server.ts`.
 */
export function withRequestAccess<T>(access: RequestAccess, fn: () => T): T {
  return requestScope.run(access, fn);
}

/** The current request's authority, or `undefined` outside one. */
export function currentRequestAccess(): RequestAccess | undefined {
  return requestScope.getStore();
}

/**
 * Whether the current request may read this harness: every enumeration a fleet fold makes
 * goes through it, so a count, a badge, a snippet or a total never includes a harness the
 * caller cannot read. Outside a request, nothing is visible: Home's own background work
 * runs under {@link systemAccess}.
 *
 * First consumers: the registry enumerations in `server.ts`.
 */
export function visibleToRequest(harness: string): boolean {
  return requestScope.getStore()?.canRead(harness) ?? false;
}

/** Whether the current request may read this harness's content; `false` outside a request. */
export function contentVisibleToRequest(harness: string): boolean {
  return requestScope.getStore()?.canReadContent(harness) ?? false;
}

/**
 * Whether the current request's caller holds `permission` on a harness, or on the whole
 * Home. Outside a request, nothing is allowed.
 *
 * First consumers: the handlers in `server.ts` that act on several harnesses or escalate.
 */
export function requestAllows(permission: string, harness?: string): boolean {
  const access = requestScope.getStore();
  if (access === undefined) return false;
  return access.authorize(permission, harness !== undefined ? { harness } : undefined).allow;
}

/** The permissions Home's own background work holds: reading, and nothing else. */
const SYSTEM_READS: ReadonlySet<string> = new Set(["home.read", "h.read", "h.read.content"]);

/**
 * The authority one named piece of Home's own background work runs under (command recovery
 * at boot, for one): it reads every registered harness and its content, and is refused
 * every other permission, so it never writes or decides on its own authority. Its caller
 * is the `sys:<name>` principal, never Home's own key. Items about people are withheld
 * from it.
 *
 * First consumer: command recovery in `startHangarServer`.
 */
export function systemAccess(name: string): RequestAccess {
  const principal = `sys:${name}`;
  const caller: Caller = { principal, actor: { principal }, via: "system" };
  return {
    caller,
    authorize: (permission) =>
      SYSTEM_READS.has(permission)
        ? { allow: true, grant: principal }
        : { allow: false, needs: permission, role: null },
    canRead: () => true,
    canReadContent: () => true,
    peopleAllowed: () => false,
  };
}

/** The sensitivity an item carries when it is about people. */
export const PEOPLE_SENSITIVITY = "people";

/** How deep {@link withholdPeople} walks an answer; the top-level object is depth 1. */
export const PEOPLE_WALK_DEPTH = 16;

/**
 * What stands in for a part of an answer nested deeper than {@link PEOPLE_WALK_DEPTH} that
 * holds an item about people: the part is withheld whole, and the rest of the answer is sent.
 */
export const PEOPLE_TOO_DEEP = "[withheld: nested too deep to check for people]";

/** How a people item reads once serialized: the key and value need no escaping. */
const PEOPLE_MARK = `"sensitivity":${JSON.stringify(PEOPLE_SENSITIVITY)}`;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isPeopleItem = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) && value["sensitivity"] === PEOPLE_SENSITIVITY;

/**
 * Whether a part of an answer may hold an item about people, read from the text it is sent
 * as: inside a JSON string every quote is escaped, so the mark appears only where an object
 * really carries it. A part that cannot be serialized counts as holding one.
 */
const mayHoldPeople = (value: unknown): boolean => {
  try {
    return (JSON.stringify(value) ?? "").includes(PEOPLE_MARK);
  } catch {
    return true;
  }
};

/**
 * The one predicate at a fleet fold's exit: an item marked `sensitivity: "people"` in any
 * list of the answer, at any depth, is released only when `allowed` says so; otherwise it
 * is withheld, what it holds is not read, and the answer says `hidden: ["people"]` at its
 * top. A part nested deeper than {@link PEOPLE_WALK_DEPTH} is checked whole: one that holds
 * no item about people is sent as it is, and one that does is replaced by
 * {@link PEOPLE_TOO_DEEP} and counts as withheld. Nothing past the cap is sent unchecked,
 * and one deep part never keeps the rest of the answer from its caller. An answer with
 * nothing withheld is returned as it was, the same object, and a part of it with nothing
 * withheld is not copied.
 *
 * First consumer: `handle` in `server.ts`, on every row the table marks `filtered`.
 */
export function withholdPeople(
  body: unknown,
  allowed: (item: Readonly<Record<string, unknown>>) => boolean,
): unknown {
  if (!isPlainObject(body)) return body;
  let withheld = false;
  // `depth` is the depth of `value` itself; a container past the cap is checked whole.
  const walk = (value: unknown, depth: number): unknown => {
    const container = Array.isArray(value) || isPlainObject(value);
    if (container && depth > PEOPLE_WALK_DEPTH) {
      if (!mayHoldPeople(value)) return value;
      withheld = true;
      return PEOPLE_TOO_DEEP;
    }
    if (Array.isArray(value)) {
      let out: unknown[] | undefined;
      for (const [index, item] of value.entries()) {
        if (isPeopleItem(item) && !allowed(item)) {
          withheld = true;
          out ??= value.slice(0, index);
          continue;
        }
        const next = walk(item, depth + 1);
        if (out !== undefined) out.push(next);
        else if (next !== item) {
          out = value.slice(0, index);
          out.push(next);
        }
      }
      return out ?? value;
    }
    if (!isPlainObject(value)) return value;
    let out: Record<string, unknown> | undefined;
    for (const [key, child] of Object.entries(value)) {
      const next = walk(child, depth + 1);
      if (next !== child) {
        out ??= { ...value };
        out[key] = next;
      }
    }
    return out ?? value;
  };
  const exited = walk(body, 1) as Record<string, unknown>;
  if (!withheld) return body;
  const prior = Array.isArray(exited["hidden"]) ? (exited["hidden"] as unknown[]) : [];
  return { ...exited, hidden: [...new Set([...prior, PEOPLE_SENSITIVITY])] };
}
