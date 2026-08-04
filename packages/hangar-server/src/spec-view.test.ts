/**
 * Capability badges — the fleet table's capability column.
 *
 * The regression these pin (F-7): `wiki` and `dream` were scanned at column
 * 0, but the schema nests them under `memory:` and a TOP-LEVEL `dream:`
 * fails validation outright, so two of the seven badges were unreachable
 * for any valid spec.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { BADGE_KEYS, capabilityBadges } from "./spec-view";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

const on = (yaml: string): string[] => {
  const badges = capabilityBadges(yaml);
  return BADGE_KEYS.filter((k) => badges[k]);
};

describe("capabilityBadges", () => {
  test("wiki and dream badge where the schema actually puts them (memory.*)", () => {
    const yaml = [
      "name: nested",
      "target: cli",
      "memory:",
      "  wiki: {}",
      "  dream:",
      "    every: 10",
    ].join("\n");
    expect(on(yaml)).toEqual(["memory", "wiki", "dream"]);
  });

  test("the memory block's flow form badges the same way", () => {
    expect(on("name: flow\nmemory: { recall: true, wiki: {}, dream: { every: 5 } }\n")).toEqual([
      "memory",
      "wiki",
      "dream",
    ]);
  });

  test("a nested key stops at the next column-0 block, so a sibling never bleeds in", () => {
    const yaml = ["memory:", "  recall: true", "budget:", "  wiki: nope", "  dream: nope"].join(
      "\n",
    );
    expect(on(yaml)).toEqual(["memory", "budget"]);
  });

  test("a commented-out child does not badge", () => {
    expect(on("memory:\n  recall: true\n  # wiki: notes\n")).toEqual(["memory"]);
  });

  test("a look-alike child key does not badge", () => {
    expect(on("memory:\n  wiki_url: https://example.invalid\n")).toEqual(["memory"]);
  });

  test("the lenient top-level scan still wins for a spec a schema version away", () => {
    expect(on("wiki: {}\ndream: {}\n")).toEqual(["wiki", "dream"]);
  });

  test("the other five badges are unchanged top-level blocks", () => {
    const yaml = [
      "thredz:",
      "  url: x",
      "watchme:",
      "  capture: true",
      "feedback:",
      "  capture: true",
      "budget:",
      "  usd: 10",
    ].join("\n");
    expect(on(yaml)).toEqual(["thredz", "watchme", "feedback", "budget"]);
  });

  test("nothing declared badges nothing", () => {
    expect(on("name: bare\ntarget: cli\n")).toEqual([]);
  });
});

describe("the Library capability column", () => {
  test("a harness declaring wiki + dream under memory: badges both", async () => {
    const t = bootTestServer();
    servers.push(t);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "nested"), {
      specName: "nested",
      specExtra: ["memory:", "  recall: true", "  wiki: {}", "  dream:", "    every: 10"].join(
        "\n",
      ),
    });
    await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
    const { body } = await t.api("/api/harnesses");
    const rows = body["harnesses"] as Array<Record<string, unknown>>;
    const row = rows.find((r) => r["dir"] === dir) as Record<string, unknown>;
    expect(row["capabilities"]).toEqual(["memory", "wiki", "dream"]);
  });
});
