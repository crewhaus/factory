import { describe, expect, test } from "bun:test";
import { TOOL_REGISTRY } from "@crewhaus/tool-registry-manifest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MCP_NOTE,
  type RegistryAnswer,
  buildRegistryAnswer,
  knownCategories,
  liveToolNames,
  normalizeCategory,
  toolRegistry,
} from "./index";

/** A live catalog shaped like the runtime bridge, with nothing else on it. */
function bridgeWith(names: ReadonlyArray<string>): unknown {
  return { tools: names.map((name) => ({ name })) };
}

async function ask(input: unknown, bridge?: unknown): Promise<string> {
  return (await toolRegistry.execute(input, bridge === undefined ? {} : { bridge })) as string;
}

function parse(text: string): RegistryAnswer {
  return JSON.parse(text) as RegistryAnswer;
}

describe("the tool's posture", () => {
  test("it reads, it is safe to call twice, and it stays in the process", () => {
    expect({
      readOnly: toolRegistry.readOnly,
      destructive: toolRegistry.destructive,
      concurrencySafe: toolRegistry.concurrencySafe,
      scope: toolRegistry.scope,
      requiresSandbox: toolRegistry.requiresSandbox,
      requireJustification: toolRegistry.requireJustification,
    }).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      scope: "internal",
      requiresSandbox: false,
      requireJustification: false,
    });
  });

  /**
   * The operator decided this ships as an ergonomics feature and explicitly
   * NOT as a control: in any harness granting bash, file write or code
   * execution the agent can edit `crewhaus.yaml` itself, so a description
   * claiming otherwise would be describing something that is not there.
   *
   * The word list is checked against the strings a model and an operator
   * actually read — the description and every note the tool can emit.
   */
  test("nothing the model reads calls this a control", () => {
    const CONTROL_WORDS = [
      "gate",
      "gated",
      "guard",
      "prevent",
      "prevents",
      "enforce",
      "enforces",
      "authorize",
      "authorizes",
      "authorization",
      "permission boundary",
    ];
    const surfaces: Array<{ where: string; text: string }> = [
      { where: "description", text: toolRegistry.description },
      { where: "note", text: MCP_NOTE },
    ];
    expect(surfaces.length).toBeGreaterThanOrEqual(2);
    const offenders: string[] = [];
    for (const { where, text } of surfaces) {
      const lower = text.toLowerCase();
      for (const word of CONTROL_WORDS) {
        if (new RegExp(`\\b${word}\\b`).test(lower)) offenders.push(`${where}: "${word}"`);
      }
    }
    expect(offenders).toEqual([]);
    // And the sweep looked at real text, not at empty strings.
    expect(toolRegistry.description.length).toBeGreaterThan(200);
  });
});

describe("granted is read from the live catalog, not from a spec", () => {
  test("a tool bound right now is granted; one that is not is unlisted", async () => {
    const answer = parse(await ask({ query: "bash", limit: 100 }, bridgeWith(["Bash", "Read"])));
    expect(answer.liveCatalog).toBe("read");
    expect((answer.granted ?? []).map((r) => r.key)).toContain("bash");
    expect((answer.unlisted ?? []).map((r) => r.key)).not.toContain("bash");
  });

  /**
   * The point of reading the LIVE catalog rather than the spec: a tool an MCP
   * peer registered an hour after boot is in the catalog and not in the spec,
   * and the same is true of a builtin a host registered programmatically.
   */
  test("a builtin that appears in the catalog late still counts as granted", async () => {
    const before = parse(await ask({ key: "read" }, bridgeWith([])));
    expect((before.unlisted ?? []).map((r) => r.key)).toEqual(["read"]);
    const after = parse(await ask({ key: "read" }, bridgeWith(["Read"])));
    expect((after.granted ?? []).map((r) => r.key)).toEqual(["read"]);
  });

  test("an unlisted row says how to ask for it and a granted row does not", async () => {
    const answer = parse(await ask({ query: "bash", limit: 100 }, bridgeWith(["Bash"])));
    const granted = (answer.granted ?? []).find((r) => r.key === "bash");
    const anyUnlisted = (answer.unlisted ?? [])[0];
    expect(granted?.howToRequest).toBeUndefined();
    expect(anyUnlisted?.howToRequest).toContain("crewhaus.yaml");
  });

  /**
   * An empty catalog and an unreadable one are different answers, and the
   * difference matters: reporting "you have none of them" when the truth is
   * "I could not tell" is the one wrong answer this tool must never give.
   */
  test("an unreachable catalog is reported as unknown, not as nothing bound", async () => {
    const answer = parse(await ask({ query: "bash", limit: 5 }));
    expect(answer.liveCatalog).toBe("unavailable");
    expect(answer.granted).toBeUndefined();
    expect(answer.unlisted).toBeUndefined();
    expect((answer.tools ?? []).length).toBeGreaterThan(0);
    expect((answer.tools ?? [])[0]?.granted).toBeUndefined();
    expect(answer.note).toContain("ListTools");
  });

  test("an unreachable catalog refuses only:granted rather than guessing", async () => {
    const text = await ask({ only: "granted" });
    expect(text).toStartWith("[ToolRegistry]");
    expect(text).toContain("ListTools");
  });

  test("liveToolNames tells an empty catalog apart from no catalog", () => {
    expect(liveToolNames(undefined)).toBeUndefined();
    expect(liveToolNames({})).toBeUndefined();
    expect(liveToolNames({ tools: "nope" })).toBeUndefined();
    expect(liveToolNames({ tools: [] })?.size).toBe(0);
    expect(liveToolNames(bridgeWith(["Read"]))?.has("Read")).toBe(true);
  });
});

