import { describe, expect, test } from "bun:test";
import type { PluginMetadata } from "@crewhaus/module-marketplace-client";
import type { PluginManifest } from "@crewhaus/plugin-sdk";
import {
  MarketplaceCliError,
  type PublishDraftLike,
  buildPublishPrPlan,
  compareSemverCore,
  computeOutdated,
  createHttpModuleRegistrySource,
  createLocalModuleRegistrySource,
  formatOutdated,
  formatPluginList,
  installedVersions,
  resolveRegistryRef,
  toMetadata,
} from "./marketplace-cli";

/** A minimal valid plugin manifest for tests. */
function manifest(
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): PluginManifest {
  return { name, version, ...extra } as unknown as PluginManifest;
}

describe("resolveRegistryRef", () => {
  test("http url → http source", () => {
    expect(resolveRegistryRef("https://example.com/registry/", "plugin")).toEqual({
      kind: "http",
      baseUrl: "https://example.com/registry",
    });
  });

  test("file: prefix + relative path → local abs dir", () => {
    const r = resolveRegistryRef("file:./reg", "plugin");
    expect(r.kind).toBe("local");
    if (r.kind === "local") expect(r.dir.endsWith("/reg")).toBe(true);
  });

  test("undefined → throws with guidance", () => {
    expect(() => resolveRegistryRef(undefined, "template")).toThrow(MarketplaceCliError);
    expect(() => resolveRegistryRef(undefined, "template")).toThrow(/CREWHAUS_TEMPLATE_REGISTRY/);
  });
});

describe("compareSemverCore", () => {
  test("orders by major.minor.patch", () => {
    expect(compareSemverCore("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareSemverCore("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemverCore("1.0.0", "1.0.0")).toBe(0);
  });
  test("ignores pre-release suffix", () => {
    expect(compareSemverCore("1.0.0-rc1", "1.0.0")).toBe(0);
  });
});

describe("computeOutdated", () => {
  const remote: PluginMetadata[] = [
    { name: "a", version: "2.0.0" },
    { name: "a", version: "1.5.0" }, // older duplicate — latest wins
    { name: "b", version: "1.0.0" },
  ];
  test("flags outdated, current, and unknown", () => {
    const rows = computeOutdated(
      [
        { name: "a", version: "1.0.0" }, // outdated (2.0.0 available)
        { name: "b", version: "1.0.0" }, // current
        { name: "c", version: "0.1.0" }, // unknown (not in remote)
      ],
      remote,
    );
    expect(rows.find((r) => r.name === "a")?.status).toBe("outdated");
    expect(rows.find((r) => r.name === "a")?.latest).toBe("2.0.0");
    expect(rows.find((r) => r.name === "b")?.status).toBe("current");
    expect(rows.find((r) => r.name === "c")?.status).toBe("unknown");
  });

  test("formatOutdated summarizes update count", () => {
    const rows = computeOutdated([{ name: "a", version: "1.0.0" }], remote);
    const out = formatOutdated(rows).join("\n");
    expect(out).toContain("1 update(s) available");
    expect(out).toContain("⤴ a: 1.0.0 → 2.0.0");
  });
});

describe("installedVersions", () => {
  test("uses pinnedVersion when present, else manifest version", () => {
    const entries = [
      {
        manifest: manifest("a", "1.0.0"),
        sourcePath: "/x",
        installedAt: "t",
        pinnedVersion: "1.2.0",
      },
      { manifest: manifest("b", "2.0.0"), sourcePath: "/y", installedAt: "t" },
    ];
    expect(installedVersions(entries)).toEqual([
      { name: "a", version: "1.2.0" },
      { name: "b", version: "2.0.0" },
    ]);
  });
});

describe("createLocalModuleRegistrySource", () => {
  test("lists + fetches manifests from an in-memory dir", async () => {
    const files: Record<string, string> = {
      "a.json": JSON.stringify(manifest("a", "1.0.0", { description: "the a plugin" })),
      "b.json": JSON.stringify(manifest("b", "2.0.0")),
      "notes.txt": "ignored",
      "a@0.9.0.json": JSON.stringify(manifest("a", "0.9.0")), // versioned — excluded from list
    };
    const src = createLocalModuleRegistrySource({
      dir: "/reg",
      readdirImpl: () => Object.keys(files),
      readFileImpl: (p) => {
        const key = p.replace("/reg/", "");
        const v = files[key];
        if (v === undefined) throw new Error("no file");
        return v;
      },
      existsImpl: (p) => p === "/reg" || Object.keys(files).some((k) => p.endsWith(k)),
    });
    const list = await src.listPlugins();
    expect(list.map((p) => p.name)).toEqual(["a", "b"]);
    expect(list[0]?.description).toBe("the a plugin");
    const m = await src.getManifest("a");
    expect(m.version).toBe("1.0.0");
  });

  test("getManifest throws for a missing plugin", async () => {
    const src = createLocalModuleRegistrySource({
      dir: "/reg",
      readdirImpl: () => [],
      readFileImpl: () => "{}",
      existsImpl: (p) => p === "/reg",
    });
    await expect(src.getManifest("nope")).rejects.toThrow(MarketplaceCliError);
  });
});

describe("createHttpModuleRegistrySource", () => {
  test("lists via the injected fetch", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u === "https://reg.example") {
        return new Response(JSON.stringify({ plugins: [{ name: "a", version: "1.0.0" }] }), {
          status: 200,
        });
      }
      if (u === "https://reg.example/a.json") {
        return new Response(JSON.stringify(manifest("a", "1.0.0")), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const src = createHttpModuleRegistrySource({
      id: "test",
      baseUrl: "https://reg.example/",
      fetchImpl,
    });
    const list = await src.listPlugins();
    expect(list[0]?.name).toBe("a");
    const m = await src.getManifest("a");
    expect(m.version).toBe("1.0.0");
  });

  test("surfaces a non-ok list status", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const src = createHttpModuleRegistrySource({ id: "t", baseUrl: "https://x", fetchImpl });
    await expect(src.listPlugins()).rejects.toThrow(MarketplaceCliError);
  });
});

describe("toMetadata", () => {
  test("projects a manifest to search metadata", () => {
    const meta = toMetadata(
      manifest("a", "1.0.0", { description: "d", author: "me", secret: "x" }),
    );
    expect(meta).toEqual({ name: "a", version: "1.0.0", description: "d", author: "me" });
  });
});

describe("formatPluginList", () => {
  test("renders name@version with optional author/description", () => {
    const out = formatPluginList([
      { name: "a", version: "1.0.0", author: "me", description: "d" },
    ]).join("\n");
    expect(out).toContain("a@1.0.0 — me");
    expect(out).toContain("    d");
  });
  test("empty registry note", () => {
    expect(formatPluginList([]).join("\n")).toContain("no plugins");
  });
});

describe("buildPublishPrPlan", () => {
  test("assembles a publish/ branch + manifest file", () => {
    const draft: PublishDraftLike = {
      prTitle: "plugin: publish a@1.0.0",
      prBody: "body",
      manifestRelPath: "plugins/a.json",
      manifestContents: "{}",
      name: "a",
      version: "1.0.0",
    };
    const plan = buildPublishPrPlan(draft, new Date("2026-07-02T12:00:00Z"));
    expect(plan.branch).toBe("publish/a-1.0.0-2026-07-02T12-00-00");
    expect(plan.files["plugins/a.json"]).toBe("{}");
    expect(plan.commitMessage).toContain("a");
  });
});
