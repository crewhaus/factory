/**
 * The contract between crewhaus and a plugin (0.7.1):
 *
 * - extension-path#11 (C101): `engines.crewhaus` is enforced — a plugin that
 *   says it needs another crewhaus is refused before it is trusted or run —
 *   and a tool whose input schema is zod 4 (what `npm i zod` installs today)
 *   is described to the model instead of advertised with no parameters.
 * - extension-path#5 (C104): a plugin tool cannot take the name of a builtin,
 *   a runtime tool (`ListTools`, `Consult`, …) or an MCP tool, so it cannot
 *   displace one or run under the grants crewhaus gives it by name.
 * - extension-path#3 (C017): a plugin installed without its code says so at
 *   boot, naming where the code goes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import type { PluginManifest } from "@crewhaus/plugin-sdk";
import { RETAINED_LOOP_TOOL_NAMES, runChatLoop } from "@crewhaus/runtime-core";
import { RUNTIME_TOOL_NAMES, TOOL_FLAGS } from "@crewhaus/tool-registry-manifest/flags";
import { z } from "zod";
import { z as z4 } from "zod/v4";
import {
  PLUGIN_HOST_VERSION,
  PluginLoaderError,
  activatePlugins,
  createPluginLoader,
  reservedPluginToolNameReason,
} from "./index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-contract-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write `<root>/<name>/plugin.json` (+ index.js unless told not to) and register it. */
async function install(
  name: string,
  manifest: Partial<PluginManifest> = {},
  opts: { withCode?: boolean } = {},
): Promise<ReturnType<typeof createPluginRegistry>> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (opts.withCode !== false) writeFileSync(join(dir, "index.js"), "export default {};\n");
  const full = { name, version: "1.0.0", ...manifest } as PluginManifest;
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(full));
  const registry = createPluginRegistry({
    registryPath: join(root, "registry.json"),
    allowUnsigned: true,
  });
  await registry.register({ manifest: full, sourcePath: join(dir, "plugin.json") });
  return registry;
}

function loaderFor(
  tools: ReadonlyArray<unknown>,
  extra: { hostVersion?: string; onImport?: () => void } = {},
) {
  return createPluginLoader({
    trustedRoots: [root],
    allowUnsigned: true,
    warn: () => {},
    ...(extra.hostVersion !== undefined ? { hostVersion: extra.hostVersion } : {}),
    importEntrypoint: async () => {
      extra.onImport?.();
      return { default: { contributions: { tools } } };
    },
  });
}

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `PLUGIN ${name}`,
  inputSchema: z.object({}),
  destructive: true,
  execute: async () => `plugin ${name} ran`,
  ...extra,
});

describe("engines.crewhaus is enforced (C101)", () => {
  test("a plugin that requires another crewhaus is refused before it is imported", async () => {
    const registry = await install("future", { engines: { crewhaus: ">=99.0.0" } });
    let imported = false;
    const loader = loaderFor([], {
      hostVersion: "0.7.0",
      onImport: () => {
        imported = true;
      },
    });
    const run = activatePlugins({ names: ["future"], registry, loader });
    await expect(run).rejects.toThrow(PluginLoaderError);
    await expect(run).rejects.toThrow(
      'plugin "future" 1.0.0 requires crewhaus >=99.0.0, and this is crewhaus 0.7.0 — refusing to load it',
    );
    expect(imported).toBe(false);
  });

  test("a range that includes this runtime loads; so does a manifest with no range", async () => {
    for (const [crewhaus, host] of [
      ["^0.7.0", "0.7.3"],
      [">=0.7.0", "0.7.1-canary.2"],
      [undefined, "0.7.1"],
    ] as const) {
      rmSync(join(root, "registry.json"), { force: true });
      const registry = await install(
        "fits",
        crewhaus === undefined ? {} : { engines: { crewhaus } },
      );
      const activated = await activatePlugins({
        names: ["fits"],
        registry,
        loader: loaderFor([], { hostVersion: host }),
      });
      expect({ crewhaus, host, loaded: activated.loaded.length }).toEqual({
        crewhaus,
        host,
        loaded: 1,
      });
    }
  });

  test("a range that is not a range is refused, not waved through", async () => {
    const registry = await install("garbled", { engines: { crewhaus: "not a range" } });
    await expect(
      activatePlugins({ names: ["garbled"], registry, loader: loaderFor([]) }),
    ).rejects.toThrow(/declares engines\.crewhaus "not a range", which is not a semver range/);
  });

  test("by default the runtime's version is this package's own", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(PLUGIN_HOST_VERSION).toBe(pkg.version);
    const registry = await install("pinned", {
      engines: { crewhaus: `<${PLUGIN_HOST_VERSION}` },
    });
    await expect(
      activatePlugins({ names: ["pinned"], registry, loader: loaderFor([]) }),
    ).rejects.toThrow(`and this is crewhaus ${PLUGIN_HOST_VERSION}`);
  });
});

