import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * This package is Bun-only: `./regex` starts Bun Workers, `./streams` calls
 * `Bun.spawn` and imports `node:fs`, and `withRawBody`'s `decompress: false`
 * is a Bun fetch option that workerd does not have. The tools a cf-worker
 * target bundles (its `EDGE_TOOL_IMPORTS`) must therefore never depend on
 * it, directly or through another workspace package. An edge tool needs its
 * own bound (see the README).
 */

const PACKAGES = join(import.meta.dir, "..", "..");
const TARGETS = ["target-cf-worker-cli", "target-cf-worker-workflow", "target-cf-worker-graph"];
const FORBIDDEN = "@crewhaus/tool-safety";

/** The package names in a target's `EDGE_TOOL_IMPORTS` table. */
function edgePackages(source: string): string[] {
  const start = source.indexOf("const EDGE_TOOL_IMPORTS");
  if (start === -1) return [];
  const end = source.indexOf("\n};", start);
  const block = source.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/package:\s*"(@crewhaus\/[a-z0-9-]+)"/g)].map((m) => m[1] as string);
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
  test("no EDGE_TOOL_IMPORTS package has it in its workspace dependency closure", () => {
    const deps = workspaceDeps();
    const edge = new Set<string>();
    for (const target of TARGETS) {
      const found = edgePackages(readFileSync(join(PACKAGES, target, "src", "index.ts"), "utf8"));
      // The guard's hit count: each target's table was found and read.
      expect({ target, packages: found.length > 0 }).toEqual({ target, packages: true });
      for (const name of found) edge.add(name);
    }
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
  });

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
