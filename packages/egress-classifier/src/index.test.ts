import { afterEach, describe, expect, test } from "bun:test";
import { type TrustOrigin, createRunContext, tagContent } from "@crewhaus/run-context";
import {
  MIN_MATCH_LENGTH,
  _cacheSize,
  _clearEgressCache,
  classifyEgress,
  summarizeEgress,
} from "./index";

afterEach(() => {
  _clearEgressCache();
});

describe("classifyEgress", () => {
  test("returns pass when run-context has no dataLineage", async () => {
    const ctx = createRunContext();
    const result = await classifyEgress("any outbound payload", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    expect(result.verdict).toBe("pass");
    expect(result.originsFound).toEqual([]);
    expect(result.matchCount).toBe(0);
  });

  test("returns pass for user-origin content even at strict sink", async () => {
    const ctx = createRunContext();
    const tagged = "this is user-typed CLI input string";
    tagContent(ctx, tagged, "user");
    const result = await classifyEgress(`prefix ${tagged} suffix`, ctx, {
      sinkId: "fetch",
      sinkScope: "external-dynamic",
    });
    expect(result.verdict).toBe("pass");
    expect(result.originsFound).toEqual(["user"]);
    expect(result.matchCount).toBe(1);
  });

  test("warns when subagent content reaches a configured external sink", async () => {
    const ctx = createRunContext();
    const tagged = "API_KEY=sleeper-token-12345";
    tagContent(ctx, tagged, "subagent");
    const result = await classifyEgress(`POST body: ${tagged}`, ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    expect(result.verdict).toBe("warn");
    expect(result.originsFound).toEqual(["subagent"]);
  });

  test("blocks when subagent content reaches a dynamic external sink", async () => {
    const ctx = createRunContext();
    const tagged = "API_KEY=sleeper-token-12345";
    tagContent(ctx, tagged, "subagent");
    const result = await classifyEgress(`Bearer ${tagged}`, ctx, {
      sinkId: "dynamic-mcp:foo",
      sinkScope: "external-dynamic",
    });
    expect(result.verdict).toBe("block");
    expect(result.originsFound).toEqual(["subagent"]);
  });

  test("ignores tagged content shorter than the match floor", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "abc", "subagent"); // way under 16-char floor
    const result = await classifyEgress("https://example.com/?q=abc", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    expect(result.verdict).toBe("pass");
    expect(result.matchCount).toBe(0);
  });

  test("respects a custom minMatchLength for fixtures", async () => {
    const ctx = createRunContext();
    // tagContent itself enforces a 16-char floor to keep lineage clean, so
    // for short-fixture tests we pre-populate dataLineage directly. In
    // production, the classifier's floor and tagContent's floor are both
    // 16; minMatchLength override is intended for tests + recipes.
    ctx.dataLineage = new Map<string, TrustOrigin>([["shortish", "subagent"]]);
    const result = await classifyEgress("payload shortish embedded", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      minMatchLength: 4,
    });
    expect(result.verdict).toBe("warn");
    expect(result.matchCount).toBe(1);
  });

  test("folds to the most severe origin across multiple matches", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "user-typed sentence here visible", "user");
    tagContent(ctx, "mcp-sourced bearer token segment", "mcp");
    const result = await classifyEgress(
      "user-typed sentence here visible + mcp-sourced bearer token segment",
      ctx,
      {
        sinkId: "dynamic-fetch",
        sinkScope: "external-dynamic",
      },
    );
    expect(result.verdict).toBe("block"); // mcp on dynamic-sink → block
    expect(result.originsFound).toContain("user");
    expect(result.originsFound).toContain("mcp");
  });

  test("override tightens policy beyond default", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "subagent-flagged content from worker", "subagent");
    const result = await classifyEgress("POST: subagent-flagged content from worker", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured", // default = warn
      override: { subagent: "block" },
    });
    expect(result.verdict).toBe("block");
  });

  test("caches verdicts by (sinkScope, sinkId, payload)", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "content tagged by subagent boundary", "subagent");
    _clearEgressCache();
    const first = await classifyEgress("POST content tagged by subagent boundary", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    expect(first.fromCache).toBe(false);
    expect(_cacheSize()).toBe(1);

    const second = await classifyEgress("POST content tagged by subagent boundary", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    expect(second.fromCache).toBe(true);
    expect(second.verdict).toBe("warn");
  });

  test("cache bypass forces re-evaluation", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "content tagged by subagent boundary", "subagent");
    await classifyEgress("POST content tagged by subagent boundary", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    const re = await classifyEgress("POST content tagged by subagent boundary", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      bypassCache: true,
    });
    expect(re.fromCache).toBe(false);
  });

  test("rejects non-string payloads", async () => {
    const ctx = createRunContext();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
      classifyEgress(123 as any, ctx, { sinkId: "fetch", sinkScope: "external-configured" }),
    ).rejects.toThrow(/expected a string/);
  });
});

describe("MIN_MATCH_LENGTH constant", () => {
  test("is 16", () => {
    expect(MIN_MATCH_LENGTH).toBe(16);
  });
});

describe("summarizeEgress", () => {
  test("formats a clean verdict for audit logs", () => {
    const summary = summarizeEgress({
      verdict: "pass",
      originsFound: [],
      matchCount: 0,
      fromCache: false,
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    expect(summary).toContain("clean");
    expect(summary).toContain("fetch");
    expect(summary).toContain("external-configured");
  });

  test("formats a block verdict with origin list", () => {
    const summary = summarizeEgress({
      verdict: "block",
      originsFound: ["mcp", "subagent"],
      matchCount: 3,
      fromCache: false,
      sinkId: "dynamic-mcp:foo",
      sinkScope: "external-dynamic",
    });
    expect(summary).toContain("block");
    expect(summary).toContain("3");
    expect(summary).toContain("mcp,subagent");
    expect(summary).toContain("dynamic-mcp:foo");
  });
});
