import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PluginRegistry, PluginRegistryEntry } from "@crewhaus/plugin-registry";
import type { PluginManifest } from "@crewhaus/plugin-sdk";
import {
  DEFAULT_MODULE_REGISTRY_URL,
  ModuleMarketplaceError,
  type ModuleRegistrySource,
  type PluginMetadata,
  createMarketplaceClient,
} from "./index";

const PLUGINS_DIR = "/tmp/plugins";

const CATALOG: ReadonlyArray<PluginMetadata> = [
  {
    name: "alpha-tools",
    version: "1.0.0",
    description: "alpha contributes tools",
    author: "alice",
    contributes: ["tool"],
  },
  {
    name: "beta-channel",
    version: "2.0.0",
    description: "beta contributes a Mastodon channel",
    author: "bob",
    contributes: ["channel"],
  },
  {
    name: "gamma-mixed",
    version: "1.5.0",
    description: "gamma contributes graders + a target emitter",
    author: "alice",
    contributes: ["grader", "target"],
  },
];

const MANIFESTS: Readonly<Record<string, PluginManifest>> = {
  "alpha-tools": { name: "alpha-tools", version: "1.0.0", description: "alpha contributes tools" },
  "beta-channel": {
    name: "beta-channel",
    version: "2.0.0",
    description: "beta contributes a Mastodon channel",
  },
  "gamma-mixed": {
    name: "gamma-mixed",
    version: "1.5.0",
    description: "gamma contributes graders + a target emitter",
  },
};

function fakeRegistrySource(overrides: Partial<ModuleRegistrySource> = {}): ModuleRegistrySource {
  return {
    id: "test-registry",
    async listPlugins() {
      return CATALOG;
    },
    async getManifest(name) {
      const m = MANIFESTS[name];
      if (!m) throw new Error(`unknown plugin ${name}`);
      return m;
    },
    ...overrides,
  };
}

let memEntries: Map<string, PluginRegistryEntry>;
let memFiles: Map<string, string>;

function fakePluginRegistry(): PluginRegistry {
  return {
    async register(args) {
      const entry: PluginRegistryEntry = {
        manifest: args.manifest,
        sourcePath: args.sourcePath,
        installedAt: new Date().toISOString(),
      };
      memEntries.set(args.manifest.name, entry);
      return entry;
    },
    async unregister(name) {
      memEntries.delete(name);
    },
    async list() {
      return [...memEntries.values()].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1));
    },
    async get(name) {
      return memEntries.get(name);
    },
    async pin() {
      throw new Error("not used");
    },
    async verifyEntry() {
      throw new Error("not used");
    },
    async aggregatedPermissions() {
      throw new Error("not used");
    },
  };
}

beforeEach(() => {
  memEntries = new Map();
  memFiles = new Map();
});

afterEach(() => {
  memEntries.clear();
  memFiles.clear();
});

function recordWrite(path: string, contents: string): void {
  memFiles.set(path, contents);
}

describe("createMarketplaceClient construction", () => {
  test("rejects empty pluginsDir", () => {
    expect(() =>
      createMarketplaceClient({
        registry: fakeRegistrySource(),
        pluginRegistry: fakePluginRegistry(),
        pluginsDir: "",
        writeFileImpl: recordWrite,
      }),
    ).toThrow(ModuleMarketplaceError);
  });
});

describe("search", () => {
  test("returns the full catalog when no filter", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const results = await c.search();
    expect(results.length).toBe(3);
  });

  test("filters by query substring (name)", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const results = await c.search({ query: "GAMMA" });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe("gamma-mixed");
  });

  test("filters by query substring (description)", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const results = await c.search({ query: "mastodon" });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe("beta-channel");
  });

  test("filters by author", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const results = await c.search({ author: "alice" });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.author === "alice")).toBe(true);
  });

  test("filters by contributes kind", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const results = await c.search({ contributes: "grader" });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe("gamma-mixed");
  });

  test("respects limit", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const results = await c.search({ limit: 1 });
    expect(results.length).toBe(1);
  });
});

