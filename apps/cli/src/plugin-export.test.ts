import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import {
  DEFAULT_CLAUDE_PLUGIN_AUTHOR,
  type ExportPluginFile,
  resolveClaudePluginAuthor,
  resolveExportOutDir,
  smokeCheckClaudePluginBundle,
} from "./plugin-export";

describe("resolveClaudePluginAuthor", () => {
  test("uses the flags when given, trimming", () => {
    expect(resolveClaudePluginAuthor("Max", "max@x.io")).toEqual({
      name: "Max",
      email: "max@x.io",
    });
    expect(resolveClaudePluginAuthor("  Max  ", "  max@x.io  ")).toEqual({
      name: "Max",
      email: "max@x.io",
    });
  });
  test("defaults the (required) author name when --author is absent/blank", () => {
    expect(resolveClaudePluginAuthor(undefined, undefined)).toEqual({
      name: DEFAULT_CLAUDE_PLUGIN_AUTHOR,
    });
    expect(resolveClaudePluginAuthor("   ", undefined)).toEqual({
      name: DEFAULT_CLAUDE_PLUGIN_AUTHOR,
    });
  });
  test('an empty email is dropped, never emitted as ""', () => {
    expect(resolveClaudePluginAuthor("Max", "")).toEqual({ name: "Max" });
    expect(resolveClaudePluginAuthor("Max", "   ")).toEqual({ name: "Max" });
    expect(resolveClaudePluginAuthor("Max", undefined)).not.toHaveProperty("email");
  });
});

describe("resolveExportOutDir", () => {
  test("defaults to <cwd>/<pluginName>", () => {
    expect(resolveExportOutDir(undefined, "/work", "hello")).toBe(resolve("/work", "hello"));
  });
  test("an absolute --out is used verbatim", () => {
    const out = resolveExportOutDir("/abs/dir", "/work", "hello");
    expect(isAbsolute(out)).toBe(true);
    expect(out).toBe(resolve("/abs/dir"));
  });
  test("a relative --out resolves against cwd", () => {
    expect(resolveExportOutDir("out/here", "/work", "hello")).toBe(resolve("/work", "out/here"));
  });
});

describe("smokeCheckClaudePluginBundle", () => {
  const goodPluginJson = JSON.stringify({
    name: "hello",
    description: "does a thing",
    author: { name: "Max" },
  });
  const wellFormed: ExportPluginFile[] = [
    { path: ".claude-plugin/plugin.json", content: goodPluginJson },
    { path: "README.md", content: "# hello" },
    { path: "skills/hello/SKILL.md", content: "---\nname: hello\n---\nbody" },
  ];

  test("a well-formed bundle has no issues", () => {
    expect(smokeCheckClaudePluginBundle(wellFormed)).toEqual([]);
  });

  test("a valid .mcp.json is accepted", () => {
    const withMcp: ExportPluginFile[] = [
      ...wellFormed,
      { path: ".mcp.json", content: JSON.stringify({ github: { command: "npx" } }) },
    ];
    expect(smokeCheckClaudePluginBundle(withMcp)).toEqual([]);
  });

  test("flags a missing / malformed plugin.json", () => {
    expect(smokeCheckClaudePluginBundle([{ path: "README.md", content: "x" }])).toContain(
      "missing required .claude-plugin/plugin.json",
    );
    const badJson = smokeCheckClaudePluginBundle([
      { path: ".claude-plugin/plugin.json", content: "{ not json" },
      { path: "README.md", content: "x" },
      { path: "skills/a/SKILL.md", content: "y" },
    ]);
    expect(badJson.some((i) => i.includes("not valid JSON"))).toBe(true);
  });

  test("flags plugin.json missing required keys", () => {
    const issues = smokeCheckClaudePluginBundle([
      { path: ".claude-plugin/plugin.json", content: JSON.stringify({ name: "hello" }) },
      { path: "README.md", content: "x" },
      { path: "skills/a/SKILL.md", content: "y" },
    ]);
    expect(issues).toContain(".claude-plugin/plugin.json is missing a non-empty description");
    expect(issues).toContain(".claude-plugin/plugin.json is missing author.name");
  });

  test("flags an invalid .mcp.json (the part mcp_servers specs care about)", () => {
    const issues = smokeCheckClaudePluginBundle([
      { path: ".claude-plugin/plugin.json", content: goodPluginJson },
      { path: "README.md", content: "x" },
      { path: "skills/a/SKILL.md", content: "y" },
      { path: ".mcp.json", content: "{ broken" },
    ]);
    expect(issues.some((i) => i.startsWith(".mcp.json is not valid JSON"))).toBe(true);
  });

  test("flags a bundle with no skill / agent surface", () => {
    expect(
      smokeCheckClaudePluginBundle([
        { path: ".claude-plugin/plugin.json", content: goodPluginJson },
        { path: "README.md", content: "x" },
      ]),
    ).toContain("no SKILL.md or agents/*.md — the plugin has nothing for Claude Code to load");
  });

  test("an agents/*.md counts as a surface", () => {
    expect(
      smokeCheckClaudePluginBundle([
        { path: ".claude-plugin/plugin.json", content: goodPluginJson },
        { path: "README.md", content: "x" },
        { path: "agents/researcher.md", content: "---\nname: researcher\n---" },
      ]),
    ).toEqual([]);
  });
});
