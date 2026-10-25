import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import { config, sumTool } from "./__fixtures__/helpers";
import { mergeGateTools, registerGateTools, wantsProofCheckTools } from "./tools";

describe("wantsProofCheckTools", () => {
  test("at proven, always", () => {
    expect(wantsProofCheckTools(config("proven"))).toBe(true);
  });

  test("below proven with the lowered default checkers, never", () => {
    for (const level of ["cited", "grounded", "checked"] as const) {
      expect(wantsProofCheckTools(config(level))).toBe(false);
    }
  });

  test("below proven with spec-chosen checkers (another set, another order), yes", () => {
    expect(wantsProofCheckTools(config("grounded", { formal: { checkers: ["builtin"] } }))).toBe(
      true,
    );
    expect(
      wantsProofCheckTools(config("checked", { formal: { checkers: ["smt", "builtin"] } })),
    ).toBe(true);
    expect(
      wantsProofCheckTools(config("cited", { formal: { checkers: ["builtin", "smt", "lean4"] } })),
    ).toBe(true);
  });
});

describe("mergeGateTools / registerGateTools — what the level adds, and what it replaces", () => {
  // At `checked` with the default checkers: the level adds only the preflight,
  // but all three proof tools are bound (and replace a listed builtin).
  const checkers = sumTool("ProofCheckers");
  const check = sumTool("ProofCheck");
  const preflight = sumTool("ProvabilityPreflight");
  const checked = { tools: [preflight], proofTools: [checkers, check, preflight] };
  const proven = { tools: [checkers, check, preflight], proofTools: [checkers, check, preflight] };

  test("adds what the level adds, after the run's tools; a copy, never the caller's array", () => {
    const a = sumTool("A");
    const tools = [a];
    expect(mergeGateTools(tools, checked)).toEqual([a, preflight]);
    expect(mergeGateTools(tools, proven)).toEqual([a, checkers, check, preflight]);
    expect(mergeGateTools(tools, { tools: [], proofTools: [] })).toEqual([a]);
    expect(mergeGateTools(tools, { tools: [], proofTools: [] })).not.toBe(tools);
  });

  test("a proof tool the run already has is replaced by the bound one, even one the level does not add", () => {
    const a = sumTool("A");
    const listedCheck = sumTool("ProofCheck");
    const listedPreflight = sumTool("ProvabilityPreflight");
    const merged = mergeGateTools([listedCheck, a, listedPreflight], checked);
    expect(merged.map((t) => t.name)).toEqual(["A", "ProofCheck", "ProvabilityPreflight"]);
    expect(merged[1]).toBe(check);
    expect(merged[2]).toBe(preflight);
    // ProofCheckers was not listed and the level does not add it.
    expect(merged).not.toContain(checkers);
  });

  test("the catalog form follows the same rule", () => {
    const catalog = new ToolCatalog();
    catalog.register(sumTool("A"));
    const listedCheck = sumTool("ProofCheck");
    catalog.register(listedCheck);
    registerGateTools(catalog, checked);
    expect(
      catalog
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["A", "ProofCheck", "ProvabilityPreflight"]);
    expect(catalog.get("ProofCheck")).toBe(check);
    expect(catalog.get("ProvabilityPreflight")).toBe(preflight);
    expect(catalog.has("ProofCheckers")).toBe(false);
    // Nothing to add, nothing to replace: the catalog is untouched.
    const bare = new ToolCatalog();
    registerGateTools(bare, { tools: [], proofTools: [] });
    expect(bare.list()).toEqual([]);
  });
});
