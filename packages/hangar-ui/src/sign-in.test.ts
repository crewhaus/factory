/**
 * Signing a browser in, under a stubbed `fetch`, sessionStorage, address and an
 * in-memory IndexedDB. Home's half is the real one (`@crewhaus/access-control`'s sealing,
 * loaded by path), so a sealed answer here opens exactly as it would in a browser.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  NOT_ENCRYPTED,
  OWN_KEY,
  boot,
  canonicalJson,
  parseSignInLink,
  signOut,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/sign-in.js";

type Jwk = { kty: "EC"; crv: "P-256"; x: string; y: string };
type SealSecret = (seal: Jwk, secret: string, op: string) => Promise<unknown>;

const sealSecret = async (): Promise<SealSecret> =>
  (
    (await import(new URL("../../access-control/src/sealed.ts", import.meta.url).href)) as {
      sealSecret: SealSecret;
    }
  ).sealSecret;

const SESSION = `cha_${"S".repeat(43)}`;
const BOOT_PATH = `/boot/${"ab".repeat(32)}`;

// ---------------------------------------------------------------------------
// The browser around the module
// ---------------------------------------------------------------------------

type Call = {
  method: string;
  path: string;
  body: unknown;
  hashAtSend: string;
  auth: string | null;
};

let calls: Call[] = [];
let storage: Map<string, string>;
let idb: ReturnType<typeof fakeIndexedDB>;
let navigatedTo: string[] = [];
const real = {
  fetch: globalThis.fetch,
  sessionStorage: (globalThis as Record<string, unknown>)["sessionStorage"],
  location: (globalThis as Record<string, unknown>)["location"],
  history: (globalThis as Record<string, unknown>)["history"],
  indexedDB: (globalThis as Record<string, unknown>)["indexedDB"],
};

function fakeIndexedDB() {
  const stores = new Map<string, Map<unknown, unknown>>();
  let created = false;
  const request = (run: () => unknown) => {
    const req: Record<string, unknown> = {};
    queueMicrotask(() => {
      try {
        req["result"] = run();
        (req["onsuccess"] as (() => void) | undefined)?.();
      } catch (err) {
        req["error"] = err;
        (req["onerror"] as (() => void) | undefined)?.();
      }
    });
    return req;
  };
  return {
    stores,
    open() {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        req["result"] = {
          createObjectStore: (name: string) => stores.set(name, new Map()),
          transaction: () => ({
            objectStore: (name: string) => {
              const map = stores.get(name) as Map<unknown, unknown>;
              return {
                get: (key: unknown) => request(() => map.get(key)),
                put: (value: unknown, key: unknown) => request(() => map.set(key, value) && key),
                delete: (key: unknown) => request(() => map.delete(key) && undefined),
              };
            },
          }),
          close: () => {},
        };
        if (!created) {
          created = true;
          (req["onupgradeneeded"] as (() => void) | undefined)?.();
        }
        (req["onsuccess"] as (() => void) | undefined)?.();
      });
      return req;
    },
  };
}

const location = { pathname: "/", search: "", hash: "" } as Record<string, unknown>;

type Responder = (call: Call) => Promise<Response> | Response;
let respond: Responder;

beforeEach(() => {
  calls = [];
  navigatedTo = [];
  storage = new Map();
  idb = fakeIndexedDB();
  location["hash"] = "";
  location["replace"] = (url: string) => navigatedTo.push(url);
  location["assign"] = (url: string) => navigatedTo.push(url);
  const g = globalThis as Record<string, unknown>;
  g["location"] = location;
  g["history"] = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      const hash = url.indexOf("#");
      location["hash"] = hash === -1 ? "" : url.slice(hash);
    },
  };
  g["sessionStorage"] = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, String(v)),
    removeItem: (k: string) => storage.delete(k),
  };
  g["indexedDB"] = idb;
  respond = () => new Response("{}", { status: 404 });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      hashAtSend: String(location["hash"]),
      auth: headers["authorization"] ?? null,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = real.fetch;
  const g = globalThis as Record<string, unknown>;
  for (const key of ["sessionStorage", "location", "history", "indexedDB"] as const) {
    if (real[key] === undefined) Reflect.deleteProperty(g, key);
    else g[key] = real[key];
  }
});

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const refusal = (status: number, reason: string): Response =>
  new Response(
    JSON.stringify({
      error: { code: "unauthenticated", message: reason, retryable: false, details: { reason } },
    }),
    {
      status,
    },
  );

/** Home's sealed answer to an exchange or a session request. */
async function sealedAnswer(
  call: Call,
  op: string,
  device = "dev_01JD0000000000000000000000",
): Promise<Response> {
  const seal = (call.body as { seal: Jwk }).seal;
  return ok({
    issued: await (await sealSecret())(seal, SESSION, op),
    expiresAt: "2026-11-11T12:00:00.000Z",
    principal: "prn_01JD0000000000000000000000",
    device,
  });
}