/**
 * THE ASYMMETRY. `unlisted` is builtins only and must be seen to be: the
 * manifest cannot contain an MCP tool, so a bound MCP tool is neither granted
 * nor unlisted, and an answer that did not say so would read as complete.
 */
describe("MCP is declared, not buried", () => {
  test("no unlisted row is ever an mcp__ name, across the whole registry", async () => {
    const answer = parse(await ask({ limit: MAX_LIMIT, only: "unlisted" }, bridgeWith([])));
    // The sweep's own size: a page of rows, not an empty list that proves
    // nothing about what could have appeared in it.
    expect((answer.unlisted ?? []).length).toBe(MAX_LIMIT);
    expect((answer.unlisted ?? []).filter((r) => r.key.startsWith("mcp__"))).toEqual([]);
    // And the whole registry, not just the page that was shown.
    const keys = Object.keys(TOOL_REGISTRY);
    expect(keys.length).toBeGreaterThanOrEqual(500);
    expect(keys.filter((k) => k.startsWith("mcp__"))).toEqual([]);
  });

  test("a bound MCP tool is counted as something this answer cannot describe", async () => {
    const answer = parse(
      await ask({ limit: 1 }, bridgeWith(["Read", "mcp__notes__search", "mcp__notes__write"])),
    );
    expect(answer.counts.otherBound).toBe(2);
    expect(answer.counts.granted).toBe(1);
  });

  test("every answer carries the note saying so", async () => {
    for (const input of [{}, { key: "read" }, { query: "pdf" }, { category: "fs" }]) {
      const answer = parse(await ask(input, bridgeWith(["Read"])));
      expect(answer.note).toContain("Builtin tools only");
    }
  });

  test("a miss on a key says it too, so an absent MCP name is not read as absent", async () => {
    const text = await ask({ key: "mcp__notes__search" }, bridgeWith(["mcp__notes__search"]));
    expect(text).toStartWith("[ToolRegistry]");
    expect(text).toContain("Builtin tools only");
  });
});

describe("searching and narrowing", () => {
  test("a query matches key, name, description, category and keywords", async () => {
    const live = bridgeWith([]);
    for (const q of ["pdfInfo", "PdfInfo", "page count", "fs", "jsonpath"]) {
      const answer = parse(await ask({ query: q, limit: 100 }, live));
      expect({ q, matched: answer.counts.matched > 0 }).toEqual({ q, matched: true });
    }
  });

  test("a category accepts both spellings and means the same set", async () => {
    const withPrefix = parse(await ask({ category: "all-fs", limit: 100 }, bridgeWith([])));
    const without = parse(await ask({ category: "fs", limit: 100 }, bridgeWith([])));
    expect(withPrefix.counts.matched).toBe(without.counts.matched);
    expect(withPrefix.counts.matched).toBeGreaterThan(0);
    expect(normalizeCategory("all-fs")).toBe("fs");
    expect(normalizeCategory("fs")).toBe("fs");
  });

  test("a roll-up category reaches more tools than the leaf it contains", async () => {
    const leaf = parse(await ask({ category: "fs", limit: 100 }, bridgeWith([])));
    const rollUp = parse(await ask({ category: "all-code", limit: 100 }, bridgeWith([])));
    expect(rollUp.counts.matched).toBeGreaterThan(leaf.counts.matched);
  });

  test("an unknown category is refused with a hint, not answered emptily", async () => {
    const text = await ask({ category: "all-fss" }, bridgeWith([]));
    expect(text).toStartWith("[ToolRegistry]");
    expect(text).toContain("all-fs");
  });

  test("the known category set is derived from the manifest itself", () => {
    const cats = knownCategories(TOOL_REGISTRY);
    expect(cats.length).toBeGreaterThanOrEqual(60);
    expect(cats).toContain("fs");
    expect(cats).toContain("code");
  });

  test("a single key returns the whole description and its keywords", async () => {
    const one = parse(await ask({ key: "read" }, bridgeWith(["Read"])));
    const listed = parse(await ask({ query: "read", limit: 100 }, bridgeWith(["Read"])));
    const fromList = (listed.granted ?? []).find((r) => r.key === "read");
    const detail = (one.granted ?? [])[0];
    expect(detail?.keywords?.length).toBeGreaterThan(0);
    expect(fromList?.keywords).toBeUndefined();
    expect((detail?.description.length ?? 0) >= (fromList?.description.length ?? 0)).toBe(true);
    expect(detail?.description).toBe(TOOL_REGISTRY["read"]?.description ?? "");
  });

  test("an unknown key is refused with close matches", async () => {
    const text = await ask({ key: "reed" }, bridgeWith([]));
    expect(text).toStartWith("[ToolRegistry]");
    expect(text).toContain('"reed"');
  });
});

