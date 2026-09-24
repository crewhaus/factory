import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS } from "./builtins";
import { planToolConfigInits } from "./config";
import { CATEGORIES, leafCategories } from "./registry";
import {
  BuiltinToolError,
  SHAPE_TOOL_PROFILES,
  type ToolShape,
  builtinKeyForName,
  builtinToolsFor,
  checkBuiltinTool,
  registeredToolName,
  resolveBuiltinTools,
  unknownToolMessage,
} from "./shapes";

const KEYS = Object.keys(BUILTIN_TOOLS);
const SHAPES = Object.keys(SHAPE_TOOL_PROFILES) as ToolShape[];

describe("the builtin table agrees with the category registry", () => {
  const leafOwners = (key: string) =>
    leafCategories().filter((c) => (CATEGORIES[c]?.tools ?? []).includes(key));

  test("the table is the size the release claims, so a truncated file cannot pass", () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(550);
  });

  test("every categorized key is in the table, and carries no shape restriction", () => {
    const categorized = new Set(leafCategories().flatMap((c) => CATEGORIES[c]?.tools ?? []));
    expect(categorized.size).toBeGreaterThanOrEqual(500);
    const missing = [...categorized].filter((k) => BUILTIN_TOOLS[k] === undefined);
    const restricted = [...categorized].filter((k) => BUILTIN_TOOLS[k]?.shapes !== undefined);
    expect({ missing, restricted }).toEqual({ missing: [], restricted: [] });
  });

  test("every shape-agnostic builtin is in exactly one leaf category", () => {
    const wrong = KEYS.filter((k) => BUILTIN_TOOLS[k]?.shapes === undefined)
      .map((k) => ({ k, leaves: leafOwners(k) }))
      .filter((x) => x.leaves.length !== 1);
    expect(wrong).toEqual([]);
  });

  test("a shape-specific builtin is in no category, so all-<category> never reaches it", () => {
    const specific = KEYS.filter((k) => BUILTIN_TOOLS[k]?.shapes !== undefined);
    expect(specific.length).toBeGreaterThan(0);
    expect(specific.filter((k) => leafOwners(k).length > 0)).toEqual([]);
  });
});

describe("names and keys", () => {
  test("every registered name differs from its key only in case", () => {
    const off = KEYS.filter((k) => BUILTIN_TOOLS[k]?.name.toLowerCase() !== k.toLowerCase());
    expect(off).toEqual([]);
  });

  test("no two keys collide once case is ignored, so a name maps back to one key", () => {
    const lower = KEYS.map((k) => k.toLowerCase());
    expect(new Set(lower).size).toBe(KEYS.length);
    for (const key of KEYS) {
      const name = registeredToolName(key) ?? "";
      expect(builtinKeyForName(name)).toBe(key);
    }
  });

  test("every package is a @crewhaus/tool-* package", () => {
    expect(KEYS.filter((k) => !BUILTIN_TOOLS[k]?.package.startsWith("@crewhaus/tool-"))).toEqual(
      [],
    );
  });
});

describe("checkBuiltinTool", () => {
  test("a 0.7.0 builtin is ok on every shape that runs a host catalog", () => {
    for (const shape of SHAPES) {
      if (SHAPE_TOOL_PROFILES[shape].runtime !== "host") continue;
      expect(checkBuiltinTool("jsonQuery", shape).kind).toBe("ok");
      expect(checkBuiltinTool("gitStatus", shape).kind).toBe("ok");
    }
  });

  test("an unknown name is unknown, with the nearest builtin as a hint", () => {
    const v = checkBuiltinTool("jsonQury", "graph");
    expect(v.kind).toBe("unknown");
    expect(v.kind === "unknown" && v.message).toBe(
      'unknown tool "jsonQury" — Did you mean "jsonQuery"? Run `crewhaus tools search <word>` to find a builtin by what it does.',
    );
  });

  test("an MCP name is told where MCP tools come from", () => {
    expect(unknownToolMessage("mcp__gh__search")).toContain("mcp_servers");
  });

  test("a shape-specific builtin elsewhere is refused by name, not called unknown", () => {
    const v = checkBuiltinTool("evmCall", "cli");
    expect(v.kind).toBe("refused");
    expect(v.kind === "refused" && v.message).toBe(
      'tool "evmCall" is a builtin, but the cli shape cannot run it: only the graph, workflow and crew shapes carry it. Use one of those shapes, or remove it from tools.',
    );
  });

  test("sendMessage is refused on crew with the reason crew does not need it", () => {
    const v = checkBuiltinTool("sendMessage", "crew");
    expect(v.kind === "refused" && v.message).toContain("SendMessage and Handoff");
  });

  test("a withheld builtin is refused on every shape", () => {
    for (const shape of SHAPES) {
      const v = checkBuiltinTool("evmSendTransaction", shape);
      expect(v.kind).toBe("refused");
      expect(v.kind === "refused" && v.message).toContain("no shape can run it");
      expect(v.kind === "refused" && v.message).toContain("EvmSimulate runs the same transaction");
    }
  });

  test("a chain reader compiles on its own shapes and names the registrar that binds it", () => {
    for (const key of ["evmCall", "evmSimulate"]) {
      const v = checkBuiltinTool(key, "graph");
      expect(v.kind).toBe("ok");
      expect(v.kind === "ok" && v.entry.chainSymbol).toMatch(/^bind\w+Chains$/);
    }
  });

  test("the edge refuses host builtins with the reason, and runs its own set", () => {
    const git = checkBuiltinTool("gitStatus", "cf-worker");
    expect(git.kind === "refused" && git.message).toContain("starts a host process");
    const py = checkBuiltinTool("python", "cf-worker");
    expect(py.kind === "refused" && py.message).toContain("sandbox");
    const json = checkBuiltinTool("jsonQuery", "cf-worker");
    expect(json.kind === "refused" && json.message).toContain("does not wire it");
    expect(checkBuiltinTool("webFetch", "cf-worker").kind).toBe("ok");
    expect(checkBuiltinTool("sendMessage", "cf-worker").kind).toBe("ok");
  });

  test("builtinToolsFor matches checkBuiltinTool on every shape", () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const carried = new Set(builtinToolsFor(shape));
      if (SHAPE_TOOL_PROFILES[shape].runtime === "none") {
        expect(carried.size).toBe(0);
        continue;
      }
      for (const key of KEYS) {
        const kind = checkBuiltinTool(key, shape).kind;
        expect(carried.has(key)).toBe(kind === "ok" || kind === "inert");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(KEYS.length * 5);
  });

  test("the cli shape carries every categorized builtin and nothing shape-specific", () => {
    const cli = builtinToolsFor("cli");
    const categorized = new Set(leafCategories().flatMap((c) => CATEGORIES[c]?.tools ?? []));
    expect([...categorized].filter((k) => !cli.includes(k))).toEqual([]);
    expect(cli.filter((k) => !categorized.has(k))).toEqual([]);
  });
});

