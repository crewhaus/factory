/**
 * `specSchemaIdentity()` names the schema that answered a check: this
 * package's version and a digest of its JSON schema, computed once and kept.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schemaDigest, specSchemaIdentity } from "./identity";
import { specJsonSchema } from "./index";

describe("specSchemaIdentity", () => {
  test("names this package and its version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      version: string;
    };
    const identity = specSchemaIdentity();
    expect(identity.package).toBe("@crewhaus/spec");
    expect(identity.version).toBe(pkg.version);
  });

  test("the digest is stable across calls, is the schema's, and changes when the schema does", () => {
    const first = specSchemaIdentity();
    expect(specSchemaIdentity()).toBe(first);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const schema = specJsonSchema();
    expect(first.digest).toBe(schemaDigest(schema));
    const mutated = { ...schema, description: "a schema that differs by one key" };
    expect(schemaDigest(mutated)).not.toBe(first.digest);
  });

  test("the module computes no digest when it loads", () => {
    const source = readFileSync(join(import.meta.dir, "identity.ts"), "utf8");
    const topLevel = source
      .split("\n")
      .filter((line) => !line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("*"))
      // A declaration is not a call.
      .filter((line) => !/^(export )?function /.test(line));
    const calls = topLevel.filter((line) =>
      /schemaDigest\(|createHash\(|specJsonSchema\(\)/.test(line),
    );
    expect(calls).toEqual([]);
    // Not vacuous: the hash call exists, inside a function body.
    expect(source).toContain("createHash(");
  });
});
