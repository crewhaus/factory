/**
 * 0.6.0 §5.1 (the PR 5 wave-1 carry-over) — `ReadImage` declares
 * `requiresModelFeatures: { vision: true }`: its result is an image block the
 * model must be able to SEE, so a pool candidate without vision never gets it
 * advertised (runtime-core's plan table consults this through
 * `@crewhaus/model-plan`'s `buildAdvertisement`, whose capability filter is
 * pinned in that package) and `compile --strict` can check the same
 * requirement offline against the capability table.
 */
import { describe, expect, test } from "bun:test";
import { readImage } from "./index";

describe("ReadImage — requiresModelFeatures", () => {
  test("declares vision: true and buildTool passes it through to the RegisteredTool", () => {
    expect(readImage.requiresModelFeatures).toEqual({ vision: true });
  });
});
