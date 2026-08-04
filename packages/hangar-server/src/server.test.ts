import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HANGAR_SERVER_VERSION, PROTOCOL_V } from "./constants";
import { feedbackRecord, logLine, makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});
function boot(opts: Parameters<typeof bootTestServer>[0] = {}): TestServer {
  const t = bootTestServer(opts);
  servers.push(t);
  return t;
}

/** Register a fixture harness through the API and return its id. */
async function register(t: TestServer, dir: string): Promise<string> {
  const { status, body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  expect(status).toBe(201);
  return (body["entry"] as { id: string }).id;
}

function goldenHarness(t: TestServer): string {
  return makeFixtureHarness(join(t.harnessesRoot, "golden"), {
    specName: "golden-harness",
    sessions: [
      {
        id: "sess_00000000000000aa",
        updatedAt: iso(NOW - DAY),
        lastTurnIndex: 2,
        log: [
          logLine("user_message", { content: "hello" }, iso(NOW - DAY)),
          logLine(
            "cost_accrual",
            {
              provider: "anthropic",
              modelId: "m-alpha",
              costUsdMicros: 1000,
              inputTokens: 10,
              outputTokens: 5,
            },
            iso(NOW - DAY),
          ),
          logLine(
            "cost_accrual",
            { provider: "anthropic", modelId: "m-alpha", costUsdMicros: 1000 },
            iso(NOW - DAY),
          ),
          logLine(
            "cost_accrual",
            { provider: "openai", modelId: "m-beta", costUsdMicros: 500 },
            iso(NOW - 30 * DAY),
          ),
          logLine(
            "cost_accrual",
            { provider: "anthropic", modelId: "m-alpha", costUsdMicros: 9999, summary: true },
            iso(NOW - DAY),
          ),
          '{"kind":"cost_accrual","payload":{"costUsdMicros":77', // torn line
          logLine(
            "user_feedback",
            feedbackRecord("sess_00000000000000aa", 1, "up", iso(NOW - DAY)),
          ),
        ],
      },
      { id: "sess_00000000000000bb", updatedAt: iso(NOW - 2 * DAY) },
    ],
    feedback: {
      manual: [feedbackRecord("sess_00000000000000aa", 2, "down", iso(NOW - DAY))],
    },
    evalIndex: [
      {
        runId: "run_000000000000000a",
        specName: "golden-harness",
        specHash: "x",
        datasetName: "smoke",
        datasetHash: "y",
        passRate: 0.8,
        meanScore: 0.8,
        sampleCount: 5,
        ts: iso(NOW - 3 * DAY),
        outDir: "/gone",
      },
      {
        runId: "run_000000000000000b",
        specName: "golden-harness",
        specHash: "x",
        datasetName: "smoke",
        datasetHash: "y",
        passRate: 0.9,
        meanScore: 0.9,
        sampleCount: 5,
        ts: iso(NOW - 1 * DAY),
        outDir: "/gone",
      },
    ],
  });
}

/** The golden fixture's zero-filled 7-day cost buckets at `NOW`: 2 priced
 *  calls (2000 micros) land on yesterday, everything else is zero. */
function goldenDays(): Array<{ day: string; usdMicros: number; calls: number }> {
  const days: Array<{ day: string; usdMicros: number; calls: number }> = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = iso(NOW - i * DAY).slice(0, 10);
    days.push(i === 1 ? { day, usdMicros: 2000, calls: 2 } : { day, usdMicros: 0, calls: 0 });
  }
  return days;
}

