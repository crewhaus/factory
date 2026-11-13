/**
 * Issued secrets: random, shown once, kept only as a sha256. A secret is looked up by its
 * digest, never by comparing secrets, and a list shows its `prefixHint`, never the digest.
 */
import { ISSUED_SECRET_RES } from "@crewhaus/control-contract";

/** The kinds minted here. A scoped `chx_` token carries signed claims: `scoped.ts` mints it. */
export type IssuedSecretKind = "session" | "personal" | "service" | "invite";

const PREFIXES: Readonly<Record<IssuedSecretKind, string>> = Object.freeze({
  session: "cha_",
  personal: "chp_",
  service: "chs_",
  invite: "chi_",
});

const SECRET_BYTES = 32;
/** The prefix plus four characters: too short for any mask shape, enough to tell two apart. */
const PREFIX_HINT_LENGTH = 8;

/**
 * A new secret: 32 bytes from `crypto.getRandomValues`, base64url (43 characters) after
 * its prefix. Every one matches its `ISSUED_SECRET_RES` entry.
 *
 * First consumers: invites and service tokens (`crewhaus access invite`, `mint`).
 */
export function mintIssuedSecret(kind: IssuedSecretKind): string {
  const prefix = PREFIXES[kind];
  if (prefix === undefined) throw new TypeError(`access-control: no secret kind "${kind}"`);
  const body = Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString(
    "base64url",
  );
  const secret = `${prefix}${body}`;
  if (!ISSUED_SECRET_RES[kind].test(secret)) {
    throw new Error(`access-control: a minted ${kind} secret does not fit its grammar`);
  }
  return secret;
}

/** Lowercase hex SHA-256 over the UTF-8 of `text`: what a record keeps of a secret. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

/** The first eight characters of a secret, shown in lists so a person can tell tokens apart. */
export function prefixHintOf(secret: string): string {
  return secret.slice(0, PREFIX_HINT_LENGTH);
}
