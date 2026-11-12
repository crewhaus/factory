/**
 * What the gateway reads of a request body before it knows who sent it.
 *
 * The JSON-RPC plane checks the bearer before it reads a byte of the body: a
 * malformed body without a valid bearer is answered 401, and with one it is
 * answered 400. The federation route reads a body only when federation is on,
 * and then at most `federation.maxBodyBytes` of it (FEDERATION_MAX_BODY_BYTES
 * by default): past that it is answered 413 before the peer is authorized.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEDERATION_VERSION, encodeFederationEnvelope } from "@crewhaus/federation-protocol";
import { buildTenant } from "@crewhaus/tenancy";
import {
  FEDERATION_MAX_BODY_BYTES,
  type GatewayFederationConfig,
  createGatewayServer,
  signJwt,
} from "./index";

const SECRET = ["body", "order", "fixture"].join("-");
let tmp = "";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "gateway-body-order-"));
});
afterAll(() => {
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

function countingStream(chunks: number, chunkBytes: number) {
  const counter = { pulled: 0 };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) {
        controller.close();
        return;
      }
      sent++;
      counter.pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x7b));
    },
  });
  return { stream, counter };
}

async function withServer(
  opts: Partial<Parameters<typeof createGatewayServer>[0]>,
  fn: (base: string, handled: { count: number }) => Promise<void>,
): Promise<void> {
  const handled = { count: 0 };
  const server = createGatewayServer({
    jwtSecret: SECRET,
    tenantsRoot: tmp,
    tenantOverrides: { "tenant-a": buildTenant("tenant-a", { tenantsRoot: tmp }) },
    handler: async () => {
      handled.count++;
      return { ok: true };
    },
    ...opts,
  });
  const { port, close } = await server.listen(0, "127.0.0.1");
  try {
    await fn(`http://127.0.0.1:${port}`, handled);
  } finally {
    await close();
  }
}

describe("the JSON-RPC plane checks the bearer before it reads the body", () => {
  test("no bearer: a malformed body is answered 401, not parsed", async () => {
    await withServer({}, async (base, handled) => {
      const res = await fetch(base, { method: "POST", body: "{not json" });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: { code: "unauthorized", message: "missing bearer token" },
      });
      expect(handled.count).toBe(0);
    });
  });

  test("a bearer that does not verify: 401 the same way", async () => {
    await withServer({}, async (base) => {
      const forged = signJwt({ tenant_id: "tenant-a" }, `${SECRET}-other`);
      const res = await fetch(base, {
        method: "POST",
        headers: { authorization: `Bearer ${forged}` },
        body: "{not json",
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    });
  });

  test("a valid bearer still gets its body read and parsed (the control)", async () => {
    await withServer({}, async (base) => {
      const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
      const res = await fetch(base, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("POST /federation reads a body only when federation is on, and only so much", () => {
  test("federation off: 404 without parsing the body", async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/federation`, { method: "POST", body: "{not json" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "federation is not enabled" });
    });
  });

  test("federation on: a streamed body over the limit is 413 and the peer is never dispatched to", async () => {
    let dispatched = 0;
    let authorized = 0;
    await withServer(
      {
        federation: {
          identity: {
            name: "dep",
            description: "a peer",
            endpoint: "https://dep.example",
            publicKeyFingerprint: "a".repeat(64),
          },
          dispatch: async () => {
            dispatched++;
            return "never";
          },
          authorize: () => {
            authorized++;
            return { ok: true };
          },
        },
      },
      async (base) => {
        // A malformed body within the limit is answered as before.
        const bad = await fetch(`${base}/federation`, { method: "POST", body: "{not json" });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({ error: "request body must be JSON" });
        const chunkBytes = 64 * 1024;
        const chunks = (FEDERATION_MAX_BODY_BYTES / chunkBytes) * 4;
        const { stream, counter } = countingStream(chunks, chunkBytes);
        const res = await fetch(`${base}/federation`, {
          method: "POST",
          body: stream,
          duplex: "half",
        } as RequestInit);
        expect(res.status).toBe(413);
        expect(dispatched).toBe(0);
        expect(authorized).toBe(0);
        // The client may have written ahead of the read, but not the whole body.
        expect(counter.pulled).toBeLessThan(chunks * chunkBytes);
      },
    );
  }, 20_000); // streams 4 MiB through a real socket; slow on a loaded CI runner
});

function envelope(payload: string): string {
  return encodeFederationEnvelope({
    version: FEDERATION_VERSION,
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    federation: {
      from: { deployment: "peer-a", role: "client" },
      to: { deployment: "dep", role: "server" },
      mtls: { client_cert_subject: "CN=peer-a" },
    },
    kind: "question",
    payload,
  });
}

function federationWith(
  counts: { authorized: number; dispatched: number },
  maxBodyBytes?: number,
): GatewayFederationConfig {
  return {
    identity: {
      name: "dep",
      description: "a peer",
      endpoint: "https://dep.example",
      publicKeyFingerprint: "a".repeat(64),
    },
    // Denies, so a large envelope that is read stops at a cheap 403.
    authorize: () => {
      counts.authorized++;
      return { ok: false, reason: "not allowlisted" };
    },
    dispatch: async () => {
      counts.dispatched++;
      return { reply: "never" };
    },
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
  };
}

describe("federation.maxBodyBytes sets how much of a POST /federation body is read", () => {
  // 1.5 MiB of payload: over the default limit, under a raised one.
  const large = envelope("p".repeat(1536 * 1024));

  test("unset: a 1.5 MiB envelope is 413 and the peer is not authorized", async () => {
    const counts = { authorized: 0, dispatched: 0 };
    await withServer({ federation: federationWith(counts) }, async (base) => {
      const res = await fetch(`${base}/federation`, { method: "POST", body: large });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: `payload too large: the limit is ${FEDERATION_MAX_BODY_BYTES} bytes`,
      });
      expect(counts).toEqual({ authorized: 0, dispatched: 0 });
    });
  }, 20_000); // sends 1.5 MiB through a real socket; slow on a loaded CI runner

  test("raised to 2 MiB: the same envelope is read and reaches authorize", async () => {
    const counts = { authorized: 0, dispatched: 0 };
    await withServer({ federation: federationWith(counts, 2 * 1024 * 1024) }, async (base) => {
      const res = await fetch(`${base}/federation`, { method: "POST", body: large });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "federation denied: not allowlisted" });
      expect(counts).toEqual({ authorized: 1, dispatched: 0 });
    });
  }, 20_000); // sends 1.5 MiB through a real socket; slow on a loaded CI runner

  test("lowered to 1 KiB: a 2 KiB envelope is 413, a small one still reaches authorize", async () => {
    const counts = { authorized: 0, dispatched: 0 };
    await withServer({ federation: federationWith(counts, 1024) }, async (base) => {
      const over = await fetch(`${base}/federation`, {
        method: "POST",
        body: envelope("p".repeat(2048)),
      });
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({ error: "payload too large: the limit is 1024 bytes" });
      expect(counts.authorized).toBe(0);
      const small = await fetch(`${base}/federation`, { method: "POST", body: envelope("hi") });
      expect(small.status).toBe(403);
      expect(counts.authorized).toBe(1);
    });
  });

  test("a limit that is not a non-negative integer is refused when the server is created", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createGatewayServer({
          jwtSecret: SECRET,
          tenantsRoot: tmp,
          handler: async () => ({ ok: true }),
          federation: federationWith({ authorized: 0, dispatched: 0 }, bad),
        }),
      ).toThrow("federation.maxBodyBytes must be a non-negative integer");
    }
  });
});
