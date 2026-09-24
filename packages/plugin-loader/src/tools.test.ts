/**
 * extension-path#6 (C105): activatePlugins passed a plugin's tools straight
 * to buildTool, whose `??` defaults keep whatever a JavaScript author wrote.
 * `readOnly: "false"` is truthy, so plan mode ran the tool; `requiresSandbox:
 * "true"`, `requireJustification: "true"` and `scope: "External"` are not
 * `true`/`"external"`, so the sandbox floor, the intent gate and the egress
 * check skipped it; a schema crewhaus cannot read crashed every run that
 * listed the tool; and no scope audit ever saw a plugin tool.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { PluginLoaderError, activatePlugins, createPluginLoader } from "./index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-tools-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Install unsigned plugins (dev mode) whose modules contribute the given tools. */
async function activate(byPlugin: Record<string, unknown>) {
  const registry = createPluginRegistry({
    registryPath: join(root, "registry.json"),
    allowUnsigned: true,
  });
  for (const name of Object.keys(byPlugin)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "index.js"), `export default ${JSON.stringify(name)};\n`);
    const manifest = { name, version: "1.0.0" };
    writeFileSync(join(root, name, "plugin.json"), JSON.stringify(manifest));
    await registry.register({ manifest, sourcePath: join(root, name, "plugin.json") });
  }
  const loader = createPluginLoader({
    trustedRoots: [root],
    allowUnsigned: true,
    warn: () => {},
    importEntrypoint: async (p) => {
      const which = Object.keys(byPlugin).find((n) => p.includes(`${sep}${n}${sep}`)) ?? "";
      return { default: { contributions: { tools: byPlugin[which] } } };
    },
  });
  return activatePlugins({ names: Object.keys(byPlugin), registry, loader });
}

const execute = async () => "ran";
const good = (extra: Record<string, unknown> = {}) => ({
  name: "wipe",
  description: "wipes",
  inputSchema: z.object({ path: z.string() }),
  execute,
  ...extra,
});

describe("a malformed plugin tool refuses the plugin at boot, naming the field (C105)", () => {
  test.each([
    ["readOnly", "false", 'readOnly is the string "false", not true or false'],
    ["requiresSandbox", "true", 'requiresSandbox is the string "true", not true or false'],
    [
      "requireJustification",
      "true",
      'requireJustification is the string "true", not true or false',
    ],
    ["destructive", 0, "destructive is number 0, not true or false"],
    ["concurrencySafe", "yes", 'concurrencySafe is the string "yes", not true or false'],
    ["classifyOutput", null, "classifyOutput is null, not true or false"],
    ["scope", "External", 'scope is the string "External", not "internal" or "external"'],
    ["ioCapability", "net", 'ioCapability is the string "net", not "network" or "process"'],
    ["description", 42, "description is number 42, not a string"],
    ["execute", undefined, "execute is missing, not a function"],
    ["concurrencyClassifier", true, "concurrencyClassifier is boolean true, not a function"],
    [
      "requiresModelFeatures",
      "vision",
      'requiresModelFeatures is the string "vision", not an object',
    ],
    ["operativeArgs", { field: "path" }, "operativeArgs is an object, not a list"],
  ])("%s: %p", async (field, value, why) => {
    const run = activate({ maker: [good({ [field]: value })] });
    await expect(run).rejects.toThrow(PluginLoaderError);
    await expect(run).rejects.toThrow(
      `plugin "maker" tool "wipe": ${why} — refusing to load the plugin`,
    );
  });

  test("a schema crewhaus cannot validate or describe is refused at boot, not on the first turn", async () => {
    await expect(activate({ maker: [good({ inputSchema: { not: "zod" } })] })).rejects.toThrow(
      'plugin "maker" tool "wipe": inputSchema is an object; it must be a schema with safeParse (zod), which checks every call — refusing to load the plugin',
    );
    const validatorOnly = { safeParse: (v: unknown) => ({ success: true, data: v }) };
    await expect(activate({ maker: [good({ inputSchema: validatorOnly })] })).rejects.toThrow(
      "inputSchema is not a zod schema crewhaus can describe to the model, and the tool gives no jsonSchema: use zod, or add a jsonSchema",
    );
    // With a jsonSchema for the model, a plain validator is fine.
    const ok = await activate({
      checker: [
        good({ inputSchema: validatorOnly, jsonSchema: { type: "object", properties: {} } }),
      ],
    });
    expect(ok.tools.map((t) => t.name)).toEqual(["wipe"]);
  });

  test("a jsonSchema that is not an object schema is refused", async () => {
    await expect(activate({ maker: [good({ jsonSchema: { type: "string" } })] })).rejects.toThrow(
      'jsonSchema describes "string" input; a tool\'s input is an object',
    );
    await expect(activate({ maker: [good({ jsonSchema: [] })] })).rejects.toThrow(
      "jsonSchema is a list, not a JSON Schema object",
    );
  });

  test("a name no provider accepts, or none at all, is refused", async () => {
    await expect(activate({ maker: [good({ name: "Fetch(x" })] })).rejects.toThrow(
      'plugin "maker" tool "Fetch(x": name "Fetch(x" must be 1-64 letters, digits, "_" or "-"',
    );
    await expect(activate({ maker: [good({ name: "a".repeat(65) })] })).rejects.toThrow(
      /must be 1-64 letters/,
    );
    await expect(activate({ maker: [good({ name: undefined })] })).rejects.toThrow(
      'plugin "maker" tools[0]: has no name (name is missing) — refusing to load the plugin',
    );
    await expect(activate({ maker: ["wipe"] })).rejects.toThrow(
      'plugin "maker" tools[0]: is the string "wipe", not a tool definition',
    );
  });

  test("contributions.tools that is not a list is refused", async () => {
    await expect(activate({ maker: { wipe: good() } })).rejects.toThrow(
      'plugin "maker": contributions.tools is an object, not a list of tools — refusing to load the plugin',
    );
  });

  test("an operativeArgs field the schema lacks is refused under the plugin's name", async () => {
    await expect(
      activate({ maker: [good({ operativeArgs: [{ field: "target", kind: "path" }] })] }),
    ).rejects.toThrow(/^plugin "maker" tool "wipe": .*target.* — refusing to load the plugin$/);
  });
});

