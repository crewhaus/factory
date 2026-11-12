/**
 * `crewhaus access`: who may use this Home, in direct mode. Every verb reads and writes
 * the access records under the Hangar root itself, through `@crewhaus/access-control`, so
 * it works with Home stopped and needs no credential: the OS user who owns the Home acts
 * as its owner. This module only parses and prints.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv switch and so
 * cannot be imported by a test without executing the CLI). Side-effect-free on import,
 * the shape of `harness-cmd.ts`: the environment, the clock, the OS identity and the
 * registry are injected, and each verb returns lines and an exit code. Bad arguments throw
 * plain `Error`s; the entry file routes them through `die()`.
 *
 * Reads (`members`, `tokens`) write nothing, and over a Home nobody else has access to
 * they print the single-owner view. Every other verb first makes sure the access records
 * exist, with this OS user as the owner, and refuses another user of this computer.
 */
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import {
  type AccessHandle,
  type AccessHarness,
  type Done,
  INVITE_TTL_MS,
  type LocalIdentity,
  type MemberView,
  PROXY_SECRET_HEADER,
  type ProjectionReport,
  type Refusal,
  SERVICE_TOKEN_TTL_MS,
  SETTINGS_FILENAME,
  type TokenView,
  ensureAccessSetUp,
  listInvites,
  listMembers,
  listTokens,
  loadAccessSnapshot,
  localActorOf,
  openAccess,
  parseCidr,
  readOwnerSettings,
  writeOwnerBlock,
} from "@crewhaus/access-control";
import { type HangarRegistry, openHangarRegistry } from "@crewhaus/harness-registry";
import { defaultIsPidAlive, readHangarLock, resolveHangarRoot } from "./hangar-cmd";

export type AccessCommandResult = {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
};

export type AccessCommandOptions = {
  /** Environment for the Hangar root and the registry; tests inject one. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (epoch ms); injected by tests. */
  readonly now?: () => number;
  /** The OS user acting; `os.userInfo().username` and `os.hostname()` by default. */
  readonly identity?: LocalIdentity;
  /** Opens the registry for reading; tests inject one. Its writes are always turned off. */
  readonly openRegistry?: (env: Readonly<Record<string, string | undefined>>) => HangarRegistry;
  /** Whether Home's process is alive; tests inject one. */
  readonly isPidAlive?: (pid: number) => boolean;
};

const ROLE_WORDS = ["viewer", "operator", "maintainer", "owner"] as const;

const ACCESS_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus access members [--json]            who has access to this Home, and how",
  "  crewhaus access invite --role <role> (--home | --group <g> | --harness <h>) [--expires <dur>]",
  "                                               a link that works once (24h by default, 7d at most)",
  "  crewhaus access grant --member <name|id> --role <role> (--home | --group <g> | --harness <h>)",
  "       [--expires <dur>] [--create]            give someone a role; --create adds them by name;",
  "                                               only the viewer role takes --expires",
  "  crewhaus access revoke <grt_…|inv_…|crd_…>   take back a grant, an invite or a token",
  "  crewhaus access revoke --member <name|id>    remove someone, with their grants, tokens and links",
  "  crewhaus access link <slack:T:U|github:N|proxy:H:V> --member <name|id|me> [--create]",
  "                                               connect an outside account to someone",
  "  crewhaus access unlink <lnk_…|account>       disconnect it",
  "  crewhaus access tokens [--json]              tokens: kind, hint, expiry and state",
  "  crewhaus access mint --service <name> --permission <p>... [--harness <h>...] [--content]",
  "       [--subject] [--expires <dur>]           a service token, shown once (180d at most)",
  "  crewhaus access sync                         rewrite each harness's list of who may approve;",
  "                                               run it after you change a harness's groups",
  "  crewhaus access proxy                        how Home trusts a reverse proxy, if it does",
  "  crewhaus access proxy --header <h> --peer <cidr>... --host <name>... [--socket]",
  "                                               trust a proxy's identity header: from the listed",
  "                                               peers with a secret it sends (shown once), or",
  "                                               over Home's proxy socket with --socket",
  "  crewhaus access proxy --off                  stop trusting it",
  "",
  "  Roles: viewer, operator, maintainer, owner. <h> is a harness id or directory, and",
  "  <dur> is like 30m, 24h or 7d. These verbs work with Home stopped; a proxy change",
  "  takes effect when Home next starts.",
];

