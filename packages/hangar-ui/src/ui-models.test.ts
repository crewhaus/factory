/** The decisions of the smaller components, each a pure export. */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { confirmReady } from "../assets/js/ui/dialog.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { panelModel } from "../assets/js/ui/panels.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { CHECK_GLYPH, toggleModel } from "../assets/js/ui/toggle.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { tipPlacement } from "../assets/js/ui/tooltip.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { startSelection } from "../assets/js/views/inbox.js";

describe("confirmReady", () => {
  test("a typed confirmation needs the exact name", () => {
    expect(confirmReady({ level: "typed", confirmName: "prod", typed: "pro" }).ready).toBe(false);
    expect(confirmReady({ level: "typed", confirmName: "prod", typed: " prod " }).ready).toBe(true);
    // An empty name can never be typed to.
    expect(confirmReady({ level: "typed", confirmName: "", typed: "" }).ready).toBe(false);
  });

  test("a required reason must be given, and says why it is not", () => {
    const r = confirmReady({ level: "confirm", reasonRequired: true, reason: "  " });
    expect(r.ready).toBe(false);
    expect(r.why).toContain("reason is required");
    expect(confirmReady({ level: "confirm", reasonRequired: true, reason: "stale" }).ready).toBe(
      true,
    );
    expect(confirmReady({ level: "confirm" }).ready).toBe(true);
  });
});

describe("toggleModel", () => {
  test("pressed is said in aria-pressed AND shown as a glyph", () => {
    expect(toggleModel(true)).toEqual({ ariaPressed: "true", glyph: CHECK_GLYPH });
    expect(toggleModel(false)).toEqual({ ariaPressed: "false", glyph: "" });
    expect(toggleModel(undefined).ariaPressed).toBe("false");
  });
});

describe("panelModel", () => {
  const PANELS = [
    ["facts", "Facts"],
    ["wiki", "Wiki"],
  ];
  test("exactly one panel is current, and an unknown one falls back to the first", () => {
    expect(panelModel(PANELS, "wiki").map((p: { current: boolean }) => p.current)).toEqual([
      false,
      true,
    ]);
    expect(panelModel(PANELS, "nope").map((p: { current: boolean }) => p.current)).toEqual([
      true,
      false,
    ]);
  });
});

describe("tipPlacement", () => {
  const view = { width: 320, height: 600 };
  test("below the control, and never past either side", () => {
    expect(
      tipPlacement({ left: 10, top: 10, bottom: 30 }, { width: 100, height: 40 }, view),
    ).toEqual({ left: 10, top: 36 });
    expect(
      tipPlacement({ left: 300, top: 10, bottom: 30 }, { width: 200, height: 40 }, view).left,
    ).toBe(112);
    expect(
      tipPlacement({ left: -50, top: 10, bottom: 30 }, { width: 100, height: 40 }, view).left,
    ).toBe(8);
  });
  test("above when it would leave the bottom of the screen", () => {
    expect(
      tipPlacement({ left: 10, top: 560, bottom: 580 }, { width: 100, height: 40 }, view).top,
    ).toBe(514);
  });
});

describe("startSelection", () => {
  test("a kept row is found by id after a reload", () => {
    expect(startSelection(["a", "b", "c"], { id: "c", index: 0, focus: true })).toEqual({
      index: 2,
      focus: true,
    });
  });
  test("a row that left keeps its place, clamped", () => {
    expect(startSelection(["b", "c"], { id: "a", index: 0, focus: true })).toEqual({
      index: 0,
      focus: true,
    });
    expect(startSelection(["a"], { id: "z", index: 5, focus: true })).toEqual({
      index: 0,
      focus: true,
    });
  });
  test("nothing kept starts at the top without taking focus", () => {
    expect(startSelection(["a"], null)).toEqual({ index: 0, focus: false });
    expect(startSelection([], { id: "a", index: 0, focus: true })).toEqual({
      index: 0,
      focus: false,
    });
  });
});
