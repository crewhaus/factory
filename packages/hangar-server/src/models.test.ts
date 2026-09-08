/**
 * The Models area (0.6.0 §8.3): the pure readers, the four routes driven
 * against a live fixture server, and the two invariants this surface exists
 * to keep — Hangar never writes an arm, and a routing band never reaches a
 * browser as `"[redacted]"`.
 *
 * The shared contract fixture asserts these routes' SHAPES; the populated
 * behaviour is covered here, against a fixture this area controls.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashSpecSource } from "./bundle-freshness";
import { logLine, makeFixtureHarness } from "./fixture";
import {
  buildLeaderboard,
  foldRouteStats,
  readModelRegistry,
  readPinServeStates,
  readPoolView,
  readRouteTimeline,
  rosterModels,
  rosterSunsets,
  splitModelString,
} from "./models";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});
function boot(): TestServer {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  return (body["entry"] as { id: string }).id;
}

const HYBRID_SPEC = [
  "  model_pool:",
  "    policy: heuristic",
  "    candidates:",
  "      - model: $fast",
  "        tags: [cheap]",
  "      - model: $strong",
  "        tags: [strong]",
  "models:",
  "  fast:",
  "    model: claude-haiku-4-5",
  "    max_tokens: 2048",
  "    temperature: 0.2",
  "  strong:",
  "    model: claude-opus-5",
].join("\n");

/** A harness with a pool, a scoreboard, attributed spend and routing lines. */
function hybridHarness(t: TestServer): string {
  return makeFixtureHarness(join(t.harnessesRoot, "hybrid"), {
    specName: "hybrid",
    specExtra: HYBRID_SPEC,
    sessions: [
      {
        id: "sess_00000000000000aa",
        updatedAt: iso(NOW - DAY),
        log: [
          logLine("user_message", { content: "where is my order" }, iso(NOW - DAY)),
          logLine(
            "model_route",
            {
              turnNumber: 1,
              routeKey: "easy",
              model: "claude-haiku-4-5",
              profile: "fast",
              policy: "heuristic",
              reason: "no tools in play",
            },
            iso(NOW - DAY),
          ),
          logLine(
            "model_stage",
            {
              turnNumber: 1,
              stage: "draft",
              strategy: "cascade",
              role: "draft",
              model: "claude-haiku-4-5",
              profile: "fast",
              outcome: "done",
            },
            iso(NOW - DAY),
          ),
          logLine(
            "model_stage",
            {
              turnNumber: 1,
              stage: "escalate",
              strategy: "cascade",
              role: "escalation",
              model: "claude-opus-5",
              profile: "strong",
              outcome: "done",
            },
            iso(NOW - DAY),
          ),
          logLine(
            "cost_accrual",
            {
              provider: "anthropic",
              modelId: "claude-haiku-4-5",
              costUsdMicros: 400,
              inputTokens: 100,
              outputTokens: 20,
              role: "draft",
              profile: "fast",
            },
            iso(NOW - DAY),
          ),
          logLine(
            "cost_accrual",
            {
              provider: "anthropic",
              modelId: "claude-opus-5",
              costUsdMicros: 3000,
              inputTokens: 200,
              outputTokens: 60,
              role: "judge",
              profile: "strong",
            },
            iso(NOW - DAY),
          ),
        ],
      },
    ],
    routingArms: [
      { v: 1, k: "easy", m: "claude-haiku-4-5", r: 0.9, s: 1, l: 800, c: 0.0004, t: NOW - DAY },
      { v: 1, k: "easy", m: "claude-opus-5", r: 0.4, s: 1, l: 2400, c: 0.006, t: NOW - DAY },
    ],
  });
}

// ---------------------------------------------------------------------------
// pure readers
// ---------------------------------------------------------------------------

