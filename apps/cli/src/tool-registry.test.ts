import { describe, expect, test } from "bun:test";
/**
 * The registry-consistency floor.
 *
 * `@crewhaus/tool-categories` is data-only and cannot prove that a key it
 * lists resolves to a real tool — it must not import a tool package, because
 * the compiler imports it and codegen has to stay offline. This file CAN
 * import both sides, so it is where the two are held together:
 *
 *   (1) every key in the category registry is a real builtin, and
 *   (2) every builtin is categorized, in exactly one leaf category.
 *
 * Adding a builtin without categorizing it fails (2). Listing a tool that
 * does not exist fails (1). Either way the failure names the key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import {
  CATEGORIES,
  allRegisteredTools,
  categoriesForTool,
  leafCategories,
  toolsInCategory,
} from "@crewhaus/tool-categories";
import { CLI_RUNTIME_TOOL_KEYS, buildCategoryRows, diffToolMapKeys } from "./tools-cli";

describe("category registry vs. the real builtin set", () => {
  test("every categorized key is a real builtin", () => {
    const unknown = allRegisteredTools().filter((k) => !CLI_RUNTIME_TOOL_KEYS.includes(k));
    expect(unknown).toEqual([]);
  });

  test("every builtin is categorized", () => {
    const uncategorized = CLI_RUNTIME_TOOL_KEYS.filter((k) => categoriesForTool(k).length === 0);
    expect(uncategorized).toEqual([]);
  });

  test("the two sets are exactly equal", () => {
    const { onlyInA, onlyInB } = diffToolMapKeys(allRegisteredTools(), CLI_RUNTIME_TOOL_KEYS);
    expect({ onlyInA, onlyInB }).toEqual({ onlyInA: [], onlyInB: [] });
  });

  test("each builtin lives in exactly one LEAF category", () => {
    const multiHomed: Array<{ key: string; leaves: string[] }> = [];
    for (const key of CLI_RUNTIME_TOOL_KEYS) {
      const leaves = leafCategories().filter((c) => (CATEGORIES[c]?.tools ?? []).includes(key));
      if (leaves.length !== 1) multiHomed.push({ key, leaves });
    }
    expect(multiHomed).toEqual([]);
  });

  test("a roll-up never contradicts its leaves", () => {
    // Every tool a roll-up claims must come from a leaf it actually includes.
    for (const name of Object.keys(CATEGORIES)) {
      const def = CATEGORIES[name];
      if (def?.includes === undefined) continue;
      const fromLeaves = new Set(def.includes.flatMap((c) => toolsInCategory(c)));
      for (const key of toolsInCategory(name)) {
        expect(fromLeaves.has(key)).toBe(true);
      }
    }
  });
});

describe("buildCategoryRows", () => {
  test("rows carry the all- selector an operator writes", () => {
    const rows = buildCategoryRows(CATEGORIES, toolsInCategory);
    const fs = rows.find((r) => r.name === "fs");
    expect(fs?.selector).toBe("all-fs");
    expect(fs?.kind).toBe("leaf");
    expect(fs?.tools).toContain("read");
  });

  test("leaves sort before roll-ups", () => {
    const rows = buildCategoryRows(CATEGORIES, toolsInCategory);
    const firstRollUp = rows.findIndex((r) => r.kind === "roll-up");
    const lastLeaf = rows.map((r) => r.kind).lastIndexOf("leaf");
    expect(lastLeaf).toBeLessThan(firstRollUp);
  });

  test("a roll-up reports what it includes", () => {
    const rows = buildCategoryRows(CATEGORIES, toolsInCategory);
    const code = rows.find((r) => r.name === "code");
    expect(code?.kind).toBe("roll-up");
    expect(code?.includes).toContain("fs");
    expect(code?.tools.length).toBeGreaterThan(
      (rows.find((r) => r.name === "fs")?.tools ?? []).length,
    );
  });

  test("every row has a non-empty title and at least one tool", () => {
    for (const row of buildCategoryRows(CATEGORIES, toolsInCategory)) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.tools.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The gap the checks above cannot see.
 *
 * Everything above compares the category registry against
 * `CLI_RUNTIME_TOOL_KEYS`. Both are hand-maintained lists, so if a tool is
 * left out of BOTH they agree with each other and say nothing is wrong. That
 * happened: `base64Encode` and `base64Decode` existed in tool-encode, passed
 * their own tests, and were unreachable from any spec because a key-extraction
 * regex excluded digits.
 *
 * This asserts against the packages themselves rather than against another
 * list: every tool a deterministic package EXPORTS must be registered. A tool
 * that exists but cannot be switched on is not shipped.
 */
describe("every exported tool is reachable from a spec", () => {
  const PACKAGES = [
    "tool-text",
    "tool-data",
    "tool-encode",
    "tool-datetime",
    "tool-schema",
    "tool-git",
    "tool-fsx",
    "tool-proc",
    "tool-http",
    "tool-state",
    "tool-crewhaus",
    "tool-code",
    "tool-codehost",
    "tool-sql",
    "tool-docs",
    "tool-secure",
    "tool-math",
  ];

  test("no package exports a tool that is not wired", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const unreachable: Array<{ pkg: string; tool: string }> = [];
    for (const pkg of PACKAGES) {
      const source = join(repoRoot, "packages", pkg, "src", "index.ts");
      if (!existsSync(source)) continue;
      const text = readFileSync(source, "utf-8");
      // Every `export const <name>: RegisteredTool` in the package entrypoint.
      // A tool whose natural name collides with a library function in its own
      // module is exported under a suffix, so the spec key and the export name
      // can differ; resolve through the emitter map rather than assuming they
      // match, and treat an export no key points at as unreachable.
      const exportsWired = new Set(
        Object.values(BUILTIN_TOOL_MAP).map((entry) => (entry as { export: string }).export),
      );
      for (const m of text.matchAll(/^export const ([A-Za-z0-9_]+): RegisteredTool/gm)) {
        const name = m[1] as string;
        if (!CLI_RUNTIME_TOOL_KEYS.includes(name) && !exportsWired.has(name)) {
          unreachable.push({ pkg, tool: name });
        }
      }
    }
    expect(unreachable).toEqual([]);
  });
});
