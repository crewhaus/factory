/**
 * Device sign-in with a short code (RFC 8628's flow): a CLI or a script on another
 * computer asks to sign in, shows a code, and a member who is already signed in allows
 * it on Home's own page or with `crewhaus access approve` on Home's computer.
 *
 *   start   → a request, a code (`XXXX-XXXX`) and a poll reference, both kept only as
 *             keyed digests; the poll reference leaves sealed to the start's own key
 *   lookup  → what the request asks for, to the signed-in member who typed its code
 *   decide  → the member's choice, recorded; nothing is minted yet
 *   poll    → `pending` until decided; on the first poll that finds it allowed, a
 *             personal token for that member is minted, sealed to that poll's key, and
 *             the request is `consumed`
 *
 * Pending requests live in `<hangarRoot>/access/device-requests.json`: rewritable,
 * `0600`, written whole under the access lock, never a ledger, so a request never moves
 * the access revision; only the token it ends in does. An expired request is dropped by
 * the next writer, never by a read. Limits are `DEVICE_LIMITS`.
 *
 * Every stored request names where it came from, as Home observed it (`requestedFrom`),
 * so the member who allows it can tell their own sign-in from someone else's. A refused
 * start, a poll for a request that is gone or has ended, and a poll that comes too soon or
 * while another poll of the same request is being answered never wait for the access
 * lock: they answer from a read, which sees each whole write (temp file plus rename). So
 * each waiting request has at most one poll waiting for the lock at a time.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDigestKey, readDigestKey, withLedgerLock } from "@crewhaus/control-records";
import { parseIp } from "./addresses";
import { readJsonFile, writeJsonFile } from "./files";
import { type AccessContext, type Refusal, runMutationLocked } from "./mutate";
import { accessLedger, accessPaths } from "./paths";
import { PERSONAL_TOKEN_TTL_MS, type PersonalIssue, planPersonalToken } from "./personal";
import { mintShortCode, normalizeShortCode, shortCodeDigest } from "./short-code";
import { loadAccessSnapshot } from "./snapshot";

/**
 * The limits a device sign-in keeps.
 *
 * First consumers: the requests below, and Home's device page, which says them.
 */
export const DEVICE_LIMITS = Object.freeze({
  /** A code works for ten minutes, once. */
  codeTtlMs: 10 * 60_000,
  /** At most this many waiting at once; the next start is refused. */
  maxPending: 128,
  /**
   * At most this many waiting from one address; the next start from it is refused. An
   * IPv6 address counts by its /64, a trusted proxy's requests count by the address it
   * reports, and Home's own socket counts as one address.
   */
  maxPendingPerPeer: 4,
  /** At most this many waiting from one IPv6 /48, however they spread over its /64s. */
  maxPendingPerNetwork: 8,
  /**
   * At most this many waiting that came through the trusted proxy, so requests that
   * reach Home directly or on its own socket always find room the proxy cannot take.
   */
  maxPendingThroughProxy: 64,
  /** How often a client may poll. */
  intervalMs: 5_000,
  /** What a poll that came too soon adds to the interval (RFC 8628 `slow_down`). */
  slowDownMs: 5_000,
  /** Failed lookups a caller may make in one window before the next is refused. */
  lookupFailures: 10,
  lookupWindowMs: 10 * 60_000,
  /** How long the token a collected sign-in mints lasts. */
  tokenDays: PERSONAL_TOKEN_TTL_MS / (24 * 60 * 60 * 1000),
});

const CODE_LABEL = "access.device.code";
const POLL_LABEL = "access.device.poll";
const MAX_FILE_BYTES = 256 * 1024;

export type DeviceRequestState = "pending" | "allowed" | "denied" | "consumed";

/**
 * Where a device sign-in came from, as Home itself observed it: over TCP from `address`
 * (`direct`), through the trusted proxy once it proved itself, with the address it reports
 * (`proxy`), or on Home's own socket (`home`). Never what the request says about itself.
 */
