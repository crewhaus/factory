import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AXE_TAGS } from "../a11y/axe";
import { type AxeReport, rowKey } from "../a11y/baseline";
import {
  GATED_TEMPLATES,
  GATE_EXPECTS,
  GATE_THEMES,
  GATE_WIDTHS,
  gateMessage,
  gateVerdict,
} from "../a11y/gate";
import { fleetRoutes, harnessRoutes, loadConsoleGrammar } from "../console-routes";

const report = (rows: AxeReport["rows"]): AxeReport => ({
  schema: 1,
  axe: "4.14.0",
  tags: [...AXE_TAGS],
  rows,
});

/** Every gated row, empty. */
function cleanRows(templates: readonly string[]): Record<string, Record<string, number>> {
  const rows: Record<string, Record<string, number>> = {};
  for (const template of templates) {
    for (const theme of GATE_THEMES) {
      for (const width of GATE_WIDTHS) rows[rowKey(template, theme, width)] = {};
    }
  }
  return rows;
}

describe("gateVerdict", () => {
  test("a clean report passes", () => {
    expect(gateVerdict(report(cleanRows(GATED_TEMPLATES)), GATED_TEMPLATES)).toEqual({
      failures: [],
      missing: [],
    });
  });

  test("one node of any rule on any gated row fails, and is named", () => {
    for (const rule of [
      "color-contrast",
      "target-size",
      "scrollable-region-focusable",
      "made-up",
    ]) {
      const rows = cleanRows(GATED_TEMPLATES);
      rows[rowKey("#/h/:id/spec", "light", 320)] = { [rule]: 1 };
      const verdict = gateVerdict(report(rows), GATED_TEMPLATES);
      expect(verdict.failures).toEqual([
        { template: "#/h/:id/spec", theme: "light", width: 320, rule, count: 1 },
      ]);
      expect(verdict.missing).toEqual([]);
    }
  });

  test("a row outside the gate never fails it", () => {
    const rows = cleanRows(GATED_TEMPLATES);
    rows[rowKey("#/runs", "dark", 1280)] = { "color-contrast": 40 };
    expect(gateVerdict(report(rows), GATED_TEMPLATES).failures).toEqual([]);
  });

  test("a gated template without a width or a theme is missing, not passed", () => {
    const rows = cleanRows(GATED_TEMPLATES);
    Reflect.deleteProperty(rows, rowKey("#/approvals", "dark", 320));
    Reflect.deleteProperty(rows, rowKey("#/settings", "light", 1280));
    expect(gateVerdict(report(rows), GATED_TEMPLATES).missing).toEqual([
      "#/approvals dark 320",
      "#/settings light 1280",
    ]);
  });

  test("the verdict takes no parameter that could exempt a rule or a node", () => {
    expect(gateVerdict.length).toBe(2);
  });

  test("the message names the template, theme, width, rule and samples", () => {
    const rows = cleanRows(["#/"]);
    rows[rowKey("#/", "dark", 320)] = { "target-size": 2 };
    const verdict = gateVerdict(report(rows), ["#/"]);
    const message = gateMessage(verdict, {
      [rowKey("#/", "dark", 320)]: { "target-size": [".chip", "a.pin"] },
    });
    expect(message).toContain("#/ dark 320: target-size on 2 nodes (.chip, a.pin)");
  });
});

describe("the gated screens", () => {
  test("are exactly the thirteen retrofitted templates", () => {
    expect([...GATED_TEMPLATES]).toEqual([
      "#/",
      "#/approvals",
      "#/review",
      "#/activity",
      "#/advisor",
      "#/h/:id/advisor",
      "#/settings",
      "#/h/:id/overview",
      "#/h/:id/costs",
      "#/h/:id/spec",
      "#/h/:id/memory",
      "#/thredz",
      "#/h/:id/thredz",
    ]);
    expect(new Set(GATED_TEMPLATES).size).toBe(13);
  });

  test("each is a template the real route grammar produces", async () => {
    const grammar = await loadConsoleGrammar();
    const known = new Set(
      [...fleetRoutes(grammar), ...harnessRoutes(grammar, "x")].map((r) => r.template),
    );
    for (const template of GATED_TEMPLATES) {
      expect(`${template}:${known.has(template)}`).toBe(`${template}:true`);
    }
  });

  test("each says what must be on it before axe runs, and nothing else is listed", () => {
    expect(Object.keys(GATE_EXPECTS).sort()).toEqual([...GATED_TEMPLATES].sort());
    for (const selector of Object.values(GATE_EXPECTS)) expect(selector.trim()).not.toBe("");
  });

  test("the committed baseline holds every gated row, empty", () => {
    const baseline = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "axe-baseline.json"), "utf8"),
    ) as AxeReport;
    const verdict = gateVerdict(baseline, GATED_TEMPLATES);
    expect(verdict).toEqual({ failures: [], missing: [] });
  });
});

describe("axe itself", () => {
  test("runs every rule of its tags: nothing narrows it instead of fixing a screen", () => {
    const source = readFileSync(join(import.meta.dir, "..", "a11y", "axe.ts"), "utf8");
    // The one place axe is configured, and the count this guard expects to scan.
    expect(source.match(/axe\.run\(/g)?.length).toBe(1);
    expect(source).not.toContain("exclude");
    expect(source).not.toContain("rules:");
    expect(source).not.toContain("disableOtherRules");
    expect(source).toContain('runOnly: { type: "tag", values: tags }');
  });
});
