/**
 * Loop contract 0.4 (Batch C, G26) — the pure `run --trace` + cost-on-by-
 * default env resolution. Precedence: the flag wins absolutely; absent a flag
 * the spec sets a default with env-wins (`??=`) semantics.
 */
import { describe, expect, test } from "bun:test";
import {
  TRACE_LEVELS,
  isValidTraceLevel,
  resolveCostEnv,
  resolveTraceEnv,
  resolveWatchmeEnv,
} from "./run-observability";

describe("isValidTraceLevel", () => {
  test("accepts the four levels, rejects others", () => {
    for (const level of TRACE_LEVELS) expect(isValidTraceLevel(level)).toBe(true);
    expect(isValidTraceLevel("verbose")).toBe(false);
    expect(isValidTraceLevel("")).toBe(false);
    expect(isValidTraceLevel("PRETTY")).toBe(false);
  });
});

describe("resolveTraceEnv — flag wins absolutely", () => {
  test("pretty/json flag stamps the level even over ambient env", () => {
    expect(resolveTraceEnv("pretty", undefined, undefined)).toBe("pretty");
    expect(resolveTraceEnv("json", "ring", "pretty")).toBe("json");
  });

  test("off/ring flag stamps a non-printer value (overriding ambient pretty)", () => {
    // Stamping "off"/"ring" makes attachIfEnvSet attach no printer, so a flag
    // of off/ring suppresses an ambient CREWHAUS_TRACE=pretty.
    expect(resolveTraceEnv("off", "json", "pretty")).toBe("off");
    expect(resolveTraceEnv("ring", "pretty", "pretty")).toBe("ring");
  });
});

describe("resolveTraceEnv — no flag, spec default with env-wins", () => {
  test("spec pretty/json sets the env only when unset", () => {
    expect(resolveTraceEnv(undefined, "pretty", undefined)).toBe("pretty");
    expect(resolveTraceEnv(undefined, "json", undefined)).toBe("json");
  });

  test("ambient env wins over the spec default", () => {
    expect(resolveTraceEnv(undefined, "json", "pretty")).toBeUndefined();
    expect(resolveTraceEnv(undefined, "pretty", "off")).toBeUndefined();
  });

  test("spec ring/off or absent block leaves the env untouched", () => {
    expect(resolveTraceEnv(undefined, "ring", undefined)).toBeUndefined();
    expect(resolveTraceEnv(undefined, "off", undefined)).toBeUndefined();
    expect(resolveTraceEnv(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("resolveCostEnv — cost on by default", () => {
  test("absent/true cost with unset env → '1'", () => {
    expect(resolveCostEnv(undefined, undefined)).toBe("1");
    expect(resolveCostEnv(true, undefined)).toBe("1");
  });

  test("spec cost.enabled: false → leave env untouched (off)", () => {
    expect(resolveCostEnv(false, undefined)).toBeUndefined();
  });

  test("ambient env wins (already set)", () => {
    expect(resolveCostEnv(undefined, "1")).toBeUndefined();
    expect(resolveCostEnv(true, "0")).toBeUndefined();
  });
});

describe('resolveWatchmeEnv — "watch me" capture off by default, opt-in with env-wins', () => {
  test("spec enabled+full capture → '1' when the env is unset", () => {
    expect(resolveWatchmeEnv(true, false, undefined)).toBe("1");
  });

  test("state watching turns capture on without a spec block", () => {
    expect(resolveWatchmeEnv(undefined, true, undefined)).toBe("1");
    expect(resolveWatchmeEnv(false, true, undefined)).toBe("1");
  });

  test("neither spec nor state → leave the env untouched (off by default)", () => {
    expect(resolveWatchmeEnv(undefined, false, undefined)).toBeUndefined();
    expect(resolveWatchmeEnv(false, false, undefined)).toBeUndefined();
  });

  test("ambient env wins over both spec and state (even an explicit off)", () => {
    expect(resolveWatchmeEnv(true, true, "1")).toBeUndefined();
    expect(resolveWatchmeEnv(true, true, "0")).toBeUndefined();
  });
});
