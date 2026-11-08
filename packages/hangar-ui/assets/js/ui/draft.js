/**
 * Unsent prose survives a reload: what someone typed into a comment, an
 * issue or a wiki article is kept in THIS TAB's `sessionStorage` until it is
 * sent or cleared.
 *
 * Only prose. A field that can hold a secret is never stashed: a password
 * input, anything marked `data-secret`, and anything whose `autocomplete`
 * names a credential ({@link canStash}). The spec editor's JSON pane is not
 * wired here at all, because a person can paste a key into it. A value over
 * {@link DRAFT_CAP_BYTES} is refused rather than truncated, and every storage
 * call is wrapped: a private window or a full quota loses the draft, never
 * the page.
 */

/** Every draft key starts with this. */
export const DRAFT_PREFIX = "hangar.draft.";
/** The largest draft kept, in UTF-8 bytes. */
export const DRAFT_CAP_BYTES = 64 * 1024;

/** `autocomplete` tokens that name a credential. Any `cc-*` token counts too. */
const CREDENTIAL_TOKENS = new Set(["current-password", "new-password", "one-time-code"]);

/** The storage key for a field on a route. */
export function draftKey(route, field) {
  return `${DRAFT_PREFIX}${String(route ?? "")}.${String(field ?? "")}`;
}

function attr(field, name) {
  if (field && typeof field.getAttribute === "function") {
    const value = field.getAttribute(name);
    if (value !== null) return String(value);
  }
  return null;
}

/**
 * Whether a field's text may be kept. `field` is an element, or a plain
 * `{ type, autocomplete, dataset }` record in a test. Pure.
 */
export function canStash(field) {
  if (field === null || field === undefined || typeof field !== "object") return false;
  const type = String(attr(field, "type") ?? field.type ?? "").toLowerCase();
  if (type === "password") return false;
  if (attr(field, "data-secret") !== null) return false;
  if (field.dataset && typeof field.dataset === "object" && "secret" in field.dataset) return false;
  const auto = String(attr(field, "autocomplete") ?? field.autocomplete ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (auto.some((token) => CREDENTIAL_TOKENS.has(token) || token.startsWith("cc-"))) return false;
  return true;
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function storageOf(opts) {
  if (opts && opts.storage !== undefined) return opts.storage;
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep `value` under `key`. `opts.field` is checked with {@link canStash};
 * `opts.storage` replaces `sessionStorage` in a test. Returns
 * `{ ok, reason }`; an empty value clears the draft.
 */
export function stash(key, value, opts = {}) {
  if (opts.field !== undefined && !canStash(opts.field)) return { ok: false, reason: "secret" };
  const text = String(value ?? "");
  const storage = storageOf(opts);
  if (storage === null) return { ok: false, reason: "no-storage" };
  try {
    if (text === "") {
      storage.removeItem(key);
      return { ok: true, reason: null };
    }
    if (byteLength(text) > DRAFT_CAP_BYTES) {
      storage.removeItem(key);
      return { ok: false, reason: "too-large" };
    }
    storage.setItem(key, text);
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: "storage-failed" };
  }
}

/** The kept draft, or null. */
export function restore(key, opts = {}) {
  const storage = storageOf(opts);
  if (storage === null) return null;
  try {
    const value = storage.getItem(key);
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Forget a draft (after it was sent). */
export function clearDraft(key, opts = {}) {
  const storage = storageOf(opts);
  if (storage === null) return;
  try {
    storage.removeItem(key);
  } catch {
    // nothing kept, nothing to clear
  }
}

/**
 * A draft of something that has versions (a wiki article) keeps the version
 * it was typed against, so restoring it can never pass it off as an edit of
 * a newer one. Encoded as one JSON string; an empty body encodes as "" so
 * {@link stash} clears it.
 */
export function encodeVersioned(base, body) {
  const text = String(body ?? "");
  if (text === "") return "";
  const version = Number.isInteger(base) && base >= 0 ? base : 0;
  return JSON.stringify({ v: 1, base: version, body: text });
}

/** `{ base, body }` from {@link encodeVersioned}, or null for anything else
 *  — a plain-text draft has no version, so it is never adopted as one. */
export function decodeVersioned(text) {
  if (typeof text !== "string" || text === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.v !== 1) return null;
  if (!Number.isInteger(parsed.base) || parsed.base < 0) return null;
  if (typeof parsed.body !== "string" || parsed.body === "") return null;
  return { base: parsed.base, body: parsed.body };
}

/**
 * Keep a field's text as it is typed. Returns `{ clear, kept }`: `clear()`
 * once the text has been sent, and the draft that was kept, if any. A field
 * that may hold a secret is left alone.
 *
 * Plain prose (no `opts.base`) goes straight back into an empty field.
 * With `opts.base` — a function returning the version the text is being
 * typed against — each stash carries that version, `kept` is
 * `{ base, body }`, and nothing is put back: the caller decides, because
 * only it knows whether the thing changed since.
 */
export function bindDraft(field, key, opts = {}) {
  if (!canStash(field)) return { clear: () => {}, kept: null };
  const versioned = typeof opts.base === "function";
  const raw = restore(key);
  const kept = versioned ? decodeVersioned(raw) : raw;
  if (!versioned && kept !== null && String(field.value ?? "") === "") field.value = kept;
  field.addEventListener("input", () => {
    stash(key, versioned ? encodeVersioned(opts.base(), field.value) : field.value, { field });
  });
  return { clear: () => clearDraft(key), kept };
}
