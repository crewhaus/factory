/**
 * HM-179 — the plugin SDK's minimal wiring.
 *
 * The item's whole value is honesty about WHICH points are wired, so the
 * assertions below are as much about the deferred pair as about the live
 * one: `onSpecLoad` and `onEvalSampleRendered` must be reported declared,
 * not wired, and carry the reason. The rest is containment — the sandbox
 * token list, the fail-closed CSP, and the filesystem permission that
 * decides whether a plugin sees a harness at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import {
  DEFERRED_EXTENSION_POINTS,
  PANE_SANDBOX,
  WIRED_EXTENSION_POINTS,
  classifyExtensionPoints,
  panePolicy,
  panesForHarness,
  pluginMayFetch,
  pluginSeesHarness,
  readPaneDecls,
  readPaneDocument,
  readPluginInventory,
  traceObservers,
} from "./plugins";
import { bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

type PluginFixture = {
  readonly name: string;
  readonly manifest: Record<string, unknown>;
  readonly files?: Readonly<Record<string, string>>;
};

function makePluginsDir(root: string, plugins: readonly PluginFixture[]): string {
  const dir = join(root, "plugins");
  mkdirSync(dir, { recursive: true });
  for (const plugin of plugins) {
    const pdir = join(dir, plugin.name);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "plugin.json"), JSON.stringify(plugin.manifest, null, 2));
    for (const [file, body] of Object.entries(plugin.files ?? {})) {
      writeFileSync(join(pdir, file), body);
    }
  }
  return dir;
}

describe("extension points", () => {
  test("exactly two are wired, and the deferred pair is reported with its reason", () => {
    expect([...WIRED_EXTENSION_POINTS]).toEqual(["onTraceEvent", "panes"]);
    expect(Object.keys(DEFERRED_EXTENSION_POINTS).sort()).toEqual([
      "onEvalSampleRendered",
      "onSpecLoad",
    ]);

    const points = classifyExtensionPoints({
      onTraceEvent: true,
      onSpecLoad: true,
      onEvalSampleRendered: true,
      panes: [{ id: "p", title: "P", file: "p.html" }],
    });
    const byName = new Map(points.map((p) => [p.point, p]));
    expect(byName.get("onTraceEvent")).toMatchObject({ declared: true, wired: true });
    expect(byName.get("panes")).toMatchObject({ declared: true, wired: true });
    // Declared and NOT wired — the row an operator must be able to see.
    expect(byName.get("onSpecLoad")).toMatchObject({ declared: true, wired: false });
    expect(String(byName.get("onSpecLoad")?.reason)).toContain("deferred");
    expect(byName.get("onEvalSampleRendered")).toMatchObject({ declared: true, wired: false });
  });

  test("a manifest declaring nothing reports every point undeclared", () => {
    for (const point of classifyExtensionPoints({})) {
      expect(`${point.point}:${point.declared}`).toBe(`${point.point}:false`);
    }
  });
});

describe("readPaneDecls", () => {
  test("keeps well-formed panes and drops anything unservable", () => {
    const panes = readPaneDecls({
      panes: [
        { id: "costs", title: "Costs", file: "costs.html" },
        { id: "no-file", title: "x" },
        { id: "../escape", title: "x", file: "a.html" },
        { id: "traverse", title: "x", file: "../../etc/passwd" },
        { id: "not-html", title: "x", file: "script.js" },
      ],
    });
    expect(panes.map((p) => p.id)).toEqual(["costs"]);
  });

  test("a missing title falls back to the id", () => {
    expect(readPaneDecls({ panes: [{ id: "x", file: "x.html" }] })[0]?.title).toBe("x");
  });
});

describe("the pane sandbox and CSP are fail-closed", () => {
  test("the sandbox never grants same-origin alongside scripts", () => {
    expect(PANE_SANDBOX).toBe("allow-scripts");
    expect(PANE_SANDBOX).not.toContain("allow-same-origin");
  });

  test("no net permission ⇒ connect-src 'none' and nothing else may load", () => {
    const { csp, connectSrc } = panePolicy(undefined);
    expect(connectSrc).toEqual([]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  test("declared origins reach connect-src; a glob is narrowed to its origin", () => {
    const { csp, connectSrc } = panePolicy({
      net: ["fetch:https://api.example.test/**", "fetch:https://api.example.test/v2/*", "read:x"],
    });
    expect(connectSrc).toEqual(["https://api.example.test"]);
    expect(csp).toContain("connect-src https://api.example.test");
    // The per-URL decision still belongs to the loader's own evaluator.
    expect(
      pluginMayFetch({ net: ["fetch:https://api.example.test/**"] }, "https://evil.test/x"),
    ).toBe(false);
    expect(
      pluginMayFetch({ net: ["fetch:https://api.example.test/**"] }, "https://api.example.test/v1"),
    ).toBe(true);
  });
});

describe("pluginSeesHarness", () => {
  test("fail-closed: no fs permission means no visibility", () => {
    expect(pluginSeesHarness(undefined, "/h/one")).toBe(false);
    expect(pluginSeesHarness({}, "/h/one")).toBe(false);
    expect(pluginSeesHarness({ fs: [] }, "/h/one")).toBe(false);
    // A WRITE grant is not a read grant.
    expect(pluginSeesHarness({ fs: ["write:/h/**"] }, "/h/one")).toBe(false);
  });

  test("a read glob covering the harness grants visibility; another harness does not", () => {
    expect(pluginSeesHarness({ fs: ["read:/h/**"] }, "/h/one")).toBe(true);
    expect(pluginSeesHarness({ fs: ["read:/other/**"] }, "/h/one")).toBe(false);
  });
});

describe("readPluginInventory", () => {
  test("reads manifests, never imports code, and surfaces broken entries with their problem", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-plugins-"));
    try {
      const dir = makePluginsDir(root, [
        {
          name: "cost-lens",
          manifest: {
            name: "cost-lens",
            version: "1.0.0",
            description: "spend, per pane",
            onTraceEvent: true,
            panes: [{ id: "spend", title: "Spend", file: "spend.html" }],
            permissions: { fs: ["read:/h/**"], net: ["fetch:https://api.example.test/**"] },
          },
          files: { "spend.html": "<p>spend</p>" },
        },
        { name: "broken", manifest: { version: "1.0.0" } as Record<string, unknown> },
      ]);
      // A directory with no manifest at all.
      mkdirSync(join(dir, "empty-dir"), { recursive: true });
      // An executable that must never be run by discovery.
      writeFileSync(join(dir, "cost-lens", "index.js"), "throw new Error('never imported');\n");

      const inventory = readPluginInventory(dir);
      const byName = new Map(inventory.plugins.map((p) => [p.name, p]));
      expect(byName.get("cost-lens")?.panes.map((p) => p.id)).toEqual(["spend"]);
      expect(byName.get("cost-lens")?.permissions.fs).toEqual(["read:/h/**"]);
      expect(byName.get("broken")?.problems[0]).toContain("no name");
      expect(byName.get("empty-dir")?.problems[0]).toContain("no plugin.json");
      expect(inventory.wired).toEqual([...WIRED_EXTENSION_POINTS]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absent plugins directory is an empty inventory, not an error", () => {
    expect(readPluginInventory("/no/such/dir").plugins).toEqual([]);
  });
});

describe("panes and trace observers are gated by the same permission", () => {
  test("a plugin that may not read the harness neither draws a pane nor observes it", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-plugins-"));
    try {
      const dir = makePluginsDir(root, [
        {
          name: "allowed",
          manifest: {
            name: "allowed",
            version: "1.0.0",
            onTraceEvent: true,
            panes: [{ id: "a", title: "A", file: "a.html" }],
            permissions: { fs: ["read:/h/**"] },
          },
          files: { "a.html": "<p>a</p>" },
        },
        {
          name: "denied",
          manifest: {
            name: "denied",
            version: "1.0.0",
            onTraceEvent: true,
            panes: [{ id: "b", title: "B", file: "b.html" }],
            permissions: { fs: ["read:/elsewhere/**"] },
          },
          files: { "b.html": "<p>b</p>" },
        },
      ]);
      const plugins = readPluginInventory(dir).plugins;
      expect(panesForHarness(plugins, "/h/one").map((p) => p.plugin)).toEqual(["allowed"]);
      expect(traceObservers(plugins, "/h/one")).toEqual(["allowed"]);
      expect(panesForHarness(plugins, "/h/one")[0]?.sandbox).toBe(PANE_SANDBOX);
      expect(traceObservers(plugins, "/nowhere/near")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readPaneDocument", () => {
  test("serves the declared document with its sandbox and CSP attached", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-plugins-"));
    try {
      const dir = makePluginsDir(root, [
        {
          name: "p",
          manifest: {
            name: "p",
            version: "1.0.0",
            panes: [{ id: "a", title: "A", file: "a.html" }],
            permissions: { fs: ["read:/h/**"] },
          },
          files: { "a.html": "<p>hello</p>" },
        },
      ]);
      const plugin = readPluginInventory(dir).plugins[0];
      expect(plugin).toBeDefined();
      const doc = readPaneDocument(plugin as NonNullable<typeof plugin>, "a");
      expect(doc?.doc).toBe("<p>hello</p>");
      expect(doc?.sandbox).toBe(PANE_SANDBOX);
      expect(doc?.csp).toContain("connect-src 'none'");
      expect(readPaneDocument(plugin as NonNullable<typeof plugin>, "nope")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pane file that symlinks out of the plugin directory is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-plugins-"));
    try {
      const secret = join(root, "outside.html");
      writeFileSync(secret, "<p>not the plugin's</p>");
      const dir = makePluginsDir(root, [
        {
          name: "p",
          manifest: {
            name: "p",
            version: "1.0.0",
            panes: [{ id: "a", title: "A", file: "a.html" }],
          },
        },
      ]);
      symlinkSync(secret, join(dir, "p", "a.html"));
      const plugin = readPluginInventory(dir).plugins[0];
      expect(readPaneDocument(plugin as NonNullable<typeof plugin>, "a")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GET /api/plugins, /api/plugins/:name/panes/:paneId and /api/h/:id/panes", () => {
  test("the routes report the wiring, the panes and the deferred pair", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "hangar-plugins-route-"));
    // A read glob that covers nothing this server registers: the plugin is
    // installed and visible in the inventory, but it draws no pane and
    // observes no harness.
    const pluginsDir = makePluginsDir(scratch, [
      {
        name: "cost-lens",
        manifest: {
          name: "cost-lens",
          version: "1.0.0",
          onTraceEvent: true,
          onSpecLoad: true,
          panes: [{ id: "spend", title: "Spend", file: "spend.html" }],
          permissions: { fs: ["read:/nowhere-near-this-machine/**"] },
        },
        files: { "spend.html": "<p>spend</p>" },
      },
    ]);
    const t = bootTestServer({ now: () => NOW, pluginsDir });
    try {
      const dir = join(t.harnessesRoot, "paned");
      makeFixtureHarness(dir, { specName: "paned" });
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;

      const inventory = await t.api("/api/plugins");
      expect(inventory.status).toBe(200);
      const plugins = inventory.body["plugins"] as Array<{
        name: string;
        extensionPoints: Array<{ point: string; wired: boolean; reason: string | null }>;
      }>;
      const points = plugins[0]?.extensionPoints ?? [];
      expect(points.find((p) => p.point === "onSpecLoad")?.wired).toBe(false);
      expect(String(points.find((p) => p.point === "onSpecLoad")?.reason)).toContain("deferred");
      expect(points.find((p) => p.point === "onTraceEvent")?.wired).toBe(true);

      const doc = await t.api("/api/plugins/cost-lens/panes/spend");
      expect(doc.status).toBe(200);
      expect(doc.body["sandbox"]).toBe(PANE_SANDBOX);
      expect(String(doc.body["csp"])).toContain("default-src 'none'");
      expect((await t.api("/api/plugins/cost-lens/panes/missing")).status).toBe(404);
      expect((await t.api("/api/plugins/nope/panes/spend")).status).toBe(404);

      const panes = await t.api(`/api/h/${id}/panes`);
      expect(panes.status).toBe(200);
      expect(panes.body["panes"]).toEqual([]);
      expect(panes.body["traceObservers"]).toEqual([]);
      expect(Object.keys(panes.body["deferred"] as object).sort()).toEqual([
        "onEvalSampleRendered",
        "onSpecLoad",
      ]);
    } finally {
      await t.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  test("a plugin whose read glob covers the harness gets its pane on that harness", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "hangar-plugins-route2-"));
    const pluginsDir = makePluginsDir(scratch, [
      { name: "cost-lens", manifest: { name: "cost-lens", version: "1.0.0" } },
    ]);
    const t = bootTestServer({ now: () => NOW, pluginsDir });
    try {
      const dir = join(t.harnessesRoot, "paned");
      makeFixtureHarness(dir, { specName: "paned" });
      // The glob is written against THIS server's temp harness root, which
      // only exists once the server has been booted.
      writeFileSync(
        join(pluginsDir, "cost-lens", "plugin.json"),
        JSON.stringify({
          name: "cost-lens",
          version: "1.0.0",
          onTraceEvent: true,
          panes: [{ id: "spend", title: "Spend", file: "spend.html" }],
          permissions: { fs: [`read:${t.harnessesRoot}/**`] },
        }),
      );
      writeFileSync(join(pluginsDir, "cost-lens", "spend.html"), "<p>spend</p>");
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;
      const panes = await t.api(`/api/h/${id}/panes`);
      const rows = panes.body["panes"] as Array<{ plugin: string; id: string; sandbox: string }>;
      expect(rows.map((r) => `${r.plugin}/${r.id}`)).toEqual(["cost-lens/spend"]);
      expect(rows[0]?.sandbox).toBe(PANE_SANDBOX);
      expect(panes.body["traceObservers"]).toEqual(["cost-lens"]);
    } finally {
      await t.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("pane scoping speaks the glob's alphabet on both sides", () => {
  // Provable on ANY platform: feed the Windows-shaped strings directly.
  // `matchesGlob` defines `*`/`**` over `/`, so a backslash target OR a
  // backslash pattern matches nothing — and the failure is silent (no pane),
  // which is why it survived until a Windows runner existed.
  test("a backslash target and a backslash pattern both still match", () => {
    const winDir = "C:\\Users\\op\\harnesses\\paned";
    const winRoot = "C:\\Users\\op\\harnesses";
    expect(pluginSeesHarness({ fs: [`read:${winRoot}/**`] }, winDir)).toBe(true);
    expect(pluginSeesHarness({ fs: [`read:${winRoot}\\**`] }, winDir)).toBe(true);
    expect(pluginSeesHarness({ fs: ["read:C:/Users/op/harnesses/**"] }, winDir)).toBe(true);
    // …and a plugin scoped elsewhere still gets nothing.
    expect(pluginSeesHarness({ fs: ["read:C:\\Users\\other\\**"] }, winDir)).toBe(false);
    // POSIX behaviour is unchanged.
    expect(pluginSeesHarness({ fs: ["read:/h/**"] }, "/h/one")).toBe(true);
    expect(pluginSeesHarness({ fs: ["read:/other/**"] }, "/h/one")).toBe(false);
  });
});
