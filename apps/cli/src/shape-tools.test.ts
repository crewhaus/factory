/**
 * The 0.7.1 shape-reach guards.
 *
 * 0.7.0 shipped 549 builtins that only the cli shape could use: every other
 * emitter, the eval runner and parts of the CLI kept a private, hand-written
 * copy of the builtin map, eight to twenty-three entries long. These guards
 * hold the fix in place:
 *
 *   1. No emitter, no eval-runner file and no CLI file hand-maintains a
 *      builtin map again — the scan's scope is read off the directory tree,
 *      and the scan proves it can see a map by finding the real table.
 *   2. Every shape's smoke fixture, given `all-compute` plus one tool from
 *      every leaf category, either imports and pins each tool's package or
 *      refuses with the precise per-shape reason. The fixtures and the tool
 *      site come from the smoke harness and the compiler, not from a list.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CompileResult, compile, lower, toolSitesOf } from "@crewhaus/compiler";
import { listFixtureShapes, loadFixture } from "@crewhaus/smoke-harness";
import { parseSpec } from "@crewhaus/spec";
import {
  BUILTIN_TOOLS,
  CATEGORIES,
  SHAPE_TOOL_PROFILES,
  type ToolShape,
  leafCategories,
  toolsInCategory,
} from "@crewhaus/tool-categories";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { collectCrewhausDeps } from "./bundle-manifest";
import { emitCfWorkerBundle } from "./cf-worker-emit";

const REPO = join(import.meta.dir, "..", "..", "..");

// ---------------------------------------------------------------------------
// 1 — no hand-maintained builtin map outside the one table
// ---------------------------------------------------------------------------

/** Every non-test `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The directories the guard covers, derived from the tree: every target
 * emitter, the eval runner, the compiler and the CLI. A new `target-*`
 * package is covered the day it is created.
 */
const SCANNED_DIRS = [
  ...readdirSync(join(REPO, "packages"))
    .filter((name) => name.startsWith("target-"))
    .map((name) => join(REPO, "packages", name, "src")),
  join(REPO, "packages", "eval-runner", "src"),
  join(REPO, "packages", "compiler", "src"),
  join(REPO, "apps", "cli", "src"),
];

const KEYS = new Set(Object.keys(BUILTIN_TOOLS));
const NAMES = new Set(Object.values(BUILTIN_TOOLS).map((e) => e.name));

/**
 * The ways a builtin map has been hand-written in this repo, each keyed to a
 * real builtin so ordinary code never matches:
 *   - `read: { package: "@crewhaus/tool-fs", … }` — the emitters' maps;
 *   - `read: fs.read,` — the CLI's and the eval runner's runtime maps (three
 *     or more such lines: one `hash: a.hash` is an ordinary field copy);
 *   - `runtime: "Read"` — a registered-name column (scaffold-evals had one);
 *   - a literal array of five or more builtin keys — the CLI's key list.
 */
function mapLiterals(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/(\w+)\s*:\s*\{\s*package\s*:\s*"@crewhaus\/tool-[a-z0-9-]+"/g)) {
    if (KEYS.has(m[1] as string)) hits.push(`${m[1]}: { package: … }`);
  }
  const runtimeEntries: string[] = [];
  for (const m of text.matchAll(/^\s*(\w+):\s*(\w+)\.(\w+),\s*$/gm)) {
    const key = m[1] as string;
    if (KEYS.has(key) && BUILTIN_TOOLS[key]?.export === m[3]) {
      runtimeEntries.push(`${key}: ${m[2]}.${m[3]}`);
    }
  }
  if (runtimeEntries.length >= 3) hits.push(...runtimeEntries);
  for (const m of text.matchAll(/runtime:\s*"(\w+)"/g)) {
    if (NAMES.has(m[1] as string)) hits.push(`runtime: "${m[1]}"`);
  }
  for (const m of text.matchAll(/\[((?:\s*"\w+",?){5,})\s*\]/g)) {
    const entries = [...(m[1] as string).matchAll(/"(\w+)"/g)].map((x) => x[1] as string);
    if (entries.every((e) => KEYS.has(e))) hits.push(`[${entries.slice(0, 3).join(", ")}, …]`);
  }
  return hits;
}