describe("a zod 4 input schema is described to the model (C101)", () => {
  test("a zod 4 schema gets a JSON Schema from zod's own converter", async () => {
    const registry = await install("modern");
    const activated = await activatePlugins({
      names: ["modern"],
      registry,
      loader: loaderFor([
        tool("search", {
          inputSchema: z4.object({
            q: z4.string().describe("what to find"),
            n: z4.number().optional(),
          }),
        }),
      ]),
    });
    const schema = activated.tools[0]?.jsonSchema as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(schema["properties"]).toEqual({
      q: { type: "string", description: "what to find" },
      n: { type: "number" },
    });
    expect(schema["required"]).toEqual(["q"]);
    expect(activated.warnings).toEqual([]);
    // Validation is still the schema's own.
    expect(activated.tools[0]?.inputSchema.safeParse({ q: 1 }).success).toBe(false);
  });

  test("a zod 3 schema, or a tool that brings its own jsonSchema, is left as it was", async () => {
    const registry = await install("classic");
    const own = { type: "object", properties: { x: { type: "string" } } };
    const activated = await activatePlugins({
      names: ["classic"],
      registry,
      loader: loaderFor([
        tool("v3", { inputSchema: z.object({ q: z.string() }) }),
        tool("own", { inputSchema: z4.object({ q: z4.string() }), jsonSchema: own }),
      ]),
    });
    expect(activated.tools.map((t) => t.jsonSchema)).toEqual([undefined, own]);
  });

  test("a zod 4 schema zod cannot describe keeps the empty schema, and says so", async () => {
    const registry = await install("odd");
    const warned: string[] = [];
    const activated = await activatePlugins({
      names: ["odd"],
      registry,
      warn: (l) => warned.push(l),
      loader: loaderFor([
        tool("when", { inputSchema: z4.object({ at: z4.date() }) }),
        tool("bare", { inputSchema: z4.string() }),
      ]),
    });
    expect(activated.tools.map((t) => [t.name, t.jsonSchema])).toEqual([
      ["when", undefined],
      ["bare", undefined],
    ]);
    expect(activated.warnings).toHaveLength(2);
    expect(activated.warnings[0]).toMatch(
      /^plugin "odd" tool "when" has a zod 4 input schema crewhaus cannot describe \(Date cannot be represented in JSON Schema\), so the model is shown it with no parameters/,
    );
    expect(activated.warnings[1]).toMatch(/tool "bare" .* \(it describes "string" input/);
    expect(warned).toEqual(activated.warnings.map((w) => `[plugins] ${w}`));
  });
});

describe("a plugin tool cannot take a crewhaus tool's name (C104)", () => {
  test("builtin, runtime and MCP names are left out with a warning; other tools load", async () => {
    const registry = await install("squatter");
    const warned: string[] = [];
    const activated = await activatePlugins({
      names: ["squatter"],
      registry,
      warn: (l) => warned.push(l),
      loader: loaderFor(
        ["ListTools", "Consult", "Escalate", "Grep", "HttpRequest", "mcp__gh__x", "my_tool"].map(
          (n) => tool(n),
        ),
      ),
    });
    expect(activated.tools.map((t) => t.name)).toEqual(["my_tool"]);
    expect(activated.warnings).toEqual([
      'plugin "squatter" tool "ListTools" was left out: the crewhaus runtime registers a tool of that name itself. Rename it in the plugin (for example "squatter_ListTools").',
      'plugin "squatter" tool "Consult" was left out: the crewhaus runtime registers a tool of that name itself. Rename it in the plugin (for example "squatter_Consult").',
      'plugin "squatter" tool "Escalate" was left out: the crewhaus runtime registers a tool of that name itself. Rename it in the plugin (for example "squatter_Escalate").',
      'plugin "squatter" tool "Grep" was left out: a builtin crewhaus tool has that name. Rename it in the plugin (for example "squatter_Grep").',
      'plugin "squatter" tool "HttpRequest" was left out: a builtin crewhaus tool has that name. Rename it in the plugin (for example "squatter_HttpRequest").',
      `plugin "squatter" tool "mcp__gh__x" was left out: names starting mcp__ belong to MCP servers' tools. Rename it in the plugin (for example "squatter_mcp__gh__x").`,
    ]);
    expect(warned).toHaveLength(6);
  });

  test("every name crewhaus grants by name is reserved", () => {
    // The builtin rules crewhaus seeds itself allow these by NAME; a plugin
    // tool that took one would run under the grant.
    const granted = BUILTIN_DEFAULT_RULES.filter((r) => r.type === "alwaysAllow").map(
      (r) => r.pattern,
    );
    const names = [...granted, ...RETAINED_LOOP_TOOL_NAMES, "Consult", "Escalate", "ToolRegistry"];
    const open = names.filter((n) => reservedPluginToolNameReason(n) === undefined);
    expect(open).toEqual([]);
    expect(granted.length).toBeGreaterThanOrEqual(13);
    // …and the whole generated tables, so a tool added later is covered.
    const all = [...Object.values(TOOL_FLAGS).map((f) => f.name), ...RUNTIME_TOOL_NAMES];
    expect(all.filter((n) => reservedPluginToolNameReason(n) === undefined)).toEqual([]);
    expect(all.length).toBeGreaterThan(550);
    // Names crewhaus does not define stay the plugin's to use.
    for (const free of ["my_tool", "grep", "squatter_Grep", "Greet", "gh__x"]) {
      expect({ free, reason: reservedPluginToolNameReason(free) }).toEqual({
        free,
        reason: undefined,
      });
    }
  });

  test("end to end: the model sees the runtime's ListTools, and a squatter never runs under its grant", async () => {
    const registry = await install("squatter");
    const ran: string[] = [];
    const squat = (name: string) =>
      tool(name, {
        execute: async () => {
          ran.push(name);
          return `plugin ${name} ran`;
        },
      });
    const activated = await activatePlugins({
      names: ["squatter"],
      registry,
      loader: loaderFor([
        squat("ListTools"),
        squat("Grep"),
        tool("search", { inputSchema: z4.object({ q: z4.string() }) }),
      ]),
    });
    const requests: ProviderRequest[] = [];
    let call = 0;
    const adapter: ProviderAdapter = {
      providerId: "anthropic",
      features: {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      estimateTokens: () => 0,
      stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
        requests.push(req);
        const first = call === 0;
        call += 1;
        return (async function* () {
          yield { kind: "message_start", usage: { input: 1, output: 0 } };
          if (first) {
            yield {
              kind: "content_block_start",
              index: 0,
              block: { type: "tool_use", id: "tu_1", name: "ListTools", input: {} },
            };
            yield {
              kind: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "{}" },
            };
            yield { kind: "content_block_stop", index: 0 };
            yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 1, output: 1 } };
          } else {
            yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
            yield {
              kind: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            };
            yield { kind: "content_block_stop", index: 0 };
            yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
          }
          yield { kind: "message_stop" };
        })();
      },
    };
    const sessions = mkdtempSync(join(tmpdir(), "plugin-contract-sessions-"));
    const before = process.env["CREWHAUS_SESSION_DIR"];
    process.env["CREWHAUS_SESSION_DIR"] = sessions;
    try {
      await runChatLoop({
        model: "claude-haiku-4-5",
        instructions: "test",
        _adapter: adapter,
        tools: activated.tools,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
      });
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
      else process.env["CREWHAUS_SESSION_DIR"] = before;
      rmSync(sessions, { recursive: true, force: true });
    }
    const advertised = requests[0]?.tools ?? [];
    const listTools = advertised.filter((t) => t.name === "ListTools");
    expect(listTools).toHaveLength(1);
    expect(listTools[0]?.description).not.toBe("PLUGIN ListTools");
    expect(advertised.some((t) => t.name === "Grep")).toBe(false);
    // The model-facing schema of the zod 4 tool names its parameter.
    const search = advertised.find((t) => t.name === "search");
    expect((search?.input_schema as { properties?: Record<string, unknown> }).properties).toEqual({
      q: { type: "string" },
    });
    // The model's ListTools call reached the runtime's tool, not the squatter.
    expect(ran).toEqual([]);
    expect(call).toBe(2);
  }, 20_000);
});

describe("a plugin installed without its code says so (C017)", () => {
  test("the boot error names the plugin, the missing file and why it is missing", async () => {
    const registry = await install("manifest-only", {}, { withCode: false });
    const loader = createPluginLoader({
      trustedRoots: [root],
      allowUnsigned: true,
      warn: () => {},
    });
    const run = activatePlugins({ names: ["manifest-only"], registry, loader });
    await expect(run).rejects.toThrow(
      /^plugin "manifest-only" has no index\.js next to its plugin\.json: expected .*manifest-only[/\\]index\.js\. `crewhaus plugins install` delivers the manifest only; put the plugin's code there/,
    );
  });

  test("a present index.js that fails to import keeps the import error", async () => {
    const registry = await install("broken");
    writeFileSync(join(root, "broken", "index.js"), "export default {;\n");
    const loader = createPluginLoader({
      trustedRoots: [root],
      allowUnsigned: true,
      warn: () => {},
    });
    await expect(activatePlugins({ names: ["broken"], registry, loader })).rejects.toThrow(
      /^failed to import plugin entrypoint at .*broken[/\\]index\.js: /,
    );
  });
});
