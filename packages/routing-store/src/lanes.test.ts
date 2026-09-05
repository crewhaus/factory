/**
 * 0.6.0 §7.8 — the observe-only lanes: the router never mints a `q:` or
 * `shadow:` routeKey, so recording into them cannot steer a live decision.
 */
import { describe, expect, test } from "bun:test";
import {
  QUALITY_LANE_PREFIX,
  SHADOW_LANE_PREFIX,
  isObserveOnlyLane,
  shadowLaneQuality,
  shadowRouteKey,
} from "./index.js";

describe("shadowRouteKey", () => {
  test("scoped: shadow:<scope>/<band>; unscoped: shadow:<band>", () => {
    expect(shadowRouteKey("hard", "draft")).toBe("shadow:draft/hard");
    expect(shadowRouteKey("easy")).toBe("shadow:easy");
    expect(shadowRouteKey("easy", "")).toBe("shadow:easy");
  });

  test("the lane prefixes are disjoint from the router's band vocabulary", () => {
    for (const band of ["hard", "easy"]) {
      expect(isObserveOnlyLane(band)).toBe(false);
      expect(isObserveOnlyLane(shadowRouteKey(band, "s"))).toBe(true);
      expect(isObserveOnlyLane(`${QUALITY_LANE_PREFIX}${band}`)).toBe(true);
    }
    expect(SHADOW_LANE_PREFIX).toBe("shadow:");
    expect(QUALITY_LANE_PREFIX).toBe("q:");
  });
});

describe("shadowLaneQuality", () => {
  test("a win is 1/0, a tie is 0.5/0.5 — never a win for either side", () => {
    expect(shadowLaneQuality("shadow")).toEqual({ shadow: 1, primary: 0 });
    expect(shadowLaneQuality("primary")).toEqual({ shadow: 0, primary: 1 });
    expect(shadowLaneQuality("tie")).toEqual({ shadow: 0.5, primary: 0.5 });
  });
});
