/**
 * extension-path#8 (C107): the manifest was not the contract for what loads.
 * The module's own name was never compared with the manifest's, nothing
 * listed which tools a plugin contributes, and the SDK and the loader said
 * plugins were sandboxed — "fail-closed, zero access", "capability gating",
 * "sandboxed import" — while their code ran in-process with the process's
 * full authority and fs/net/secrets were read by nothing at runtime.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import {
  type PluginManifest,
  entrypointDigest,
  manifestPayloadForSigning,
} from "@crewhaus/plugin-sdk";
import { z } from "zod";
import { PluginLoaderError, activatePlugins, createPluginLoader } from "./index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-manifest-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: z.object({}),
  execute: async () => name,
});

/** Activate one plugin `greeter` with `manifest` fields, whose module default export is `moduleDefault`. */
async function activate(manifest: Partial<PluginManifest>, moduleDefault: unknown) {
  const registry = createPluginRegistry({
    registryPath: join(root, "registry.json"),
    allowUnsigned: true,
  });
  mkdirSync(join(root, "greeter"), { recursive: true });
  writeFileSync(join(root, "greeter", "index.js"), "export default {};\n");
  const full = { name: "greeter", version: "1.0.0", ...manifest } as PluginManifest;
  writeFileSync(join(root, "greeter", "plugin.json"), JSON.stringify(full));
  await registry.register({ manifest: full, sourcePath: join(root, "greeter", "plugin.json") });
  const loader = createPluginLoader({
    trustedRoots: [root],
    allowUnsigned: true,
    warn: () => {},
    importEntrypoint: async () => ({ default: moduleDefault }),
  });
  return activatePlugins({ names: ["greeter"], registry, loader });
}

describe("the code must be the plugin its manifest describes (C107)", () => {
  test("a module that says it is another plugin is refused, naming both", async () => {
    const run = activate({}, { name: "impostor", contributions: { tools: [tool("hi")] } });
    await expect(run).rejects.toThrow(PluginLoaderError);
    await expect(run).rejects.toThrow(
      `plugin "greeter": its code says it is plugin "impostor", so the index.js beside "greeter"'s manifest is another plugin's code — refusing to load it`,
    );
  });

  test("a module with no name, or the manifest's, loads as before", async () => {
    for (const moduleDefault of [
      { contributions: { tools: [tool("hi")] } },
      { name: "greeter", version: "1.0.0", contributions: { tools: [tool("hi")] } },
    ]) {
      rmSync(join(root, "registry.json"), { force: true });
      const activated = await activate({}, moduleDefault);
      expect(activated.tools.map((t) => t.name)).toEqual(["hi"]);
      expect(activated.warnings).toEqual([]);
    }
  });

  test("a differing version or permissions block loads, noted; the manifest's apply", async () => {
    const activated = await activate(
      { permissions: { tools: ["Read"] } },
      {
        name: "greeter",
        version: "0.9.0",
        permissions: { tools: ["*"] },
        contributions: { tools: [tool("hi")] },
      },
    );
    expect(activated.warnings).toEqual([
      'plugin "greeter": its code declares version 0.9.0 (the manifest says 1.0.0) and permissions that differ from the manifest\'s. The manifest is what crewhaus goes by; rebuild the plugin so they agree.',
    ]);
    expect(activated.loaded[0]?.permissions).toEqual({ tools: ["Read"] });
  });
});

describe("provides.tools makes the manifest list what loads (C107)", () => {
  const code = (tools: string[]) => ({ contributions: { tools: tools.map(tool) } });

  test("a tool the manifest does not list is refused, by name", async () => {
    await expect(
      activate({ provides: { tools: ["hi"] } }, code(["hi", "extra_tool"])),
    ).rejects.toThrow(
      `plugin "greeter": its code contributes "extra_tool", which its manifest's provides.tools does not list — refusing to load the plugin`,
    );
  });

  test("a listed tool the code does not contribute is refused, by name", async () => {
    await expect(activate({ provides: { tools: ["hi", "gone"] } }, code(["hi"]))).rejects.toThrow(
      `plugin "greeter": its manifest's provides.tools lists "gone", which its code does not contribute — refusing to load the plugin`,
    );
  });

  test("exactly the listed tools load; a manifest without the list loads as before", async () => {
    const exact = await activate({ provides: { tools: ["hi", "bye"] } }, code(["bye", "hi"]));
    expect(exact.tools.map((t) => t.name)).toEqual(["bye", "hi"]);
    rmSync(join(root, "registry.json"));
    const open = await activate({}, code(["hi", "extra_tool"]));
    expect(open.tools.map((t) => t.name)).toEqual(["hi", "extra_tool"]);
    expect(open.warnings).toEqual([]);
  });

  test("the list is signed: widening it after signing breaks the signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const index = "export default {};\n";
    const m: PluginManifest = {
      name: "greeter",
      version: "1.0.0",
      provides: { tools: ["hi"] },
      entrypointDigest: entrypointDigest(index),
    };
    const sig = sign(null, Buffer.from(manifestPayloadForSigning(m), "utf8"), privateKey);
    mkdirSync(join(root, "greeter"), { recursive: true });
    writeFileSync(join(root, "greeter", "index.js"), index);
    const path = join(root, "greeter", "plugin.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...m,
        provides: { tools: ["hi", "extra_tool"] },
        signature: { algorithm: "ed25519", publicKeyB64: "x", sigB64: sig.toString("base64") },
      }),
    );
    const loader = createPluginLoader({
      trustedRoots: [root],
      trustAnchors: [
        { name: "t", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
      ],
    });
    await expect(loader.load(path)).rejects.toThrow(/signature does not verify/);
  });
});

