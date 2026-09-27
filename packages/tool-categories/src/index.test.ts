import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOLS,
  CATEGORIES,
  LOCAL_TOOLS_IN_NETWORK_ROLLUP,
  NETWORK_LEAVES_OUTSIDE_ROLLUP,
  NETWORK_TOOLS_OUTSIDE_ROLLUP,
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

// flag-truth-6#10 — inertness was judged per KEY: every key an exclusion
// named had to be included, so `-all-network` failed after `all-code` because
// most network tools are not code tools, although it removed eight that are.
describe("expandToolSelectors — each exclusion is judged on its own", () => {
  const code = toolsInCategory("code");
  const network = new Set(toolsInCategory("network"));

  test("-all-<category> that only partly overlaps the includes subtracts the overlap", () => {
    const overlap = code.filter((k) => network.has(k));
    // The case is only this one while the overlap is partial on both sides.
    expect(overlap.length).toBeGreaterThanOrEqual(8);
    expect([...network].some((k) => !code.includes(k))).toBe(true);
    const out = expandToolSelectors(["all-code", "-all-network"]);
    expect(out.tools).toEqual(code.filter((k) => !network.has(k)));
    expect(out.tools).toContain("read");
    expect(out.tools).not.toContain("registrySearch");
    expect(out.tools).not.toContain("dependencyAudit");
  });

  test("a roll-up minus a leaf set it only half holds", () => {
    const filesystem = new Set(toolsInCategory("filesystem"));
    const fsx = toolsInCategory("fsx");
    expect(fsx.filter((k) => filesystem.has(k)).length).toBeGreaterThan(0);
    expect([...filesystem].some((k) => !fsx.includes(k))).toBe(true);
    expect(expandToolSelectors(["all-fsx", "-all-filesystem"]).tools).toEqual(
      fsx.filter((k) => !filesystem.has(k)),
    );
  });

  test("a category exclusion that removes nothing is still refused, by its own name", () => {
    expect(toolsInCategory("chain").filter((k) => toolsInCategory("fs").includes(k))).toEqual([]);
    expect(() => expandToolSelectors(["all-fs", "-all-chain"])).toThrow(
      'tools: "-all-chain" excludes a category none of whose tools is included.',
    );
  });

  test("a bare exclusion is judged alone, beside a category exclusion that does remove something", () => {
    expect(code).not.toContain("dnsLookup");
    let message = "";
    try {
      expandToolSelectors(["all-code", "-all-network", "-dnsLookup"]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toStartWith('tools: "-dnsLookup" excludes a tool that nothing includes.');
    expect(message).not.toContain('"-all-network"');
  });

  test("both kinds of inert exclusion are reported together", () => {
    expect(() => expandToolSelectors(["all-fs", "-gitPush", "-all-chain"])).toThrow(
      'tools: "-gitPush" excludes a tool that nothing includes; "-all-chain" excludes a category none of whose tools is included.',
    );
  });
});

// security-12#14 — `CATEGORIES` is an object literal, so a category named
// after an Object.prototype member resolved to that member: `all-constructor`
// expanded to no tools and `-all-hasOwnProperty` was a silent no-op, where
// every other unknown name is refused.
describe("a category name is never an Object.prototype member", () => {
  const inherited = Object.getOwnPropertyNames(Object.prototype);

  test("each one is an unknown category, as an include and as an exclusion", () => {
    expect(inherited).toContain("constructor");
    expect(inherited).toContain("__proto__");
    expect(inherited.length).toBeGreaterThanOrEqual(12);
    for (const name of inherited) {
      expect(() => toolsInCategory(name)).toThrow(ToolCategoryError);
      expect(() => expandToolSelectors([`all-${name}`])).toThrow(
        `tools: unknown tool category "all-${name}"`,
      );
      expect(() => expandToolSelectors(["read", `-all-${name}`])).toThrow(
        `tools: unknown tool category "all-${name}"`,
      );
    }
  });

  test("a real category still resolves", () => {
    expect(toolsInCategory("git")).toContain("gitCommit");
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
    expect(categoriesForTool("constructor")).toEqual([]);
  });

  // docs-claims#14 — the docstrings said "leaf first", and the order was
  // alphabetical: gitCommit read `code, git`.
  test("categoriesForTool lists the owning leaf first, then the roll-ups alphabetically", () => {
    expect(categoriesForTool("gitCommit")).toEqual(["git", "code"]);
    expect(categoriesForTool("abiDecode")).toEqual(["onchain", "chain", "compute"]);
    const leaves = new Set(leafCategories());
    const all = allRegisteredTools();
    expect(all.length).toBeGreaterThanOrEqual(500);
    const bad = all.filter((k) => {
      const cats = categoriesForTool(k);
      const rollUps = cats.slice(1);
      return (
        !leaves.has(cats[0] ?? "") ||
        rollUps.some((c) => leaves.has(c)) ||
        rollUps.join() !== [...rollUps].sort().join()
      );
    });
    expect(bad).toEqual([]);
  });
});

// C038 — the `network` roll-up was titled "Everything that reaches the
// network" while half the builtins whose row says io: "network" sat outside
// it, and it held four tools that never touch the network. Its title now
// says what it holds; this guard keeps the roll-up, the two exemption lists
// and the builtin table's io column (itself checked against every tool by
// apps/cli/src/tool-registry.test.ts) in agreement, both ways.
describe("the network roll-up and the io column agree", () => {
  const inRollup = new Set(toolsInCategory("network"));
  const leafOf = (key: string): string | undefined =>
    leafCategories().find((c) => (CATEGORIES[c]?.tools ?? []).includes(key));
  const networkBuiltins = Object.entries(BUILTIN_TOOLS)
    .filter(([, e]) => e.io === "network")
    .map(([k]) => k);
  // A shape-specific builtin (sendMessage, evmSendTransaction) is in no
  // category at all, so no roll-up can hold it.
  const categorized = networkBuiltins.filter((k) => BUILTIN_TOOLS[k]?.shapes === undefined);

  test("every categorized network builtin is in the roll-up or listed outside it", () => {
    const unlisted = categorized.filter(
      (k) =>
        !inRollup.has(k) &&
        !((leafOf(k) ?? "") in NETWORK_LEAVES_OUTSIDE_ROLLUP) &&
        !(k in NETWORK_TOOLS_OUTSIDE_ROLLUP),
    );
    expect(unlisted).toEqual([]);
    // The guard's hit count: the lists really carry the tools left out.
    const outside = categorized.filter((k) => !inRollup.has(k));
    expect(outside.length).toBeGreaterThan(40);
    expect(networkBuiltins.length - categorized.length).toBe(2);
  });

  test("every listed leaf still reaches the network and is still outside the roll-up", () => {
    const rollupLeaves = new Set(
      (CATEGORIES["network"]?.includes ?? []).flatMap((c) =>
        CATEGORIES[c]?.tools !== undefined ? [c] : (CATEGORIES[c]?.includes ?? []),
      ),
    );
    const stale: string[] = [];
    for (const leaf of Object.keys(NETWORK_LEAVES_OUTSIDE_ROLLUP)) {
      const tools = CATEGORIES[leaf]?.tools;
      if (tools === undefined) stale.push(`${leaf}: not a leaf`);
      else if (!tools.some((k) => BUILTIN_TOOLS[k]?.io === "network"))
        stale.push(`${leaf}: no network tool`);
      if (rollupLeaves.has(leaf)) stale.push(`${leaf}: now in the roll-up`);
    }
    expect(stale).toEqual([]);
    expect(Object.keys(NETWORK_LEAVES_OUTSIDE_ROLLUP).length).toBeGreaterThan(0);
  });

  test("every listed tool still reaches the network, from a leaf the roll-up and the leaf list leave out", () => {
    const stale: string[] = [];
    for (const key of Object.keys(NETWORK_TOOLS_OUTSIDE_ROLLUP)) {
      if (BUILTIN_TOOLS[key]?.io !== "network") stale.push(`${key}: not a network builtin`);
      if (inRollup.has(key)) stale.push(`${key}: now in the roll-up`);
      if ((leafOf(key) ?? "") in NETWORK_LEAVES_OUTSIDE_ROLLUP)
        stale.push(`${key}: its whole leaf is listed`);
    }
    expect(stale).toEqual([]);
    expect(Object.keys(NETWORK_TOOLS_OUTSIDE_ROLLUP).length).toBeGreaterThan(0);
  });

  test("the only roll-up members with no network I/O are the named local helpers", () => {
    const local = [...inRollup].filter((k) => BUILTIN_TOOLS[k]?.io !== "network").sort();
    expect(local).toEqual([...LOCAL_TOOLS_IN_NETWORK_ROLLUP].sort());
  });

  test("the note names every leaf and tool left out, and the title no longer claims everything", () => {
    const def = CATEGORIES["network"];
    expect(def?.title).not.toMatch(/^everything/i);
    const note = def?.note ?? "";
    for (const leaf of Object.keys(NETWORK_LEAVES_OUTSIDE_ROLLUP)) {
      expect(note).toContain(`all-${leaf}`);
    }
    for (const key of Object.keys(NETWORK_TOOLS_OUTSIDE_ROLLUP)) expect(note).toContain(key);
  });

  test("the roll-up grants what it granted on 0.7.0", () => {
    // Retitled, not widened: a spec that wrote all-network keeps its grant.
    expect([...inRollup].sort()).toEqual(
      [
        "web",
        "http",
        "registry",
        "supplychain",
        "containers",
        "chainread",
        "chaincall",
        "token",
        "defi",
      ]
        .flatMap((c) => toolsInCategory(c))
        .filter((k, i, a) => a.indexOf(k) === i)
        .sort(),
    );
  });
});