// ---------------------------------------------------------------------------
// Argument parsing (harness-cmd posture: throw plain Errors)
// ---------------------------------------------------------------------------

type FlagKind = "value" | "values" | "boolean";
type FlagSpec = Readonly<Record<string, FlagKind>>;

type Args = {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
};

function parseArgs(verb: string, argv: readonly string[], spec: FlagSpec): Args {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = spec[name];
    if (kind === undefined) {
      const known = Object.keys(spec).map((key) => `--${key}`);
      throw new Error(
        `access ${verb}: unknown flag "${arg}"${known.length > 0 ? ` (expected: ${known.join(", ")})` : ""}`,
      );
    }
    if (kind === "boolean") {
      booleans.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`access ${verb}: ${arg} needs a value`);
    i++;
    const list = values.get(name) ?? [];
    if (kind === "value" && list.length > 0) {
      throw new Error(`access ${verb}: ${arg} can be given once`);
    }
    list.push(value);
    values.set(name, list);
  }
  return { positional, values, booleans };
}

const one = (args: Args, name: string): string | undefined => args.values.get(name)?.[0];
const many = (args: Args, name: string): readonly string[] => args.values.get(name) ?? [];

function noPositional(verb: string, args: Args, allowed = 0): void {
  if (args.positional.length > allowed) {
    throw new Error(`access ${verb}: unexpected argument "${args.positional[allowed]}"`);
  }
}

function requireValue(verb: string, args: Args, name: string): string {
  const value = one(args, name);
  if (value === undefined) throw new Error(`access ${verb}: --${name} is required`);
  return value;
}

function roleOf(verb: string, raw: string): (typeof ROLE_WORDS)[number] {
  const role = ROLE_WORDS.find((word) => word === raw);
  if (role === undefined) {
    throw new Error(
      `access ${verb}: --role must be one of ${ROLE_WORDS.join(", ")} (got "${raw}")`,
    );
  }
  return role;
}

const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30m`, `24h`, `7d` in milliseconds. Anything else names the expected form. */
export function parseDuration(raw: string): number {
  const match = /^([1-9][0-9]{0,5})([mhd])$/.exec(raw);
  if (match === null) {
    throw new Error(`--expires takes a duration like 30m, 24h or 7d (got "${raw}")`);
  }
  return Number(match[1]) * (UNIT_MS[match[2] as string] as number);
}

function boundedDuration(raw: string | undefined, maxMs: number, what: string): number | undefined {
  if (raw === undefined) return undefined;
  const ms = parseDuration(raw);
  if (ms > maxMs) throw new Error(`${what} lasts at most ${Math.round(maxMs / 86_400_000)} days`);
  return ms;
}

// ---------------------------------------------------------------------------
// The session: root, identity, registry and handle
// ---------------------------------------------------------------------------

type Session = {
  readonly root: string;
  readonly now: () => number;
  readonly localActor: string;
  readonly username: string;
  readonly registry: () => HangarRegistry;
  readonly access: AccessHandle;
  readonly isPidAlive: (pid: number) => boolean;
};

function defaultIdentity(env: Readonly<Record<string, string | undefined>>): LocalIdentity {
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    username = env["USER"] ?? env["USERNAME"] ?? "";
  }
  return { username, hostname: hostname() };
}

function sessionFor(opts: AccessCommandOptions): Session {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => Date.now());
  const identity = opts.identity ?? defaultIdentity(env);
  // This verb never writes the registry: `list()` would persist missing-directory stamps.
  const readOnlyEnv = { ...env, CREWHAUS_NO_REGISTRY: "1" };
  let registry: HangarRegistry | undefined;
  const openRegistry = (): HangarRegistry => {
    registry ??= opts.openRegistry
      ? opts.openRegistry(readOnlyEnv)
      : openHangarRegistry({ env: readOnlyEnv, now });
    return registry;
  };
  const harnesses = (): readonly AccessHarness[] =>
    openRegistry()
      .list()
      .map((entry) => ({ id: entry.id, dir: entry.dir, groups: entry.groups }));
  const root = resolveHangarRoot(env);
  return {
    root,
    now,
    localActor: localActorOf(identity),
    username: identity.username,
    registry: openRegistry,
    access: openAccess(root, { now, harnesses }),
    isPidAlive: opts.isPidAlive ?? defaultIsPidAlive,
  };
}

/** `<hrn_…|dir>` to a registered harness id, through `registry.get` (which persists nothing). */
function harnessIdOf(session: Session, ref: string): string {
  const entry = session.registry().get(ref);
  if (entry === undefined) {
    throw new Error(
      `"${ref}" is not a registered harness: register it with \`crewhaus harness add <dir>\``,
    );
  }
  return entry.id;
}

