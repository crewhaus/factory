import { afterEach, describe, expect, test } from "bun:test";
import {
  type CodeGraphClient,
  type CodeGraphNode,
  _injectCodeGraphFactory,
  codegraphCallees,
  codegraphCallers,
  codegraphImpact,
  codegraphSearch,
  codegraphTools,
} from "./index";

afterEach(() => {
  _injectCodeGraphFactory(undefined);
});

function makeClient(stubs: Partial<CodeGraphClient> = {}): CodeGraphClient {
  return {
    searchNodes: async () => [],
    getCallers: async () => [],
    getCallees: async () => [],
    getImpactRadius: async () => ({ direct: 0, transitive: 0 }),
    ...stubs,
  };
}

describe("codegraphSearch", () => {
  test("returns formatted hits", async () => {
    const client = makeClient({
      searchNodes: async (q) => {
        expect(q).toBe("parseSpec");
        return [
          { name: "parseSpec", kind: "function", file: "src/spec.ts", line: 42 },
          { name: "parseSpecYaml", kind: "function", file: "src/yaml.ts", line: 17 },
        ] as ReadonlyArray<CodeGraphNode>;
      },
    });
    _injectCodeGraphFactory(async () => client);
    const out = await codegraphSearch.execute({ query: "parseSpec", limit: 10 });
    expect(out).toContain("parseSpec");
    expect(out).toContain("src/spec.ts:42");
    expect(out).toContain("src/yaml.ts:17");
  });

  test("returns 'No symbols' on empty result", async () => {
    _injectCodeGraphFactory(async () => makeClient());
    const out = await codegraphSearch.execute({ query: "ghost", limit: 10 });
    expect(out).toMatch(/No symbols matching/);
  });

  test("is internal scope (egress fabric skips it)", () => {
    expect(codegraphSearch.scope).toBe("internal");
  });
});

describe("codegraphCallers / Callees", () => {
  test("callers formats hits", async () => {
    _injectCodeGraphFactory(async () =>
      makeClient({
        getCallers: async () => [
          { name: "compileSpec", kind: "function", file: "src/compile.ts", line: 5 },
        ],
      }),
    );
    const out = await codegraphCallers.execute({ symbol: "parseSpec" });
    expect(out).toContain("compileSpec");
    expect(out).toContain("src/compile.ts:5");
  });

  test("callers empty result", async () => {
    _injectCodeGraphFactory(async () => makeClient());
    const out = await codegraphCallers.execute({ symbol: "parseSpec" });
    expect(out).toMatch(/No callers of/);
  });

  test("callees formats hits", async () => {
    _injectCodeGraphFactory(async () =>
      makeClient({
        getCallees: async () => [
          { name: "tokenize", kind: "function", file: "src/lex.ts", line: 10 },
          { name: "validate", kind: "function", file: "src/validate.ts", line: 33 },
        ],
      }),
    );
    const out = await codegraphCallees.execute({ symbol: "parseSpec" });
    expect(out).toContain("tokenize");
    expect(out).toContain("validate");
  });
});

describe("codegraphImpact", () => {
  test("formats direct + transitive counts", async () => {
    _injectCodeGraphFactory(async () =>
      makeClient({
        getImpactRadius: async () => ({ direct: 3, transitive: 47 }),
      }),
    );
    const out = await codegraphImpact.execute({ symbol: "IrV0" });
    expect(out).toContain("direct callers:     3");
    expect(out).toContain("transitive callers: 47");
  });
});

describe("missing SDK", () => {
  test("clear error message when peer dep isn't installed", async () => {
    _injectCodeGraphFactory(undefined);
    // No peer installed in this monorepo; expect the helpful error.
    await expect(codegraphSearch.execute({ query: "x", limit: 1 })).rejects.toThrow(
      /requires the optional peer dependency/,
    );
  });
});

describe("codegraphTools bundle", () => {
  test("exports all four tools", () => {
    expect(codegraphTools.length).toBe(4);
    expect(codegraphTools.map((t) => t.name)).toEqual([
      "CodeGraphSearch",
      "CodeGraphCallers",
      "CodeGraphCallees",
      "CodeGraphImpact",
    ]);
  });

  test("all tools are read-only and internal-scoped", () => {
    for (const t of codegraphTools) {
      expect(t.readOnly).toBe(true);
      expect(t.scope).toBe("internal");
    }
  });
});
