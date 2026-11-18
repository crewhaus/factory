/**
 * Shape-aware badges and the `features.<setting>` capabilities: a block a
 * harness's shape accepts and does not use reads "unwired" with the reason, on
 * the Library row, the harness detail and Home's versioned API, read against
 * the support manifest and the crewhaus version its bundle was compiled with.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { type V1Home, v1Home } from "./__test__/v1-home";
import { makeFixtureHarness } from "./fixture";
import { badgeSupport } from "./spec-view";
import { type TestServer, bootTestServer } from "./testkit";
import { HOME_AREAS, homeCompositionProblems } from "./v1/areas";
import { compilerCapabilityProviders } from "./v1/compiler";
import type { V1Context } from "./v1/context";

const WATCHME = "watchme:\n  enabled: true";
const TENANTS =
  "tenants:\n  - {id: acme, budget: {maxInputTokens: 100000, maxOutputTokens: 20000}}";
const COMPACTION = "compaction:\n  curate: true";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

type Built = { readonly entry: string; readonly compiledWith?: string } | "none";

/** Register a fixture harness of `target` declaring `extra`, with a bundle stamped as `built`. */
async function harnessOn(
  t: TestServer,
  name: string,
  target: string,
  extra: string,
  built: Built,
): Promise<string> {
  const dir = makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    target,
    specExtra: extra,
    ...(built === "none"
      ? {}
      : {
          bundle: {
            entry: built.entry,
            specHash: "0".repeat(64),
            ...(built.compiledWith !== undefined ? { compiledWith: built.compiledWith } : {}),
          },
        }),
  });
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  expect(res.status).toBe(201);
  return (res.body["entry"] as { id: string }).id;
}

/** The Library row and the detail payload for one harness. */
async function views(
  t: TestServer,
  id: string,
): Promise<{
  row: Record<string, unknown>;
  detail: Record<string, unknown>;
}> {
  const list = await t.api("/api/harnesses");
  const rows = list.body["harnesses"] as Array<Record<string, unknown>>;
  const row = rows.find((r) => r["id"] === id) as Record<string, unknown>;
  const detail = (await t.api(`/api/h/${id}`)).body;
  return { row, detail };
}

describe("badges say whether the shape uses them", () => {
  test("watchme on a managed harness built with 0.9.0 is not used there, with the reason", async () => {
    const t = bootTestServer();
    servers.push(t);
    const id = await harnessOn(t, "steward", "managed", `${TENANTS}\n${WATCHME}`, {
      entry: "daemon.ts",
      compiledWith: "0.9.0",
    });
    const { row, detail } = await views(t, id);
    for (const payload of [row, detail]) {
      const support = payload["badgeSupport"] as Record<
        string,
        { status: string; reason?: string }
      >;
      expect(support["watchme"]?.status).toBe("unwired");
      expect(support["watchme"]?.reason).toContain("managed");
      expect(payload["badgeNote"]).toBeUndefined();
    }
    expect(row["capabilities"]).toEqual(["watchme"]);
  });

  test("the same block on a cli harness is wired", async () => {
    const t = bootTestServer();
    servers.push(t);
    const id = await harnessOn(t, "helper", "cli", WATCHME, {
      entry: "agent.ts",
      compiledWith: "0.9.0",
    });
    const { row, detail } = await views(t, id);
    expect(row["badgeSupport"]).toEqual({ watchme: { status: "wired" } });
    expect(detail["badgeSupport"]).toEqual({ watchme: { status: "wired" } });
  });

  test("a bundle built before the manifest reads unknown, with one note", async () => {
    const t = bootTestServer();
    servers.push(t);
    const id = await harnessOn(t, "older", "managed", `${TENANTS}\n${WATCHME}`, {
      entry: "daemon.ts",
      compiledWith: "0.8.4",
    });
    const { row, detail } = await views(t, id);
    for (const payload of [row, detail]) {
      expect(payload["badgeSupport"]).toEqual({ watchme: { status: "unknown" } });
      expect(payload["badgeNote"]).toBe(
        "Built with CrewHaus 0.8.4. Recompile to check which settings take effect.",
      );
      expect(payload["badgeVerb"]).toBe("crewhaus compile");
    }
  });

  test("no build reads unknown, saying there is none yet", async () => {
    const t = bootTestServer();
    servers.push(t);
    const id = await harnessOn(t, "fresh", "managed", `${TENANTS}\n${WATCHME}`, "none");
    const { detail } = await views(t, id);
    expect(detail["badgeSupport"]).toEqual({ watchme: { status: "unknown" } });
    expect(detail["badgeNote"]).toBe("This harness has no build yet.");
    expect(detail["badgeVerb"]).toBe("crewhaus compile");
  });

  test("a build by a newer CrewHaus names no command", () => {
    const view = badgeSupport(
      {
        memory: false,
        wiki: false,
        dream: false,
        thredz: false,
        watchme: true,
        feedback: false,
        budget: false,
      },
      "managed",
      "0.10.0",
    );
    expect(view.badgeSupport).toEqual({ watchme: { status: "unknown" } });
    expect(view.badgeNote).toContain("newer CrewHaus (0.10.0)");
    expect(view.badgeVerb).toBeUndefined();
  });

  test("a shape this CrewHaus does not know reads unknown, never in effect", () => {
    const view = badgeSupport(
      {
        memory: false,
        wiki: false,
        dream: false,
        thredz: false,
        watchme: true,
        feedback: false,
        budget: false,
      },
      "Managed",
      "0.9.0",
    );
    expect(view.badgeSupport).toEqual({ watchme: { status: "unknown" } });
    expect(view.badgeNote).toContain('does not know the "Managed" shape');
    expect(view.badgeVerb).toBeUndefined();
  });

  test("a harness that declares no badge gets an empty map and no note", () => {
    const none = {
      memory: false,
      wiki: false,
      dream: false,
      thredz: false,
      watchme: false,
      feedback: false,
      budget: false,
    };
    expect(badgeSupport(none, "managed", undefined)).toEqual({ badgeSupport: {} });
    const wiki = { ...none, memory: true, wiki: true };
    expect(badgeSupport(wiki, "cli", "0.9.0").badgeSupport).toEqual({
      memory: { status: "wired" },
      wiki: { status: "wired" },
    });
  });
});