describe("paging", () => {
  test("the default page is small and says it was cut", async () => {
    const answer = parse(await ask({}, bridgeWith(["Read"])));
    expect(answer.counts.shown).toBe(DEFAULT_LIMIT);
    expect(answer.truncated).toBe(true);
    expect(answer.counts.matched).toBe(Object.keys(TOOL_REGISTRY).length);
  });

  test("the limit is spent on what was asked for", async () => {
    const answer = parse(await ask({ only: "unlisted", limit: 10 }, bridgeWith(["Read"])));
    expect((answer.granted ?? []).length).toBe(0);
    expect((answer.unlisted ?? []).length).toBe(10);
  });

  /**
   * The half a harness cannot get from `ListTools` must survive the page.
   *
   * A harness bound to more tools than the page holds would otherwise fill it
   * with what it already has and show nothing it is missing — which is the
   * only question this tool exists to answer.
   */
  test("a wide default page still shows what is missing", async () => {
    const manyBound = Object.values(TOOL_REGISTRY)
      .slice(0, 200)
      .map((e) => e.name);
    const answer = parse(await ask({}, bridgeWith(manyBound)));
    expect(answer.counts.granted).toBe(200);
    expect((answer.granted ?? []).length).toBeGreaterThan(0);
    expect((answer.unlisted ?? []).length).toBeGreaterThan(0);
    expect(answer.counts.shown).toBe(DEFAULT_LIMIT);
  });

  test("a side with little to show gives the rest of the page to the other", async () => {
    const answer = parse(await ask({ limit: 10 }, bridgeWith(["Read", "Bash"])));
    expect((answer.granted ?? []).length).toBe(2);
    expect((answer.unlisted ?? []).length).toBe(8);
    expect(answer.counts.shown).toBe(10);
  });

  test("a complete answer is not marked truncated", async () => {
    const answer = parse(await ask({ only: "granted", limit: 10 }, bridgeWith(["Read", "Bash"])));
    expect(answer.counts.shown).toBe(2);
    expect(answer.truncated).toBe(false);
  });

  test("a limit above the ceiling is refused by the schema", () => {
    expect(toolRegistry.inputSchema.safeParse({ limit: MAX_LIMIT + 1 }).success).toBe(false);
    expect(toolRegistry.inputSchema.safeParse({ limit: MAX_LIMIT }).success).toBe(true);
  });

  test("an unknown input field is refused", () => {
    expect(toolRegistry.inputSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("buildRegistryAnswer is decidable without a runtime", () => {
  test("it works against a hand-built registry", () => {
    const registry = {
      alpha: {
        key: "alpha",
        name: "Alpha",
        description: "Does the first thing. And a second sentence.",
        readOnly: true,
        destructive: false,
        scope: "internal",
        requiresSandbox: false,
        requireJustification: false,
        categories: ["demo"],
        package: "@crewhaus/tool-demo",
        keywords: ["first"],
      },
    } as const;
    const answer = buildRegistryAnswer({
      registry,
      version: "9.9.9",
      live: new Set(["Alpha"]),
      input: {},
    });
    expect("error" in answer).toBe(false);
    if ("error" in answer) return;
    expect(answer.version).toBe("9.9.9");
    expect(answer.granted?.[0]?.description).toBe("Does the first thing.");
    expect(answer.counts).toEqual({
      total: 1,
      matched: 1,
      shown: 1,
      granted: 1,
      unlisted: 0,
      otherBound: 0,
    });
  });
});
