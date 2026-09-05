/**
 * 0.6.0 §4.4 — per-candidate `tool_config`: a serving candidate's
 * `tool_config.fetch` block arrives on `ToolExecuteContext.toolConfig` and
 * REPLACES the registered allow-list for that one call; a call without it
 * reads the process-global registration exactly as before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetFetchConfig,
  getFetchConfig,
  registerFetchConfig,
  resolveFetchConfig,
} from "./index";

afterEach(() => _resetFetchConfig());

describe("resolveFetchConfig (per-call tool_config override)", () => {
  test("no override → the registered config, by reference", () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    expect(resolveFetchConfig(undefined)).toBe(getFetchConfig());
    expect([...resolveFetchConfig(undefined).allowedOrigins]).toEqual(["https://api.example.com"]);
  });

  test("an object override REPLACES the registered allow-list for the call (both key spellings)", () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    const snake = resolveFetchConfig({ allowed_origins: ["https://other.example.org"] });
    expect([...snake.allowedOrigins]).toEqual(["https://other.example.org"]);
    const camel = resolveFetchConfig({ allowedOrigins: ["https://camel.example.org:8443"] });
    expect([...camel.allowedOrigins]).toEqual(["https://camel.example.org:8443"]);
    // The registration itself is untouched — the override is per call.
    expect([...getFetchConfig().allowedOrigins]).toEqual(["https://api.example.com"]);
  });

  test("an override with no origins is a fail-closed EMPTY allow-list, never a widening", () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    expect(resolveFetchConfig({}).allowedOrigins.size).toBe(0);
  });

  test("a non-object override is ignored (the registered config applies)", () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    for (const bad of [null, "https://x.example", 42, ["https://x.example"]]) {
      expect(resolveFetchConfig(bad)).toBe(getFetchConfig());
    }
  });
});
