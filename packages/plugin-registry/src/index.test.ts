import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { type PluginManifest, manifestPayloadForSigning } from "@crewhaus/plugin-sdk";
import { PluginRegistryError, createPluginRegistry } from "./index";

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
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): PluginManifest {
  const payload = manifestPayloadForSigning(unsigned);
  const sigBuf = sign(null, Buffer.from(payload, "utf8"), privateKey);
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      publicKeyB64: "n/a",
      sigB64: sigBuf.toString("base64"),
    },
  };
}

/** In-memory file backend so we don't touch disk in tests. */
function makeMemFs(): {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, c: string) => void;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    exists: (p) => store.has(p),
    read: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    write: (p, c) => {
      store.set(p, c);
    },
  };
}

let mem: ReturnType<typeof makeMemFs>;
const REG_PATH = "/tmp/registry.json";

beforeEach(() => {
  mem = makeMemFs();
});

afterEach(() => {
  mem.store.clear();
});

describe("createPluginRegistry construction", () => {
  test("rejects empty registryPath", () => {
    expect(() => createPluginRegistry({ registryPath: "" })).toThrow(PluginRegistryError);
  });

  test("rejects trustAnchor of kind 'secret' without a secrets backend", () => {
    expect(() =>
      createPluginRegistry({
        registryPath: REG_PATH,
        trustAnchors: [{ kind: "secret", name: "prod", secretName: "TRUST_ANCHOR_PEM" }],
      }),
    ).toThrow(PluginRegistryError);
  });
});

describe("register / list / get / unregister", () => {
  test("registers + lists + gets", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      allowUnsigned: true,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha/manifest.json",
    });
    await reg.register({
      manifest: { name: "beta", version: "2.0.0" },
      sourcePath: "/p/beta/manifest.json",
    });
    const list = await reg.list();
    expect(list.length).toBe(2);
    expect(list[0]?.manifest.name).toBe("alpha");
    expect(list[1]?.manifest.name).toBe("beta");
    const alpha = await reg.get("alpha");
    expect(alpha?.manifest.version).toBe("1.0.0");
    const missing = await reg.get("missing");
    expect(missing).toBeUndefined();
  });

  test("returns empty list when registry file does not exist", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    expect((await reg.list()).length).toBe(0);
  });

  test("rejects duplicate name from different sourcePath without replace", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha/manifest.json",
    });
    let caught: Error | undefined;
    try {
      await reg.register({
        manifest: { name: "alpha", version: "1.1.0" },
        sourcePath: "/elsewhere/manifest.json",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginRegistryError);
    expect(caught?.message).toContain("already registered");
  });

  test("allows replace: true to overwrite", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha/manifest.json",
    });
    await reg.register({
      manifest: { name: "alpha", version: "2.0.0" },
      sourcePath: "/p/alpha/manifest.json",
      replace: true,
    });
    const alpha = await reg.get("alpha");
    expect(alpha?.manifest.version).toBe("2.0.0");
  });

  test("unregister is a no-op when entry missing", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.unregister("never-existed");
    expect((await reg.list()).length).toBe(0);
  });

  test("unregister removes the entry", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha/manifest.json",
    });
    await reg.unregister("alpha");
    expect(await reg.get("alpha")).toBeUndefined();
  });
});

describe("pin", () => {
  test("sets and clears the pinned version", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha/manifest.json",
    });
    let entry = await reg.pin("alpha", "1.0.0");
    expect(entry.pinnedVersion).toBe("1.0.0");
    entry = await reg.pin("alpha", "");
    expect(entry.pinnedVersion).toBeUndefined();
  });

  test("rejects pin on unknown plugin", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    let caught: Error | undefined;
    try {
      await reg.pin("missing", "1.0.0");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginRegistryError);
  });
});

