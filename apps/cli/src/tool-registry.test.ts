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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import {
  BUILTIN_TOOLS,
  CATEGORIES,
  allRegisteredTools,
  builtinToolsFor,
  categoriesForTool,
  leafCategories,
  toolsInCategory,
} from "@crewhaus/tool-categories";
import { isPrivateIp } from "@crewhaus/tool-fetch";
import { TOOL_REGISTRY, projectRegistryEntry } from "@crewhaus/tool-registry-manifest";
import { TOOL_FLAGS } from "@crewhaus/tool-registry-manifest/flags";
import { loadAllBuiltinTools } from "./builtin-tools-for-tests";
import { TOOL_PACKAGE_LOADERS, loadBuiltinTools } from "./tool-packages";
import {
  CLI_RUNTIME_TOOL_KEYS,
  TOOL_KEYWORDS,
  buildCategoryRows,
  diffToolMapKeys,
  formatCategoryLines,
} from "./tools-cli";

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

/**
 * The builtin table (`@crewhaus/tool-categories`) is data only, so it cannot
 * check its own `name` / `io` / `sandbox` columns against the tools. This
 * file can import every tool, so it does — for every row, shape-specific
 * ones included. A row that says a tool does not start a process when it
 * does would let the cf-worker check call a host tool "not wired yet".
 */
