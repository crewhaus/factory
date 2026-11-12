/**
 * `buildTool` passes `checksOwnTargets` through only when it is `true`: the
 * runtime-state floor reads a store's own files for such a tool the `inside`
 * way alone, so an absent or false flag must leave the field off.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildTool } from "./index";

const base = {
  name: "Importer",
  description: "imports",
  inputSchema: z.object({}),
  execute: async () => "ok",
};

describe("buildTool checksOwnTargets pass-through", () => {
  test("true is carried", () => {
    expect(buildTool({ ...base, checksOwnTargets: true }).checksOwnTargets).toBe(true);
  });

  test("absent or false leaves the field off", () => {
    expect("checksOwnTargets" in buildTool(base)).toBe(false);
    expect("checksOwnTargets" in buildTool({ ...base, checksOwnTargets: false })).toBe(false);
  });
});
