/**
 * Scoped tokens: `chx_<payload>.<mac>`, a short-lived token a service hands a browser so it
 * can read one run, and nothing else.
 *
 * The payload is base64url JSON `{v: 1, cred, refs, acts, exp, sub?}`: the minting
 * service token's credential, the run refs it may read, the read acts it may perform, and
 * when it ends. The MAC is HMAC-SHA256 over the payload part, under
 * `<hangarRoot>/access/keys/scoped.key` (32 random bytes, `0600`, inside `access/`, which
 * no route serves), and is checked in constant time.
 *
 * Nothing about a token is stored: it is checked against the access records each time it
 * is presented, so revoking the service token that minted it ends every token it minted.
 * A token lives at most 15 minutes, so a field added later needs no migration.
 */
import { timingSafeEqual } from "node:crypto";
import {
  ISSUED_SECRET_RES,
  SCOPED_ACTS,
  SCOPED_REF_KINDS,
  type ScopedAct,
  isId,
  parseRef,
} from "@crewhaus/control-contract";
import { ensureDigestKey, readDigestKey } from "@crewhaus/control-records";
import { authorize } from "./authorize";
import { accessPaths } from "./paths";
import { type AccessSnapshot, isLiveCredential, loadAccessSnapshot } from "./snapshot";

/**
 * A scoped token lives this long unless asked for less, and never longer.
 *
 * First consumer: {@link mintScopedToken}.
 */
export const SCOPED_TOKEN_TTL_MS = Object.freeze({ default: 15 * 60_000, max: 15 * 60_000 });

/**
 * The permission the minter must hold, on every ref's harness, for each act it delegates.
 *
 * First consumers: {@link mintScopedToken}, and Home's choke point, which checks it again
 * on every request a scoped token makes.
 */
export const SCOPED_ACT_PERMISSIONS: Readonly<Record<ScopedAct, string>> = Object.freeze({
  "run.events.read": "h.read.content",
  "run.result.read": "h.read",
} as Record<ScopedAct, string>);

/** The longest token this package reads; anything longer is not one. */
const MAX_TOKEN_LENGTH = 4096;
const MAX_REFS = 32;
const PREFIX = "chx_";

export type ScopedClaims = {
  readonly v: 1;
  /** The minting service token's credential, `crd_…`. */
  readonly cred: string;
  readonly refs: readonly string[];
  readonly acts: readonly ScopedAct[];
  /** When the token stops working, epoch ms. */
  readonly exp: number;
  readonly sub?: string;
};

export type ScopedMintInput = {
  /** The service token the browser's token is minted from, `crd_…`. */
  readonly credential: string;
  /** `<hrn_…>/run/<run id>` and `<hrn_…>/exec/run_<16 hex>` refs: what the token may read. */
  readonly refs: readonly string[];
  readonly acts: readonly string[];
  /** At most 15 minutes; 15 by default. */
  readonly ttlMs?: number;
  /** The subject the minting service names the browser's person by. */
  readonly subjectRef?: string;
};

export type ScopedRefusalReason =
  | "credential"
  | "ttl"
  | "act"
  | "not-held"
  | "ref"
  | "no-refs"
  | "unreadable";

export type ScopedMintAnswer =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: string;
      readonly principal: string;
    }
  | { readonly ok: false; readonly reason: ScopedRefusalReason; readonly message: string };

export type ScopedVerifyReason = "token_invalid" | "token_expired" | "credential_unknown";

export type ScopedVerified =
  | {
      readonly ok: true;
      /** The minting service's principal. */
      readonly principal: string;
      readonly credential: string;
      readonly refs: readonly string[];
      readonly acts: readonly ScopedAct[];
      readonly exp: number;
    }
  | { readonly ok: false; readonly reason: ScopedVerifyReason };

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function isScopedAct(value: unknown): value is ScopedAct {
  return typeof value === "string" && (SCOPED_ACTS as readonly string[]).includes(value);
}