function harnessName(session: Session, id: string): string {
  try {
    return session.registry().get(id)?.specName ?? id;
  } catch {
    return id;
  }
}

function scopeOf(verb: string, session: Session, args: Args): string {
  const chosen = [
    args.booleans.has("home") ? "home" : undefined,
    one(args, "group") !== undefined ? "group" : undefined,
    one(args, "harness") !== undefined ? "harness" : undefined,
  ].filter((value) => value !== undefined);
  if (chosen.length !== 1) {
    throw new Error(`access ${verb}: choose one of --home, --group <name> or --harness <id|dir>`);
  }
  if (args.booleans.has("home")) return "home";
  const group = one(args, "group");
  if (group !== undefined) {
    if (
      !session
        .registry()
        .listGroups()
        .some((def) => def.name === group)
    ) {
      throw new Error(`no group named "${group}": see \`crewhaus harness group\``);
    }
    return `group:${group}`;
  }
  return `harness:${harnessIdOf(session, one(args, "harness") as string)}`;
}

function scopeText(session: Session, scope: string): string {
  if (scope === "home") return "all of this Home";
  if (scope.startsWith("group:")) return `the group "${scope.slice("group:".length)}"`;
  return harnessName(session, scope.slice("harness:".length));
}

const dayOf = (iso: string): string => iso.slice(0, 10);

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function refused(answer: Refusal, before: readonly string[] = []): AccessCommandResult {
  return { lines: [...before, answer.reason], exitCode: 1 };
}

/** The lines a change ends with: one per harness whose approver list could not be updated. */
function projectionLines(session: Session, report: ProjectionReport): string[] {
  if (report.failed.length === 0) return [];
  return [
    ...report.failed.map(
      (failure) =>
        `Could not update who may approve on ${harnessName(session, failure.harness)}: ${failure.reason}.`,
    ),
    "The change is recorded. Once that is fixed, run `crewhaus access sync`.",
  ];
}

function finish(
  session: Session,
  done: Done<unknown>,
  lines: readonly string[],
): AccessCommandResult {
  const tail = projectionLines(session, done.projections);
  return { lines: [...lines, ...tail], exitCode: tail.length > 0 ? 1 : 0 };
}

function jsonLines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}

/** Set up the records if needed, and answer the principal this OS user acts as. */
async function actingPrincipal(
  session: Session,
): Promise<{ principal: string; lines: string[] } | Refusal> {
  const setup = await ensureAccessSetUp(session.root, {
    localActor: session.localActor,
    now: session.now,
    ...(session.username !== "" ? { displayName: session.username } : {}),
  });
  if (!setup.ok) return setup;
  const principal = setup.result.localPrincipal;
  if (principal === undefined) {
    return {
      ok: false,
      code: "not-authorized",
      reason: "This Home belongs to another user on this computer.",
    };
  }
  const lines = setup.result.created.includes("owner")
    ? ["Access is set up for this Home, with you as its owner."]
    : [];
  return { principal, lines };
}