describe("install", () => {
  test("fetches, writes, registers", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const result = await c.install("alpha-tools");
    expect(result.manifest.name).toBe("alpha-tools");
    expect(result.manifestPath).toBe("/tmp/plugins/alpha-tools/plugin.json");
    expect(memFiles.has(result.manifestPath)).toBe(true);
    expect(memEntries.get("alpha-tools")).toBeDefined();
  });

  test("rejects manifest whose name does not match install request", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource({
        async getManifest(_name) {
          return { name: "different", version: "1.0.0" };
        },
      }),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    let caught: Error | undefined;
    try {
      await c.install("alpha-tools");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(ModuleMarketplaceError);
  });

  test("downloads source tarball when registry implements downloadSource", async () => {
    let downloaded: { name: string; version: string } | undefined;
    const c = createMarketplaceClient({
      registry: fakeRegistrySource({
        async downloadSource(name, version) {
          downloaded = { name, version };
          return new TextEncoder().encode("fake-source");
        },
      }),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    await c.install("alpha-tools");
    expect(downloaded).toEqual({ name: "alpha-tools", version: "1.0.0" });
    expect(memFiles.has("/tmp/plugins/alpha-tools/source.bin")).toBe(true);
  });

  test("respects subdir + manifestFilename overrides", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const result = await c.install("alpha-tools", undefined, {
      subdir: "@alice/alpha",
      manifestFilename: "manifest.json",
    });
    expect(result.manifestPath).toBe("/tmp/plugins/@alice/alpha/manifest.json");
  });
});

describe("uninstall", () => {
  test("removes from the plugin registry", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    await c.install("alpha-tools");
    expect(memEntries.has("alpha-tools")).toBe(true);
    await c.uninstall("alpha-tools");
    expect(memEntries.has("alpha-tools")).toBe(false);
  });

  test("no-ops when plugin not installed", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    await c.uninstall("nope");
    expect(memEntries.size).toBe(0);
  });
});

describe("update", () => {
  test("returns undefined when plugin not installed", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    expect(await c.update("alpha-tools")).toBeUndefined();
  });

  test("returns undefined when remote is not newer", async () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    await c.install("alpha-tools");
    expect(await c.update("alpha-tools")).toBeUndefined();
  });

  test("installs when remote is newer", async () => {
    let pluginReturned = false;
    const c = createMarketplaceClient({
      registry: fakeRegistrySource({
        async getManifest(name) {
          // First call (initial install) returns 1.0.0; second call (update)
          // returns 2.0.0.
          if (name === "alpha-tools" && pluginReturned) {
            return { name: "alpha-tools", version: "2.0.0" };
          }
          pluginReturned = true;
          return MANIFESTS["alpha-tools"] as PluginManifest;
        },
      }),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    await c.install("alpha-tools");
    const updated = await c.update("alpha-tools");
    expect(updated).toBeDefined();
    expect(updated?.manifest.version).toBe("2.0.0");
  });
});

describe("draftPublish", () => {
  test("returns a draft for a valid manifest", () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    const draft = c.draftPublish({
      name: "new-plugin",
      version: "0.1.0",
      description: "a fresh plugin",
    });
    expect(draft.registryId).toBe("test-registry");
    expect(draft.name).toBe("new-plugin");
    expect(draft.prTitle).toBe("plugin: publish new-plugin@0.1.0");
    expect(draft.prBody).toContain("a fresh plugin");
    expect(draft.canonicalManifest).toContain("new-plugin");
  });

  test("rejects invalid manifest", () => {
    const c = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: PLUGINS_DIR,
      writeFileImpl: recordWrite,
    });
    expect(() => c.draftPublish({ name: "BadCaps" as never, version: "1.0.0" } as never)).toThrow();
  });
});

describe("DEFAULT_MODULE_REGISTRY_URL (G89)", () => {
  test("is the canonical https registry index, no trailing slash", () => {
    expect(DEFAULT_MODULE_REGISTRY_URL).toBe("https://registry.crewhaus.ai/plugins");
    // The HTTP source appends `/<name>.json`, so a trailing slash would
    // double it — the documented default must be slash-free.
    expect(DEFAULT_MODULE_REGISTRY_URL.endsWith("/")).toBe(false);
    expect(DEFAULT_MODULE_REGISTRY_URL.startsWith("https://")).toBe(true);
  });
});
