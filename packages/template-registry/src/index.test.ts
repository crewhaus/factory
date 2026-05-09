import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpRegistrySource,
  LocalRegistrySource,
  type RegistrySource,
  type TemplateManifest,
  TemplateRegistryError,
  _canonicalManifestJsonForTest,
  _defaultTtlMsForTest,
  cachedRegistry,
  generateSigningKeypair,
  signManifest,
  verifyManifest,
  verifyingRegistry,
} from "./index";

const baseManifest = {
  name: "hello-cli-template",
  version: "1.0.0",
  description: "A CLI hello-world template",
  author: "test",
  target: "cli",
  yaml: "name: hello\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n",
};

describe("Canonical JSON + signing (T1)", () => {
  test("canonicalManifestJson is stable", () => {
    const a = _canonicalManifestJsonForTest({ ...baseManifest });
    const b = _canonicalManifestJsonForTest({ ...baseManifest });
    expect(a).toBe(b);
  });

  test("signManifest + verifyManifest round-trip", () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const sig = signManifest({ ...baseManifest, publicKey }, privateKey);
    const manifest: TemplateManifest = { ...baseManifest, publicKey, signature: sig };
    const result = verifyManifest(manifest, { publicKeys: [publicKey] });
    expect(result.ok).toBe(true);
  });

  test("verifyManifest rejects tampered yaml", () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const sig = signManifest({ ...baseManifest, publicKey }, privateKey);
    const manifest: TemplateManifest = {
      ...baseManifest,
      yaml: "tampered: true\n",
      publicKey,
      signature: sig,
    };
    const result = verifyManifest(manifest, { publicKeys: [publicKey] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("signature does not verify");
  });

  test("verifyManifest rejects unsigned manifest", () => {
    const manifest: TemplateManifest = { ...baseManifest };
    const result = verifyManifest(manifest, { publicKeys: ["x"] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsigned/);
  });

  test("verifyManifest rejects missing publicKey", () => {
    const manifest: TemplateManifest = { ...baseManifest, signature: "abc" };
    const result = verifyManifest(manifest, { publicKeys: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing publicKey/);
  });

  test("verifyManifest rejects publicKey not in trust root", () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const sig = signManifest({ ...baseManifest, publicKey }, privateKey);
    const manifest: TemplateManifest = { ...baseManifest, publicKey, signature: sig };
    // Trust a DIFFERENT key.
    const other = generateSigningKeypair();
    const result = verifyManifest(manifest, { publicKeys: [other.publicKey] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not in trust root/);
  });
});

describe("LocalRegistrySource (T1)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "template-registry-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("put + fetch round-trip", async () => {
    const src = new LocalRegistrySource({ rootDir: tmp });
    const manifest: TemplateManifest = { ...baseManifest };
    src.put(manifest);
    const fetched = await src.fetch("hello-cli-template");
    expect(fetched.name).toBe("hello-cli-template");
    expect(fetched.yaml).toBe(baseManifest.yaml);
  });

  test("metadata strips yaml field", async () => {
    const src = new LocalRegistrySource({ rootDir: tmp });
    src.put({ ...baseManifest });
    const meta = await src.metadata("hello-cli-template");
    expect("yaml" in meta).toBe(false);
    expect(meta.target).toBe("cli");
  });

  test("list returns metadata for all manifests, sorted", async () => {
    const src = new LocalRegistrySource({ rootDir: tmp });
    src.put({ ...baseManifest, name: "zebra" });
    src.put({ ...baseManifest, name: "alpha" });
    const list = await src.list();
    expect(list.map((m) => m.name)).toEqual(["alpha", "zebra"]);
  });

  test("fetch unknown template throws", async () => {
    const src = new LocalRegistrySource({ rootDir: tmp });
    await expect(src.fetch("ghost")).rejects.toThrow(TemplateRegistryError);
  });

  test("rejects malformed template names (path traversal)", () => {
    const src = new LocalRegistrySource({ rootDir: tmp });
    expect(() => src.put({ ...baseManifest, name: "../escape" })).toThrow(/invalid template name/);
    expect(() => src.put({ ...baseManifest, name: "evil/template" })).toThrow(
      /invalid template name/,
    );
  });

  test("requires rootDir", () => {
    expect(() => new LocalRegistrySource({ rootDir: "" })).toThrow(TemplateRegistryError);
  });
});

describe("HttpRegistrySource (T1)", () => {
  test("list parses templates[] from JSON", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          templates: [
            { ...baseManifest, name: "remote-a" },
            { ...baseManifest, name: "remote-b" },
          ].map(({ yaml: _y, ...rest }) => rest),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const src = new HttpRegistrySource({
      id: "git",
      listUrl: "https://example.test/list",
      fetchUrl: (n) => `https://example.test/fetch/${n}`,
      fetchImpl,
    });
    const list = await src.list();
    expect(list.map((m) => m.name).sort()).toEqual(["remote-a", "remote-b"]);
  });

  test("list throws on non-2xx", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const src = new HttpRegistrySource({
      id: "git",
      listUrl: "https://example.test/list",
      fetchUrl: (n) => `https://example.test/fetch/${n}`,
      fetchImpl,
    });
    await expect(src.list()).rejects.toThrow(/git list 404/);
  });

  test("list throws when payload missing templates[]", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ wrong: true }), { status: 200 })) as unknown as typeof fetch;
    const src = new HttpRegistrySource({
      id: "huggingface",
      listUrl: "https://hf.test/list",
      fetchUrl: (n) => `https://hf.test/${n}`,
      fetchImpl,
    });
    await expect(src.list()).rejects.toThrow(/missing templates\[\]/);
  });
});