function memberRef(ref: string, me: string): string {
  return ref === "me" ? me : ref;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ONLY_YOU = "Only you have access to this Home.";

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  slack: "Slack",
  github: "GitHub",
  proxy: "proxy sign-in",
};

function memberLine(session: Session, member: MemberView, tokens: readonly TokenView[]): string {
  const name = member.displayName ?? member.id;
  if (member.kind === "service") {
    const live = tokens.filter((token) => token.principal === member.id && token.live).length;
    return `${name} (service): ${live === 1 ? "1 token" : `${live} tokens`}`;
  }
  const roles = member.grants.map((grant) => {
    const until = grant.expiresAt === undefined ? "" : ` until ${dayOf(grant.expiresAt)}`;
    const ended = grant.live ? "" : " (expired)";
    return `${grant.role} on ${scopeText(session, grant.scope)}${until}${ended}`;
  });
  const providers = [
    ...new Set(
      member.links
        .filter((link) => link.provider !== "local")
        .map((link) => PROVIDER_NAMES[link.provider] ?? link.provider),
    ),
  ];
  const who = member.homeOwner ? `${name} (Home's owner)` : name;
  const linked = providers.length > 0 ? `; linked: ${providers.join(", ")}` : "";
  return `${who}: ${roles.length > 0 ? roles.join(", ") : "no role"}${linked}`;
}

function membersVerb(session: Session, argv: readonly string[]): AccessCommandResult {
  const args = parseArgs("members", argv, { json: "boolean" });
  noPositional("members", args);
  const json = args.booleans.has("json");
  const read = loadAccessSnapshot(session.root);
  if (read.state === "unreadable") {
    return { lines: [`The access records cannot be read: ${read.reason}.`], exitCode: 1 };
  }
  if (read.state === "absent") {
    return json
      ? { lines: jsonLines({ members: [], invites: [], singleOwner: true }), exitCode: 0 }
      : { lines: [ONLY_YOU], exitCode: 0 };
  }
  const now = session.now();
  const members = listMembers(read.snapshot, now);
  const invites = listInvites(read.snapshot, now).filter((invite) => invite.live);
  const tokens = listTokens(read.snapshot, now);
  const singleOwner =
    members.length === 1 && members[0]?.homeOwner === true && invites.length === 0;
  if (json) return { lines: jsonLines({ members, invites, singleOwner }), exitCode: 0 };
  if (singleOwner) {
    const owner = members[0] as MemberView;
    const linked = owner.links.some((link) => link.provider !== "local");
    return {
      lines: linked ? [ONLY_YOU, memberLine(session, owner, tokens)] : [ONLY_YOU],
      exitCode: 0,
    };
  }
  const lines = members.map((member) => memberLine(session, member, tokens));
  for (const invite of invites) {
    lines.push(
      `Open invite: ${invite.role} on ${scopeText(session, invite.scope)}, until ${dayOf(invite.expiresAt)}`,
    );
  }
  lines.push("", "`crewhaus access members --json` shows the ids `revoke` takes.");
  return { lines, exitCode: 0 };
}

