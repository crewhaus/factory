/**
 * The per-shape accent map: one accent per canonical compile target, and a
 * safe default for anything unknown.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { DEFAULT_ACCENT, SHAPE_ACCENTS, shapeAccent, shapeLabel } from "../assets/js/shapes.js";

const CANONICAL = [
  "cli",
  "channel",
  "workflow",
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

describe("shape accents", () => {
  test("covers every canonical target with a hex color", () => {
    for (const shape of CANONICAL) {
      expect(SHAPE_ACCENTS[shape]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.keys(SHAPE_ACCENTS).sort()).toEqual([...CANONICAL].sort());
  });

  test("lookup falls back to the default accent", () => {
    expect(shapeAccent("channel")).toBe(SHAPE_ACCENTS.channel);
    expect(shapeAccent("unknown-shape")).toBe(DEFAULT_ACCENT);
    expect(shapeAccent(undefined)).toBe(DEFAULT_ACCENT);
    // prototype names must not leak through the map lookup
    expect(shapeAccent("toString")).toBe(DEFAULT_ACCENT);
  });

  test("labels", () => {
    expect(shapeLabel("cli")).toBe("cli");
    expect(shapeLabel("")).toBe("?");
    expect(shapeLabel(null)).toBe("?");
  });
});
