/**
 * extension-path#11 (0.7.1, C101) — `engines.crewhaus` was typed as "the
 * crewhaus versions this plugin requires" and then never read, so a plugin
 * written for a later crewhaus loaded anyway. The check lives here, once, for
 * the loader (which refuses) and the marketplace install (which warns).
 */
import { describe, expect, test } from "bun:test";
import { crewhausEngineProblem, isValidEngineRange } from "./index";

describe("isValidEngineRange", () => {
  const valid = [
    "*",
    "x",
    "0.7.x",
    "^0.7.0",
    "~0.7",
    ">=0.7.0",
    ">= 0.7.0",
    ">=0.7.0 <0.8.0",
    "=0.7.1",
    "v0.7.1",
    "0.7.1",
    "1",
    "^0.6.0 || ^0.7.0",
    "0.6.0 - 0.8.0",
    ">=1.0.0-beta.1",
    "1.2.3+build.5",
  ];
  const invalid = [
    "",
    "   ",
    "not a range",
    "garbage>=1",
    ">=",
    "^",
    "1.2.3.4",
    "01.2.3",
    "1.2.3 -",
    "|| ^0.7.0",
    "^0.7.0 ||",
    ">=0.7.0 && <0.8.0",
    "latest",
    `^${"1".repeat(300)}`,
  ];

  test("accepts the npm range grammar", () => {
    const rejected = valid.filter((r) => !isValidEngineRange(r));
    expect(rejected).toEqual([]);
    expect(valid.length).toBe(16);
  });

  test("refuses text Bun.semver.satisfies would wave through", () => {
    // The reason this check exists: satisfies() says yes to nonsense.
    expect(Bun.semver.satisfies("0.7.1", "not a range")).toBe(true);
    expect(Bun.semver.satisfies("0.7.1", "garbage>=1")).toBe(true);
    const accepted = invalid.filter((r) => isValidEngineRange(r));
    expect(accepted).toEqual([]);
    expect(invalid.length).toBe(14);
  });
});

describe("crewhausEngineProblem", () => {
  const plugin = (crewhaus?: string) => ({
    name: "my-plugin",
    version: "1.0.0",
    ...(crewhaus !== undefined ? { engines: { crewhaus } } : {}),
  });

  test("a plugin that declares no range runs anywhere, as before", () => {
    expect(crewhausEngineProblem(plugin(), "0.7.1")).toBeUndefined();
    expect(crewhausEngineProblem({ ...plugin(), engines: {} }, "0.7.1")).toBeUndefined();
  });

  test("a range that includes this version runs", () => {
    for (const r of ["^0.7.0", ">=0.7.0 <0.8.0", "0.7.x", "*", "0.6.0 - 0.8.0"]) {
      expect({ r, problem: crewhausEngineProblem(plugin(r), "0.7.1") }).toEqual({
        r,
        problem: undefined,
      });
    }
  });

  test("a range that leaves this version out is named, with both versions", () => {
    expect(crewhausEngineProblem(plugin(">=99.0.0"), "0.7.1")).toBe(
      'plugin "my-plugin" 1.0.0 requires crewhaus >=99.0.0, and this is crewhaus 0.7.1',
    );
    // ^0.6.0 is >=0.6.0 <0.7.0 — a 0.6 plugin is not promised to run on 0.7.
    expect(crewhausEngineProblem(plugin("^0.6.0"), "0.7.1")).toMatch(/requires crewhaus \^0\.6\.0/);
  });

  test("a range that is not a range is a problem, not a pass", () => {
    expect(crewhausEngineProblem(plugin("not a range"), "0.7.1")).toBe(
      'plugin "my-plugin" 1.0.0 declares engines.crewhaus "not a range", which is not a semver range, so crewhaus cannot tell whether it runs on 0.7.1',
    );
  });

  test("a prerelease host is checked as its release", () => {
    expect(Bun.semver.satisfies("0.7.1-canary.2", ">=0.7.0")).toBe(false);
    expect(crewhausEngineProblem(plugin(">=0.7.0"), "0.7.1-canary.2")).toBeUndefined();
    expect(crewhausEngineProblem(plugin(">=0.7.2"), "0.7.1-canary.2")).toMatch(
      /and this is crewhaus 0\.7\.1-canary\.2$/,
    );
  });
});
