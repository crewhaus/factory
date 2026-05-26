import { describe, expect, test } from "bun:test";
import { SHAPE_ASSERTIONS, listFixtureShapes, runShapeSmoke, runSmokeMatrix } from "./index.js";

describe("smoke matrix — every target shape compiles + wires its baseline", () => {
  // Generate one test per shape so a failure pinpoints which emitter
  // drifted instead of failing them all behind a single assertion.
  for (const assertion of SHAPE_ASSERTIONS) {
    test(`shape: ${assertion.shape}`, () => {
      const result = runShapeSmoke(assertion);
      if (result.status !== "ok") {
        throw new Error(
          [
            `smoke failed for shape "${assertion.shape}" (${result.status}):`,
            ...result.failures.map((f) => `  - ${f}`),
          ].join("\n"),
        );
      }
      expect(result.status).toBe("ok");
    });
  }
});

describe("smoke matrix — coverage", () => {
  test("every fixture on disk has a matching SHAPE_ASSERTIONS entry", () => {
    const fixtureShapes = listFixtureShapes();
    const assertionShapes = SHAPE_ASSERTIONS.map((a) => a.shape);
    const orphans = fixtureShapes.filter((s) => !assertionShapes.includes(s));
    expect(orphans).toEqual([]);
  });

  test("every SHAPE_ASSERTIONS entry has a fixture on disk", () => {
    const fixtureShapes = new Set(listFixtureShapes());
    const orphans = SHAPE_ASSERTIONS.filter((a) => !fixtureShapes.has(a.shape)).map((a) => a.shape);
    expect(orphans).toEqual([]);
  });

  test("runSmokeMatrix returns one ok result per declared shape", () => {
    const results = runSmokeMatrix();
    const matrixEntry = results.find((r) => r.shape === "__matrix__");
    if (matrixEntry !== undefined) {
      throw new Error(`matrix consistency failure: ${matrixEntry.failures.join("; ")}`);
    }
    expect(results).toHaveLength(SHAPE_ASSERTIONS.length);
    for (const r of results) expect(r.status).toBe("ok");
  });
});
