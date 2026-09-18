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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * Path containment is implemented once and copied, so it can drift.
 *
 * Every package that takes a path from a caller carries its own copy of the
 * resolver. They started as copies of one another, and one of them was found
 * admitting a DANGLING symlink: `existsSync` follows links, so a link whose
 * target does not exist yet reads as "missing", the walk steps past it, and
 * the link's own name is re-appended to the resolved root — where it passes
 * the containment check. A write through that name then lands wherever the
 * link points.
 *
 * The behavioural test for this lives in
 * `packages/tool-fsx/src/dangling.test.ts`. It can only cover one copy, so
 * this asserts the others did not drift back to the unsafe probe.
 *
 * Copies are found by WHAT THEY CONTAIN, not by filename. The earlier version
 * of this test looked only at `src/paths.ts` and `continue`d past anything
 * else, so it silently skipped every package that keeps its resolver
 * somewhere else — `tool-fs` and `tool-image` in `index.ts`, `tool-proc` in
 * `safe-path.ts`, `tool-git` in `git-run.ts` — which is exactly where the
 * unsafe probe survived. A guard that inspects nothing passes, so the count
 * is asserted too.
 */
describe("every copy of the path resolver probes with lstat, not existsSync", () => {
  /** Files that implement the walk-up-to-an-existing-ancestor resolver. */
  function resolverFiles(): Array<{ pkg: string; file: string; text: string }> {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const pkgDir = join(repoRoot, "packages");
    const found: Array<{ pkg: string; file: string; text: string }> = [];
    // EVERY package, not just `tool-*`. Scoping this sweep to tool packages
    // is the same blind spot as scoping it to `paths.ts`: `packages/crawler`
    // carries its own copy of the resolver (it checks against a list of
    // allowed roots rather than one workspace root) and was the last one
    // still walking with `existsSync`, precisely because nothing looked.
    for (const pkg of readdirSync(pkgDir)) {
      const srcDir = join(pkgDir, pkg, "src");
      if (!existsSync(srcDir)) continue;
      for (const entry of readdirSync(srcDir)) {
        if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
        const file = join(srcDir, entry);
        const text = readFileSync(file, "utf-8");
        // The signature of the resolver: a loop that walks up while the
        // component is not there. Any probe name counts — the point is to
        // find the walk, then judge what it probes WITH.
        if (/while \(!\w+\(probe\)\)/.test(text)) found.push({ pkg, file: entry, text });
      }
    }
    return found;
  }

  test("no copy walks with existsSync, and each follows a dangling link by hand", () => {
    const copies = resolverFiles();
    const offenders: Array<{ pkg: string; file: string; why: string }> = [];
    for (const { pkg, file, text } of copies) {
      // `existsSync` may appear in a comment explaining why it is wrong, or
      // as a genuine "does this really exist" check elsewhere in the file;
      // what matters is that nothing WALKS with it.
      if (/while \(!existsSync\(/.test(text)) {
        offenders.push({ pkg, file, why: "walks with existsSync" });
      }
      if (!text.includes("lstatSync")) {
        offenders.push({ pkg, file, why: "does not probe with lstat" });
      }
      if (!text.includes("readlinkSync")) {
        offenders.push({ pkg, file, why: "cannot follow a dangling link, so it over-refuses" });
      }
      // The second defect in the same hop: a RELATIVE link target must be
      // resolved against the directory that really CONTAINS the link, not
      // against its lexical parent. They differ when that parent is itself a
      // symlink, and the lexical reading then names an in-root path the
      // caller's path does not lead to — so the operation lands somewhere
      // else inside the workspace, or a legitimate link is refused.
      if (/resolve\(\s*(path\.)?dirname\(probe\)\s*,/.test(text)) {
        offenders.push({
          pkg,
          file,
          why: "resolves a relative link target against the lexical parent",
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the sweep actually finds the copies it is meant to guard", () => {
    // Without this, renaming or moving a resolver makes the test above pass
    // by inspecting nothing — which is how the unsafe probe survived in five
    // packages while this file reported green. The floor and the named list
    // are both load-bearing: the floor catches a copy that disappears from
    // the sweep, the list catches the ones that do not follow the filename
    // or the `tool-` prefix convention.
    const copies = resolverFiles();
    const pkgs = [...new Set(copies.map((c) => c.pkg))].sort();
    expect(copies.length).toBeGreaterThanOrEqual(17);
    // The ones that do NOT use the conventional paths.ts filename are the
    // ones a filename-based sweep loses, so name them explicitly.
    for (const pkg of [
      "tool-fs",
      "tool-image",
      "tool-document-ingest",
      "tool-proc",
      "tool-git",
      "crawler",
    ]) {
      expect(pkgs).toContain(pkg);
    }
  });
});