describe("healthz + version + static", () => {
  test("healthz is unauthenticated; version requires auth and reports protocolV", async () => {
    const t = boot({ now: () => NOW });
    const health = await t.fetchRaw("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    expect((await t.fetchRaw("/api/version")).status).toBe(401);
    const { status, body } = await t.api("/api/version");
    expect(status).toBe(200);
    expect(body).toEqual({ hangar: HANGAR_SERVER_VERSION, protocolV: PROTOCOL_V });
  });

  test("static shell serves injected assets, falls back to a builtin index, and 404s the rest", async () => {
    const t = boot({
      assets: {
        "/index.html": { body: "<html>ui-shell</html>", contentType: "text/html; charset=utf-8" },
        "/assets/app.js": { body: "console.log(1)", contentType: "text/javascript" },
      },
    });
    const index = await t.fetchRaw("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("ui-shell");
    const js = await t.fetchRaw("/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect((await t.fetchRaw("/assets/missing.js")).status).toBe(404);

    const bare = boot();
    const builtin = await bare.fetchRaw("/");
    expect(builtin.status).toBe(200);
    expect(await builtin.text()).toContain("Hangar manager API");
  });
});

describe("auth", () => {
  test("every /api route 401s without (or with a wrong) bearer token", async () => {
    const t = boot();
    const id = "hrn_0123456789abcdef";
    const gets = [
      "/api/version",
      "/api/harnesses",
      "/api/registry/groups",
      "/api/registry/scan-roots",
      "/api/costs",
      `/api/h/${id}`,
      `/api/h/${id}/spec`,
      `/api/h/${id}/preflight`,
      `/api/h/${id}/sessions`,
      `/api/h/${id}/sessions/sess_0123456789abcdef`,
      `/api/h/${id}/evals`,
      `/api/h/${id}/evals/run_0123456789abcdef`,
      `/api/h/${id}/memory/facts`,
      `/api/h/${id}/memory/wiki/some-article`,
      `/api/h/${id}/costs`,
      "/api/definitely-not-a-route",
    ];
    for (const path of gets) {
      const bare = await t.fetchRaw(path);
      expect(`${path} ${bare.status}`).toBe(`${path} 401`);
      expect(bare.headers.get("www-authenticate")).toBe("Bearer");
      const wrong = await t.fetchRaw(path, {
        headers: { authorization: "Bearer definitely-wrong" },
      });
      expect(wrong.status).toBe(401);
    }
    const mutations: Array<[string, string]> = [
      ["POST", "/api/harnesses"],
      ["POST", "/api/scan"],
      ["POST", `/api/h/${id}/relocate`],
      ["PUT", `/api/h/${id}/groups`],
      ["DELETE", `/api/h/${id}`],
      ["POST", "/api/registry/groups"],
      ["DELETE", "/api/registry/scan-roots"],
    ];
    for (const [method, path] of mutations) {
      const res = await t.fetchRaw(path, { method, body: "{}" });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 401`);
    }
    // With the real token the same routes never 401.
    for (const path of gets) {
      const { status } = await t.api(path);
      expect(status).not.toBe(401);
    }
  });

  test("the token is minted 0600 under the hangar root and reloaded across boots", async () => {
    const t = boot();
    expect(t.server.tokenPath).toBe(join(t.hangarRoot, "token"));
    const mode = statSync(t.server.tokenPath as string).mode & 0o777;
    expect(mode).toBe(0o600);
    const again = bootTestServer({});
    servers.push(again);
    expect(again.token).not.toBe(t.token); // different roots → different tokens
  });

  test("noAuth disables the check with a logged warning", async () => {
    const t = boot({ noAuth: true });
    expect(t.warnings.some((w) => w.includes("AUTH DISABLED"))).toBe(true);
    const res = await t.fetchRaw("/api/version");
    expect(res.status).toBe(200);
    expect(t.server.token).toBeUndefined();
  });
});

describe("registry CRUD over HTTP", () => {
  test("manual add validates the dir, warns (not fails) on an unreadable spec, and lists", async () => {
    const t = boot({ now: () => NOW });
    const withSpec = makeFixtureHarness(join(t.harnessesRoot, "with-spec"), {
      specName: "with-spec",
    });
    const noSpec = makeFixtureHarness(join(t.harnessesRoot, "no-spec"), { noSpec: true });

    const rel = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir: "relative/path" }),
    });
    expect(rel.status).toBe(400);
    const gone = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir: join(t.harnessesRoot, "does-not-exist") }),
    });
    expect(gone.status).toBe(400);

    const ok = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir: withSpec }),
    });
    expect(ok.status).toBe(201);
    expect(ok.body["warnings"]).toEqual([]);
    expect((ok.body["entry"] as { specName: string }).specName).toBe("with-spec");

    const warned = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir: noSpec }),
    });
    expect(warned.status).toBe(201);
    expect((warned.body["warnings"] as string[]).length).toBe(1);

    const list = await t.api("/api/harnesses");
    expect(list.status).toBe(200);
    expect((list.body["harnesses"] as unknown[]).length).toBe(2);
  });

  test("groups/tags/pin/notes PUTs, group collection CRUD, and DELETE /api/h/:id", async () => {
    const t = boot({ now: () => NOW });
    const dir = makeFixtureHarness(join(t.harnessesRoot, "crud"), { specName: "crud" });
    const id = await register(t, dir);

    expect(
      (
        await t.api("/api/registry/groups", {
          method: "POST",
          body: JSON.stringify({ name: "prod", color: "#4f9" }),
        })
      ).status,
    ).toBe(201);
    const put = await t.api(`/api/h/${id}/groups`, {
      method: "PUT",
      body: JSON.stringify({ groups: ["prod"] }),
    });
    expect(put.status).toBe(200);
    expect((put.body["entry"] as { groups: string[] }).groups).toEqual(["prod"]);
    expect(
      (
        (
          await t.api(`/api/h/${id}/tags`, {
            method: "PUT",
            body: JSON.stringify({ tags: ["slack"] }),
          })
        ).body["entry"] as { tags: string[] }
      ).tags,
    ).toEqual(["slack"]);
    expect(
      (
        (
          await t.api(`/api/h/${id}/pin`, {
            method: "PUT",
            body: JSON.stringify({ pinned: true }),
          })
        ).body["entry"] as { pinned: boolean }
      ).pinned,
    ).toBe(true);
    expect(
      (
        (
          await t.api(`/api/h/${id}/notes`, {
            method: "PUT",
            body: JSON.stringify({ notes: "the fixture" }),
          })
        ).body["entry"] as { notes: string }
      ).notes,
    ).toBe("the fixture");

    const renamed = await t.api("/api/registry/groups", {
      method: "PUT",
      body: JSON.stringify({ name: "prod", rename: "production" }),
    });
    expect(renamed.status).toBe(200);
    const groups = await t.api("/api/registry/groups");
    expect((groups.body["groups"] as Array<{ name: string }>).map((g) => g.name)).toEqual([
      "production",
    ]);
    // The rename rewrote entry membership too.
    const detail = await t.api(`/api/h/${id}`);
    expect((detail.body["entry"] as { groups: string[] }).groups).toEqual(["production"]);

    expect(
      (
        await t.api("/api/registry/groups", {
          method: "DELETE",
          body: JSON.stringify({ name: "production" }),
        })
      ).body["removed"],
    ).toBe(true);

    const del = await t.api(`/api/h/${id}`, { method: "DELETE" });
    expect(del.body["removed"]).toBe(true);
    expect((await t.api(`/api/h/${id}`)).status).toBe(404);
  });

  test("scan roots CRUD + POST /api/scan discovers and upserts with origin scan", async () => {
    const t = boot({ now: () => NOW });
    makeFixtureHarness(join(t.harnessesRoot, "scan-a"), { specName: "scan-a" });
    makeFixtureHarness(join(t.harnessesRoot, "nested", "scan-b"), { specName: "scan-b" });

    expect(
      (
        await t.api("/api/registry/scan-roots", {
          method: "POST",
          body: JSON.stringify({ dir: t.harnessesRoot, depth: 6 }),
        })
      ).status,
    ).toBe(201);

    const first = await t.api("/api/scan", { method: "POST" });
    expect(first.status).toBe(200);
    expect(first.body["roots"]).toBe(1);
    expect(first.body["discovered"]).toBe(2);
    expect(first.body["added"]).toBe(2);
    expect(first.body["refreshed"]).toBe(0);

    const second = await t.api("/api/scan", { method: "POST" });
    expect(second.body["added"]).toBe(0);
    expect(second.body["refreshed"]).toBe(2);

    const rows = (await t.api("/api/harnesses")).body["harnesses"] as Array<{
      specName: string;
      origin: string;
    }>;
    expect(rows.map((r) => `${r.specName}:${r.origin}`).sort()).toEqual([
      "scan-a:scan",
      "scan-b:scan",
    ]);

    const roots = await t.api("/api/registry/scan-roots");
    const root = (roots.body["scanRoots"] as Array<{ lastScanAt: string | null }>)[0];
    expect(root?.lastScanAt).toBe(iso(NOW));

    expect(
      (
        await t.api("/api/registry/scan-roots", {
          method: "DELETE",
          body: JSON.stringify({ dir: t.harnessesRoot }),
        })
      ).body["removed"],
    ).toBe(true);
  });

  test("relocate moves an entry to an existing dir and 409s on a conflict", async () => {
    const t = boot({ now: () => NOW });
    const dirA = makeFixtureHarness(join(t.harnessesRoot, "reloc-a"), { specName: "reloc" });
    const dirB = makeFixtureHarness(join(t.harnessesRoot, "reloc-b"), { specName: "reloc" });
    const dirC = makeFixtureHarness(join(t.harnessesRoot, "reloc-c"), { specName: "other" });
    const id = await register(t, dirA);
    const idC = await register(t, dirC);

    rmSync(dirA, { recursive: true, force: true });
    const moved = await t.api(`/api/h/${id}/relocate`, {
      method: "POST",
      body: JSON.stringify({ newDir: dirB }),
    });
    expect(moved.status).toBe(200);
    expect((moved.body["entry"] as { dir: string; id: string }).dir).toBe(dirB);
    expect((moved.body["entry"] as { id: string }).id).toBe(id);

    const conflict = await t.api(`/api/h/${idC}/relocate`, {
      method: "POST",
      body: JSON.stringify({ newDir: dirB }),
    });
    expect(conflict.status).toBe(409);
  });
});

describe("/api/harnesses rows + rollup cache", () => {
  test("golden row: cold rollup is null, hydrate computes, warm serves the cache", async () => {
    const clock = { t: NOW };
    const t = boot({ now: () => clock.t });
    const dir = goldenHarness(t);
    const id = await register(t, dir);

    // COLD: cheap fields render, rollup is null.
    const cold = (await t.api("/api/harnesses")).body["harnesses"] as Array<
      Record<string, unknown>
    >;
    expect(cold.length).toBe(1);
    const coldRow = cold[0] as Record<string, unknown>;
    expect(coldRow["rollup"]).toBeNull();
    expect(coldRow["specName"]).toBe("golden-harness");
    expect(coldRow["model"]).toBe("anthropic/claude-sonnet-4");

    // Pin the log's mtime to a whole millisecond first: utimesSync truncates
    // sub-ms precision, and the warm-path proof below must re-set the SAME
    // mtime after swapping the bytes.
    const logPath = join(dir, ".crewhaus", "sessions", "sess_00000000000000aa.jsonl");
    const pinnedMtime = new Date(NOW - DAY);
    utimesSync(logPath, pinnedMtime, pinnedMtime);

    // HYDRATE: the golden row, ids/dir/digest normalized.
    const rows = (await t.api("/api/harnesses?hydrate=1")).body["harnesses"] as Array<
      Record<string, unknown>
    >;
    const row = rows[0] as Record<string, unknown>;
    const rollup = row["rollup"] as Record<string, unknown>;
    expect(typeof rollup["digest"]).toBe("string");
    const normalized = {
      ...row,
      id: "<id>",
      dir: "<dir>",
      rollup: { ...rollup, digest: "<digest>" },
    };
    expect(normalized).toEqual({
      id: "<id>",
      dir: "<dir>",
      specName: "golden-harness",
      target: "cli",
      model: "anthropic/claude-sonnet-4",
      origin: "manual",
      groups: [],
      tags: [],
      pinned: false,
      notes: "",
      kind: "local",
      registeredAt: iso(NOW),
      lastSeen: iso(NOW),
      missingSince: null,
      capabilities: [],
      evalHealthy: true, // runs exist but no baseline is pinned
      cachedAt: iso(NOW),
      rollup: {
        digest: "<digest>",
        cachedAt: iso(NOW),
        lastEval: { datasetName: "smoke", passRate: 0.9, ts: iso(NOW - DAY) },
        sessionCount: 2,
        feedbackCount: 2,
        spend7d: 2000,
        costBreakdown: {
          totalUsdMicros: 2500,
          calls: 3,
          spend7dUsdMicros: 2000,
          byModel: [
            {
              provider: "anthropic",
              modelId: "m-alpha",
              calls: 2,
              usdMicros: 2000,
              inputTokens: 10,
              outputTokens: 5,
            },
            {
              provider: "openai",
              modelId: "m-beta",
              calls: 1,
              usdMicros: 500,
              inputTokens: 0,
              outputTokens: 0,
            },
          ],
          days: goldenDays(),
          truncatedFiles: 0,
        },
      },
    });

    // WARM: digest matches → the CACHED rollup (original cachedAt), even
    // though the clock moved — and even though the log bytes were swapped
    // for garbage of the same size+mtime, proving no session JSONL is read
    // on the warm path.
    clock.t = NOW + DAY;
    const stat = statSync(logPath);
    writeFileSync(logPath, "#".repeat(stat.size));
    utimesSync(logPath, pinnedMtime, pinnedMtime);
    const warmRow = (
      (await t.api("/api/harnesses")).body["harnesses"] as Array<Record<string, unknown>>
    )[0] as Record<string, unknown>;
    const warmRollup = warmRow["rollup"] as Record<string, unknown>;
    expect(warmRollup["cachedAt"]).toBe(iso(NOW));
    expect(warmRollup["spend7d"]).toBe(2000);
  });

  test("touching a source file invalidates (rollup null + stale cachedAt); deleting the cache dir is always safe", async () => {
    const clock = { t: NOW };
    const t = boot({ now: () => clock.t });
    const dir = goldenHarness(t);
    const id = await register(t, dir);
    await t.api("/api/harnesses?hydrate=1");

    // mtime bump → digest mismatch → cold again, with the stale as-of time.
    const metaPath = join(dir, ".crewhaus", "sessions", "sess_00000000000000bb.json");
    utimesSync(metaPath, new Date(NOW + DAY), new Date(NOW + DAY));
    const stale = (
      (await t.api("/api/harnesses")).body["harnesses"] as Array<Record<string, unknown>>
    )[0] as Record<string, unknown>;
    expect(stale["rollup"]).toBeNull();
    expect(stale["rollupStaleCachedAt"]).toBe(iso(NOW));

    clock.t = NOW + 2 * DAY;
    const rehydrated = (
      (await t.api("/api/harnesses?hydrate=1")).body["harnesses"] as Array<Record<string, unknown>>
    )[0] as Record<string, unknown>;
    expect((rehydrated["rollup"] as Record<string, unknown>)["cachedAt"]).toBe(iso(NOW + 2 * DAY));

    // Deleting the whole cache dir is always safe.
    rmSync(join(t.hangarRoot, "cache"), { recursive: true, force: true });
    const afterDelete = (
      (await t.api("/api/harnesses")).body["harnesses"] as Array<Record<string, unknown>>
    )[0] as Record<string, unknown>;
    expect(afterDelete["rollup"]).toBeNull();
    expect((await t.api(`/api/h/${id}`)).status).toBe(200);
    expect(
      (
        (await t.api("/api/harnesses?hydrate=1")).body["harnesses"] as Array<
          Record<string, unknown>
        >
      ).length,
    ).toBe(1);
  });

  test("a vanished dir renders missingSince and keeps its row; sub-resources 404", async () => {
    const t = boot({ now: () => NOW });
    const dir = makeFixtureHarness(join(t.harnessesRoot, "vanishing"), { specName: "vanish" });
    const id = await register(t, dir);
    rmSync(dir, { recursive: true, force: true });

    const rows = (await t.api("/api/harnesses")).body["harnesses"] as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(1);
    expect((rows[0] as Record<string, unknown>)["missingSince"]).toBe(iso(NOW));

    const detail = await t.api(`/api/h/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body["missing"]).toBe(true);
    expect((await t.api(`/api/h/${id}/spec`)).status).toBe(404);
    expect((await t.api(`/api/h/${id}/sessions`)).status).toBe(404);
  });
});

describe("cost routes", () => {
  test("golden per-harness and fleet cost folds (summary lines skipped, 7d windowed)", async () => {
    const t = boot({ now: () => NOW });
    const dir = goldenHarness(t);
    const id = await register(t, dir);

    const one = await t.api(`/api/h/${id}/costs`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({
      id,
      costs: {
        totalUsdMicros: 2500,
        calls: 3,
        spend7dUsdMicros: 2000,
        byModel: [
          {
            provider: "anthropic",
            modelId: "m-alpha",
            calls: 2,
            usdMicros: 2000,
            inputTokens: 10,
            outputTokens: 5,
          },
          {
            provider: "openai",
            modelId: "m-beta",
            calls: 1,
            usdMicros: 500,
            inputTokens: 0,
            outputTokens: 0,
          },
        ],
        days: goldenDays(),
        truncatedFiles: 0,
      },
    });

    const fleet = await t.api("/api/costs");
    expect(fleet.status).toBe(200);
    expect(fleet.body["fleet"]).toEqual({
      totalUsdMicros: 2500,
      spend7dUsdMicros: 2000,
      calls: 3,
    });
    expect((fleet.body["harnesses"] as unknown[]).length).toBe(1);
  });
});
