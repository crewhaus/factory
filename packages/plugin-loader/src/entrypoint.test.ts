/**
 * extension-path#10 (C170): the loader realpath'd the manifest but not the
 * entrypoint beside it, so an `index.js` that was a link to a file outside
 * the trusted root was hashed and imported from there, while the module
 * docstring promised the opposite. The entrypoint must now really be a
 * regular file inside the plugin's own directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PluginManifest,
  entrypointDigest,
  manifestPayloadForSigning,
} from "@crewhaus/plugin-sdk";
import { MAX_PLUGIN_MANIFEST_BYTES, PluginLoaderError, createPluginLoader } from "./index";

let root: string;
let outside: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-entry-root-"));
  outside = mkdtempSync(join(tmpdir(), "plugin-entry-outside-"));
  dir = join(root, "my-plugin");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const EVIL = "export default { evil: true };\n";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

function writeManifest(m: PluginManifest, key?: ReturnType<typeof keypair>["privateKey"]): string {
  const signed: PluginManifest =
    key === undefined
      ? m
      : {
          ...m,
          signature: {
            algorithm: "ed25519",
            publicKeyB64: "unused",
            sigB64: sign(null, Buffer.from(manifestPayloadForSigning(m), "utf8"), key).toString(
              "base64",
            ),
          },
        };
  const path = join(dir, "plugin.json");
  writeFileSync(path, JSON.stringify(signed));
  return path;
}

/** A loader whose import and digest read are recorded, so a test can say neither ran. */
function spyLoader(opts: { anchor?: string } = {}) {
  const seen = { imported: [] as string[], read: [] as string[] };
  const loader = createPluginLoader({
    trustedRoots: [root],
    ...(opts.anchor !== undefined
      ? { trustAnchors: [{ name: "t", publicKeyPem: opts.anchor }] }
      : { allowUnsigned: true }),
    warn: () => {},
    importEntrypoint: async (p) => {
      seen.imported.push(p);
      return { default: {} };
    },
    readEntrypoint: async (p) => {
      seen.read.push(p);
      return new TextEncoder().encode(EVIL);
    },
  });
  return { loader, seen };
}

describe("a plugin's index.js must really be inside its own directory (C170)", () => {
  test("an index.js linked to a file outside the trusted root is refused, and nothing is imported", async () => {
    writeFileSync(join(outside, "evil.js"), EVIL);
    symlinkSync(join(outside, "evil.js"), join(dir, "index.js"));
    const manifest = writeManifest({ name: "my-plugin", version: "1.0.0" });
    const { loader, seen } = spyLoader();
    const load = loader.load(manifest);
    await expect(load).rejects.toThrow(PluginLoaderError);
    await expect(load).rejects.toThrow(
      /^plugin "my-plugin": .*my-plugin[/\\]index\.js is a link that leads outside the plugin's directory .*; only code inside it is loaded — refusing to load it$/,
    );
    expect(seen).toEqual({ imported: [], read: [] });
  });

  test("a signed digest over the outside file does not make the link acceptable", async () => {
    // The digest binds content, not location: the signature is valid and the
    // bytes match, and it is still refused before they are read.
    const k = keypair();
    writeFileSync(join(outside, "evil.js"), EVIL);
    symlinkSync(join(outside, "evil.js"), join(dir, "index.js"));
    const manifest = writeManifest(
      {
        name: "my-plugin",
        version: "1.0.0",
        entrypointDigest: entrypointDigest(new TextEncoder().encode(EVIL)),
      },
      k.privateKey,
    );
    const { loader, seen } = spyLoader({ anchor: k.pem });
    await expect(loader.load(manifest)).rejects.toThrow(/leads outside the plugin's directory/);
    expect(seen).toEqual({ imported: [], read: [] });
  });

  test("a link into ANOTHER plugin's directory under the same root is refused too", async () => {
    mkdirSync(join(root, "other-plugin"));
    writeFileSync(join(root, "other-plugin", "index.js"), EVIL);
    symlinkSync(join(root, "other-plugin", "index.js"), join(dir, "index.js"));
    const manifest = writeManifest({ name: "my-plugin", version: "1.0.0" });
    const { loader, seen } = spyLoader();
    await expect(loader.load(manifest)).rejects.toThrow(/leads outside the plugin's directory/);
    expect(seen.imported).toEqual([]);
  });

  test("a link to a file inside the plugin's directory loads, and the real file is what is imported", async () => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.js"), "export default { ok: true };\n");
    symlinkSync(join("dist", "index.js"), join(dir, "index.js"));
    const manifest = writeManifest({ name: "my-plugin", version: "1.0.0" });
    const { loader, seen } = spyLoader();
    const loaded = await loader.load(manifest);
    expect(seen.imported).toEqual([realpathSync(join(dir, "dist", "index.js"))]);
    // The name the plugin is known by stays <dir>/index.js: its skills/ is found beside it.
    expect(loaded.entrypointPath).toBe(join(realpathSync(dir), "index.js"));
  });

  test("an index.js that is a FIFO is refused without being opened", async () => {
    const fifo = join(dir, "index.js");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);
    const manifest = writeManifest({
      name: "my-plugin",
      version: "1.0.0",
      entrypointDigest: entrypointDigest(new TextEncoder().encode(EVIL)),
    });
    // The real reader: a read that opened the FIFO would wait for a writer.
    const loader = createPluginLoader({
      trustedRoots: [root],
      allowUnsigned: true,
      warn: () => {},
    });
    await expect(loader.load(manifest)).rejects.toThrow(
      /^plugin "my-plugin": .*index\.js is a fifo, not a regular file — refusing to load it$/,
    );
  });

  test("an index.js that is a directory is refused by name", async () => {
    mkdirSync(join(dir, "index.js"));
    const manifest = writeManifest({ name: "my-plugin", version: "1.0.0" });
    const { loader, seen } = spyLoader();
    await expect(loader.load(manifest)).rejects.toThrow(
      /index\.js is a directory, not a regular file/,
    );
    expect(seen.imported).toEqual([]);
  });

  test("a regular index.js in place still loads, through the real reader and importer", async () => {
    const code = "export default { ok: 42 };\n";
    writeFileSync(join(dir, "index.js"), code);
    const manifest = writeManifest({
      name: "my-plugin",
      version: "1.0.0",
      entrypointDigest: entrypointDigest(new TextEncoder().encode(code)),
    });
    const loader = createPluginLoader({
      trustedRoots: [root],
      allowUnsigned: true,
      warn: () => {},
    });
    const loaded = await loader.load(manifest);
    expect(loaded.module.default).toEqual({ ok: 42 });
  });
});

describe("the manifest is read with a cap", () => {
  test("a plugin.json past the cap is refused, naming the cap", async () => {
    const path = join(dir, "plugin.json");
    writeFileSync(
      path,
      JSON.stringify({
        name: "my-plugin",
        version: "1.0.0",
        description: "x".repeat(MAX_PLUGIN_MANIFEST_BYTES),
      }),
    );
    const { loader, seen } = spyLoader();
    await expect(loader.load(path)).rejects.toThrow(
      `failed to read plugin manifest at ${realpathSync(path)}: it is larger than ${MAX_PLUGIN_MANIFEST_BYTES} bytes`,
    );
    expect(seen.imported).toEqual([]);
  });
});
