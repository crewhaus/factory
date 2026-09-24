/**
 * The `compute` roll-up's title is a promise about its members, so it is
 * checked against their source rather than trusted.
 *
 * 0.7.0 titled it "no I/O at all — pure", while DeadlineCheck, ErrorClassify
 * and SequenceRun read the clock, Uuid v4 the CSPRNG and LocalTime the host's
 * zone whenever a call left out now, seed or timeZone. The title now names
 * those five. This scan finds every package behind a compute tool that reads
 * the clock, randomness or the environment, and fails if the set moves — a
 * sixth package doing so needs the title (and the docs) to say so first.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOLS, CATEGORIES, toolsInCategory } from "./index";

const PACKAGES_DIR = join(import.meta.dir, "..", "..");

/** Reads that make a call's answer depend on when or where it ran. */
const IMPURE = [
  /\bDate\.now\s*\(/,
  /\bnew Date\s*\(\s*\)/,
  /\bperformance\.now\s*\(/,
  /\bgetRandomValues\s*\(/,
  /\brandomUUID\s*\(/,
  /\brandomBytes\s*\(/,
  /\bMath\.random\s*\(/,
  /resolvedOptions\s*\(\s*\)\s*\.\s*timeZone/,
  /\bprocess\.env\b/,
];

/** Source with comments blanked, so a comment that names Date.now() is not a read. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const at = join(dir, name);
    if (statSync(at).isDirectory()) sourceFiles(at, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(at);
    }
  }
  return out;
}

/** Package name -> how many impure reads its source makes. */
function impureReads(packages: ReadonlyArray<string>): Map<string, number> {
  const found = new Map<string, number>();
  for (const pkg of packages) {
    const dir = join(PACKAGES_DIR, pkg.replace(/^@crewhaus\//, ""), "src");
    for (const file of sourceFiles(dir)) {
      const body = code(readFileSync(file, "utf-8"));
      for (const pattern of IMPURE) {
        const hits = body.match(new RegExp(pattern.source, "g"))?.length ?? 0;
        if (hits > 0) found.set(pkg, (found.get(pkg) ?? 0) + hits);
      }
    }
  }
  return found;
}

describe("the compute roll-up says what its members read", () => {
  const packages = [
    ...new Set(toolsInCategory("compute").map((key) => BUILTIN_TOOLS[key]?.package as string)),
  ].sort();

  test("the scan covers every package behind a compute tool", () => {
    expect(packages).toEqual([
      "@crewhaus/tool-data",
      "@crewhaus/tool-datetime",
      "@crewhaus/tool-encode",
      "@crewhaus/tool-flow",
      "@crewhaus/tool-math",
      "@crewhaus/tool-onchain",
      "@crewhaus/tool-schema",
      "@crewhaus/tool-text",
    ]);
  });

  test("only the packages the title names read the clock, randomness or the host", () => {
    const reads = impureReads(packages);
    // tool-flow: Date.now() behind DeadlineCheck, ErrorClassify and
    // SequenceRun; tool-encode: the CSPRNG behind plain Uuid v4;
    // tool-datetime: TZ (and NODE_ENV, its test gate) behind LocalTime.
    expect([...reads.keys()].sort()).toEqual([
      "@crewhaus/tool-datetime",
      "@crewhaus/tool-encode",
      "@crewhaus/tool-flow",
    ]);
    // Every one of them is a real read, not a pattern that matches nothing.
    for (const count of reads.values()) expect(count).toBeGreaterThan(0);
  });

  test("the title names each exception and no longer promises no I/O at all", () => {
    const title = CATEGORIES["compute"]?.title ?? "";
    expect(title).not.toContain("no I/O at all");
    const named = ["DeadlineCheck", "ErrorClassify", "SequenceRun", "Uuid", "LocalTime"];
    expect(named.filter((name) => !title.includes(name))).toEqual([]);
    const computeNames = toolsInCategory("compute").map((key) => BUILTIN_TOOLS[key]?.name);
    expect(named.filter((name) => !computeNames.includes(name))).toEqual([]);
  });

  test("the comment-stripper keeps code and drops comments", () => {
    expect(code("const a = Date.now(); // Date.now()\n/* new Date() */ x")).toBe(
      "const a = Date.now(); \n  x",
    );
    expect(code('const u = "http://x"; // Math.random()')).toBe('const u = "http://x"; ');
  });
});
