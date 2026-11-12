/**
 * Signing a browser in: device keys and sessions, behind one handle per running Home.
 *
 * A browser on this computer arrives through a boot ticket, which this handle trades for
 * a single-use exchange code (60 seconds). The browser makes a non-extractable ECDSA
 * P-256 key, sends its public half with the code and an ephemeral seal key, and gets a
 * session sealed to it. A returning browser asks for a challenge (a single-use nonce, 60
 * seconds), signs it with its device key, and gets a new session the same way.
 *
 * A session's secret (`cha_…`) is never stored: `sessions.jsonl` keeps its sha256, and a
 * bearer is looked up by that digest, never by comparing secrets. A session lasts one
 * hour from its last use and twelve hours at most; the sliding deadline is kept in memory,
 * starting from the session's row after a restart, so a read writes nothing. A device is
 * unusable 30 days after it last signed in.
 *
 * Appending a device or a session changes nobody's authority, so it does not move the
 * access revision, and neither does a refresh (same principal, device and deadline).
 * Signing out, revoking a device and rotating Home's key do. The handle keeps a
 * sha256-keyed index of sessions and re-reads `sessions.jsonl` when its size or the
 * revision changes, so a rotation by the CLI in another process is seen on the next
 * request.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { ISSUED_SECRET_RES, canonicalJson, isId, mintId } from "@crewhaus/control-contract";
import {
  ensureDigestKey,
  keyedDigest,
  readDigestKey,
  withLedgerLock,
} from "@crewhaus/control-records";
import { appendContained } from "@crewhaus/tool-safety/fs";
import { ensureAccessSetUp } from "./access";
import { type BootTickets, createBootTickets } from "./bootstrap";
import { readRevision, sealTornLine, writeRevision } from "./files";
import { nextEpoch } from "./mutate";
import { accessLedger, accessPaths } from "./paths";
import { type Issued, type SealedOperation, sealSecret } from "./sealed";
import { mintIssuedSecret, sha256Hex } from "./secrets";
import {
  type DeviceJwk,
  type DeviceRow,
  SESSION_MAX_MS,
  type SessionEndReason,
  type SessionRow,
  foldSignIn,
  isDeviceJwk,
} from "./sign-in-records";
import { type AccessSnapshotRead, isActivePrincipal, loadAccessSnapshot } from "./snapshot";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The lifetimes of everything sign-in keeps.
 *
 * First consumer: Home's sign-in routes, which report `expiresAt` from them.
 */
export const SIGN_IN_LIMITS = Object.freeze({
  /** A session ends this long after its last use. */
  sessionIdleMs: HOUR_MS,
  /** …and this long after it was first issued, however busy. A refresh keeps the deadline. */
  sessionMaxMs: SESSION_MAX_MS,
  /** A device key is unusable this long after it last signed in. */
  deviceIdleMs: 30 * DAY_MS,
  /** An exchange code and a challenge each work once, within this. */
  codeTtlMs: MINUTE_MS,
  /** At most this many exchange codes, and this many challenges, live at once. */
  cap: 256,
});

/** The keyed-digest purpose of a peer address in `security.jsonl`. A pin. */
const SECURITY_PEER_LABEL = "access.security.peer";

export type SignInRefusalReason =
  | "code_unknown"
  | "challenge_unknown"
  | "device_unknown"
  | "device_revoked"
  | "device_expired"
  | "signature_invalid"
  | "session_unknown"
  | "session_expired"
  | "invalid"
  | "unavailable";

export type SignInRefusal = {
  readonly ok: false;
  readonly code: "unauthenticated" | "invalid" | "unavailable";
  readonly status: 400 | 401 | 503;
  readonly reason: SignInRefusalReason;
  /** One sentence for the person; names no secret. */
  readonly message: string;
};

export type SessionIssue = {
  readonly ok: true;
  readonly issued: Issued;
  readonly expiresAt: string;
  readonly principal: string;
  readonly device: string;
};

