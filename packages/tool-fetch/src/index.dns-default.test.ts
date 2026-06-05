/**
 * Isolated coverage for the DEFAULT DNS resolver wired into `assertNotSsrf`.
 *
 * `index.ts` defines one `defaultDnsLookup = (host) => dnsLookup(host, …)` and
 * references it from both the initial `dnsLookupFn` binding and the
 * `_setDnsLookup(undefined)` restorer. The main `index.test.ts` always installs
 * a stub via `_setDnsLookup(PUBLIC_DNS_STUB)`, so that genuine default — which
 * calls `node:dns/promises`'s `lookup` — never runs there. We exercise it here
 * with the default resolver restored, but with `node:dns/promises` mocked so NO
 * real DNS query (and no socket) is issued. `mock.module` mutates the
 * process-global module registry, so this lives in its own file to keep the
 * stub from leaking into `index.test.ts`.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// Record the hosts the default resolver asks about, and answer deterministically
// — public for the rebind-allow case, private for the rebind-block case.
const lookupCalls: string[] = [];
let nextAddress = "93.184.216.34";

mock.module("node:dns/promises", () => ({
  lookup: async (host: string, _opts?: { verbatim?: boolean }) => {
    lookupCalls.push(host);
    return { address: nextAddress, family: 4 };
  },
}));

// Import AFTER the stub is registered so `import { lookup } from
// "node:dns/promises"` inside index.ts binds to the mock.
const { assertNotSsrf, FetchPermissionError, _setDnsLookup } = await import("./index");

describe("default DNS resolver (node:dns/promises lookup)", () => {
  afterEach(() => {
    lookupCalls.length = 0;
    nextAddress = "93.184.216.34";
  });

  test("default resolver resolves a public host via node:dns/promises and pins it", async () => {
    nextAddress = "93.184.216.34";
    _setDnsLookup(undefined); // install the genuine `defaultDnsLookup`
    const pinned = await assertNotSsrf("public.example.com");
    expect(pinned).toBe("93.184.216.34");
    // The default resolver delegated to node:dns/promises (mocked here).
    expect(lookupCalls).toEqual(["public.example.com"]);
  });

  test("default resolver feeds the SSRF check: a private answer is rejected", async () => {
    nextAddress = "10.1.2.3"; // RFC1918 → must be rejected
    _setDnsLookup(undefined);
    await expect(assertNotSsrf("rebind.example.com")).rejects.toBeInstanceOf(FetchPermissionError);
    expect(lookupCalls).toEqual(["rebind.example.com"]);
  });
});