function tokensVerb(session: Session, argv: readonly string[]): AccessCommandResult {
  const args = parseArgs("tokens", argv, { json: "boolean" });
  noPositional("tokens", args);
  const json = args.booleans.has("json");
  const read = loadAccessSnapshot(session.root);
  if (read.state === "unreadable") {
    return { lines: [`The access records cannot be read: ${read.reason}.`], exitCode: 1 };
  }
  const tokens = read.state === "present" ? listTokens(read.snapshot, session.now()) : [];
  if (json) return { lines: jsonLines({ tokens }), exitCode: 0 };
  const shown = tokens.filter((token) => token.kind === "service");
  if (shown.length === 0) {
    return {
      lines: ["No access tokens yet. Home's own sign-in token is managed by `crewhaus hangar`."],
      exitCode: 0,
    };
  }
  return {
    lines: shown.map((token) => {
      const state = token.live ? "active" : token.state === "revoked" ? "revoked" : "expired";
      const until = token.expiresAt === undefined ? "" : `, until ${dayOf(token.expiresAt)}`;
      return `${token.displayName ?? token.principal} (service): ${token.prefixHint ?? "chs_"}…, ${state}${until}`;
    }),
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

async function inviteVerb(session: Session, argv: readonly string[]): Promise<AccessCommandResult> {
  const args = parseArgs("invite", argv, {
    role: "value",
    home: "boolean",
    group: "value",
    harness: "value",
    expires: "value",
  });
  noPositional("invite", args);
  const role = roleOf("invite", requireValue("invite", args, "role"));
  const ttlMs = boundedDuration(one(args, "expires"), INVITE_TTL_MS.max, "an invite");
  const scope = scopeOf("invite", session, args);
  const acting = await actingPrincipal(session);
  if ("ok" in acting) return refused(acting);
  const done = await session.access.createInvite(
    { principal: acting.principal },
    { role, scope, ...(ttlMs !== undefined ? { ttlMs } : {}) },
  );
  if (!done.ok) return refused(done, acting.lines);
  const path = `/invite#c=${done.result.code}`;
  const lock = readHangarLock(session.root);
  const running =
    lock !== undefined && lock.url !== "" && session.isPidAlive(lock.pid)
      ? `${lock.url.replace(/\/+$/, "")}${path}`
      : undefined;
  return finish(session, done, [
    ...acting.lines,
    `Invite for a ${role} on ${scopeText(session, scope)}. It works once, until ${dayOf(done.result.invite.expiresAt)}:`,
    running ?? path,
    ...(running === undefined ? ["Home is not running: open this path on Home's address."] : []),
    "This is the only time the link is shown.",
  ]);
}

async function grantVerb(session: Session, argv: readonly string[]): Promise<AccessCommandResult> {
  const args = parseArgs("grant", argv, {
    member: "value",
    role: "value",
    home: "boolean",
    group: "value",
    harness: "value",
    expires: "value",
    create: "boolean",
  });
  noPositional("grant", args);
  const ref = requireValue("grant", args, "member");
  const role = roleOf("grant", requireValue("grant", args, "role"));
  const ttlMs = boundedDuration(one(args, "expires"), Number.MAX_SAFE_INTEGER, "a grant");
  const scope = scopeOf("grant", session, args);
  const acting = await actingPrincipal(session);
  if ("ok" in acting) return refused(acting);
  const done = await session.access.grant(
    { principal: acting.principal },
    {
      member: memberRef(ref, acting.principal),
      create: args.booleans.has("create"),
      role,
      scope,
      ...(ttlMs !== undefined ? { expiresAt: new Date(session.now() + ttlMs).toISOString() } : {}),
    },
  );
  if (!done.ok) return refused(done, acting.lines);
  const { grant, displayName, createdMember } = done.result;
  const name = displayName ?? done.result.principal;
  const until = grant.expiresAt === undefined ? "" : ` until ${dayOf(grant.expiresAt)}`;
  return finish(session, done, [
    ...acting.lines,
    ...(createdMember ? [`Added ${name} as a member.`] : []),
    `${name} is now ${role === "operator" || role === "owner" ? "an" : "a"} ${role} on ${scopeText(session, scope)}${until}.`,
    `To undo: crewhaus access revoke ${grant.id}`,
  ]);
}

async function revokeVerb(session: Session, argv: readonly string[]): Promise<AccessCommandResult> {
  const args = parseArgs("revoke", argv, { member: "value" });
  const member = one(args, "member");
  if (member !== undefined) {
    noPositional("revoke", args);
  } else {
    noPositional("revoke", args, 1);
    if (args.positional[0] === undefined) {
      throw new Error("access revoke: name a grant, invite or token id, or --member <name|id>");
    }
  }
  const acting = await actingPrincipal(session);
  if ("ok" in acting) return refused(acting);
  const actor = { principal: acting.principal };
  if (member !== undefined) {
    const done = await session.access.removeMember(actor, memberRef(member, acting.principal));
    if (!done.ok) return refused(done, acting.lines);
    const { grants, tokens, links, invites } = done.result.revoked;
    const parts = [
      grants === 1 ? "1 grant" : `${grants} grants`,
      tokens === 1 ? "1 token" : `${tokens} tokens`,
      links === 1 ? "1 link" : `${links} links`,
      ...(invites > 0 ? [invites === 1 ? "1 open invite" : `${invites} open invites`] : []),
    ];
    return finish(session, done, [
      ...acting.lines,
      `Removed ${member}: ${parts.join(", ")} revoked, and their name and linked accounts erased.`,
    ]);
  }
  const done = await session.access.revoke(actor, args.positional[0] as string);
  if (!done.ok) return refused(done, acting.lines);
  const result = done.result;
  const line =
    result.kind === "grant"
      ? `Revoked the ${result.grant.role} role on ${scopeText(session, result.grant.scope)}.`
      : result.kind === "invite"
        ? "Withdrew the invite. Its link no longer works."
        : `Revoked the token ${result.token.prefixHint ?? "chs_"}….`;
  return finish(session, done, [...acting.lines, line]);
}

async function linkVerb(session: Session, argv: readonly string[]): Promise<AccessCommandResult> {
  const args = parseArgs("link", argv, { member: "value", create: "boolean" });
  noPositional("link", args, 1);
  const subject = args.positional[0];
  if (subject === undefined) {
    throw new Error(
      "access link: name the account: slack:<team>:<user>, github:<numeric id> or proxy:<header>:<value>",
    );
  }
  const ref = requireValue("link", args, "member");
  const acting = await actingPrincipal(session);
  if ("ok" in acting) return refused(acting);
  const done = await session.access.link(
    { principal: acting.principal },
    { subject, member: memberRef(ref, acting.principal), create: args.booleans.has("create") },
  );
  if (!done.ok) return refused(done, acting.lines);
  const name = done.result.displayName ?? done.result.principal;
  return finish(session, done, [
    ...acting.lines,
    ...(done.result.createdMember ? [`Added ${name} as a member.`] : []),
    `Linked ${subject} to ${name}.`,
  ]);
}

async function unlinkVerb(session: Session, argv: readonly string[]): Promise<AccessCommandResult> {
  const args = parseArgs("unlink", argv, {});
  noPositional("unlink", args, 1);
  const ref = args.positional[0];
  if (ref === undefined)
    throw new Error("access unlink: name a link id (lnk_…) or a linked account");
  const acting = await actingPrincipal(session);
  if ("ok" in acting) return refused(acting);
  const done = await session.access.unlink({ principal: acting.principal }, ref);
  if (!done.ok) return refused(done, acting.lines);
  return finish(session, done, [
    ...acting.lines,
    "Unlinked. That account no longer acts for anyone here.",
  ]);
}

async function mintVerb(session: Session, argv: readonly string[]): Promise<AccessCommandResult> {
  const args = parseArgs("mint", argv, {
    service: "value",
    permission: "values",
    harness: "values",
    content: "boolean",
    subject: "boolean",
    expires: "value",
  });
  noPositional("mint", args);
  const service = requireValue("mint", args, "service");
  const permissions = many(args, "permission");
  if (permissions.length === 0) throw new Error("access mint: give at least one --permission");
  const ttlMs = boundedDuration(one(args, "expires"), SERVICE_TOKEN_TTL_MS.max, "a service token");
  const harnesses = many(args, "harness").map((ref) => harnessIdOf(session, ref));
  const acting = await actingPrincipal(session);
  if ("ok" in acting) return refused(acting);
  const done = await session.access.mintServiceToken(
    { principal: acting.principal },
    {
      service,
      permissions,
      harnesses,
      contentRead: args.booleans.has("content"),
      subjectAssert: args.booleans.has("subject"),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    },
  );
  if (!done.ok) return refused(done, acting.lines);
  const { token, secret, createdService } = done.result;
  return finish(session, done, [
    ...acting.lines,
    ...(createdService ? [`Added the service ${service}.`] : []),
    `Token for ${service}, shown this once and kept only as a hash:`,
    secret,
    ...(token.expiresAt !== undefined ? [`It works until ${dayOf(token.expiresAt)}.`] : []),
    ...(harnesses.length === 0 ? ["It names no harness, so it can act on none."] : []),
  ]);
}

async function syncVerb(session: Session, argv: readonly string[]): Promise<AccessCommandResult> {
  const args = parseArgs("sync", argv, {});
  noPositional("sync", args);
  const read = loadAccessSnapshot(session.root);
  if (read.state === "absent") {
    return { lines: [`${ONLY_YOU} There is nothing to sync.`], exitCode: 0 };
  }
  if (read.state === "unreadable") {
    return { lines: [`The access records cannot be read: ${read.reason}.`], exitCode: 1 };
  }
  const acting = await actingPrincipal(session);
  if ("ok" in acting) return refused(acting);
  const done = await session.access.sync({ principal: acting.principal });
  if (!done.ok) return refused(done, acting.lines);
  const { written, unchanged, failed } = done.result;
  const governed = written.length + unchanged.length + failed.length;
  const lines = [
    ...acting.lines,
    governed === 0
      ? "No harness has anyone else who may approve, so there is nothing to write."
      : failed.length === 0
        ? `Updated ${written.length} of ${governed} approver lists; the rest were current.`
        : `Updated ${written.length} of ${governed} approver lists.`,
  ];
  return finish(session, done, lines);
}

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const HOST_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** The `access` block of the Hangar settings file as it is now, or `{}`. */
function accessBlockOf(root: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(root, SETTINGS_FILENAME), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const access = (raw as Record<string, unknown>)["access"];
    return typeof access === "object" && access !== null && !Array.isArray(access)
      ? { ...(access as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

/**
 * `crewhaus access proxy`: print, set or remove `access.trustedProxy` in the Hangar
 * settings. Only this Home's owner may change it, and Home reads it when it starts.
 */
async function proxyVerb(session: Session, argv: readonly string[]): Promise<AccessCommandResult> {
  const args = parseArgs("proxy", argv, {
    header: "value",
    peer: "values",
    host: "values",
    socket: "boolean",
    off: "boolean",
  });
  noPositional("proxy", args);
  const header = one(args, "header");
  const peers = many(args, "peer");
  const hosts = many(args, "host");
  const writing =
    header !== undefined || peers.length > 0 || hosts.length > 0 || args.booleans.has("socket");
  if (!writing && !args.booleans.has("off")) {
    const read = readOwnerSettings(session.root);
    if (!read.ok) return { lines: [read.reason], exitCode: 1 };
    const proxy = read.settings.trustedProxy;
    if (proxy === undefined) {
      return {
        lines: ["Home trusts no reverse proxy: it signs every browser in itself."],
        exitCode: 0,
      };
    }
    return {
      lines: [
        `Home trusts the ${proxy.header} header from a reverse proxy:`,
        `  peers  ${proxy.peers.length > 0 ? proxy.peers.join(", ") : "(none)"}`,
        `  names  ${proxy.hosts.length > 0 ? proxy.hosts.join(", ") : "(none)"}`,
        `  proof  ${proxy.socket === true ? `Home's proxy socket (${join(session.root, "proxy.sock")})` : `the ${PROXY_SECRET_HEADER} header it sends`}`,
      ],
      exitCode: 0,
    };
  }
  if (writing && args.booleans.has("off")) {
    throw new Error(
      "access proxy: --off cannot be combined with --header, --peer, --host or --socket",
    );
  }
  const acting = await actingPrincipal(session);
  if ("ok" in acting) return refused(acting);
  const before = accessBlockOf(session.root);
  if (args.booleans.has("off")) {
    const { trustedProxy: _gone, ...rest } = before;
    writeOwnerBlock(session.root, "access", Object.keys(rest).length > 0 ? rest : undefined);
    return {
      lines: [
        ...acting.lines,
        "Home no longer trusts a reverse proxy. Restart Home for this to take effect.",
      ],
      exitCode: 0,
    };
  }
  if (header === undefined || !HEADER_RE.test(header)) {
    throw new Error("access proxy: --header names the header your proxy sets, like X-Auth-User");
  }
  const socket = args.booleans.has("socket");
  if (socket && process.platform === "win32") {
    throw new Error(
      "access proxy: --socket needs a unix socket, which Home does not create on Windows",
    );
  }
  if (!socket && peers.length === 0) {
    throw new Error(
      "access proxy: give the proxy's address with --peer <cidr> (127.0.0.1/32 for one on this computer)",
    );
  }
  for (const peer of peers) {
    if (parseCidr(peer) === undefined)
      throw new Error(`access proxy: --peer "${peer}" is not a CIDR block`);
  }
  for (const host of hosts) {
    if (!HOST_RE.test(host)) throw new Error(`access proxy: --host "${host}" is not a host name`);
  }
  const secret = socket
    ? undefined
    : Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const trustedProxy: Record<string, unknown> = {
    header: header.toLowerCase(),
    peers: [...peers],
    hosts: hosts.map((host) => host.toLowerCase()),
    ...(secret !== undefined ? { secretDigest: await sha256Hex(secret) } : {}),
    ...(socket ? { socket: true } : {}),
  };
  writeOwnerBlock(session.root, "access", { ...before, trustedProxy });
  const check = readOwnerSettings(session.root);
  if (!check.ok) {
    writeOwnerBlock(session.root, "access", Object.keys(before).length > 0 ? before : undefined);
    return { lines: [`Nothing was changed: ${check.reason}`], exitCode: 1 };
  }
  const lines = [
    ...acting.lines,
    `Home will trust the ${header.toLowerCase()} header as the person signing in, and only from your proxy.`,
  ];
  if (secret !== undefined) {
    lines.push(
      "Configure the proxy to send this header on every request it passes to Home:",
      `  ${PROXY_SECRET_HEADER}: ${secret}`,
      "It is shown this once; Home keeps only a hash of it.",
    );
  } else {
    lines.push(`Point the proxy at Home's proxy socket: ${join(session.root, "proxy.sock")}`);
  }
  lines.push(
    "Each person still needs a link: `crewhaus access link proxy:<header>:<name> --member <name>`.",
    "Restart Home for this to take effect.",
  );
  return { lines, exitCode: 0 };
}

/**
 * Run one `crewhaus access` verb. Bare `access`, `--help` and `-h` print usage.
 */
export async function runAccessCommand(
  argv: readonly string[],
  opts: AccessCommandOptions = {},
): Promise<AccessCommandResult> {
  const verb = argv[0] ?? "";
  if (verb === "" || verb === "--help" || verb === "-h" || verb === "help") {
    return { lines: ACCESS_USAGE_LINES, exitCode: 0 };
  }
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h"))
    return { lines: ACCESS_USAGE_LINES, exitCode: 0 };
  const session = sessionFor(opts);
  switch (verb) {
    case "members":
      return membersVerb(session, rest);
    case "tokens":
      return tokensVerb(session, rest);
    case "invite":
      return inviteVerb(session, rest);
    case "grant":
      return grantVerb(session, rest);
    case "revoke":
      return revokeVerb(session, rest);
    case "link":
      return linkVerb(session, rest);
    case "unlink":
      return unlinkVerb(session, rest);
    case "mint":
      return mintVerb(session, rest);
    case "sync":
      return syncVerb(session, rest);
    case "proxy":
      return proxyVerb(session, rest);
    default:
      throw new Error(
        `access: unknown verb "${verb}" (expected: members, invite, grant, revoke, link, unlink, tokens, mint, sync, proxy)`,
      );
  }
}
