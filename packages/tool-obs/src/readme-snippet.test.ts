/**
 * The README's `tools:` snippet is one a spec can paste (C113, docs-claims#3).
 *
 * 0.7.0 package READMEs showed snippets that fail to compile: a PascalCase
 * exclusion (`-SmsSend`) where a `tools:` list takes the camelCase key, and
 * a category name that does not exist. The compiler refuses both, so a
 * newcomer's first paste failed. This holds the snippet in this README to
 * what the selector grammar accepts, and holds "every tool below" to the
 * tools the README's tables list.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expandToolSelectors } from "@crewhaus/tool-categories";

const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

/** Every ```yaml block's `tools:` list. */
function toolLists(): string[][] {
  const lists: string[][] = [];
  for (const match of README.matchAll(/```yaml\n([\s\S]*?)```/g)) {
    const parsed = Bun.YAML.parse(match[1] as string) as { tools?: unknown } | null;
    if (Array.isArray(parsed?.tools)) lists.push(parsed.tools as string[]);
  }
  return lists;
}

/** The camelCase key of every tool a README table row names. */
function tableKeys(): Set<string> {
  const keys = new Set<string>();
  for (const match of README.matchAll(/^\| `([A-Z][A-Za-z0-9]*)` \|/gm)) {
    const name = match[1] as string;
    keys.add(name[0]?.toLowerCase() + name.slice(1));
  }
  return keys;
}

describe("the README's tools: snippet (C113)", () => {
  test("compiles, and its first include is every tool the tables list", () => {
    const lists = toolLists();
    expect(lists.length).toBe(1);
    const list = lists[0] as string[];
    expect(() => expandToolSelectors(list, { path: "README tools" })).not.toThrow();
    const everyTool = new Set(expandToolSelectors([list[0] as string]).tools);
    const listed = tableKeys();
    expect(listed.size).toBe(16);
    expect(everyTool).toEqual(listed);
  });
});