describe("the builtin table's facts match the tools themselves", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");

  test("name, io, sandbox, justification and scope agree with every RegisteredTool", async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const [key, entry] of Object.entries(BUILTIN_TOOLS)) {
      // By file, not by specifier: apps/cli does not depend on the
      // shape-specific packages, and workspace deps are linked per package.
      const file = join(
        repoRoot,
        "packages",
        entry.package.replace("@crewhaus/", ""),
        "src/index.ts",
      );
      const mod = (await import(file)) as Record<string, unknown>;
      const tool = mod[entry.export] as
        | {
            name: string;
            ioCapability?: string;
            requiresSandbox: boolean;
            requireJustification: boolean;
            scope: string;
          }
        | undefined;
      checked += 1;
      if (tool === undefined) {
        wrong.push(`${key}: ${entry.package} exports no "${entry.export}"`);
        continue;
      }
      if (tool.name !== entry.name) wrong.push(`${key}: name ${entry.name} vs ${tool.name}`);
      const io =
        tool.ioCapability === "process" || tool.ioCapability === "network"
          ? tool.ioCapability
          : undefined;
      if (io !== entry.io) wrong.push(`${key}: io ${entry.io} vs ${io}`);
      if ((tool.requiresSandbox === true) !== (entry.sandbox === true)) {
        wrong.push(`${key}: sandbox ${entry.sandbox} vs ${tool.requiresSandbox}`);
      }
      if ((tool.requireJustification === true) !== (entry.justify === true)) {
        wrong.push(`${key}: justify ${entry.justify} vs ${tool.requireJustification}`);
      }
      // A bundle README prints "external" for a row with an io fact, so the
      // two must be the same fact on every tool.
      if ((tool.scope === "external") !== (entry.io !== undefined)) {
        wrong.push(`${key}: scope ${tool.scope} but io ${entry.io}`);
      }
    }
    expect(checked).toBe(Object.keys(BUILTIN_TOOLS).length);
    expect(checked).toBeGreaterThanOrEqual(550);
    expect(wrong).toEqual([]);
  }, 60_000);

  test("the cf-worker policy lists agree with the table's edge column", async () => {
    // By file: apps/cli does not depend on the edge runtime package.
    const { EDGE_SAFE_TOOLS, HOST_ONLY_TOOLS } = (await import(
      join(repoRoot, "packages/worker-runtime/src/tool-policy.ts")
    )) as {
      EDGE_SAFE_TOOLS: ReadonlySet<string>;
      HOST_ONLY_TOOLS: ReadonlyMap<string, string>;
    };
    const edge = Object.entries(BUILTIN_TOOLS)
      .filter(([, e]) => e.edge === true)
      .map(([k]) => k)
      .sort();
    expect(edge.length).toBeGreaterThan(0);
    expect([...EDGE_SAFE_TOOLS].sort()).toEqual(edge);
    // Every host-only name the edge hard-rejects is a builtin the edge does
    // not wire (the policy also lists perception tools that are not builtins).
    for (const name of HOST_ONLY_TOOLS.keys()) {
      expect(BUILTIN_TOOLS[name]?.edge).not.toBe(true);
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

  // C038 — `tools categories` is where an operator reads what all-network
  // holds, so the network tools it leaves out are printed under it.
  test("the network roll-up prints the network tools it leaves out", () => {
    const rows = buildCategoryRows(CATEGORIES, toolsInCategory);
    const network = rows.find((r) => r.name === "network");
    expect(network?.note).toContain("all-codehost");
    const lines = formatCategoryLines(rows);
    const at = lines.findIndex((l) => l.startsWith("  all-network  "));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 2]).toBe(`    note: ${network?.note}`);
    // Only the rows that carry a note print one.
    expect(lines.filter((l) => l.startsWith("    note: "))).toHaveLength(
      rows.filter((r) => r.note !== undefined).length,
    );
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
  const repoRoot = join(import.meta.dir, "..", "..", "..");

  /**
   * Every `tool-*` package on disk, not a list of them.
   *
   * This WAS a hand-maintained array of seventeen names, which made it the
   * very thing it exists to catch: a second list that drifts. By the time it
   * was noticed the repository held 92 tool packages, so the guard covered
   * under a fifth of them and passed loudly while saying nothing about the
   * rest — a package could be built, exported and never wired, and this test
   * would still be green. Reading the directory cannot fall behind.
   */
  const PACKAGES = readdirSync(join(repoRoot, "packages"))
    .filter((name) => name.startsWith("tool-"))
    .filter((name) => existsSync(join(repoRoot, "packages", name, "src", "index.ts")))
    .sort();

  /**
   * The guard's own hit count.
   *
   * A sweep that matches nothing passes. Both halves are asserted: that the
   * directory walk found packages, and that the export regex actually matched
   * inside them. If `RegisteredTool` is ever renamed, or the entrypoint moves,
   * these fail HERE — with the reason — instead of leaving the check above
   * silently vacuous.
   */
  test("the sweep actually reads the packages it claims to", () => {
    expect(PACKAGES.length).toBeGreaterThanOrEqual(80);
    expect(PACKAGES).toContain("tool-verify");
    expect(PACKAGES).toContain("tool-notify");
    expect(PACKAGES).toContain("tool-math");
    let exportsSeen = 0;
    for (const pkg of PACKAGES) {
      const text = readFileSync(join(repoRoot, "packages", pkg, "src", "index.ts"), "utf-8");
      exportsSeen += [...text.matchAll(/^export const ([A-Za-z0-9_]+): RegisteredTool/gm)].length;
    }
    expect(exportsSeen).toBeGreaterThanOrEqual(400);
  });

  /**
   * The packages whose tools are not in the builtin table at all.
   *
   * Every other `RegisteredTool` a tool package exports must be a row of the
   * table — including the shape-specific ones (the evm pair and
   * `sendMessage`), which the table carries with the shapes that wire them.
   * `Retrieve` is the one exception: `apps/cli/src/knowledge-ingest.ts`
   * builds it per corpus from a spec's `knowledge:` block, so it has no
   * `tools:` key. The test below re-derives that reason, so an exemption
   * whose justification stops being true fails rather than going on
   * exempting.
   */
  const REACHED_OUTSIDE_THE_TABLE: Readonly<Record<string, string>> = {
    "tool-retrieve": "apps/cli/src/knowledge-ingest.ts registers it per corpus",
  };

  const exportNames = new Set(Object.values(BUILTIN_TOOLS).map((entry) => entry.export));

  test("every exemption still has the reason it was granted for", () => {
    for (const pkg of Object.keys(REACHED_OUTSIDE_THE_TABLE)) {
      const entry = join(repoRoot, "packages", pkg, "src", "index.ts");
      expect(existsSync(entry)).toBe(true);
      expect(PACKAGES).toContain(pkg);
      // Still reached from the CLI by name.
      const cliDir = join(repoRoot, "apps/cli/src");
      const importers = readdirSync(cliDir)
        .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
        .filter((f) => readFileSync(join(cliDir, f), "utf-8").includes(`@crewhaus/${pkg}`));
      expect(
        importers.length,
        `${pkg} is exempt because ${REACHED_OUTSIDE_THE_TABLE[pkg]}, and nothing imports it any more`,
      ).toBeGreaterThan(0);
      // And still NEEDS the exemption: none of its tools is in the table.
      const inTable = Object.values(BUILTIN_TOOLS).filter((e) => e.package === `@crewhaus/${pkg}`);
      expect(
        inTable.map((e) => e.export),
        `${pkg} is exempt, but the builtin table carries its tools — drop the exemption`,
      ).toEqual([]);
    }
  });

  test("no package exports a tool that is not wired", () => {
    const unreachable: Array<{ pkg: string; tool: string }> = [];
    // Every `export const <name>: RegisteredTool` in the package entrypoint.
    // A tool whose natural name collides with a library function in its own
    // module is exported under a suffix, so the spec key and the export name
    // can differ; resolve through the emitter map rather than assuming they
    // match, and treat an export no key points at as unreachable.
    for (const pkg of PACKAGES) {
      if (pkg in REACHED_OUTSIDE_THE_TABLE) continue;
      const text = readFileSync(join(repoRoot, "packages", pkg, "src", "index.ts"), "utf-8");
      for (const m of text.matchAll(/^export const ([A-Za-z0-9_]+): RegisteredTool/gm)) {
        const name = m[1] as string;
        if (BUILTIN_TOOLS[name] === undefined && !exportNames.has(name)) {
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
    for (const pkg of ["tool-proc", "tool-git", "crawler"]) {
      expect(pkgs).toContain(pkg);
    }
  });

  test("a package that retired its copy resolves through tool-safety instead", () => {
    // 0.7.1: these five dropped their copy for tool-safety's resolveContained,
    // which walks a dangling link's target one component at a time (the
    // copies folded it as text: `evil -> a/y/../x` with `a/y -> ..` read as
    // inside). A copy that leaves the sweep must have been REPLACED, not
    // deleted, or the floor above is all that notices.
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const retired = [
      ["tool-fs", "index.ts"],
      ["tool-fsx", "paths.ts"],
      ["tool-hostfs", "paths.ts"],
      ["tool-image", "index.ts"],
      ["tool-document-ingest", "index.ts"],
    ] as const;
    const copies = new Set(resolverFiles().map((c) => c.pkg));
    let checked = 0;
    for (const [pkg, file] of retired) {
      const text = readFileSync(join(repoRoot, "packages", pkg, "src", file), "utf-8");
      expect({ pkg, copy: copies.has(pkg) }).toEqual({ pkg, copy: false });
      expect({ pkg, delegates: /resolveContained\(/.test(text) }).toEqual({
        pkg,
        delegates: true,
      });
      expect({ pkg, imports: text.includes('from "@crewhaus/tool-safety/fs"') }).toEqual({
        pkg,
        imports: true,
      });
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});

/**
 * 0.7.1 review — the walk every copy of the resolver makes to a path's
 * deepest existing name is linear, and a path no filesystem can hold is
 * refused before it starts.
 *
 * Each step of the old walk took one name off and handed the whole rest of
 * the path to `path.dirname` and `path.basename` (and `tail.unshift` moved
 * every name already found): about 2·d² characters for d missing names, a
 * count the model picks, and 4·d² in the permission gate, which walked twice
 * on the runtime's thread before any rule was read. The copies now share one
 * `deepestName`, worked by index on the path, and refuse a path past
 * MAX_PATH_CHARS (twice the longest any platform opens) before walking.
 *
 * Copies are found by what they contain, at any depth, and counted, so one
 * that drifts back or leaves the sweep fails here. Nothing is timed: the
 * work is counted.
 */
describe("every copy of the resolver climbs by index and refuses a path no filesystem holds", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");

  /** Every non-test source that defines the resolver's walk. */
  function walkCopies(): Array<{ file: string; text: string }> {
    const found: Array<{ file: string; text: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const text = readFileSync(full, "utf-8");
          if (text.includes("function resolveLocation(")) {
            found.push({ file: full.slice(repoRoot.length + 1), text });
          }
        }
      }
    };
    for (const pkg of readdirSync(join(repoRoot, "packages"))) {
      const src = join(repoRoot, "packages", pkg, "src");
      if (existsSync(src)) walk(src);
    }
    return found.sort((a, b) => a.file.localeCompare(b.file));
  }

  /** `function deepestName(…) {…}`, with `path.` dropped (crawler imports the names). */
  function climbOf(text: string): string | undefined {
    const from = text.indexOf("function deepestName(");
    if (from === -1) return undefined;
    const to = text.indexOf("\n}\n", from);
    return text.slice(from, to + 2).replace(/\bpath\.(parse|sep)\b/g, "$1");
  }

  function limitOf(text: string): string | undefined {
    const from = text.indexOf("export const MAX_PATH_CHARS =");
    return from === -1 ? undefined : text.slice(from, text.indexOf(";\n", from) + 1);
  }

  test("the sweep finds every copy, and each carries the same climb and the same limit", () => {
    const found = walkCopies();
    // 37 paths.ts, tool-git's git-run.ts, tool-proc's safe-path.ts, crawler,
    // and the permission gate (runtime-core path-canonical.ts).
    expect(found.length).toBe(41);
    const climbs = new Set(found.map((c) => climbOf(c.text)));
    const limits = new Set(found.map((c) => limitOf(c.text)));
    expect(climbs.size).toBe(1);
    expect(limits.size).toBe(1);
    expect([...climbs][0]).toBeDefined();
    expect([...limits][0]).toBeDefined();
    const drifted = found
      .filter(
        (c) =>
          !c.text.includes("const { probe, tail } = deepestName(target);") ||
          c.text.includes("tail.unshift(") ||
          !/[aA]bs\.length > MAX_PATH_CHARS\)/.test(c.text),
      )
      .map((c) => c.file);
    expect(drifted).toEqual([]);
  });

  test("the climb is path.dirname and path.basename, on POSIX and Windows paths alike", () => {
    const text = climbOf(walkCopies()[0]?.text ?? "") ?? "";
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(text);
    type Impl = typeof posix;
    type Climb = (t: string) => { probe: string; tail: string };
    const shipped = (impl: Impl, exists: (p: string) => boolean): Climb =>
      new Function("parse", "sep", "nameExists", `${js}\nreturn deepestName;`)(
        impl.parse,
        impl.sep,
        exists,
      ) as Climb;
    // The walk this replaced, verbatim but for the platform's path module.
    const oldClimb = (impl: Impl, exists: (p: string) => boolean, target: string) => {
      let probe = target;
      const tail: string[] = [];
      while (!exists(probe)) {
        tail.unshift(impl.basename(probe));
        const parent = impl.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      return { probe, tail };
    };
    let state = 20_251_012;
    // A 32-bit LCG, multiplied in integers (a float product loses the low
    // bits, and `% n` then picks the same few values every time).
    const next = (n: number) => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) & 0x7fffffff;
      return (state >>> 8) % n;
    };
    const cases: Array<{ impl: Impl; roots: string[]; names: string[] }> = [
      { impl: posix, roots: ["/", "/r/"], names: ["a", "B", "é", ".", "..", "", "a/", "b//"] },
      {
        impl: win32,
        roots: ["C:\\", "c:/", "\\\\srv\\share\\"],
        names: ["a", "B", ".", "..", "", "a\\", "b/", "c\\\\"],
      },
    ];
    const wrong: string[] = [];
    let checked = 0;
    // Enough of each shape, so the comparison does not pass for want of cases.
    let trailing = 0;
    let climbed = 0;
    for (const { impl, roots, names } of cases) {
      for (let k = 0; k < 20_000; k++) {
        const parts = Array.from({ length: next(9) }, () => names[next(names.length)] as string);
        const root = roots[next(roots.length)] as string;
        // What the callers hand over: path.resolve's output, or path.join's
        // (which keeps a trailing separator).
        const target =
          k % 2 === 0 ? impl.resolve(root, ...parts) : impl.join(root, parts.join(impl.sep));
        const probes: string[] = [];
        oldClimb(
          impl,
          (q) => {
            probes.push(q);
            return false;
          },
          target,
        );
        // Some prefix exists — the filesystem root at least — and nothing below it.
        const exists = new Set(probes.slice(Math.min(next(probes.length + 1), probes.length - 1)));
        const seenBefore: string[] = [];
        const seenNow: string[] = [];
        const was = oldClimb(
          impl,
          (q) => {
            seenBefore.push(q);
            return exists.has(q);
          },
          target,
        );
        const now = shipped(impl, (q) => {
          seenNow.push(q);
          return exists.has(q);
        })(target);
        const at = impl === posix ? "/R" : "C:\\R";
        const joinedBefore = was.tail.length > 0 ? impl.join(at, was.tail.join(impl.sep)) : at;
        const joinedNow = now.tail.length > 0 ? impl.join(at, now.tail) : at;
        checked++;
        if (/[\\/]$/.test(target) && target !== impl.parse(target).root) trailing++;
        if (seenBefore.length >= 3) climbed++;
        if (
          JSON.stringify(seenBefore) !== JSON.stringify(seenNow) ||
          was.probe !== now.probe ||
          joinedBefore !== joinedNow
        ) {
          if (wrong.length < 5)
            wrong.push(JSON.stringify({ target, was, now, seenBefore, seenNow }));
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBe(40_000);
    expect(Math.min(trailing, climbed)).toBeGreaterThan(2_000);
  });

  test("counted: linear at d and 2d names, the whole path up to the limit, refused one past it", () => {
    const files = walkCopies().map((c) => join(repoRoot, c.file));
    const dir = mkdtempSync(join(tmpdir(), "walk-count-"));
    const script = join(dir, "count.ts");
    // In a process of its own, so node:path is wrapped before any copy (or
    // anything else) imports it: Bun's namespace takes the module's functions
    // as they are at the first import.
    writeFileSync(
      script,
      `const req = require("node:path");
let chars = 0;
for (const k of Object.keys(req)) {
  const f = req[k];
  if (typeof f !== "function") continue;
  req[k] = (...a) => { for (const x of a) if (typeof x === "string") chars += x.length; return f(...a); };
}
const fs = require("node:fs");
const files = ${JSON.stringify(files)};
const root = fs.realpathSync(fs.mkdtempSync(require("node:os").tmpdir() + "/count-"));
fs.writeFileSync(root + "/f.db", "x");
const tracker = { runId: "run_0123456789abcdef", hasFetched: () => false, getFetchedContent: () => undefined, getFetchRecord: () => undefined, recordFetch: () => ({}), recordCitation: () => ({}), listCitationsOrdered: () => [], listFetches: () => [] };
const rows = [];
let MAX = 0;
for (const file of files) {
  const mod = await import(file);
  MAX = mod.MAX_PATH_CHARS;
  // "whole": resolved to root/raw; "refused": text of the refusal; else what came back.
  let run;
  if (typeof mod.canonicalWorkspacePath === "function") {
    run = async (raw) => {
      const v = mod.canonicalWorkspacePath(raw, root, { pwd: undefined, topLevelLinks: [] });
      if (v.length === 1 && v[0].outsideWorkspace === true) return { refused: "outside" };
      return v.length === 1 && v[0].canonical[2] === root + "/" + raw ? { whole: true } : { got: JSON.stringify(v).slice(0, 200) };
    };
  } else if (typeof mod.resolveInsideRoot === "function") {
    run = async (raw) => {
      const r = mod.resolveInsideRoot("Count", raw, root);
      return r.ok ? (r.value === root + "/" + raw ? { whole: true } : { got: r.value.slice(-40) }) : { refused: r.message };
    };
  } else if (typeof mod.createCrawler === "function") {
    const crawler = mod.createCrawler({ tracker, config: { allowedFileRoots: [root] } });
    run = async (raw) => {
      try { await crawler.fetch("file://" + root + "/" + raw); return { got: "read" }; }
      catch (e) { return /character limit/.test(e.message) ? { refused: e.message } : { whole: true, read: e.message.slice(0, 30) }; }
    };
  } else if (typeof mod.resolveSafe === "function") {
    run = async (raw) => {
      try {
        const r = mod.resolveSafe("Count", raw, root);
        if (r.ok === false) return { refused: r.message };
        const at = r.real ?? r.path;
        return at === root + "/" + raw ? { whole: true } : { got: at.slice(-40) };
      } catch (e) { return { refused: e.message }; }
    };
  } else { rows.push({ file, cannotDrive: true }); continue; }
  const deepTo = (abs) => {
    const tail = abs - (root.length + 1 + "f.db/".length);
    const pairs = Math.floor((tail - 1) / 2);
    return "f.db/" + "a/".repeat(pairs) + "b".repeat(tail - 2 * pairs);
  };
  const d = Math.floor((MAX - root.length - 16) / 4);
  const ask = [["d", "f.db/" + Array.from({ length: d }, () => "a").join("/")], ["2d", "f.db/" + Array.from({ length: 2 * d }, () => "a").join("/")], ["limit", deepTo(MAX)], ["past", deepTo(MAX + 1)]];
  for (const [at, raw] of ask) {
    chars = 0;
    const out = await run(raw);
    rows.push({ file: file.slice(file.indexOf("packages/")), at, abs: root.length + 1 + raw.length, chars, ...out });
  }
}
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ MAX, rows }));
`,
    );
    let report: {
      MAX: number;
      rows: Array<{
        file: string;
        at: string;
        abs: number;
        chars: number;
        whole?: boolean;
        refused?: string;
        cannotDrive?: boolean;
      }>;
    };
    try {
      const run = Bun.spawnSync([process.execPath, script], { stderr: "pipe" });
      expect(run.stderr.toString()).toBe("");
      report = JSON.parse(run.stdout.toString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const { MAX, rows } = report;
    expect(rows.filter((r) => r.cannotDrive).map((r) => r.file)).toEqual([]);
    expect(rows.length).toBe(41 * 4);
    const by = (at: string) => rows.filter((r) => r.at === at);
    // Up to the limit every copy resolves the whole path.
    for (const at of ["d", "2d", "limit"]) {
      expect({ at, notWhole: by(at).filter((r) => r.whole !== true) }).toEqual({
        at,
        notWhole: [],
      });
    }
    // One character past it, every copy refuses, naming the length and the limit.
    const why = `${MAX + 1} characters once resolved, over the ${MAX}-character limit`;
    expect(
      by("past")
        .filter((r) => !(r.refused === "outside" || r.refused?.includes(why)))
        .map((r) => ({ file: r.file, refused: r.refused })),
    ).toEqual([]);
    // Linear: a bounded number of characters handed to node:path per character
    // of path at every size (the old walk read ~900 per character at d = 400,
    // and four times as much at 2d), and doubling d no more than doubles it.
    const overBound = rows
      .filter((r) => r.chars > 40 * r.abs)
      .map((r) => ({ file: r.file, at: r.at, perChar: Math.round(r.chars / r.abs) }));
    expect(overBound).toEqual([]);
    const notLinear = by("d")
      .map((r) => ({
        file: r.file,
        ratio: (by("2d").find((x) => x.file === r.file)?.chars ?? 0) / r.chars,
      }))
      .filter((r) => !(r.ratio < 2.5));
    expect(notLinear).toEqual([]);
  }, 120_000);
});

describe("the CLI can actually load every tool package it names", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");

  /**
   * Every package `apps/cli/src/tool-packages.ts` has a literal loader for,
   * read from the SOURCE — a literal `import("…")` is what `bun build
   * --compile` embeds, so the text is what matters.
   */
  function loaderPackages(): string[] {
    const text = readFileSync(join(REPO, "apps/cli/src/tool-packages.ts"), "utf-8");
    const found = [
      ...text.matchAll(/"(@crewhaus\/tool-[a-z0-9-]+)": \(\) => import\("([^"]+)"\)/g),
    ];
    // Each loader imports the package it is keyed by, not a neighbour.
    for (const m of found) expect(m[2]).toBe(m[1]);
    return [...new Set(found.map((m) => m[1] as string))].sort();
  }

  /** Every package a builtin the cli shape compiles lives in, from the table. */
  const cliPackages = [
    ...new Set(builtinToolsFor("cli").map((k) => BUILTIN_TOOLS[k]?.package as string)),
  ].sort();

  test("the sweep finds the loaders it is meant to guard", () => {
    expect(loaderPackages().length).toBeGreaterThanOrEqual(60);
    expect(Object.keys(TOOL_PACKAGE_LOADERS).sort()).toEqual(loaderPackages());
  });

  test("each one is a declared dependency of apps/cli", () => {
    // A dynamic import of an undeclared workspace package resolves anyway
    // through the hoisted node_modules, so this passes locally and fails
    // only once the CLI is published or installed on its own. The wiring
    // script adds the dependency; when its anchor moved it reported the edit
    // as "already present" instead, and nothing else would have noticed.
    const pkg = JSON.parse(readFileSync(join(REPO, "apps/cli/package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const missing = loaderPackages().filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  test("each one has a project reference, so tsc builds it first", () => {
    const text = readFileSync(join(REPO, "apps/cli/tsconfig.json"), "utf-8");
    const missing = loaderPackages().filter(
      (name) => !text.includes(`../../packages/${name.replace("@crewhaus/", "")}"`),
    );
    expect(missing).toEqual([]);
  });

  test("the loaders are exactly the packages the cli shape's builtins live in", () => {
    // A package with a builtin and no loader is a tool that compiles into a
    // spec and then cannot be run; a loader for no builtin is dead weight.
    expect(cliPackages.length).toBeGreaterThanOrEqual(60);
    expect(loaderPackages()).toEqual(cliPackages);
  });

  test("loadBuiltinTools resolves every cli builtin to a tool with the table's name", async () => {
    const map = await loadBuiltinTools(builtinToolsFor("cli"));
    const keys = Object.keys(map);
    expect(keys.length).toBe(builtinToolsFor("cli").length);
    const wrong = keys.filter((k) => map[k]?.name !== BUILTIN_TOOLS[k]?.name);
    expect(wrong).toEqual([]);
  }, 30_000);
});

describe("every copy of the private-address classifier is the same classifier", () => {
  /**
   * The packages in CLASSIFIER_PACKAGES guard an outbound request against a
   * private destination, and each carries the classifier as a byte-identical
   * block rather than importing it — these are otherwise independent
   * per-package networking layers, and a guard proving the copies are
   * identical is cheaper than the import graph a shared package would need
   * across `crawler`, `computer-use-driver` and the tools (FederationDiscover's
   * peer dialing among them).
   *
   * That only works if something checks. On 2026-09-18 an audit of the copies
   * found SIX confirmed exploitable — each with a runnable proof — because they
   * had drifted into comparing address TEXT. `new URL()` rewrites
   * `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so a text check never
   * sees the spelling it was written for, and `64:ff9b::a9fe:a9fe` IS
   * 169.254.169.254 wherever DNS64/NAT64 runs. One copy parsed numerically and
   * was still exploitable, because it knew `64:ff9b::/96` and not the
   * `64:ff9b:1::/48` variant.
   */
  const MARKER_START = "// BEGIN SYNCHRONISED BLOCK";
  const MARKER_END = "// END SYNCHRONISED BLOCK";

  /**
   * Every package that carries a copy, exactly. A copy lost (markers renamed,
   * file moved), a copy added, or a second copy in one package each fails
   * until this list is edited. tool-discovery's copy arrived after the list
   * was first written and was missing from it, so its markers could vanish
   * with every assertion here still green (security-7#10).
   */
  const CLASSIFIER_PACKAGES = [
    "computer-use-driver",
    "crawler",
    "tool-chainread",
    "tool-codehost",
    "tool-discovery",
    "tool-fetch",
    "tool-http",
    "tool-navigate",
    "tool-notify",
    "tool-obs",
    // 0.7.1 C144: WaitForPort classifies the host it may probe.
    "tool-proc",
    "tool-web",
  ];

  /** Every non-test `.ts` under `packages/<pkg>/src`, at any depth. */
  function sourceFiles(): Array<{ pkg: string; file: string; text: string }> {
    const pkgDir = join(import.meta.dir, "..", "..", "..", "packages");
    const out: Array<{ pkg: string; file: string; text: string }> = [];
    const walk = (pkg: string, dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(pkg, full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        out.push({ pkg, file: full, text: readFileSync(full, "utf-8") });
      }
    };
    for (const pkg of readdirSync(pkgDir)) {
      const src = join(pkgDir, pkg, "src");
      if (existsSync(src)) walk(pkg, src);
    }
    return out;
  }

  /**
   * RECURSIVE on purpose. The sibling resolver guard above walks only
   * `packages/<pkg>/src/*.ts`, and this block also lives at
   * `tool-chainread/src/lib/endpoint.ts` — one level deeper. A sweep that
   * stops at the first level would miss it and still report green, which is
   * how the resolver guard went vacuous twice.
   */
  function classifierCopies(): Array<{ pkg: string; file: string; block: string }> {
    const found: Array<{ pkg: string; file: string; block: string }> = [];
    for (const { pkg, file, text } of sourceFiles()) {
      const from = text.indexOf(MARKER_START);
      if (from === -1) continue;
      const to = text.indexOf(MARKER_END, from);
      // A start marker with no end is a truncated block, not an absent one.
      expect(to).toBeGreaterThan(from);
      found.push({ pkg, file, block: text.slice(from, to + MARKER_END.length) });
    }
    return found;
  }

  test("the sweep finds every copy it is meant to guard, and no other", () => {
    const copies = classifierCopies();
    // Exact, both ways: the package list, and one copy per package. Without
    // the count a rename or a moved file silently shrinks the sweep, and the
    // byte-identical test below then reports green over fewer copies.
    expect(copies.map((c) => c.pkg).sort()).toEqual(CLASSIFIER_PACKAGES);
    expect(copies.length).toBe(CLASSIFIER_PACKAGES.length);
  });

  test("no classifier lives outside the markers", () => {
    // The NAT64 arm (`g[1] === 0xff9b`) is the classifier's fingerprint. A
    // package that pastes the classifier without the markers, or a file that
    // keeps a second copy beside its marked one, is invisible to the sweep
    // above; this finds it by the arm instead.
    const nat64 = /0xff9b/i;
    const carriers = sourceFiles().filter(({ text }) => nat64.test(text));
    expect(carriers.map((c) => c.pkg).sort()).toEqual(CLASSIFIER_PACKAGES);
    const outside = carriers
      .filter(({ text }) => {
        const from = text.indexOf(MARKER_START);
        const to = text.indexOf(MARKER_END, from);
        if (from === -1 || to === -1) return true;
        return nat64.test(text.slice(0, from) + text.slice(to));
      })
      .map((c) => c.file);
    expect(outside).toEqual([]);
  });

  test("every copy is byte-identical", () => {
    const copies = classifierCopies();
    const distinct = new Map<string, string[]>();
    for (const { file, block } of copies) {
      const existing = distinct.get(block);
      if (existing) existing.push(file);
      else distinct.set(block, [file]);
    }
    // One distinct block, or the failure names which files disagree.
    expect([...distinct.values()].map((files) => files.length).sort((a, b) => b - a)).toEqual([
      copies.length,
    ]);
  });

  /**
   * RUN the classifier rather than reading it.
   *
   * The first version of this test asserted the block's TEXT — that it
   * contained `g[0] === 0x64 && g[1] === 0xff9b`, and so on. Mutation-testing
   * it showed that was worthless: narrowing the NAT64 arm to
   * `g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0` — which reopens the
   * `64:ff9b:1::/48` hole that shipped exploitable — STILL CONTAINS that
   * substring, so the assertion passed over a broken classifier in every
   * copy at once. Matching on text was the original bug; asserting on text
   * reproduced it in the guard.
   *
   * Executing one copy plus proving the copies identical covers all of them.
   */
  const MUST_BE_PRIVATE = [
    "169.254.169.254", // the metadata service, plainly
    "2852039166", // ...as a packed integer
    "0xA9FEA9FE", // ...as hex
    "0251.0376.0251.0376", // ...as octal
    "127.1", // inet_aton short form
    "::ffff:169.254.169.254", // IPv4-mapped, dotted
    "::ffff:a9fe:a9fe", // what `new URL()` turns the line above into
    "0:0:0:0:0:ffff:a9fe:a9fe", // ...uncompressed, which a CONNECT target keeps
    "64:ff9b::a9fe:a9fe", // NAT64 /96 — this IS 169.254.169.254 under DNS64
    "64:ff9b:1::a9fe:a9fe", // NAT64 /48 — the variant that shipped exploitable
    "::a9fe:a9fe", // IPv4-compatible, deprecated but still routed
    "2002:a9fe:a9fe::", // 6to4
    "127.0.0.1",
    "::1",
    "0:0:0:0:0:0:0:1", // loopback uncompressed — tunnelled a real proxy
    "fe80::1",
    "febf::1", // still fe80::/10; a `startsWith("fe80:")` check misses it
    "fd00::1",
    "::",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1", // carrier-grade NAT
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "255.255.255.255",
    "0.0.0.0",
  ];
  const MUST_STAY_PUBLIC = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ];

  test("the shared classifier, executed, blocks every spelling and over-blocks none", () => {
    const leaked = MUST_BE_PRIVATE.filter((host) => !isPrivateIp(host));
    expect(leaked).toEqual([]);
    // Over-blocking is the other failure: a guard that refuses the real
    // internet is removed by whoever it blocks, and then nothing guards.
    const overBlocked = MUST_STAY_PUBLIC.filter((host) => isPrivateIp(host));
    expect(overBlocked).toEqual([]);
  });
});

/**
 * The generated manifest must not go stale.
 *
 * `@crewhaus/tool-registry-manifest` exists so a compiled bundle can describe
 * a tool it is NOT running — the question `ListTools` cannot answer, because
 * the live catalog only knows what is bound. Its contents are a projection of
 * the tools themselves, produced by `scripts/gen-tool-registry.ts`, so the
 * only way it can be wrong is by being old: a builtin added, renamed,
 * recategorised or reworded since the last run of that script.
 *
 * This file is where that is checkable, for the same reason it is where the
 * category registry is checked — it can import every builtin, and no
 * `packages/*` may.
 *
 * THREE CHECKS, IN THIS ORDER, AND ALL THREE ARE LOAD-BEARING:
 *
 *   1. the COUNT. A manifest missing a row has the right keys for every row
 *      it still has, so a set comparison alone reports the shape of the
 *      failure and not its size. Counting first is what makes "one tool
 *      disappeared" fail as "one tool disappeared".
 *   2. the KEY SETS, both directions. A renamed key keeps the count and
 *      changes the answer.
 *   3. the CONTENTS, byte for byte against a fresh projection. A reworded
 *      description keeps both the count and the keys, and is the most likely
 *      drift of the three because it needs no wiring change at all.
 *
 * Each has been mutation-tested: deleting a row fails (1), renaming a key
 * fails (2) with (1) still green, and editing a description fails (3) with
 * (1) and (2) still green.
 */
describe("the generated tool manifest matches the tools it describes", () => {
  const manifestKeys = Object.keys(TOOL_REGISTRY).sort();
  const emitterKeys = Object.keys(BUILTIN_TOOL_MAP).sort();

  test("the manifest, the emitter map and the runtime key list are all the same size", () => {
    // Deliberately three numbers rather than two: the manifest is projected
    // FROM the emitter map, so those two agreeing proves only that the
    // projection ran. The runtime list is the independent third party, and a
    // spec key that compiles but cannot run (or the reverse) is the failure
    // the other two cannot see.
    expect({
      manifest: manifestKeys.length,
      emitter: emitterKeys.length,
      runtime: CLI_RUNTIME_TOOL_KEYS.length,
    }).toEqual({
      manifest: emitterKeys.length,
      emitter: emitterKeys.length,
      runtime: emitterKeys.length,
    });
    // And a floor, so an empty tree cannot satisfy "all three agree".
    expect(manifestKeys.length).toBeGreaterThanOrEqual(500);
  });

  test("the key sets are equal in both directions", () => {
    const { onlyInA, onlyInB } = diffToolMapKeys(manifestKeys, emitterKeys);
    expect({ onlyInManifest: onlyInA, onlyInEmitter: onlyInB }).toEqual({
      onlyInManifest: [],
      onlyInEmitter: [],
    });
  });

  test("every row is byte-identical to a freshly generated projection", async () => {
    const stale: Array<{ key: string; expected: string; actual: string }> = [];
    let projected = 0;
    for (const key of emitterKeys) {
      const entry = BUILTIN_TOOL_MAP[key];
      if (entry === undefined) throw new Error(`no BUILTIN_TOOL_MAP entry for ${key}`);
      const mod = (await import(entry.package)) as Record<string, unknown>;
      const tool = mod[entry.export] as Parameters<typeof projectRegistryEntry>[0]["tool"];
      const fresh = projectRegistryEntry({
        key,
        tool,
        categories: categoriesForTool(key),
        package: entry.package,
        keywords: TOOL_KEYWORDS[key] ?? [],
      });
      projected += 1;
      const expected = JSON.stringify(fresh);
      const actual = JSON.stringify(TOOL_REGISTRY[key]);
      if (expected !== actual) stale.push({ key, expected, actual });
    }
    // The sweep's own hit count. Without it, an import that silently yields
    // nothing would leave this loop comparing an empty set and reporting
    // green over a manifest nobody looked at.
    expect(projected).toBe(emitterKeys.length);
    expect(
      stale.map((s) => s.key),
      `re-run \`bun run scripts/gen-tool-registry.ts\` — ${stale.length} row(s) no longer match the tool they describe`,
    ).toEqual([]);
  }, 60_000);

  /**
   * The projection test above compares a row with a fresh PROJECTION, and the
   * projection drops every `OperativeArg` key it does not know on both sides,
   * so a key the projection forgets passes it. Removing `env` from
   * `projectOperativeArg` and regenerating once passed every test (final
   * review, mutation MU08r): ApprovalStatus and `permissions suggest`, which
   * read the manifest offline, silently lost the environment spellings the
   * runtime deny reads. So each row's operativeArgs are compared with the
   * live tool's own declaration, key for key.
   */
  test("every row carries its tool's operativeArgs whole, every key of every field", async () => {
    let compared = 0;
    let keysSeen = new Set<string>();
    const lost: Array<{ key: string; live: unknown; manifest: unknown; flags: unknown }> = [];
    for (const key of emitterKeys) {
      const entry = BUILTIN_TOOL_MAP[key];
      if (entry === undefined) throw new Error(`no BUILTIN_TOOL_MAP entry for ${key}`);
      const mod = (await import(entry.package)) as Record<string, unknown>;
      const tool = mod[entry.export] as { operativeArgs?: ReadonlyArray<object> } | undefined;
      if (tool === undefined) throw new Error(`${entry.package} has no export ${entry.export}`);
      const live = tool.operativeArgs?.map((arg) => ({ ...arg }));
      const manifest = TOOL_REGISTRY[key]?.operativeArgs;
      const flags = TOOL_FLAGS[key]?.operativeArgs;
      compared += 1;
      for (const arg of live ?? []) keysSeen = new Set([...keysSeen, ...Object.keys(arg)]);
      if (JSON.stringify(sortKeys(live)) !== JSON.stringify(sortKeys(manifest))) {
        lost.push({ key, live, manifest, flags });
      } else if (JSON.stringify(sortKeys(live)) !== JSON.stringify(sortKeys(flags))) {
        lost.push({ key, live, manifest, flags });
      }
    }
    expect(compared).toBe(emitterKeys.length);
    expect(
      lost.map((l) => l.key),
      "re-run `bun run scripts/gen-tool-registry.ts`, and carry every OperativeArg key in projectOperativeArg",
    ).toEqual([]);
    // Every key an OperativeArg can have is in use by some builtin, so the
    // comparison above has really looked at each of them.
    expect([...keysSeen].sort()).toEqual(
      [
        "beneath",
        "default",
        "defaultAtRoot",
        "env",
        "field",
        "glob",
        "kind",
        "prefix",
        "relocates",
        "shell",
        "within",
      ].sort(),
    );
    // The environment a command's call sets, by name.
    expect(TOOL_FLAGS["runCommand"]?.operativeArgs).toEqual([
      { field: "argv", kind: "command", within: "cwd", env: "envSet" },
    ]);
  }, 60_000);

  test("no row describes an MCP tool", () => {
    // A spec declares an MCP SERVER and the server's tool list only exists
    // once it is connected, so this manifest can never cover MCP. One
    // `mcp__` row would make an MCP-free answer look complete.
    expect(manifestKeys.length).toBeGreaterThanOrEqual(500);
    expect(manifestKeys.filter((k) => k.startsWith("mcp__"))).toEqual([]);
  });
});

/**
 * OpenAI and Azure OpenAI refuse the WHOLE request when any tool's
 * `function.description` is longer than 1024 characters, so one over-long
 * builtin breaks every turn of a spec that grants it (C014).
 * `@crewhaus/tool-registry-manifest`'s own test holds the limit over the
 * manifest; this holds it over the live tools, which includes the builtins the
 * manifest cannot carry — the chain readers and signers other shapes emit,
 * `SendMessage` and the pipeline's `Retrieve`. `.length` counts UTF-16 units,
 * never fewer than the code points a provider might count.
 */
describe("every builtin description fits every provider", () => {
  test("no live builtin's description is longer than 1024 characters", async () => {
    const { tools, fromMap } = await loadAllBuiltinTools();
    const over = tools
      .filter((tool) => tool.description.length > 1024)
      .map((tool) => `${tool.name}: ${tool.description.length}`);
    // The sweep's hit count: the emitter map and the package scan both ran,
    // and the scan found the builtins the map leaves out.
    expect(fromMap).toBeGreaterThanOrEqual(500);
    expect(tools.length).toBeGreaterThan(fromMap);
    expect(over).toEqual([]);
  }, 60_000);
});

/**
 * The 455 KB of descriptions stays where it was declared.
 *
 * `collectCrewhausDeps` pins whole PACKAGES into a bundle's `package.json`, so
 * a package that imports the manifest hands the manifest to every bundle that
 * grants any of its tools. That is why `capability` was given no roll-up: a
 * broad `all-<category>` grant must not drag the description prose into a
 * harness that never asked for it.
 *
 * `toolInventory` defeated that once already. It needs the builtin KEY SET,
 * took it from the manifest, and `@crewhaus/tool-crewhaus` sits in the
 * `crewhaus` leaf — which IS inside the `all-operations` roll-up. It reads
 * `BUILTIN_TOOL_MAP` instead: the same keys, already in its dependency
 * closure, no prose. The key sets being identical is asserted above.
 *
 * 0.7.1 moved the line. `PermissionAudit` (tool-crewhaus) and
 * `PermissionsSuggest` / `ApprovalStatus` (tool-approvals) need every
 * builtin's FLAGS — read-only, destructive, external, justification, the
 * operative arguments — to tell the truth about a spec
 * (permission-integration#9, #8). Those come from the manifest's `/flags`
 * entry, a table with no descriptions. A bundle granting those tools now
 * INSTALLS the manifest package, but never LOADS its prose, and a compiled
 * single binary embeds only the flags table. The package split that would
 * avoid the install is a new npm package, which a patch release cannot
 * first-publish through the trusted-publishing pipeline; it is left to 0.8.
 *
 * So the rule held here is about what is loaded: only tool-capability imports
 * the descriptions, every other carrier imports `/flags` and nothing else,
 * and the carriers are exactly the reviewed ones.
 */
describe("the tool manifest's descriptions are loaded only by bundles that asked for them", () => {
  const ROOT = join(import.meta.dir, "..", "..", "..");
  const MANIFEST = "@crewhaus/tool-registry-manifest";
  const FLAGS_ONLY = `${MANIFEST}/flags`;

  function deps(pkg: string): ReadonlyArray<string> {
    const file = join(ROOT, "packages", pkg.replace("@crewhaus/", ""), "package.json");
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(parsed.dependencies ?? {});
  }

  /** Every `@crewhaus/*` package a bundle granting `root`'s tools installs. */
  function closure(root: string): ReadonlySet<string> {
    const seen = new Set<string>();
    const queue = [root];
    while (queue.length > 0) {
      const next = queue.pop();
      if (next === undefined || seen.has(next) || !next.startsWith("@crewhaus/")) continue;
      seen.add(next);
      queue.push(...deps(next));
    }
    return seen;
  }

  /** The manifest specifiers a package's non-test sources import. */
  function manifestImports(pkg: string): string[] {
    const src = join(ROOT, "packages", pkg.replace("@crewhaus/", ""), "src");
    if (!existsSync(src)) return [];
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          const text = readFileSync(full, "utf-8");
          for (const m of text.matchAll(/from "(@crewhaus\/tool-registry-manifest[^"]*)"/g)) {
            out.push(m[1] as string);
          }
        }
      }
    };
    walk(src);
    return out;
  }

  /** The packages that depend on the manifest, each with why. */
  const CARRIERS: Readonly<Record<string, string>> = {
    "tool-approvals":
      "PermissionsSuggest and ApprovalStatus read each builtin's operativeArgs and readOnly flag",
    "tool-capability": "ToolRegistry describes the tools a harness lacks — the prose is its answer",
    "tool-crewhaus": "PermissionAudit reports each builtin's real flags",
  };

  test("the carriers are exactly the reviewed ones", () => {
    const carriers = readdirSync(join(ROOT, "packages"))
      .filter((name) => name.startsWith("tool-") && name !== "tool-registry-manifest")
      .filter((name) => deps(`@crewhaus/${name}`).includes(MANIFEST));
    // The sweep found tool packages to look at.
    expect(carriers.length).toBeGreaterThan(0);
    expect(carriers.sort()).toEqual(Object.keys(CARRIERS).sort());
  });

  test("only tool-capability imports the descriptions; every other carrier imports /flags alone", () => {
    for (const pkg of Object.keys(CARRIERS)) {
      const imports = manifestImports(`@crewhaus/${pkg}`);
      // The carrier really imports it — an exemption for a dependency nothing
      // reads is dead weight.
      expect({ pkg, imports: imports.length > 0 }).toEqual({ pkg, imports: true });
      if (pkg === "tool-capability") continue;
      expect({ pkg, imports: [...new Set(imports)] }).toEqual({ pkg, imports: [FLAGS_ONLY] });
    }
  });

  test("a tool-crewhaus bundle loads no description", () => {
    const reach = closure("@crewhaus/tool-crewhaus");
    // `target-cli` is what it reads the key set from, and it was already there.
    expect(reach.has("@crewhaus/target-cli")).toBe(true);
    // And the closure was really walked, not empty.
    expect(reach.size).toBeGreaterThan(20);
    const prose = [...reach].filter(
      (pkg) => pkg !== MANIFEST && manifestImports(pkg).some((spec) => spec !== FLAGS_ONLY),
    );
    expect(prose).toEqual([]);
  });

  test("a tool-capability bundle does install it, so the check can fail", () => {
    expect(closure("@crewhaus/tool-capability").has(MANIFEST)).toBe(true);
  });
});

/** The value with every object's keys in one order, so two JSON spellings compare. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}