describe("planToolConfigInits — the one tool_config rule", () => {
  test("a tool's own config reaches its registrar", () => {
    const plan = planToolConfigInits([
      { tools: ["fetch"], toolConfigs: { fetch: { allowed_origins: ["https://a.test"] } } },
    ]);
    expect(plan).toEqual([
      {
        key: "fetch",
        package: "@crewhaus/tool-fetch",
        initSymbol: "registerFetchConfig",
        config: { allowed_origins: ["https://a.test"] },
        where: "tool_config.fetch",
      },
    ]);
  });

  test("the codeExecution alias reaches only the code-execution registrar", () => {
    const plan = planToolConfigInits([
      { tools: ["webFetch", "python"], toolConfigs: { codeExecution: { image: "py" } } },
    ]);
    expect(plan.map((p) => p.initSymbol)).toEqual(["registerCodeExecutionConfig"]);
  });

  test("tools sharing a registrar register once", () => {
    const plan = planToolConfigInits([
      { tools: ["python", "javascript"], toolConfigs: { javascript: { a: 1 }, python: { a: 1 } } },
      { tools: ["shell"], toolConfigs: { shell: { a: 1 } } },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.config).toEqual({ a: 1 });
  });

  test("two different blocks for one registrar are refused, naming both keys", () => {
    expect(() =>
      planToolConfigInits([
        {
          tools: ["python", "javascript"],
          toolConfigs: { javascript: { a: 1 }, python: { b: 2 } },
        },
      ]),
    ).toThrow(/tool_config\.javascript and tool_config\.python both configure code execution/);
  });
});

describe("resolveBuiltinTools", () => {
  test("one import per package, symbols sorted, per-site identifiers in order", () => {
    const r = resolveBuiltinTools("graph", [
      { tools: ["grep", "read"] },
      { tools: ["jsonQuery", "read"], toolConfigs: {} },
    ]);
    expect(r.imports).toEqual([
      'import { jsonQuery } from "@crewhaus/tool-data";',
      'import { grep, read } from "@crewhaus/tool-fs";',
    ]);
    expect(r.sites).toEqual([
      ["grep", "read"],
      ["jsonQuery", "read"],
    ]);
    expect(r.packages).toEqual(["@crewhaus/tool-data", "@crewhaus/tool-fs"]);
    expect(r.sandbox).toBe(false);
  });

  test("a registrar is imported beside its tool and called once", () => {
    const r = resolveBuiltinTools("channel", [
      { tools: ["webFetch"], toolConfigs: { webFetch: { allowed_domains: ["a.test"] } } },
    ]);
    expect(r.imports).toEqual([
      'import { registerWebFetchConfig, webFetch } from "@crewhaus/tool-web";',
    ]);
    expect(r.inits).toEqual(['registerWebFetchConfig({"allowed_domains":["a.test"]});']);
  });

  test("a code-execution tool sets the sandbox flag", () => {
    expect(resolveBuiltinTools("managed", [{ tools: ["python"] }]).sandbox).toBe(true);
  });

  test("a host shape throws the checker's message for a name it cannot run", () => {
    expect(() => resolveBuiltinTools("workflow", [{ tools: ["nope"] }])).toThrow(BuiltinToolError);
    expect(() => resolveBuiltinTools("cli", [{ tools: ["evmCall"] }])).toThrow(
      /only the graph, workflow and crew shapes carry it/,
    );
  });

  test("the edge aliases what it wires and leaves out the rest, without throwing", () => {
    const r = resolveBuiltinTools("cf-worker", [
      { tools: ["webFetch", "gitStatus", "webSearch", "myCustom", "webFetch"] },
    ]);
    expect(r.imports).toEqual([
      'import { webFetch as __t_webFetch, webSearch as __t_webSearch } from "@crewhaus/tool-web";',
    ]);
    expect(r.sites).toEqual([["__t_webFetch", "__t_webSearch"]]);
    expect(r.unwired).toEqual(["gitStatus", "myCustom"]);
  });
});
