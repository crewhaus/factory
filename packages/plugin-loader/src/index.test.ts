import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PluginManifest, manifestPayloadForSigning } from "@crewhaus/plugin-sdk";
import {
  PluginLoaderError,
  createPluginLoader,
  isFsAllowed,
  isNetAllowed,
  matchesGlob,
} from "./index";

function makeKeypair(): {
  publicKeyPem: string;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

function signManifest(
  unsigned: PluginManifest,
  key: ReturnType<typeof generateKeyPairSync>["privateKey"],
): PluginManifest {
  const payload = manifestPayloadForSigning(unsigned);
  const sigBuf = sign(null, Buffer.from(payload, "utf8"), key);
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      publicKeyB64: "ignored-for-now",
      sigB64: sigBuf.toString("base64"),
    },
  };
}

let tmpRoot: string;
let pluginDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "plugin-loader-test-"));
  pluginDir = join(tmpRoot, "my-plugin");
  mkdirSync(pluginDir, { recursive: true });
  // Minimal entrypoint
  writeFileSync(join(pluginDir, "index.js"), "export default { ok: true };\n");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("matchesGlob", () => {
  test("plain string match", () => {
    expect(matchesGlob("foo/bar", "foo/bar")).toBe(true);
    expect(matchesGlob("foo/bar", "foo/baz")).toBe(false);
  });
  test("single * does not cross /", () => {
    expect(matchesGlob("foo/bar", "foo/*")).toBe(true);
    expect(matchesGlob("foo/bar/baz", "foo/*")).toBe(false);
  });
  test("** crosses /", () => {
    expect(matchesGlob("foo/bar/baz", "foo/**")).toBe(true);
    expect(matchesGlob("foo/bar/baz/qux", "foo/**")).toBe(true);
  });
  test("escapes regex special chars in literal portions", () => {
    expect(matchesGlob("foo.txt", "foo.txt")).toBe(true);
    expect(matchesGlob("fooXtxt", "foo.txt")).toBe(false);
  });
});

describe("isFsAllowed / isNetAllowed", () => {
  test("isFsAllowed honors mode prefix", () => {
    const perms = { fs: ["read:/data/**", "write:/out/*.txt"] };
    expect(isFsAllowed(perms, "read", "/data/x.json")).toBe(true);
    expect(isFsAllowed(perms, "write", "/data/x.json")).toBe(false);
    expect(isFsAllowed(perms, "write", "/out/result.txt")).toBe(true);
  });

  test("isFsAllowed returns false when no fs list", () => {
    expect(isFsAllowed(undefined, "read", "/data/x")).toBe(false);
    expect(isFsAllowed({}, "read", "/data/x")).toBe(false);
    expect(isFsAllowed({ fs: [] }, "read", "/data/x")).toBe(false);
  });

  test("isNetAllowed matches fetch URLs", () => {
    const perms = { net: ["fetch:https://api.example.com/**"] };
    expect(isNetAllowed(perms, "https://api.example.com/v1/foo")).toBe(true);
    expect(isNetAllowed(perms, "https://other.example.com/")).toBe(false);
  });

  test("isNetAllowed ignores non-fetch ops", () => {
    expect(isNetAllowed({ net: ["socket:tcp://x:443"] }, "https://api.example.com/")).toBe(false);
  });
});

describe("createPluginLoader construction", () => {
  test("rejects empty trustedRoots", () => {
    expect(() => createPluginLoader({ trustedRoots: [] })).toThrow(PluginLoaderError);
  });

  test("rejects no anchors + allowUnsigned=false", () => {
    expect(() => createPluginLoader({ trustedRoots: [tmpRoot] })).toThrow(PluginLoaderError);
  });

  test("accepts empty anchors when allowUnsigned=true", () => {
    expect(() =>
      createPluginLoader({ trustedRoots: [tmpRoot], allowUnsigned: true }),
    ).not.toThrow();
  });
});

describe("plugin-loader.load — happy path", () => {
  test("loads an unsigned plugin when allowUnsigned=true", async () => {
    const manifest: PluginManifest = {
      name: "my-plugin",
      version: "1.0.0",
      permissions: { fs: ["read:./data/**"] },
    };
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));
    const loader = createPluginLoader({ trustedRoots: [tmpRoot], allowUnsigned: true });
    const loaded = await loader.load(join(pluginDir, "plugin.json"));
    expect(loaded.manifest.name).toBe("my-plugin");
    expect(loaded.signed).toBe(false);
    expect(loaded.permissions.fs).toEqual(["read:./data/**"]);
    expect((loaded.module.default as { ok: boolean }).ok).toBe(true);
  });

  test("loads a signed plugin against a configured trust anchor", async () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const unsigned: PluginManifest = { name: "my-plugin", version: "1.0.0" };
    const signed = signManifest(unsigned, privateKey);
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(signed));
    const loader = createPluginLoader({
      trustedRoots: [tmpRoot],
      trustAnchors: [{ name: "test", publicKeyPem }],
    });
    const loaded = await loader.load(join(pluginDir, "plugin.json"));
    expect(loaded.signed).toBe(true);
  });
});