export type RequestedFrom = {
  readonly via: "direct" | "proxy" | "home";
  readonly address?: string;
};

/** One stored request. No raw code and no raw poll reference: keyed digests only. */
export type DeviceRequestRow = {
  readonly id: string;
  readonly codeDigest: string;
  readonly pollDigest: string;
  readonly readOnly: boolean;
  readonly state: DeviceRequestState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly intervalMs: number;
  readonly lastPollAt?: string;
  readonly clientName?: string;
  /** Where it came from, as Home observed it. */
  readonly requestedFrom: RequestedFrom;
  /** The member who allowed or denied it. */
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  /** The receipt the decision was recorded under. */
  readonly decidedCmd?: string;
  /** The token it was collected as, once `consumed`. */
  readonly credential?: string;
};

export type DeviceRefusal = {
  readonly ok: false;
  readonly code:
    | "invalid"
    | "not_found"
    | "conflict"
    | "forbidden"
    | "rate_limited"
    | "unavailable";
  readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 503;
  readonly reason: string;
  readonly message: string;
  readonly retryAfterMs?: number;
};

export type DeviceStart = {
  readonly ok: true;
  /** Shown to the person: `XXXX-XXXX`. */
  readonly userCode: string;
  /** 32 random bytes as hex; it leaves Home only sealed. */
  readonly pollRef: string;
  readonly intervalMs: number;
  readonly expiresAt: string;
};

export type DevicePoll =
  | { readonly ok: true; readonly state: "pending" | "denied" | "expired" | "consumed" }
  | ({ readonly ok: true; readonly state: "allowed" } & PersonalIssue)
  | DeviceRefusal;

export type DeviceLookup =
  | {
      readonly ok: true;
      readonly request: {
        readonly state: DeviceRequestState | "expired";
        readonly readOnly: boolean;
        readonly expiresAt: string;
        readonly createdAt: string;
        readonly requestedFrom: RequestedFrom;
        readonly clientName?: string;
        readonly tokenDays: number;
      };
    }
  | DeviceRefusal;

export type DeviceDecide =
  | { readonly ok: true; readonly state: "allowed" | "denied" }
  | DeviceRefusal;

export type DeviceRequests = {
  start(input: {
    readonly readOnly?: boolean;
    readonly clientName?: string;
    /** Where the request came from, as Home observed it (`requesterOf`). */
    readonly requestedFrom: RequestedFrom;
  }): Promise<DeviceStart | DeviceRefusal>;
  poll(pollRef: string): Promise<DevicePoll>;
  /** `caller` is the signed-in member who typed the code. */
  lookup(caller: string, code: string): Promise<DeviceLookup>;
  decide(input: {
    readonly caller: string;
    readonly code: string;
    readonly choice: "allow" | "deny";
    /** The receipt this decision is recorded under. */
    readonly cmd?: string;
  }): Promise<DeviceDecide>;
  /** Every stored request, read-only: nothing is dropped or created. */
  read(): readonly DeviceRequestRow[];
};

function refuse(
  code: DeviceRefusal["code"],
  status: DeviceRefusal["status"],
  reason: string,
  message: string,
  retryAfterMs?: number,
): DeviceRefusal {
  return {
    ok: false,
    code,
    status,
    reason,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

const NOT_SET_UP = refuse(
  "unavailable",
  503,
  "access_not_set_up",
  "Nobody can allow a sign-in on this Home yet. Open Home in a browser on its own computer first.",
);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isRequestedFrom(value: unknown): value is RequestedFrom {
  if (typeof value !== "object" || value === null) return false;
  const from = value as Record<string, unknown>;
  const address = from["address"];
  return (
    ["direct", "proxy", "home"].includes(from["via"] as string) &&
    (address === undefined || (typeof address === "string" && address.length <= 64))
  );
}

/** Just the two fields of a `RequestedFrom`, whatever else the value carries. */
function fromOf(from: RequestedFrom): RequestedFrom {
  return from.address === undefined ? { via: from.via } : { via: from.via, address: from.address };
}

/** A stored request; every one names where it came from, so one that does not is not one. */
function isRow(value: unknown): value is DeviceRequestRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    isRequestedFrom(row["requestedFrom"]) &&
    typeof row["id"] === "string" &&
    typeof row["codeDigest"] === "string" &&
    typeof row["pollDigest"] === "string" &&
    typeof row["readOnly"] === "boolean" &&
    ["pending", "allowed", "denied", "consumed"].includes(row["state"] as string) &&
    typeof row["createdAt"] === "string" &&
    typeof row["expiresAt"] === "string" &&
    typeof row["intervalMs"] === "number"
  );
}

