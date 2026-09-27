/**
 * extension-path#8 (C107): `provides.tools` lists, in the signed manifest,
 * the tools a plugin's code contributes; plugin-loader refuses a plugin whose
 * code does not match it.
 */
import { describe, expect, test } from "bun:test";
import { PLUGIN_TOOL_NAME_PATTERN, PluginSdkError, validatePluginManifest } from "./index";

const base = { name: "my-plugin", version: "1.0.0" };

describe("provides.tools", () => {
  test("a list of provider-legal tool names is accepted, as is no list", () => {
    expect(
      validatePluginManifest({ ...base, provides: { tools: ["a_b-C9", "x"] } }).provides,
    ).toEqual({
      tools: ["a_b-C9", "x"],
    });
    expect(validatePluginManifest({ ...base, provides: {} }).provides).toEqual({});
    expect(validatePluginManifest(base).provides).toBeUndefined();
  });

  test("anything else is refused with the reason", () => {
    const cases: Array<[unknown, string]> = [
      [[], "`provides` must be an object"],
      [null, "`provides` must be an object"],
      [{ tools: "hi" }, "`provides.tools` must be an array of strings"],
      [{ tools: [""] }, "`provides.tools` entries must be non-empty strings"],
      [
        { tools: ["Fetch(x"] },
        '`provides.tools` entry "Fetch(x" must be 1-64 letters, digits, "_" or "-"',
      ],
      [{ tools: ["a".repeat(65)] }, "must be 1-64 letters"],
      [{ tools: ["hi", "hi"] }, "`provides.tools` lists a tool twice"],
    ];
    for (const [provides, why] of cases) {
      expect(() => validatePluginManifest({ ...base, provides })).toThrow(PluginSdkError);
      expect(() => validatePluginManifest({ ...base, provides })).toThrow(why);
    }
  });

  test("the name grammar is the one model providers accept", () => {
    expect(["a", "A_b-9", "x".repeat(64)].every((n) => PLUGIN_TOOL_NAME_PATTERN.test(n))).toBe(
      true,
    );
    expect(
      ["", "a b", "a.b", "a(b", "x".repeat(65)].some((n) => PLUGIN_TOOL_NAME_PATTERN.test(n)),
    ).toBe(false);
  });
});
