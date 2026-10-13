/**
 * 0.7.1 — MCP tools are registered as `mcp__<server>__<tool>`. A rate limit a
 * spec wrote against the old `<server>__<tool>` spelling must keep applying:
 * a limit that silently stopped matching would be a control that failed open.
 */
import { describe, expect, test } from "bun:test";
import { rekeyLegacyMcpToolKeys } from "./index";

const limit = (rpm: number) => ({ rpm });

describe("rekeyLegacyMcpToolKeys", () => {
  const tools = new Set(["Read", "mcp__github__create_issue", "mcp__broker__quote"]);

  test("an old-spelling key moves onto the registered name", () => {
    expect(
      rekeyLegacyMcpToolKeys({ github__create_issue: limit(5), Read: limit(60) }, tools),
    ).toEqual({ mcp__github__create_issue: limit(5), Read: limit(60) });
  });

  test("a key that already names a tool, and the `*` default, stay put", () => {
    const map = { mcp__broker__quote: limit(1), "*": limit(30) };
    expect(rekeyLegacyMcpToolKeys(map, tools)).toBe(map);
  });

  test("when both spellings are present, the registered one wins and the old one is left inert", () => {
    const out = rekeyLegacyMcpToolKeys(
      { broker__quote: limit(9), mcp__broker__quote: limit(1) },
      tools,
    );
    expect(out?.["mcp__broker__quote"]).toEqual(limit(1));
  });

  test("a key naming no tool is left alone, and undefined stays undefined", () => {
    const map = { nothing__here: limit(1) };
    expect(rekeyLegacyMcpToolKeys(map, tools)).toBe(map);
    expect(rekeyLegacyMcpToolKeys(undefined, tools)).toBeUndefined();
  });
});
