import { describe, expect, test } from "bun:test";
import { getStudioJs, renderStudioHtml } from "./index.js";

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
