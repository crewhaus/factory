import { describe, expect, test } from "bun:test";
import {
  PluginSdkError,
  canonicalJson,
  definePlugin,
  manifestPayloadForSigning,
  validatePluginManifest,
} from "./index";

describe("validatePluginManifest", () => {
  test("accepts a minimal valid manifest", () => {
    const m = validatePluginManifest({ name: "my-plugin", version: "1.2.3" });
    expect(m.name).toBe("my-plugin");
    expect(m.version).toBe("1.2.3");
  });

  test("accepts pre-release + build metadata in semver", () => {
    expect(() =>
      validatePluginManifest({ name: "my-plugin", version: "1.2.3-beta.1+build.42" }),
    ).not.toThrow();
  });

  test("rejects missing name", () => {
    expect(() => validatePluginManifest({ version: "1.0.0" })).toThrow(PluginSdkError);
  });

  test("rejects invalid name", () => {
    expect(() => validatePluginManifest({ name: "MyPlugin", version: "1.0.0" })).toThrow(
      PluginSdkError,
    );
    expect(() => validatePluginManifest({ name: "-leading", version: "1.0.0" })).toThrow(
      PluginSdkError,
    );
    expect(() => validatePluginManifest({ name: "trailing-", version: "1.0.0" })).toThrow(
      PluginSdkError,
    );
    expect(() => validatePluginManifest({ name: "1starts-with-digit", version: "1.0.0" })).toThrow(
      PluginSdkError,
    );
  });

  test("rejects non-semver version", () => {
    expect(() => validatePluginManifest({ name: "ok-name", version: "v1.2.3" })).toThrow(
      PluginSdkError,
    );
    expect(() => validatePluginManifest({ name: "ok-name", version: "1.2" })).toThrow(
      PluginSdkError,
    );
  });

  test("validates engines.crewhaus when present", () => {
    expect(() =>
      validatePluginManifest({
        name: "ok-name",
        version: "1.0.0",
        engines: { crewhaus: "^0.2.0" },
      }),
    ).not.toThrow();
    expect(() =>
      validatePluginManifest({
        name: "ok-name",
        version: "1.0.0",
        engines: { crewhaus: 42 },
      }),
    ).toThrow(PluginSdkError);
  });

  test("validates permissions arrays are string arrays", () => {
    expect(() =>
      validatePluginManifest({
        name: "ok-name",
        version: "1.0.0",
        permissions: { fs: ["read:./data/**"], net: ["fetch:https://api.example.com/**"] },
      }),
    ).not.toThrow();
    expect(() =>
      validatePluginManifest({
        name: "ok-name",
        version: "1.0.0",
        permissions: { fs: [42] },
      }),
    ).toThrow(PluginSdkError);
    expect(() =>
      validatePluginManifest({
        name: "ok-name",
        version: "1.0.0",
        permissions: { tools: "Bash" }, // must be array
      }),
    ).toThrow(PluginSdkError);
  });

  test("validates signature shape", () => {
    const ok = {
      name: "ok-name",
      version: "1.0.0",
      signature: {
        algorithm: "ed25519",
        publicKeyB64: "base64-data",
        sigB64: "base64-sig",
      },
    };
    expect(() => validatePluginManifest(ok)).not.toThrow();
  });

  test("rejects non-ed25519 algorithms", () => {
    expect(() =>
      validatePluginManifest({
        name: "ok-name",
        version: "1.0.0",
        signature: { algorithm: "rsa", publicKeyB64: "x", sigB64: "y" },
      }),
    ).toThrow(PluginSdkError);
  });

  test("rejects signature missing publicKeyB64 / sigB64", () => {
    expect(() =>
      validatePluginManifest({
        name: "ok-name",
        version: "1.0.0",
        signature: { algorithm: "ed25519", publicKeyB64: "x" },
      }),
    ).toThrow(PluginSdkError);
  });

  test("rejects non-object manifest", () => {
    expect(() => validatePluginManifest(null)).toThrow(PluginSdkError);
    expect(() => validatePluginManifest("not an object")).toThrow(PluginSdkError);
    expect(() => validatePluginManifest(42)).toThrow(PluginSdkError);
  });
});

describe("definePlugin", () => {
  test("returns the input unchanged on success", () => {
    const def = definePlugin({
      name: "my-plugin",
      version: "1.0.0",
      description: "demo",
    });
    expect(def.name).toBe("my-plugin");
    expect(def.description).toBe("demo");
  });

  test("throws on invalid manifest", () => {
    expect(() => definePlugin({ name: "MyPlugin", version: "1.0.0" } as never)).toThrow(
      PluginSdkError,
    );
  });

  test("carries contribution types through", () => {
    const def = definePlugin({
      name: "my-plugin",
      version: "1.0.0",
      contributions: {
        graders: [
          {
            id: "my-grader",
            async grade() {
              return { pass: true };
            },
          },
        ],
      },
    });
    expect(def.contributions?.graders?.length).toBe(1);
  });
});

describe("canonicalJson", () => {
  test("serialises primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("hi")).toBe('"hi"');
  });

  test("rejects non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(PluginSdkError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(PluginSdkError);
  });

  test("sorts object keys deterministically", () => {
    const a = canonicalJson({ z: 1, a: 2, m: 3 });
    const b = canonicalJson({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  test("recurses into nested objects + arrays", () => {
    const out = canonicalJson({
      list: [{ b: 2, a: 1 }, "str"],
      obj: { z: { y: 1 } },
    });
    expect(out).toBe('{"list":[{"a":1,"b":2},"str"],"obj":{"z":{"y":1}}}');
  });

  test("drops undefined keys", () => {
    const out = canonicalJson({ a: 1, b: undefined, c: 3 });
    expect(out).toBe('{"a":1,"c":3}');
  });
});

describe("manifestPayloadForSigning", () => {
  test("excludes signature from the canonical payload", () => {
    const manifest = {
      name: "my-plugin",
      version: "1.0.0",
      signature: {
        algorithm: "ed25519" as const,
        publicKeyB64: "pk",
        sigB64: "sig",
      },
    };
    const payload = manifestPayloadForSigning(manifest);
    expect(payload).not.toContain("signature");
    expect(payload).not.toContain("ed25519");
    expect(payload).toContain("my-plugin");
  });

  test("matches canonicalJson when no signature is present", () => {
    const manifest = { name: "my-plugin", version: "1.0.0" };
    expect(manifestPayloadForSigning(manifest)).toBe(canonicalJson(manifest));
  });

  test("signing payload is stable across signature mutations", () => {
    const base = { name: "my-plugin", version: "1.0.0", description: "demo" };
    const signed1 = {
      ...base,
      signature: { algorithm: "ed25519" as const, publicKeyB64: "a", sigB64: "b" },
    };
    const signed2 = {
      ...base,
      signature: { algorithm: "ed25519" as const, publicKeyB64: "c", sigB64: "d" },
    };
    expect(manifestPayloadForSigning(signed1)).toBe(manifestPayloadForSigning(signed2));
  });
});
