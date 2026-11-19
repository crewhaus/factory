/**
 * gateway-server's published entry points export no test seam: every key of its
 * `package.json` `exports` is imported by its published name, and no export of any of them
 * ends in `ForTest`. A seam lives in a module the package does not export, and a test
 * reaches it by relative path.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  readonly exports: Readonly<Record<string, string>>;
};

describe("the published entry points", () => {
  test("export no name ending in ForTest", async () => {
    const keys = Object.keys(manifest.exports);
    let imported = 0;
    const seams: string[] = [];
    for (const key of keys) {
      const specifier = `@crewhaus/gateway-server${key === "." ? "" : key.slice(1)}`;
      const mod = (await import(specifier)) as Record<string, unknown>;
      imported += 1;
      expect(Object.keys(mod).length).toBeGreaterThan(0);
      for (const name of Object.keys(mod))
        if (name.endsWith("ForTest")) seams.push(`${key}: ${name}`);
    }
    expect(seams).toEqual([]);
    expect(imported).toBe(keys.length);
    expect(imported).toBe(2);
  });

  test("the classifier seam lives in a module the package does not export", () => {
    expect(Object.values(manifest.exports)).not.toContain("./src/managed-classify.ts");
  });
});
