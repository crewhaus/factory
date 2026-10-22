import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as ledger from "./index";

describe("@crewhaus/claim-ledger", () => {
  test("exports the text layer the gate, the tools and the graders read", () => {
    for (const name of [
      "STOPWORDS",
      "contentTokens",
      "coverage",
      "splitSentences",
      "sentences",
      "isQuestion",
      "claimSentences",
      "MIN_CLAIM_TOKENS",
      "lintCitations",
      "citationDefinitions",
      "citedClaims",
      "codeSpanTest",
      "extractClaims",
      "classifyDefinition",
      "definitionGloss",
      "isAssumptionMarker",
      "indexSource",
      "locateClaim",
      "governingNegation",
      "clauseNumbers",
      "breaksClause",
      "tightestWindows",
      "extractNumbers",
      "containsValue",
      "quotedSpans",
      "messageText",
    ]) {
      expect(ledger).toHaveProperty(name);
    }
  });

  test("keeps the grammar's constants and extractor plumbing private", () => {
    for (const name of [
      "CITATION_MARKER",
      "DEFINITION",
      "markersOutsideCode",
      "definitionRanges",
      "definitionEntries",
      "definitionItemSource",
      "commonMarkFences",
      "readBlocks",
      "labelRunStart",
    ]) {
      expect(ledger).not.toHaveProperty(name);
    }
  });

  test("depends on nothing and imports no package (design §4.1: dependency-free)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});
    // A dev dependency on another package is still an edge a bundler can follow.
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
      expect(name).not.toMatch(/^@crewhaus\//);
    }
    // Every way a module names another: import … from, export … from, a bare
    // import, import(), require().
    const specifier =
      /(?:^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/gm;
    let seen = 0;
    for (const file of readdirSync(import.meta.dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(join(import.meta.dir, file), "utf-8");
      for (const m of source.matchAll(specifier)) {
        seen += 1;
        expect(`${file}: ${m[1]}`).toMatch(/: \.\//);
      }
    }
    // index.ts is made of `export … from "./…"` lines: the scan must see them.
    expect(seen).toBeGreaterThan(10);
  });

  test("the specifier scan catches every form it guards against", () => {
    const specifier =
      /(?:^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/gm;
    const found = (source: string): string[] =>
      [...source.matchAll(specifier)].map((m) => m[1] as string);
    expect(found('export { x } from "@crewhaus/errors";')).toEqual(["@crewhaus/errors"]);
    expect(found('export {\n  a,\n  b,\n} from "@crewhaus/ir";')).toEqual(["@crewhaus/ir"]);
    expect(found('import type { T } from "@crewhaus/ir";')).toEqual(["@crewhaus/ir"]);
    expect(found('import "@crewhaus/side-effect";')).toEqual(["@crewhaus/side-effect"]);
    expect(found('const m = await import("@crewhaus/lazy");')).toEqual(["@crewhaus/lazy"]);
    expect(found("const m = require('@crewhaus/cjs');")).toEqual(["@crewhaus/cjs"]);
  });
});
