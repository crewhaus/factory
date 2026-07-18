import { describe, expect, test } from "bun:test";
import { parsePluginsFlag, resolvePluginNames } from "./plugin-activation";

describe("parsePluginsFlag", () => {
  test("splits a comma list, trimming and dropping empties", () => {
    expect(parsePluginsFlag("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parsePluginsFlag("a, b , c")).toEqual(["a", "b", "c"]);
    expect(parsePluginsFlag("a, ,b,")).toEqual(["a", "b"]);
  });
  test("an empty / whitespace flag yields no names (activate none)", () => {
    expect(parsePluginsFlag("")).toEqual([]);
    expect(parsePluginsFlag("  ")).toEqual([]);
    expect(parsePluginsFlag(",,")).toEqual([]);
  });
  test("preserves order (activation de-dupes downstream)", () => {
    expect(parsePluginsFlag("b,a,b")).toEqual(["b", "a", "b"]);
  });
});

describe("resolvePluginNames", () => {
  test("a present flag OVERRIDES the spec list", () => {
    expect(resolvePluginNames(["spec-one"], "flag-a,flag-b")).toEqual(["flag-a", "flag-b"]);
  });
  test("a present-but-empty flag is an explicit 'activate none' override", () => {
    expect(resolvePluginNames(["spec-one"], "")).toEqual([]);
    expect(resolvePluginNames(["spec-one"], "  ")).toEqual([]);
  });
  test("an absent flag falls back to the spec list", () => {
    expect(resolvePluginNames(["spec-one", "spec-two"], undefined)).toEqual([
      "spec-one",
      "spec-two",
    ]);
  });
  test("absent flag + absent spec list → none (the pre-Batch-G path)", () => {
    expect(resolvePluginNames(undefined, undefined)).toEqual([]);
  });
});
