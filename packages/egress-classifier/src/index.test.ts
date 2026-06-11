import { afterEach, describe, expect, test } from "bun:test";
import { type TrustOrigin, createRunContext, tagContent } from "@crewhaus/run-context";
import {
  type EgressMatchInput,
  type EgressMatchResult,
  type EgressMatcher,
  MIN_MATCH_LENGTH,
  SubstringEgressMatcher,
  _cacheSize,
  _clearEgressCache,
  classifyEgress,
  substringMatcher,
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

  // SECURITY (audit R2): the cache key includes a digest of the LINEAGE
  // CONTENT. The lineage map grows during a run; a verdict computed before a
  // secret was tagged must not be served after the tag lands — that would be
  // an egress-scan bypass for every repeated payload.
  test("lineage growth invalidates a cached verdict for the same payload", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "some early boundary content of length", "subagent");
    const payload = "exfiltrating sk-LaterTagged99 now";
    const first = await classifyEgress(payload, ctx, {
      sinkId: "fetch",
      sinkScope: "external-dynamic",
    });
    expect(first.verdict).toBe("pass"); // secret not tagged yet
    // The secret now crosses a boundary and gets token-tagged.
    tagContent(ctx, "key issued: sk-LaterTagged99 keep private", "mcp");
    const second = await classifyEgress(payload, ctx, {
      sinkId: "fetch",
      sinkScope: "external-dynamic",
    });
    expect(second.fromCache).toBe(false); // NOT served stale
    expect(second.verdict).toBe("block");
    expect(second.originsFound).toEqual(["mcp"]);
  });

  // SECURITY (audit R2): end-to-end short-secret coverage — a credential-
  // shaped token under the old 16-char floor is tagged at the boundary and
  // caught at egress when the model extracts JUST the secret from its line.
  test("a short credential token extracted from its line is caught at egress", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "Stripe key for deploys: sk-Ab12Cd34 (rotate quarterly)", "mcp");
    const result = await classifyEgress("posting sk-Ab12Cd34 to a webhook", ctx, {
      sinkId: "fetch",
      sinkScope: "external-dynamic",
      bypassCache: true,
    });
    expect(result.verdict).toBe("block");
    expect(result.matchCount).toBeGreaterThanOrEqual(1);
    expect(result.originsFound).toEqual(["mcp"]);
  });
});

