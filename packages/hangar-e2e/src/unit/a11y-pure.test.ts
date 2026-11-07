import { describe, expect, test } from "bun:test";
import { unnamedControls } from "../a11y/aria";
import { contrastRatio, focusStyleFinding } from "../a11y/keyboard";

describe("contrastRatio", () => {
  test("black on white is 21:1, either way round", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBeCloseTo(21, 5);
    expect(contrastRatio("rgb(255, 255, 255)", "rgb(0, 0, 0)")).toBeCloseTo(21, 5);
  });

  test("a colour against itself is 1:1", () => {
    expect(contrastRatio("rgb(120, 120, 120)", "rgb(120, 120, 120)")).toBeCloseTo(1, 5);
  });

  test("an unreadable colour is undetermined, not zero", () => {
    expect(contrastRatio("oklch(0.5 0.1 200)", "rgb(0, 0, 0)")).toBeUndefined();
  });
});

describe("focusStyleFinding", () => {
  const ring = {
    tag: "button",
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineColor: "rgb(0, 0, 0)",
    boxShadow: "none",
    background: "rgb(255, 255, 255)",
  };

  test("a ring with contrast is fine", () => {
    expect(focusStyleFinding(ring)).toBeUndefined();
  });

  test("no outline at all is not visible", () => {
    expect(focusStyleFinding({ ...ring, outlineStyle: "none" })?.rule).toBe("focus-not-visible");
    expect(focusStyleFinding({ ...ring, outlineWidth: 0 })?.rule).toBe("focus-not-visible");
  });

  test("a ring without contrast is not visible", () => {
    const finding = focusStyleFinding({ ...ring, outlineColor: "rgb(250, 250, 250)" });
    expect(finding?.rule).toBe("focus-not-visible");
    expect(finding?.detail).toContain(":1");
  });

  test("a box shadow is an indicator", () => {
    const shadow = { ...ring, outlineStyle: "none", boxShadow: "rgb(0, 0, 0) 0px 0px 0px 2px" };
    expect(focusStyleFinding(shadow)).toBeUndefined();
  });

  test("a colour it cannot read says so, rather than passing", () => {
    expect(focusStyleFinding({ ...ring, outlineColor: "color(srgb 0 0 0)" })?.rule).toBe(
      "focus-undetermined",
    );
  });
});

describe("unnamedControls", () => {
  test("a control with no name is a finding, one per control", () => {
    const snapshot = [
      "- main:",
      "  - button",
      '  - button "Save"',
      "  - link:",
      "  - textbox",
    ].join("\n");
    expect(unnamedControls(snapshot).map((finding) => finding.detail)).toEqual([
      "a button",
      "a link",
      "a textbox",
    ]);
  });

  test("named controls and other roles are nothing", () => {
    const snapshot = ['- heading "Title" [level=1]', '- button "Save"', '- link "Home":', "- img"];
    expect(unnamedControls(snapshot.join("\n"))).toEqual([]);
  });
});
