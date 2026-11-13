/**
 * Signing this browser in to Home.
 *
 * A browser never holds Home's own key. It holds two things:
 *
 *   - a DEVICE KEY: a non-extractable ECDSA P-256 key made here with WebCrypto and kept
 *     in IndexedDB (database `crewhaus-home`, store `device`, `{id: dev_…, key}`). Script
 *     on this page can use it while the page is open but cannot read it out;
 *   - a SESSION: a `cha_…` secret Home seals to this tab (see `sealed.js`), kept in
 *     sessionStorage (`hangar.session`) and gone with the tab. It lasts an hour from its
 *     last use and twelve hours at most.
 *
 * `boot()` runs before the router. Before anything else it takes an old `#t=<key>` link
 * (Home's own key in the address, which earlier releases printed) off the address and
 * keeps the key only in memory, for step (d). An invite link (`/invite#c=<code>`) is taken
 * off the address the same way, and the join screen asks for one thing, the person's name:
 * where this page can make keys it joins with a device key and a sealed session; on a page
 * that is not encrypted it makes a session secret itself, which lives only in this tab and
 * cannot be renewed. Then, in this order:
 *
 *   a. `#x=<code>` in the address: the one-time code a boot link (`crewhaus hangar open`)
 *      redirects to. It is removed from the address FIRST, then traded, with a new device
 *      key, for a session;
 *   b. else a session already in this tab;
 *   c. else a device key: ask for a challenge, sign it, get a session;
 *   d. else Home's own key from an earlier release (that `#t=` link, or a tab still
 *      holding it as `hangar.token`): traded once for a boot link (which works only on
 *      Home's own computer) and dropped, whatever the answer; never stored;
 *   e. else a request with no credential at all: a Home started with --no-auth, or one
 *      behind a trusted proxy that vouched for this person, answers it, and the tab is
 *      signed in as far as Home is concerned;
 *   f. else the sign-in screen.
 *
 * After a 401, (c) runs once, silently, before the screen. A device key is deleted only
 * when Home says it is unknown, withdrawn or unused for 30 days, never on a network error.
 * After the person signs out, (c) waits for them to ask (the screen offers it), so a
 * reload does not sign them straight back in.
 */

import { api, getSession, setSession } from "./api.js";
import { canSeal, makeSeal } from "./sealed.js";

const DB_NAME = "crewhaus-home";
const STORE = "device";
const RECORD = "current";
const LEGACY_TOKEN_KEY = "hangar.token";
const RETURN_KEY = "hangar.return";
/** Set when the person signed out of this tab, so a reload does not sign it back in. */
const SIGNED_OUT_KEY = "hangar.signed-out";
/** Home's answers that mean this browser's key will never work again. */
const FORGET_REASONS = new Set(["device_unknown", "device_revoked", "device_expired"]);
const BOOT_PATH_RE = /^\/boot\/[0-9a-f]{64}$/;
const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** An invite code, as `crewhaus access invite` and the `--lan` QR code carry it. */
const INVITE_CODE_RE = /^chi_[A-Za-z0-9_-]{43}$/;
/** A second silent sign-in this soon after the last one means it is not working. */
const SILENT_RETRY_MS = 60_000;

// ---------------------------------------------------------------------------
// The signed bytes
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: keys sorted, no whitespace. A copy of control-contract's
 * `canonicalJson` for the one object this page signs; a test signs here and verifies
 * on the server, so the two cannot drift apart.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined)
        parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What a device signs to sign in: the challenge, bound to this request's seal. */
export function signedPayload({ device, nonce, seal }) {
  return canonicalJson({
    v: 1,
    op: "auth.session",
    device,
    nonce,
    seal: { kty: seal.kty, crv: seal.crv, x: seal.x, y: seal.y },
  });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign a challenge with the device key: ECDSA P-256 / SHA-256, `r||s`, base64url. */
export async function signChallenge(privateKey, input) {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signedPayload(input)),
  );
  return base64url(signature);
}

/** A new device key: the private half never leaves WebCrypto. */
export async function makeDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    deviceJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
  };
}

