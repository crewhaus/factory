/**
 * Home's own key works only from this computer. A test that only dials loopback cannot
 * tell a peer check from none, so this one also binds Home to this machine's own
 * non-loopback IPv4 address and dials the key there, where it must be refused.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { bearer } from "./__test__/browser";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

/** This machine's first non-loopback, non-link-local IPv4 address, if it has one. */
function ownIpv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      const family = String(entry.family);
      if (
        (family === "IPv4" || family === "4") &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
}

const LAN = ownIpv4();

describe("Home's own key and the peer", () => {
  test("works from loopback", async () => {
    const t = bootTestServer({});
    servers.push(t);
    const res = await t.fetchRaw("/api/version", { headers: bearer(t.token) });
    expect(res.status).toBe(200);
  });

  test.skipIf(LAN === undefined)(
    "is refused dialled at this machine's own LAN address, and accepted on loopback beside it (skipped: this machine has no non-loopback IPv4)",
    async () => {
      const t = bootTestServer({ hostname: LAN as string });
      servers.push(t);
      const port = t.server.port;
      expect(t.server.loopbackUrl).toBe(`http://127.0.0.1:${port}`);
      const remote = await fetch(`http://${LAN}:${port}/api/version`, {
        headers: bearer(t.token),
        signal: AbortSignal.timeout(10_000),
      });
      expect(remote.status).toBe(401);
      expect(((await remote.json()) as { reason?: string }).reason).toBe(
        "bootstrap_not_accepted_here",
      );
      const local = await fetch(`http://127.0.0.1:${port}/api/version`, {
        headers: bearer(t.token),
        signal: AbortSignal.timeout(10_000),
      });
      expect(local.status).toBe(200);
    },
  );

  test("a forwarding header turns it away on loopback too", async () => {
    const t = bootTestServer({});
    servers.push(t);
    const res = await t.fetchRaw("/api/version", {
      headers: { ...bearer(t.token), "x-forwarded-for": "203.0.113.9" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason?: string }).reason).toBe("bootstrap_not_accepted_here");
  });
});
