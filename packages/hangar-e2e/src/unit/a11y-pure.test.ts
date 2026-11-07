import { describe, expect, test } from "bun:test";
import { unnamedControls } from "../a11y/aria";
import { contrastRatio, focusStyleFinding, trapVerdict } from "../a11y/keyboard";

describe("contrastRatio", () => {
  test("black on white is 21:1, either way round", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBeCloseTo(21, 5);
    expect(contrastRatio("rgb(255, 255, 255)", "rgb(0, 0, 0)")).toBeCloseTo(21, 5);
  });

  test("a colour against itself is 1:1", () => {
    expect(contrastRatio("rgb(120, 120, 120)", "rgb(120, 120, 120)")).toBeCloseTo(1, 5);
  });

  test("alpha counts: a transparent colour is 1:1, and a faint one barely more", () => {
    expect(contrastRatio("rgba(0, 0, 0, 0)", "rgb(255, 255, 255)")).toBeCloseTo(1, 5);
    const faint = contrastRatio("rgba(0, 0, 0, 0.1)", "rgb(255, 255, 255)") ?? 0;
    expect(faint).toBeGreaterThan(1);
    expect(faint).toBeLessThan(1.5);
    expect(contrastRatio("rgb(0 0 0 / 0.5)", "rgb(255, 255, 255)")).toBeLessThan(21);
  });

  test("a translucent background is read over white", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgba(0, 0, 0, 0)")).toBeCloseTo(21, 5);
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
    unfocusedBoxShadow: "none",
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

  test.each([
    ["transparent", "rgba(0, 0, 0, 0)"],
    ["10% alpha", "rgba(0, 0, 0, 0.1)"],
  ])("a %s ring cannot be seen", (_name, outlineColor) => {
    expect(focusStyleFinding({ ...ring, outlineColor })?.rule).toBe("focus-not-visible");
  });

  test("a shadow that was there without focus is no indicator", () => {
    const decorative = "rgb(0, 0, 0) 0px 1px 3px 0px";
    const style = {
      ...ring,
      outlineStyle: "none",
      boxShadow: decorative,
      unfocusedBoxShadow: decorative,
    };
    expect(focusStyleFinding(style)?.rule).toBe("focus-not-visible");
    // And a good ring on such a control is still a good ring.
    expect(
      focusStyleFinding({ ...ring, boxShadow: decorative, unfocusedBoxShadow: decorative }),
    ).toBeUndefined();
  });

  test("a layer focus adds to a decorative shadow is an indicator", () => {
    const decorative = "rgba(0, 0, 0, 0.2) 0px 1px 3px 0px";
    expect(
      focusStyleFinding({
        ...ring,
        outlineStyle: "none",
        boxShadow: `rgb(0, 0, 0) 0px 0px 0px 2px, ${decorative}`,
        unfocusedBoxShadow: decorative,
      }),
    ).toBeUndefined();
  });

  test.each([
    ["transparent", "rgba(0, 0, 0, 0) 0px 0px 0px 2px"],
    ["faint", "rgba(0, 0, 0, 0.1) 0px 0px 0px 2px"],
    ["zero-sized", "rgb(0, 0, 0) 0px 0px 0px 0px"],
  ])("a %s shadow added on focus cannot be seen", (_name, boxShadow) => {
    expect(focusStyleFinding({ ...ring, outlineStyle: "none", boxShadow })?.rule).toBe(
      "focus-not-visible",
    );
  });

  test("a shadow colour it cannot read says so, rather than passing", () => {
    const boxShadow = "oklch(0.5 0.1 200) 0px 0px 0px 2px";
    expect(focusStyleFinding({ ...ring, outlineStyle: "none", boxShadow })?.rule).toBe(
      "focus-undetermined",
    );
  });

  test("a colour it cannot read says so, rather than passing", () => {
    expect(focusStyleFinding({ ...ring, outlineColor: "color(srgb 0 0 0)" })?.rule).toBe(
      "focus-undetermined",
    );
  });
});

describe("trapVerdict", () => {
  test("focus that leaves the page after every stop is no trap", () => {
    expect(trapVerdict(["a", "b", null], 2)).toBeUndefined();
    expect(trapVerdict(["a", null], 1)).toBeUndefined();
  });

  test("Tab leaving focus where it was is a trap, on the last or the only control", () => {
    expect(trapVerdict(["a", "b", "b"], 2)?.detail).toBe("Tab stayed on b");
    expect(trapVerdict(["a", "a"], 1)?.detail).toBe("Tab stayed on a");
    expect(trapVerdict(["a", "a"], 3)?.rule).toBe("keyboard-trap");
  });

  test("coming round without reaching every stop is a trap", () => {
    expect(trapVerdict(["a", "b", "a"], 3)?.detail).toBe("Tab reached 2 of 3 controls");
  });

  test("a stop the count missed is not a finding", () => {
    expect(trapVerdict(["a", "region", "b", null], 2)).toBeUndefined();
  });

  test("the same control after leaving the page is coming round, not a trap", () => {
    expect(trapVerdict(["a", null, "a"], 1)).toBeUndefined();
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