/**
 * A run ref's harness, or `undefined` for anything that is not one. A run is named `run`
 * and a supervisor's execution `exec` (`scopedRunRef`); no other kind is read.
 */
function runRefHarness(ref: unknown): string | undefined {
  const parsed = parseRef(ref);
  if ("error" in parsed || !(SCOPED_REF_KINDS as readonly string[]).includes(parsed.kind)) {
    return undefined;
  }
  return parsed.scope;
}

function refused(reason: ScopedRefusalReason, message: string): ScopedMintAnswer {
  return { ok: false, reason, message };
}

/**
 * The key scoped tokens are signed with, created on first use (`0600`, in a `0700`
 * directory), or `undefined` when it cannot be read or made.
 *
 * First consumer: {@link mintScopedToken}.
 */
export async function ensureScopedKey(hangarRoot: string): Promise<CryptoKey | undefined> {
  const read = await ensureDigestKey(hangarRoot, { file: accessPaths().scopedKey });
  return read.state === "present" ? read.hmac : undefined;
}

/**
 * The key scoped tokens are checked with, or `undefined` while none was ever made. Reads
 * only: checking a token never creates the key.
 *
 * First consumer: the sign-in handle's `scopedKey()`.
 */
export async function readScopedKey(hangarRoot: string): Promise<CryptoKey | undefined> {
  const read = await readDigestKey(hangarRoot, { file: accessPaths().scopedKey });
  return read.state === "present" ? read.hmac : undefined;
}

async function macOf(key: CryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, utf8(payload));
  return Buffer.from(signature).toString("base64url");
}

/**
 * Mint a scoped token from a live service token. Refused: a credential that is not a live
 * service token; a lifetime past 15 minutes; an act outside the closed list; an act whose
 * permission the minting service does not hold on every ref's harness; a ref that is not a
 * run ref; no refs at all. Library only: the HTTP mint route is the versioned API's.
 *
 * First consumer: Home's route tests, which drive every route with one.
 */
export async function mintScopedToken(
  hangarRoot: string,
  input: ScopedMintInput,
  options: { readonly now: () => number },
): Promise<ScopedMintAnswer> {
  const now = options.now();
  const ttl = input.ttlMs ?? SCOPED_TOKEN_TTL_MS.default;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > SCOPED_TOKEN_TTL_MS.max) {
    return refused("ttl", "A scoped token lasts at most 15 minutes.");
  }
  if (!Array.isArray(input.refs) || input.refs.length === 0) {
    return refused("no-refs", "A scoped token names at least one run.");
  }
  if (input.refs.length > MAX_REFS) {
    return refused("ref", `A scoped token names at most ${MAX_REFS} runs.`);
  }
  const harnesses: string[] = [];
  for (const ref of input.refs) {
    const harness = runRefHarness(ref);
    if (harness === undefined) return refused("ref", `"${String(ref)}" is not a run ref.`);
    harnesses.push(harness);
  }
  if (!Array.isArray(input.acts) || input.acts.length === 0) {
    return refused("act", "A scoped token names at least one act.");
  }
  const acts: ScopedAct[] = [];
  for (const act of input.acts) {
    if (!isScopedAct(act)) return refused("act", `"${String(act)}" is not a scoped act.`);
    if (!acts.includes(act)) acts.push(act);
  }
  if (!isId("crd", input.credential)) {
    return refused("credential", "That is not a service token's credential.");
  }
  const read = loadAccessSnapshot(hangarRoot);
  if (read.state !== "present") {
    return refused("unreadable", "The access records cannot be read.");
  }
  const snapshot = read.snapshot;
  const credential = snapshot.tokens.find((row) => row.id === input.credential);
  if (
    credential === undefined ||
    credential.kind !== "service" ||
    !isLiveCredential(snapshot, credential, now)
  ) {
    return refused("credential", "That is not a live service token.");
  }
  const actor = { principal: credential.principal, credential: credential.id };
  for (const act of acts) {
    const permission = SCOPED_ACT_PERMISSIONS[act];
    for (const harness of harnesses) {
      const verdict = authorize(
        snapshot,
        actor,
        permission,
        { scope: "harness", harness, groups: [] },
        { now },
      );
      if (!verdict.allow) {
        return refused("not-held", `This service cannot delegate ${act} on ${harness}.`);
      }
    }
  }
  const key = await ensureScopedKey(hangarRoot);
  if (key === undefined) return refused("unreadable", "The scoped-token key cannot be read.");
  const exp = now + ttl;
  const claims: ScopedClaims = {
    v: 1,
    cred: credential.id,
    refs: [...new Set(input.refs)],
    acts,
    exp,
    ...(input.subjectRef !== undefined ? { sub: input.subjectRef } : {}),
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const token = `${PREFIX}${payload}.${await macOf(key, payload)}`;
  return {
    ok: true,
    token,
    expiresAt: new Date(exp).toISOString(),
    principal: credential.principal,
  };
}

