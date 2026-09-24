/**
 * extension-path#13 (C172): activation never checked that the plugin it
 * loaded was the one the registry lists. A registry entry pointing at another
 * plugin's files ran that plugin under the requested name, while `list`,
 * `outdated` and `aggregatedPermissions` described the listed one; and
 * `pinnedVersion` was shown to operators but never enforced, so an older
 * validly-signed release on disk loaded under a pin to a newer one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import {
  type PluginManifest,
  entrypointDigest,
  manifestPayloadForSigning,
} from "@crewhaus/plugin-sdk";
import { type PluginLoader, PluginLoaderError, activatePlugins, createPluginLoader } from "./index";

let root: string;
let key: ReturnType<typeof generateKeyPairSync>["privateKey"];
let pem: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-identity-"));
  const pair = generateKeyPairSync("ed25519");
  key = pair.privateKey;
  pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CODE = "export default {};\n";

function signed(m: Omit<PluginManifest, "entrypointDigest">): PluginManifest {
  const full: PluginManifest = { ...m, entrypointDigest: entrypointDigest(CODE) };
  return {
    ...full,
    signature: {
      algorithm: "ed25519",
      publicKeyB64: "unused",
      sigB64: sign(null, Buffer.from(manifestPayloadForSigning(full), "utf8"), key).toString(
        "base64",
      ),
    },
  };
}

/** Write `<root>/<dir>/{index.js,plugin.json}` holding `manifest`; returns plugin.json. */
function place(dir: string, manifest: PluginManifest): string {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "index.js"), CODE);
  const path = join(root, dir, "plugin.json");
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

function registry() {
  return createPluginRegistry({ registryPath: join(root, "registry.json"), allowUnsigned: true });
}

function spyLoader() {
  const imported: string[] = [];
  const loader = createPluginLoader({
    trustedRoots: [root],
    trustAnchors: [{ name: "t", publicKeyPem: pem }],
    warn: () => {},
    importEntrypoint: async (p) => {
      imported.push(p);
      return { default: {} };
    },
  });
  return { loader, imported };
}

describe("the plugin that loads is the one the registry lists (C172)", () => {
  test("an entry pointing at another plugin's files is refused, and that plugin is never imported", async () => {
    const other = place("other-plugin", signed({ name: "other-plugin", version: "3.0.0" }));
    const reg = registry();
    // The listed manifest is validly signed too; only the files it points at are someone else.
    await reg.register({
      manifest: signed({ name: "trusted-name", version: "1.0.0" }),
      sourcePath: other,
    });
    const { loader, imported } = spyLoader();
    const run = activatePlugins({ names: ["trusted-name"], registry: reg, loader });
    await expect(run).rejects.toThrow(PluginLoaderError);
    await expect(run).rejects.toThrow(
      /^the plugin registry lists "trusted-name" at .*other-plugin[/\\]plugin\.json, but that manifest is plugin "other-plugin" — refusing to load it under "trusted-name"$/,
    );
    expect(imported).toEqual([]);
  });

  test("a pinned plugin loads only at its pin: an older signed release on disk is refused", async () => {
    // The rollback: the record and the pin say 2.0.0; the files are 1.0.0,
    // validly signed by the same publisher.
    const path = place("my-plugin", signed({ name: "my-plugin", version: "1.0.0" }));
    const reg = registry();
    await reg.register({
      manifest: signed({ name: "my-plugin", version: "2.0.0" }),
      sourcePath: path,
    });
    await reg.pin("my-plugin", "2.0.0");
    const { loader, imported } = spyLoader();
    await expect(activatePlugins({ names: ["my-plugin"], registry: reg, loader })).rejects.toThrow(
      /^plugin "my-plugin" is pinned to 2\.0\.0 in the plugin registry, but .*my-plugin[/\\]plugin\.json is version 1\.0\.0 — refusing to load it\. Install 2\.0\.0, or clear the pin\.$/,
    );
    expect(imported).toEqual([]);

    await reg.pin("my-plugin", "1.0.0");
    const activated = await activatePlugins({ names: ["my-plugin"], registry: reg, loader });
    expect(activated.loaded.map((p) => p.manifest.version)).toEqual(["1.0.0"]);
  });

  test("a host's own loader that ignores who is expected is still held to it", async () => {
    const other = place("other-plugin", signed({ name: "other-plugin", version: "1.0.0" }));
    const reg = registry();
    await reg.register({
      manifest: signed({ name: "listed", version: "1.0.0" }),
      sourcePath: other,
    });
    const { loader: real } = spyLoader();
    const careless: PluginLoader = { load: (p) => real.load(p) };
    await expect(
      activatePlugins({ names: ["listed"], registry: reg, loader: careless }),
    ).rejects.toThrow(/lists "listed" at .* but that manifest is plugin "other-plugin"/);
  });

  test("loader.load checks who is expected before it verifies or imports", async () => {
    const path = place("my-plugin", signed({ name: "my-plugin", version: "1.0.0" }));
    const { loader, imported } = spyLoader();
    await expect(loader.load(path, { name: "someone-else" })).rejects.toThrow(
      /lists "someone-else" at .* but that manifest is plugin "my-plugin"/,
    );
    await expect(loader.load(path, { version: "9.9.9" })).rejects.toThrow(/pinned to 9\.9\.9/);
    expect(imported).toEqual([]);
    expect((await loader.load(path, { name: "my-plugin", version: "1.0.0" })).signed).toBe(true);
  });
});

describe("a plugin changed in place since it was installed says so (C172)", () => {
  test("a newer version on disk than the record loads, with a note", async () => {
    const path = place("my-plugin", signed({ name: "my-plugin", version: "1.0.1" }));
    const reg = registry();
    await reg.register({
      manifest: signed({ name: "my-plugin", version: "1.0.0" }),
      sourcePath: path,
    });
    const activated = await activatePlugins({
      names: ["my-plugin"],
      registry: reg,
      loader: spyLoader().loader,
    });
    expect(activated.loaded.map((p) => p.manifest.version)).toEqual(["1.0.1"]);
    expect(activated.warnings).toEqual([
      `plugin "my-plugin": the install record says 1.0.0, but ${path} is 1.0.1. The plugin on disk is what loads; install it again to bring the record up to date.`,
    ]);
  });

  test("the same version with a different manifest is named too; an unchanged one says nothing", async () => {
    const path = place(
      "my-plugin",
      signed({ name: "my-plugin", version: "1.0.0", description: "changed" }),
    );
    const reg = registry();
    await reg.register({
      manifest: signed({ name: "my-plugin", version: "1.0.0" }),
      sourcePath: path,
    });
    const { loader } = spyLoader();
    const drifted = await activatePlugins({ names: ["my-plugin"], registry: reg, loader });
    expect(drifted.warnings).toEqual([
      `plugin "my-plugin": ${path} differs from its install record (both say 1.0.0). The plugin on disk is what loads; install it again to bring the record up to date.`,
    ]);

    rmSync(join(root, "registry.json"));
    const same = signed({ name: "my-plugin", version: "1.0.0" });
    const reg2 = registry();
    await reg2.register({ manifest: same, sourcePath: place("my-plugin", same) });
    const clean = await activatePlugins({ names: ["my-plugin"], registry: reg2, loader });
    expect(clean.warnings).toEqual([]);
  });
});
