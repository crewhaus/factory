/**
 * `plugins:` (#514, #522): a list of plugin names compiles to the bytes it
 * always did.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { corpusFileDigests } from "./__fixtures__/delta-090/regenerate";
import { PLUGINS_STRINGS_CORPUS } from "./plugins-corpus";

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
