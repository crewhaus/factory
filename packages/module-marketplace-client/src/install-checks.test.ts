/**
 * What `install` checks before it reports a plugin as installed (0.7.1):
 *
 * - extension-path#3 (C017): install writes the manifest only, and the
 *   loader imports `<plugin-dir>/index.js`, so 0.7.0 reported "installed" for
 *   a plugin that could never run. Install now says whether it can run, and
 *   what is missing: the code, code that matches `entrypointDigest`, or a
 *   crewhaus the manifest's `engines.crewhaus` range includes.
 * - extension-path#2 (C015): a pinned version is the version installed, and
 *   a manifest the registry refuses for its signature is refused before it
 *   is written, so it never replaces a working one on disk.
 *
 * Real files in a throwaway directory and the real plugin-registry; only
 * the remote source is faked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import {
  type PluginManifest,
  entrypointDigest,
  manifestPayloadForSigning,
} from "@crewhaus/plugin-sdk";
import {
  ModuleMarketplaceError,
  type ModuleRegistrySource,
  createMarketplaceClient,
} from "./index";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marketplace-install-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CODE = "export default { contributions: {} };\n";

function source(manifest: PluginManifest): ModuleRegistrySource {
  return {
    id: "fixture",
    async listPlugins() {
      return [];
    },
    async getManifest() {
      return manifest;
    },
  };
}

function client(
  manifest: PluginManifest,
  extra: { registry?: ReturnType<typeof createPluginRegistry>; hostVersion?: string } = {},
) {
  const registry =
    extra.registry ??
    createPluginRegistry({ registryPath: join(dir, "registry.json"), allowUnsigned: true });
  return {
    registry,
    client: createMarketplaceClient({
      registry: source(manifest),
      pluginRegistry: registry,
      pluginsDir: join(dir, "plugins"),
      ...(extra.hostVersion !== undefined ? { hostVersion: extra.hostVersion } : {}),
    }),
  };
}

function placeCode(name: string, code = CODE): string {
  const p = join(dir, "plugins", name, "index.js");
  mkdirSync(join(dir, "plugins", name), { recursive: true });
  writeFileSync(p, code);
  return p;
}

describe("install says whether the plugin can run (C017)", () => {
  test("with no code in place, it installs the manifest and says where the code goes", async () => {
    const m = { name: "greeter", version: "1.0.0", entrypointDigest: entrypointDigest(CODE) };
    const { client: c, registry } = client(m);
    const result = await c.install("greeter");
    expect(result.runnable).toBe(false);
    expect(result.warnings).toEqual([
      `greeter@1.0.0 is installed as a manifest only: the registry delivers no code. Put the plugin's index.js at ${join(dir, "plugins", "greeter", "index.js")} (its sha256 must equal the manifest's entrypointDigest) before a spec names it in plugins:.`,
    ]);
    // The manifest is still installed: placing the code afterwards is the
    // documented way to finish, and it needs no second install.
    expect(existsSync(result.manifestPath)).toBe(true);
    expect((await registry.get("greeter"))?.sourcePath).toBe(result.manifestPath);
  });

  test("with the code in place and matching, it is runnable with nothing to say", async () => {
    placeCode("greeter");
    const m = { name: "greeter", version: "1.0.0", entrypointDigest: entrypointDigest(CODE) };
    const result = await client(m).client.install("greeter");
    expect({ runnable: result.runnable, warnings: result.warnings }).toEqual({
      runnable: true,
      warnings: [],
    });
  });

  test("code that does not match the manifest's digest is named", async () => {
    const path = placeCode("greeter", "export default { evil: true };\n");
    const m = { name: "greeter", version: "1.0.0", entrypointDigest: entrypointDigest(CODE) };
    const result = await client(m).client.install("greeter");
    expect(result.runnable).toBe(false);
    expect(result.warnings).toEqual([
      `greeter@1.0.0: the index.js at ${path} does not match the manifest's entrypointDigest, so a spec that names the plugin will be refused at boot until it does.`,
    ]);
  });

  test("a FIFO where the code should be is reported, not waited on", async () => {
    mkdirSync(join(dir, "plugins", "greeter"), { recursive: true });
    const path = join(dir, "plugins", "greeter", "index.js");
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const result = await client({ name: "greeter", version: "1.0.0" }).client.install("greeter");
    expect(result.runnable).toBe(false);
    expect(result.warnings).toEqual([
      `greeter@1.0.0: ${path} cannot be used: it is a fifo, not a regular file. A spec that names the plugin will not start until it is a regular file inside the plugin's directory.`,
    ]);
  });

  test("an index.js that links out of the plugin's directory is not runnable, as the boot will refuse it", async () => {
    const outside = join(dir, "elsewhere");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "index.js"), CODE);
    mkdirSync(join(dir, "plugins", "greeter"), { recursive: true });
    const path = join(dir, "plugins", "greeter", "index.js");
    symlinkSync(join(outside, "index.js"), path);
    const m = { name: "greeter", version: "1.0.0", entrypointDigest: entrypointDigest(CODE) };
    const result = await client(m).client.install("greeter");
    expect(result.runnable).toBe(false);
    expect(result.warnings).toEqual([
      `greeter@1.0.0: ${path} cannot be used: it is a link that leads outside the plugin's directory ${join(dir, "plugins", "greeter")}, and the boot loads only code inside it. A spec that names the plugin will not start until it is a regular file inside the plugin's directory (its sha256 must equal the manifest's entrypointDigest).`,
    ]);
  });

  test("a link that stays inside the plugin's directory is runnable, as the boot allows it", async () => {
    mkdirSync(join(dir, "plugins", "greeter", "dist"), { recursive: true });
    writeFileSync(join(dir, "plugins", "greeter", "dist", "index.js"), CODE);
    symlinkSync(join("dist", "index.js"), join(dir, "plugins", "greeter", "index.js"));
    const m = { name: "greeter", version: "1.0.0", entrypointDigest: entrypointDigest(CODE) };
    const result = await client(m).client.install("greeter");
    expect(result).toMatchObject({ runnable: true, warnings: [] });
  });

  test("a range that leaves this crewhaus out is named", async () => {
    placeCode("greeter");
    const m = { name: "greeter", version: "1.0.0", engines: { crewhaus: ">=99.0.0" } };
    const result = await client(m, { hostVersion: "0.7.1" }).client.install("greeter");
    expect(result.runnable).toBe(false);
    expect(result.warnings).toEqual([
      'plugin "greeter" 1.0.0 requires crewhaus >=99.0.0, and this is crewhaus 0.7.1, so a spec that names it will be refused at boot.',
    ]);
  });
});

describe("install installs what was asked for, or nothing (C015)", () => {
  test("a pinned version the source answers with another version is refused, and nothing is written", async () => {
    const { client: c, registry } = client({ name: "greeter", version: "1.0.0" });
    await expect(c.install("greeter", "9.9.9")).rejects.toThrow(ModuleMarketplaceError);
    await expect(c.install("greeter", "9.9.9")).rejects.toThrow(
      'registry "fixture" served greeter@1.0.0 when 9.9.9 was asked for — not installed',
    );
    expect(existsSync(join(dir, "plugins", "greeter", "plugin.json"))).toBe(false);
    expect(await registry.get("greeter")).toBeUndefined();
    // The version it does serve installs.
    await expect(c.install("greeter", "1.0.0")).resolves.toMatchObject({
      manifest: { version: "1.0.0" },
    });
  });

  test("a manifest the registry refuses for its signature never replaces a working one on disk", async () => {
    const publisher = generateKeyPairSync("ed25519");
    const pem = publisher.publicKey.export({ type: "spki", format: "pem" }).toString();
    const signWith = (m: PluginManifest, key: typeof publisher.privateKey): PluginManifest => ({
      ...m,
      signature: {
        algorithm: "ed25519",
        publicKeyB64: "unused",
        sigB64: sign(null, Buffer.from(manifestPayloadForSigning(m), "utf8"), key).toString(
          "base64",
        ),
      },
    });
    const registry = createPluginRegistry({
      registryPath: join(dir, "registry.json"),
      trustAnchors: [{ kind: "pem", name: "publisher", publicKeyPem: pem }],
    });
    const good = signWith({ name: "greeter", version: "1.0.0" }, publisher.privateKey);
    const first = await client(good, { registry }).client.install("greeter");
    const onDisk = readFileSync(first.manifestPath, "utf8");

    const forged = signWith(
      { name: "greeter", version: "2.0.0" },
      generateKeyPairSync("ed25519").privateKey,
    );
    await expect(client(forged, { registry }).client.install("greeter")).rejects.toThrow(
      /signature verification failed for plugin "greeter"/,
    );
    expect(readFileSync(first.manifestPath, "utf8")).toBe(onDisk);
    expect((await registry.get("greeter"))?.manifest.version).toBe("1.0.0");
  });
});

describe("install says when signed code cannot run as signed (C108)", () => {
  // The loader runs a signed plugin as exactly the bytes its entrypointDigest
  // names, so install reports what boot would refuse.
  const publisher = generateKeyPairSync("ed25519");
  const pem = publisher.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signWith = (m: PluginManifest): PluginManifest => ({
    ...m,
    signature: {
      algorithm: "ed25519",
      publicKeyB64: "unused",
      sigB64: sign(
        null,
        Buffer.from(manifestPayloadForSigning(m), "utf8"),
        publisher.privateKey,
      ).toString("base64"),
    },
  });
  const verifying = () =>
    createPluginRegistry({
      registryPath: join(dir, "registry.json"),
      trustAnchors: [{ kind: "pem", name: "publisher", publicKeyPem: pem }],
    });

  test("a signed manifest with no entrypointDigest is not runnable, and says why", async () => {
    placeCode("greeter");
    const m = signWith({ name: "greeter", version: "1.0.0" });
    const result = await client(m, { registry: verifying() }).client.install("greeter");
    expect(result.runnable).toBe(false);
    expect(result.warnings).toEqual([
      "greeter@1.0.0 is signed, but its manifest has no entrypointDigest, so the signature covers none of its code, and a spec that names it will be refused at boot outside development mode. Ask the publisher to re-sign it with entrypointDigest set.",
    ]);
  });

  test("signed code that imports a sibling is not runnable, and names the import", async () => {
    const code = 'import { b } from "./lib.js";\nexport default { b };\n';
    const path = placeCode("greeter", code);
    const m = signWith({
      name: "greeter",
      version: "1.0.0",
      entrypointDigest: entrypointDigest(code),
    });
    const result = await client(m, { registry: verifying() }).client.install("greeter");
    expect(result.runnable).toBe(false);
    expect(result.warnings).toEqual([
      `greeter@1.0.0: the index.js at ${path} cannot run as signed code, so a spec that names the plugin will be refused at boot: it imports "./lib.js", which its entrypointDigest does not cover. A signed plugin must be one file: bundle it (bun build src/index.ts --target=bun --format=esm --outfile index.js) and sign that.`,
    ]);
  });

  test("single-file signed code is runnable; an unsigned plugin may still import its siblings", async () => {
    const one = "export default {};\n";
    placeCode("greeter", one);
    const signed = signWith({
      name: "greeter",
      version: "1.0.0",
      entrypointDigest: entrypointDigest(one),
    });
    const a = await client(signed, { registry: verifying() }).client.install("greeter");
    expect({ runnable: a.runnable, warnings: a.warnings }).toEqual({
      runnable: true,
      warnings: [],
    });

    const multi = 'import { b } from "./lib.js";\nexport default { b };\n';
    placeCode("dev", multi);
    const unsigned = { name: "dev", version: "1.0.0", entrypointDigest: entrypointDigest(multi) };
    const b = await client(unsigned).client.install("dev");
    expect({ runnable: b.runnable, warnings: b.warnings }).toEqual({
      runnable: true,
      warnings: [],
    });
  });
});
