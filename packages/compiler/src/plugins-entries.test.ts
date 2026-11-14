/**
 * `plugins:` (#514, #522): a list of plugin names compiles to the bytes it
 * always did, and a `{name, tools}` entry lowers with its tools sorted and
 * de-duplicated, in entry order.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY, corpusFileDigests } from "./__fixtures__/delta-090/regenerate";
import { compile, lower } from "./index";
import { lowerPlugins } from "./lower/plugins";
import { PLUGINS_GRANTS_CORPUS, PLUGINS_STRINGS_CORPUS } from "./plugins-corpus";

function digestsOf(name: string): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/delta-090/${name}`, import.meta.url), "utf8"),
  ) as Record<string, Record<string, string>>;
}

describe("a list of plugin names", () => {
  const pinned = digestsOf("plugins-strings.digests.json");

  test("the digest file covers exactly the two specs", () => {
    expect(Object.keys(pinned).sort()).toEqual(Object.keys(PLUGINS_STRINGS_CORPUS).sort());
    expect(Object.keys(pinned)).toEqual(["channel-strings", "cli-strings"]);
  });

  for (const [name, yaml] of Object.entries(PLUGINS_STRINGS_CORPUS)) {
    test(`${name}: every file matches its digest`, () => {
      expect(
        corpusFileDigests(yaml),
        "a list of plugin names compiled to new bytes: the entry form reached a spec that does not use it",
      ).toEqual(pinned[name] as Record<string, string>);
    });
  }
});

describe("lowerPlugins", () => {
  test("names pass through; an object sorts and de-duplicates its tools; entry order is kept", () => {
    expect(
      lowerPlugins({
        plugins: ["b", { name: "a", tools: ["Write", "Read", "Write"] }, "b", "c"],
      }),
    ).toEqual({ plugins: ["b", { name: "a", tools: ["Read", "Write"] }, "b", "c"] });
  });

  test("an object lowers with name before tools, and tools: [] stays empty", () => {
    const lowered = lowerPlugins({ plugins: [{ tools: [], name: "a" } as never] });
    expect(lowered).toEqual({ plugins: [{ name: "a", tools: [] }] });
    expect(Object.keys((lowered.plugins as Array<object>)[0] as object)).toEqual(["name", "tools"]);
  });

  test("empty or absent lowers to nothing", () => {
    expect(lowerPlugins({ plugins: [] })).toEqual({});
    expect(lowerPlugins({})).toEqual({});
  });
});

describe("a {name, tools} entry", () => {
  const present = digestsOf("plugins-grants.present.digests.json");

  test("the present golden covers exactly the two shapes", () => {
    expect(Object.keys(present)).toEqual(["channel-grants", "cli-grants"]);
    expect(Object.keys(PLUGINS_GRANTS_CORPUS).sort()).toEqual(Object.keys(present));
  });

  for (const [name, yaml] of Object.entries(PLUGINS_GRANTS_CORPUS)) {
    test(`${name}: lowers with tools sorted and de-duplicated`, () => {
      const ir = lower(parseSpec(yaml), { today: CORPUS_TODAY }) as unknown as Record<
        string,
        unknown
      >;
      expect(ir["plugins"]).toEqual(["notes", { name: "weather-pane", tools: ["Bash", "Read"] }]);
    });

    test(`${name}: the emitted names: carries the entry as JSON`, () => {
      const files = compile(yaml, { today: CORPUS_TODAY }).files;
      const code = files.find((f) => f.path === "agent.ts" || f.path === "daemon.ts");
      const all = files.map((f) => f.content).join("\n");
      expect(code).toBeDefined();
      expect(all).toContain('names: ["notes",{"name":"weather-pane","tools":["Bash","Read"]}],');
    });

    test(`${name}: every file matches the present golden`, () => {
      expect(corpusFileDigests(yaml)).toEqual(present[name] as Record<string, string>);
    });
  }
});