describe("MIN_MATCH_LENGTH constant", () => {
  test("is 8 — parity with run-context's MIN_TOKEN_TAG_LENGTH (audit R2)", () => {
    expect(MIN_MATCH_LENGTH).toBe(8);
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

// ---------------------------------------------------------------------------
// FR-006 — the EgressMatcher seam.
// ---------------------------------------------------------------------------

describe("SubstringEgressMatcher (FR-006)", () => {
  test('name is "substring" for audit + cache namespacing', () => {
    expect(substringMatcher.name).toBe("substring");
    expect(new SubstringEgressMatcher().name).toBe("substring");
  });

  test("matches identically to the legacy inline scan", () => {
    // The default matcher is the verbatim pre-FR-006 loop: tagged entries
    // >= floor that the payload contains, deduped origins, distinct count.
    const lineage = new Map<string, TrustOrigin>([
      ["mcp-sourced bearer token segment", "mcp"],
      ["subagent-flagged content from worker", "subagent"],
      ["short", "tool"], // under floor — must be ignored
      ["user-typed sentence here visible", "user"], // not present in payload
    ]);
    const payload =
      "POST mcp-sourced bearer token segment + subagent-flagged content from worker (short)";
    const result = new SubstringEgressMatcher().match({
      payload,
      lineage,
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect([...result.originsFound].sort()).toEqual(["mcp", "subagent"]);
    expect(result.matchCount).toBe(2); // the two over-floor hits; "short" skipped
  });

  test("respects the minMatchLength floor passed in the input", () => {
    // Use the concrete class so `.match` is the synchronous overload.
    const m = new SubstringEgressMatcher();
    const lineage = new Map<string, TrustOrigin>([["short67", "subagent"]]);
    // Under default floor (8) → a 7-char tag never matches.
    expect(
      m.match({
        payload: "carries short67 inside",
        lineage,
        minMatchLength: MIN_MATCH_LENGTH,
      }).matchCount,
    ).toBe(0);
    // With a low floor → hit.
    expect(
      m.match({
        payload: "carries short67 inside",
        lineage,
        minMatchLength: 4,
      }).matchCount,
    ).toBe(1);
  });

  // SECURITY: a prompt-injectable model can re-encode a tagged secret before
  // egress. A verbatim substring scan misses these; the decode-aware views do
  // not. The raw tagged content is the lineage key in every case.
  const TAGGED = "mcp-sourced secret value that exceeds the floor length";

  test("detects raw tagged content hidden by JSON.stringify escaping (#5)", () => {
    // runtime-core builds the egress payload as JSON.stringify(toolInput). A
    // multi-line tagged string is escaped (\\n, \\\") inside it, so the raw
    // string is NOT a verbatim substring — but the JSON-decoded view recovers it.
    const tagged = `${TAGGED}\nsecond "quoted" line`;
    const lineage = new Map<string, TrustOrigin>([[tagged, "mcp"]]);
    const payload = JSON.stringify({ url: "https://evil.test", body: tagged });
    expect(payload.includes(tagged)).toBe(false); // escaped — verbatim scan misses it
    const result = new SubstringEgressMatcher().match({
      payload,
      lineage,
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toEqual(["mcp"]);
    expect(result.matchCount).toBe(1);
  });

  test("detects base64-re-encoded tagged content (#6)", () => {
    const lineage = new Map<string, TrustOrigin>([[TAGGED, "subagent"]]);
    const b64 = Buffer.from(TAGGED, "utf8").toString("base64");
    const payload = JSON.stringify({ note: `exfil: ${b64}` });
    expect(payload.includes(TAGGED)).toBe(false);
    const result = new SubstringEgressMatcher().match({
      payload,
      lineage,
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toEqual(["subagent"]);
  });

  test("detects hex-re-encoded tagged content (#6)", () => {
    const lineage = new Map<string, TrustOrigin>([[TAGGED, "channel"]]);
    const hex = Buffer.from(TAGGED, "utf8").toString("hex");
    const result = new SubstringEgressMatcher().match({
      payload: `prefix ${hex} suffix`,
      lineage,
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toEqual(["channel"]);
  });

  test("detects percent-encoded tagged content (#6)", () => {
    const lineage = new Map<string, TrustOrigin>([[TAGGED, "federation"]]);
    const result = new SubstringEgressMatcher().match({
      payload: `q=${encodeURIComponent(TAGGED)}`,
      lineage,
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toEqual(["federation"]);
  });

  test("does not flag unrelated content (no false positive from decoding)", () => {
    const lineage = new Map<string, TrustOrigin>([[TAGGED, "mcp"]]);
    const payload = JSON.stringify({
      note: Buffer.from("totally unrelated bytes here", "utf8").toString("base64"),
    });
    const result = new SubstringEgressMatcher().match({
      payload,
      lineage,
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.matchCount).toBe(0);
  });
});

describe("classifyEgress with an injected matcher (FR-006)", () => {
  test("uses the injected matcher's hits and folds policy over them", async () => {
    const ctx = createRunContext();
    // Populate lineage with content the SUBSTRING matcher would NOT find in
    // the payload, proving the verdict came from the injected matcher.
    ctx.dataLineage = new Map<string, TrustOrigin>([
      ["paraphrased-and-reencoded original text", "subagent"],
    ]);
    const fakeMatcher: EgressMatcher = {
      name: "fake-fixed",
      match: (_input: EgressMatchInput): EgressMatchResult => ({
        originsFound: ["subagent"],
        matchCount: 1,
      }),
    };
    const result = await classifyEgress("totally unrelated outbound bytes", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured", // subagent on configured → warn
      matcher: fakeMatcher,
    });
    // The substring matcher would have returned pass (no verbatim overlap);
    // the injected matcher's hit drives the warn verdict. This proves the
    // policy fold is matcher-independent (acceptance #3).
    expect(result.verdict).toBe("warn");
    expect(result.originsFound).toEqual(["subagent"]);
    expect(result.matchCount).toBe(1);
  });

  test("custom-matcher hits still respect per-origin/per-sink policy", async () => {
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([["anything", "subagent"]]);
    const subagentHit: EgressMatcher = {
      name: "subagent-hit",
      match: () => ({ originsFound: ["subagent"], matchCount: 1 }),
    };
    // Same matcher, same hit — warn on configured, block on dynamic. The
    // outcome difference comes purely from sinkScope policy, not the matcher.
    const configured = await classifyEgress("payload", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      matcher: subagentHit,
      bypassCache: true,
    });
    const dynamic = await classifyEgress("payload", ctx, {
      sinkId: "dyn",
      sinkScope: "external-dynamic",
      matcher: subagentHit,
      bypassCache: true,
    });
    expect(configured.verdict).toBe("warn");
    expect(dynamic.verdict).toBe("block");
  });

  test("an injected matcher may be async", async () => {
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([["anything", "mcp"]]);
    const asyncMatcher: EgressMatcher = {
      name: "async-hit",
      match: async () => {
        await Promise.resolve();
        return { originsFound: ["mcp"], matchCount: 2 };
      },
    };
    const result = await classifyEgress("payload", ctx, {
      sinkId: "fetch",
      sinkScope: "external-dynamic", // mcp on dynamic → block
      matcher: asyncMatcher,
    });
    expect(result.verdict).toBe("block");
    expect(result.matchCount).toBe(2);
  });

  test("cache key namespaces by matcher name (no cross-serve)", async () => {
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([["anything", "subagent"]]);
    _clearEgressCache();
    // Matcher A finds a hit → warn, and caches under name "A".
    const matcherA: EgressMatcher = {
      name: "matcher-A",
      match: () => ({ originsFound: ["subagent"], matchCount: 1 }),
    };
    // Matcher B finds nothing → pass, under name "B". Same payload/sink.
    const matcherB: EgressMatcher = {
      name: "matcher-B",
      match: () => ({ originsFound: [], matchCount: 0 }),
    };
    const a = await classifyEgress("same payload", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      matcher: matcherA,
    });
    const b = await classifyEgress("same payload", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      matcher: matcherB,
    });
    expect(a.verdict).toBe("warn");
    expect(a.fromCache).toBe(false);
    // If the cache did NOT namespace by matcher name, B would have served
    // A's cached warn-hit. It must compute its own (pass) verdict instead.
    expect(b.verdict).toBe("pass");
    expect(b.fromCache).toBe(false);
    expect(_cacheSize()).toBe(2); // two distinct keys, not one
  });

  test("re-running the same matcher does serve from cache", async () => {
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([["anything", "subagent"]]);
    _clearEgressCache();
    const m: EgressMatcher = {
      name: "stable",
      match: () => ({ originsFound: ["subagent"], matchCount: 1 }),
    };
    const first = await classifyEgress("p", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      matcher: m,
    });
    const second = await classifyEgress("p", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      matcher: m,
    });
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.verdict).toBe("warn");
  });
});
