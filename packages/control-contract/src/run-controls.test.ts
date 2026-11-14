import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_NAMES,
  type CapabilityDescriptor,
  RUN_CONTROL_KEYS,
  RUN_CONTROL_SHAPES,
  SHAPE_RUN_CONTROLS,
} from "./index.js";
import { capabilityDescriptor } from "./schemas/core.js";

/**
 * The cells a truth test proves `true`, as `shape key`, each naming the test that does.
 * Empty until one exists: a `true` cell with no row here fails.
 */
const TRUTH_TESTS: Readonly<Record<string, string>> = {};

/** The compiler's targets, written apart from the table, minus the three with no run controls. */
const COMPILER_TARGETS = [
  "cli",
  "workflow",
  "channel",
  "graph",
  "managed",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
  "eval",
  "onchain",
  "onchain-game",
];

function trueCells(
  table: Readonly<Record<string, Readonly<Record<string, CapabilityDescriptor>>>>,
): string[] {
  const cells: string[] = [];
  for (const [shape, row] of Object.entries(table)) {
    for (const [key, cell] of Object.entries(row)) {
      if (cell.supported === true) cells.push(`${shape} ${key}`);
    }
  }
  return cells;
}

describe("SHAPE_RUN_CONTROLS", () => {
  test("every shape has every key, and only those", () => {
    expect(Object.keys(SHAPE_RUN_CONTROLS).sort()).toEqual([...RUN_CONTROL_SHAPES].sort());
    for (const shape of RUN_CONTROL_SHAPES) {
      expect(Object.keys(SHAPE_RUN_CONTROLS[shape]).sort()).toEqual([...RUN_CONTROL_KEYS].sort());
    }
  });

  test("the shapes are the compiler's targets that run work", () => {
    const without = COMPILER_TARGETS.filter(
      (target) => !["eval", "onchain", "onchain-game"].includes(target),
    );
    expect([...RUN_CONTROL_SHAPES].sort()).toEqual(without.sort());
  });

  test("the keys are five of the core's capability keys", () => {
    expect(RUN_CONTROL_KEYS).toHaveLength(5);
    for (const key of RUN_CONTROL_KEYS) expect(CAPABILITY_NAMES).toContain(key);
    for (const perBundle of ["runs.ledger", "decisions.consumeChecks", "events.trace"]) {
      expect(RUN_CONTROL_KEYS as readonly string[]).not.toContain(perBundle);
    }
  });

  test("every cell is a descriptor, and a refusal or an unknown says why", () => {
    for (const shape of RUN_CONTROL_SHAPES) {
      for (const key of RUN_CONTROL_KEYS) {
        const cell = SHAPE_RUN_CONTROLS[shape][key];
        expect(capabilityDescriptor.safeParse(cell).success).toBe(true);
        if (cell.supported !== true) expect(cell.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("no cell is true without a named truth test, and a planted one is caught", () => {
    expect(trueCells(SHAPE_RUN_CONTROLS).filter((cell) => !(cell in TRUTH_TESTS))).toEqual([]);
    const planted = {
      ...SHAPE_RUN_CONTROLS,
      channel: { ...SHAPE_RUN_CONTROLS.channel, "controls.drain": { supported: true } as const },
    };
    expect(trueCells(planted).filter((cell) => !(cell in TRUTH_TESTS))).toEqual([
      "channel controls.drain",
    ]);
  });

  test("an unknown shape has no row", () => {
    expect(Object.hasOwn(SHAPE_RUN_CONTROLS, "eval")).toBe(false);
    expect(Object.hasOwn(SHAPE_RUN_CONTROLS, "spaceship")).toBe(false);
  });
});
