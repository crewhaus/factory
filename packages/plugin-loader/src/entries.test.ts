/**
 * `plugins:` entries (#522): `{name, tools}` narrows the host tools a plugin's
 * tools may drive to those in both the entry and the manifest's
 * `permissions.tools`. A name entry keeps the manifest's list.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import {
  type PluginManifest,
  type RegisteredTool,
  entrypointDigest,
  manifestPayloadForSigning,
} from "@crewhaus/plugin-sdk";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import {
  type PluginEntry,
  activatePlugins,
  activatePluginsOrStartWithout,
  createPluginLoader,
  defaultPluginPaths,
  defaultTrustAnchorDir,
  grantedBridgeTools,
  pluginEntryName,
} from "./index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-entries-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const hostTool = (name: string) =>
  buildTool({ name, description: name, inputSchema: z.object({}), execute: async () => name });

const bridge = () => ({
  runContext: { runId: "r1" },
  tools: [hostTool("Read"), hostTool("Bash"), hostTool("Write")],
});

/** A plugin tool that reports the host tools its bridge and its classifier catalog show it. */
function probe() {
  const seen: { catalog: string[] } = { catalog: [] };
  const tool = {
    name: "probe",
    description: "reports its bridge",
    inputSchema: z.object({}),
    concurrencyClassifier: (_input: unknown, catalog: ReadonlyArray<RegisteredTool>) => {
      seen.catalog = catalog.map((t) => t.name);
      return true;
    },
    execute: async (_input: unknown, ctx?: { bridge?: unknown }) =>
      JSON.stringify((ctx?.bridge as { tools: Array<{ name: string }> }).tools.map((t) => t.name)),
  };
  return { tool, seen };
}

/** Activate one unsigned plugin `prober` whose manifest asks for `asked`, through `entry`. */
async function activate(asked: string[], entries: PluginEntry[]) {
  const registry = createPluginRegistry({
    registryPath: join(root, "registry.json"),
    allowUnsigned: true,
  });
  mkdirSync(join(root, "prober"), { recursive: true });
  writeFileSync(join(root, "prober", "index.js"), "export default {};\n");
  const manifest = { name: "prober", version: "1.0.0", permissions: { tools: asked } };
  writeFileSync(join(root, "prober", "plugin.json"), JSON.stringify(manifest));
  await registry.register({ manifest, sourcePath: join(root, "prober", "plugin.json") });
  const p = probe();
  const loader = createPluginLoader({
    trustedRoots: [root],
    allowUnsigned: true,
    warn: () => {},
    importEntrypoint: async () => ({ default: { contributions: { tools: [p.tool] } } }),
  });
  const warnings: string[] = [];
  const activated = await activatePlugins({
    names: entries,
    registry,
    loader,
    warn: (l) => warnings.push(l),
  });
  const tool = activated.tools[0] as RegisteredTool;
  const bridgeTools = JSON.parse(String(await tool.execute({}, { bridge: bridge() })));
  tool.concurrencyClassifier?.({}, bridge().tools);
  return { bridgeTools, catalog: p.seen.catalog, warnings, activated };
}

const notGrantedLines = (warnings: string[]) =>
  warnings.filter((w) => w.includes("it was not granted"));

describe("an object entry narrows the host tools", () => {
  test("to those in both lists, on ctx.bridge and in the classifier catalog", async () => {
    const got = await activate(["Read", "Bash"], [{ name: "prober", tools: ["Read"] }]);
    expect(got.bridgeTools).toEqual(["Read"]);
    expect(got.catalog).toEqual(["Read"]);
    expect(notGrantedLines(got.warnings)).toEqual([]);
  });

  test("tools: [] grants none", async () => {
    const got = await activate(["Read", "Bash"], [{ name: "prober", tools: [] }]);
    expect(got.bridgeTools).toEqual([]);
    expect(got.catalog).toEqual([]);
  });

  test("a tool the manifest does not ask for stays unreachable, and one warning names it", async () => {
    const got = await activate(["Read"], [{ name: "prober", tools: ["Read", "Write"] }]);
    expect(got.bridgeTools).toEqual(["Read"]);
    expect(got.catalog).toEqual(["Read"]);
    expect(notGrantedLines(got.warnings)).toEqual([
      '[plugins] plugin "prober" asks for no host tool "Write"; it was not granted. Its manifest\'s permissions.tools must list a host tool before plugins: can grant it.',
    ]);
  });

  test("a name entry keeps every host tool the manifest asks for", async () => {
    const got = await activate(["Read", "Bash"], ["prober"]);
    expect(got.bridgeTools).toEqual(["Read", "Bash"]);
    expect(got.catalog).toEqual(["Read", "Bash"]);
  });

  test("repeats are de-duplicated by name: the first entry wins", async () => {
    const narrowFirst = await activate(
      ["Read", "Bash"],
      [{ name: "prober", tools: ["Read"] }, "prober"],
    );
    expect(narrowFirst.activated.loaded).toHaveLength(1);
    expect(narrowFirst.bridgeTools).toEqual(["Read"]);
  });
});