/** Whether a request's code has passed its ten minutes. A time that cannot be read has. */
function expired(row: DeviceRequestRow, now: number): boolean {
  const at = Date.parse(row.expiresAt);
  return Number.isNaN(at) || at <= now;
}

/**
 * The address a request counts against for `maxPendingPerPeer`: Home's own socket as one,
 * an IPv4 address (an IPv4-mapped one too) whole, an IPv6 address by its /64, and one with
 * no readable address by how it arrived.
 */
function peerBucket(from: RequestedFrom): string {
  if (from.via === "home") return "home";
  const ip = parseIp(from.address);
  if (ip === undefined) return from.via;
  return ip.family === 4
    ? `${from.via}:4:${hex(ip.bytes)}`
    : `${from.via}:6:${hex(ip.bytes.slice(0, 8))}`;
}

/** The IPv6 /48 a request counts against for `maxPendingPerNetwork`; none for any other. */
function networkBucket(from: RequestedFrom): string | undefined {
  if (from.via === "home") return undefined;
  const ip = parseIp(from.address);
  return ip === undefined || ip.family === 4
    ? undefined
    : `${from.via}:6/48:${hex(ip.bytes.slice(0, 6))}`;
}

const TOO_MANY_PENDING = refuse(
  "rate_limited",
  429,
  "too_many_pending",
  "Too many sign-ins are waiting on this Home. Allow or deny one, or wait ten minutes.",
  DEVICE_LIMITS.codeTtlMs,
);

const TOO_MANY_PENDING_HERE = refuse(
  "rate_limited",
  429,
  "too_many_pending_here",
  "Too many sign-ins from this address are waiting. Finish or cancel one, or wait ten minutes.",
  DEVICE_LIMITS.codeTtlMs,
);

/** The refusal a new start from `from` meets among `live` rows, if any. */
function capRefusal(
  live: readonly DeviceRequestRow[],
  from: RequestedFrom,
): DeviceRefusal | undefined {
  const pending = live.filter((row) => row.state === "pending");
  if (pending.length >= DEVICE_LIMITS.maxPending) return TOO_MANY_PENDING;
  const count = (match: (row: DeviceRequestRow) => boolean): number => pending.filter(match).length;
  if (
    from.via === "proxy" &&
    count((row) => row.requestedFrom.via === "proxy") >= DEVICE_LIMITS.maxPendingThroughProxy
  ) {
    return TOO_MANY_PENDING;
  }
  const bucket = peerBucket(from);
  if (count((row) => peerBucket(row.requestedFrom) === bucket) >= DEVICE_LIMITS.maxPendingPerPeer) {
    return TOO_MANY_PENDING_HERE;
  }
  const network = networkBucket(from);
  if (
    network !== undefined &&
    count((row) => networkBucket(row.requestedFrom) === network) >=
      DEVICE_LIMITS.maxPendingPerNetwork
  ) {
    return TOO_MANY_PENDING_HERE;
  }
  return undefined;
}

/**
 * The device sign-in requests of one Hangar root. `now` is injected so a test fakes the
 * clock; the failed-lookup counts live in this handle, one per caller.
 *
 * First consumers: Home's sign-in and access routes, and `crewhaus access approve`.
 */