// ---------------------------------------------------------------------------

describe("a boot link's #x= code", () => {
  test("is off the address before the exchange is sent, and signs the tab in", async () => {
    location["hash"] = `#x=${"c".repeat(43)}`;
    respond = (call) =>
      call.path === "/api/v1/auth/exchange"
        ? sealedAnswer(call, "auth.exchange")
        : refusal(404, "x");
    const answer = await boot();
    expect(answer.signedIn).toBe(true);
    const exchange = calls.find((c) => c.path === "/api/v1/auth/exchange");
    expect(exchange).toBeDefined();
    expect(exchange?.hashAtSend).toBe("");
    expect((exchange?.body as { code: string }).code).toBe("c".repeat(43));
    expect(storage.get("hangar.session")).toBe(SESSION);
    expect(location["hash"]).toBe("#/");
    // The new device key is kept, non-extractable.
    const record = idb.stores.get("device")?.get("current") as { id: string; key: CryptoKey };
    expect(record.id).toBe("dev_01JD0000000000000000000000");
    expect(record.key.extractable).toBe(false);
  });
});

describe("a tab an earlier release left holding Home's own key", () => {
  test("trades it once for a boot link, and deletes it", async () => {
    storage.set("hangar.token", "legacy-key");
    location["hash"] = "#/h/hrn_0123456789abcdef/runs";
    respond = (call) =>
      call.path === "/api/boot-ticket" ? ok({ bootPath: BOOT_PATH }) : refusal(404, "x");
    const answer = await boot();
    expect(answer).toEqual({ signedIn: false, navigating: true });
    const traded = calls.filter((c) => c.path === "/api/boot-ticket");
    expect(traded.length).toBe(1);
    expect(traded[0]?.auth).toBe("Bearer legacy-key");
    expect(storage.has("hangar.token")).toBe(false);
    expect(navigatedTo).toEqual([BOOT_PATH]);
    // The screen it was on comes back after the link.
    expect(storage.get("hangar.return")).toBe("#/h/hrn_0123456789abcdef/runs");
  });

  test("deletes it when Home refuses it too, and shows the screen", async () => {
    storage.set("hangar.token", "legacy-key");
    respond = (call) =>
      call.path === "/api/boot-ticket"
        ? refusal(401, "bootstrap_not_accepted_here")
        : call.path === "/api/v1/auth/challenge"
          ? ok({ nonce: "n", expiresAt: "2026-11-11T00:01:00.000Z" })
          : refusal(404, "x");
    const answer = await boot();
    expect(answer.signedIn).toBe(false);
    expect(calls.filter((c) => c.path === "/api/boot-ticket").length).toBe(1);
    expect(storage.has("hangar.token")).toBe(false);
    expect(navigatedTo).toEqual([]);
  });
});