describe("harnesses.capabilities answers each setting", () => {
  let home: V1Home;
  afterAll(async () => {
    await home?.t.stop();
  });

  test("a managed harness: watchme is not supported, curation is, and the answer passes its schema", async () => {
    home = await v1Home();
    const managed = await home.harness("steward", {
      target: "managed",
      specExtra: `${TENANTS}\n${WATCHME}\n${COMPACTION}`,
      bundle: { entry: "daemon.ts", specHash: "0".repeat(64), compiledWith: "0.9.0" },
    });
    const res = await home.call("GET", `/api/v1/harnesses/${managed.id}/capabilities`);
    expect(res.status).toBe(200);
    const caps = res.body["capabilities"] as Record<string, unknown>;
    expect(caps["features.watchme"]).toEqual({
      supported: false,
      reason: expect.stringContaining("managed") as unknown as string,
      verb: null,
    });
    expect(caps["features.compaction.curate"]).toEqual({ supported: true });
    const schema = (
      SCHEMAS as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>
    )["harnessCapabilities"];
    expect(schema?.safeParse(res.body).success).toBe(true);

    const older = await home.harness("older", {
      target: "managed",
      specExtra: `${TENANTS}\n${WATCHME}`,
      bundle: { entry: "daemon.ts", specHash: "0".repeat(64), compiledWith: "0.8.4" },
    });
    const old = await home.call("GET", `/api/v1/harnesses/${older.id}/capabilities`);
    expect((old.body["capabilities"] as Record<string, unknown>)["features.watchme"]).toEqual({
      supported: "unknown",
      reason: "Built with CrewHaus 0.8.4. Recompile to check which settings take effect.",
    });
  }, 20_000);

  test("the composition has the compiler area and no problem", () => {
    expect(HOME_AREAS.map((a) => a.area)).toContain("compiler");
    expect(homeCompositionProblems(HOME_AREAS)).toEqual([]);
  });

  test("the providers read a harness's stamp once per request", async () => {
    let reads = 0;
    const providers = compilerCapabilityProviders(() => {
      reads += 1;
      return "0.9.0";
    });
    const entry = {
      id: "hrn_00000000000000a1",
      target: "managed",
    } as unknown as HangarHarnessEntry;
    const ctx = {} as V1Context;
    for (const provider of providers) await provider.answer(entry, ctx);
    expect(providers.length).toBeGreaterThan(40);
    expect(reads).toBe(1);
    await providers[0]?.answer(entry, {} as V1Context);
    expect(reads).toBe(2);
  });
});
