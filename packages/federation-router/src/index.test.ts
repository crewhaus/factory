import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Discovery, createDiscovery } from "@crewhaus/federation-discovery";
import {
  FEDERATION_VERSION,
  type FederationEnvelope,
  type FederationTransport,
} from "@crewhaus/federation-protocol";
import {
  type FixtureCertSet,
  makeFixtureCertSet,
} from "../../federation-protocol/src/test-helpers";

import {
  FederationRouterError,
  type RouterTraceEvent,
  classifyRouterError,
  createFederationRouter,
} from "./index";

let certs: FixtureCertSet;

beforeAll(() => {
  certs = makeFixtureCertSet("deployment-test");
});

afterAll(() => {
  certs.cleanup();
});

function fakeDiscovery(args: {
  endpoint?: string;
  version?: string;
  publicKeyFingerprint?: string;
  fail?: string;
}): Discovery {
  return createDiscovery({
    wellKnownFetcher: async () => {
      if (args.fail) return { status: 503, body: args.fail };
      return {
        status: 200,
        body: JSON.stringify({
          endpoint: args.endpoint ?? "https://federation.deployment-b.example",
          version: args.version ?? FEDERATION_VERSION,
          supportedShapes: ["cli", "crew"],
          publicKeyFingerprint: args.publicKeyFingerprint ?? certs.pinnedFingerprint,
        }),
      };
    },
  });
}

describe("federationRouter.call — happy path (T2)", () => {
  test("discovers, builds envelope, hits transport, returns reply", async () => {
    const events: RouterTraceEvent[] = [];
    const captured: { url: string; envelope: FederationEnvelope }[] = [];
    const transport: FederationTransport = async (url, envelope) => {
      captured.push({ url, envelope });
      return { status: 200, body: JSON.stringify({ reply: "review-done" }) };
    };
    const router = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      discovery: fakeDiscovery({}),
      transport,
      currentTraceparent: () => "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });
    router.subscribe((e) => events.push(e));

    const result = await router.call({
      fromRole: "researcher",
      to: { deployment: "deployment-b.example", role: "code-reviewer" },
      payload: "review the patch",
    });

    expect(result.reply).toBe("review-done");
    expect(captured.length).toBe(1);
    expect(captured[0]?.url).toBe("https://federation.deployment-b.example/federation");
    const env = captured[0]?.envelope;
    expect(env?.federation.from).toEqual({ deployment: "deployment-a", role: "researcher" });
    expect(env?.federation.to).toEqual({
      deployment: "deployment-b.example",
      role: "code-reviewer",
    });
    expect(env?.payload).toBe("review the patch");
    expect(env?.kind).toBe("question");
    expect(env?.traceparent).toBe("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");

    expect(events.length).toBe(2);
    expect(events[0]?.kind).toBe("federation_call_start");
    expect(events[1]?.kind).toBe("federation_call_end");
  });
});

