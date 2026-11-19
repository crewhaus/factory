/**
 * `tool_config.work` (#514): what the runtime may accept on its own, and the weights the
 * ranker reads, are the owner's. Every leaf under `tool_config` is a structural segment the
 * optimizer never reaches and a security surface at any depth, so the block needs no row of
 * its own; this pins that for both places a spec writes it, the root `tool_config` and a
 * channel's or managed agent's `agent.tool_config`.
 */
import { describe, expect, test } from "bun:test";
import { type Spec, parseSpec } from "@crewhaus/spec";
import {
  SECURITY_SURFACES,
  STRUCTURAL_SEGMENTS,
  leafReachable,
  surfaceFor,
  validatePatch,
} from "./index";

const SPEC = `name: work-fixture
target: cli
agent:
  model: claude-opus-4-7
  instructions: Help.
tool_config:
  work:
    accept: [fix]
    ranking:
      weights: { evidence: 2 }
`;

const SURFACE_REASON = "tool config decides what the agent's tools may reach";

const LEAVES = [
  ["tool_config", "work", "accept"],
  ["tool_config", "work", "ranking", "weights", "evidence"],
] as const;

/** Where each shape writes the block: the root, or its agent. */
const PLACEMENTS: readonly (readonly [Spec["target"], readonly string[]])[] = [
  ["cli", []],
  ["workflow", []],
  ["graph", []],
  ["crew", []],
  ["research", []],
  ["batch", []],
  ["channel", ["agent"]],
  ["managed", ["agent"]],
  // A step's, a node's and a role's own block: the optimizer may replace the whole step,
  // node or role, so only the structural segment keeps it from this block.
  ["workflow", ["steps", "0"]],
  ["graph", ["nodes", "triage"]],
  ["crew", ["roles", "lead"]],
];

function refusal(spec: Spec, path: readonly string[], value: unknown): string {
  try {
    validatePatch(spec, { target: spec.target, path: [...path], op: "replace", value });
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

describe("tool_config.work is the owner's", () => {
  test("no leaf of it is reachable by the optimizer, on any shape, in either place", () => {
    for (const [target, at] of PLACEMENTS) {
      for (const leaf of LEAVES) {
        expect(
          `${target} ${[...at, ...leaf].join(".")}: ${leafReachable(target, [...at, ...leaf])}`,
        ).toBe(`${target} ${[...at, ...leaf].join(".")}: false`);
      }
    }
  });

  test("a step, a node or a role replaced whole still never reaches it: tool_config is structural", () => {
    expect(STRUCTURAL_SEGMENTS).toContain("tool_config");
    // The ancestor is reachable, so the segment is what stops the leaf.
    expect(leafReachable("workflow", ["steps", "0", "instructions"])).toBe(true);
    expect(leafReachable("workflow", ["steps", "0", "tool_config", "work", "accept"])).toBe(false);
    const spec = parseSpec(SPEC);
    expect(refusal(spec, ["tool_config", "work", "accept"], ["feature"])).not.toBe("");
  });

  test("every leaf is a security surface wherever it is written", () => {
    const anywhere = SECURITY_SURFACES.filter(
      (row) => row.prefix.join(".") === "tool_config" && row.anywhere === true,
    );
    expect(anywhere.length).toBeGreaterThanOrEqual(1);
    for (const [, at] of PLACEMENTS) {
      for (const leaf of LEAVES) {
        const surface = surfaceFor([...at, ...leaf]);
        expect(surface?.prefix).toEqual(["tool_config"]);
        expect(surface?.reason).toBe(SURFACE_REASON);
      }
    }
  });
});
