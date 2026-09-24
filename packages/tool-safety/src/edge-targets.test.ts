import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOLS, builtinToolsFor } from "@crewhaus/tool-categories";

/**
 * This package is Bun-only: `./regex` starts Bun Workers, `./streams` calls
 * `Bun.spawn` and imports `node:fs`, and `withRawBody`'s `decompress: false`
 * is a Bun fetch option that workerd does not have. The tools a cf-worker
 * target bundles must therefore never depend on it, directly or through
 * another workspace package. An edge tool needs its own bound (see the
 * README).
 *
 * Which tools the edge bundles is read from the one builtin table every
 * emitter resolves through (`builtinToolsFor("cf-worker")` in
 * @crewhaus/tool-categories), not from a per-target map: since 0.7.1 no
 * emitter keeps one, and apps/cli/src/shape-tools.test.ts fails if one
 * reappears.
 */

const PACKAGES = join(import.meta.dir, "..", "..");
const FORBIDDEN = "@crewhaus/tool-safety";

/**
 * Every package a cf-worker bundle can import for its tools: the package of
 * each builtin the edge profile carries, plus the table package itself (the
 * edge emitters import its config registrar).
 */
function edgePackages(): string[] {
  const out = new Set<string>(["@crewhaus/tool-categories"]);
  for (const key of builtinToolsFor("cf-worker")) {
    const entry = BUILTIN_TOOLS[key];
    if (entry !== undefined) out.add(entry.package);
  }
  return [...out].sort();
}

type Manifest = {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

/** Every workspace package reachable from `start`, `start` included. */
function closure(start: string, deps: (name: string) => ReadonlyArray<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...deps(name));
  }
  return seen;
}

function workspaceDeps(): (name: string) => string[] {
  const byName = new Map<string, Manifest>();
  for (const dir of readdirSync(PACKAGES)) {
    const file = join(PACKAGES, dir, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest & { name?: string };
    if (typeof manifest.name === "string") byName.set(manifest.name, manifest);
  }
  return (name) => {
    const manifest = byName.get(name);
    if (manifest === undefined) return [];
    return Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((d) =>
      byName.has(d),
    );
  };
}

describe("cf-worker targets never bundle this Bun-only package", () => {
  test("no package the edge bundles has it in its workspace dependency closure", () => {
    const deps = workspaceDeps();
    const edge = new Set<string>(edgePackages());
    // The guard's hit count: the edge profile carries tools, from more than
    // the table package alone, and fetch is among them.
    expect(builtinToolsFor("cf-worker").length).toBeGreaterThan(0);
    expect(edge.has("@crewhaus/tool-fetch")).toBe(true);
    expect(edge.size).toBeGreaterThanOrEqual(5);
    const offenders: string[] = [];
    let walked = 0;
    for (const name of edge) {
      const reach = closure(name, deps);
      walked += reach.size;
      if (reach.has(FORBIDDEN)) offenders.push(name);
    }
    expect(walked).toBeGreaterThan(edge.size);
    expect(offenders).toEqual([]);
  }, 20_000);

  test("the closure walk finds the package through an intermediate dependency", () => {
    const graph: Record<string, string[]> = {
      "@crewhaus/tool-edge": ["@crewhaus/helper"],
      "@crewhaus/helper": [FORBIDDEN],
      [FORBIDDEN]: [],
    };
    expect(closure("@crewhaus/tool-edge", (n) => graph[n] ?? []).has(FORBIDDEN)).toBe(true);
    expect(
      closure("@crewhaus/helper", (n) => (n === "@crewhaus/helper" ? [] : [])).has(FORBIDDEN),
    ).toBe(false);
  });
});
