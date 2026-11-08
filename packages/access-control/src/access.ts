/**
 * The access operations: set up, invite, redeem, grant, revoke, remove, link, unlink, mint
 * and sync, each over the records `<hangarRoot>/access/` holds. Every change but a
 * redemption runs through `runMutation`, so it is authorized, size-checked and recorded
 * whole under the access lock, and moves the access revision once.
 */
import { mkdirSync, statSync } from "node:fs";
import {
  ISSUED_SECRET_RES,
  LOCAL_ACTOR_RE,
  PERMISSION_DECLS,
  type Permission,
  ROLES,
  type Role,
  isGrantScope,
  isId,
  isPermission,
  mintId,
  parseId,
  parseLinkSubject,
} from "@crewhaus/control-contract";
import {
  appendClaim,
  ensureDigestKey,
  keyedDigest,
  readDigestKey,
  withLedgerLock,
} from "@crewhaus/control-records";
import {
  type AccessActor,
  type AccessTarget,
  type AuthorizeVerdict,
  CORE_PERMISSION_PREFIXES,
  type DomainChecker,
  authorize,
} from "./authorize";
import {
  EMPTY_SUBJECTS,
  type Subjects,
  readBootstrapToken,
  readRevision,
  writeRevision,
} from "./files";
import {
  type AccessContext,
  type Change,
  type Done,
  type PlannedClaim,
  type Planning,
  type Refusal,
  projectAfter,
  projectionEpochFloor,
  refusal,
  runMutation,
} from "./mutate";
import { accessLedger, accessPaths, inviteEndClaim } from "./paths";
import type { AccessHarness, ProjectionReport } from "./projection";
import type {
  CredentialRow,
  GrantRow,
  InviteRow,
  LinkRow,
  PrincipalKind,
  PrincipalRow,
} from "./records";
import { mintIssuedSecret, prefixHintOf, sha256Hex } from "./secrets";
import {
  type AccessSnapshot,
  type AccessSnapshotRead,
  displayNameOf,
  hasPassed,
  isLiveGrant,
  loadAccessSnapshot,
  localPrincipalOf,
  principalOf,
} from "./snapshot";
import {
  type GrantView,
  type InviteView,
  type LinkView,
  type TokenView,
  grantView,
  inviteView,
  linkView,
  tokenView,
} from "./views";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * An invite lasts a day unless asked otherwise, and a week at most.
 *
 * First consumer: `crewhaus access invite --expires`.
 */
export const INVITE_TTL_MS = Object.freeze({ default: DAY_MS, max: 7 * DAY_MS });
/**
 * A service token lasts 180 days, and no longer.
 *
 * First consumer: `crewhaus access mint --expires`.
 */
export const SERVICE_TOKEN_TTL_MS = Object.freeze({ default: 180 * DAY_MS, max: 180 * DAY_MS });

const DISPLAY_NAME_MAX = 80;
/** The keyed-digest purpose of a link subject. A pin: stored digests join forever. */
const LINK_SUBJECT_LABEL = "access.link.subject";
const HOME: AccessTarget = { scope: "home" };

