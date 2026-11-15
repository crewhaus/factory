/**
 * runtime-core's published surface: the package entry exports no test seam,
 * and package.json `exports` names no test subpath. Tests take a seam from the
 * module that defines it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("runtime-core's package entry", () => {
  test("the package entry exports no test seam", async () => {
    const entry: Record<string, unknown> = await import("@crewhaus/runtime-core");
    expect(typeof entry["runChatLoop"]).toBe("function");
    expect(Object.keys(entry).filter((k) => k.endsWith("ForTest"))).toEqual([]);
    expect("_setInputOriginClassifierForTest" in entry).toBe(false);
    expect("_resetInputOriginForTest" in entry).toBe(false);
  });

  test("package.json exports names no test subpath", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      readonly exports?: Record<string, unknown>;
    };
    const keys = Object.keys(pkg.exports ?? {});
    expect(keys).toContain(".");
    expect(keys.filter((k) => /test/i.test(k))).toEqual([]);
  });
});