describe("verifyEntry", () => {
  test("verifies a signed plugin against a PEM trust anchor", async () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const signed = signManifest({ name: "alpha", version: "1.0.0" }, privateKey);
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "test", publicKeyPem }],
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({ manifest: signed, sourcePath: "/p/alpha/manifest.json" });
    expect(await reg.verifyEntry("alpha")).toBe(true);
  });

  test("rejects mismatched signature", async () => {
    const { publicKeyPem: trustedPem } = makeKeypair();
    const { privateKey: untrustedKey } = makeKeypair();
    const signed = signManifest({ name: "alpha", version: "1.0.0" }, untrustedKey);
    // Persist the wrong-key manifest through a registry with no anchors (the
    // read-only registry a boot builds), so verifyEntry's rejection is what
    // is exercised. A registry WITH the anchor refuses it at register, even
    // under allowUnsigned (see "a signature that is present must verify").
    await createPluginRegistry({
      registryPath: REG_PATH,
      allowUnsigned: true,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    }).register({ manifest: signed, sourcePath: "/p/alpha/manifest.json" });
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "trusted", publicKeyPem: trustedPem }],
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    let caught: Error | undefined;
    try {
      await reg.verifyEntry("alpha");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginRegistryError);
    expect(caught?.message).toContain("does not verify");
  });

  test("rejects unsigned manifest", async () => {
    const { publicKeyPem } = makeKeypair();
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "trusted", publicKeyPem }],
      // Bypass the register-time check so we can persist an unsigned manifest
      // and exercise verifyEntry's rejection specifically.
      allowUnsigned: true,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha/manifest.json",
    });
    let caught: Error | undefined;
    try {
      await reg.verifyEntry("alpha");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginRegistryError);
    expect(caught?.message).toContain("unsigned");
  });

  test("rejects when entry not found", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "x", publicKeyPem: "x" }],
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    let caught: Error | undefined;
    try {
      await reg.verifyEntry("nope");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginRegistryError);
  });

  test("rejects when no anchors configured", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    const { privateKey } = makeKeypair();
    const signed = signManifest({ name: "alpha", version: "1.0.0" }, privateKey);
    await reg.register({ manifest: signed, sourcePath: "/p/alpha/manifest.json" });
    let caught: Error | undefined;
    try {
      await reg.verifyEntry("alpha");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginRegistryError);
    expect(caught?.message).toContain("no trustAnchors");
  });

  test("resolves trust anchors via secrets backend", async () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const signed = signManifest({ name: "alpha", version: "1.0.0" }, privateKey);
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "secret", name: "prod", secretName: "TRUST_ANCHOR_PEM" }],
      secrets: {
        backendId: "env-var",
        async get(name) {
          if (name === "TRUST_ANCHOR_PEM") return publicKeyPem;
          throw new Error("unknown secret");
        },
        async rotate() {
          throw new Error("not used");
        },
        onRotation() {
          return () => {};
        },
        async doctor() {
          return { backend: "env-var", available: [], missing: [], rotationDue: [] };
        },
      },
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({ manifest: signed, sourcePath: "/p/alpha/manifest.json" });
    expect(await reg.verifyEntry("alpha")).toBe(true);
  });
});