describe("federationRouter — failure modes (T8)", () => {
  test("rejects when peer's discovered fingerprint does not match local pin", async () => {
    const router = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      discovery: fakeDiscovery({ publicKeyFingerprint: "b".repeat(64) }),
      transport: async () => ({ status: 200, body: '{"reply":"x"}' }),
    });
    await expect(
      router.call({
        fromRole: "researcher",
        to: { deployment: "deployment-b.example", role: "code-reviewer" },
        payload: "x",
      }),
    ).rejects.toThrow(/pinned fingerprint mismatch/);
  });

  test("rejects when peer speaks a different version", async () => {
    const router = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      discovery: fakeDiscovery({ version: "crewhaus.federation.v0" }),
      transport: async () => ({ status: 200, body: '{"reply":"x"}' }),
    });
    await expect(
      router.call({
        fromRole: "researcher",
        to: { deployment: "deployment-b.example", role: "code-reviewer" },
        payload: "x",
      }),
    ).rejects.toThrow(/expected crewhaus.federation.v1/);
  });

  test("rejects non-200 response", async () => {
    const router = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      discovery: fakeDiscovery({}),
      transport: async () => ({ status: 502, body: "" }),
    });
    await expect(
      router.call({
        fromRole: "researcher",
        to: { deployment: "deployment-b.example", role: "code-reviewer" },
        payload: "x",
      }),
    ).rejects.toThrow(/status 502/);
  });

  test("rejects non-JSON body", async () => {
    const router = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      discovery: fakeDiscovery({}),
      transport: async () => ({ status: 200, body: "not-json{" }),
    });
    await expect(
      router.call({
        fromRole: "researcher",
        to: { deployment: "deployment-b.example", role: "code-reviewer" },
        payload: "x",
      }),
    ).rejects.toThrow(/non-JSON body/);
  });

  test("rejects body missing reply field", async () => {
    const router = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      discovery: fakeDiscovery({}),
      transport: async () => ({ status: 200, body: '{"foo":"bar"}' }),
    });
    await expect(
      router.call({
        fromRole: "researcher",
        to: { deployment: "deployment-b.example", role: "code-reviewer" },
        payload: "x",
      }),
    ).rejects.toThrow(/missing string 'reply' field/);
  });

  test("emits federation_call_error trace on failure", async () => {
    const events: RouterTraceEvent[] = [];
    const router = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      discovery: fakeDiscovery({}),
      transport: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    router.subscribe((e) => events.push(e));
    await expect(
      router.call({
        fromRole: "researcher",
        to: { deployment: "deployment-b.example", role: "code-reviewer" },
        payload: "x",
      }),
    ).rejects.toThrow();
    expect(events.some((e) => e.kind === "federation_call_error")).toBe(true);
  });
});

describe("classifyRouterError → recovery-engine taxonomy", () => {
  test("network errors → retry", () => {
    expect(classifyRouterError(new Error("ECONNREFUSED")).kind).toBe("retry");
    expect(classifyRouterError(new Error("ETIMEDOUT")).kind).toBe("retry");
    expect(classifyRouterError(new Error("federation transport timeout after 30000ms")).kind).toBe(
      "retry",
    );
    expect(classifyRouterError(new Error("peer deployment-b unreachable")).kind).toBe("retry");
  });

  test("cert/auth errors → tombstone", () => {
    expect(
      classifyRouterError(
        new Error("cert-pin mismatch: peer fingerprint deadbeef != pinned cafef00d"),
      ).kind,
    ).toBe("tombstone");
    expect(classifyRouterError(new Error("certificate has expired")).kind).toBe("tombstone");
    expect(classifyRouterError(new Error("status 401 Unauthorized")).kind).toBe("tombstone");
    expect(
      classifyRouterError(new FederationRouterError("pinned fingerprint mismatch for x")).kind,
    ).toBe("tombstone");
  });

  test("5xx → retry", () => {
    expect(classifyRouterError(new Error("peer returned status 503")).kind).toBe("retry");
    expect(classifyRouterError(new Error("status 502")).kind).toBe("retry");
  });

  test("unknown errors → fail", () => {
    expect(classifyRouterError(new Error("unrelated programmer error")).kind).toBe("fail");
  });
});

describe("subscribe / unsubscribe semantics", () => {
  test("unsubscribe stops receiving events", async () => {
    const events: RouterTraceEvent[] = [];
    const router = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: {
        caCertPem: certs.caCertPem,
        clientCertPem: certs.clientCertPem,
        clientKeyPem: certs.clientKeyPem,
        pinnedFingerprint: certs.pinnedFingerprint,
      },
      discovery: fakeDiscovery({}),
      transport: async () => ({ status: 200, body: '{"reply":"ok"}' }),
    });
    const unsub = router.subscribe((e) => events.push(e));
    await router.call({
      fromRole: "r",
      to: { deployment: "deployment-b.example", role: "x" },
      payload: "p",
    });
    expect(events.length).toBe(2);
    unsub();
    await router.call({
      fromRole: "r",
      to: { deployment: "deployment-b.example", role: "x" },
      payload: "p2",
    });
    expect(events.length).toBe(2); // no new events after unsubscribe
  });
});
