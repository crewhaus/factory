/**
 * HM-179 — the plugin SDK's minimal wiring.
 *
 * The item's whole value is honesty about WHICH points are wired, so the
 * assertions below are as much about the deferred pair as about the live
 * one: `onSpecLoad` and `onEvalSampleRendered` must be reported declared,
 * not wired, and carry the reason. The rest is containment — the sandbox
 * token list, the fail-closed CSP — and serving: a pane, a trace and a
 * pane's network reach come only from what the plugin's owner granted
 * (`plugin-grants.test.ts` holds the ledger side).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginGrantSet } from "@crewhaus/control-contract";
import { makeFixtureHarness } from "./fixture";
import { SERVED_NOTHING, grantPlugin } from "./plugin-grants";
import {
  DEFERRED_EXTENSION_POINTS,
  PANE_SANDBOX,
  type ServedPlugin,
  WIRED_EXTENSION_POINTS,
  classifyExtensionPoints,
  netOriginsOf,
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

  test("no origin served ⇒ connect-src 'none' and nothing else may load", () => {
    const { csp, connectSrc } = panePolicy([]);
    expect(connectSrc).toEqual([]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  test("a manifest's net globs ask for their origins; served origins reach connect-src", () => {
    expect(
      netOriginsOf([
        "fetch:https://api.example.test/**",
        "fetch:https://api.example.test/v2/*",
        "fetch:https://*.wild.test/**",
        "read:x",
      ]),
    ).toEqual(["https://api.example.test"]);
    const { csp, connectSrc } = panePolicy(["https://api.example.test"]);
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

describe("pluginSeesHarness (the harnesses a review prefills)", () => {
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

/** A served view: nothing, then these fields. */
const servedSet = (over: Partial<PluginGrantSet>): PluginGrantSet => ({
  ...SERVED_NOTHING,
  ...over,
});

