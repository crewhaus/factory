/**
 * The package reads records and nothing else: no process, no model, no runtime, no
 * server, and no Bun-only API, so any head can carry it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = dirname(new URL(import.meta.url).pathname);

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["a child process", /["']node:child_process["']|["']child_process["']/],
  ["a model adapter", /["']@crewhaus\/adapter-[^"']*["']/],
  ["the model service", /["']@crewhaus\/model-service["']/],
  ["the runtime", /["']@crewhaus\/runtime-core["']/],
  ["the server", /["']@crewhaus\/hangar-server["']/],
  ["a Bun-only API", /\bBun\./],
];

describe("purity", () => {
  test("no source file imports a process, a model, the runtime or the server, or calls Bun", () => {
    const files = readdirSync(SRC).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(files.sort()).toEqual([
      "exec.ts",
      "fold-context.ts",
      "fold-spans.ts",
      "fold-summary.ts",
      "fold-timeline.ts",
      "fold-why.ts",
      "index.ts",
      "lines.ts",
      "load.ts",
      "model.ts",
      "projection.ts",
      "records.ts",
      "taxonomy.ts",
    ]);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(SRC, file), "utf8");
      for (const [what, pattern] of FORBIDDEN)
        if (pattern.test(text)) hits.push(`${file}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  test("the scan finds what it looks for", () => {
    const planted = 'import { spawn } from "node:child_process";\nBun.file("x");\n';
    const found = FORBIDDEN.filter(([, pattern]) => pattern.test(planted)).map(([what]) => what);
    expect(found).toEqual(["a child process", "a Bun-only API"]);
  });

  test("only the loader and the line reader touch the filesystem", () => {
    const touching = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => /["']node:fs["']/.test(readFileSync(join(SRC, name), "utf8")))
      .sort();
    expect(touching).toEqual(["lines.ts", "load.ts"]);
  });
});