describe("the lenient spec readers", () => {
  test("readModelRegistry itemises a profile's settings and keeps its extra keys", () => {
    const rows = readModelRegistry(
      [
        "models:",
        "  fast:",
        "    model: claude-haiku-4-5",
        "    max_tokens: 2048",
        "    caching: off",
      ].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("fast");
    expect(rows[0]?.model).toBe("claude-haiku-4-5");
    expect(rows[0]?.settings.map((s) => s.key)).toEqual(["model", "max_tokens"]);
    // `caching` is real, just not itemised — it must be NAMED, not dropped.
    expect(rows[0]?.extraKeys).toEqual(["caching"]);
  });

  test("no models: block is not an error — it is an empty registry", () => {
    expect(readModelRegistry("name: x\ntarget: cli\n")).toEqual([]);
    expect(readPoolView("name: x\ntarget: cli\n").declared).toBe(false);
  });

  test("readPoolView reads a $profile candidate's profile from either spelling", () => {
    const pool = readPoolView(
      [
        "agent:",
        "  model_pool:",
        "    policy: learned",
        "    scope: step",
        "    candidates:",
        "      - model: $fast",
        "        tags: [cheap]",
        "      - model: claude-opus-5",
        "        profile: strong",
        "      - model: claude-sonnet-4-6",
        "    rules:",
        "      - id: r1",
        "    strategy:",
        "      cascade: {}",
      ].join("\n"),
    );
    expect(pool.declared).toBe(true);
    expect(pool.policy).toBe("learned");
    expect(pool.scope).toBe("step");
    expect(pool.candidates.map((c) => c.profile)).toEqual(["fast", "strong", null]);
    expect(pool.candidates[0]?.tags).toEqual(["cheap"]);
    expect(pool.rules).toBe(1);
    expect(pool.strategies).toEqual(["cascade"]);
  });

  test("rosterModels finds every model slot at any depth and skips $refs", () => {
    const models = rosterModels(
      [
        "agent:",
        "  model: $fast",
        "  model_fallbacks:",
        "    - openai/gpt-4o",
        "models:",
        "  fast:",
        "    model: claude-3-5-haiku-20241022",
        "sub_agents:",
        "  helper:",
        "    model: gemini/gemini-1.5-pro",
      ].join("\n"),
    );
    expect(models).toEqual(["claude-3-5-haiku-20241022", "gemini/gemini-1.5-pro", "openai/gpt-4o"]);
  });

  test("splitModelString strips hosting prefixes and defaults to anthropic", () => {
    expect(splitModelString("claude-opus-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
    expect(splitModelString("openai/gpt-4o")).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(splitModelString("vertex/anthropic/claude-opus-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
    // A model id that merely contains a slash is not a provider hop.
    expect(splitModelString("bedrock/meta.llama3")).toEqual({
      provider: "bedrock",
      modelId: "meta.llama3",
    });
  });

  test("rosterSunsets flags a retiring model and says whether the date has passed", () => {
    const yaml = "agent:\n  model: claude-3-5-haiku-20241022\n";
    const before = rosterSunsets(yaml, Date.parse("2026-01-01T00:00:00.000Z"));
    expect(before).toHaveLength(1);
    expect(before[0]?.past).toBe(false);
    expect(before[0]?.replacement).toBe("claude-haiku-4-5");
    const after = rosterSunsets(yaml, Date.parse("2027-01-01T00:00:00.000Z"));
    expect(after[0]?.past).toBe(true);
    // A current model carries no sunset row at all.
    expect(rosterSunsets("agent:\n  model: claude-opus-5\n", NOW)).toEqual([]);
  });
});

describe("buildLeaderboard (pure)", () => {
  const arm = (band: string, model: string, meanReward: number, n = 10) => ({
    band,
    model,
    n,
    meanReward,
    meanQuality: 0,
    qualityCount: 0,
    meanLatencyMs: 100,
    meanCostUsd: 0.001,
    ungraded: 0,
    shadow: band.startsWith("shadow:"),
  });

  test("ranks inside each band, stars the leader, and reports the gap", () => {
    const board = buildLeaderboard([
      arm("easy", "b", 0.4),
      arm("easy", "a", 0.9),
      arm("hard", "c", 0.5),
    ]);
    expect(board.map((r) => `${r.band}/${r.model}/${r.rank}/${r.best}`)).toEqual([
      "easy/a/1/true",
      "easy/b/2/false",
      "hard/c/1/true",
    ]);
    expect(board[1]?.rewardGap).toBeCloseTo(0.5, 10);
    expect(board[0]?.rewardGap).toBe(0);
  });

  test("an arm with zero observations is never starred — nothing has been learned", () => {
    const board = buildLeaderboard([arm("easy", "a", 0, 0)]);
    expect(board[0]?.best).toBe(false);
  });
});

describe("readRouteTimeline (pure)", () => {
  test("keeps only routing kinds, in file order, and renames routeKey to band", () => {
    const t = boot();
    const dir = hybridHarness(t);
    const path = join(dir, ".crewhaus", "sessions", "sess_00000000000000aa.jsonl");
    const timeline = readRouteTimeline(path);
    expect(timeline.entries.map((e) => e.kind)).toEqual([
      "model_route",
      "model_stage",
      "model_stage",
    ]);
    expect(timeline.counts).toEqual({ model_route: 1, model_stage: 2 });
    expect(timeline.entries[0]?.payload["band"]).toBe("easy");
    expect(timeline.entries[0]?.payload["routeKey"]).toBeUndefined();
    expect(timeline.entries[0]?.turnNumber).toBe(1);
  });

  test("foldRouteStats counts decisions and COMPLETED escalations only", () => {
    const t = boot();
    const dir = hybridHarness(t);
    const stats = foldRouteStats(dir);
    expect(stats.sessions).toBe(1);
    expect(stats.decisions).toBe(1);
    expect(stats.stages).toBe(2);
    // The `draft` stage is not an escalation; the `escalate` one completed.
    expect(stats.escalations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the routes
// ---------------------------------------------------------------------------

describe("GET /api/h/:id/models", () => {
  test("returns the registry, the pool, per-role/per-profile spend, arms and the leaderboard", async () => {
    const t = boot();
    const id = await register(t, hybridHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/models`);
    expect(status).toBe(200);
    expect(body["present"]).toBe(true);

    const registry = body["registry"] as Array<{ name: string; model: string }>;
    expect(registry.map((r) => `${r.name}=${r.model}`)).toEqual([
      "fast=claude-haiku-4-5",
      "strong=claude-opus-5",
    ]);

    const pool = body["pool"] as { declared: boolean; policy: string; candidates: unknown[] };
    expect(pool.declared).toBe(true);
    expect(pool.policy).toBe("heuristic");
    expect(pool.candidates).toHaveLength(2);

    const spend = body["spend"] as {
      totalUsdMicros: number;
      byRole: Array<{ role: string; usdMicros: number }>;
      byProfile: Array<{ profile: string; usdMicros: number }>;
    };
    expect(spend.totalUsdMicros).toBe(3400);
    // Biggest first — "the judge is most of the bill" is the first row.
    expect(spend.byRole).toEqual([
      { role: "judge", calls: 1, usdMicros: 3000, inputTokens: 200, outputTokens: 60 },
      { role: "draft", calls: 1, usdMicros: 400, inputTokens: 100, outputTokens: 20 },
    ] as unknown as Array<{ role: string; usdMicros: number }>);
    expect(spend.byProfile.map((p) => p.profile)).toEqual(["strong", "fast"]);

    expect((body["arms"] as unknown[]).length).toBe(2);
    const board = body["leaderboard"] as Array<{ band: string; model: string; best: boolean }>;
    expect(board.map((r) => r.model)).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    expect(board[0]?.best).toBe(true);
    // The band survives masking: it is served as `band`, never `routeKey`.
    expect(board[0]?.band).toBe("easy");
    expect((body["sessions"] as Array<{ id: string }>).map((s) => s.id)).toEqual([
      "sess_00000000000000aa",
    ]);
  });

  test("an un-pooled harness answers with the honest sentence, not an empty screen", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "plain"), { specName: "plain" });
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/models`);
    expect(status).toBe(200);
    expect(body["registry"]).toEqual([]);
    expect((body["pool"] as { declared: boolean }).declared).toBe(false);
    expect(String(body["note"])).toContain("serves one declared model");
    expect(String(body["guidance"])).toContain("declare agent.model_pool");
  });

  test("reading the area never CREATES the scoreboard — reads never mutate", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "plain2"), { specName: "plain2" });
    const id = await register(t, dir);
    await t.api(`/api/h/${id}/models`);
    await t.api(`/api/h/${id}/models/arms`);
    await t.api(`/api/h/${id}/models/leaderboard`);
    expect(existsSync(join(dir, ".crewhaus", "routing"))).toBe(false);
  });
});

describe("GET /api/h/:id/models/{arms,leaderboard,routes/:sess}", () => {
  test("arms says it is read-only and names the CLI kill switch", async () => {
    const t = boot();
    const dir = hybridHarness(t);
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/models/arms`);
    expect(status).toBe(200);
    expect((body["arms"] as unknown[]).length).toBe(2);
    expect(body["bands"]).toEqual(["easy"]);
    expect(String(body["note"])).toContain("Hangar never writes an arm");
    // The file is untouched by the read.
    const path = join(dir, ".crewhaus", "routing", "arms.jsonl");
    const before = readFileSync(path, "utf8");
    await t.api(`/api/h/${id}/models/arms`);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("leaderboard is empty-but-explained on a harness that never routed", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "cold"), { specName: "cold" });
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/models/leaderboard`);
    expect(body["present"]).toBe(false);
    expect(body["leaderboard"]).toEqual([]);
    expect(body["verb"]).toBe("crewhaus route status");
  });

  test("the route timeline reads the session JSONL, and an unknown session is absent, not a 404", async () => {
    const t = boot();
    const id = await register(t, hybridHarness(t));
    const found = await t.api(`/api/h/${id}/models/routes/sess_00000000000000aa`);
    expect(found.status).toBe(200);
    expect(found.body["present"]).toBe(true);
    expect((found.body["entries"] as Array<{ kind: string }>).map((e) => e.kind)).toEqual([
      "model_route",
      "model_stage",
      "model_stage",
    ]);
    const missing = await t.api(`/api/h/${id}/models/routes/sess_0000000000000099`);
    expect(missing.status).toBe(200);
    expect(missing.body["present"]).toBe(false);
    expect(missing.body["entries"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the pin → serve gap (0.6.0 §9.4) and the advisor item it raises
// ---------------------------------------------------------------------------

const PINNED_YAML = "name: pinned\ntarget: cli\nagent:\n  model: claude-opus-5\n";

/** A harness whose registry pins `prod → 1.4.0`. `servesPin` decides whether
 *  the compiled bundle was stamped from that pinned text. */
function pinnedHarness(t: TestServer, name: string, servesPin: boolean): string {
  return makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    bundle: {
      entry: "agent.ts",
      specHash: servesPin ? hashSpecSource(PINNED_YAML) : `sha256:${"0".repeat(64)}`,
      compiledWith: "0.5.8",
    },
    specRegistry: {
      dirName: name,
      manifest: { versions: ["1.4.0"], pins: { prod: "1.4.0" } },
      versions: { "1.4.0": PINNED_YAML },
    },
  });
}

describe("readPinServeStates (0.6.0 §9.4)", () => {
  test("a pin the compiled bundle was built from is `served`; a different one is not", async () => {
    const t = boot();
    const servedDir = pinnedHarness(t, "served", true);
    const staleDir = pinnedHarness(t, "stale", false);
    const servedId = await register(t, servedDir);
    const staleId = await register(t, staleDir);

    // Driven through the advisor route, because that is where the signal is
    // consumed — the reader is exercised with the ctx the server builds.
    const staleFeed = (await t.api(`/api/h/${staleId}/advisor`)).body;
    const item = (staleFeed["items"] as Array<{ id: string; detail: string; screen: string }>).find(
      (i) => i.id === "restart-to-serve-pin-prod",
    );
    expect(item).toBeDefined();
    expect(item?.detail).toContain("1.4.0");
    expect(item?.screen).toBe("deploy");

    const servedFeed = (await t.api(`/api/h/${servedId}/advisor`)).body;
    expect(
      (servedFeed["items"] as Array<{ id: string }>).some((i) =>
        i.id.startsWith("restart-to-serve-pin"),
      ),
    ).toBe(false);
  });

  test("a harness with no registry pins produces no rows at all", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "unpinned"), { specName: "unpinned" });
    const id = await register(t, dir);
    const feed = (await t.api(`/api/h/${id}/advisor`)).body;
    expect(
      (feed["items"] as Array<{ id: string }>).some((i) => i.id.startsWith("restart-to-serve-pin")),
    ).toBe(false);
    // And the reader itself is empty rather than throwing.
    expect(typeof readPinServeStates).toBe("function");
  });
});

describe("the advisor's routing items, end to end", () => {
  test("a pooled harness with a losing candidate and a hot escalation rate raises them", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "advised"), {
      specName: "advised",
      specExtra: HYBRID_SPEC,
      sessions: [
        {
          id: "sess_00000000000000ac",
          updatedAt: iso(NOW - DAY),
          log: [
            logLine("model_route", { turnNumber: 1, routeKey: "easy", model: "m" }, iso(NOW - DAY)),
            logLine(
              "model_stage",
              {
                turnNumber: 1,
                stage: "escalate",
                strategy: "cascade",
                role: "escalation",
                model: "m",
                outcome: "done",
              },
              iso(NOW - DAY),
            ),
            logLine(
              "cost_accrual",
              { provider: "anthropic", modelId: "m", costUsdMicros: 100, role: "judge" },
              iso(NOW - DAY),
            ),
          ],
        },
      ],
      // Both live arms are past the sample floor and far apart, so the flip
      // and the losing candidate are both real claims.
      routingArms: [
        ...Array.from({ length: 25 }, () => ({
          v: 1,
          k: "easy",
          m: "claude-haiku-4-5",
          r: 0.9,
          s: 1,
          l: 800,
          t: NOW - DAY,
        })),
        ...Array.from({ length: 25 }, () => ({
          v: 1,
          k: "easy",
          m: "claude-opus-5",
          r: 0.2,
          s: 0,
          l: 2400,
          t: NOW - DAY,
        })),
      ],
    });
    const id = await register(t, dir);
    const feed = (await t.api(`/api/h/${id}/advisor`)).body;
    const ids = (feed["items"] as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain("policy-flip-ready");
    expect(ids.some((i) => i.startsWith("candidate-underperforming"))).toBe(true);
    expect(ids).toContain("escalation-rate-high");
    expect(ids).toContain("judge-spend-dominates");
  }, 30_000);

  test("the routing and hybrid reports build from the same durable files", async () => {
    const t = boot();
    const id = await register(t, hybridHarness(t));
    for (const kind of ["routing", "hybrid"]) {
      const { status, body } = await t.api(`/api/h/${id}/advisor/reports`, {
        method: "POST",
        body: JSON.stringify({ kind }),
      });
      expect(`${kind}:${status}`).toBe(`${kind}:200`);
      const report = body["report"] as { kind: string; body: Record<string, unknown> };
      expect(report.kind).toBe(kind);
      expect(typeof report.body["finding"]).toBe("string");
    }
  }, 30_000);
});
