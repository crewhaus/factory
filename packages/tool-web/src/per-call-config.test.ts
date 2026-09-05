/**
 * 0.6.0 §4.4 — per-candidate `tool_config`: a serving candidate's
 * `tool_config.webFetch` block arrives on `ToolExecuteContext.toolConfig` and
 * REPLACES the registered domain allow-list for that one call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetWebFetchConfig,
  getWebFetchConfig,
  registerWebFetchConfig,
  resolveWebFetchConfig,
} from "./index";

afterEach(() => _resetWebFetchConfig());

describe("resolveWebFetchConfig (per-call tool_config override)", () => {
  test("no override → the registered config, by reference", () => {
    registerWebFetchConfig({ allowed_domains: ["Example.com"] });
    expect(resolveWebFetchConfig(undefined)).toBe(getWebFetchConfig());
    expect(resolveWebFetchConfig(undefined).allowedDomains).toEqual(["example.com"]);
  });

  test("an object override REPLACES the registered allow-list for the call, lower-cased, both spellings", () => {
    registerWebFetchConfig({ allowed_domains: ["example.com"] });
    expect(resolveWebFetchConfig({ allowed_domains: ["Docs.Example.org"] }).allowedDomains).toEqual(
      ["docs.example.org"],
    );
    expect(resolveWebFetchConfig({ allowedDomains: ["api.example.net"] }).allowedDomains).toEqual([
      "api.example.net",
    ]);
    expect(getWebFetchConfig().allowedDomains).toEqual(["example.com"]);
  });

  test("a non-object override is ignored", () => {
    registerWebFetchConfig({ allowed_domains: ["example.com"] });
    for (const bad of [null, "example.org", 1, ["example.org"]]) {
      expect(resolveWebFetchConfig(bad)).toBe(getWebFetchConfig());
    }
  });
});
