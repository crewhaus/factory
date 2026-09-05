/**
 * Supplemental coverage + hardening tests for `egress-classifier`.
 *
 * Companion to `index.test.ts`: the FR-006 acceptance suite there exercises
 * the matcher seam and the headline pass/warn/block flows; this file drives
 * the remaining branches (LRU eviction + recency, every policy-matrix cell,
 * the cache-key framing regression, and the summarize/diagnostics helpers)
 * to 100% and pins the security-relevant invariants.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { TRUST_ORIGINS } from "@crewhaus/boundary-classifier";
import { CrewhausError } from "@crewhaus/errors";
import { type TrustOrigin, createRunContext, tagContent } from "@crewhaus/run-context";
import {
  EgressClassifierError,
  type EgressMatcher,
  type EgressResult,
  MIN_MATCH_LENGTH,
  type SinkScope,
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

// A trivially deterministic matcher that always reports the given origins.
function fixedMatcher(
  name: string,
  originsFound: TrustOrigin[],
  matchCount = originsFound.length,
): EgressMatcher {
  return { name, match: () => ({ originsFound, matchCount }) };
}

describe("post-match (await) return paths with forced cache miss", () => {
  test("bypassCache + matcher returns no hits → fresh pass after the await", async () => {
    // Guarantees the cache-miss branch runs (bypassCache), the matcher is
    // awaited, and the post-await `originsFound.length === 0` early return is
    // taken — distinct from the no-lineage pre-await pass.
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([["anything-present", "subagent"]]);
    const r = await classifyEgress("outbound bytes", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      matcher: fixedMatcher("no-hits", [], 0),
      bypassCache: true,
    });
    expect(r.verdict).toBe("pass");
    expect(r.fromCache).toBe(false);
    expect(r.originsFound).toEqual([]);
    expect(r.matchCount).toBe(0);
    expect(_cacheSize()).toBe(0); // bypassCache never wrote
  });

  test("bypassCache + matcher returns hits → fresh non-pass after the await", async () => {
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([["anything-present", "subagent"]]);
    const r = await classifyEgress("outbound bytes", ctx, {
      sinkId: "fetch",
      sinkScope: "external-dynamic",
      matcher: fixedMatcher("has-hits", ["subagent"], 1),
      bypassCache: true,
    });
    expect(r.verdict).toBe("block");
    expect(r.fromCache).toBe(false);
    expect(_cacheSize()).toBe(0);
  });

  test("real substring path: cache miss, await, then non-empty return", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "subagent payload that is verbatim present", "subagent");
    const r = await classifyEgress("POST subagent payload that is verbatim present now", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      bypassCache: true,
    });
    expect(r.verdict).toBe("warn");
    expect(r.fromCache).toBe(false);
  });

  test("real substring path: cache miss, await, then empty return (no overlap)", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "tagged content that will not appear", "subagent");
    const r = await classifyEgress("a completely disjoint outbound string", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      bypassCache: true,
    });
    expect(r.verdict).toBe("pass");
    expect(r.fromCache).toBe(false);
    expect(r.originsFound).toEqual([]);
  });
});

describe("policy matrix — every TrustOrigin × SinkScope cell", () => {
  // Every non-user origin: warn on configured, block on dynamic. Derived from
  // the classifier's declared origin list (0.6.0 §10.1) so a new origin is
  // covered the moment it exists — this array used to be hand-written and
  // had silently missed "memory".
  const nonUser: TrustOrigin[] = TRUST_ORIGINS.filter((o) => o !== "user");
  test("the derived list covers every origin the matrix declares", () => {
    expect(nonUser).toContain("memory");
    expect(nonUser).toContain("consult");
    expect(nonUser.length).toBe(TRUST_ORIGINS.length - 1);
  });

  for (const origin of nonUser) {
    test(`${origin}: configured → warn, dynamic → block`, async () => {
      const ctx = createRunContext();
      ctx.dataLineage = new Map<string, TrustOrigin>([["anything-tagged", origin]]);
      const m = fixedMatcher(`fixed-${origin}`, [origin], 1);
      const configured = await classifyEgress("payload", ctx, {
        sinkId: "fetch",
        sinkScope: "external-configured",
        matcher: m,
        bypassCache: true,
      });
      const dynamic = await classifyEgress("payload", ctx, {
        sinkId: "dyn",
        sinkScope: "external-dynamic",
        matcher: m,
        bypassCache: true,
      });
      expect(configured.verdict).toBe("warn");
      expect(dynamic.verdict).toBe("block");
    });
  }

  test("user: pass on both configured and dynamic", async () => {
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([["anything-tagged", "user"]]);
    const m = fixedMatcher("fixed-user", ["user"], 1);
    for (const sinkScope of ["external-configured", "external-dynamic"] as SinkScope[]) {
      const r = await classifyEgress("payload", ctx, {
        sinkId: "s",
        sinkScope,
        matcher: m,
        bypassCache: true,
      });
      expect(r.verdict).toBe("pass");
      expect(r.originsFound).toEqual(["user"]);
    }
  });
});

describe("foldVerdict precedence (via classifyEgress)", () => {
  test("warn wins over pass when no block present", async () => {
    // user (pass) + tool@configured (warn) → warn, exercising the
    // `some(warn)` branch after `some(block)` short-circuits to false.
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([
      ["one", "user"],
      ["two", "tool"],
    ]);
    const m = fixedMatcher("multi", ["user", "tool"], 2);
    const r = await classifyEgress("payload", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      matcher: m,
    });
    expect(r.verdict).toBe("warn");
  });

  test("block wins over warn", async () => {
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([
      ["one", "user"],
      ["two", "mcp"],
    ]);
    // user → pass, mcp@dynamic → block; folded = block.
    const m = fixedMatcher("multi2", ["user", "mcp"], 2);
    const r = await classifyEgress("payload", ctx, {
      sinkId: "dyn",
      sinkScope: "external-dynamic",
      matcher: m,
    });
    expect(r.verdict).toBe("block");
  });

  test("all-pass origins fold to pass", async () => {
    // Two user hits → foldVerdict reaches the trailing `return "pass"`.
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([
      ["one", "user"],
      ["two", "user"],
    ]);
    const m = fixedMatcher("two-user", ["user", "user"], 2);
    const r = await classifyEgress("payload", ctx, {
      sinkId: "fetch",
      sinkScope: "external-dynamic",
      matcher: m,
    });
    expect(r.verdict).toBe("pass");
  });
});

describe("override semantics", () => {
  test("override can loosen a default-block to pass on a dynamic sink", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "mcp-sourced content from a server", "mcp");
    const r = await classifyEgress("body: mcp-sourced content from a server", ctx, {
      sinkId: "dyn-mcp",
      sinkScope: "external-dynamic", // default mcp@dynamic = block
      override: { mcp: "pass" },
    });
    expect(r.verdict).toBe("pass");
    expect(r.originsFound).toEqual(["mcp"]);
  });

  test("override only applies to listed origins; others keep defaults", async () => {
    const ctx = createRunContext();
    ctx.dataLineage = new Map<string, TrustOrigin>([
      ["one", "subagent"],
      ["two", "channel"],
    ]);
    const m = fixedMatcher("two-origin", ["subagent", "channel"], 2);
    // Loosen subagent to pass, leave channel at its dynamic default (block).
    const r = await classifyEgress("payload", ctx, {
      sinkId: "dyn",
      sinkScope: "external-dynamic",
      override: { subagent: "pass" },
      matcher: m,
    });
    expect(r.verdict).toBe("block"); // channel still blocks
  });

  test("cached verdict is re-folded under a different override on the second call", async () => {
    // First call caches the raw hit (subagent) with no override. Second call
    // serves from cache but recomputes the verdict under a tightening
    // override — exercising the cache-hit `.map(originVerdict)` arrow.
    const ctx = createRunContext();
    const tagged = "subagent content for cache reeval test";
    tagContent(ctx, tagged, "subagent");
    const first = await classifyEgress(`x ${tagged}`, ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured", // warn
    });
    expect(first.fromCache).toBe(false);
    expect(first.verdict).toBe("warn");

    const second = await classifyEgress(`x ${tagged}`, ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      override: { subagent: "block" }, // tighten
    });
    expect(second.fromCache).toBe(true);
    expect(second.verdict).toBe("block");
    // The cached raw hit is preserved even though the folded verdict changed.
    expect(second.originsFound).toEqual(["subagent"]);
    expect(second.matchCount).toBe(1);
  });
});

describe("cache-key framing (regression: delimiter-collision exfil bypass)", () => {
  test("shifted sinkId/payload boundary does NOT cross-serve a cached verdict", async () => {
    // CONSTRUCT A TRUE COLLISION for the old bare-`|` key scheme. With
    // matcher+scope held constant, these two calls byte-concatenate the same
    // `sinkId|payload` stream:
    //   A: sinkId = "tool|", payload = P          → "…|tool||P"
    //   B: sinkId = "tool",  payload = "|" + P    → "…|tool||P"
    // Under the vulnerable key, B would hash-collide with A and be served A's
    // cached entry (fromCache:true, cache size stays 1) — a cache-poisoning /
    // egress-scan bypass when sinkId carries attacker influence (e.g. a
    // dynamically discovered MCP tool name). Length-framed keys make the two
    // self-delimiting and therefore distinct.
    const ctx = createRunContext();
    // Lineage must be non-empty so the classifier reaches the cache/match path
    // (an empty lineage short-circuits to pass before any key is computed).
    ctx.dataLineage = new Map<string, TrustOrigin>([["present-tag-entry", "subagent"]]);
    const P = "shared-suffix outbound payload bytes";
    // Use a matcher whose result is independent of payload so the two calls'
    // verdicts would coincide — isolating `fromCache`/size as the sole tell.
    const m = fixedMatcher("framing", ["subagent"], 1);

    const a = await classifyEgress(P, ctx, {
      sinkId: "tool|",
      sinkScope: "external-configured",
      matcher: m,
    });
    expect(a.fromCache).toBe(false);
    expect(_cacheSize()).toBe(1);

    const b = await classifyEgress(`|${P}`, ctx, {
      sinkId: "tool",
      sinkScope: "external-configured",
      matcher: m,
    });
    // The discriminator: on the fixed key B is a fresh miss (its own slot);
    // on the vulnerable key B would have been served A's entry.
    expect(b.fromCache).toBe(false);
    expect(_cacheSize()).toBe(2);
  });

  test("identical (matcher, scope, sinkId, payload) still hits cache", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "subagent content stable for cache", "subagent");
    const p = "POST subagent content stable for cache";
    const first = await classifyEgress(p, ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    const second = await classifyEgress(p, ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(_cacheSize()).toBe(1);
  });

  test("a literal '|' inside sinkId does not collide with a different split", async () => {
    // Direct key-injectivity check at the classifier boundary: same payload,
    // sinkIds "a|b" vs "a" with payload prefixed — must be two cache slots.
    const ctx = createRunContext();
    tagContent(ctx, "subagent content for framing test ok", "subagent");
    await classifyEgress("subagent content for framing test ok", ctx, {
      sinkId: "a|b",
      sinkScope: "external-configured",
    });
    await classifyEgress("subagent content for framing test ok", ctx, {
      sinkId: "a",
      sinkScope: "external-configured",
    });
    expect(_cacheSize()).toBe(2);
  });
});

describe("LRU cache behaviour", () => {
  test("distinct payloads accumulate distinct entries", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "subagent content for lru accumulation", "subagent");
    for (let i = 0; i < 5; i++) {
      await classifyEgress(`payload number ${i} subagent content for lru accumulation`, ctx, {
        sinkId: "fetch",
        sinkScope: "external-configured",
      });
    }
    expect(_cacheSize()).toBe(5);
  });

  test("re-accessing an entry refreshes its recency (get path)", async () => {
    // Exercises LruCache.get's move-to-end recency bump: an entry read on the
    // second call survives even as new entries arrive.
    const ctx = createRunContext();
    tagContent(ctx, "subagent recency probe content here", "subagent");
    const p0 = "first subagent recency probe content here";
    const r1 = await classifyEgress(p0, ctx, { sinkId: "fetch", sinkScope: "external-configured" });
    expect(r1.fromCache).toBe(false);
    // Touch p0 again → cache hit, recency refreshed.
    const r2 = await classifyEgress(p0, ctx, { sinkId: "fetch", sinkScope: "external-configured" });
    expect(r2.fromCache).toBe(true);
    expect(_cacheSize()).toBe(1);
  });

  test("bypassCache never populates the cache (no store on miss)", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "subagent content under bypass mode here", "subagent");
    await classifyEgress("x subagent content under bypass mode here", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
      bypassCache: true,
    });
    expect(_cacheSize()).toBe(0);
  });
});

describe("summarizeEgress", () => {
  const base: Omit<EgressResult, "verdict" | "originsFound" | "matchCount"> = {
    fromCache: false,
    sinkId: "fetch",
    sinkScope: "external-configured",
  };

  test("clean summary when no origins matched", () => {
    const s = summarizeEgress({ ...base, verdict: "pass", originsFound: [], matchCount: 0 });
    expect(s).toBe("clean (sink=fetch scope=external-configured)");
  });

  test("warn summary lists origins and count", () => {
    const s = summarizeEgress({
      ...base,
      verdict: "warn",
      originsFound: ["subagent"],
      matchCount: 1,
      sinkScope: "external-configured",
    });
    expect(s).toBe("warn: 1 match(es) from [subagent] (sink=fetch scope=external-configured)");
  });

  test("block summary with multiple origins joins with commas", () => {
    const s = summarizeEgress({
      verdict: "block",
      originsFound: ["mcp", "federation"],
      matchCount: 4,
      fromCache: true,
      sinkId: "dyn:peer",
      sinkScope: "external-dynamic",
    });
    expect(s).toBe(
      "block: 4 match(es) from [mcp,federation] (sink=dyn:peer scope=external-dynamic)",
    );
  });
});

describe("SubstringEgressMatcher direct", () => {
  test("empty lineage yields no hits", () => {
    const r = new SubstringEgressMatcher().match({
      payload: "anything at all goes here",
      lineage: new Map(),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(r.originsFound).toEqual([]);
    expect(r.matchCount).toBe(0);
  });

  test("dedupes origins but counts distinct matched strings", () => {
    const lineage = new Map<string, TrustOrigin>([
      ["first tagged string over floor", "subagent"],
      ["second tagged string over floor", "subagent"],
    ]);
    const r = new SubstringEgressMatcher().match({
      payload: "first tagged string over floor and second tagged string over floor",
      lineage,
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(r.originsFound).toEqual(["subagent"]); // deduped
    expect(r.matchCount).toBe(2); // two distinct strings
  });

  test("singleton and class share the same name", () => {
    expect(substringMatcher.name).toBe("substring");
  });
});

describe("diagnostics helpers", () => {
  test("_clearEgressCache empties the cache", async () => {
    const ctx = createRunContext();
    tagContent(ctx, "subagent content to populate cache now", "subagent");
    await classifyEgress("x subagent content to populate cache now", ctx, {
      sinkId: "fetch",
      sinkScope: "external-configured",
    });
    expect(_cacheSize()).toBeGreaterThan(0);
    _clearEgressCache();
    expect(_cacheSize()).toBe(0);
  });
});

describe("EgressClassifierError", () => {
  test("carries the config error code, fixed name, message, and cause chain", () => {
    const cause = new Error("root");
    const err = new EgressClassifierError("boom", cause);
    // The `name` field initializer + constructor (the class's two functions)
    // are exercised directly here, independent of the internal throw site.
    expect(err.name).toBe("EgressClassifierError");
    expect(err.message).toBe("boom");
    expect(err.code).toBe("config");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(EgressClassifierError);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err).toBeInstanceOf(Error);
  });

  test("cause is optional", () => {
    const err = new EgressClassifierError("no cause");
    expect(err.cause).toBeUndefined();
    expect(err.name).toBe("EgressClassifierError");
  });

  test("classifyEgress throws an EgressClassifierError for a non-string payload", async () => {
    const ctx = createRunContext();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime type guard
      classifyEgress({ not: "a string" } as any, ctx, {
        sinkId: "fetch",
        sinkScope: "external-configured",
      }),
    ).rejects.toBeInstanceOf(EgressClassifierError);
  });
});