// ---------------------------------------------------------------------------
// Where the device key lives
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const db = globalThis.indexedDB;
    if (db === undefined || db === null) {
      reject(new Error("no IndexedDB"));
      return;
    }
    const request = db.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function withStore(mode, use) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = use(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

/** This browser's device key, `{id, key}`, or null. */
export async function readDevice() {
  try {
    const record = await withStore("readonly", (store) => store.get(RECORD));
    if (record && typeof record.id === "string" && record.key) return record;
  } catch {
    // No IndexedDB (a private window may refuse it): no device key.
  }
  return null;
}

async function saveDevice(record) {
  try {
    await withStore("readwrite", (store) => store.put(record, RECORD));
  } catch {
    // Unsaved: this tab is signed in, and the next one asks for a link again.
  }
}

/** Delete this browser's device key. */
export async function forgetDevice() {
  try {
    await withStore("readwrite", (store) => store.delete(RECORD));
  } catch {
    // Nothing stored, or nowhere to store it.
  }
}

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function replaceAddress(hash) {
  const loc = globalThis.location;
  globalThis.history?.replaceState(null, "", `${loc.pathname}${loc.search}${hash}`);
}

/** Remember the screen the person was on, to come back to after a sign-in that navigates. */
export function rememberReturn(hash) {
  const value = typeof hash === "string" && hash.startsWith("#/") ? hash : "#/";
  try {
    storage()?.setItem(RETURN_KEY, value);
  } catch {
    // Without storage the person lands on the Library.
  }
}

function signedOutHere() {
  try {
    return storage()?.getItem(SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function markSignedOut(on) {
  try {
    if (on) storage()?.setItem(SIGNED_OUT_KEY, "1");
    else storage()?.removeItem(SIGNED_OUT_KEY);
  } catch {
    // Without storage, a reload signs back in with the device key.
  }
}

function takeReturn() {
  try {
    const value = storage()?.getItem(RETURN_KEY) ?? null;
    storage()?.removeItem(RETURN_KEY);
    return typeof value === "string" && value.startsWith("#/") ? value : "#/";
  } catch {
    return "#/";
  }
}

// ---------------------------------------------------------------------------
// The flows
// ---------------------------------------------------------------------------

/** Whether this page can sign in: WebCrypto exists only on an encrypted or local page. */
export function canSignIn() {
  return globalThis.isSecureContext !== false && canSeal();
}

function refusalOf(answer) {
  const error = answer?.body?.error;
  const reason = typeof error?.details?.reason === "string" ? error.details.reason : "";
  const message =
    answer.status === 0
      ? "Home could not be reached. Check that it is still running."
      : typeof error?.message === "string"
        ? error.message
        : "Signing in did not work.";
  return { ok: false, reason, message, network: answer.status === 0 };
}

/** Trade a one-time code for a session, with a new device key for this browser. */
export async function exchangeCode(code) {
  if (!canSignIn()) return { ok: false, reason: "insecure", message: NOT_ENCRYPTED };
  const device = await makeDeviceKey();
  const sealed = await makeSeal();
  const answer = await api.authExchange({ code, deviceJwk: device.deviceJwk, seal: sealed.seal });
  if (!answer.ok) return refusalOf(answer);
  let secret;
  try {
    secret = await sealed.open(answer.body.issued, "auth.exchange");
  } catch {
    return { ok: false, reason: "sealed", message: "Home's answer could not be opened." };
  }
  setSession(secret);
  markSignedOut(false);
  if (typeof answer.body.device === "string") {
    await saveDevice({ id: answer.body.device, key: device.privateKey });
  }
  return { ok: true };
}

/** Sign in with this browser's device key, if it has one. */
export async function signInWithDevice() {
  if (!canSignIn()) return { ok: false, reason: "insecure", message: NOT_ENCRYPTED };
  const device = await readDevice();
  if (device === null) return { ok: false, reason: "no_device", message: "" };
  const challenge = await api.authChallenge();
  if (!challenge.ok || typeof challenge.body.nonce !== "string") return refusalOf(challenge);
  const sealed = await makeSeal();
  let signature;
  try {
    signature = await signChallenge(device.key, {
      device: device.id,
      nonce: challenge.body.nonce,
      seal: sealed.seal,
    });
  } catch {
    return { ok: false, reason: "signing", message: "This browser's key could not sign." };
  }
  const answer = await api.authSession({
    device: device.id,
    nonce: challenge.body.nonce,
    signature,
    seal: sealed.seal,
  });
  if (!answer.ok) {
    const refusal = refusalOf(answer);
    if (FORGET_REASONS.has(refusal.reason)) await forgetDevice();
    return refusal;
  }
  try {
    setSession(await sealed.open(answer.body.issued, "auth.session"));
  } catch {
    return { ok: false, reason: "sealed", message: "Home's answer could not be opened." };
  }
  markSignedOut(false);
  return { ok: true };
}

/** Whether this browser has a device key to sign in with. */
export async function hasDevice() {
  return (await readDevice()) !== null;
}

/**
 * A tab from an earlier release may still hold Home's own key. Trade it, once, for a
 * boot link, and delete it whatever the answer. Answers `"navigated"` when the browser
 * is on its way to the link.
 */
export async function migrateLegacyToken(fromAddress = null) {
  const store = storage();
  let legacy = null;
  try {
    legacy = store?.getItem(LEGACY_TOKEN_KEY) ?? null;
  } catch {
    legacy = null;
  }
  if (legacy === null || legacy === "") legacy = fromAddress;
  if (legacy === null || legacy === "") return "none";
  let answer;
  try {
    answer = await api.bootTicket(legacy);
  } finally {
    try {
      store?.removeItem(LEGACY_TOKEN_KEY);
    } catch {
      // Nowhere to delete it from.
    }
  }
  const bootPath = answer?.ok ? answer.body?.bootPath : undefined;
  if (typeof bootPath !== "string" || !BOOT_PATH_RE.test(bootPath)) return "none";
  rememberReturn(globalThis.location.hash);
  globalThis.location.replace(bootPath);
  return "navigated";
}

export const NOT_ENCRYPTED =
  "This page is not encrypted, so this browser can't sign in here. Open Home on its own computer.";

/** Said on a join screen served over plain HTTP, where this tab keeps its own sign-in. */
export const CONNECTION_NOT_ENCRYPTED = "This connection is not encrypted.";

/**
 * Join Home from an invite. Where this page can make keys, with a new device key and a
 * session sealed to this tab; elsewhere, with a session secret this tab makes itself, which
 * Home keeps only a digest of, lives in this tab alone and cannot be renewed.
 */
export async function acceptInvite(code, displayName) {
  const name = String(displayName ?? "").trim();
  if (name === "") return { ok: false, reason: "invalid", message: "Type your name." };
  if (canSignIn()) {
    const device = await makeDeviceKey();
    const sealed = await makeSeal();
    const answer = await api.authAcceptInvite({
      code,
      displayName: name,
      deviceJwk: device.deviceJwk,
      seal: sealed.seal,
    });
    if (!answer.ok) return refusalOf(answer);
    let secret;
    try {
      secret = await sealed.open(answer.body.issued, "auth.acceptInvite");
    } catch {
      return { ok: false, reason: "sealed", message: "Home's answer could not be opened." };
    }
    setSession(secret);
    markSignedOut(false);
    if (typeof answer.body.device === "string") {
      await saveDevice({ id: answer.body.device, key: device.privateKey });
    }
    return { ok: true, tabOnly: false };
  }
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    return { ok: false, reason: "insecure", message: NOT_ENCRYPTED };
  }
  const sessionSecret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const answer = await api.authAcceptInvite({ code, displayName: name, sessionSecret });
  if (!answer.ok) return refusalOf(answer);
  if (answer.body?.tabOnly !== true) {
    return { ok: false, reason: "tab_only", message: "Home did not accept this tab's sign-in." };
  }
  setSession(`cha_${sessionSecret}`);
  markSignedOut(false);
  return { ok: true, tabOnly: true };
}

/** The invite code an invite link carries, taken off the address; null when there is none. */
function takeInviteCode() {
  const loc = globalThis.location;
  const found = /^#c=([A-Za-z0-9_-]+)$/.exec(loc.hash);
  if (found === null) return null;
  // Off the address first, and out of history: nothing after this can show or replay it.
  globalThis.history?.replaceState(null, "", `/${loc.search}#/`);
  return INVITE_CODE_RE.test(found[1]) ? found[1] : "";
}

export const OWN_KEY =
  "That is Home's own key. It stays on that computer; use the link from `crewhaus hangar open` instead.";

/**
 * What the person pasted into "Sign-in link": a boot link, a `#x=` code, Home's own key
 * (never sent or stored), or something else.
 */
export function parseSignInLink(text) {
  const value = String(text ?? "").trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return { kind: "key" };
  const code = /#x=([A-Za-z0-9_-]+)$/.exec(value);
  if (code !== null && CODE_RE.test(code[1])) return { kind: "code", code: code[1] };
  const boot = /(\/boot\/[0-9a-f]{64})\/?$/.exec(value);
  if (boot !== null) return { kind: "boot", path: boot[1] };
  return { kind: "invalid" };
}

/** Follow a pasted boot link on this page's own address, coming back here afterwards. */
export function followBootLink(path) {
  rememberReturn(globalThis.location.hash);
  globalThis.location.assign(path);
}

/**
 * Take an old `#t=<key>` link off the address before anything else runs, and hand the key
 * back (held in memory only), or null.
 */
function takeLegacyAddressKey() {
  const legacy = /^#t=(.+)$/.exec(globalThis.location.hash);
  if (legacy === null) return null;
  replaceAddress("#/");
  try {
    return decodeURIComponent(legacy[1]);
  } catch {
    return legacy[1];
  }
}

/** Sign in from the address and storage, before the router starts. */
export async function boot() {
  const addressKey = takeLegacyAddressKey();
  const invite = takeInviteCode();
  if (invite !== null) {
    return invite === ""
      ? { signedIn: false, message: "That invite link is not complete. Ask for a new one." }
      : { signedIn: false, invite };
  }
  const loc = globalThis.location;
  let message = "";
  const fragment = /^#x=([A-Za-z0-9_-]+)$/.exec(loc.hash);
  if (fragment !== null) {
    // Off the address first: nothing after this point can leak or replay it.
    replaceAddress("");
    const exchanged = await exchangeCode(fragment[1]);
    replaceAddress(takeReturn());
    if (exchanged.ok) return { signedIn: true };
    message = exchanged.message;
  }
  if (getSession()) return { signedIn: true };
  if (!signedOutHere()) {
    const device = await signInWithDevice();
    if (device.ok) return { signedIn: true };
    if (!device.network && device.reason !== "no_device" && message === "") {
      message = device.message;
    }
  }
  if ((await migrateLegacyToken(addressKey)) === "navigated") {
    return { signedIn: false, navigating: true };
  }
  // A Home started with --no-auth, or a trusted proxy that vouched for this person,
  // answers a request that carries no credential: nothing to sign in to.
  if (await answersWithoutCredential()) return { signedIn: true };
  if (!canSignIn()) message = NOT_ENCRYPTED;
  return { signedIn: false, message };
}

/** Whether Home answers this tab with no credential at all. */
async function answersWithoutCredential() {
  const probe = await api.probe();
  return probe.ok;
}

let lastSilent = Number.NEGATIVE_INFINITY;
let recovering = null;

/**
 * After a 401: drop the dead session and try the device key once, silently. Answers
 * whether the tab is signed in again; when not, the caller shows the screen.
 */
export function recover() {
  if (recovering !== null) return recovering;
  recovering = (async () => {
    setSession(null);
    const now = Date.now();
    if (now - lastSilent < SILENT_RETRY_MS) return false;
    lastSilent = now;
    const answer = await signInWithDevice();
    return answer.ok;
  })().finally(() => {
    recovering = null;
  });
  return recovering;
}

/** Sign out: end the session at Home, clear it here, and, when asked, forget this browser. */
export async function signOut({ forget = false } = {}) {
  const answer = await api.authSignOut();
  setSession(null);
  markSignedOut(true);
  if (forget) await forgetDevice();
  return answer.ok || answer.status === 401;
}
