/**
 * extension-path#9 (C108): what a signature can say about a plugin.
 *
 * - `notAfter` is signed and ends a manifest; `signature.issuedAt` is not
 *   signed, so it is only a note. A date-time with no offset is refused, not
 *   read as the host's local time.
 * - A signed plugin runs as exactly the bytes its `entrypointDigest` names, so
 *   it may import nothing but the runtime's own builtins.
 */
import { describe, expect, test } from "bun:test";
import {
  PluginSdkError,
  entrypointImportProblem,
  manifestExpiryProblem,
  manifestPayloadForSigning,
  validatePluginManifest,
} from "./index";

const base = { name: "my-plugin", version: "1.0.0" };

describe("notAfter", () => {
  test("an RFC 3339 date-time with Z or an offset is accepted", () => {
    for (const notAfter of [
      "2027-01-01T00:00:00Z",
      "2027-01-01T00:00:00.5+05:30",
      "2027-12-31T23:59:59-08:00",
    ]) {
      expect(validatePluginManifest({ ...base, notAfter }).notAfter).toBe(notAfter);
    }
  });

  test("anything else is refused, and one without an offset says why", () => {
    const refused = [
      "2027-01-01T00:00:00", // no offset: would be the host's local time
      "2027-01-01",
      "2027-02-30T00:00:00Z", // no such day; Date would roll it into March
      "2027-01-01T24:00:00Z",
      "2027-01-01T00:00:00+25:00",
      "next year",
      20270101,
    ];
    for (const notAfter of refused) {
      expect(() => validatePluginManifest({ ...base, notAfter })).toThrow(PluginSdkError);
    }
    expect(() => validatePluginManifest({ ...base, notAfter: "2027-01-01T00:00:00" })).toThrow(
      "a date-time without one would be read as the host's local time",
    );
  });

  test("the manifest expires strictly after notAfter", () => {
    const m = { ...base, notAfter: "2027-01-01T00:00:00Z" };
    const at = Date.parse("2027-01-01T00:00:00Z");
    expect(manifestExpiryProblem(m, at)).toBeUndefined();
    expect(manifestExpiryProblem(m, at + 1)).toBe(
      'plugin "my-plugin" 1.0.0 expired: its manifest is good until 2027-01-01T00:00:00Z, and it is now 2027-01-01T00:00:00.001Z',
    );
    expect(manifestExpiryProblem(base, Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  test("notAfter is part of what is signed; issuedAt is not", () => {
    const signedAt = (m: object) => manifestPayloadForSigning(validatePluginManifest(m));
    const sig = { algorithm: "ed25519", publicKeyB64: "k", sigB64: "s" };
    expect(signedAt({ ...base, notAfter: "2027-01-01T00:00:00Z", signature: sig })).not.toBe(
      signedAt({ ...base, notAfter: "2099-01-01T00:00:00Z", signature: sig }),
    );
    expect(signedAt({ ...base, signature: { ...sig, issuedAt: "1999-01-01" } })).toBe(
      signedAt({ ...base, signature: { ...sig, issuedAt: "2026-01-01" } }),
    );
  });
});

describe("entrypointImportProblem", () => {
  test("a file that imports only runtime builtins, or nothing, has no problem", () => {
    expect(entrypointImportProblem("export default {};")).toBeUndefined();
    expect(
      entrypointImportProblem(
        'import fs from "fs"; import { join } from "node:path"; import { $ } from "bun"; import { Database } from "bun:sqlite"; const c = require("node:crypto"); export default {};',
      ),
    ).toBeUndefined();
  });

  test("every other kind of import is named: relative, package, re-export, require, literal import()", () => {
    const problem = entrypointImportProblem(
      'import a from "./a.js"; import { z } from "zod"; export * from "../b.js"; const c = require("./c.cjs"); const d = await import("@scope/d"); export default {};',
    );
    expect(problem).toBe(
      'it imports "./a.js", "zod", "../b.js", "./c.cjs", "@scope/d", which its entrypointDigest does not cover. A signed plugin must be one file: bundle it (bun build src/index.ts --target=bun --format=esm --outfile index.js) and sign that',
    );
  });

  test("a long list is cut at five, with a count; bytes are read as UTF-8", () => {
    const code = Array.from({ length: 7 }, (_, i) => `import "./m${i}.js";`).join("\n");
    expect(entrypointImportProblem(new TextEncoder().encode(code))).toStartWith(
      'it imports "./m0.js", "./m1.js", "./m2.js", "./m3.js", "./m4.js" and 2 more, which',
    );
  });

  test("code that is not JavaScript is a problem, not a pass", () => {
    expect(entrypointImportProblem("export default {")).toStartWith(
      "it cannot be read as JavaScript (",
    );
  });
});
