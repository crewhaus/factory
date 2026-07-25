import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_CLAUDE_PLUGIN_AUTHOR,
  type ExportPluginFile,
  collectHarnessPluginAssets,
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

/**
 * Item 14 — the harness's authored `.crewhaus/` surface must travel into the
 * exported plugin. These build a throwaway harness on disk (the helper is the
 * one I/O function in this module) and assert the mapping onto Anthropic's
 * layout.
 */
describe("collectHarnessPluginAssets", () => {
  let harness: string | undefined;
  function freshHarness(files: Record<string, string>): string {
    harness = mkdtempSync(join(tmpdir(), "crewhaus-plugin-assets-"));
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(harness, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return harness;
  }
  afterEach(() => {
    if (harness !== undefined) rmSync(harness, { recursive: true, force: true });
    harness = undefined;
  });

  const goodSkill =
    "---\nname: research-topic\ndescription: corroborate claims\n---\n\nCite two.\n";

  test("maps .crewhaus/skills/** and .crewhaus/commands/*.md onto the plugin layout", () => {
    const dir = freshHarness({
      ".crewhaus/skills/research-topic/SKILL.md": goodSkill,
      ".crewhaus/skills/research-topic/references/checklist.md": "- [ ] two sources\n",
      ".crewhaus/commands/browse.md": "---\ndescription: browse\n---\nBrowse $ARGUMENTS\n",
      ".crewhaus/commands/notes.txt": "not a command",
    });
    const got = collectHarnessPluginAssets(dir);
    expect(got.issues).toEqual([]);
    expect(got.skipped).toEqual([]);
    expect(got.files.map((f) => f.path)).toEqual([
      "skills/research-topic/SKILL.md",
      "skills/research-topic/references/checklist.md",
      "commands/browse.md",
    ]);
    // Verbatim — re-rendering could only drop frontmatter keys the author wrote.
    expect(got.files[0]?.content).toBe(goodSkill);
  });

  test("a harness with no .crewhaus/ workspace contributes nothing (and does not throw)", () => {
    const dir = freshHarness({ "crewhaus.yaml": "name: x\n" });
    expect(collectHarnessPluginAssets(dir)).toEqual({ files: [], skipped: [], issues: [] });
  });

  test("a skills subdirectory without SKILL.md is not a skill", () => {
    const dir = freshHarness({ ".crewhaus/skills/scratch/notes.md": "wip" });
    expect(collectHarnessPluginAssets(dir).files).toEqual([]);
  });

  test("an authored SKILL.md Claude Code could not load is reported as an issue", () => {
    const dir = freshHarness({
      ".crewhaus/skills/no-frontmatter/SKILL.md": "# just a body\n",
      ".crewhaus/skills/no-description/SKILL.md": "---\nname: no-description\n---\nbody\n",
      ".crewhaus/skills/unclosed/SKILL.md": "---\nname: unclosed\ndescription: d\nbody\n",
    });
    const got = collectHarnessPluginAssets(dir);
    expect(got.files).toEqual([]);
    expect(got.issues).toHaveLength(3);
    // Verbatim `skills-registry` diagnostics — the export gate and the runtime
    // loader share one notion of a valid SKILL.md.
    const joined = got.issues.join("\n");
    expect(joined).toContain("must start with a `---` frontmatter delimiter");
    expect(joined).toContain("frontmatter description: Required");
    expect(joined).toContain("never terminated (missing `---` closer)");
  });

  test("a block-scalar description is valid frontmatter", () => {
    const dir = freshHarness({
      ".crewhaus/skills/blocky/SKILL.md":
        "---\nname: blocky\ndescription: |\n  multi\n  line\n---\nbody\n",
    });
    const got = collectHarnessPluginAssets(dir);
    expect(got.issues).toEqual([]);
    expect(got.files.map((f) => f.path)).toEqual(["skills/blocky/SKILL.md"]);
  });

  test("a binary payload inside a skill dir is skipped, not mangled into text", () => {
    const dir = freshHarness({ ".crewhaus/skills/imgs/SKILL.md": goodSkill });
    writeFileSync(
      join(dir, ".crewhaus/skills/imgs/logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
    const got = collectHarnessPluginAssets(dir);
    expect(got.files.map((f) => f.path)).toEqual(["skills/imgs/SKILL.md"]);
    expect(got.skipped).toEqual([join(dir, ".crewhaus/skills/imgs/logo.png")]);
  });

  test("symlinked entries are skipped, so the walk cannot cycle", () => {
    const dir = freshHarness({ ".crewhaus/skills/loop/SKILL.md": goodSkill });
    symlinkSync(join(dir, ".crewhaus/skills/loop"), join(dir, ".crewhaus/skills/loop/self"));
    expect(collectHarnessPluginAssets(dir).files.map((f) => f.path)).toEqual([
      "skills/loop/SKILL.md",
    ]);
  });
});