// SECURITY: register() must not persist a forged/unsigned manifest into the
// on-disk registry when trust anchors are configured — those entries are
// surfaced to hosts (and folded into aggregatedPermissions) as trusted.
describe("register signature verification (fail-closed)", () => {
  test("refuses to register an unsigned manifest under trust anchors", async () => {
    const { publicKeyPem } = makeKeypair();
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "trusted", publicKeyPem }],
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await expect(
      reg.register({ manifest: { name: "alpha", version: "1.0.0" }, sourcePath: "/p/alpha" }),
    ).rejects.toThrow(/unsigned/);
  });

  test("refuses to register a wrong-key signed manifest under trust anchors", async () => {
    const { publicKeyPem: trustedPem } = makeKeypair();
    const { privateKey: untrustedKey } = makeKeypair();
    const signed = signManifest({ name: "alpha", version: "1.0.0" }, untrustedKey);
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "trusted", publicKeyPem: trustedPem }],
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await expect(reg.register({ manifest: signed, sourcePath: "/p/alpha" })).rejects.toThrow(
      /verification failed/,
    );
  });

  test("registers a correctly-signed manifest", async () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const signed = signManifest({ name: "alpha", version: "1.0.0" }, privateKey);
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "trusted", publicKeyPem }],
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    const entry = await reg.register({ manifest: signed, sourcePath: "/p/alpha" });
    expect(entry.manifest.name).toBe("alpha");
  });

  // extension-path#2 (C015): allowUnsigned used to skip the check entirely,
  // so `plugins install --allow-unsigned` persisted a FORGED signature as
  // readily as a missing one — and the loader then refused it at every boot.
  test("a signature that is present must verify, even under allowUnsigned", async () => {
    const { publicKeyPem: trustedPem, privateKey: trustedKey } = makeKeypair();
    const { privateKey: untrustedKey } = makeKeypair();
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "trusted", publicKeyPem: trustedPem }],
      allowUnsigned: true,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    const forged = signManifest({ name: "alpha", version: "1.0.0" }, untrustedKey);
    await expect(reg.verifyManifest?.(forged)).rejects.toThrow(/verification failed/);
    await expect(reg.register({ manifest: forged, sourcePath: "/p/alpha" })).rejects.toThrow(
      /signature verification failed for plugin "alpha" — not registered/,
    );
    expect(await reg.get("alpha")).toBeUndefined();
    // Unsigned is what allowUnsigned allows; a good signature still registers.
    await reg.register({ manifest: { name: "beta", version: "1.0.0" }, sourcePath: "/p/beta" });
    const good = signManifest({ name: "gamma", version: "1.0.0" }, trustedKey);
    await expect(reg.verifyManifest?.(good)).resolves.toBeUndefined();
    await reg.register({ manifest: good, sourcePath: "/p/gamma" });
    expect((await reg.list()).map((e) => e.manifest.name)).toEqual(["beta", "gamma"]);
  });

  test("verifyManifest refuses what register would, and writes nothing", async () => {
    const { publicKeyPem } = makeKeypair();
    const writes: string[] = [];
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      trustAnchors: [{ kind: "pem", name: "trusted", publicKeyPem }],
      readFileImpl: mem.read,
      writeFileImpl: (p, c) => {
        writes.push(p);
        mem.write(p, c);
      },
      existsImpl: mem.exists,
    });
    await expect(reg.verifyManifest?.({ name: "alpha", version: "1.0.0" })).rejects.toThrow(
      /refusing to register unsigned plugin "alpha"/,
    );
    expect(writes).toEqual([]);
  });

  test("allows an unsigned manifest when NO trust anchors are configured (back-compat)", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    const entry = await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha",
    });
    expect(entry.manifest.name).toBe("alpha");
  });
});

describe("aggregatedPermissions", () => {
  test("unions permissions across all entries", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await reg.register({
      manifest: {
        name: "alpha",
        version: "1.0.0",
        permissions: {
          fs: ["read:/data/**"],
          net: ["fetch:https://api.alpha/**"],
          tools: ["WebFetch"],
        },
      },
      sourcePath: "/p/alpha/manifest.json",
    });
    await reg.register({
      manifest: {
        name: "beta",
        version: "1.0.0",
        permissions: {
          fs: ["read:/data/**", "write:/tmp/**"],
          net: ["fetch:https://api.beta/**"],
          tools: ["Bash"],
          secrets: ["OPENAI_API_KEY"],
        },
      },
      sourcePath: "/p/beta/manifest.json",
    });
    const agg = await reg.aggregatedPermissions();
    expect(agg.fs).toEqual(["read:/data/**", "write:/tmp/**"]);
    expect(agg.net).toEqual(["fetch:https://api.alpha/**", "fetch:https://api.beta/**"]);
    expect(agg.tools).toEqual(["Bash", "WebFetch"]);
    expect(agg.secrets).toEqual(["OPENAI_API_KEY"]);
  });

  test("returns empty arrays when no entries", async () => {
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    const agg = await reg.aggregatedPermissions();
    expect(agg.fs).toEqual([]);
    expect(agg.net).toEqual([]);
    expect(agg.tools).toEqual([]);
    expect(agg.secrets).toEqual([]);
  });
});

