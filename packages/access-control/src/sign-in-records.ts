/**
 * The sign-in rows: each browser's device key (`devices.jsonl`) and each session issued to
 * it (`sessions.jsonl`), in the access ledgers' style (`{id, state, at, by, …}`, folded by
 * `id`). The fold is tolerant: a line that cannot be read, or a row of the wrong shape, is
 * skipped rather than failing the read, because a torn line must not sign everyone out.
 *
 * No row holds a secret. A device row holds the browser's PUBLIC signing key; a session
 * row holds only the sha256 of the session's secret. Every field name tests false under
 * the masker's `isCredentialKey`.
 */
import { isId, isStoredActor } from "@crewhaus/control-contract";
import { foldStates } from "@crewhaus/control-records";
import { type SignInKind, signInLedger } from "./paths";
import { stripBookkeeping } from "./records";

/** A P-256 public key as a JWK, the four fields WebCrypto needs and nothing else. */
export type DeviceJwk = {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
};

export type DeviceRow = {
  readonly id: string;
  readonly state: "active" | "revoked";
  readonly at: string;
  readonly by: string;
  readonly principal: string;
  readonly deviceJwk: DeviceJwk;
  readonly revokedAt?: string;
};

/** Why a session ended. */
export type SessionEndReason = "signed-out" | "refreshed" | "rotated" | "device-revoked";

export type SessionRow = {
  /** `crd_…`: the session's reference, never its secret. */
  readonly id: string;
  readonly state: "active" | "ended";
  readonly at: string;
  readonly by: string;
  readonly principal: string;
  /** The device it was issued to, `dev_…`. */
  readonly device: string;
  /** Lowercase hex SHA-256 of the session's secret. */
  readonly sha256: string;
  /** The absolute deadline. The sliding one is kept in memory. */
  readonly expiresAt: string;
  readonly endedAt?: string;
  readonly reason?: SessionEndReason;
};

const HEX64_RE = /^[0-9a-f]{64}$/;
const COORDINATE_RE = /^[A-Za-z0-9_-]{43}$/;
const END_REASONS: readonly string[] = ["signed-out", "refreshed", "rotated", "device-revoked"];

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Whether a value is exactly a P-256 public JWK: `{kty: "EC", crv: "P-256", x, y}`. */
export function isDeviceJwk(value: unknown): value is DeviceJwk {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const jwk = value as Record<string, unknown>;
  return (
    Object.keys(jwk).length === 4 &&
    jwk["kty"] === "EC" &&
    jwk["crv"] === "P-256" &&
    typeof jwk["x"] === "string" &&
    COORDINATE_RE.test(jwk["x"]) &&
    typeof jwk["y"] === "string" &&
    COORDINATE_RE.test(jwk["y"])
  );
}

function isDeviceRow(row: Record<string, unknown>): row is Record<string, unknown> & DeviceRow {
  return (
    isId("dev", row["id"]) &&
    isTime(row["at"]) &&
    isStoredActor(row["by"]) &&
    isId("prn", row["principal"]) &&
    isDeviceJwk(row["deviceJwk"]) &&
    (row["state"] === "active"
      ? row["revokedAt"] === undefined
      : row["state"] === "revoked" && isTime(row["revokedAt"]))
  );
}

function isSessionRow(row: Record<string, unknown>): row is Record<string, unknown> & SessionRow {
  return (
    isId("crd", row["id"]) &&
    isTime(row["at"]) &&
    isStoredActor(row["by"]) &&
    isId("prn", row["principal"]) &&
    isId("dev", row["device"]) &&
    typeof row["sha256"] === "string" &&
    HEX64_RE.test(row["sha256"]) &&
    isTime(row["expiresAt"]) &&
    (row["state"] === "active"
      ? row["endedAt"] === undefined && row["reason"] === undefined
      : row["state"] === "ended" &&
        isTime(row["endedAt"]) &&
        END_REASONS.includes(row["reason"] as string))
  );
}

/** A session lasts at most this long from its first issuance; a refresh keeps the deadline. */
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

export type SignInFold =
  | {
      readonly ok: true;
      readonly devices: ReadonlyMap<string, DeviceRow>;
      readonly sessions: ReadonlyMap<string, SessionRow>;
      /**
       * Per device, the latest time it signed in: its enrolment, or the first issuance of
       * a session lineage (the absolute deadline less the session's longest life, which a
       * refresh never moves).
       */
      readonly lastIssued: ReadonlyMap<string, number>;
    }
  | { readonly ok: false; readonly reason: string };

function foldOne<T>(
  root: string,
  kind: SignInKind,
  check: (row: Record<string, unknown>) => boolean,
): Map<string, T> | { readonly reason: string } {
  const fold = foldStates(signInLedger(root, kind));
  if (!fold.ok) return { reason: fold.reason };
  const out = new Map<string, T>();
  for (const object of fold.objects.values()) {
    const row = stripBookkeeping({ ...object.record });
    if (check(row)) out.set(object.id, row as unknown as T);
  }
  return out;
}

/**
 * Both sign-in ledgers, folded by id. Tolerant: an unreadable line or a row of the wrong
 * shape is skipped. Takes no lock and writes nothing.
 *
 * First consumers: the sign-in handle's session index, and rotation.
 */
export function foldSignIn(root: string): SignInFold {
  const devices = foldOne<DeviceRow>(root, "devices", isDeviceRow);
  if (!(devices instanceof Map)) return { ok: false, reason: devices.reason };
  const sessions = foldOne<SessionRow>(root, "sessions", isSessionRow);
  if (!(sessions instanceof Map)) return { ok: false, reason: sessions.reason };
  const lastIssued = new Map<string, number>();
  const bump = (device: string, ms: number): void => {
    if (Number.isFinite(ms) && ms > (lastIssued.get(device) ?? Number.NEGATIVE_INFINITY)) {
      lastIssued.set(device, ms);
    }
  };
  for (const device of devices.values()) bump(device.id, Date.parse(device.at));
  for (const session of sessions.values()) {
    bump(session.device, Date.parse(session.expiresAt) - SESSION_MAX_MS);
  }
  return { ok: true, devices, sessions, lastIssued };
}