describe("cachedRegistry — TTL caching (T9)", () => {
  test("repeated list calls within TTL hit the cache", async () => {
    let listCalls = 0;
    const upstream: RegistrySource = {
      id: "upstream",
      async list() {
        listCalls += 1;
        return [];
      },
      async fetch() {
        throw new Error("not used");
      },
      async metadata() {
        throw new Error("not used");
      },
    };
    let now = 1_000;
    const cached = cachedRegistry({ source: upstream, now: () => now, ttlMs: 1_000 });
    await cached.list();
    await cached.list();
    expect(listCalls).toBe(1);
    now += 1_500; // past TTL
    await cached.list();
    expect(listCalls).toBe(2);
  });

  test("refresh() clears the cache", async () => {
    let calls = 0;
    const upstream: RegistrySource = {
      id: "u",
      async list() {
        calls += 1;
        return [];
      },
      async fetch() {
        throw new Error("nope");
      },
      async metadata() {
        throw new Error("nope");
      },
    };
    const cached = cachedRegistry({ source: upstream, ttlMs: 60_000 });
    await cached.list();
    await cached.list();
    expect(calls).toBe(1);
    cached.refresh();
    await cached.list();
    expect(calls).toBe(2);
  });

  test("default TTL is 60 minutes", () => {
    expect(_defaultTtlMsForTest).toBe(60 * 60 * 1000);
  });
});

describe("verifyingRegistry — T8 supply-chain check", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "template-registry-verify-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("fetch verifies signature against trust root", async () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const sig = signManifest({ ...baseManifest, publicKey }, privateKey);
    const local = new LocalRegistrySource({ rootDir: tmp });
    local.put({ ...baseManifest, publicKey, signature: sig });
    const verifying = verifyingRegistry({
      source: local,
      trustRoot: { publicKeys: [publicKey] },
    });
    const fetched = await verifying.fetch("hello-cli-template");
    expect(fetched.name).toBe("hello-cli-template");
  });

  test("fetch refuses unverified manifest", async () => {
    const local = new LocalRegistrySource({ rootDir: tmp });
    local.put({ ...baseManifest }); // no signature
    const { publicKey } = generateSigningKeypair();
    const verifying = verifyingRegistry({
      source: local,
      trustRoot: { publicKeys: [publicKey] },
    });
    await expect(verifying.fetch("hello-cli-template")).rejects.toThrow(
      /failed signature verification/,
    );
  });

  test("fetch refuses tampered manifest", async () => {
    const { privateKey, publicKey } = generateSigningKeypair();
    const sig = signManifest({ ...baseManifest, publicKey }, privateKey);
    const local = new LocalRegistrySource({ rootDir: tmp });
    local.put({ ...baseManifest, publicKey, signature: sig, yaml: "evil: true" });
    const verifying = verifyingRegistry({
      source: local,
      trustRoot: { publicKeys: [publicKey] },
    });
    await expect(verifying.fetch("hello-cli-template")).rejects.toThrow(
      /signature does not verify/,
    );
  });

  test("fetch refuses signature from untrusted key", async () => {
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    const sig = signManifest({ ...baseManifest, publicKey: a.publicKey }, a.privateKey);
    const local = new LocalRegistrySource({ rootDir: tmp });
    local.put({ ...baseManifest, publicKey: a.publicKey, signature: sig });
    const verifying = verifyingRegistry({
      source: local,
      trustRoot: { publicKeys: [b.publicKey] }, // trust a different key only
    });
    await expect(verifying.fetch("hello-cli-template")).rejects.toThrow(/not in trust root/);
  });
});