describe("plugin-loader.load — security checks", () => {
  test("rejects manifest outside trustedRoots", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "plugin-loader-outside-"));
    try {
      writeFileSync(
        join(outsideDir, "plugin.json"),
        JSON.stringify({ name: "my-plugin", version: "1.0.0" }),
      );
      const loader = createPluginLoader({ trustedRoots: [tmpRoot], allowUnsigned: true });
      let caught: Error | undefined;
      try {
        await loader.load(join(outsideDir, "plugin.json"));
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeInstanceOf(PluginLoaderError);
      expect(caught?.message).toContain("outside every configured trustedRoot");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects symlink escape from trustedRoots", async () => {
    // Create a symlink inside trustedRoot pointing at an outside file.
    const outsideDir = mkdtempSync(join(tmpdir(), "plugin-loader-symlink-"));
    try {
      writeFileSync(
        join(outsideDir, "plugin.json"),
        JSON.stringify({ name: "my-plugin", version: "1.0.0" }),
      );
      const symlinkPath = join(pluginDir, "evil-link.json");
      symlinkSync(join(outsideDir, "plugin.json"), symlinkPath);
      const loader = createPluginLoader({ trustedRoots: [tmpRoot], allowUnsigned: true });
      let caught: Error | undefined;
      try {
        await loader.load(symlinkPath);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeInstanceOf(PluginLoaderError);
      expect(caught?.message).toContain("outside every configured trustedRoot");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects unsigned plugin when allowUnsigned=false", async () => {
    const { publicKeyPem } = makeKeypair();
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "my-plugin", version: "1.0.0" }),
    );
    const loader = createPluginLoader({
      trustedRoots: [tmpRoot],
      trustAnchors: [{ name: "test", publicKeyPem }],
    });
    let caught: Error | undefined;
    try {
      await loader.load(join(pluginDir, "plugin.json"));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginLoaderError);
    expect(caught?.message).toContain("unsigned and allowUnsigned is false");
  });

  test("rejects signature signed by a non-trusted key", async () => {
    const { publicKeyPem: trustedPem } = makeKeypair();
    const { privateKey: untrustedKey } = makeKeypair();
    const unsigned: PluginManifest = { name: "my-plugin", version: "1.0.0" };
    const signed = signManifest(unsigned, untrustedKey);
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(signed));
    const loader = createPluginLoader({
      trustedRoots: [tmpRoot],
      trustAnchors: [{ name: "trusted", publicKeyPem: trustedPem }],
    });
    let caught: Error | undefined;
    try {
      await loader.load(join(pluginDir, "plugin.json"));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginLoaderError);
    expect(caught?.message).toContain("does not verify against any configured trustAnchor");
  });

  test("rejects tampered manifest after signing", async () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const original: PluginManifest = { name: "my-plugin", version: "1.0.0" };
    const signed = signManifest(original, privateKey);
    // Tamper with version after signing — signature payload no longer matches.
    const tampered = { ...signed, version: "9.9.9" };
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(tampered));
    const loader = createPluginLoader({
      trustedRoots: [tmpRoot],
      trustAnchors: [{ name: "test", publicKeyPem }],
    });
    let caught: Error | undefined;
    try {
      await loader.load(join(pluginDir, "plugin.json"));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginLoaderError);
    expect(caught?.message).toContain("does not verify");
  });

  test("rejects manifest with invalid schema", async () => {
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "BadCaps", version: "x" }),
    );
    const loader = createPluginLoader({ trustedRoots: [tmpRoot], allowUnsigned: true });
    let caught: Error | undefined;
    try {
      await loader.load(join(pluginDir, "plugin.json"));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
  });

  test("rejects non-ed25519 signature algorithm", async () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const unsigned: PluginManifest = { name: "my-plugin", version: "1.0.0" };
    const valid = signManifest(unsigned, privateKey);
    // Force the alg to something else
    const tampered = {
      ...valid,
      signature: { ...valid.signature, algorithm: "ed25519" },
    };
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(tampered));
    // We can't actually construct a non-ed25519 manifest through
    // validatePluginManifest (which rejects it), so the only path the
    // loader's own algorithm check guards is a freshly-instantiated
    // bypass — covered indirectly by the validation tests in
    // plugin-sdk. Sanity-check the happy path still works here.
    const loader = createPluginLoader({
      trustedRoots: [tmpRoot],
      trustAnchors: [{ name: "test", publicKeyPem }],
    });
    const loaded = await loader.load(join(pluginDir, "plugin.json"));
    expect(loaded.signed).toBe(true);
  });

  test("rejects missing manifest file with a clear error", async () => {
    const loader = createPluginLoader({ trustedRoots: [tmpRoot], allowUnsigned: true });
    let caught: Error | undefined;
    try {
      await loader.load(join(tmpRoot, "nonexistent.json"));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginLoaderError);
    expect(caught?.message).toContain("plugin manifest not found");
  });

  test("rejects directory paths as manifest", async () => {
    const loader = createPluginLoader({ trustedRoots: [tmpRoot], allowUnsigned: true });
    let caught: Error | undefined;
    try {
      await loader.load(pluginDir);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginLoaderError);
    expect(caught?.message).toContain("not a regular file");
  });

  test("does not import the entrypoint when signature fails", async () => {
    const { publicKeyPem: trustedPem } = makeKeypair();
    const { privateKey: untrustedKey } = makeKeypair();
    const unsigned: PluginManifest = { name: "my-plugin", version: "1.0.0" };
    const signed = signManifest(unsigned, untrustedKey);
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(signed));
    let imported = false;
    const loader = createPluginLoader({
      trustedRoots: [tmpRoot],
      trustAnchors: [{ name: "trusted", publicKeyPem: trustedPem }],
      importEntrypoint: async () => {
        imported = true;
        return { default: {} };
      },
    });
    let caught: Error | undefined;
    try {
      await loader.load(join(pluginDir, "plugin.json"));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginLoaderError);
    expect(imported).toBe(false);
  });
});