describe("a pasted value", () => {
  test("Home's own key is recognised, so it is never sent or stored", () => {
    expect(parseSignInLink("ab".repeat(32))).toEqual({ kind: "key" });
    expect(parseSignInLink(` ${"AB".repeat(32)} `)).toEqual({ kind: "key" });
    expect(calls).toEqual([]);
    expect(storage.size).toBe(0);
    expect(OWN_KEY).toContain("crewhaus hangar open");
  });

  test("a boot link and a #x= link are read; anything else is not a link", () => {
    expect(parseSignInLink(`http://127.0.0.1:4200${BOOT_PATH}`)).toEqual({
      kind: "boot",
      path: BOOT_PATH,
    });
    expect(parseSignInLink(BOOT_PATH)).toEqual({ kind: "boot", path: BOOT_PATH });
    expect(parseSignInLink(`http://localhost:4200/#x=${"d".repeat(43)}`)).toEqual({
      kind: "code",
      code: "d".repeat(43),
    });
    for (const text of ["", "hello", "/boot/xyz", "#t=abc", "https://evil.example.test/#x=a"]) {
      expect(parseSignInLink(text).kind).toBe("invalid");
    }
  });
});

describe("this browser's key", () => {
  async function enrolled(): Promise<void> {
    location["hash"] = `#x=${"c".repeat(43)}`;
    respond = (call) =>
      call.path === "/api/v1/auth/exchange"
        ? sealedAnswer(call, "auth.exchange")
        : refusal(404, "x");
    expect((await boot()).signedIn).toBe(true);
    storage.delete("hangar.session");
    calls = [];
  }

  test("signs a returning tab in, binding its signature to the seal it sends", async () => {
    await enrolled();
    respond = (call) =>
      call.path === "/api/v1/auth/challenge"
        ? ok({ nonce: "nonce-1", expiresAt: "2026-11-11T00:01:00.000Z" })
        : call.path === "/api/v1/auth/session"
          ? sealedAnswer(call, "auth.session")
          : refusal(404, "x");
    expect((await boot()).signedIn).toBe(true);
    const session = calls.find((c) => c.path === "/api/v1/auth/session");
    const body = session?.body as { device: string; nonce: string; signature: string; seal: Jwk };
    expect(body.nonce).toBe("nonce-1");
    expect(body.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(storage.get("hangar.session")).toBe(SESSION);
  });

  test("survives a network error, and is deleted when Home says it was withdrawn", async () => {
    await enrolled();
    respond = () => {
      throw new TypeError("network down");
    };
    expect((await boot()).signedIn).toBe(false);
    expect(idb.stores.get("device")?.has("current")).toBe(true);

    respond = (call) =>
      call.path === "/api/v1/auth/challenge"
        ? ok({ nonce: "nonce-2", expiresAt: "2026-11-11T00:01:00.000Z" })
        : call.path === "/api/v1/auth/session"
          ? refusal(401, "device_revoked")
          : refusal(404, "x");
    expect((await boot()).signedIn).toBe(false);
    expect(idb.stores.get("device")?.has("current")).toBe(false);
  });

  test("after signing out, a reload waits to be asked rather than signing straight back in", async () => {
    await enrolled();
    storage.set("hangar.session", SESSION);
    respond = (call) =>
      call.path === "/api/v1/auth/sign-out" ? ok({ signedOut: true }) : refusal(404, "x");
    expect(await signOut()).toBe(true);
    expect(storage.has("hangar.session")).toBe(false);
    expect(idb.stores.get("device")?.has("current")).toBe(true);
    calls = [];
    respond = (call) =>
      call.path === "/api/v1/auth/challenge"
        ? ok({ nonce: "n", expiresAt: "x" })
        : refusal(404, "x");
    expect((await boot()).signedIn).toBe(false);
    expect(calls.some((c) => c.path === "/api/v1/auth/session")).toBe(false);
  });
});

describe("the signed bytes", () => {
  test("canonical JSON sorts keys and drops undefined, as the server's does", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined, d: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"d":{"y":2,"z":1}}',
    );
  });

  test("a page that is not encrypted is told so", async () => {
    (globalThis as Record<string, unknown>)["isSecureContext"] = false;
    try {
      respond = (call) =>
        call.path === "/api/v1/auth/challenge"
          ? ok({ nonce: "n", expiresAt: "x" })
          : refusal(404, "x");
      const answer = await boot();
      expect(answer).toEqual({ signedIn: false, message: NOT_ENCRYPTED });
    } finally {
      Reflect.deleteProperty(globalThis, "isSecureContext");
    }
  });
});
