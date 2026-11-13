import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AXE_TAGS } from "../a11y/axe";
import { type AxeReport, rowKey } from "../a11y/baseline";
import {
  GATE_EXPECTS,
  GATE_THEMES,
  GATE_WIDTHS,
  TOURED_TEMPLATES,
  gateMessage,
  gateVerdict,
  gatedTemplates,
} from "../a11y/gate";
import { loadConsoleGrammar, routeFor } from "../console-routes";

const grammar = await loadConsoleGrammar();
const GATED = await gatedTemplates();
const entry = import.meta.resolve("@crewhaus/hangar-ui");
const { ROUTE_TEMPLATES, parseRoute } = (await import(
  new URL("../assets/js/router.js", entry).href
)) as { ROUTE_TEMPLATES: readonly string[]; parseRoute(hash: string): { view: string } };

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

/** A harness as the seed writes one. */
const SEEDED = {
  id: "hrn_0123456789abcdef",
  runId: "run_0123456789abcdef",
  sessionIds: ["sess_0123456789abcdef"],
  wikiSlug: "getting-started",
};

describe("gateVerdict", () => {
  test("a clean report passes", () => {
    expect(gateVerdict(report(cleanRows(GATED)), GATED)).toEqual({ failures: [], missing: [] });
  });

  test("one node of any rule on any row fails, and is named", () => {
    for (const rule of [
      "color-contrast",
      "target-size",
      "scrollable-region-focusable",
      "made-up",
    ]) {
      const rows = cleanRows(GATED);
      rows[rowKey("#/h/:id/setup/spec", "light", 320)] = { [rule]: 1 };
      const verdict = gateVerdict(report(rows), GATED);
      expect(verdict.failures).toEqual([
        { template: "#/h/:id/setup/spec", theme: "light", width: 320, rule, count: 1 },
      ]);
      expect(verdict.missing).toEqual([]);
    }
  });

  test("a template without a width or a theme is missing, not passed", () => {
    const rows = cleanRows(GATED);
    Reflect.deleteProperty(rows, rowKey("#/home/working", "dark", 320));
    Reflect.deleteProperty(rows, rowKey("#/settings", "light", 1280));
    expect(gateVerdict(report(rows), GATED).missing).toEqual([
      "#/home/working dark 320",
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

describe("the gate is every route", () => {
  test("it is the router's own route templates, all of them", () => {
    expect(GATED).toBe(ROUTE_TEMPLATES);
    expect(GATED.length).toBeGreaterThanOrEqual(40);
    expect(new Set(GATED).size).toBe(GATED.length);
  });

  test("each route says what must be on it before axe runs, and nothing else is listed", () => {
    expect(Object.keys(GATE_EXPECTS).sort()).toEqual([...GATED].sort());
    for (const [template, selector] of Object.entries(GATE_EXPECTS)) {
      expect(`${template}:${selector.trim() !== ""}`).toBe(`${template}:true`);
      // A heading alone is not content.
      expect(`${template}:${/^(h1|#page-title|\.page-title)$/.test(selector.trim())}`).toBe(
        `${template}:false`,
      );
    }
  });

  test("every template is producible from a seeded harness, and lands on a screen", () => {
    for (const template of GATED) {
      const route = routeFor(template, SEEDED);
      expect(`${template}:${parseRoute(route).view === "notfound"}`).toBe(`${template}:false`);
    }
  });

  test("the toured screens are thirteen of them, each a route the gate holds", () => {
    expect(TOURED_TEMPLATES.length).toBe(13);
    expect(new Set(TOURED_TEMPLATES).size).toBe(13);
    for (const template of TOURED_TEMPLATES) {
      expect(`${template}:${GATED.includes(template)}`).toBe(`${template}:true`);
    }
  });

  test("there is no baseline file and no allow-list to fall back on", () => {
    const pkg = join(import.meta.dir, "..", "..");
    expect(() => readFileSync(join(pkg, "axe-baseline.json"), "utf8")).toThrow();
    const gate = readFileSync(join(import.meta.dir, "..", "a11y", "gate.ts"), "utf8");
    for (const word of ["allow", "exempt", "skip", "baseline"]) {
      expect(`${word}:${new RegExp(`export const \\w*${word}`, "i").test(gate)}`).toBe(
        `${word}:false`,
      );
    }
    expect(grammar.templates).toBe(GATED);
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
