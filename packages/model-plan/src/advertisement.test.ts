/**
 * `buildAdvertisement` (§5) — subset-only, never additive, capability-filtered,
 * loop tools survive `tools: []` unless denied.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderFeatures } from "@crewhaus/adapter-anthropic";
import {
  buildAdvertisement,
  matchesToolPattern,
  satisfiesFeatures,
  unmetRequirement,
} from "./advertisement";

const FULL: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
};
const NO_VISION: ProviderFeatures = { ...FULL, vision: false, caching: false };

const TOOLS = [
  { name: "Read" },
  { name: "Grep" },
  { name: "Bash" },
  { name: "ReadImage", requiresModelFeatures: { vision: true } },
  { name: "mcp__github__list_issues" },
  { name: "mcp__github__create_issue" },
  { name: "mcp__linear__search" },
  { name: "ListTools" },
  { name: "Skill" },
];
const LOOP = ["ListTools", "Skill"];

describe("buildAdvertisement", () => {
  test("absent profile.tools advertises the full shape set", () => {
    const ad = buildAdvertisement(TOOLS, {}, { capabilities: { features: FULL }, retain: LOOP });
    expect([...ad.names]).toEqual(TOOLS.map((t) => t.name));
    expect(ad.excluded).toEqual([]);
    expect(ad.unmatched).toEqual([]);
  });

  test("subset by exact name keeps declared order and reports the rest", () => {
    const ad = buildAdvertisement(
      TOOLS,
      { tools: ["Grep", "Read"] },
      { capabilities: { features: FULL }, retain: LOOP },
    );
    expect(ad.tools.map((t) => t.name)).toEqual(["Read", "Grep", "ListTools", "Skill"]);
    expect(ad.excluded.map((e) => e.name)).toEqual([
      "Bash",
      "ReadImage",
      "mcp__github__list_issues",
      "mcp__github__create_issue",
      "mcp__linear__search",
    ]);
    expect(ad.excluded.every((e) => e.reason === "not-in-profile")).toBe(true);
  });

  test("server-scoped MCP glob narrows to that server", () => {
    const ad = buildAdvertisement(
      TOOLS,
      { tools: ["mcp__github__*"] },
      { capabilities: { features: FULL } },
    );
    expect(ad.tools.map((t) => t.name)).toEqual([
      "mcp__github__list_issues",
      "mcp__github__create_issue",
    ]);
  });

  test("never additive: a name matching nothing is reported, not invented", () => {
    const ad = buildAdvertisement(TOOLS, { tools: ["Read", "Fetch", "mcp__slack__*"] });
    expect(ad.tools.map((t) => t.name)).toEqual(["Read"]);
    expect(ad.unmatched).toEqual(["Fetch", "mcp__slack__*"]);
  });

  test("tools: [] means zero SHAPE tools; retained loop tools survive", () => {
    const ad = buildAdvertisement(TOOLS, { tools: [] }, { retain: LOOP });
    expect(ad.tools.map((t) => t.name)).toEqual(["ListTools", "Skill"]);
  });

  test("a permissions.deny removes even a retained loop tool", () => {
    const ad = buildAdvertisement(
      TOOLS,
      { tools: [], permissions: { deny: ["Skill(*)"] } },
      { retain: LOOP },
    );
    expect(ad.tools.map((t) => t.name)).toEqual(["ListTools"]);
    expect(ad.excluded).toContainEqual({ name: "Skill", reason: "denied" });
  });

  test("an argument-scoped deny (Bash(rm *)) does NOT remove the tool", () => {
    const ad = buildAdvertisement(TOOLS, { permissions: { deny: ["Bash(rm *)"] } });
    expect(ad.names.has("Bash")).toBe(true);
  });

  test("capability filter drops a tool the candidate cannot serve, even when named", () => {
    const ad = buildAdvertisement(
      TOOLS,
      { tools: ["Read", "ReadImage"] },
      { capabilities: { features: NO_VISION } },
    );
    expect(ad.tools.map((t) => t.name)).toEqual(["Read"]);
    expect(ad.excluded).toContainEqual({
      name: "ReadImage",
      reason: "requires-feature",
      detail: "vision",
    });
  });

  test("unknown features never satisfy a requirement", () => {
    const ad = buildAdvertisement(TOOLS, { tools: ["ReadImage"] });
    expect(ad.tools).toEqual([]);
    expect(ad.excluded.find((e) => e.name === "ReadImage")?.reason).toBe("requires-feature");
  });
});

describe("unmetRequirement / satisfiesFeatures", () => {
  test("mirrors the cost-tracker twin's semantics", () => {
    expect(unmetRequirement(undefined, undefined)).toBeUndefined();
    expect(unmetRequirement({ vision: true }, { features: FULL })).toBeUndefined();
    expect(unmetRequirement({ vision: true }, { features: NO_VISION })).toBe("vision");
    expect(unmetRequirement({ caching: "automatic" }, { features: FULL })).toBeUndefined();
    expect(unmetRequirement({ caching: "automatic" }, { features: NO_VISION })).toBe("caching");
    expect(
      unmetRequirement({ caching: "explicit" }, { features: { ...FULL, caching: "automatic" } }),
    ).toBe("caching");
    expect(unmetRequirement({ vision: false }, { features: NO_VISION })).toBeUndefined();
  });

  test("size floors need a KNOWN value at or above the floor", () => {
    expect(
      unmetRequirement({ contextWindowGte: 200000 }, { contextWindow: 200000 }),
    ).toBeUndefined();
    expect(unmetRequirement({ contextWindowGte: 200000 }, { contextWindow: 128000 })).toBe(
      "contextWindowGte",
    );
    expect(unmetRequirement({ contextWindowGte: 200000 }, {})).toBe("contextWindowGte");
    expect(unmetRequirement({ maxOutputTokensGte: 8192 }, { maxOutputTokens: 4096 })).toBe(
      "maxOutputTokensGte",
    );
  });

  test("satisfiesFeatures convenience", () => {
    expect(satisfiesFeatures(FULL, { thinking: true })).toBe(true);
    expect(satisfiesFeatures(undefined, { thinking: true })).toBe(false);
    expect(satisfiesFeatures(undefined, undefined)).toBe(true);
  });
});

describe("matchesToolPattern", () => {
  test("exact, glob, and regex metacharacters", () => {
    expect(matchesToolPattern("Read", "Read")).toBe(true);
    expect(matchesToolPattern("Read", "ReadImage")).toBe(false);
    expect(matchesToolPattern("mcp__gh__*", "mcp__gh__x")).toBe(true);
    expect(matchesToolPattern("mcp__gh__*", "mcp__linear__x")).toBe(false);
    expect(matchesToolPattern("a.b", "axb")).toBe(false);
    expect(matchesToolPattern("*", "anything")).toBe(true);
  });
});