describe("a plugin's unenforced permissions are called that (C107)", () => {
  test("declaring fs, net or secrets is noted as not enforced; tools alone is not", async () => {
    const declared = await activate(
      { permissions: { fs: [], net: ["fetch:https://x/**"], tools: ["Read"] } },
      { contributions: { tools: [] } },
    );
    expect(declared.warnings).toEqual([
      'plugin "greeter" declares permissions.fs, permissions.net; crewhaus does not enforce these on plugin code, which runs inside this process with its full authority (environment, files, network). Only permissions.tools is applied.',
    ]);
    rmSync(join(root, "registry.json"));
    const toolsOnly = await activate(
      { permissions: { tools: ["Read"] } },
      { contributions: { tools: [] } },
    );
    expect(toolsOnly.warnings).toEqual([]);
  });

  test("the SDK and the loader no longer promise a sandbox", () => {
    const read = (rel: string) => readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
    const sources = {
      sdk: read("plugin-sdk/src/index.ts"),
      loader: read("plugin-loader/src/index.ts"),
      loaderPkg: read("plugin-loader/package.json"),
      loaderReadme: read("plugin-loader/README.md"),
    };
    const count = (text: string, phrase: string) => text.split(phrase).length - 1;
    const promises = [
      "zero access to that resource class",
      "enforcing the `permissions` allow-list",
      "sandboxed import",
      "capability gating",
      "Capability gating",
    ];
    for (const [where, text] of Object.entries(sources)) {
      for (const phrase of promises) {
        expect({ where, phrase, hits: count(text, phrase) }).toEqual({ where, phrase, hits: 0 });
      }
    }
    // …and each says what is true, once where it is defined.
    expect(count(sources.sdk, "`fs`, `net` and `secrets` are NOT enforced on plugin code")).toBe(1);
    expect(count(sources.loader, "runs with its full authority")).toBe(1);
    expect(
      count(sources.loaderReadme, "`fs`, `net` and `secrets` are not\nenforced on plugin code"),
    ).toBe(1);
  });
});

describe("an install record 0.7.0 wrote breaks only its own plugin (review of 0.7.1)", () => {
  // 0.7.0 ignored `provides` and `notAfter`; a registry holding one such
  // record made every plugin fail to load, naming neither the record nor
  // the file. Now the registry reads it, the other plugins load, and the
  // plugin itself is refused when a spec names it, naming its manifest.
  async function setUp() {
    const registryPath = join(root, "registry.json");
    const write = (manifest: Record<string, unknown>) => {
      const dir = join(root, String(manifest["name"]));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.js"), "export default {};\n");
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
      return {
        manifest,
        sourcePath: join(dir, "plugin.json"),
        installedAt: "2026-09-01T00:00:00Z",
      };
    };
    // The file as 0.7.0's install wrote it.
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: "1",
        entries: {
          "acme-notes": write({ name: "acme-notes", version: "1.0.0", provides: ["notes_search"] }),
          "acme-dated": write({ name: "acme-dated", version: "1.0.0", notAfter: "2027-01-01" }),
          "weather-tools": write({ name: "weather-tools", version: "1.0.0" }),
        },
      }),
    );
    const registry = createPluginRegistry({ registryPath, allowUnsigned: true });
    const loader = createPluginLoader({
      trustedRoots: [root],
      allowUnsigned: true,
      warn: () => {},
      importEntrypoint: async (p) => ({
        default: {
          contributions: { tools: p.includes("weather-tools") ? [tool("forecast")] : [] },
        },
      }),
    });
    return { registry, loader };
  }

  test("a spec that names another plugin loads it", async () => {
    const { registry, loader } = await setUp();
    const activated = await activatePlugins({ names: ["weather-tools"], registry, loader });
    expect(activated.tools.map((t) => t.name)).toEqual(["forecast"]);
    expect((await registry.list()).map((e) => e.manifest.name)).toEqual([
      "acme-dated",
      "acme-notes",
      "weather-tools",
    ]);
  });

  test("the plugin with the malformed field is refused, naming its manifest and the field", async () => {
    const { registry, loader } = await setUp();
    for (const [name, field] of [
      ["acme-notes", "`provides` must be an object"],
      ["acme-dated", "`notAfter` must be an RFC 3339 date-time with Z or an offset"],
    ] as const) {
      const run = activatePlugins({ names: [name], registry, loader });
      await expect(run).rejects.toThrow(PluginLoaderError);
      await expect(run).rejects.toThrow(
        new RegExp(
          `^plugin manifest at .*${name}/plugin\\.json is not valid: plugin manifest: ${field.replace(/[`()]/g, "\\$&")}`,
        ),
      );
    }
  });
});