describe("parseRegistryFile edge cases", () => {
  test("rejects unsupported file version", async () => {
    mem.store.set(REG_PATH, JSON.stringify({ version: "999", entries: {} }));
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    let caught: Error | undefined;
    try {
      await reg.list();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginRegistryError);
    expect(caught?.message).toContain("not supported");
  });

  // C172: an entry keyed by one name but holding another plugin's manifest
  // made list/outdated describe one plugin while activation loaded another.
  test("rejects an entry whose key is not its manifest's name, naming both", async () => {
    mem.store.set(
      REG_PATH,
      JSON.stringify({
        version: "1",
        entries: {
          a: {
            manifest: { name: "bee", version: "1.0.0" },
            sourcePath: "/x/plugin.json",
            installedAt: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    await expect(reg.list()).rejects.toThrow(
      'plugin-registry: entry "a" holds the manifest of plugin "bee"; an entry must be keyed by its plugin\'s name',
    );
    await expect(reg.get("a")).rejects.toThrow(PluginRegistryError);
  });

  test("rejects malformed JSON", async () => {
    mem.store.set(REG_PATH, "{not json");
    const reg = createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });
    let caught: Error | undefined;
    try {
      await reg.list();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(PluginRegistryError);
  });
});

// Review of 0.7.1: validatePluginManifest learned `provides` and `notAfter`,
// fields 0.7.0 ignored, and the registry read every entry with it. One
// install record written by 0.7.0 with `"provides": [...]` or a date-only
// `notAfter` made the whole file unreadable, so every plugin failed to load,
// and the message named neither the entry nor the file.
describe("a record 0.7.0 wrote still reads (review of 0.7.1)", () => {
  const record = (manifest: Record<string, unknown>) => ({
    manifest,
    sourcePath: `/plugins/${String(manifest["name"])}/plugin.json`,
    installedAt: "2026-01-01T00:00:00Z",
  });
  const registry = () =>
    createPluginRegistry({
      registryPath: REG_PATH,
      readFileImpl: mem.read,
      writeFileImpl: mem.write,
      existsImpl: mem.exists,
    });

  test("fields 0.7.0 ignored, in any shape, do not stop the file from being read", async () => {
    mem.store.set(
      REG_PATH,
      JSON.stringify({
        version: "1",
        entries: {
          "acme-notes": record({
            name: "acme-notes",
            version: "1.0.0",
            provides: ["notes_search"],
            notAfter: "2027-01-01",
          }),
          "weather-tools": record({ name: "weather-tools", version: "2.0.0" }),
        },
      }),
    );
    const reg = registry();
    expect((await reg.list()).map((e) => e.manifest.name)).toEqual(["acme-notes", "weather-tools"]);
    expect((await reg.get("weather-tools"))?.manifest.version).toBe("2.0.0");
    // Kept as written: the loader, not the registry, refuses the plugin for them.
    expect((await reg.get("acme-notes"))?.manifest).toMatchObject({
      provides: ["notes_search"],
      notAfter: "2027-01-01",
    });
  });

  test("an entry the registry cannot read is named, with the file", async () => {
    mem.store.set(
      REG_PATH,
      JSON.stringify({
        version: "1",
        entries: {
          "acme-notes": record({ name: "acme-notes", version: "one" }),
          "weather-tools": record({ name: "weather-tools", version: "2.0.0" }),
        },
      }),
    );
    await expect(registry().list()).rejects.toThrow(
      `plugin-registry: entry "acme-notes" in ${REG_PATH}: plugin manifest: \`version\` must be semver-shaped (got "one"). Remove or reinstall that plugin`,
    );
  });
});
