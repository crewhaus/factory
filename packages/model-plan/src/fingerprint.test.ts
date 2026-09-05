import { describe, expect, test } from "bun:test";
import { canonicalJson, fnv1a64, planFingerprint, profileFingerprint } from "./fingerprint";

describe("canonicalJson", () => {
  test("sorts keys at every depth, drops undefined, keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("planFingerprint", () => {
  test("is stable across key order and process boundaries", () => {
    const a = planFingerprint({ policy: "learned", candidates: [{ model: "x", tags: ["cheap"] }] });
    const b = planFingerprint({ candidates: [{ tags: ["cheap"], model: "x" }], policy: "learned" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("changes when ANY setting, rule or strategy changes (not just the roster)", () => {
    const base = {
      policy: "heuristic",
      candidates: [{ model: "x", tags: ["cheap"], maxTokens: 4096 }],
      rules: [{ id: "r", when: { has_images: true }, use: "strong", enabled: true }],
      strategy: { cascade: { draft: "cheap", escalate_to: "strong" } },
      reward: { quality_source: "none" },
    };
    const fp = planFingerprint(base);
    expect(
      planFingerprint({ ...base, candidates: [{ ...base.candidates[0], maxTokens: 2048 }] }),
    ).not.toBe(fp);
    expect(planFingerprint({ ...base, rules: [{ ...base.rules[0], enabled: false }] })).not.toBe(
      fp,
    );
    expect(planFingerprint({ ...base, strategy: {} })).not.toBe(fp);
    expect(planFingerprint({ ...base, reward: { quality_source: "in_loop" } })).not.toBe(fp);
    // array ORDER matters (declared order is routing semantics)
    expect(
      planFingerprint({ ...base, candidates: [...base.candidates, { model: "y", tags: [] }] }),
    ).not.toBe(
      planFingerprint({ ...base, candidates: [{ model: "y", tags: [] }, ...base.candidates] }),
    );
  });

  test("profileFingerprint is the same function over one profile", () => {
    expect(profileFingerprint({ model: "x" })).toBe(planFingerprint({ model: "x" }));
  });
});

describe("fnv1a64", () => {
  test("known vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });
});
