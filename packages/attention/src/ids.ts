/**
 * An item's id and its evidence revision. The id is the digest of what the item is about
 * (`attentionKey(scope, kind, key)`), so the same evidence names the same item in every
 * process; the revision is the digest of the evidence and its states, so it moves only
 * when the evidence does.
 *
 * A key holds ids, kinds, names, classes and digests only: never a message, a path or a
 * value. {@link KEY_SHAPE_RE} says which characters a key may hold.
 */
import { createHash } from "node:crypto";
import {
  attIdFromDigest,
  attentionKey,
  attentionRef,
  canonicalJson,
} from "@crewhaus/control-contract";

/** sha256 of UTF-8 text, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The first `n` hex characters of sha256(text). */
export function digestPrefix(text: string, n: number): string {
  return sha256Hex(text).slice(0, n);
}

/**
 * What an item key may hold: ids (`appr_…`, `dec_…`, `rev_…`, `hrn_…`, `dep_…`), kinds,
 * provider and env names, failure classes, decimal counts and hex digests, joined by
 * `:` and `@`. No space, slash or quote, so no message or path fits.
 */
export const KEY_SHAPE_RE = /^[A-Za-z0-9_.-]+(?:[:@][A-Za-z0-9_.-]+)*$/;

/** The `att_` id of an item. */
export function attIdOf(scope: string, kind: string, key: string): string {
  const digest = createHash("sha256")
    .update(attentionKey(scope, kind, key), "utf8")
    .digest();
  return attIdFromDigest(new Uint8Array(digest));
}

/** The ref of an item: `home/attention/att_…`. */
export function attRefOf(scope: string, kind: string, key: string): string {
  return attentionRef(attIdOf(scope, kind, key));
}

/** One piece of evidence as the revision counts it: its id and its state. */
export type RevisionPart = { readonly id: string; readonly state: string };

/**
 * The first 16 hex characters of sha256 over the canonical JSON of the evidence ids and
 * their states, sorted by id: the same evidence in any order gives the same revision.
 */
export function evidenceRevOf(parts: readonly RevisionPart[]): string {
  const sorted = [...parts]
    .map((p) => ({ id: p.id, state: p.state }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.state < b.state ? -1 : 1));
  return sha256Hex(canonicalJson(sorted)).slice(0, 16);
}
