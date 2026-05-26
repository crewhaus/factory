/**
 * Compile-time smoke matrix for every CrewHaus target shape.
 *
 * Reads one minimal YAML fixture per shape from `./fixtures/`, drives
 * it through `compile()`, and runs the matching `ShapeAssertion` from
 * `./assertions.ts`. The matrix is the first line of defence against
 * emitter drift — the PR #107 (browser dropped `ir.tools`) and Navigate
 * (browser had no bootstrap tool) regressions both would have tripped
 * specific anchors below.
 *
 * Public surface: `runSmokeMatrix()` returns one `SmokeResult` per
 * shape. The bun test in `index.test.ts` calls it and asserts every
 * result is OK. Other callers (e.g. a CI step that wants a JSON
 * summary) can consume the same function directly.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@crewhaus/compiler";
import type { Bundle } from "@crewhaus/ir";
import { SHAPE_ASSERTIONS, type ShapeAssertion } from "./assertions.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export type SmokeResult = {
  readonly shape: string;
  readonly fixture: string;
  readonly status: "ok" | "compile_error" | "assertion_error";
  readonly failures: readonly string[];
  readonly bundle?: Bundle;
};

export function loadFixture(shape: string): string {
  return readFileSync(join(FIXTURES_DIR, `${shape}.yaml`), "utf-8");
}

export function listFixtureShapes(): readonly string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -".yaml".length))
    .sort();
}

export function runShapeSmoke(assertion: ShapeAssertion): SmokeResult {
  const fixture = `${assertion.shape}.yaml`;
  let yamlText: string;
  try {
    yamlText = loadFixture(assertion.shape);
  } catch (err) {
    return {
      shape: assertion.shape,
      fixture,
      status: "compile_error",
      failures: [`fixture not found: ${(err as Error).message}`],
    };
  }

  let bundle: Bundle;
  try {
    bundle = compile(yamlText);
  } catch (err) {
    return {
      shape: assertion.shape,
      fixture,
      status: "compile_error",
      failures: [`compile() threw: ${(err as Error).message}`],
    };
  }

  const failures: string[] = [];
  const actualFiles = bundle.files.map((f) => f.path).sort();
  const expected = [...assertion.expectedFiles].sort();
  if (actualFiles.length !== expected.length || actualFiles.some((p, i) => p !== expected[i])) {
    failures.push(`expected files ${JSON.stringify(expected)}, got ${JSON.stringify(actualFiles)}`);
  }

  for (const a of assertion.anchors) {
    if (a.in === "any") {
      const hit = bundle.files.some((f) => f.content.includes(a.contains));
      if (!hit) failures.push(`no file contains ${JSON.stringify(a.contains)}`);
      continue;
    }
    const file = bundle.files.find((f) => f.path === a.in);
    if (!file) {
      failures.push(`anchor target file "${a.in}" not in bundle`);
      continue;
    }
    if (!file.content.includes(a.contains)) {
      failures.push(`"${a.in}" missing anchor ${JSON.stringify(a.contains)}`);
    }
  }

  return {
    shape: assertion.shape,
    fixture,
    status: failures.length === 0 ? "ok" : "assertion_error",
    failures,
    bundle,
  };
}

export function runSmokeMatrix(): readonly SmokeResult[] {
  // Cross-check: every fixture on disk has an assertion entry and
  // vice versa. Mismatch is itself a smoke failure — it means someone
  // added a shape without wiring it into the matrix, or vice versa.
  const fixtureShapes = new Set(listFixtureShapes());
  const assertionShapes = new Set(SHAPE_ASSERTIONS.map((a) => a.shape));
  const orphanFixtures = [...fixtureShapes].filter((s) => !assertionShapes.has(s));
  const orphanAssertions = [...assertionShapes].filter((s) => !fixtureShapes.has(s));
  const matrix = SHAPE_ASSERTIONS.map(runShapeSmoke);
  if (orphanFixtures.length > 0 || orphanAssertions.length > 0) {
    return [
      ...matrix,
      {
        shape: "__matrix__",
        fixture: "matrix-consistency",
        status: "assertion_error",
        failures: [
          ...(orphanFixtures.length > 0
            ? [`fixtures without an assertion entry: ${orphanFixtures.join(", ")}`]
            : []),
          ...(orphanAssertions.length > 0
            ? [`assertions without a fixture: ${orphanAssertions.join(", ")}`]
            : []),
        ],
      },
    ];
  }
  return matrix;
}

export { SHAPE_ASSERTIONS } from "./assertions.js";
export type { ShapeAssertion } from "./assertions.js";
