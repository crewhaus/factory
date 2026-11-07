/**
 * The per-shape accent map: one accent per canonical compile target, and a
 * safe default for anything unknown.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACCENT,
  DEFAULT_ACCENT_LIGHT,
  SHAPE_ACCENTS,
  SHAPE_ACCENTS_LIGHT,
  shapeAccent,
  shapeAccentVars,
  shapeLabel,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/shapes.js";

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

describe("the light theme's accents", () => {
  test("pair every dark accent, and nothing else", () => {
    expect(Object.keys(SHAPE_ACCENTS_LIGHT).sort()).toEqual(Object.keys(SHAPE_ACCENTS).sort());
    for (const shape of CANONICAL) expect(SHAPE_ACCENTS_LIGHT[shape]).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("shapeAccentVars hands a node both, so a theme switch needs no re-render", () => {
    expect(shapeAccentVars("voice")).toEqual({
      "--accent-dark": SHAPE_ACCENTS.voice,
      "--accent-light": SHAPE_ACCENTS_LIGHT.voice,
    });
    expect(shapeAccentVars("toString")).toEqual({
      "--accent-dark": DEFAULT_ACCENT,
      "--accent-light": DEFAULT_ACCENT_LIGHT,
    });
    expect(shapeAccentVars(undefined)).toEqual(shapeAccentVars(""));
  });
});
