/**
 * Branch coverage for `index.ts`. Exercised against the real fixtures +
 * real `compile()`; the two branches that need a throwing compile or
 * synthetic orphans are reached via the injectable `deps` seams on
 * `runShapeSmoke`/`runSmokeMatrix` (added precisely because
 * process-global `mock.module` of the shared `@crewhaus/compiler` leaks
 * across Bun test files).
 */
import { describe, expect, test } from "bun:test";
import type { Bundle } from "@crewhaus/ir";
import type { ShapeAssertion } from "./assertions.js";
import {
  type SmokeResult,
  listFixtureShapes,
  loadFixture,
  runShapeSmoke,
  runSmokeMatrix,
} from "./index.js";

describe("loadFixture / listFixtureShapes", () => {
  test("loadFixture returns the raw YAML for a real shape", () => {
    const yaml = loadFixture("cli");
    expect(yaml).toContain("target: cli");
  });

  test("listFixtureShapes is sorted and includes the known shapes", () => {
    const shapes = listFixtureShapes();
    expect(shapes).toContain("cli");
    expect(shapes).toContain("browser");
    expect([...shapes]).toEqual([...shapes].sort());
  });
});

describe("runShapeSmoke — failure branches", () => {
  test("missing fixture → compile_error with a 'fixture not found' message", () => {
    const assertion: ShapeAssertion = {
      shape: "this-shape-has-no-fixture",
      expectedFiles: ["agent.ts"],
      anchors: [],
    };
    const result = runShapeSmoke(assertion);
    expect(result.status).toBe("compile_error");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("fixture not found");
    expect(result.bundle).toBeUndefined();
  });

  test("wrong expectedFiles → assertion_error naming the file mismatch", () => {
    const assertion: ShapeAssertion = {
      shape: "cli",
      // cli emits exactly ["agent.ts"]; demand a different set.
      expectedFiles: ["agent.ts", "phantom.ts"],
      anchors: [],
    };
    const result = runShapeSmoke(assertion);
    expect(result.status).toBe("assertion_error");
    expect(result.failures.join("\n")).toContain("expected files");
  });

  test("missing 'any' anchor → reports no file contains the substring", () => {
    const assertion: ShapeAssertion = {
      shape: "cli",
      expectedFiles: ["agent.ts"],
      anchors: [{ in: "any", contains: "__no_file_contains_this_token__" }],
    };
    const result = runShapeSmoke(assertion);
    expect(result.status).toBe("assertion_error");
    expect(result.failures.join("\n")).toContain("no file contains");
  });

  test("present 'any' anchor passes (covers the satisfied any-branch)", () => {
    const assertion: ShapeAssertion = {
      shape: "cli",
      // Item 42 — every bundle now carries a generated README.md too.
      expectedFiles: ["README.md", "agent.ts"],
      // cli bundles import runtime-core, so this substring is present.
      anchors: [{ in: "any", contains: "@crewhaus/runtime-core" }],
    };
    const result = runShapeSmoke(assertion);
    expect(result.status).toBe("ok");
    expect(result.failures).toEqual([]);
  });

  test("anchor targeting a non-existent file → 'not in bundle'", () => {
    const assertion: ShapeAssertion = {
      shape: "cli",
      expectedFiles: ["agent.ts"],
      anchors: [{ in: "no-such-file.ts", contains: "anything" }],
    };
    const result = runShapeSmoke(assertion);
    expect(result.status).toBe("assertion_error");
    expect(result.failures.join("\n")).toContain('"no-such-file.ts" not in bundle');
  });

  test("anchor substring absent from the named file → 'missing anchor'", () => {
    const assertion: ShapeAssertion = {
      shape: "cli",
      expectedFiles: ["agent.ts"],
      anchors: [{ in: "agent.ts", contains: "__definitely_absent_anchor__" }],
    };
    const result = runShapeSmoke(assertion);
    expect(result.status).toBe("assertion_error");
    expect(result.failures.join("\n")).toContain("missing anchor");
  });

  test("compile() throws → compile_error with the thrown message (injected compile)", () => {
    const throwingCompile = (_yaml: string): Bundle => {
      throw new Error("synthetic compile failure");
    };
    const result = runShapeSmoke(
      { shape: "cli", expectedFiles: ["agent.ts"], anchors: [] },
      { compile: throwingCompile },
    );
    expect(result.status).toBe("compile_error");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("compile() threw");
    expect(result.failures[0]).toContain("synthetic compile failure");
  });
});

