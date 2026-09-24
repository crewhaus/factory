/**
 * extension-path#9 (C108): a plugin signature proved little. A signed
 * manifest with no entrypointDigest loaded as signed:true whatever index.js
 * held; only index.js was hashed, so a tampered `./lib.js` it imported ran as
 * "signed"; the file was read for the digest and then read again by
 * `import()`; and `signature.issuedAt` sits outside what is signed, so
 * nothing could give a signature an end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type PluginManifest,
  entrypointDigest,
  manifestPayloadForSigning,
} from "@crewhaus/plugin-sdk";
import { PluginLoaderError, createPluginLoader } from "./index";

let root: string;
let dir: string;
let key: ReturnType<typeof generateKeyPairSync>["privateKey"];
let pem: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-signing-"));
  dir = join(root, "my-plugin");
  mkdirSync(dir, { recursive: true });
  const pair = generateKeyPairSync("ed25519");
  key = pair.privateKey;
  pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const digestOf = (code: string) => entrypointDigest(new TextEncoder().encode(code));

/** Write index.js (+ any siblings) and a manifest signed with `key` unless `unsigned`. */
function install(
  code: string,
  manifest: Partial<PluginManifest> = {},
  opts: { unsigned?: boolean; files?: Record<string, string> } = {},
): string {
  writeFileSync(join(dir, "index.js"), code);
  for (const [f, text] of Object.entries(opts.files ?? {})) writeFileSync(join(dir, f), text);
  const m = { name: "my-plugin", version: "1.0.0", ...manifest } as PluginManifest;
  const signed: PluginManifest =
    opts.unsigned === true
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

type Seams = {
  importEntrypoint?: (p: string) => Promise<{ default?: unknown }>;
  readEntrypoint?: (p: string) => Promise<Uint8Array>;
};

function loader(opts: { allowUnsigned?: boolean; anchors?: boolean } & Seams = {}) {
  const warnings: string[] = [];
  const l = createPluginLoader({
    trustedRoots: [root],
    ...(opts.anchors === false ? {} : { trustAnchors: [{ name: "t", publicKeyPem: pem }] }),
    allowUnsigned: opts.allowUnsigned ?? false,
    warn: (w) => warnings.push(w),
    ...(opts.importEntrypoint !== undefined ? { importEntrypoint: opts.importEntrypoint } : {}),
    ...(opts.readEntrypoint !== undefined ? { readEntrypoint: opts.readEntrypoint } : {}),
  });
  return { loader: l, warnings };
}

const marker = "__crewhausSigningTestRan";
const g = globalThis as Record<string, unknown>;
afterEach(() => {
  Reflect.deleteProperty(g, marker);
});

describe("a signed manifest must name its code (C108)", () => {
  test("a signed manifest without entrypointDigest is refused, and nothing is imported", async () => {
    const path = install("export default { ok: true };\n");
    let imported = false;
    const { loader: l } = loader({
      importEntrypoint: async () => {
        imported = true;
        return { default: {} };
      },
    });
    const load = l.load(path);
    await expect(load).rejects.toThrow(PluginLoaderError);
    await expect(load).rejects.toThrow(
      'plugin "my-plugin" is signed, but its manifest has no entrypointDigest, so the signature covers none of its code — refusing to load it.',
    );
    expect(imported).toBe(false);
  });

  test("in development mode it loads, as unverified, and says why", async () => {
    const path = install("export default { ok: true };\n");
    const { loader: l, warnings } = loader({ allowUnsigned: true });
    const loaded = await l.load(path);
    expect(loaded.signed).toBe(false);
    expect(warnings).toEqual([
      '[plugins] "my-plugin" is signed, but has no entrypointDigest, so the signature covers none of its code; it loads unverified only because CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1 — development only',
    ]);
  });
});

describe("only the verified bytes of a signed plugin run (C108)", () => {
  test("a sibling module the digest does not cover is refused before anything runs", async () => {
    const code = `import { b } from "./lib.js";\nexport default { b };\n`;
    const path = install(
      code,
      { entrypointDigest: digestOf(code) },
      {
        // Tampered after signing: nothing covers it, so it must never execute.
        files: { "lib.js": `globalThis.${marker} = true;\nexport const b = "TAMPERED";\n` },
      },
    );
    const { loader: l } = loader();
    await expect(l.load(path)).rejects.toThrow(
      /^plugin "my-plugin": .*index\.js cannot run as signed code: it imports "\.\/lib\.js", which its entrypointDigest does not cover\. A signed plugin must be one file: bundle it \(bun build/,
    );
    expect(g[marker]).toBeUndefined();
  });

  test("a package import is refused too: the signature covers none of it", async () => {
    const code = `import { z } from "zod";\nexport * from "left-pad";\nexport default { z };\n`;
    const path = install(code, { entrypointDigest: digestOf(code) });
    const { loader: l } = loader();
    await expect(l.load(path)).rejects.toThrow(/it imports "zod", "left-pad", which its/);
  });

  test("the runtime's own builtins may be imported", async () => {
    const code = `import { join } from "node:path";\nimport fs from "fs";\nimport { Database } from "bun:sqlite";\nexport default { ok: typeof join === "function" && typeof fs.statSync === "function" && typeof Database === "function" };\n`;
    const path = install(code, { entrypointDigest: digestOf(code) });
    const { loader: l } = loader();
    const loaded = await l.load(path);
    expect(loaded.signed).toBe(true);
    expect(loaded.module.default).toEqual({ ok: true });
  });

  test("what runs is what was hashed, even if index.js changes after the check", async () => {
    const A = "export default { which: 'A' };\n";
    const B = "export default { which: 'B' };\n";
    const path = install(A, { entrypointDigest: digestOf(A) });
    const { loader: l } = loader({
      // The check reads A; the file is swapped for B right after it.
      readEntrypoint: async (p) => {
        const bytes = new Uint8Array(readFileSync(p));
        writeFileSync(p, B);
        return bytes;
      },
    });
    const loaded = await l.load(path);
    expect(loaded.module.default).toEqual({ which: "A" });
    expect(readFileSync(join(dir, "index.js"), "utf8")).toBe(B);
  });

  test("the verified copy lives in a private directory outside the plugins root, and is gone after the import", async () => {
    const code = "export default { ok: true };\n";
    const path = install(code, { entrypointDigest: digestOf(code) });
    let importedFrom = "";
    let modeWhileImporting = 0;
    const { loader: l } = loader({
      importEntrypoint: async (p) => {
        importedFrom = p;
        modeWhileImporting = (await import("node:fs")).statSync(dirname(p)).mode & 0o777;
        expect(readFileSync(p, "utf8")).toBe(code);
        return { default: {} };
      },
    });
    await l.load(path);
    expect(importedFrom.startsWith(root)).toBe(false);
    expect(modeWhileImporting).toBe(0o700);
    expect(existsSync(dirname(importedFrom))).toBe(false);
  });

  test("an unsigned development plugin may still be several files, imported in place", async () => {
    const code = `import { b } from "./lib.js";\nexport default { b };\n`;
    const path = install(
      code,
      { entrypointDigest: digestOf(code) },
      { unsigned: true, files: { "lib.js": `export const b = "sibling";\n` } },
    );
    const { loader: l } = loader({ allowUnsigned: true, anchors: false });
    const loaded = await l.load(path);
    expect(loaded.signed).toBe(false);
    expect(loaded.module.default).toEqual({ b: "sibling" });
  });
});

describe("a signed notAfter ends a manifest (C108)", () => {
  test("an expired manifest is refused before its code is imported", async () => {
    const code = "export default {};\n";
    const path = install(code, {
      entrypointDigest: digestOf(code),
      notAfter: "2000-01-01T00:00:00Z",
    });
    let imported = false;
    const { loader: l } = loader({
      importEntrypoint: async () => {
        imported = true;
        return { default: {} };
      },
    });
    await expect(l.load(path)).rejects.toThrow(
      /^plugin "my-plugin" 1\.0\.0 expired: its manifest is good until 2000-01-01T00:00:00Z, and it is now .* — refusing to load it$/,
    );
    expect(imported).toBe(false);
  });

  test("one still in date loads", async () => {
    const code = "export default {};\n";
    const path = install(code, {
      entrypointDigest: digestOf(code),
      notAfter: "2999-01-01T00:00:00+02:00",
    });
    expect((await loader().loader.load(path)).signed).toBe(true);
  });

  test("notAfter is signed: moving it after signing breaks the signature", async () => {
    const code = "export default {};\n";
    const path = install(code, {
      entrypointDigest: digestOf(code),
      notAfter: "2000-01-01T00:00:00Z",
    });
    const m = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...m, notAfter: "2999-01-01T00:00:00Z" }));
    await expect(loader().loader.load(path)).rejects.toThrow(/signature does not verify/);
  });
});