export type BearerCheck =
  | {
      readonly ok: true;
      readonly principal: string;
      readonly sessionRef: string;
      readonly device: string;
    }
  | { readonly ok: false; readonly reason: "session_unknown" | "session_expired" };

/** How a session that a stream watches came to an end. */
export type SessionEnd = "expired" | "revoked";

export type SignInOptions = {
  readonly now?: () => number;
  /** The OS user running Home, as `local:<user>@<host>`; set-up runs as it. */
  readonly localActor: string;
};

export type SignInHandle = {
  readonly root: string;
  /** A fresh `/boot/<nonce>` path. */
  mintBootTicket(): string;
  /** Spend a boot ticket for a single-use exchange code; `undefined` for a bad ticket. */
  mintExchangeCode(bootNonce: string): string | undefined;
  exchange(input: {
    readonly code: string;
    readonly deviceJwk: DeviceJwk;
    readonly seal: DeviceJwk;
  }): Promise<SessionIssue | SignInRefusal>;
  challenge(): { readonly nonce: string; readonly expiresAt: string };
  signInWithDevice(input: {
    readonly device: string;
    readonly nonce: string;
    readonly signature: string;
    readonly seal: DeviceJwk;
  }): Promise<SessionIssue | SignInRefusal>;
  refresh(sessionRef: string, seal: DeviceJwk): Promise<SessionIssue | SignInRefusal>;
  signOut(sessionRef: string): Promise<{ readonly signedOut: true } | SignInRefusal>;
  verifyBearer(secret: string): Promise<BearerCheck>;
  /** Call `cb` once when this session ends. Answers the unsubscribe. */
  onEnd(sessionRef: string, cb: (end: SessionEnd) => void): () => void;
  /** End every watched session that has expired or was ended elsewhere. Writes nothing. */
  checkSessions(): void;
  /** The access records, reloaded only when the access revision moves. */
  snapshot(): AccessSnapshotRead;
  /** The Hangar root's subject key, or `undefined` while there is none. */
  subjectKey(): Promise<CryptoKey | undefined>;
  /**
   * Record, at most once per peer per hour, that a proxy identity header from a request
   * that could not prove it came from the proxy was ignored. The line holds no address.
   */
  noteIgnoredIdentity(listener: string, address: string | null): Promise<void>;
  /** Live exchange codes and challenges: what the caps bound. */
  pending(): { readonly codes: number; readonly challenges: number };
};

function refused(
  reason: SignInRefusalReason,
  message: string,
  status: 400 | 401 | 503 = 401,
): SignInRefusal {
  const code = status === 400 ? "invalid" : status === 503 ? "unavailable" : "unauthenticated";
  return { ok: false, code, status, reason, message };
}

const AGAIN = "Sign in again with a link from `crewhaus hangar open`.";

function randomCode(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** A map used as a single-use store: oldest entries pruned past the cap. */
function capped(map: Map<string, number>, now: number, cap: number): void {
  for (const [key, expiry] of map) if (expiry <= now) map.delete(key);
  while (map.size >= cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/** Take a single-use value: deleted before its expiry is checked. */
function spend(map: Map<string, number>, key: string, now: number): boolean {
  const expiry = map.get(key);
  if (expiry === undefined) return false;
  map.delete(key);
  return expiry > now;
}

/** The bytes a device signs to sign in: canonical JSON, so both halves agree byte for byte. */
export function signedPayload(input: {
  readonly device: string;
  readonly nonce: string;
  readonly seal: DeviceJwk;
}): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({
      v: 1,
      op: "auth.session",
      device: input.device,
      nonce: input.nonce,
      seal: { kty: input.seal.kty, crv: input.seal.crv, x: input.seal.x, y: input.seal.y },
    }),
  );
}

async function verifyDeviceSignature(
  jwk: DeviceJwk,
  payload: Uint8Array,
  signature: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes, payload);
  } catch {
    return false;
  }
}