describe("no hand-maintained builtin map outside @crewhaus/tool-categories", () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);

  test("the scan reads the files it claims to", () => {
    // Every target emitter, and the files the maps used to live in.
    expect(SCANNED_DIRS.length).toBeGreaterThanOrEqual(20);
    expect(files.length).toBeGreaterThanOrEqual(100);
    for (const f of [
      "packages/target-cli/src/index.ts",
      "packages/target-graph/src/index.ts",
      "packages/target-cf-worker-cli/src/index.ts",
      "packages/eval-runner/src/wire-once.ts",
      "apps/cli/src/index.ts",
      "apps/cli/src/tools-cli.ts",
    ]) {
      expect(files).toContain(join(REPO, f));
    }
  });

  test("the detector finds the table itself, so a miss below is not a blind spot", () => {
    const table = readFileSync(join(REPO, "packages/tool-categories/src/builtins.ts"), "utf-8");
    expect(mapLiterals(table).length).toBe(KEYS.size);
    // And each hand-written shape it guards against, as 0.7.0 wrote them.
    expect(mapLiterals('  read: { package: "@crewhaus/tool-fs", export: "read" },')).toHaveLength(
      1,
    );
    const runtimeMap = "    read: fs.read,\n    write: fs.write,\n    jsonQuery: data.jsonQuery,\n";
    expect(mapLiterals(runtimeMap)).toHaveLength(3);
    expect(mapLiterals("    hash: a.hash,\n")).toEqual([]);
    expect(mapLiterals('  read: { runtime: "Read", keywords: [] },')).toHaveLength(1);
    expect(mapLiterals('["read", "write", "edit", "glob", "grep"]')).toHaveLength(1);
  });

  test("no scanned source file carries one", () => {
    const offenders = files
      .map((file) => ({
        file: file.slice(REPO.length + 1),
        hits: mapLiterals(readFileSync(file, "utf-8")),
      }))
      .filter((x) => x.hits.length > 0);
    expect(
      offenders,
      "a builtin map is hand-maintained here — read BUILTIN_TOOLS / resolveBuiltinTools from @crewhaus/tool-categories instead",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2 — every shape's fixture, with every kind of tool
// ---------------------------------------------------------------------------

/** One tool from every leaf category, plus the whole compute roll-up. */
const LEAF_PICKS = leafCategories().map(
  (c) => [...(CATEGORIES[c]?.tools ?? [])].sort()[0] as string,
);
const SELECTORS = ["all-compute", ...LEAF_PICKS];
const EXPECTED_KEYS = [...new Set([...toolsInCategory("compute"), ...LEAF_PICKS])];

/** Set `value` at a spec path like `steps[0].tools` or `nodes.plan.tools`. */
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").flatMap((p): Array<string | number> => {
    const m = p.match(/^(\w[\w-]*)\[(\d+)\]$/);
    return m !== null ? [m[1] as string, Number(m[2])] : [p];
  });
  let node = root as Record<string | number, unknown>;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Record<string | number, unknown>;
  }
  node[parts[parts.length - 1] as string | number] = value;
}

/** The fixture with `tools` at the first place its shape keeps tools, or undefined if it has none. */
function withTools(shape: string, tools: ReadonlyArray<string>): string | undefined {
  const text = loadFixture(shape);
  const site = toolSitesOf(lower(parseSpec(text)))[0];
  if (site === undefined) return undefined;
  const doc = parseYaml(text) as Record<string, unknown>;
  setPath(doc, site.path, [...tools]);
  return stringifyYaml(doc);
}

const FIXTURES = listFixtureShapes();

