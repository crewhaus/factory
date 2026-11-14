/**
 * Keyed digests. A plain sha256 of a short tool input can be guessed, so the digests
 * that tie a record to an action are HMAC-SHA256 under the harness's own key. Joins
 * between stored digests still work; a guess cannot be tested without the key.
 *
 * The digest format is a pin: stored digests join forever. Its label keeps two purposes
 * from joining, and the JSON array keeps `("a", ["bc"])` apart from `("ab", ["c"])`.
 */
import { dirname } from "node:path";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { decodeStrict, readRecordFile } from "./io";
import { controlPaths } from "./paths";

const KEY_BYTES = 32;
const KEY_FILE_RE = /^[0-9a-f]{64}\n$/;
const KEY_FILE_BYTES = 65;

export type DigestKeyRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly hmac: CryptoKey }
  | { readonly state: "unreadable"; readonly reason: string };

function importHmac(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Where a key lives: `file` is relative to the root. The default is `keys/digest.key` in
 * the root's control directory.
 */
export type DigestKeyOptions = { readonly file?: string };

function keyRel(root: string, options: DigestKeyOptions): string {
  return options.file ?? controlPaths(root).digestKeyFile;
}

/**
 * The harness's digest key, read. Creates nothing. `file` names another key file under
 * the same root, read and refused the same way.
 *
 * First consumers: the decision log, which joins records by keyed digest, and
 * access-control's subject key (`file`).
 */
export async function readDigestKey(
  harnessDir: string,
  options: DigestKeyOptions = {},
): Promise<DigestKeyRead> {
  const rel = keyRel(harnessDir, options);
  const read = readRecordFile(harnessDir, rel, KEY_FILE_BYTES);
  if (!read.ok) {
    return read.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: read.reason };
  }
  const text = read.truncated ? undefined : decodeStrict(read.bytes);
  if (text === undefined || !KEY_FILE_RE.test(text)) {
    return { state: "unreadable", reason: `${rel} is not a digest key file` };
  }
  return { state: "present", hmac: await importHmac(Buffer.from(text.trim(), "hex")) };
}

/**
 * The harness's digest key, created by the first writer that needs it. Publishing is
 * exclusive, so a racing creator reads the winner's key. An unreadable existing key is
 * refused, never replaced: replacing it would break every stored join. `file` names
 * another key file under the same root; its directory is created `0700` the same way.
 *
 * First consumers: the decision log, and access-control's subject key (`file`).
 */
export async function ensureDigestKey(
  harnessDir: string,
  options: DigestKeyOptions = {},
): Promise<Exclude<DigestKeyRead, { readonly state: "absent" }>> {
  const existing = await readDigestKey(harnessDir, options);
  if (existing.state !== "absent") return existing;
  const rel = keyRel(harnessDir, options);
  const dir = ensureDirContained(harnessDir, dirname(rel), { mode: 0o700 });
  if (!dir.ok) return { state: "unreadable", reason: dir.reason };
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const written = writeFileSafe(harnessDir, rel, `${hexOf(raw)}\n`, {
    overwrite: false,
    mode: 0o600,
  });
  if (written.ok) return { state: "present", hmac: await importHmac(raw) };
  if (written.code !== "exists") return { state: "unreadable", reason: written.reason };
  const winner = await readDigestKey(harnessDir, options);
  return winner.state === "absent"
    ? { state: "unreadable", reason: `${rel} disappeared while it was being created` }
    : winner;
}

/**
 * HMAC-SHA256, lowercase hex, over the UTF-8 of `JSON.stringify([label, ...parts])`.
 *
 * First consumer: the decision log, including an unlinked actor's `local:#<digest>`.
 */
export async function keyedDigest(
  key: CryptoKey,
  label: string,
  parts: readonly string[],
): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify([label, ...parts]));
  return hexOf(new Uint8Array(await crypto.subtle.sign("HMAC", key, body)));
}

/**
 * The label of a run subject's digest. Stored digests join forever: a pin.
 *
 * First consumer: {@link subjectRefOf}.
 */
export const RUN_SUBJECT_LABEL = "run-subject";

/**
 * What a run row holds for the subject a run serves (`app:<tenant>:<sub>`, a person
 * named by a verified token): `keyedDigest(key, RUN_SUBJECT_LABEL, [subject])` under the
 * harness's subject key (`controlPaths(root).subjectKeyFile`, created `0600` by the first
 * writer that needs it). A run row is append-only, so it never holds the subject itself.
 * Rejects with the key's reason when the key cannot be read or made.
 *
 * First consumers: runtime-core's run rows and the managed daemon's run rows.
 */
export async function subjectRefOf(root: string, subject: string): Promise<string> {
  const key = await ensureDigestKey(root, { file: controlPaths(root).subjectKeyFile });
  if (key.state !== "present") throw new Error(key.reason);
  return keyedDigest(key.hmac, RUN_SUBJECT_LABEL, [subject]);
}

/**
 * The label of an unlinked local actor's digest. Stored digests join forever: a pin.
 *
 * First consumers: the command receipts, through `storedLocalActor`, and the decision log.
 */
export const LOCAL_ACTOR_LABEL = "local-actor";

/**
 * The label of a channel conversation's keyed ref on a run row (over the platform, the
 * workspace, the channel and the thread). Stored digests join forever: a pin.
 *
 * First consumer: channel-adapter-base's `acceptInbound`.
 */
export const CHANNEL_CONVERSATION_LABEL = "channel-conversation";

/**
 * The label of a channel message's keyed ref on a run row (over the platform and the
 * message's idempotency key). Stored digests join forever: a pin.
 *
 * First consumer: channel-adapter-base's `acceptInbound`.
 */
export const CHANNEL_MESSAGE_LABEL = "channel-message";

/**
 * The label of an unlinked channel sender's keyed ref on a run row (over the platform,
 * the workspace and the user). Stored digests join forever: a pin.
 *
 * First consumer: channel-adapter-base's `acceptInbound`.
 */
export const CHANNEL_SENDER_LABEL = "channel-sender";

/**
 * The label of a delegation rule's consequences page digest (over the page's canonical
 * material). Stored digests join forever: a pin.
 *
 * First consumer: control-service's delegation rules.
 */
export const CONSEQUENCES_LABEL = "delegation-consequences";

/**
 * The label of a delegation rule's terms digest. Stored digests join forever: a pin.
 *
 * First consumer: control-service's delegation rules.
 */
export const DELEGATION_TERMS_LABEL = "delegation-terms";

/**
 * The label of the host facts a delegation rule was turned on under. A pin.
 *
 * First consumer: control-service's delegation rules.
 */
export const DELEGATION_HOST_LABEL = "delegation-host";

/**
 * What an append-only record holds for an unlinked local actor (`local:<user>@<host>`):
 * `local:#<keyedDigest(key, LOCAL_ACTOR_LABEL, [actor])>`, under the key of the root the
 * record lives in. One definition, so the decision log and the receipts join.
 *
 * First consumer: the command receipts.
 */
export async function storedLocalActor(key: CryptoKey, localActor: string): Promise<string> {
  return `local:#${await keyedDigest(key, LOCAL_ACTOR_LABEL, [localActor])}`;
}
