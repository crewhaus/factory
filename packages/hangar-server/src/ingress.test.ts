/**
 * Home's receivers: a delivery is verified, claimed once and recorded before it is
 * acknowledged, and its receipt settles when the work does.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldStates } from "@crewhaus/control-records";
import { wireControl, workspaceCommandsLedger } from "@crewhaus/control-service";
import { type Receiver, createIngress, receiverProblems, verifyHmacSha256 } from "./ingress";
import { bootTestServer } from "./testkit";
import { HOME_CORE, homeCompositionProblems } from "./v1/areas";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const SECRET = ["test", "signing", "secret"].join("-");

function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function receiver(overrides: Partial<Receiver> = {}, gate?: Promise<void>): Receiver {
  return {
    provider: "test",
    via: "github",
    kind: "legacy.hookTest",
    origin: "api",
    verify: async (req, raw) => verifyHmacSha256(SECRET, raw, req.headers.get("x-signature") ?? ""),
    dedupeRef: (req) => req.headers.get("x-delivery") ?? undefined,
    handle: async () => {
      await gate;
      return { state: "succeeded" };
    },
    ...overrides,
  };
}

function setUp(r: Receiver, warnings: string[] = []) {
  const hangarRoot = mkdtempSync(join(tmpdir(), "hangar-ingress-"));
  roots.push(hangarRoot);
  const control = wireControl(
    {
      hangarRoot,
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
      identity: { username: "sam", hostname: "laptop" },
      probe: { isAlive: () => true, startTimeMs: () => undefined },
    },
    { mode: "server" },
  );
  const ingress = createIngress({
    hangarRoot,
    receivers: [r],
    control,
    now: () => Date.parse("2026-11-13T00:00:00.000Z"),
    onWarn: (message) => warnings.push(message),
  });
  const receipts = () => {
    const fold = foldStates(workspaceCommandsLedger(hangarRoot));
    return fold.ok ? [...fold.objects.values()].map((object) => object.record) : [];
  };
  const inbound = () => {
    const dir = join(hangarRoot, "ingress", "test");
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  return { hangarRoot, control, ingress, receipts, inbound };
}

function delivery(body: string, id: string | undefined, signature?: string): Request {
  const headers: Record<string, string> = {
    "x-signature": signature ?? createHmac("sha256", SECRET).update(body).digest("hex"),
  };
  if (id !== undefined) headers["x-delivery"] = id;
  return new Request("http://127.0.0.1/hooks/test/events", { method: "POST", headers, body });
}

describe("verifyHmacSha256", () => {
  test("agrees with node:crypto, and refuses any other signature", async () => {
    const payload = '{"event":"push"}';
    const good = createHmac("sha256", SECRET).update(payload).digest("hex");
    expect(await verifyHmacSha256(SECRET, payload, good)).toBe(true);
    expect(await verifyHmacSha256(SECRET, payload, good.toUpperCase())).toBe(true);
    expect(await verifyHmacSha256(SECRET, `${payload} `, good)).toBe(false);
    expect(await verifyHmacSha256("other", payload, good)).toBe(false);
    expect(await verifyHmacSha256(SECRET, payload, good.slice(0, 62))).toBe(false);
    expect(await verifyHmacSha256(SECRET, payload, "zz".repeat(32))).toBe(false);
  });
});

describe("a delivery", () => {
  test("a bad signature: 401, and nothing is written", async () => {
    const s = setUp(receiver());
    const res = await s.ingress.fetch(delivery("{}", "d1", "00".repeat(32)));
    expect(res.status).toBe(401);
    expect(s.receipts()).toEqual([]);
    expect(existsSync(join(s.hangarRoot, "ingress"))).toBe(false);
    expect(existsSync(join(s.hangarRoot, "control"))).toBe(false);
  });

  test("no delivery id: 400, and nothing is written", async () => {
    const s = setUp(receiver());
    const res = await s.ingress.fetch(delivery("{}", undefined));
    expect(res.status).toBe(400);
    expect(s.receipts()).toEqual([]);
  });

  test("a good one is recorded before the answer, then settles when the work does", async () => {
    const gate = deferred();
    const s = setUp(receiver({}, gate.promise));
    const res = await s.ingress.fetch(delivery('{"n":1}', "delivery-1"));
    expect(res.status).toBe(200);
    // The work is still waiting: the receipt and the inbound record are already there.
    const [receipt] = s.receipts();
    expect(receipt?.["state"]).toBe("accepted");
    expect(receipt?.["actor"]).toBe("sys:ingress");
    expect(receipt?.["via"]).toBe("github");
    expect(receipt?.["kind"]).toBe("legacy.hookTest");
    expect(s.inbound()).toEqual([`${String(receipt?.["id"])}.json`]);
    gate.open();
    await s.ingress.idle();
    expect(s.receipts()[0]?.["state"]).toBe("succeeded");
    expect(s.inbound()).toEqual([]);
  });

  test("the same delivery id again: 200 duplicate, one receipt, and the claim under claims/ingress", async () => {
    const s = setUp(receiver());
    expect((await s.ingress.fetch(delivery('{"n":1}', "delivery-2"))).status).toBe(200);
    await s.ingress.idle();
    const again = await s.ingress.fetch(delivery('{"n":2}', "delivery-2"));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
    expect(s.receipts()).toHaveLength(1);
    const claims = readdirSync(join(s.hangarRoot, "control", "claims", "ingress"));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatch(/^test-[0-9a-f]{32}\.json$/);
  });

  test("a record that cannot be written: 503, the claim is given up, and the retry is handled once", async () => {
    let handled = 0;
    const warnings: string[] = [];
    const s = setUp(
      receiver({
        handle: async () => {
          handled += 1;
          return { state: "succeeded" };
        },
      }),
      warnings,
    );
    // A file where the inbound records' directory goes: the record cannot be written.
    writeFileSync(join(s.hangarRoot, "ingress"), "in the way");
    const first = await s.ingress.fetch(delivery('{"n":1}', "delivery-lost"));
    expect(first.status).toBe(503);
    await s.ingress.idle();
    expect(handled).toBe(0);
    const [failed] = s.receipts();
    expect(failed?.["state"]).toBe("failed");
    expect((failed?.["outcome"] as { code: string }).code).toBe("unavailable");
    expect(failed?.["effects"]).toEqual([{ kind: "inbound-record", status: "failed" }]);
    expect(warnings.some((w) => w.includes("could not be recorded"))).toBe(true);
    expect(readdirSync(join(s.hangarRoot, "control", "claims", "ingress"))).toEqual([]);

    rmSync(join(s.hangarRoot, "ingress"));
    const retry = await s.ingress.fetch(delivery('{"n":1}', "delivery-lost"));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { ok?: boolean }).ok).toBe(true);
    await s.ingress.idle();
    expect(handled).toBe(1);
    const again = await s.ingress.fetch(delivery('{"n":1}', "delivery-lost"));
    expect(await again.json()).toEqual({ duplicate: true });
    await s.ingress.idle();
    expect(handled).toBe(1);
    expect(s.receipts().map((r) => r["state"])).toEqual(["failed", "succeeded"]);
  });

  test("a claim still held by a delivery that was never recorded is given up on the next attempt", async () => {
    let handled = 0;
    const warnings: string[] = [];
    const s = setUp(
      receiver({
        handle: async () => {
          handled += 1;
          return { state: "succeeded" };
        },
      }),
      warnings,
    );
    writeFileSync(join(s.hangarRoot, "ingress"), "in the way");
    // The first release fails, so the never-recorded receipt keeps the claim.
    const ledgers = spyOn(s.control.ledgers, "workspace").mockImplementationOnce(() => {
      throw new Error("the ledger is busy");
    });
    try {
      expect((await s.ingress.fetch(delivery("{}", "delivery-held"))).status).toBe(503);
    } finally {
      ledgers.mockRestore();
    }
    expect(warnings.some((w) => w.includes("was not released"))).toBe(true);
    expect(readdirSync(join(s.hangarRoot, "control", "claims", "ingress"))).toHaveLength(1);
    rmSync(join(s.hangarRoot, "ingress"));
    // Replayed onto a receipt that never recorded it: not a duplicate, and the claim goes.
    const replay = await s.ingress.fetch(delivery("{}", "delivery-held"));
    expect(replay.status).toBe(503);
    expect(readdirSync(join(s.hangarRoot, "control", "claims", "ingress"))).toEqual([]);
    const retry = await s.ingress.fetch(delivery("{}", "delivery-held"));
    expect(retry.status).toBe(200);
    await s.ingress.idle();
    expect(handled).toBe(1);
  });

  test("a claim whose delivery is still being recorded is answered 503, not duplicate", async () => {
    const s = setUp(receiver());
    // The winner of the claim has its receipt and no inbound record yet.
    const digest = createHash("sha256").update("delivery-busy").digest("hex").slice(0, 32);
    const held = await s.control.commands.submit({
      kind: "legacy.hookTest",
      actor: "sys:ingress",
      ledger: "workspace",
      via: "github",
      params: { provider: "test", delivery: digest },
      dedupeClaim: `ingress/test-${digest}`,
    });
    expect(held.ok).toBe(true);
    const res = await s.ingress.fetch(delivery("{}", "delivery-busy"));
    expect(res.status).toBe(503);
    expect(s.receipts()).toHaveLength(1);
  });

  test("work that throws settles the receipt failed", async () => {
    const s = setUp(
      receiver({
        handle: async () => {
          throw new Error("boom");
        },
      }),
    );
    await s.ingress.fetch(delivery("{}", "delivery-3"));
    await s.ingress.idle();
    const [receipt] = s.receipts();
    expect(receipt?.["state"]).toBe("failed");
    expect((receipt?.["outcome"] as { code: string }).code).toBe("internal");
  });

  test("an unknown provider and another path: 404", async () => {
    const s = setUp(receiver());
    const other = new Request("http://127.0.0.1/hooks/nobody/x", { method: "POST", body: "{}" });
    expect((await s.ingress.fetch(other)).status).toBe(404);
    expect((await s.ingress.fetch(new Request("http://127.0.0.1/api/fleet"))).status).toBe(404);
  });
});

describe("the receivers a composition may hold", () => {
  test("each refusal is named", () => {
    const problems = receiverProblems([
      { area: "core", receiver: receiver() },
      { area: "integrations", receiver: receiver() },
      { area: "core", receiver: receiver({ provider: "Bad_Name" }) },
      { area: "core", receiver: receiver({ provider: "o", origin: "webhook" as never }) },
      { area: "core", receiver: receiver({ provider: "v", via: "email" as never }) },
      { area: "core", receiver: receiver({ provider: "k", kind: "hooks.delivered" }) },
    ]);
    expect(problems).toEqual([
      'receiver "test" registered twice (areas "core" and "integrations")',
      'receiver provider "Bad_Name" is not a provider name (area "core")',
      'receiver "o" declares origin "webhook", which is not a TrustOrigin (area "core")',
      'receiver "v" declares via "email", which is not a receipt door (area "core")',
      'receiver "k" declares kind "hooks.delivered", which is not a receipt kind (area "core")',
    ]);
  });

  test("a sweep named twice or run more often than once a second is refused", () => {
    const tick = { name: "reconcile", everyMs: 500, run: () => undefined };
    expect(homeCompositionProblems([HOME_CORE, { area: "quality", sweeps: [tick] }])).toEqual([
      'sweep "reconcile" registered twice (areas "core" and "quality")',
      'sweep "reconcile" runs every 500 ms, more often than once a second (area "quality")',
    ]);
    expect(homeCompositionProblems([HOME_CORE])).toEqual([]);
  });
});

describe("Home's listeners", () => {
  let serveSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    serveSpy?.mockRestore();
    serveSpy = undefined;
  });

  test("the console never answers /hooks, and with no receiver composed nothing more binds", async () => {
    serveSpy = spyOn(Bun, "serve");
    const plain = bootTestServer();
    const baseline = serveSpy.mock.calls.length;
    await plain.stop();
    expect(baseline).toBeGreaterThan(0);
    serveSpy.mockClear();
    const t = bootTestServer({ ingress: { port: 0 } });
    try {
      // The console's own listeners, and nothing for the ingress.
      expect(serveSpy.mock.calls.length).toBe(baseline);
      expect(t.server.ingress).toBeUndefined();
      const res = await t.fetchRaw("/hooks/test/x", { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    } finally {
      await t.stop();
    }
  });

  test("every composition refusal is named in the boot error, and nothing binds", () => {
    serveSpy = spyOn(Bun, "serve");
    const fast = { name: "fast", everyMs: 100, run: () => undefined };
    let message = "";
    try {
      bootTestServer({
        areas: [
          HOME_CORE,
          {
            area: "integrations",
            sweeps: [fast, { ...fast, everyMs: 5000 }],
            receivers: [
              receiver(),
              receiver(),
              receiver({ provider: "No_Good" }),
              receiver({ provider: "o", origin: "webhook" as never }),
              receiver({ provider: "v", via: "email" as never }),
              receiver({ provider: "k", kind: "hooks.delivered" }),
            ],
          },
        ],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    for (const line of [
      'sweep "fast" registered twice (areas "integrations" and "integrations")',
      'sweep "fast" runs every 100 ms, more often than once a second (area "integrations")',
      'receiver "test" registered twice (areas "integrations" and "integrations")',
      'receiver provider "No_Good" is not a provider name (area "integrations")',
      'receiver "o" declares origin "webhook", which is not a TrustOrigin (area "integrations")',
      'receiver "v" declares via "email", which is not a receipt door (area "integrations")',
      'receiver "k" declares kind "hooks.delivered", which is not a receipt kind (area "integrations")',
    ]) {
      expect(message).toContain(line);
    }
    expect(serveSpy).toHaveBeenCalledTimes(0);
  });

  test("a receiver composed with an origin that is not a TrustOrigin refuses boot, naming it", () => {
    serveSpy = spyOn(Bun, "serve");
    expect(() =>
      bootTestServer({
        areas: [
          HOME_CORE,
          { area: "integrations", receivers: [receiver({ origin: "webhook" as never })] },
        ],
        ingress: { port: 0 },
      }),
    ).toThrow('receiver "test" declares origin "webhook", which is not a TrustOrigin');
    expect(serveSpy).toHaveBeenCalledTimes(0);
  });

  test("with a receiver composed, the ingress binds loopback and answers it there only", async () => {
    serveSpy = spyOn(Bun, "serve");
    // The console on another host than the ingress's, so an ingress that took the
    // console's host would be seen.
    const t = bootTestServer({
      hostname: "localhost",
      areas: [HOME_CORE, { area: "quality", receivers: [receiver()] }],
      ingress: { port: 0 },
    });
    try {
      const ingress = t.server.ingress;
      if (ingress === undefined) throw new Error("no ingress");
      expect(t.server.hostname).toBe("localhost");
      // The bind itself: the call that made the ingress's socket asked for loopback.
      const results = serveSpy.mock.results as { readonly value: { readonly port?: number } }[];
      const bound = serveSpy.mock.calls.filter(
        (_call, i) => results[i]?.value?.port === ingress.port,
      );
      expect(bound).toHaveLength(1);
      expect((bound[0]?.[0] as { hostname?: string }).hostname).toBe("127.0.0.1");
      expect(ingress.hostname).toBe("127.0.0.1");
      const body = '{"n":1}';
      const res = await fetch(`${ingress.url}/hooks/test/events`, {
        method: "POST",
        headers: {
          "x-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
          "x-delivery": "listener-1",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(200);
      expect((await fetch(`${ingress.url}/api/fleet`)).status).toBe(404);
    } finally {
      await t.stop();
    }
  });
});
