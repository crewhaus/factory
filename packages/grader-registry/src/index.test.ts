/**
 * Section 29 — `grader-registry` tests:
 *  - T1 register/lookup round-trip
 *  - T8 plugin discovery sandbox isolation (only path scanning, no eval-of-arbitrary-code)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraderRegistry, GraderRegistryError, discoverPluginGraders } from "./index";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "grader-registry-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("grader-registry — T1 register/lookup", () => {
  test("register + lookup round-trip", async () => {
    const reg = new GraderRegistry();
    reg.register("my_grader", async () => ({ passed: true, score: 1, rationale: "ok" }) as const);
    const g = reg.lookup("my_grader");
    const result = await g({ id: "x", input: "y" }, {} as never);
    expect(result.passed).toBe(true);
  });

  test("duplicate register throws", () => {
    const reg = new GraderRegistry();
    reg.register("g", async () => ({ passed: true, score: 1, rationale: "ok" }));
    expect(() =>
      reg.register("g", async () => ({ passed: false, score: 0, rationale: "no" })),
    ).toThrow(GraderRegistryError);
  });

  test("upsert replaces an existing entry", async () => {
    const reg = new GraderRegistry();
    reg.register("g", async () => ({ passed: true, score: 1, rationale: "ok" }));
    reg.upsert("g", async () => ({ passed: false, score: 0, rationale: "no" }));
    const g = reg.lookup("g");
    const result = await g({ id: "x", input: "y" }, {} as never);
    expect(result.passed).toBe(false);
  });

  test("rejects malformed names", () => {
    const reg = new GraderRegistry();
    expect(() =>
      reg.register("../etc", async () => ({ passed: true, score: 1, rationale: "ok" })),
    ).toThrow(GraderRegistryError);
  });

  test("lookup of missing grader throws", () => {
    const reg = new GraderRegistry();
    expect(() => reg.lookup("missing")).toThrow(GraderRegistryError);
  });

  test("has + list reflect registered graders", () => {
    const reg = new GraderRegistry();
    reg.register("a", async () => ({ passed: true, score: 1, rationale: "ok" }));
    reg.register("b", async () => ({ passed: true, score: 1, rationale: "ok" }));
    expect(reg.has("a")).toBe(true);
    expect(reg.has("c")).toBe(false);
    expect(reg.list()).toEqual(["a", "b"]);
  });
});

describe("grader-registry — T8 plugin discovery", () => {
  test("discoverPluginGraders walks <root>/<plugin>/index.ts", async () => {
    const pluginRoot = join(tmpRoot, "plugins");
    mkdirSync(join(pluginRoot, "fixture"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "fixture", "index.ts"),
      `export default {
  name: "fixture_grader",
  grader: async () => ({ passed: true, score: 1, rationale: "from plugin" }),
};
`,
    );
    const reg = new GraderRegistry();
    const registered = await discoverPluginGraders(reg, pluginRoot);
    expect(registered).toEqual(["fixture_grader"]);
    expect(reg.has("fixture_grader")).toBe(true);
    const g = reg.lookup("fixture_grader");
    const r = await g({ id: "x", input: "y" }, {} as never);
    expect(r.rationale).toBe("from plugin");
  });

  test("array default export registers multiple graders", async () => {
    const pluginRoot = join(tmpRoot, "plugins");
    mkdirSync(join(pluginRoot, "multi"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "multi", "index.ts"),
      `export default [
  { name: "g_a", grader: async () => ({ passed: true, score: 1, rationale: "ok" }) },
  { name: "g_b", grader: async () => ({ passed: true, score: 1, rationale: "ok" }) },
];
`,
    );
    const reg = new GraderRegistry();
    const registered = await discoverPluginGraders(reg, pluginRoot);
    expect([...registered].sort()).toEqual(["g_a", "g_b"]);
  });

  test("returns [] when pluginRoot doesn't exist", async () => {
    const reg = new GraderRegistry();
    const registered = await discoverPluginGraders(reg, join(tmpRoot, "nonexistent"));
    expect(registered).toEqual([]);
  });

  test("malformed default export throws", async () => {
    const pluginRoot = join(tmpRoot, "plugins");
    mkdirSync(join(pluginRoot, "bad"), { recursive: true });
    writeFileSync(join(pluginRoot, "bad", "index.ts"), 'export default { not: "valid" };\n');
    const reg = new GraderRegistry();
    expect(discoverPluginGraders(reg, pluginRoot)).rejects.toBeInstanceOf(GraderRegistryError);
  });

  test("skips directories without index.{ts,js,mjs}", async () => {
    const pluginRoot = join(tmpRoot, "plugins");
    mkdirSync(join(pluginRoot, "empty"), { recursive: true });
    const reg = new GraderRegistry();
    const registered = await discoverPluginGraders(reg, pluginRoot);
    expect(registered).toEqual([]);
  });

  test("skips dotfiles + underscore-prefixed", async () => {
    const pluginRoot = join(tmpRoot, "plugins");
    mkdirSync(join(pluginRoot, "_internal"), { recursive: true });
    writeFileSync(join(pluginRoot, "_internal", "index.ts"), "export default {};\n");
    mkdirSync(join(pluginRoot, ".hidden"), { recursive: true });
    writeFileSync(join(pluginRoot, ".hidden", "index.ts"), "export default {};\n");
    const reg = new GraderRegistry();
    const registered = await discoverPluginGraders(reg, pluginRoot);
    expect(registered).toEqual([]);
  });
});
