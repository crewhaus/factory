/**
 * The dependency direction: attention sits below Home's server, and nothing a harness runs
 * depends on it. Its main entry is read-only: the control service and the quorum's writer
 * are its `./act` subpath's alone. Reads every workspace package's manifest and walks the
 * `@crewhaus/*` dependency closure, and reads this package's own sources.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const WORKSPACE = join(import.meta.dir, "..", "..", "..");

function manifests(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of ["packages", "apps"]) {
    const base = join(WORKSPACE, group);
    for (const name of readdirSync(base)) {
      const file = join(base, name, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      if (typeof pkg.name !== "string") continue;
      out.set(
        pkg.name,
        Object.keys(pkg.dependencies ?? {}).filter((dep) => dep.startsWith("@crewhaus/")),
      );
    }
  }
  return out;
}

function closure(graph: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(graph.get(from) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return seen;
}

describe("dependency direction", () => {
  const graph = manifests();

  test("attention's closure does not hold Home's server, and the control service's does not hold attention", () => {
    expect(graph.size).toBeGreaterThan(100);
    const mine = closure(graph, "@crewhaus/attention");
    expect(mine.size).toBeGreaterThan(5);
    expect(mine.has("@crewhaus/control-records")).toBe(true);
    expect(mine.has("@crewhaus/hangar-server")).toBe(false);
    for (const below of ["@crewhaus/control-service", "@crewhaus/deployment-controller"]) {
      expect(closure(graph, below).has("@crewhaus/attention")).toBe(false);
    }
  });

  test("only the act subpath reaches a writer: the main entry imports none", () => {
    const WRITERS =
      /from\s+"(?:@crewhaus\/(?:control-service|deployment-controller|access-control)(?:\/[^"]*)?|(?:\.{1,2}\/)+act(?:\/[^"]*)?)"/;
    const files = (readdirSync(import.meta.dir, { recursive: true }) as string[])
      .map((name) => name.split(sep).join("/"))
      .filter(
        (name) =>
          name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("__test__/"),
      );
    const reading = files.filter((name) => !name.startsWith("act/"));
    const acting = files.filter((name) => name.startsWith("act/"));
    expect(reading.length).toBeGreaterThan(15);
    const hits = (names: readonly string[]) =>
      names.filter((name) => WRITERS.test(readFileSync(join(import.meta.dir, name), "utf8")));
    expect(hits(reading)).toEqual([]);
    expect(hits(acting).length).toBeGreaterThan(1);
  });

  test("no target package and not the runtime depend on attention", () => {
    const runners = [...graph.keys()].filter(
      (name) => name.startsWith("@crewhaus/target-") || name === "@crewhaus/runtime-core",
    );
    expect(runners.length).toBeGreaterThan(10);
    expect(runners).toContain("@crewhaus/runtime-core");
    const hits = runners.filter((name) => closure(graph, name).has("@crewhaus/attention"));
    expect(hits).toEqual([]);
  });
});
