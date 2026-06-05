/**
 * Isolated coverage for the private `defaultWriteFile` seam in
 * `module-marketplace-client`. The main suite always injects `writeFileImpl`,
 * so the default 0600-mode `node:fs` write path (lines covering
 * `existsSync` / `mkdirSync` / `writeFileSync`) is never exercised there.
 *
 * Here we replace `node:fs` with an in-memory fake via `mock.module` so the
 * default path runs WITHOUT touching disk, then drive it through `install`
 * (which calls the seam when no override is supplied). Both directory states
 * are covered: a missing dir triggers `mkdirSync`, an existing dir skips it.
 *
 * `mock.module` mutates the shared module registry, so this lives in its own
 * file — Bun gives each test file a fresh module graph, keeping the fs stub
 * from leaking into `index.test.ts`.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PluginRegistry, PluginRegistryEntry } from "@crewhaus/plugin-registry";
import type { PluginManifest } from "@crewhaus/plugin-sdk";

// In-memory recording of what the faked node:fs received.
type FsCall = { fn: "existsSync" | "mkdirSync" | "writeFileSync"; args: unknown[] };
const fsCalls: FsCall[] = [];
const existingDirs = new Set<string>();
const writtenFiles = new Map<string, { contents: string; opts: unknown }>();

mock.module("node:fs", () => ({
  existsSync: (p: string) => {
    fsCalls.push({ fn: "existsSync", args: [p] });
    return existingDirs.has(p);
  },
  mkdirSync: (p: string, opts: unknown) => {
    fsCalls.push({ fn: "mkdirSync", args: [p, opts] });
    existingDirs.add(p);
    return undefined;
  },
  writeFileSync: (p: string, contents: string, opts: unknown) => {
    fsCalls.push({ fn: "writeFileSync", args: [p, contents, opts] });
    writtenFiles.set(p, { contents, opts });
  },
}));

// Import the unit under test AFTER the fs stub is registered so its
// `import { ... } from "node:fs"` binding resolves to the fake.
const { createMarketplaceClient } = await import("./index");
type ModuleRegistrySource = import("./index").ModuleRegistrySource;

const MANIFEST: PluginManifest = {
  name: "alpha-tools",
  version: "1.0.0",
  description: "alpha contributes tools",
};

function fakeRegistrySource(overrides: Partial<ModuleRegistrySource> = {}): ModuleRegistrySource {
  return {
    id: "test-registry",
    async listPlugins() {
      return [];
    },
    async getManifest() {
      return MANIFEST;
    },
    ...overrides,
  };
}

function fakePluginRegistry(): PluginRegistry {
  const entries = new Map<string, PluginRegistryEntry>();
  return {
    async register(args) {
      const entry: PluginRegistryEntry = {
        manifest: args.manifest,
        sourcePath: args.sourcePath,
        installedAt: "2026-01-01T00:00:00.000Z",
      };
      entries.set(args.manifest.name, entry);
      return entry;
    },
    async unregister(name) {
      entries.delete(name);
    },
    async list() {
      return [...entries.values()];
    },
    async get(name) {
      return entries.get(name);
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

afterEach(() => {
  fsCalls.length = 0;
  existingDirs.clear();
  writtenFiles.clear();
});

describe("module-marketplace-client default writeFile seam", () => {
  test("creates the missing directory then writes the manifest 0600", async () => {
    const client = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: "/var/plugins",
      // NOTE: no writeFileImpl -> the default node:fs path runs.
    });
    const result = await client.install("alpha-tools");
    expect(result.manifestPath).toBe("/var/plugins/alpha-tools/plugin.json");

    // The directory did not exist -> existsSync(false) then mkdirSync(recursive).
    expect(fsCalls.some((c) => c.fn === "existsSync")).toBe(true);
    const mkdir = fsCalls.find((c) => c.fn === "mkdirSync");
    expect(mkdir?.args[0]).toBe("/var/plugins/alpha-tools");
    expect(mkdir?.args[1]).toEqual({ recursive: true });

    // The manifest was written with utf8 + mode 0600.
    const written = writtenFiles.get("/var/plugins/alpha-tools/plugin.json");
    expect(written?.opts).toEqual({ encoding: "utf8", mode: 0o600 });
    expect(written?.contents).toContain('"alpha-tools"');
    expect(written?.contents.endsWith("\n")).toBe(true);
  });

  test("skips mkdir when the directory already exists", async () => {
    existingDirs.add("/var/plugins/alpha-tools");
    const client = createMarketplaceClient({
      registry: fakeRegistrySource(),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: "/var/plugins",
    });
    await client.install("alpha-tools");
    // existsSync(true) -> mkdirSync is NOT called for that dir.
    expect(fsCalls.some((c) => c.fn === "mkdirSync")).toBe(false);
    expect(writtenFiles.has("/var/plugins/alpha-tools/plugin.json")).toBe(true);
  });

  test("writes both the manifest and the source tarball through the default seam", async () => {
    const client = createMarketplaceClient({
      registry: fakeRegistrySource({
        async downloadSource() {
          return new TextEncoder().encode("tarball-bytes");
        },
      }),
      pluginRegistry: fakePluginRegistry(),
      pluginsDir: "/var/plugins",
    });
    await client.install("alpha-tools");
    // Both the manifest and the base64 source land via the default writer.
    expect(writtenFiles.has("/var/plugins/alpha-tools/plugin.json")).toBe(true);
    const src = writtenFiles.get("/var/plugins/alpha-tools/source.bin");
    expect(src).toBeDefined();
    expect(src?.contents).toBe(Buffer.from("tarball-bytes").toString("base64"));
  });
});
