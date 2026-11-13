/**
 * The Models tab's PURE decisions (0.6.0 §8.3): payload → per-role and
 * per-profile spend rows with their shares, and one durable routing line →
 * the sentence the timeline renders. The render function is a thin DOM
 * builder over these (the M2 testing shape).
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { LEGACY_HARNESS_TABS, LEGACY_REST_TABS, parseRoute } from "../assets/js/router.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { ROUTES } from "../assets/js/routes.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  declaredPools,
  profileSpendRows,
  roleSpendRows,
  spendShare,
  timelineLine,
} from "../assets/js/views/models.js";

describe("declaredPools", () => {
  test("every declared pool renders, whatever host declares it", () => {
    const rows = declaredPools({
      pool: { declared: true, policy: "heuristic" },
      pools: [
        { hostPath: "agent.model_pool", pool: { declared: true, policy: "heuristic" } },
        { hostPath: "crew.roles.writer.model_pool", pool: { declared: true, policy: "learned" } },
      ],
    }) as Array<{ hostPath: string }>;
    expect(rows.map((r) => r.hostPath)).toEqual([
      "agent.model_pool",
      "crew.roles.writer.model_pool",
    ]);
  });

  test("no pool anywhere is the only empty answer; an older payload still renders one", () => {
    expect(declaredPools({ pool: { declared: false } })).toEqual([]);
    expect(declaredPools(null)).toEqual([]);
    const legacy = declaredPools({
      pool: { declared: true, policy: "learned" },
    }) as Array<{ hostPath: string }>;
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.hostPath).toBe("model_pool");
  });
});

describe("the models screen is routable", () => {
  // Changed deliberately: the Models tab is Setup › Models now; its old
  // address redirects, and its trailing segments still reach the view.
  test("its old address lands in Setup, and a route timeline's address keeps its session", () => {
    expect(LEGACY_HARNESS_TABS as string[]).toContain("models");
    expect(LEGACY_REST_TABS as string[]).toContain("models");
    expect(parseRoute("#/h/hrn_0123456789abcdef/models")).toEqual({
      view: "harness",
      id: "hrn_0123456789abcdef",
      section: "setup",
      sub: "models",
      rest: [],
      query: {},
    });
    for (const hash of [
      "#/h/hrn_0123456789abcdef/models/routes/sess_0123456789abcdef",
      "#/h/hrn_0123456789abcdef/setup/models/routes/sess_0123456789abcdef",
    ]) {
      expect(parseRoute(hash).rest).toEqual(["routes", "sess_0123456789abcdef"]);
    }
  });

  test("all four routes are in the map, GET-only, in the models group", () => {
    const routes = ROUTES as Record<string, { method: string; group?: string }>;
    for (const key of ["models", "modelRoutes", "modelArms", "modelLeaderboard"]) {
      expect(`${key}:${routes[key]?.method}`).toBe(`${key}:GET`);
      expect(`${key}:${routes[key]?.group}`).toBe(`${key}:models`);
    }
    // The whole area is read-only: no write carries the models group.
    const writes = Object.values(routes).filter((r) => r.group === "models" && r.method !== "GET");
    expect(writes).toEqual([]);
  });
});

describe("spendShare", () => {
  test("a zero total is 0, never NaN — an empty tab must still paint", () => {
    expect(spendShare(0, 0)).toBe(0);
    expect(spendShare(100, 0)).toBe(0);
    expect(spendShare(undefined, 100)).toBe(0);
    expect(spendShare(25, 100)).toBeCloseTo(0.25, 10);
  });
});

describe("roleSpendRows / profileSpendRows", () => {
  const payload = {
    spend: {
      totalUsdMicros: 1000,
      byRole: [
        { role: "judge", calls: 2, usdMicros: 750 },
        { role: "draft", calls: 4, usdMicros: 250 },
      ],
      byProfile: [
        { profile: "strong", calls: 2, usdMicros: 750 },
        { profile: "(none)", calls: 4, usdMicros: 250 },
      ],
    },
  };

  test("shares are derived from the SAME total the figures come from", () => {
    const roles = roleSpendRows(payload) as Array<{ role: string; share: number }>;
    expect(roles.map((r) => r.role)).toEqual(["judge", "draft"]);
    expect(roles[0]?.share).toBeCloseTo(0.75, 10);
    const profiles = profileSpendRows(payload) as Array<{ profile: string; share: number }>;
    expect(profiles.map((p) => p.profile)).toEqual(["strong", "(none)"]);
    expect(profiles[1]?.share).toBeCloseTo(0.25, 10);
  });

  test("a missing spend block is an empty table, not a crash", () => {
    expect(roleSpendRows({})).toEqual([]);
    expect(profileSpendRows(null)).toEqual([]);
    expect(profileSpendRows({ spend: { byProfile: "nope" } })).toEqual([]);
  });
});

describe("timelineLine", () => {
  test("a route line reads as a sentence, off `band` (never `routeKey`)", () => {
    const line = timelineLine({
      kind: "model_route",
      turnNumber: 3,
      payload: {
        model: "claude-haiku-4-5",
        profile: "fast",
        band: "easy",
        policy: "learned",
        explored: true,
        ruleId: "cheap-lane",
      },
    }) as { kind: string; turn: number; detail: string };
    expect(line.turn).toBe(3);
    expect(line.detail).toBe(
      "claude-haiku-4-5 · profile=fast · band=easy · policy=learned (exploring) · rule=cheap-lane",
    );
  });

  test("a stage line names the stage, its outcome and the strategy that owns it", () => {
    const line = timelineLine({
      kind: "model_stage",
      payload: {
        stage: "escalate",
        outcome: "done",
        strategy: "cascade",
        model: "claude-opus-5",
        profile: "strong",
      },
    }) as { detail: string; turn: number | null };
    expect(line.detail).toBe("escalate · done · strategy=cascade · claude-opus-5 · profile=strong");
    expect(line.turn).toBeNull();
  });

  test("directives, failovers and judge verdicts each read as their own fact", () => {
    expect(
      (
        timelineLine({
          kind: "model_directive",
          payload: { requested: "fast", resolved: null, accepted: false, reason: "unknown arm" },
        }) as { detail: string }
      ).detail,
    ).toBe("fast → (refused) · refused · unknown arm");
    expect(
      (
        timelineLine({
          kind: "model_failover",
          payload: { from: "a", to: "b", reason: "breaker_open" },
        }) as { detail: string }
      ).detail,
    ).toBe("a → b · breaker_open");
    expect(
      (
        timelineLine({
          kind: "judge_verdict",
          payload: { verdict: "fail", score: 0.2, judgeModel: "claude-opus-5" },
        }) as { detail: string }
      ).detail,
    ).toBe("fail · score=0.2 · judge=claude-opus-5");
  });

  test("an unknown routing kind still renders its kind — a manager behind its harness drops nothing", () => {
    const line = timelineLine({ kind: "model_something_new", payload: { x: 1 } }) as {
      kind: string;
      detail: string;
    };
    expect(line.kind).toBe("model_something_new");
    expect(line.detail).toBe("");
    // …and a junk entry does not throw.
    expect((timelineLine(undefined) as { kind: string }).kind).toBe("");
  });
});