describe("runSmokeMatrix — orphan detection (injected deps)", () => {
  const ok = (shape: string): SmokeResult => ({
    shape,
    fixture: `${shape}.yaml`,
    status: "ok",
    failures: [],
  });

  test("no orphans → returns one result per assertion, no __matrix__ entry", () => {
    const results = runSmokeMatrix({
      assertions: [{ shape: "cli", expectedFiles: ["agent.ts"], anchors: [] }],
      listFixtureShapes: () => ["cli"],
      runShapeSmoke: (a) => ok(a.shape),
    });
    expect(results).toHaveLength(1);
    expect(results.find((r) => r.shape === "__matrix__")).toBeUndefined();
    expect(results[0]?.status).toBe("ok");
  });

  test("orphan fixture only → __matrix__ reports the unwired fixture", () => {
    const results = runSmokeMatrix({
      assertions: [{ shape: "cli", expectedFiles: ["agent.ts"], anchors: [] }],
      // "ghostfix" exists on disk but has no assertion.
      listFixtureShapes: () => ["cli", "ghostfix"],
      runShapeSmoke: (a) => ok(a.shape),
    });
    const matrixEntry = results.find((r) => r.shape === "__matrix__");
    expect(matrixEntry?.status).toBe("assertion_error");
    const failures = (matrixEntry?.failures ?? []).join("\n");
    expect(failures).toContain("fixtures without an assertion entry");
    expect(failures).toContain("ghostfix");
    // Only the orphan-fixture failure is present (no orphan-assertion line).
    expect(failures).not.toContain("assertions without a fixture");
  });

  test("orphan assertion only → __matrix__ reports the fixture-less assertion", () => {
    const results = runSmokeMatrix({
      // "ghostassert" is declared but has no fixture on disk.
      assertions: [
        { shape: "cli", expectedFiles: ["agent.ts"], anchors: [] },
        { shape: "ghostassert", expectedFiles: ["agent.ts"], anchors: [] },
      ],
      listFixtureShapes: () => ["cli"],
      runShapeSmoke: (a) => ok(a.shape),
    });
    const matrixEntry = results.find((r) => r.shape === "__matrix__");
    expect(matrixEntry?.status).toBe("assertion_error");
    const failures = (matrixEntry?.failures ?? []).join("\n");
    expect(failures).toContain("assertions without a fixture");
    expect(failures).toContain("ghostassert");
    expect(failures).not.toContain("fixtures without an assertion entry");
    // The two declared shapes ran first, then the appended __matrix__ entry.
    expect(results).toHaveLength(3);
  });

  test("both orphan kinds at once → __matrix__ reports both", () => {
    const results = runSmokeMatrix({
      assertions: [{ shape: "ghostassert", expectedFiles: ["agent.ts"], anchors: [] }],
      listFixtureShapes: () => ["ghostfix"],
      runShapeSmoke: (a) => ok(a.shape),
    });
    const matrixEntry = results.find((r) => r.shape === "__matrix__");
    const failures = (matrixEntry?.failures ?? []).join("\n");
    expect(failures).toContain("fixtures without an assertion entry");
    expect(failures).toContain("ghostfix");
    expect(failures).toContain("assertions without a fixture");
    expect(failures).toContain("ghostassert");
  });

  test("defaults: runSmokeMatrix() with no deps uses the real matrix (no orphans)", () => {
    // Exercises the default-parameter bindings (assertions/listFixtureShapes/
    // runShapeSmoke all fall back to production) and the no-orphan return.
    const results = runSmokeMatrix();
    expect(results.find((r) => r.shape === "__matrix__")).toBeUndefined();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.status).toBe("ok");
  });
});
