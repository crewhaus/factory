import { describe, expect, test } from "bun:test";
import {
  CATEGORIES,
  ToolCategoryError,
  allRegisteredTools,
  categoriesForTool,
  expandToolSelectors,
  leafCategories,
  parseSelector,
  rollUpCategories,
  toolsInCategory,
  usesCategorySyntax,
} from "./index";

describe("parseSelector", () => {
  test("a bare key is an include", () => {
    expect(parseSelector("read")).toEqual({ kind: "tool", key: "read", exclude: false });
  });

  test("a leading dash is an exclusion", () => {
    expect(parseSelector("-read")).toEqual({ kind: "tool", key: "read", exclude: true });
  });

  test("all- names a category", () => {
    expect(parseSelector("all-fs")).toEqual({ kind: "category", name: "fs", exclude: false });
  });

  test("-all- excludes a whole category", () => {
    expect(parseSelector("-all-fs")).toEqual({ kind: "category", name: "fs", exclude: true });
  });

  test("a tool key containing a dash is not mistaken for an exclusion", () => {
    // Only a LEADING dash excludes; the prefix check must not be a substring test.
    expect(parseSelector("code-exec-thing")).toEqual({
      kind: "tool",
      key: "code-exec-thing",
      exclude: false,
    });
  });
});

describe("usesCategorySyntax", () => {
  test("false for a plain list — the back-compat path", () => {
    expect(usesCategorySyntax(["read", "write"])).toBe(false);
  });

  test("true when a category appears", () => {
    expect(usesCategorySyntax(["all-fs"])).toBe(true);
  });

  test("true when an exclusion appears", () => {
    expect(usesCategorySyntax(["read", "-write"])).toBe(true);
  });
});

describe("toolsInCategory", () => {
  test("a leaf returns its own keys, sorted", () => {
    expect(toolsInCategory("fs")).toEqual(["edit", "glob", "grep", "read", "write"]);
  });

  test("a roll-up follows includes transitively", () => {
    const code = toolsInCategory("code");
    // via fs
    expect(code).toContain("read");
    // via codegraph
    expect(code).toContain("codegraphImpact");
    // via process
    expect(code).toContain("bash");
    // via code-exec
    expect(code).toContain("python");
  });

  test("result is de-duplicated and sorted", () => {
    const code = toolsInCategory("code");
    expect([...code]).toEqual([...code].sort());
    expect(new Set(code).size).toBe(code.length);
  });

  test("unknown category names the known ones", () => {
    expect(() => toolsInCategory("nope")).toThrow(ToolCategoryError);
    try {
      toolsInCategory("nope");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('unknown tool category "all-nope"');
      expect(msg).toContain("all-fs");
    }
  });

  test("a near-miss gets a suggestion", () => {
    try {
      toolsInCategory("cod");
    } catch (err) {
      expect((err as Error).message).toContain("Did you mean");
    }
  });
});

describe("expandToolSelectors — plain lists stay untouched", () => {
  test("a list with no category syntax passes through", () => {
    const out = expandToolSelectors(["read", "glob"]);
    expect(out.tools).toEqual(["read", "glob"]);
    expect(out.expanded).toBe(false);
  });

  test("order is preserved on the back-compat path so bundles stay byte-identical", () => {
    expect(expandToolSelectors(["write", "read"]).tools).toEqual(["write", "read"]);
  });

  test("the untouched path is exact identity, duplicates and all", () => {
    // Deliberate: a spec that does not opt into the grammar must lower to
    // byte-identical bundles, so this path must not sort or de-duplicate.
    const input = ["read", "read", "glob"];
    expect(expandToolSelectors(input).tools).toEqual(input);
  });

  test("set-union de-duplication applies once the grammar is used", () => {
    expect(expandToolSelectors(["all-fs", "read"]).tools.filter((t) => t === "read").length).toBe(
      1,
    );
  });

  test("an empty list is legal and means no tools", () => {
    expect(expandToolSelectors([]).tools).toEqual([]);
  });
});

