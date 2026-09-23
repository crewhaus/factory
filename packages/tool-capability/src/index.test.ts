import { describe, expect, test } from "bun:test";
import { TOOL_REGISTRY } from "@crewhaus/tool-registry-manifest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MCP_NOTE,
  type RegistryAnswer,
  buildRegistryAnswer,
  firstSentence,
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
   * actually read. Those are collected by DRIVING the tool across every
   * answer shape, rather than from a list of surfaces kept by hand — the
   * list version checked two strings and missed the other five.
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
    // The surfaces are COLLECTED BY RUNNING the tool, not listed by hand.
    // A hand-written list is a list that drifts: it named the description and
    // MCP_NOTE, while `howToRequest`, the unreachable-catalog note and all
    // three error strings — every one of them text a model reads — went
    // unchecked. Driving the input matrix instead means a string added later
    // is covered the day it becomes reachable.
    const surfaces: Array<{ where: string; text: string }> = [
      { where: "description", text: toolRegistry.description },
      { where: "MCP_NOTE", text: MCP_NOTE },
    ];
    const live = bridgeWith(["Read", "mcp__notes__search"]);
    const matrix: Array<[string, unknown, unknown]> = [
      ["list", { limit: 3 }, live],
      ["list/unlisted", { limit: 3, only: "unlisted" }, live],
      ["list/granted", { limit: 3, only: "granted" }, live],
      ["key hit (granted)", { key: "read" }, live],
      ["key hit (unlisted)", { key: "bash" }, live],
      ["key miss", { key: "noSuchTool" }, live],
      ["key is an mcp name", { key: "mcp__notes__search" }, live],
      ["unknown category", { category: "all-nonsense" }, live],
      ["category hit", { category: "all-fs", limit: 3 }, live],
      ["query", { query: "file", limit: 3 }, live],
      ["no catalog", { limit: 3 }, undefined],
      ["no catalog + only", { limit: 3, only: "unlisted" }, undefined],
    ];
    // Prose this tool BORROWED from the manifest is the 550 other tools' own
    // descriptions, and a secrets or approvals tool may legitimately say
    // "enforce". Only text `ToolRegistry` itself authors is in scope, so the
    // borrowed strings are subtracted rather than the authored ones listed.
    const borrowed = new Set<string>();
    for (const entry of Object.values(TOOL_REGISTRY)) {
      borrowed.add(entry.key);
      borrowed.add(entry.name);
      borrowed.add(entry.description);
      borrowed.add(firstSentence(entry.description));
      borrowed.add(entry.package);
      borrowed.add(entry.scope);
      if (entry.ioCapability !== undefined) borrowed.add(entry.ioCapability);
      for (const c of entry.categories) borrowed.add(c);
      for (const k of entry.keywords) borrowed.add(k);
    }
    for (const [where, input, bridge] of matrix) {
      const answer = buildRegistryAnswer({
        registry: TOOL_REGISTRY,
        version: "0.0.0",
        live: liveToolNames(bridge),
        input: input as Parameters<typeof buildRegistryAnswer>[0]["input"],
      });
      // Every string anywhere in the answer, however deeply nested.
      const walk = (v: unknown, path: string): void => {
        if (typeof v === "string") {
          if (!borrowed.has(v)) surfaces.push({ where: `${where}${path}`, text: v });
        } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (typeof v === "object" && v !== null)
          for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      };
      walk(answer, "");
    }
    // The sweep reached every shape, including all three error strings.
    expect(matrix.length).toBe(12);
    expect(surfaces.length).toBeGreaterThan(20);
    expect(surfaces.filter((s) => s.text.startsWith("Not bound here.")).length).toBeGreaterThan(0);
    expect(surfaces.filter((s) => s.text.includes("could not read")).length).toBeGreaterThan(0);
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

  /**
   * The refusals carry it too, and they are the ones that most need it.
   * A reader told "that category does not exist" is a step from concluding
   * the category is empty, and a reader told the catalog is unreadable has
   * just been handed the one answer with no `granted` field at all. Both
   * previously ended without the note; only the key-miss error had it.
   */
  test("the refusals carry the note, not only the successful answers", async () => {
    const cases: Array<[string, unknown, unknown]> = [
      ["unknown category", { category: "all-nonsense" }, bridgeWith(["Read"])],
      ["unreadable catalog + only", { only: "unlisted" }, undefined],
      ["key miss", { key: "noSuchToolAnywhere" }, bridgeWith(["Read"])],
    ];
    const missing: string[] = [];
    for (const [label, input, bridge] of cases) {
      const text = await ask(input, bridge);
      expect(text).toStartWith("[ToolRegistry]");
      if (!text.includes("Builtin tools only")) missing.push(label);
    }
    expect(cases.length).toBe(3);
    expect(missing).toEqual([]);
  });
});

/**
 * A key the manifest does not have must come back as a miss — including the
 * ones every JavaScript object answers to.
 *
 * `TOOL_REGISTRY` is an object literal, so a bare `registry[key]` lookup
 * reaches `Object.prototype`: `key: "constructor"` returned a truthy value
 * and the answer described a tool named "Object", telling the reader to ask
 * an operator to add "constructor" to `tools:`. A tool whose entire purpose
 * is saying truthfully which tools exist must not invent one.
 */
describe("a key that is not a tool is a miss", () => {
  test("inherited Object.prototype names do not become tools", async () => {
    const inherited = [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "__proto__",
    ];
    const fabricated: string[] = [];
    for (const key of inherited) {
      const text = await ask({ key }, bridgeWith(["Read"]));
      if (!text.startsWith("[ToolRegistry] no builtin tool has the key")) fabricated.push(key);
    }
    expect(inherited.length).toBe(8);
    expect(fabricated).toEqual([]);
  });

  test("a real key still resolves, so the miss is not refusing everything", async () => {
    const answer = parse(await ask({ key: "read" }, bridgeWith(["Read"])));
    expect((answer.granted ?? []).map((r) => r.key)).toEqual(["read"]);
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