export type { Done, Refusal } from "./mutate";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/** A display name a person typed, or the refusal that says what is wrong with it. */
function checkDisplayName(raw: string): string | Refusal {
  const name = raw.normalize("NFC").trim();
  if (name === "") return refusal("invalid", "A name cannot be empty.");
  if (name.length > DISPLAY_NAME_MAX) {
    return refusal("invalid", `A name can be at most ${DISPLAY_NAME_MAX} characters.`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return refusal("invalid", "A name cannot hold control characters.");
  }
  if (nameKey(name) === "me" || parseId(name) !== null) {
    return refusal("invalid", `"${name}" is reserved; choose another name.`);
  }
  return name;
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && (value as Refusal).ok === false;
}

function withNamesOf(subjects: Subjects): {
  principals: Record<string, Subjects["principals"][string]>;
  links: Record<string, string>;
} {
  return { principals: { ...subjects.principals }, links: { ...subjects.links } };
}

/** Resolve `prn_…` or a display name to one active principal. */
function resolvePrincipal(
  snapshot: AccessSnapshot,
  ref: string,
  kind?: PrincipalKind,
): PrincipalRow | Refusal {
  if (isId("prn", ref)) {
    const row = principalOf(snapshot, ref);
    if (row === undefined || row.state !== "active") {
      return refusal("not-found", "No member or service has that id.");
    }
    if (kind !== undefined && row.kind !== kind) {
      return refusal(
        "invalid",
        kind === "member" ? "That id is a service." : "That id is a member.",
      );
    }
    return row;
  }
  const key = nameKey(ref);
  const matches = snapshot.principals.filter(
    (row) =>
      row.state === "active" &&
      (kind === undefined || row.kind === kind) &&
      nameKey(displayNameOf(snapshot, row.id) ?? "") === key,
  );
  if (matches.length === 0) return refusal("not-found", `No one here is named "${ref.trim()}".`);
  if (matches.length > 1) {
    return refusal(
      "conflict",
      `More than one member is named "${ref.trim()}": name one by its id (\`crewhaus access members --json\`).`,
    );
  }
  return matches[0] as PrincipalRow;
}

function nameInUse(snapshot: AccessSnapshot, name: string): boolean {
  const key = nameKey(name);
  return snapshot.principals.some(
    (row) => row.state === "active" && nameKey(displayNameOf(snapshot, row.id) ?? "") === key,
  );
}

function isRole(value: unknown): value is Role {
  return (ROLES as readonly unknown[]).includes(value);
}

function liveHomeOwnerGrants(snapshot: AccessSnapshot, now: number): GrantRow[] {
  return snapshot.grants.filter(
    (grant) =>
      grant.role === "owner" && grant.scope === "home" && isLiveGrant(snapshot, grant, now),
  );
}

const HOME_OWNER_REASON =
  "This is the Home's owner, who keeps their access, their sign-in link on this computer and Home's own token.";

function requireSnapshot(state: Planning): AccessSnapshot {
  if (state.snapshot === undefined) throw new Error("access-control: no snapshot to plan over");
  return state.snapshot;
}

function linkSubjectRef(key: CryptoKey, subject: string): Promise<string> {
  return keyedDigest(key, LINK_SUBJECT_LABEL, [subject]);
}

async function subjectKey(root: string, create: boolean): Promise<CryptoKey | Refusal> {
  const file = accessPaths().subjectKey;
  const read = create ? await ensureDigestKey(root, { file }) : await readDigestKey(root, { file });
  if (read.state === "present") return read.hmac;
  return refusal(
    "unreadable",
    read.state === "absent"
      ? "The link key is missing."
      : `The link key cannot be read: ${read.reason}.`,
  );
}

/** A new member or service, with its display name in the subjects file. */
function newPrincipal(
  state: Planning,
  kind: PrincipalKind,
  displayName: string,
  subjects: ReturnType<typeof withNamesOf>,
): PrincipalRow {
  const row: PrincipalRow = {
    id: mintId("prn"),
    kind,
    state: "active",
    at: state.at,
    by: state.by,
  };
  subjects.principals[row.id] = { displayName };
  return row;
}

/** A member named for a change: resolved, or created when `create` and the name is free. */
function memberFor(
  state: Planning,
  ref: string,
  create: boolean,
  subjects: ReturnType<typeof withNamesOf>,
): { row: PrincipalRow; created: boolean } | Refusal {
  const snapshot = requireSnapshot(state);
  if (create) {
    const name = checkDisplayName(ref);
    if (isRefusal(name)) return name;
    if (nameInUse(snapshot, name)) {
      return refusal(
        "conflict",
        `The name "${name}" is already in use; leave out --create to use it.`,
      );
    }
    return { row: newPrincipal(state, "member", name, subjects), created: true };
  }
  const row = resolvePrincipal(snapshot, ref);
  if (isRefusal(row)) {
    return row.code === "not-found" && !isId("prn", ref)
      ? refusal("not-found", `No one here is named "${ref.trim()}". Add --create to add them.`)
      : row;
  }
  if (row.kind === "service") {
    return refusal(
      "invalid",
      "A service holds no roles or links: give its token permissions with `crewhaus access mint`.",
    );
  }
  return { row, created: false };
}

function expiryAfter(at: number, ttlMs: number): string {
  return new Date(at + ttlMs).toISOString();
}

function checkTtl(
  ttlMs: number | undefined,
  bounds: { readonly default: number; readonly max: number },
  what: string,
): number | Refusal {
  const ttl = ttlMs ?? bounds.default;
  if (!Number.isFinite(ttl) || ttl <= 0) return refusal("invalid", `${what} must last some time.`);
  if (ttl > bounds.max) {
    return refusal("invalid", `${what} can last at most ${Math.round(bounds.max / DAY_MS)} days.`);
  }
  return ttl;
}

// ---------------------------------------------------------------------------
// Setup (the bootstrap migration)
// ---------------------------------------------------------------------------

export type SetUpInput = {
  readonly localActor: string;
  readonly now?: () => number;
  /** The owner's display name; the user part of the local actor by default. */
  readonly displayName?: string;
};

export type BootstrapOutcome =
  | "recorded"
  | "already-recorded"
  | "no-token"
  | "empty-token"
  | "unreadable";

export type SetUpResult = {
  /** The home owner. */
  readonly owner: string;
  /** The principal the local actor is linked to; `undefined` for another user of this computer. */
  readonly localPrincipal: string | undefined;
  /** What this call added. Empty when everything was already there. */
  readonly created: readonly ("owner" | "local-link" | "bootstrap")[];
  readonly bootstrap: BootstrapOutcome;
};

function defaultDisplayName(localActor: string): string {
  return localActor.slice("local:".length, localActor.lastIndexOf("@"));
}

/** Whether two local actors name the same OS user name, whatever the host. */
function sameLocalUser(a: string, b: string): boolean {
  if (!LOCAL_ACTOR_RE.test(a) || !LOCAL_ACTOR_RE.test(b)) return false;
  const userA = defaultDisplayName(a);
  const userB = defaultDisplayName(b);
  // Windows user names ignore case.
  return process.platform === "win32"
    ? userA.toLowerCase() === userB.toLowerCase()
    : userA === userB;
}

/**
 * Whether the Hangar root belongs to the OS user running this process. Where there are no
 * numeric user ids (Windows), the user name alone decides, and this answers `true`.
 */
function rootBelongsToCaller(root: string): boolean {
  const getuid = process.getuid;
  if (typeof getuid !== "function") return true;
  try {
    return statSync(root).uid === getuid.call(process);
  } catch {
    return false;
  }
}

/**
 * Make sure `<hangarRoot>/access` has an owner, idempotently and piece by piece, under the
 * access lock: the owner principal and its `owner` grant over the whole Home, a `local`
 * link from the local actor (its readable subject only in `subjects.json`), and, when
 * `<hangarRoot>/token` holds a token, its sha256 as the `bootstrap` credential. The token
 * file is only read. A piece already there is left alone; a later call adds a missing one.
 * When the owner's OS user comes back under another computer name, and the Hangar root
 * belongs to that user, the new name is linked to the owner as well; another user name
 * never is.
 *
 * First consumer: every mutating `crewhaus access` verb, before its change.
 */
export async function ensureAccessSetUp(
  hangarRoot: string,
  input: SetUpInput,
): Promise<Done<SetUpResult> | Refusal> {
  const { localActor } = input;
  if (!LOCAL_ACTOR_RE.test(localActor)) {
    return refusal("invalid", "The local identity is not a local actor.");
  }
  const displayName = checkDisplayName(input.displayName ?? defaultDisplayName(localActor));
  const ownerName = isRefusal(displayName) ? defaultDisplayName(localActor) : displayName;
  try {
    mkdirSync(hangarRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    return refusal("io-error", `Home's directory could not be created: ${(err as Error).message}`);
  }
  const ctx = contextFor(hangarRoot, { now: input.now });
  let minted: string | undefined;
  return runMutation<SetUpResult>(
    ctx,
    undefined,
    async (state) => {
      const snapshot = state.snapshot;
      const subjects = withNamesOf(snapshot?.subjects ?? EMPTY_SUBJECTS);
      const rows: Change<SetUpResult>["rows"][number][] = [];
      const created: SetUpResult["created"][number][] = [];
      const owner = snapshot?.owner ?? (minted as string);
      if (snapshot?.owner === undefined) {
        rows.push({
          kind: "principals",
          row: { id: owner, kind: "member", state: "active", at: state.at, by: owner },
        });
        rows.push({
          kind: "grants",
          row: {
            id: mintId("grt"),
            principal: owner,
            role: "owner",
            scope: "home",
            grantedBy: owner,
            state: "active",
            at: state.at,
            by: owner,
          },
        });
        subjects.principals[owner] = { displayName: ownerName };
        created.push("owner");
      }
      const ownerLocalLinks = (snapshot?.links ?? []).filter(
        (link) => link.principal === owner && link.provider === "local" && link.state === "active",
      );
      const ownerLinked = ownerLocalLinks.length > 0;
      // The same OS user under a new computer name (a network change can rename the host):
      // link the new name too, when the user part matches and the Home's directory is theirs.
      const renamedHost =
        ownerLinked &&
        snapshot !== undefined &&
        localPrincipalOf(snapshot, localActor) === undefined &&
        ownerLocalLinks.some((link) => {
          const linked = snapshot.subjects.links[link.id];
          return linked !== undefined && sameLocalUser(linked, localActor);
        }) &&
        rootBelongsToCaller(hangarRoot);
      if (!ownerLinked || renamedHost) {
        const key = await subjectKey(hangarRoot, true);
        if (isRefusal(key)) return key;
        const link: LinkRow = {
          id: mintId("lnk"),
          principal: owner,
          provider: "local",
          subjectRef: await linkSubjectRef(key, localActor),
          verifiedVia: "bootstrap",
          state: "active",
          at: state.at,
          by: owner,
        };
        rows.push({ kind: "links", row: link });
        subjects.links[link.id] = localActor;
        created.push("local-link");
      }
      let bootstrap: BootstrapOutcome = "already-recorded";
      const recorded = (snapshot?.tokens ?? []).some(
        (credential) => credential.kind === "bootstrap" && credential.state === "active",
      );
      if (!recorded) {
        const token = readBootstrapToken(hangarRoot);
        bootstrap =
          token.state === "present"
            ? "recorded"
            : token.state === "absent"
              ? "no-token"
              : token.state === "empty"
                ? "empty-token"
                : "unreadable";
        if (token.state === "present") {
          const credential: CredentialRow = {
            id: mintId("crd"),
            principal: owner,
            kind: "bootstrap",
            sha256: await sha256Hex(token.token),
            state: "active",
            at: state.at,
            by: owner,
          };
          rows.push({ kind: "credentials", row: credential });
          created.push("bootstrap");
        }
      }
      const localPrincipal =
        ownerLinked && !renamedHost
          ? snapshot === undefined
            ? undefined
            : localPrincipalOf(snapshot, localActor)
          : owner;
      return {
        rows,
        subjects: { v: 1, ...subjects },
        result: { owner, localPrincipal, created, bootstrap },
      };
    },
    {
      projections: false,
      setup: {
        by: (snapshot) => {
          if (snapshot?.owner !== undefined) return snapshot.owner;
          minted ??= mintId("prn");
          return minted;
        },
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export type InviteInput = {
  readonly role: string;
  readonly scope: string;
  /** How long the code works: 24 hours by default, at most 7 days. */
  readonly ttlMs?: number;
};

export type InviteResult = { readonly invite: InviteView; readonly code: string };

async function createInvite(
  ctx: AccessContext,
  actor: AccessActor,
  input: InviteInput,
): Promise<Done<InviteResult> | Refusal> {
  if (!isRole(input.role)) return refusal("invalid", `"${input.role}" is not a role.`);
  if (!isGrantScope(input.scope)) return refusal("invalid", `"${input.scope}" is not a scope.`);
  const ttl = checkTtl(input.ttlMs, INVITE_TTL_MS, "An invite");
  if (isRefusal(ttl)) return ttl;
  const role = input.role;
  return runMutation<InviteResult>(
    ctx,
    actor,
    async (state) => {
      const code = mintIssuedSecret("invite");
      const row: InviteRow = {
        id: mintId("inv"),
        role,
        scope: input.scope,
        sha256: await sha256Hex(code),
        expiresAt: expiryAfter(state.now, ttl),
        createdBy: state.by,
        state: "open",
        at: state.at,
        by: state.by,
      };
      return {
        rows: [{ kind: "invites", row }],
        result: { invite: inviteView(row, state.now), code },
      };
    },
    { projections: false },
  );
}

export type RedeemRefusalCode =
  | "unknown"
  | "expired"
  | "revoked"
  | "consumed"
  | "unreadable"
  | "io-error";

export type RedeemAnswer =
  | { readonly ok: true; readonly invite: InviteView; readonly epoch: number }
  | { readonly ok: false; readonly code: RedeemRefusalCode; readonly reason: string };

export type RedeemOptions = {
  readonly now?: () => number;
  /** The principal the code is redeemed for, when the caller has minted one. */
  readonly principal?: string;
};

const REDEEM_REASONS: Readonly<Record<RedeemRefusalCode, string>> = Object.freeze({
  unknown: "That invite code is not one this Home issued.",
  expired: "That invite has expired. Ask for a new one.",
  revoked: "That invite was withdrawn. Ask for a new one.",
  consumed: "That invite has already been used.",
  unreadable: "The access records cannot be read.",
  "io-error": "The invite could not be redeemed.",
});

function redeemRefusal(code: RedeemRefusalCode, detail?: string): RedeemAnswer {
  return {
    ok: false,
    code,
    reason: detail === undefined ? REDEEM_REASONS[code] : `${REDEEM_REASONS[code]} ${detail}`,
  };
}

/**
 * Spend an invite code once. It is looked up by its digest; an unknown, expired, revoked
 * or used code is refused. The claim on the invite's end decides: only the caller answered
 * `ok: true` may act on it. It creates no member and issues nothing; accepting an invite
 * (a member, a grant, a device, a session) is the caller's.
 *
 * First consumer: the invite-acceptance route, later in this release; nothing calls it yet.
 */
export async function redeemInvite(
  hangarRoot: string,
  code: string,
  options: RedeemOptions = {},
): Promise<RedeemAnswer> {
  const now = (options.now ?? Date.now)();
  if (typeof code !== "string" || !ISSUED_SECRET_RES.invite.test(code))
    return redeemRefusal("unknown");
  if (options.principal !== undefined && !isId("prn", options.principal)) {
    return redeemRefusal("unknown");
  }
  const read = loadAccessSnapshot(hangarRoot);
  if (read.state === "unreadable") return redeemRefusal("unreadable");
  if (read.state === "absent") return redeemRefusal("unknown");
  const digest = await sha256Hex(code);
  const invite = read.snapshot.invites.find((row) => row.sha256 === digest);
  if (invite === undefined) return redeemRefusal("unknown");
  if (invite.state === "consumed") return redeemRefusal("consumed");
  if (invite.state === "revoked") return redeemRefusal("revoked");
  if (hasPassed(invite.expiresAt, now)) return redeemRefusal("expired");
  // An invite is only as good as its creator's authority to manage access, now.
  if (!mayManageAccess(read.snapshot, invite.createdBy, now)) return redeemRefusal("revoked");
  const at = new Date(now).toISOString();
  const by = options.principal ?? "sys:executor";
  const row: InviteRow = {
    ...invite,
    state: "consumed",
    consumedAt: at,
    at,
    by,
    ...(options.principal !== undefined ? { principal: options.principal } : {}),
  };
  const ledger = accessLedger(hangarRoot, "invites");
  // appendClaim takes the access lock itself: no lock is held here.
  const claimed = await appendClaim(ledger, { claim: inviteEndClaim(invite.id), record: row });
  if (!claimed.ok) return redeemRefusal("io-error", claimed.reason);
  if (!claimed.won) {
    return redeemRefusal(claimed.winner.record["state"] === "revoked" ? "revoked" : "consumed");
  }
  const bumped = await withLedgerLock(ledger, () => {
    const revision = readRevision(hangarRoot);
    if (revision.state === "unreadable") return { ok: false as const, reason: revision.reason };
    const epoch = (revision.state === "present" ? revision.value.epoch : 0) + 1;
    const written = writeRevision(hangarRoot, epoch, at);
    return written.ok ? { ok: true as const, epoch } : written;
  });
  if (!bumped.ok) return redeemRefusal("io-error", bumped.reason);
  return { ok: true, invite: inviteView(row, now), epoch: bumped.epoch };
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export type GrantInput = {
  /** `prn_…` or a display name. */
  readonly member: string;
  /** Make a member with this display name and no credential. */
  readonly create?: boolean;
  readonly role: string;
  readonly scope: string;
  readonly expiresAt?: string;
};

export type GrantResult = {
  readonly grant: GrantView;
  readonly principal: string;
  readonly displayName?: string;
  readonly createdMember: boolean;
};

/**
 * Only a viewer grant can carry an end time: who may approve is copied into each harness,
 * and that copy names no end time, so a role that may approve is given without one.
 */
const EXPIRING_ROLE_REASON =
  "Only the viewer role can be given with an end date. Give this role without --expires, and revoke it when it should end.";

async function grantRole(
  ctx: AccessContext,
  actor: AccessActor,
  input: GrantInput,
): Promise<Done<GrantResult> | Refusal> {
  if (!isRole(input.role)) return refusal("invalid", `"${input.role}" is not a role.`);
  if (!isGrantScope(input.scope)) return refusal("invalid", `"${input.scope}" is not a scope.`);
  const role = input.role;
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) {
    return refusal("invalid", "The expiry is not a time.");
  }
  if (input.expiresAt !== undefined && role !== "viewer") {
    return refusal("invalid", EXPIRING_ROLE_REASON);
  }
  return runMutation<GrantResult>(
    ctx,
    actor,
    (state) => {
      const snapshot = requireSnapshot(state);
      if (input.expiresAt !== undefined && hasPassed(input.expiresAt, state.now)) {
        return refusal("invalid", "The expiry has already passed.");
      }
      const subjects = withNamesOf(snapshot.subjects);
      const member = memberFor(state, input.member, input.create === true, subjects);
      if (isRefusal(member)) return member;
      const row: GrantRow = {
        id: mintId("grt"),
        principal: member.row.id,
        role,
        scope: input.scope,
        grantedBy: state.by,
        ...(input.expiresAt !== undefined
          ? { expiresAt: new Date(input.expiresAt).toISOString() }
          : {}),
        state: "active",
        at: state.at,
        by: state.by,
      };
      const rows: Change<GrantResult>["rows"][number][] = [];
      if (member.created) rows.push({ kind: "principals", row: member.row });
      rows.push({ kind: "grants", row });
      const displayName = subjects.principals[member.row.id]?.displayName;
      return {
        rows,
        ...(member.created ? { subjects: { v: 1, ...subjects } } : {}),
        result: {
          grant: {
            id: row.id,
            principal: row.principal,
            role: row.role,
            scope: row.scope,
            grantedBy: row.grantedBy,
            at: row.at,
            ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
            state: "active",
            live: true,
          },
          principal: member.row.id,
          ...(displayName !== undefined ? { displayName } : {}),
          createdMember: member.created,
        },
      };
    },
    { projections: true },
  );
}

// ---------------------------------------------------------------------------
// Revocation and removal
// ---------------------------------------------------------------------------

export type RevokeResult =
  | { readonly kind: "grant"; readonly grant: GrantView }
  | { readonly kind: "invite"; readonly invite: InviteView }
  | { readonly kind: "token"; readonly token: TokenView };

function ended<T extends { state: string }>(row: T, state: Planning): T & { revokedAt: string } {
  return { ...row, state: "revoked", revokedAt: state.at, at: state.at, by: state.by };
}

function mayManageAccess(
  snapshot: AccessSnapshot,
  principal: string,
  now: number,
  domains?: ReadonlyMap<string, DomainChecker>,
): boolean {
  return (
    authorize(snapshot, { principal }, "home.access.manage", HOME, {
      now,
      ...(domains !== undefined ? { domains } : {}),
    }).allow === true
  );
}

/**
 * The open invites a principal created, each ended through the claim a redemption also
 * publishes, so ending one cannot race spending it. One already spent or withdrawn is
 * left out of the change, not a reason to refuse it.
 */
function openInvitesBy(snapshot: AccessSnapshot, creator: string, state: Planning): PlannedClaim[] {
  return snapshot.invites
    .filter((invite) => invite.createdBy === creator && invite.state === "open")
    .map((invite) => ({
      kind: "invites" as const,
      claim: inviteEndClaim(invite.id),
      row: ended(invite, state),
      taken: "skip" as const,
    }));
}

async function revokeById(
  ctx: AccessContext,
  actor: AccessActor,
  id: string,
): Promise<Done<RevokeResult> | Refusal> {
  const kind = parseId(id)?.prefix;
  if (kind !== "grt" && kind !== "inv" && kind !== "crd") {
    return refusal(
      "invalid",
      "Revoke takes a grant (grt_…), an invite (inv_…) or a token (crd_…).",
    );
  }
  return runMutation<RevokeResult>(
    ctx,
    actor,
    (state) => {
      const snapshot = requireSnapshot(state);
      if (kind === "grt") {
        const grant = snapshot.grants.find((row) => row.id === id);
        if (grant === undefined) return refusal("not-found", "No grant has that id.");
        if (grant.state !== "active") return refusal("ended", "That grant is already revoked.");
        const live = isLiveGrant(snapshot, grant, state.now);
        if (live && grant.role === "owner" && grant.scope === "home") {
          if (
            liveHomeOwnerGrants(snapshot, state.now).filter((row) => row.id !== id).length === 0
          ) {
            return refusal(
              "lockout",
              "This is the last owner of this Home: revoking it would lock everyone out.",
            );
          }
        }
        if (grant.id === snapshot.ownerGrant) return refusal("home-owner", HOME_OWNER_REASON);
        const row = ended(grant, state);
        // An invite works only while whoever created it may still manage access.
        const after: AccessSnapshot = {
          ...snapshot,
          grants: snapshot.grants.map((other) => (other.id === id ? row : other)),
        };
        const invites = mayManageAccess(snapshot, grant.principal, state.now, ctx.domains)
          ? mayManageAccess(after, grant.principal, state.now, ctx.domains)
            ? []
            : openInvitesBy(snapshot, grant.principal, state)
          : [];
        return {
          rows: [{ kind: "grants", row }],
          claims: invites,
          result: { kind: "grant", grant: grantView(snapshot, row, state.now) },
        };
      }
      if (kind === "inv") {
        const invite = snapshot.invites.find((row) => row.id === id);
        if (invite === undefined) return refusal("not-found", "No invite has that id.");
        if (invite.state === "consumed")
          return refusal("ended", "That invite has already been used.");
        if (invite.state === "revoked")
          return refusal("ended", "That invite is already withdrawn.");
        const row = ended(invite, state);
        return {
          rows: [],
          claims: [
            {
              kind: "invites",
              claim: inviteEndClaim(id),
              row,
              taken: refusal("ended", "That invite has already been used or withdrawn."),
            },
          ],
          result: { kind: "invite", invite: inviteView(row, state.now) },
        };
      }
      const credential = snapshot.tokens.find((row) => row.id === id);
      if (credential === undefined) return refusal("not-found", "No token has that id.");
      if (credential.kind === "bootstrap") {
        return refusal("home-owner", "Home's own sign-in token cannot be revoked here.");
      }
      if (credential.state !== "active") return refusal("ended", "That token is already revoked.");
      const row = ended(credential, state);
      return {
        rows: [{ kind: "credentials", row }],
        result: { kind: "token", token: tokenView(snapshot, row, state.now) },
      };
    },
    { projections: kind !== "inv" },
  );
}

export type RemoveResult = {
  readonly principal: string;
  readonly revoked: {
    readonly grants: number;
    readonly tokens: number;
    readonly links: number;
    /** Open invites they created, withdrawn with them. */
    readonly invites: number;
  };
};

async function removeMember(
  ctx: AccessContext,
  actor: AccessActor,
  member: string,
): Promise<Done<RemoveResult> | Refusal> {
  return runMutation<RemoveResult>(
    ctx,
    actor,
    (state) => {
      const snapshot = requireSnapshot(state);
      const target = resolvePrincipal(snapshot, member);
      if (isRefusal(target)) return target;
      if (target.id === snapshot.owner) return refusal("home-owner", HOME_OWNER_REASON);
      const grants = snapshot.grants.filter(
        (row) => row.principal === target.id && row.state === "active",
      );
      const remaining = liveHomeOwnerGrants(snapshot, state.now).filter(
        (row) => row.principal !== target.id,
      );
      if (remaining.length === 0) {
        return refusal(
          "lockout",
          "This is the last owner of this Home: removing them would lock everyone out.",
        );
      }
      const credentials = snapshot.tokens.filter(
        (row) => row.principal === target.id && row.state === "active",
      );
      const links = snapshot.links.filter((row) => row.principal === target.id);
      const invites = openInvitesBy(snapshot, target.id, state);
      const subjects = withNamesOf(snapshot.subjects);
      delete subjects.principals[target.id];
      for (const link of links) delete subjects.links[link.id];
      const rows = [
        ...grants.map((row) => ({ kind: "grants" as const, row: ended(row, state) })),
        ...credentials.map((row) => ({ kind: "credentials" as const, row: ended(row, state) })),
        ...links
          .filter((row) => row.state === "active")
          .map((row) => ({ kind: "links" as const, row: ended(row, state) })),
        {
          kind: "principals" as const,
          row: { ...target, state: "removed", at: state.at, by: state.by },
        },
      ];
      return {
        rows,
        claims: invites,
        subjects: { v: 1, ...subjects },
        result: {
          principal: target.id,
          revoked: {
            grants: grants.length,
            tokens: credentials.length,
            links: links.filter((row) => row.state === "active").length,
            invites: invites.length,
          },
        },
      };
    },
    { projections: true },
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type LinkInput = {
  /** `slack:<team>:<user>`, `github:<numeric id>` or `proxy:<header>:<value>`. */
  readonly subject: string;
  /** `prn_…` or a display name. */
  readonly member: string;
  readonly create?: boolean;
};

export type LinkResult = {
  readonly link: LinkView;
  readonly principal: string;
  readonly displayName?: string;
  readonly createdMember: boolean;
};

async function linkSubject(
  ctx: AccessContext,
  actor: AccessActor,
  input: LinkInput,
): Promise<Done<LinkResult> | Refusal> {
  const provider = parseLinkSubject(input.subject);
  if (provider === null || provider === "local") {
    return refusal(
      "invalid",
      "A link is slack:<team>:<user>, github:<numeric id> or proxy:<header>:<value>.",
    );
  }
  return runMutation<LinkResult>(
    ctx,
    actor,
    async (state) => {
      const snapshot = requireSnapshot(state);
      const key = await subjectKey(ctx.root, true);
      if (isRefusal(key)) return key;
      const subjectRef = await linkSubjectRef(key, input.subject);
      const holder = snapshot.links.find(
        (row) => row.state === "active" && row.subjectRef === subjectRef,
      );
      if (holder !== undefined) {
        const name = displayNameOf(snapshot, holder.principal) ?? holder.principal;
        return refusal("conflict", `${input.subject} is already linked to ${name}.`);
      }
      const subjects = withNamesOf(snapshot.subjects);
      const member = memberFor(state, input.member, input.create === true, subjects);
      if (isRefusal(member)) return member;
      const row: LinkRow = {
        id: mintId("lnk"),
        principal: member.row.id,
        provider,
        subjectRef,
        verifiedVia: "owner",
        state: "active",
        at: state.at,
        by: state.by,
      };
      subjects.links[row.id] = input.subject;
      const rows: Change<LinkResult>["rows"][number][] = [];
      if (member.created) rows.push({ kind: "principals", row: member.row });
      rows.push({ kind: "links", row });
      const displayName = subjects.principals[member.row.id]?.displayName;
      return {
        rows,
        subjects: { v: 1, ...subjects },
        result: {
          link: linkView(row),
          principal: member.row.id,
          ...(displayName !== undefined ? { displayName } : {}),
          createdMember: member.created,
        },
      };
    },
    { projections: true },
  );
}

async function unlinkSubject(
  ctx: AccessContext,
  actor: AccessActor,
  ref: string,
): Promise<Done<{ readonly link: LinkView }> | Refusal> {
  const byId = isId("lnk", ref);
  const provider = byId ? undefined : parseLinkSubject(ref);
  if (!byId && provider === null) {
    return refusal(
      "invalid",
      "Unlink takes a link id (lnk_…) or a linked identity such as slack:T0:U0.",
    );
  }
  return runMutation<{ readonly link: LinkView }>(
    ctx,
    actor,
    async (state) => {
      const snapshot = requireSnapshot(state);
      let link: LinkRow | undefined;
      if (byId) {
        link = snapshot.links.find((row) => row.id === ref);
      } else {
        const key = await subjectKey(ctx.root, false);
        if (isRefusal(key)) return refusal("not-found", "Nothing is linked to that identity.");
        const subjectRef = await linkSubjectRef(key, ref);
        link = snapshot.links.find(
          (row) => row.state === "active" && row.subjectRef === subjectRef,
        );
      }
      if (link === undefined) return refusal("not-found", "Nothing is linked to that identity.");
      if (link.state !== "active") return refusal("ended", "That link is already removed.");
      if (link.provider === "local") return refusal("home-owner", HOME_OWNER_REASON);
      const subjects = withNamesOf(snapshot.subjects);
      delete subjects.links[link.id];
      const row = ended(link, state);
      return {
        rows: [{ kind: "links", row }],
        subjects: { v: 1, ...subjects },
        result: { link: linkView(row) },
      };
    },
    { projections: true },
  );
}

// ---------------------------------------------------------------------------
// Service tokens
// ---------------------------------------------------------------------------

export type MintInput = {
  /** The service's display name; a new name makes a new service. */
  readonly service: string;
  readonly permissions: readonly string[];
  /** `hrn_…` ids. With none, the token holds no harness permission. */
  readonly harnesses: readonly string[];
  readonly contentRead?: boolean;
  readonly subjectAssert?: boolean;
  /** 180 days by default, and no longer. */
  readonly ttlMs?: number;
};

export type MintResult = {
  readonly token: TokenView;
  /** The secret, shown once. Only its sha256 is kept. */
  readonly secret: string;
  readonly principal: string;
  readonly createdService: boolean;
};

function checkPermissions(permissions: readonly string[]): Permission[] | Refusal {
  const out = new Set<Permission>();
  for (const permission of permissions) {
    if (!isPermission(permission))
      return refusal("invalid", `"${permission}" is not a permission.`);
    if (PERMISSION_DECLS[permission].service === "never") {
      return refusal("invalid", `A service can never hold ${permission}.`);
    }
    if (permission === "h.read.content") {
      return refusal(
        "invalid",
        "Reading content is its own choice: set contentRead instead of listing h.read.content.",
      );
    }
    if (permission === "h.subject.assert") {
      return refusal(
        "invalid",
        "Naming a run's subject is its own choice: set subjectAssert instead of listing h.subject.assert.",
      );
    }
    out.add(permission);
  }
  return [...out].sort();
}

async function mintServiceToken(
  ctx: AccessContext,
  actor: AccessActor,
  input: MintInput,
): Promise<Done<MintResult> | Refusal> {
  const name = checkDisplayName(input.service);
  if (isRefusal(name)) return name;
  const permissions = checkPermissions(input.permissions);
  if (isRefusal(permissions)) return permissions;
  for (const harness of input.harnesses) {
    if (!isId("hrn", harness)) return refusal("invalid", `"${harness}" is not a harness id.`);
  }
  const harnesses = [...new Set(input.harnesses)].sort();
  const ttl = checkTtl(input.ttlMs, SERVICE_TOKEN_TTL_MS, "A service token");
  if (isRefusal(ttl)) return ttl;
  return runMutation<MintResult>(
    ctx,
    actor,
    async (state) => {
      const snapshot = requireSnapshot(state);
      const subjects = withNamesOf(snapshot.subjects);
      let principal: PrincipalRow;
      let created = false;
      const existing = resolvePrincipal(snapshot, name, "service");
      if (!isRefusal(existing)) {
        principal = existing;
      } else if (existing.code === "not-found") {
        if (nameInUse(snapshot, name)) {
          return refusal("conflict", `"${name}" is a member, not a service; choose another name.`);
        }
        principal = newPrincipal(state, "service", name, subjects);
        created = true;
      } else {
        return existing;
      }
      const secret = mintIssuedSecret("service");
      const row: CredentialRow = {
        id: mintId("crd"),
        principal: principal.id,
        kind: "service",
        sha256: await sha256Hex(secret),
        prefixHint: prefixHintOf(secret),
        ...(permissions.length > 0 ? { permissions } : {}),
        ...(harnesses.length > 0 ? { harnesses } : {}),
        ...(input.contentRead === true ? { contentRead: true as const } : {}),
        ...(input.subjectAssert === true ? { subjectAssert: true as const } : {}),
        expiresAt: expiryAfter(state.now, ttl),
        state: "active",
        at: state.at,
        by: state.by,
      };
      const rows: Change<MintResult>["rows"][number][] = [];
      if (created) rows.push({ kind: "principals", row: principal });
      rows.push({ kind: "credentials", row });
      const view = tokenView(snapshot, row, state.now);
      return {
        rows,
        ...(created ? { subjects: { v: 1, ...subjects } } : {}),
        result: {
          token: { ...view, displayName: name, live: true },
          secret,
          principal: principal.id,
          createdService: created,
        },
      };
    },
    { projections: true },
  );
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export type SyncResult = ProjectionReport & { readonly setUp: boolean };

/**
 * Bring every governed harness's projection to the records and registry as they are now,
 * under the access lock: a file that is absent, unreadable or different in content is
 * rewritten, and a current one is left alone whatever its epoch. When a file is ahead of
 * the revision, the revision first moves above it. Over a Home nobody else has access to,
 * it does nothing and creates nothing.
 *
 * First consumer: `crewhaus access sync`.
 */
async function syncProjections(
  ctx: AccessContext,
  actor: AccessActor,
): Promise<Done<SyncResult> | Refusal> {
  if (loadAccessSnapshot(ctx.root).state === "absent") {
    return {
      ok: true,
      result: { setUp: false, written: [], unchanged: [], failed: [] },
      epoch: 0,
      projections: { written: [], unchanged: [], failed: [] },
    };
  }
  let report: ProjectionReport | undefined;
  let synced: number | undefined;
  const done = await runMutation<SyncResult>(
    ctx,
    actor,
    (state) => {
      const snapshot = requireSnapshot(state);
      // A file ahead of the revision (one left after revision.json was lost) is replaced:
      // the revision moves above it first, so the rewrite is never behind it.
      let epoch = snapshot.epoch;
      const floor = projectionEpochFloor(ctx, state.now);
      if (floor > epoch) {
        const moved = writeRevision(ctx.root, floor + 1, state.at);
        if (!moved.ok) return refusal("io-error", `Nothing was changed: ${moved.reason}`);
        epoch = floor + 1;
      }
      synced = epoch;
      report = projectAfter(ctx, { epoch, now: state.now, by: state.by });
      return { rows: [], result: { setUp: true, ...report } };
    },
    { projections: false },
  );
  if (!done.ok) return done;
  return { ...done, epoch: synced ?? done.epoch, projections: report ?? done.projections };
}

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

export type OpenAccessOptions = {
  readonly now?: () => number;
  /** The registered harnesses; the CLI passes the registry's rows. */
  readonly harnesses?: () => readonly AccessHarness[];
};

function contextFor(
  root: string,
  options: OpenAccessOptions,
  domains: ReadonlyMap<string, DomainChecker> = new Map(),
): AccessContext {
  return {
    root,
    now: options.now ?? (() => Date.now()),
    harnesses: options.harnesses ?? (() => []),
    domains,
  };
}

const DOMAIN_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type AccessHandle = {
  readonly root: string;
  /** Hand every permission `<name>.…` to its own checker. A core prefix or a second registration throws. */
  registerDomain(name: string, checker: DomainChecker): void;
  /** `authorize()` with this handle's clock and domains. */
  authorize(
    snapshot: AccessSnapshotRead | AccessSnapshot,
    actor: AccessActor,
    permission: string,
    target: AccessTarget,
  ): AuthorizeVerdict;
  load(): AccessSnapshotRead;
  createInvite(actor: AccessActor, input: InviteInput): Promise<Done<InviteResult> | Refusal>;
  grant(actor: AccessActor, input: GrantInput): Promise<Done<GrantResult> | Refusal>;
  /** Revoke a grant, an invite or a service token by id. */
  revoke(actor: AccessActor, id: string): Promise<Done<RevokeResult> | Refusal>;
  /** Remove a member or service: every grant, token and link, and their names. */
  removeMember(actor: AccessActor, member: string): Promise<Done<RemoveResult> | Refusal>;
  link(actor: AccessActor, input: LinkInput): Promise<Done<LinkResult> | Refusal>;
  unlink(actor: AccessActor, ref: string): Promise<Done<{ readonly link: LinkView }> | Refusal>;
  mintServiceToken(actor: AccessActor, input: MintInput): Promise<Done<MintResult> | Refusal>;
  sync(actor: AccessActor): Promise<Done<SyncResult> | Refusal>;
};

/**
 * The access records of one Hangar root, with a clock, the registered harnesses for the
 * projection writer and a domain table of its own: two handles never share domains.
 *
 * First consumer: `crewhaus access` in direct mode.
 */
export function openAccess(hangarRoot: string, options: OpenAccessOptions = {}): AccessHandle {
  const domains = new Map<string, DomainChecker>();
  const ctx = contextFor(hangarRoot, options, domains);
  return {
    root: hangarRoot,
    registerDomain(name, checker) {
      if (!DOMAIN_NAME_RE.test(name))
        throw new TypeError(`access-control: "${name}" is not a domain name`);
      if (CORE_PERMISSION_PREFIXES.has(name)) {
        throw new TypeError(`access-control: "${name}" is a core permission prefix, not a domain`);
      }
      if (domains.has(name))
        throw new TypeError(`access-control: the domain "${name}" is already registered`);
      if (typeof checker !== "function")
        throw new TypeError("access-control: a domain needs a checker");
      domains.set(name, checker);
    },
    authorize: (snapshot, actor, permission, target) =>
      authorize(snapshot, actor, permission, target, { now: ctx.now(), domains }),
    load: () => loadAccessSnapshot(hangarRoot),
    createInvite: (actor, input) => createInvite(ctx, actor, input),
    grant: (actor, input) => grantRole(ctx, actor, input),
    revoke: (actor, id) => revokeById(ctx, actor, id),
    removeMember: (actor, member) => removeMember(ctx, actor, member),
    link: (actor, input) => linkSubject(ctx, actor, input),
    unlink: (actor, ref) => unlinkSubject(ctx, actor, ref),
    mintServiceToken: (actor, input) => mintServiceToken(ctx, actor, input),
    sync: (actor) => syncProjections(ctx, actor),
  };
}

export { HOME as HOME_TARGET };
