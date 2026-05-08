import { describe, expect, test } from "bun:test";
import { getStudioJs, renderMultiSpecDashboard, renderStudioHtml } from "./index.js";

describe("studio-ui (T1)", () => {
  test("renderStudioHtml emits a complete HTML document with the three nav tabs", () => {
    const html = renderStudioHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>CrewHaus Studio</title>");
    expect(html).toContain('id="tab-specs"');
    expect(html).toContain('id="tab-wizard"');
    expect(html).toContain('id="tab-plugins"');
  });

  test("renderStudioHtml supports a custom title", () => {
    const html = renderStudioHtml({ title: "Custom Title" });
    expect(html).toContain("<title>Custom Title</title>");
  });

  test("getStudioJs is callable + non-empty + references all three views", () => {
    const js = getStudioJs();
    expect(js.length).toBeGreaterThan(500);
    expect(js).toContain("renderSpecs");
    expect(js).toContain("renderWizard");
    expect(js).toContain("renderPlugins");
    expect(js).toContain("/api/specs");
    expect(js).toContain("/api/wizard/start");
    expect(js).toContain("/api/plugins");
  });
});

describe("studio-ui v1 — Section 31 multi-spec dashboard", () => {
  test("empty rows → empty-state message", () => {
    const html = renderMultiSpecDashboard([]);
    expect(html).toContain("No specs registered");
  });

  test("dashboard sorts rows alphabetically by spec name", () => {
    const html = renderMultiSpecDashboard([
      { specName: "z-spec", costUsdMicros: 1000, runCount: 1 },
      { specName: "a-spec", costUsdMicros: 500, runCount: 1 },
    ]);
    const aIdx = html.indexOf("a-spec");
    const zIdx = html.indexOf("z-spec");
    expect(aIdx).toBeLessThan(zIdx);
  });

  test("dashboard renders cost in dollars with 4 decimals", () => {
    const html = renderMultiSpecDashboard([{ specName: "x", costUsdMicros: 12_345, runCount: 3 }]);
    expect(html).toContain("$0.0123");
  });

  test("dashboard renders pass-rate as percentage when present", () => {
    const html = renderMultiSpecDashboard([
      { specName: "x", costUsdMicros: 0, passRate: 0.95, runCount: 1 },
    ]);
    expect(html).toContain("95.0%");
  });

  test("dashboard renders em-dash for missing eval data", () => {
    const html = renderMultiSpecDashboard([{ specName: "x", costUsdMicros: 0, runCount: 0 }]);
    expect(html).toContain("—");
  });

  test("dashboard escapes spec name HTML special chars", () => {
    const html = renderMultiSpecDashboard([
      { specName: "evil<script>", costUsdMicros: 0, runCount: 0 },
    ]);
    expect(html).toContain("evil&lt;script&gt;");
    expect(html).not.toContain("evil<script>");
  });
});
