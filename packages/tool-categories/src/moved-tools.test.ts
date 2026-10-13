/**
 * Regression review (0.7.1): 0c9f9226 moved VectorDelete out of the `state`
 * leaf, so `[all-state, -vectorDelete]` — the careful author who kept the
 * destructive remote delete out of a local roll-up — compiled on 0.7.0 and
 * was refused on 0.7.1 as "excludes a tool that nothing includes". Such an
 * exclusion is now accepted as the no-op it has become; every other dead
 * exclusion is still refused.
 */
import { describe, expect, test } from "bun:test";
import { expandToolSelectors, toolsInCategory } from "./index";

describe("an exclusion of a tool a later release moved out of a category", () => {
  const ROLL_UPS = ["state", "memory", "data-stores"] as const;

  for (const category of ROLL_UPS) {
    test(`[all-${category}, -vectorDelete] still compiles, and VectorDelete stays out`, () => {
      expect(toolsInCategory(category)).not.toContain("vectorDelete");
      const result = expandToolSelectors([`all-${category}`, "-vectorDelete"]);
      expect(result.tools).not.toContain("vectorDelete");
      expect(result.tools).toEqual(expandToolSelectors([`all-${category}`]).tools);
    });
  }

  test("every roll-up that granted it on 0.7.0 is covered (guard)", () => {
    expect(ROLL_UPS.length).toBe(3);
  });

  test("where VectorDelete is included, excluding it still removes it", () => {
    const result = expandToolSelectors(["all-state", "all-network", "-vectorDelete"]);
    expect(result.tools).not.toContain("vectorDelete");
    expect(expandToolSelectors(["all-state", "all-network"]).tools).not.toContain("vectorDelete");
    expect(expandToolSelectors(["all-vector", "-vectorDelete"]).tools).not.toContain(
      "vectorDelete",
    );
    expect(expandToolSelectors(["all-state", "vectorDelete", "-vectorDelete"]).tools).not.toContain(
      "vectorDelete",
    );
  });

  test("the same exclusion with no category that held VectorDelete is still a dead exclusion", () => {
    expect(() => expandToolSelectors(["all-git", "-vectorDelete"])).toThrow(
      /"-vectorDelete" excludes a tool that nothing includes/,
    );
    // A bare state tool is not a category that held VectorDelete.
    expect(() => expandToolSelectors(["checkpointSave", "-vectorDelete"])).toThrow(
      /"-vectorDelete" excludes a tool that nothing includes/,
    );
  });

  test("any other dead exclusion after all-state is still refused", () => {
    expect(() => expandToolSelectors(["all-state", "-gitPush"])).toThrow(
      /"-gitPush" excludes a tool that nothing includes/,
    );
  });
});