type Index = {
  readonly key: string;
  readonly bySha: ReadonlyMap<string, SessionRow>;
  readonly sessions: ReadonlyMap<string, SessionRow>;
  readonly devices: ReadonlyMap<string, DeviceRow>;
  readonly lastIssued: ReadonlyMap<string, number>;
};

function sizeOf(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return -1;
  }
}

/**
 * The sign-in handle over one Hangar root. It opens no socket: Home mounts the routes and
 * hands each request's parts in.
 *
 * First consumer: Home's sign-in routes (`hangar-server`).
 */
export function openSignIn(hangarRoot: string, options: SignInOptions): SignInHandle {
  const now = options.now ?? Date.now;
  const paths = accessPaths();
  const tickets: BootTickets = createBootTickets();
  const codes = new Map<string, number>();
  const challenges = new Map<string, number>();
  const lastUse = new Map<string, number>();
  const watchers = new Map<string, Set<(end: SessionEnd) => void>>();
  const securityLogged = new Map<string, number>();
  let index: Index | undefined;
  let snapshotCache: { readonly key: string; readonly read: AccessSnapshotRead } | undefined;
  let keyCache: CryptoKey | undefined;

  const revisionKey = (): string => {
    const revision = readRevision(hangarRoot);
    return revision.state === "present"
      ? `${revision.value.epoch}:${revision.value.at}`
      : revision.state;
  };

  const loadIndex = (): Index | undefined => {
    const key = [
      sizeOf(join(hangarRoot, paths.signIn.sessions)),
      sizeOf(join(hangarRoot, paths.signIn.devices)),
      revisionKey(),
    ].join("|");
    if (index?.key === key) return index;
    const fold = foldSignIn(hangarRoot);
    if (!fold.ok) return index;
    const bySha = new Map<string, SessionRow>();
    for (const row of fold.sessions.values()) bySha.set(row.sha256, row);
    index = {
      key,
      bySha,
      sessions: fold.sessions,
      devices: fold.devices,
      lastIssued: fold.lastIssued,
    };
    return index;
  };

  const snapshot = (): AccessSnapshotRead => {
    const key = revisionKey();
    if (snapshotCache?.key === key) return snapshotCache.read;
    const read = loadAccessSnapshot(hangarRoot);
    snapshotCache = { key, read };
    return read;
  };

  /** Why a session row no longer counts at `at`, or `undefined` while it does. */
  const sessionEnd = (row: SessionRow, devices: ReadonlyMap<string, DeviceRow>, at: number) => {
    if (row.state !== "active") return "revoked" as const;
    if (devices.get(row.device)?.state !== "active") return "revoked" as const;
    if (Date.parse(row.expiresAt) <= at) return "expired" as const;
    const last = lastUse.get(row.id) ?? Date.parse(row.at);
    if (at - last >= SIGN_IN_LIMITS.sessionIdleMs) return "expired" as const;
    return undefined;
  };

  const fire = (sessionRef: string, end: SessionEnd): void => {
    const set = watchers.get(sessionRef);
    if (set === undefined) return;
    watchers.delete(sessionRef);
    for (const cb of set) {
      try {
        cb(end);
      } catch {
        // A watcher that throws must not keep the others from hearing.
      }
    }
  };

  /** Append sign-in rows under the access lock; move the revision only when asked. */
  const write = async (
    rows: ReadonlyArray<{ readonly kind: "devices" | "sessions"; readonly row: object }>,
    moveRevision: boolean,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    try {
      const locked = await withLedgerLock(accessLedger(hangarRoot, "principals"), () => {
        for (const { kind, row } of rows) {
          const sealed = sealTornLine(hangarRoot, paths.signIn[kind]);
          if (!sealed.ok) return { ok: false as const, reason: sealed.reason };
          const appended = appendContained(
            hangarRoot,
            paths.signIn[kind],
            `${JSON.stringify(row)}\n`,
            { mode: 0o600, hardLinks: "refuse" },
          );
          if (!appended.ok) return { ok: false as const, reason: appended.reason };
        }
        if (moveRevision) {
          const revision = readRevision(hangarRoot);
          if (revision.state === "unreadable")
            return { ok: false as const, reason: revision.reason };
          const at = now();
          const epoch = nextEpoch(
            { root: hangarRoot, now, harnesses: () => [], domains: new Map() },
            revision.state === "present" ? revision.value.epoch : 0,
            at,
          );
          const moved = writeRevision(hangarRoot, epoch, new Date(at).toISOString());
          if (!moved.ok) return moved;
        }
        return { ok: true as const };
      });
      if ("path" in locked && locked.ok === false) return { ok: false, reason: locked.reason };
      return locked as { readonly ok: true } | { readonly ok: false; readonly reason: string };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  /** Issue a session to `device`, sealed for `op`. */
  const issue = async (
    input: {
      readonly principal: string;
      readonly device: string;
      readonly seal: DeviceJwk;
      readonly expiresAt?: string;
      readonly enrol?: DeviceRow;
      readonly ending?: SessionRow;
    },
    op: SealedOperation,
  ): Promise<{ readonly answer: SessionIssue | SignInRefusal; readonly sessionRef?: string }> => {
    const at = now();
    const iso = new Date(at).toISOString();
    const secret = mintIssuedSecret("session");
    const expiresAt = input.expiresAt ?? new Date(at + SIGN_IN_LIMITS.sessionMaxMs).toISOString();
    const row: SessionRow = {
      id: mintId("crd"),
      state: "active",
      at: iso,
      by: input.principal,
      principal: input.principal,
      device: input.device,
      sha256: await sha256Hex(secret),
      expiresAt,
    };
    let issued: Issued;
    try {
      issued = await sealSecret(input.seal, secret, op);
    } catch {
      return { answer: refused("invalid", "The seal key is not a P-256 public key.", 400) };
    }
    const rows: Array<{ kind: "devices" | "sessions"; row: object }> = [];
    if (input.enrol !== undefined) rows.push({ kind: "devices", row: input.enrol });
    if (input.ending !== undefined) {
      const ended: SessionRow = {
        ...input.ending,
        state: "ended",
        endedAt: iso,
        reason: "refreshed",
        at: iso,
        by: input.principal,
      };
      rows.push({ kind: "sessions", row: ended });
    }
    rows.push({ kind: "sessions", row });
    const written = await write(rows, false);
    if (!written.ok) {
      return {
        answer: refused("unavailable", `Signing in could not be recorded: ${written.reason}`, 503),
      };
    }
    lastUse.set(row.id, at);
    return {
      answer: { ok: true, issued, expiresAt, principal: input.principal, device: input.device },
      sessionRef: row.id,
    };
  };

  const deviceRefusal = (
    device: DeviceRow | undefined,
    current: Index | undefined,
    at: number,
  ): SignInRefusal | undefined => {
    if (device === undefined) {
      return refused("device_unknown", `This browser's key is not one this Home knows. ${AGAIN}`);
    }
    if (device.state !== "active") {
      return refused("device_revoked", `This browser's key was withdrawn. ${AGAIN}`);
    }
    const last = current?.lastIssued.get(device.id) ?? Date.parse(device.at);
    if (at - last >= SIGN_IN_LIMITS.deviceIdleMs) {
      return refused("device_expired", `This browser has not signed in for 30 days. ${AGAIN}`);
    }
    return undefined;
  };

  return {
    root: hangarRoot,
    mintBootTicket: () => tickets.mint(now()),
    mintExchangeCode(bootNonce) {
      if (tickets.consume(bootNonce, now()) === undefined) return undefined;
      const at = now();
      capped(codes, at, SIGN_IN_LIMITS.cap);
      const code = randomCode();
      codes.set(code, at + SIGN_IN_LIMITS.codeTtlMs);
      return code;
    },

    async exchange(input) {
      if (!isDeviceJwk(input.deviceJwk) || !isDeviceJwk(input.seal)) {
        return refused("invalid", "The request does not carry two P-256 public keys.", 400);
      }
      if (typeof input.code !== "string" || !spend(codes, input.code, now())) {
        return refused(
          "code_unknown",
          `That sign-in link was already used or has expired. ${AGAIN}`,
        );
      }
      const setup = await ensureAccessSetUp(hangarRoot, {
        localActor: options.localActor,
        now,
      });
      if (!setup.ok) {
        return refused("unavailable", `Home's access records are not usable: ${setup.reason}`, 503);
      }
      const at = new Date(now()).toISOString();
      const owner = setup.result.owner;
      const device: DeviceRow = {
        id: mintId("dev"),
        state: "active",
        at,
        by: owner,
        principal: owner,
        deviceJwk: {
          kty: "EC",
          crv: "P-256",
          x: input.deviceJwk.x,
          y: input.deviceJwk.y,
        },
      };
      return (
        await issue(
          { principal: owner, device: device.id, seal: input.seal, enrol: device },
          "auth.exchange",
        )
      ).answer;
    },

    challenge() {
      const at = now();
      capped(challenges, at, SIGN_IN_LIMITS.cap);
      const nonce = randomCode();
      const expiry = at + SIGN_IN_LIMITS.codeTtlMs;
      challenges.set(nonce, expiry);
      return { nonce, expiresAt: new Date(expiry).toISOString() };
    },

    async signInWithDevice(input) {
      if (!isDeviceJwk(input.seal) || !isId("dev", input.device)) {
        return refused("invalid", "The request does not name a device and a seal key.", 400);
      }
      if (typeof input.nonce !== "string" || !spend(challenges, input.nonce, now())) {
        return refused("challenge_unknown", "That sign-in challenge was already used or expired.");
      }
      const at = now();
      const current = loadIndex();
      const device = current?.devices.get(input.device);
      const refusal = deviceRefusal(device, current, at);
      if (refusal !== undefined || device === undefined) return refusal as SignInRefusal;
      const ok = await verifyDeviceSignature(
        device.deviceJwk,
        signedPayload(input),
        String(input.signature),
      );
      if (!ok)
        return refused("signature_invalid", `This browser's signature did not verify. ${AGAIN}`);
      const read = snapshot();
      if (read.state !== "present" || !isActivePrincipal(read.snapshot, device.principal)) {
        return refused("device_revoked", `This browser's key was withdrawn. ${AGAIN}`);
      }
      return (
        await issue(
          { principal: device.principal, device: device.id, seal: input.seal },
          "auth.session",
        )
      ).answer;
    },

    async refresh(sessionRef, seal) {
      if (!isDeviceJwk(seal)) return refused("invalid", "The seal is not a P-256 public key.", 400);
      const current = loadIndex();
      const row = current?.sessions.get(sessionRef);
      if (row === undefined || current === undefined) {
        return refused("session_unknown", `This session is not one this Home knows. ${AGAIN}`);
      }
      const end = sessionEnd(row, current.devices, now());
      if (end !== undefined) {
        return refused(
          end === "expired" ? "session_expired" : "session_unknown",
          `This session has ended. ${AGAIN}`,
        );
      }
      const { answer, sessionRef: fresh } = await issue(
        {
          principal: row.principal,
          device: row.device,
          seal,
          expiresAt: row.expiresAt,
          ending: row,
        },
        "auth.refresh",
      );
      if (answer.ok && fresh !== undefined) {
        // Streams opened with the old secret follow the session, not the secret.
        const moved = watchers.get(sessionRef);
        watchers.delete(sessionRef);
        lastUse.delete(sessionRef);
        if (moved !== undefined) {
          const set = watchers.get(fresh) ?? new Set();
          for (const cb of moved) set.add(cb);
          watchers.set(fresh, set);
        }
      }
      return answer;
    },

    async signOut(sessionRef) {
      const current = loadIndex();
      const row = current?.sessions.get(sessionRef);
      if (row === undefined) {
        return refused("session_unknown", "This session is not one this Home knows.");
      }
      if (row.state === "active") {
        const iso = new Date(now()).toISOString();
        const ended: SessionRow = {
          ...row,
          state: "ended",
          endedAt: iso,
          reason: "signed-out" satisfies SessionEndReason,
          at: iso,
          by: row.principal,
        };
        const written = await write([{ kind: "sessions", row: ended }], true);
        if (!written.ok) {
          return refused(
            "unavailable",
            `Signing out could not be recorded: ${written.reason}`,
            503,
          );
        }
      }
      lastUse.delete(sessionRef);
      fire(sessionRef, "revoked");
      return { signedOut: true };
    },

    async verifyBearer(secret) {
      if (typeof secret !== "string" || !ISSUED_SECRET_RES.session.test(secret)) {
        return { ok: false, reason: "session_unknown" };
      }
      const digest = await sha256Hex(secret);
      const current = loadIndex();
      const row = current?.bySha.get(digest);
      if (row === undefined || current === undefined)
        return { ok: false, reason: "session_unknown" };
      const at = now();
      const end = sessionEnd(row, current.devices, at);
      if (end !== undefined) {
        return { ok: false, reason: end === "expired" ? "session_expired" : "session_unknown" };
      }
      lastUse.set(row.id, at);
      return { ok: true, principal: row.principal, sessionRef: row.id, device: row.device };
    },

    onEnd(sessionRef, cb) {
      const set = watchers.get(sessionRef) ?? new Set();
      set.add(cb);
      watchers.set(sessionRef, set);
      return () => {
        watchers.get(sessionRef)?.delete(cb);
      };
    },

    checkSessions() {
      if (watchers.size === 0) return;
      const current = loadIndex();
      const at = now();
      for (const sessionRef of [...watchers.keys()]) {
        const row = current?.sessions.get(sessionRef);
        const end =
          row === undefined || current === undefined
            ? "revoked"
            : sessionEnd(row, current.devices, at);
        if (end !== undefined) fire(sessionRef, end);
      }
    },

    snapshot,

    async subjectKey() {
      if (keyCache !== undefined) return keyCache;
      const read = await readDigestKey(hangarRoot, { file: paths.subjectKey });
      if (read.state === "present") keyCache = read.hmac;
      return keyCache;
    },

    async noteIgnoredIdentity(listener, address) {
      const at = now();
      const peer = `${listener}|${address ?? ""}`;
      const last = securityLogged.get(peer);
      if (last !== undefined && at - last < HOUR_MS) return;
      securityLogged.set(peer, at);
      if (securityLogged.size > SIGN_IN_LIMITS.cap) {
        const oldest = securityLogged.keys().next();
        if (oldest.done !== true) securityLogged.delete(oldest.value);
      }
      const key = await ensureDigestKey(hangarRoot, { file: paths.subjectKey });
      if (key.state !== "present") return;
      const line = {
        v: 1,
        at: new Date(at).toISOString(),
        event: "identity_header_ignored",
        listener,
        peerRef: await keyedDigest(key.hmac, SECURITY_PEER_LABEL, [address ?? ""]),
      };
      await withLedgerLock(accessLedger(hangarRoot, "principals"), () => {
        sealTornLine(hangarRoot, paths.security);
        appendContained(hangarRoot, paths.security, `${JSON.stringify(line)}\n`, {
          mode: 0o600,
          hardLinks: "refuse",
        });
      });
    },

    pending: () => ({ codes: codes.size, challenges: challenges.size }),
  };
}