describe("well-formed plugin tools load as before (C105)", () => {
  test("a valid tool builds exactly as buildTool builds it", async () => {
    const def = good({ readOnly: true, destructive: false, scope: "internal" });
    const activated = await activate({ maker: [def] });
    // Every field is buildTool's; execute is the plugin's own, behind the
    // bridge view (C106).
    const { execute: run, ...got } = activated.tools[0] ?? buildTool(good());
    const { execute: _, ...want } = buildTool(def as Parameters<typeof buildTool>[0]);
    expect(got).toEqual(want);
    expect(await run({ path: "x" })).toBe("ran");
    expect(activated.tools[0]?.readOnly).toBe(true);
    expect(activated.warnings).toEqual([]);
  });

  test("a tool with no description loads, as it did on 0.7.0", async () => {
    const activated = await activate({ maker: [good({ description: undefined })] });
    expect(activated.tools.map((t) => t.name)).toEqual(["wipe"]);
  });

  test("a malformed tool with a name crewhaus reserves is only left out, not a reason to refuse", async () => {
    const activated = await activate({
      maker: [good({ name: "Grep", readOnly: "true" }), good()],
    });
    expect(activated.tools.map((t) => t.name)).toEqual(["wipe"]);
    expect(activated.warnings[0]).toStartWith('plugin "maker" tool "Grep" was left out');
  });
});

describe("plugin tools meet the scope audit (C105)", () => {
  test("a tool that crosses a boundary but is not external runs as external, and the boot says so", async () => {
    const activated = await activate({
      maker: [
        good({ name: "net_tool", ioCapability: "network" }),
        good({ name: "proc_tool", ioCapability: "process", scope: "internal" }),
        good({ name: "ok_tool", ioCapability: "network", scope: "external" }),
      ],
    });
    expect(activated.tools.map((t) => [t.name, t.scope])).toEqual([
      ["net_tool", "external"],
      ["proc_tool", "external"],
      ["ok_tool", "external"],
    ]);
    expect(activated.warnings).toEqual([
      'plugin "maker" tool "net_tool" declares ioCapability "network" but not scope "external"; it runs as external, so what it sends is checked on the way out. Set scope: "external" in the plugin.',
      'plugin "maker" tool "proc_tool" declares ioCapability "process" but not scope "external"; it runs as external, so what it sends is checked on the way out. Set scope: "external" in the plugin.',
    ]);
  });
});

describe("one tool name, one tool (C105)", () => {
  test("a second tool of the same name, in the same plugin or another, is left out by name", async () => {
    const activated = await activate({
      alpha: [good({ description: "first" }), good({ description: "second" })],
      beta: [good({ description: "third" }), good({ name: "other" })],
    });
    expect(activated.tools.map((t) => [t.name, t.description])).toEqual([
      ["wipe", "first"],
      ["other", "wipes"],
    ]);
    expect(activated.warnings).toEqual([
      'plugin "alpha" contributes two tools named "wipe"; the second was left out.',
      'plugin "beta" tool "wipe" was left out: plugin "alpha" already contributes a tool of that name.',
    ]);
  });
});