function claimsOf(payload: string): ScopedClaims | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const claims = parsed as Record<string, unknown>;
  const refs = claims["refs"];
  const acts = claims["acts"];
  if (
    claims["v"] !== 1 ||
    !isId("crd", claims["cred"]) ||
    !Array.isArray(refs) ||
    refs.length === 0 ||
    refs.length > MAX_REFS ||
    !refs.every((ref) => runRefHarness(ref) !== undefined) ||
    !Array.isArray(acts) ||
    acts.length === 0 ||
    !acts.every(isScopedAct) ||
    typeof claims["exp"] !== "number" ||
    !Number.isFinite(claims["exp"]) ||
    (claims["sub"] !== undefined && typeof claims["sub"] !== "string")
  ) {
    return undefined;
  }
  return claims as unknown as ScopedClaims;
}

/**
 * Check a presented scoped token. Refused: a bad shape or MAC (`token_invalid`), a passed
 * `exp` (`token_expired`), a minting credential that is not a live service token
 * (`credential_unknown`). Pure but for WebCrypto: it reads no file.
 *
 * First consumer: `authenticate`, for a `chx_` bearer.
 */
export async function verifyScopedToken(
  secret: string,
  snapshot: AccessSnapshot | undefined,
  key: CryptoKey | undefined,
  now: number,
): Promise<ScopedVerified> {
  if (
    typeof secret !== "string" ||
    secret.length > MAX_TOKEN_LENGTH ||
    !ISSUED_SECRET_RES.scoped.test(secret) ||
    key === undefined
  ) {
    return { ok: false, reason: "token_invalid" };
  }
  const body = secret.slice(PREFIX.length);
  const dot = body.indexOf(".");
  const payload = body.slice(0, dot);
  const mac = body.slice(dot + 1);
  const macBytes = Buffer.from(mac, "base64url");
  // A MAC that does not round-trip is not one this package made.
  if (macBytes.length !== 32 || macBytes.toString("base64url") !== mac) {
    return { ok: false, reason: "token_invalid" };
  }
  const expected = Buffer.from(await crypto.subtle.sign("HMAC", key, utf8(payload)));
  if (!timingSafeEqual(expected, macBytes)) return { ok: false, reason: "token_invalid" };
  const claims = claimsOf(payload);
  if (claims === undefined) return { ok: false, reason: "token_invalid" };
  if (claims.exp <= now) return { ok: false, reason: "token_expired" };
  const credential = snapshot?.tokens.find((row) => row.id === claims.cred);
  if (
    snapshot === undefined ||
    credential === undefined ||
    credential.kind !== "service" ||
    !isLiveCredential(snapshot, credential, now)
  ) {
    return { ok: false, reason: "credential_unknown" };
  }
  return {
    ok: true,
    principal: credential.principal,
    credential: credential.id,
    refs: claims.refs,
    acts: claims.acts,
    exp: claims.exp,
  };
}
