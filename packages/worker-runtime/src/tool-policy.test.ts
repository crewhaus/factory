import { describe, expect, test } from "bun:test";
import {
  EDGE_SAFE_TOOLS,
  HOST_ONLY_TOOLS,
  classifyEdgeTool,
  isEdgeSafeTool,
  partitionEdgeTools,
} from "./tool-policy";

describe("cf-worker edge-safety tool policy", () => {
  test("host tools are rejected with a category-specific reason", () => {
    for (const name of [
      "bash",
      "read",
      "write",
      "edit",
      "python",
      "javascript",
      "grep",
      "codegraphSearch",
    ]) {
      const verdict = classifyEdgeTool(name);
      expect(verdict.safe).toBe(false);
      if (!verdict.safe) expect(verdict.reason).toContain(name);
      expect(isEdgeSafeTool(name)).toBe(false);
    }
  });

  test("known network / KV builtins are edge-safe", () => {
    for (const name of [
      "fetch",
      "webFetch",
      "webSearch",
      "sendMessage",
      "imageGenerate",
      "todoWrite",
    ]) {
      const verdict = classifyEdgeTool(name);
      expect(verdict).toEqual({ safe: true, kind: "known" });
      expect(isEdgeSafeTool(name)).toBe(true);
    }
  });

  test("mcp__* tools are edge-safe (remote MCP over SSE/HTTP)", () => {
    expect(classifyEdgeTool("mcp__github__search")).toEqual({ safe: true, kind: "known" });
    expect(isEdgeSafeTool("mcp__anything__do")).toBe(true);
  });

  test("unrecognised custom tools are permitted with a warning", () => {
    const verdict = classifyEdgeTool("MyCustomThing");
    expect(verdict.safe).toBe(true);
    if (verdict.safe && verdict.kind === "unverified") {
      expect(verdict.warning).toContain("MyCustomThing");
    } else {
      throw new Error("expected an unverified verdict");
    }
  });

  test("host and edge-safe sets do not overlap", () => {
    for (const name of EDGE_SAFE_TOOLS) {
      expect(HOST_ONLY_TOOLS.has(name)).toBe(false);
    }
  });

  test("partitionEdgeTools splits, dedups, and preserves order", () => {
    const part = partitionEdgeTools(["fetch", "bash", "fetch", "custom", "read", "mcp__x__y"]);
    expect(part.allowed).toEqual(["fetch", "mcp__x__y"]);
    expect(part.rejected.map((r) => r.name)).toEqual(["bash", "read"]);
    expect(part.warned.map((w) => w.name)).toEqual(["custom"]);
    // Each rejected entry carries a reason; each warned entry a warning.
    expect(part.rejected[0]?.reason).toContain("bash");
    expect(part.warned[0]?.warning).toContain("custom");
  });
});
