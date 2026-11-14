/**
 * `permissions.delegation` (#514): who may act without asking is the owner's decision,
 * so the optimizer is refused the ceiling on every shape that has `permissions:`, as a
 * leaf and as a block patch that would change it, and the spec editor treats it as a
 * security surface.
 */
import { describe, expect, test } from "bun:test";
import { type Spec, parseSpec } from "@crewhaus/spec";
import {
  DELTA_090_KEYS,
  HUMAN_OWNED_PATHS,
  OPTIMIZER_REFUSED_LEAVES,
  SECURITY_SURFACES,
  surfaceFor,
  validatePatch,
} from "./index";

const ROW = DELTA_090_KEYS.find((key) => key.pattern.join(".") === "permissions.delegation");

const SPEC = `name: delegation-fixture
target: cli
agent:
  model: claude-opus-4-7
  instructions: Help.
permissions:
  mode: default
  delegation:
    max_days: 20
`;

function refusal(spec: Spec, path: string[], value: unknown, op: "replace" | "remove" = "replace") {
  try {
    validatePatch(spec, { target: spec.target, path, op, ...(op === "replace" ? { value } : {}) });
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

describe("the delegation ceiling's owner row", () => {
  test("is refused, human-owned and a security surface, with its reason", () => {
    expect(ROW).toEqual({
      pattern: ["permissions", "delegation"],
      refused: true,
      security: true,
      reason: "who may act without asking is the owner's decision",
      since: "0.9.0",
    });
    expect(ROW?.root).toBeUndefined();
  });

  test("each derived list holds the row exactly once", () => {
    const named = (rows: ReadonlyArray<ReadonlyArray<string>>): number =>
      rows.filter((pattern) => pattern.join(".") === "permissions.delegation").length;
    expect(named(OPTIMIZER_REFUSED_LEAVES)).toBe(1);
    expect(named(HUMAN_OWNED_PATHS.map((row) => row.pattern))).toBe(1);
    expect(named(SECURITY_SURFACES.map((row) => row.prefix))).toBe(1);
    expect(surfaceFor(["permissions", "delegation", "max_days"])).toBeDefined();
  });

  test("the optimizer is refused the leaf, and a whole-permissions patch that changes it", () => {
    const spec = parseSpec(SPEC);
    const leaf = refusal(spec, ["permissions", "delegation", "max_days"], 90);
    expect(leaf).toContain(ROW?.reason as string);
    expect(refusal(spec, ["permissions", "delegation"], { max_days: 90 })).toContain(
      ROW?.reason as string,
    );
    // `permissions` is never optimizable on any shape, so a patch to the whole block is
    // refused before any leaf under it is read.
    for (const target of ["cli", "channel", "managed", "workflow"] as const) {
      const whole = refusal({ ...spec, target } as Spec, ["permissions"], {
        mode: "default",
        delegation: { max_days: 90 },
      });
      expect(whole).toContain("is not listed in OPTIMIZABLE_PATHS");
    }
    expect(refusal(spec, ["permissions"], undefined, "remove")).toContain(
      "is not listed in OPTIMIZABLE_PATHS",
    );
  });
});