describe("grantedBridgeTools and pluginEntryName", () => {
  test("the intersection, de-duplicated, and what was not granted", () => {
    const got = grantedBridgeTools(["Read", "Bash"], {
      name: "p",
      tools: ["Bash", "Bash", "Fetch"],
    });
    expect([...got.tools]).toEqual(["Bash"]);
    expect(got.notGranted).toEqual(["Fetch"]);
    expect([...grantedBridgeTools(undefined, { name: "p", tools: ["Read"] }).tools]).toEqual([]);
    expect([...grantedBridgeTools(["Read"], "p").tools]).toEqual(["Read"]);
  });

  test("names an entry of either form", () => {
    expect(pluginEntryName("notes")).toBe("notes");
    expect(pluginEntryName({ name: "notes", tools: [] })).toBe("notes");
  });
});

describe("the channel daemon path narrows the same way", () => {
  // Signed, really imported: what a channel daemon does at boot.
  const ENTRY = `export default { contributions: { tools: [{ name: "Probe", description: "reports its bridge", jsonSchema: { type: "object", properties: {} }, inputSchema: { safeParse: (v) => ({ success: true, data: v }), parse: (v) => v }, execute: async (_i, ctx) => JSON.stringify(ctx.bridge.tools.map((t) => t.name)) }] } };\n`;

  async function installSigned(name: string, asked: string[]) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const anchors = defaultTrustAnchorDir(root);
    mkdirSync(anchors, { recursive: true });
    writeFileSync(
      join(anchors, "publisher.pem"),
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const { pluginsDir, registryPath } = defaultPluginPaths(root);
    const dir = join(pluginsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), ENTRY);
    const unsigned: PluginManifest = {
      name,
      version: "1.0.0",
      permissions: { tools: asked },
      entrypointDigest: entrypointDigest(new TextEncoder().encode(ENTRY)),
    };
    const sigB64 = sign(
      null,
      Buffer.from(manifestPayloadForSigning(unsigned), "utf8"),
      privateKey,
    ).toString("base64");
    const manifest: PluginManifest = {
      ...unsigned,
      signature: { algorithm: "ed25519", publicKeyB64: "unused", sigB64 },
    };
    const sourcePath = join(dir, "plugin.json");
    writeFileSync(sourcePath, JSON.stringify(manifest));
    await createPluginRegistry({ registryPath, allowUnsigned: true }).register({
      manifest,
      sourcePath,
    });
  }

  test("a string then an object for the same plugin loads it once, as the string said", async () => {
    await installSigned("prober", ["Read", "Bash"]);
    const warnings: string[] = [];
    const activated = await activatePluginsOrStartWithout({
      names: ["prober", { name: "prober", tools: ["Read"] }],
      homeDir: root,
      env: {},
      warn: (l) => warnings.push(l),
    });
    expect(activated.loaded).toHaveLength(1);
    const tool = activated.tools[0] as RegisteredTool;
    expect(JSON.parse(String(await tool.execute({}, { bridge: bridge() })))).toEqual([
      "Read",
      "Bash",
    ]);
  });

  test("an object entry narrows, and a skip line names the plugin, not the entry", async () => {
    await installSigned("prober", ["Read", "Bash"]);
    const warnings: string[] = [];
    const activated = await activatePluginsOrStartWithout({
      names: [
        { name: "prober", tools: ["Bash"] },
        { name: "absent", tools: [] },
      ],
      homeDir: root,
      env: {},
      warn: (l) => warnings.push(l),
    });
    const tool = activated.tools[0] as RegisteredTool;
    expect(JSON.parse(String(await tool.execute({}, { bridge: bridge() })))).toEqual(["Bash"]);
    expect(warnings).toEqual([
      '[plugins] "absent" not loaded: plugin "absent" is named in plugins: but is not installed in the plugin registry. The daemon starts without it.',
    ]);
  });
});
