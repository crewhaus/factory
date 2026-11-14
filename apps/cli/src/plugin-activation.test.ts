import { describe, expect, test } from "bun:test";
import { compile, lower } from "@crewhaus/compiler";
import { PLUGIN_TOOL_NAME_PATTERN } from "@crewhaus/plugin-sdk";
import { PLUGIN_ENTRY_TOOL_NAME_PATTERN, parseSpec } from "@crewhaus/spec";
import {
  parsePluginsFlag,
  pluginEntriesFor,
  pluginEntryName,
  pluginEntryNames,
  resolvePluginNames,
  withPluginsOverride,
} from "./plugin-activation";

describe("parsePluginsFlag", () => {
  test("splits a comma list, trimming and dropping empties", () => {
    expect(parsePluginsFlag("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parsePluginsFlag("a, b , c")).toEqual(["a", "b", "c"]);
    expect(parsePluginsFlag("a, ,b,")).toEqual(["a", "b"]);
  });
  test("an empty / whitespace flag yields no names (activate none)", () => {
    expect(parsePluginsFlag("")).toEqual([]);
    expect(parsePluginsFlag("  ")).toEqual([]);
    expect(parsePluginsFlag(",,")).toEqual([]);
  });
  test("preserves order (activation de-dupes downstream)", () => {
    expect(parsePluginsFlag("b,a,b")).toEqual(["b", "a", "b"]);
  });
});

describe("resolvePluginNames", () => {
  test("a present flag OVERRIDES the spec list", () => {
    expect(resolvePluginNames(["spec-one"], "flag-a,flag-b")).toEqual(["flag-a", "flag-b"]);
  });
  test("a present-but-empty flag is an explicit 'activate none' override", () => {
    expect(resolvePluginNames(["spec-one"], "")).toEqual([]);
    expect(resolvePluginNames(["spec-one"], "  ")).toEqual([]);
  });
  test("an absent flag falls back to the spec list", () => {
    expect(resolvePluginNames(["spec-one", "spec-two"], undefined)).toEqual([
      "spec-one",
      "spec-two",
    ]);
  });
  test("absent flag + absent spec list → none (the pre-Batch-G path)", () => {
    expect(resolvePluginNames(undefined, undefined)).toEqual([]);
  });
});

describe("{name, tools} entries (#522)", () => {
  const SPEC = ["notes", { name: "weather-pane", tools: ["Read"] }] as const;

  test("--plugins keeps the spec's narrowing for a name it lists as an object", () => {
    expect(resolvePluginNames(SPEC, "weather-pane,other")).toEqual([
      { name: "weather-pane", tools: ["Read"] },
      "other",
    ]);
    expect(resolvePluginNames(SPEC, "notes")).toEqual(["notes"]);
  });

  test("a repeated flag name kept as an object is listed once; a name repeat stays", () => {
    expect(resolvePluginNames(SPEC, "weather-pane,weather-pane,notes,notes")).toEqual([
      { name: "weather-pane", tools: ["Read"] },
      "notes",
      "notes",
    ]);
  });

  test("without the flag the spec's entries pass through", () => {
    expect(resolvePluginNames(SPEC, undefined)).toEqual(SPEC);
  });

  test("printed lines name the plugins, never [object Object]", () => {
    expect(pluginEntryNames(SPEC)).toBe("notes, weather-pane");
    expect(pluginEntryName({ name: "x", tools: [] })).toBe("x");
  });

  test("pluginEntriesFor keeps a malformed object entry as written, for the compile to refuse", () => {
    expect(pluginEntriesFor([{ name: "p", tools: "Read" }], ["p"])).toEqual([
      { name: "p", tools: "Read" } as never,
    ]);
  });
});

describe("dev --plugins rewrites plugins: by the same rule", () => {
  const YAML = `name: dev-fixture
target: cli
agent:
  model: claude-opus-4-7
  instructions: Help.
plugins:
  - notes
  - name: weather-pane
    tools: [Read]
`;

  test("a name the spec lists as an object compiles as that object", () => {
    const rewritten = withPluginsOverride(YAML, ["weather-pane"]);
    const agent = compile(rewritten, { readme: false }).files.find((f) => f.path === "agent.ts");
    expect(agent?.content).toContain('names: [{"name":"weather-pane","tools":["Read"]}],');
  });

  test("other names compile as names; an empty override activates none", () => {
    const rewritten = withPluginsOverride(YAML, ["notes", "fresh"]);
    expect(lower(parseSpec(rewritten)).plugins).toEqual(["notes", "fresh"]);
    expect(lower(parseSpec(withPluginsOverride(YAML, []))).plugins).toBeUndefined();
  });

  test("a malformed object entry the flag names is refused by the compile, not widened", () => {
    const bad = YAML.replace("tools: [Read]", "tools: Read");
    expect(() => compile(withPluginsOverride(bad, ["weather-pane"]), { readme: false })).toThrow();
  });
});

describe("the two copies of the tool-name rule agree", () => {
  test("spec's PLUGIN_ENTRY_TOOL_NAME_PATTERN is plugin-sdk's PLUGIN_TOOL_NAME_PATTERN", () => {
    expect(PLUGIN_ENTRY_TOOL_NAME_PATTERN.source).toBe(PLUGIN_TOOL_NAME_PATTERN.source);
    expect(PLUGIN_ENTRY_TOOL_NAME_PATTERN.flags).toBe(PLUGIN_TOOL_NAME_PATTERN.flags);
  });
});