describe("every shape's fixture compiles every kind of tool, or refuses it by name", () => {
  test("the matrix covers every fixture and every leaf category", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15);
    expect(LEAF_PICKS.length).toBe(leafCategories().length);
    expect(LEAF_PICKS.length).toBeGreaterThanOrEqual(50);
    expect(EXPECTED_KEYS.length).toBeGreaterThanOrEqual(150);
    // A spec target without a profile could not compile at all; this keeps
    // the fixture set and the profile table in step.
    for (const shape of FIXTURES) {
      const target = parseSpec(loadFixture(shape)).target;
      expect(Object.hasOwn(SHAPE_TOOL_PROFILES, target)).toBe(true);
    }
  });

  for (const shape of FIXTURES) {
    test(shape, () => {
      const target = parseSpec(loadFixture(shape)).target as ToolShape;
      const profile = SHAPE_TOOL_PROFILES[target];
      const yaml = withTools(shape, SELECTORS);
      if (yaml === undefined) {
        // A shape with no tool site at all: its schema has no tools: key.
        expect(profile.runtime).toBe("none");
        return;
      }
      const result: CompileResult = compile(yaml);
      if (profile.runtime === "none") {
        // Accepted, said so, and nothing imported.
        const warning = result.warnings.find((w) => w.code === "accepted-but-unwired");
        expect(warning?.path).toBe("tools");
        const toolDeps = collectCrewhausDeps(result.files).filter((d) =>
          d.startsWith("@crewhaus/tool-"),
        );
        expect(toolDeps).toEqual([]);
        return;
      }
      const deps = new Set(collectCrewhausDeps(result.files));
      const source = result.files.map((f) => f.content).join("\n");
      const missing = EXPECTED_KEYS.filter((key) => {
        const pkg = BUILTIN_TOOLS[key]?.package as string;
        return !deps.has(pkg) || !source.includes(`from "${pkg}"`);
      });
      expect(missing).toEqual([]);
      // A code-execution tool (the code-exec leaf) needs the sandbox floor
      // wired: in the bundle's own loop, or — for eval — by the runner the
      // bundle hands its tool packages to.
      expect(source).toContain(target === "eval" ? "importToolPackage" : "sandboxAvailable");
      // Every file that calls the floor's parser imports it itself. The
      // channel agent and the crew daemon run the loop in a file that does
      // not carry the tool imports, and a missing import there is a
      // ReferenceError on the first code-execution call, not a compile error.
      const unimported = result.files
        .filter((f) => f.content.includes("sandboxAvailableFromEnv("))
        .filter(
          (f) =>
            !/import \{[^}]*\bsandboxAvailableFromEnv\b[^}]*\} from "@crewhaus\/tool-code-execution";/.test(
              f.content,
            ),
        )
        .map((f) => f.path);
      expect(unimported).toEqual([]);
    });
  }
});

describe("the cf-worker flavour refuses precisely what the edge cannot run", () => {
  const EDGE_FIXTURES = FIXTURES.filter((s) => ["cli", "workflow", "graph"].includes(s));

  test("the cf-worker fixtures are the three shapes it emits", () => {
    expect([...EDGE_FIXTURES].sort()).toEqual(["cli", "graph", "workflow"]);
  });

  for (const shape of EDGE_FIXTURES) {
    test(`${shape}: every compute builtin is a named warning and is left out`, () => {
      const yaml = withTools(shape, ["all-compute"]);
      if (yaml === undefined) throw new Error(`${shape} has no tool site`);
      const bundle = emitCfWorkerBundle(lower(parseSpec(yaml)));
      expect(bundle.warnings).toHaveLength(toolsInCategory("compute").length);
      for (const w of bundle.warnings) {
        expect(w.code).toBe("edge-unsafe-tool");
        expect(w.message).toMatch(
          /^tool "\w+" is a builtin, but the cf-worker target cannot run it: /,
        );
      }
      const worker = bundle.files.find((f) => f.path === "worker.js")?.content ?? "";
      expect(worker).not.toMatch(/@crewhaus\/tool-(?!catalog)/);
    });

    test(`${shape}: a host tool the edge has always refused still fails the compile`, () => {
      const yaml = withTools(shape, SELECTORS);
      if (yaml === undefined) throw new Error(`${shape} has no tool site`);
      expect(() => emitCfWorkerBundle(lower(parseSpec(yaml)))).toThrow(
        /cf-worker target cannot run \d+ host tool\(s\): tool "\w+"/,
      );
    });
  }
});