export function openDeviceRequests(
  hangarRoot: string,
  options: { readonly now?: () => number } = {},
): DeviceRequests {
  const now = options.now ?? (() => Date.now());
  const paths = accessPaths();
  const failures = new Map<string, number[]>();
  /** The poll digests with a poll waiting for, or holding, the access lock. */
  const polling = new Set<string>();
  const ctx: AccessContext = {
    root: hangarRoot,
    now,
    harnesses: () => [],
    domains: new Map(),
  };

  const readRows = (): DeviceRequestRow[] => {
    const read = readJsonFile(hangarRoot, paths.deviceRequests, MAX_FILE_BYTES);
    if (read.state !== "present") return [];
    const rows = read.value["requests"];
    return Array.isArray(rows) ? rows.filter(isRow) : [];
  };

  const writeRows = (rows: readonly DeviceRequestRow[]): boolean =>
    writeJsonFile(hangarRoot, paths.deviceRequests, { v: 1, requests: rows }).ok;

  const setUp = (): boolean => {
    if (!existsSync(join(hangarRoot, paths.dir))) return false;
    const read = loadAccessSnapshot(hangarRoot);
    return read.state === "present" && read.snapshot.owner !== undefined;
  };

  /** Run `fn` under the access lock; `undefined` when the lock could not be taken. */
  const locked = async <T>(fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      const answer = await withLedgerLock(accessLedger(hangarRoot, "principals"), fn);
      if (typeof answer === "object" && answer !== null && "ok" in answer && "path" in answer) {
        return undefined;
      }
      return answer as T;
    } catch {
      return undefined;
    }
  };

  const keyOf = async (create: boolean): Promise<CryptoKey | undefined> => {
    const file = { file: paths.subjectKey };
    const read = create
      ? await ensureDigestKey(hangarRoot, file)
      : await readDigestKey(hangarRoot, file);
    return read.state === "present" ? read.hmac : undefined;
  };

  const LOCK_FAILED = refuse(
    "unavailable",
    503,
    "access_locked",
    "Home's access records could not be locked. Try again.",
  );

  /** Whether the caller is out of failed lookups; and the failure to count, when one is. */
  const tooMany = (caller: string): boolean => {
    const at = now();
    const kept = (failures.get(caller) ?? []).filter((t) => at - t < DEVICE_LIMITS.lookupWindowMs);
    failures.set(caller, kept);
    return kept.length >= DEVICE_LIMITS.lookupFailures;
  };
  const failed = (caller: string): void => {
    failures.set(caller, [...(failures.get(caller) ?? []), now()]);
  };
  const TOO_MANY = refuse(
    "rate_limited",
    429,
    "too_many_tries",
    "Too many codes that did not match. Wait ten minutes, then try again.",
    DEVICE_LIMITS.lookupWindowMs,
  );

  const EXPIRED: DevicePoll = { ok: true, state: "expired" };

  /** What a poll of a request that is gone or has ended answers; `undefined` while it is live. */
  const ended = (row: DeviceRequestRow | undefined, at: number): DevicePoll | undefined => {
    // One dropped as expired, or one never made: either way it has ended.
    if (row === undefined) return EXPIRED;
    if (row.state === "consumed") return { ok: true, state: "consumed" };
    if (expired(row, at)) return EXPIRED;
    return undefined;
  };

  /** Whether a poll at `at` comes sooner than the request's interval after the last one. */
  const tooSoon = (row: DeviceRequestRow, at: number): boolean => {
    const last = row.lastPollAt === undefined ? undefined : Date.parse(row.lastPollAt);
    return last !== undefined && !Number.isNaN(last) && at - last < row.intervalMs;
  };

  const slowDown = (intervalMs: number): DeviceRefusal =>
    refuse(
      "rate_limited",
      429,
      "slow_down",
      "Asked too soon. Wait a little longer between checks.",
      intervalMs,
    );

  /** A poll of a live request, under the access lock: read again, then answer and record it. */
  const pollLocked = async (digest: string): Promise<DevicePoll> => {
    const at = now();
    const rows = readRows();
    const index = rows.findIndex((row) => row.pollDigest === digest);
    const row = rows[index];
    const over = ended(row, at);
    if (over !== undefined || row === undefined) return over ?? EXPIRED;
    if (tooSoon(row, at)) {
      const slower = { ...row, intervalMs: row.intervalMs + DEVICE_LIMITS.slowDownMs };
      rows[index] = { ...slower, lastPollAt: new Date(at).toISOString() };
      writeRows(rows);
      return slowDown(slower.intervalMs);
    }
    if (row.state === "allowed" && row.decidedBy !== undefined) {
      const minted = await runMutationLocked<PersonalIssue>(
        ctx,
        { principal: row.decidedBy },
        (state) => planPersonalToken(state, row.decidedBy as string, row.readOnly),
        { projections: false, own: true },
      );
      if (!minted.ok) {
        return refuse(
          "unavailable",
          503,
          "mint_failed",
          (minted as Refusal).reason ?? "The token could not be made.",
        );
      }
      rows[index] = {
        ...row,
        state: "consumed",
        lastPollAt: new Date(at).toISOString(),
        credential: minted.result.token.id,
      };
      writeRows(rows.filter((r) => r === rows[index] || !expired(r, at)));
      return { ok: true, state: "allowed", ...minted.result };
    }
    rows[index] = { ...row, lastPollAt: new Date(at).toISOString() };
    writeRows(rows.filter((r) => r === rows[index] || !expired(r, at)));
    return { ok: true, state: row.state === "denied" ? "denied" : "pending" };
  };

  /** The live request a typed code names, or the refusal that says why there is none. */
  const find = async (
    caller: string,
    code: string,
  ): Promise<
    { readonly row: DeviceRequestRow; readonly rows: DeviceRequestRow[] } | DeviceRefusal
  > => {
    if (tooMany(caller)) return TOO_MANY;
    const normalized = normalizeShortCode(code);
    const key = await keyOf(false);
    const rows = readRows();
    const digest =
      normalized === undefined || key === undefined
        ? undefined
        : await shortCodeDigest(key, CODE_LABEL, normalized);
    const row = digest === undefined ? undefined : rows.find((r) => r.codeDigest === digest);
    if (row === undefined) {
      failed(caller);
      return refuse(
        "not_found",
        404,
        "code_unknown",
        "That code does not match a sign-in waiting here. Check it and try again.",
      );
    }
    if (row.state === "consumed" || row.state === "allowed" || row.state === "denied") {
      return refuse("conflict", 409, "code_used", "That code has already been used.");
    }
    if (expired(row, now())) {
      return refuse(
        "invalid",
        422,
        "code_expired",
        "That code has expired. Start the sign-in again to get a new one.",
      );
    }
    return { row, rows };
  };

  return {
    read: readRows,

    async start(input) {
      if (!setUp()) return NOT_SET_UP;
      const from = input.requestedFrom;
      // A start either cap refuses is answered from a read: it creates nothing and never
      // waits for the access lock. The same checks run again under the lock.
      const early = capRefusal(
        readRows().filter((row) => !expired(row, now())),
        from,
      );
      if (early !== undefined) return early;
      const key = await keyOf(true);
      if (key === undefined) {
        return refuse("unavailable", 503, "key_unreadable", "Home's sign-in key cannot be read.");
      }
      const answer = await locked(async (): Promise<DeviceStart | DeviceRefusal> => {
        const at = now();
        const live = readRows().filter((row) => !expired(row, at));
        const capped = capRefusal(live, from);
        if (capped !== undefined) return capped;
        // A fresh code that no waiting request shares.
        let userCode = mintShortCode();
        let codeDigest = await shortCodeDigest(key, CODE_LABEL, userCode);
        while (live.some((row) => row.codeDigest === codeDigest)) {
          userCode = mintShortCode();
          codeDigest = await shortCodeDigest(key, CODE_LABEL, userCode);
        }
        const pollRef = hex(crypto.getRandomValues(new Uint8Array(32)));
        const expiresAt = new Date(at + DEVICE_LIMITS.codeTtlMs).toISOString();
        const row: DeviceRequestRow = {
          id: hex(crypto.getRandomValues(new Uint8Array(8))),
          codeDigest,
          pollDigest: await shortCodeDigest(key, POLL_LABEL, pollRef),
          readOnly: input.readOnly === true,
          state: "pending",
          createdAt: new Date(at).toISOString(),
          expiresAt,
          intervalMs: DEVICE_LIMITS.intervalMs,
          ...(input.clientName !== undefined ? { clientName: input.clientName } : {}),
          requestedFrom: fromOf(input.requestedFrom),
        };
        if (!writeRows([...live, row])) {
          return refuse("unavailable", 503, "write_failed", "The sign-in could not be recorded.");
        }
        return {
          ok: true,
          userCode,
          pollRef,
          intervalMs: DEVICE_LIMITS.intervalMs,
          expiresAt,
        };
      });
      return answer ?? LOCK_FAILED;
    },

    async poll(pollRef) {
      if (typeof pollRef !== "string" || !/^[0-9a-f]{64}$/.test(pollRef)) {
        return refuse("invalid", 400, "poll_ref_invalid", "That is not a sign-in to wait for.");
      }
      const key = await keyOf(false);
      if (key === undefined) return { ok: true, state: "expired" };
      const digest = await shortCodeDigest(key, POLL_LABEL, pollRef);
      // A request that is gone or has ended, and a poll that comes too soon or while another
      // poll of it is being answered, are answered from a read, with no lock and no write.
      // The read and the in-flight check run with nothing awaited between them, so only one
      // poll of a live request at a time waits for the lock, where it is read again.
      const seen = readRows().find((row) => row.pollDigest === digest);
      const at = now();
      const over = ended(seen, at);
      if (over !== undefined || seen === undefined) return over ?? EXPIRED;
      // RFC 8628 has the client add `slowDownMs` to its own interval after a slow_down.
      if (tooSoon(seen, at) || polling.has(digest)) {
        return slowDown(seen.intervalMs + DEVICE_LIMITS.slowDownMs);
      }
      polling.add(digest);
      try {
        return (await locked(() => pollLocked(digest))) ?? LOCK_FAILED;
      } finally {
        polling.delete(digest);
      }
    },

    async lookup(caller, code) {
      if (!setUp()) return NOT_SET_UP;
      const found = await find(caller, code);
      if ("ok" in found) return found;
      const { row } = found;
      return {
        ok: true,
        request: {
          state: row.state,
          readOnly: row.readOnly,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          requestedFrom: fromOf(row.requestedFrom),
          ...(row.clientName !== undefined ? { clientName: row.clientName } : {}),
          tokenDays: DEVICE_LIMITS.tokenDays,
        },
      };
    },

    async decide(input) {
      if (!setUp()) return NOT_SET_UP;
      const read = loadAccessSnapshot(hangarRoot);
      const who =
        read.state === "present"
          ? read.snapshot.principals.find((p) => p.id === input.caller)
          : undefined;
      if (who === undefined || who.state !== "active" || who.kind !== "member") {
        return refuse(
          "forbidden",
          403,
          "member_required",
          "Only a member of this Home can allow a sign-in.",
        );
      }
      const answer = await locked(async (): Promise<DeviceDecide> => {
        const found = await find(input.caller, input.code);
        if ("ok" in found) return found;
        const at = now();
        const state: "allowed" | "denied" = input.choice === "allow" ? "allowed" : "denied";
        const rows = found.rows
          .filter((row) => row === found.row || !expired(row, at))
          .map((row) =>
            row === found.row
              ? {
                  ...row,
                  state,
                  decidedBy: input.caller,
                  decidedAt: new Date(at).toISOString(),
                  ...(input.cmd !== undefined ? { decidedCmd: input.cmd } : {}),
                }
              : row,
          );
        if (!writeRows(rows)) {
          return refuse("unavailable", 503, "write_failed", "The choice could not be recorded.");
        }
        return { ok: true, state };
      });
      return answer ?? LOCK_FAILED;
    },
  };
}