describe("expandToolSelectors — categories", () => {
  test("all-<category> expands to its tools", () => {
    const out = expandToolSelectors(["all-fs"]);
    expect(out.tools).toEqual(["edit", "glob", "grep", "read", "write"]);
    expect(out.expanded).toBe(true);
  });

  test("category plus an individual tool unions them", () => {
    const out = expandToolSelectors(["all-fs", "webFetch"]);
    expect(out.tools).toContain("read");
    expect(out.tools).toContain("webFetch");
  });

  test("two categories union", () => {
    const out = expandToolSelectors(["all-fs", "all-web"]);
    expect(out.tools).toContain("read");
    expect(out.tools).toContain("webSearch");
  });

  test("the headline case: a category minus one tool", () => {
    const out = expandToolSelectors(["all-fs", "-write"]);
    expect(out.tools).toEqual(["edit", "glob", "grep", "read"]);
    expect(out.tools).not.toContain("write");
  });

  test("-all-<category> subtracts a whole category", () => {
    const out = expandToolSelectors(["all-code", "-all-process"]);
    expect(out.tools).toContain("read");
    expect(out.tools).not.toContain("bash");
    expect(out.tools).not.toContain("killShell");
  });

  test("excludes win regardless of order", () => {
    const before = expandToolSelectors(["-write", "all-fs"]).tools;
    const after = expandToolSelectors(["all-fs", "-write"]).tools;
    expect(before).toEqual(after);
    expect(before).not.toContain("write");
  });

  test("a tool included by name and excluded by name is removed", () => {
    const out = expandToolSelectors(["all-fs", "read", "-read"]);
    expect(out.tools).not.toContain("read");
  });

  test("output is sorted so the IR is stable across equivalent specs", () => {
    const a = expandToolSelectors(["all-web", "all-fs"]).tools;
    const b = expandToolSelectors(["all-fs", "all-web"]).tools;
    expect(a).toEqual(b);
    expect([...a]).toEqual([...a].sort());
  });

  test("excluding everything is legal and yields no tools", () => {
    expect(expandToolSelectors(["all-fs", "-all-fs"]).tools).toEqual([]);
  });
});

describe("expandToolSelectors — errors", () => {
  test("an unknown category is rejected with the path", () => {
    expect(() => expandToolSelectors(["all-gti"], { path: "steps[1].tools" })).toThrow(
      /steps\[1\]\.tools/,
    );
  });

  test("an exclusion that removes nothing is rejected — it is almost always a typo", () => {
    expect(() => expandToolSelectors(["all-fs", "-gitPush"])).toThrow(ToolCategoryError);
    try {
      expandToolSelectors(["all-fs", "-gitPush"]);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('"-gitPush"');
      expect(msg).toContain("nothing includes");
      // the message should show what IS included, so the fix is obvious
      expect(msg).toContain("read");
    }
  });

  test("a misspelled exclusion of a real tool is still caught", () => {
    // `writ` is not in the included set even though `write` is.
    expect(() => expandToolSelectors(["all-fs", "-writ"])).toThrow(/nothing includes/);
  });

  test("several bad exclusions are reported together", () => {
    try {
      expandToolSelectors(["all-fs", "-aaa", "-bbb"]);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('"-aaa"');
      expect(msg).toContain('"-bbb"');
    }
  });

  test("several unknown categories are reported together", () => {
    try {
      expandToolSelectors(["all-xxx", "all-yyy"]);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("all-xxx");
      expect(msg).toContain("all-yyy");
    }
  });

  test("an exclusion-only list is rejected rather than silently empty", () => {
    expect(() => expandToolSelectors(["-read"])).toThrow(/nothing includes/);
  });
});

describe("registry shape", () => {
  test("every category is either a leaf or a roll-up, never both and never neither", () => {
    for (const [name, def] of Object.entries(CATEGORIES)) {
      const isLeaf = def.tools !== undefined;
      const isRollUp = def.includes !== undefined;
      expect(isLeaf || isRollUp).toBe(true);
      expect(isLeaf && isRollUp).toBe(false);
      expect(def.title.length).toBeGreaterThan(0);
    }
  });

  test("every roll-up names categories that exist", () => {
    for (const name of rollUpCategories()) {
      for (const child of CATEGORIES[name]?.includes ?? []) {
        expect(CATEGORIES[child]).toBeDefined();
      }
    }
  });

  test("every category resolves without throwing", () => {
    for (const name of Object.keys(CATEGORIES)) {
      expect(() => toolsInCategory(name)).not.toThrow();
    }
  });

  test("every leaf category is non-empty", () => {
    for (const name of leafCategories()) {
      expect(toolsInCategory(name).length).toBeGreaterThan(0);
    }
  });

  test("no tool key is claimed by two different leaf categories", () => {
    const owner = new Map<string, string>();
    for (const name of leafCategories()) {
      for (const key of CATEGORIES[name]?.tools ?? []) {
        const prior = owner.get(key);
        expect(prior === undefined || prior === name).toBe(true);
        owner.set(key, name);
      }
    }
  });

  test("category names never collide with the all- prefix", () => {
    // `all-all-x` would be unparseable; guard against a category named all-*.
    for (const name of Object.keys(CATEGORIES)) {
      expect(name.startsWith("all-")).toBe(false);
      expect(name.startsWith("-")).toBe(false);
    }
  });
});

describe("lookup helpers", () => {
  test("allRegisteredTools covers every leaf", () => {
    const all = allRegisteredTools();
    expect(all).toContain("read");
    expect(all).toContain("bash");
    expect(all).toContain("webFetch");
    expect([...all]).toEqual([...all].sort());
  });

  test("categoriesForTool reports the leaf and the roll-up above it", () => {
    const cats = categoriesForTool("read");
    expect(cats).toContain("fs");
    expect(cats).toContain("code");
  });

  test("categoriesForTool is empty for an unknown key", () => {
    expect(categoriesForTool("definitelyNotATool")).toEqual([]);
  });
});