describe("panes and trace observers come from the served view", () => {
  test("only what is served on that harness: its panes, and run.trace for an observer", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-plugins-"));
    try {
      const dir = makePluginsDir(root, [
        {
          name: "allowed",
          manifest: {
            name: "allowed",
            version: "1.0.0",
            onTraceEvent: true,
            panes: [
              { id: "a", title: "A", file: "a.html" },
              { id: "a2", title: "A2", file: "a2.html" },
            ],
            permissions: { fs: ["read:/h/**"] },
          },
        },
        {
          name: "ungranted",
          manifest: {
            name: "ungranted",
            version: "1.0.0",
            onTraceEvent: true,
            panes: [{ id: "b", title: "B", file: "b.html" }],
            // It asks to see every harness; asking is not a grant.
            permissions: { fs: ["read:/**"] },
          },
        },
      ]);
      const [allowed, ungranted] = readPluginInventory(dir).plugins as [
        ServedPlugin["plugin"],
        ServedPlugin["plugin"],
      ];
      const served: ServedPlugin[] = [
        {
          plugin: allowed,
          served: servedSet({ harnesses: ["hrn_a"], panes: ["a"], reads: ["run.trace"] }),
        },
        { plugin: ungranted, served: SERVED_NOTHING },
      ];
      expect(panesForHarness(served, "hrn_a").map((p) => `${p.plugin}/${p.pane.id}`)).toEqual([
        "allowed/a",
      ]);
      expect(panesForHarness(served, "hrn_a")[0]?.sandbox).toBe(PANE_SANDBOX);
      expect(traceObservers(served, "hrn_a")).toEqual(["allowed"]);
      expect(panesForHarness(served, "hrn_b")).toEqual([]);
      expect(traceObservers(served, "hrn_b")).toEqual([]);
      // A pane without run.trace observes nothing; "all" covers every harness.
      const panesOnly: ServedPlugin[] = [
        { plugin: allowed, served: servedSet({ harnesses: "all", panes: ["a", "a2"] }) },
      ];
      expect(traceObservers(panesOnly, "hrn_z")).toEqual([]);
      expect(panesForHarness(panesOnly, "hrn_z").map((p) => p.pane.id)).toEqual(["a", "a2"]);
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
      const p = plugin as NonNullable<typeof plugin>;
      const doc = readPaneDocument(p, "a", servedSet({ panes: ["a"] }));
      expect(doc?.doc).toBe("<p>hello</p>");
      expect(doc?.sandbox).toBe(PANE_SANDBOX);
      expect(doc?.csp).toContain("connect-src 'none'");
      expect(readPaneDocument(p, "nope", servedSet({ panes: ["a", "nope"] }))).toBeUndefined();
      // A pane the served view does not hold is never read.
      expect(readPaneDocument(p, "a", SERVED_NOTHING)).toBeUndefined();
      // The served origins, and only those, reach connect-src.
      const reaching = readPaneDocument(
        p,
        "a",
        servedSet({ panes: ["a"], net: ["https://api.example.test"] }),
      );
      expect(reaching?.csp).toContain("connect-src https://api.example.test;");
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
      expect(
        readPaneDocument(plugin as NonNullable<typeof plugin>, "a", servedSet({ panes: ["a"] })),
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GET /api/plugins, /api/plugins/:name/panes/:paneId and /api/h/:id/panes", () => {
  /** A manifest asking to see every harness under `root`, with a pane and an observer. */
  const costLens = (root: string) => ({
    name: "cost-lens",
    version: "1.0.0",
    onTraceEvent: true,
    onSpecLoad: true,
    panes: [{ id: "spend", title: "Spend", file: "spend.html" }],
    permissions: {
      fs: [`read:${root}/**`],
      net: ["fetch:https://api.example.test/**"],
    },
  });

  async function bootWithPlugin() {
    const scratch = mkdtempSync(join(tmpdir(), "hangar-plugins-route-"));
    const pluginsDir = makePluginsDir(scratch, [
      { name: "cost-lens", manifest: { name: "cost-lens", version: "1.0.0" } },
    ]);
    const t = bootTestServer({ now: () => NOW, pluginsDir });
    // The glob is written against THIS server's temp harness root, which only
    // exists once the server has been booted.
    writeFileSync(
      join(pluginsDir, "cost-lens", "plugin.json"),
      JSON.stringify(costLens(t.harnessesRoot)),
    );
    writeFileSync(join(pluginsDir, "cost-lens", "spend.html"), "<p>spend</p>");
    const add = async (name: string): Promise<string> => {
      const dir = join(t.harnessesRoot, name);
      makeFixtureHarness(dir, { specName: name });
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      return (added.body["entry"] as { id: string }).id;
    };
    const a = await add("paned-a");
    const b = await add("paned-b");
    const done = async () => {
      await t.stop();
      rmSync(scratch, { recursive: true, force: true });
    };
    return { t, pluginsDir, a, b, done };
  }

  test("with no grant: no pane, no observer, the document 404s, and the plugin waits", async () => {
    const { t, a, done } = await bootWithPlugin();
    try {
      const inventory = await t.api("/api/plugins");
      expect(inventory.status).toBe(200);
      const plugins = inventory.body["plugins"] as Array<{
        name: string;
        grant: { state: string; legacy: boolean };
        extensionPoints: Array<{ point: string; wired: boolean; reason: string | null }>;
      }>;
      expect(plugins[0]?.grant).toEqual({ state: "waiting", legacy: true });
      const points = plugins[0]?.extensionPoints ?? [];
      expect(points.find((p) => p.point === "onSpecLoad")?.wired).toBe(false);
      expect(String(points.find((p) => p.point === "onSpecLoad")?.reason)).toContain("deferred");
      expect(points.find((p) => p.point === "onTraceEvent")?.wired).toBe(true);

      const doc = await t.api("/api/plugins/cost-lens/panes/spend");
      expect(doc.status).toBe(404);
      expect(doc.body["error"]).toBe("no such pane");
      // An unknown plugin answers the same: nothing says what is installed.
      expect((await t.api("/api/plugins/nope/panes/spend")).body["error"]).toBe("no such pane");

      const panes = await t.api(`/api/h/${a}/panes`);
      expect(panes.status).toBe(200);
      expect(panes.body["panes"]).toEqual([]);
      expect(panes.body["traceObservers"]).toEqual([]);
      expect(panes.body["waiting"]).toEqual(["cost-lens"]);
      expect(Object.keys(panes.body["deferred"] as object).sort()).toEqual([
        "onEvalSampleRendered",
        "onSpecLoad",
      ]);
    } finally {
      await done();
    }
  }, 20_000);

  test("a grant on harness A serves its pane and trace on A only, and only the granted origins", async () => {
    const { t, pluginsDir, a, b, done } = await bootWithPlugin();
    try {
      const row = readPluginInventory(pluginsDir).plugins[0] as ServedPlugin["plugin"];
      const granted = await grantPlugin(t.hangarRoot, {
        row,
        grant: { ...SERVED_NOTHING, harnesses: [a], panes: ["spend"], reads: ["run.trace"] },
        by: "local:test",
        cmd: "cmd_test",
      });
      expect(granted.ok).toBe(true);
      const onA = await t.api(`/api/h/${a}/panes`);
      const rows = onA.body["panes"] as Array<{ plugin: string; id: string; sandbox: string }>;
      expect(rows.map((r) => `${r.plugin}/${r.id}`)).toEqual(["cost-lens/spend"]);
      expect(rows[0]?.sandbox).toBe(PANE_SANDBOX);
      expect(onA.body["traceObservers"]).toEqual(["cost-lens"]);
      expect(onA.body["waiting"]).toEqual([]);
      const onB = await t.api(`/api/h/${b}/panes`);
      expect(onB.body["panes"]).toEqual([]);
      expect(onB.body["traceObservers"]).toEqual([]);

      const doc = await t.api("/api/plugins/cost-lens/panes/spend");
      expect(doc.status).toBe(200);
      expect(doc.body["sandbox"]).toBe(PANE_SANDBOX);
      // The manifest asks for an origin; none was granted, so none is reachable.
      expect(String(doc.body["csp"])).toContain("connect-src 'none'");
      expect((await t.api("/api/plugins/cost-lens/panes/missing")).status).toBe(404);
      const plugins = (await t.api("/api/plugins")).body["plugins"] as Array<{
        grant: { state: string };
      }>;
      expect(plugins[0]?.grant.state).toBe("allowed");
    } finally {
      await done();
    }
  }, 20_000);

  test("the reads leave Home's root as they found it", async () => {
    const { t, a, done } = await bootWithPlugin();
    try {
      const before = listTree(t.hangarRoot);
      await t.api("/api/plugins");
      await t.api(`/api/h/${a}/panes`);
      await t.api("/api/plugins/cost-lens/panes/spend");
      expect(listTree(t.hangarRoot)).toEqual(before);
      expect(before.some((path) => path.startsWith("plugins"))).toBe(false);
    } finally {
      await done();
    }
  }, 20_000);
});

/** Every path under `root`, relative and sorted. */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      out.push(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk("");
  return out.sort();
}

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
