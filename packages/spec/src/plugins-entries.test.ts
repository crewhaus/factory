/**
 * `plugins:` (#522): an entry is a plugin name or `{name, tools}`, on cli and
 * channel only; each bad object reports its own path; a plugin with an object
 * entry is listed once.
 */
import { describe, expect, test } from "bun:test";
import { DELTA_090_ISSUES } from "./blocks/delta-090";
import { pluginsIssues } from "./blocks/plugins";
import { scheduleIssues } from "./blocks/schedule";
import {
  PLUGIN_ENTRY_TOOL_NAME_PATTERN,
  parseSpec,
  parseSpecIssues,
  specJsonSchema,
} from "./index";

const SHAPES: Readonly<Record<string, string>> = {
  cli: "name: a\ntarget: cli\nagent: {model: claude-opus-4-7, instructions: Help.}\n",
  channel:
    "name: a\ntarget: channel\nagent: {model: claude-opus-4-7, instructions: Help.}\nchannels:\n  slack: {botToken: $T, signingSecret: $S}\nrouting: {sessionKey: thread}\n",
};
const CLI = SHAPES["cli"] as string;
const OTHERS: Readonly<Record<string, string>> = {
  managed:
    "name: a\ntarget: managed\nagent: {model: claude-opus-4-7, instructions: Help.}\ntenants:\n  - {id: t, budget: {maxInputTokens: 1, maxOutputTokens: 1}}\n",
  workflow:
    "name: a\ntarget: workflow\nmodel: claude-opus-4-7\nsteps:\n  - {name: s, instructions: Go.}\n",
};

const MIXED = `plugins:
  - notes
  - name: weather-pane
    tools: [Read, Bash]
`;

describe("both forms", () => {
  for (const [shape, yaml] of Object.entries(SHAPES)) {
    test(`parse on ${shape}, each entry as written`, () => {
      const spec = parseSpec(`${yaml}${MIXED}`) as { plugins?: unknown };
      expect(spec.plugins).toEqual(["notes", { name: "weather-pane", tools: ["Read", "Bash"] }]);
    });

    test(`a name list parses on ${shape} as it always did, repeats included`, () => {
      const spec = parseSpec(`${yaml}plugins: [notes, notes]\n`) as { plugins?: unknown };
      expect(spec.plugins).toEqual(["notes", "notes"]);
    });
  }

  for (const [shape, yaml] of Object.entries(OTHERS)) {
    test(`the object form is refused on ${shape}, as the name form is`, () => {
      expect(parseSpecIssues(`${yaml}plugins:\n  - {name: notes, tools: []}\n`).length).toBe(1);
      expect(parseSpecIssues(`${yaml}plugins: [notes]\n`).length).toBe(1);
    });
  }
});

describe("a bad object entry reports its own path", () => {
  const issue = (entries: string) => parseSpecIssues(`${CLI}plugins:\n${entries}`)[0];

  test("more than 64 tools", () => {
    const tools = Array.from({ length: 65 }, (_, i) => `t${i}`).join(", ");
    expect(
      parseSpecIssues(
        `${CLI}plugins:\n  - {name: p, tools: [${tools.split(", ").slice(0, 64).join(", ")}]}\n`,
      ),
    ).toEqual([]);
    const first = issue(`  - {name: p, tools: [${tools}]}\n`);
    expect(first?.path).toEqual(["plugins", 0, "tools"]);
    expect(first?.message).toBe("plugins[].tools lists at most 64 host tools");
  });

  test("a bad tool name", () => {
    const first = issue("  - notes\n  - {name: p, tools: [Read, 'Fetch(x)']}\n");
    expect(first?.path).toEqual(["plugins", 1, "tools", 1]);
    expect(first?.message).toContain('1-64 letters, digits, "_" or "-"');
  });

  test("an unknown key", () => {
    const first = issue("  - {name: p, tools: [], panes: [a]}\n");
    expect(first?.path).toEqual(["plugins", 0]);
    expect(first?.message).toContain("panes");
  });

  test("a missing name, and a missing tools list", () => {
    expect(issue("  - {tools: [Read]}\n")?.path).toEqual(["plugins", 0, "name"]);
    expect(issue("  - {name: p}\n")?.path).toEqual(["plugins", 0, "tools"]);
  });

  test("an empty name is refused in both forms", () => {
    expect(issue('  - ""\n')?.path).toEqual(["plugins", 0]);
    expect(issue('  - {name: "", tools: []}\n')?.path).toEqual(["plugins", 0, "name"]);
  });
});

describe("a plugin with an object entry is listed once", () => {
  test("a repeat of it is an issue at the repeat", () => {
    for (const entries of [
      "  - notes\n  - {name: notes, tools: []}\n",
      "  - {name: notes, tools: []}\n  - notes\n",
      "  - {name: notes, tools: [Read]}\n  - {name: notes, tools: [Bash]}\n",
    ]) {
      const issues = parseSpecIssues(`${CLI}plugins:\n${entries}`);
      expect(issues.length).toBe(1);
      expect(issues[0]?.path).toEqual(["plugins", 1]);
      expect(issues[0]?.message).toContain("list a plugin once");
    }
  });

  test("the check runs last, and only once", () => {
    expect(DELTA_090_ISSUES.indexOf(scheduleIssues)).toBe(1);
    expect(DELTA_090_ISSUES.indexOf(pluginsIssues)).toBe(2);
    expect(DELTA_090_ISSUES.filter((check) => check === pluginsIssues).length).toBe(1);
  });
});

test("the tool-name rule is exported", () => {
  expect(PLUGIN_ENTRY_TOOL_NAME_PATTERN.test("mcp__notes_search")).toBe(true);
  expect(PLUGIN_ENTRY_TOOL_NAME_PATTERN.test("Fetch(x)")).toBe(false);
});

test("the JSON Schema describes both entry forms on cli and channel", () => {
  const root = specJsonSchema() as Record<string, unknown>;
  const resolve = (node: unknown): Record<string, unknown> | undefined => {
    const ref = (node as { $ref?: unknown } | undefined)?.$ref;
    if (typeof ref !== "string") return node as Record<string, unknown> | undefined;
    let at: unknown = root;
    for (const part of ref.replace(/^#\//, "").split("/")) {
      at = (at as Record<string, unknown> | undefined)?.[part];
    }
    return resolve(at);
  };
  const definitions = root["definitions"] as Record<string, unknown>;
  for (const shape of ["cli", "channel"]) {
    const plugins = resolve(
      (definitions[shape] as { properties: Record<string, unknown> }).properties["plugins"],
    ) as { type?: string; items?: unknown } | undefined;
    expect(plugins?.type).toBe("array");
    const forms = (resolve(plugins?.items) as { anyOf?: Array<Record<string, unknown>> }).anyOf;
    expect(forms?.length).toBe(2);
    expect(forms?.[0]?.["type"]).toBe("string");
    expect(forms?.[1]?.["type"]).toBe("object");
  }
});
