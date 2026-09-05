/**
 * N2 eval-seeded priors (§7.11): validated, fingerprint-checked, pseudo-count
 * capped, never applied when stale or malformed.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PRIOR_PSEUDO_COUNT,
  blendPrior,
  loadPriors,
  priorKey,
  priorsFingerprint,
  seededScoreLookup,
} from "./priors";

const GOOD = {
  version: 1,
  fingerprint: "abc123",
  generatedAt: "2026-09-01T00:00:00Z",
  arms: [
    { routeKey: "easy", arm: "fast", n: 40, meanReward: 0.82, varReward: 0.01 },
    { routeKey: "hard", arm: "strong", n: 4, meanReward: 0.91 },
  ],
};

describe("loadPriors", () => {
  test("accepts a well-formed file, caps the pseudo-count, keys routeKey|arm", () => {
    const r = loadPriors(GOOD, { expectFingerprint: "abc123" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.priors.fingerprint).toBe("abc123");
    expect(r.priors.arms.get(priorKey("easy", "fast"))).toEqual({
      n: MAX_PRIOR_PSEUDO_COUNT,
      meanReward: 0.82,
      varReward: 0.01,
    });
    expect(r.priors.arms.get("hard|strong")).toEqual({ n: 4, meanReward: 0.91 });
    expect(r.priors.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a stale fingerprint is refused with a re-run hint", () => {
    const r = loadPriors(GOOD, { expectFingerprint: "zzz" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("fingerprint-stale");
    expect(r.detail).toContain("--export-priors");
  });

  test("without an expected fingerprint the file's own is accepted", () => {
    expect(loadPriors(GOOD).ok).toBe(true);
  });

  test("malformed shapes are refused, never partially applied", () => {
    const cases: unknown[] = [
      null,
      [],
      "x",
      { version: 1, arms: [] },
      { version: 1, fingerprint: "f" },
      { version: 1, fingerprint: "f", arms: [{ routeKey: "a" }] },
      { version: 1, fingerprint: "f", arms: [{ routeKey: "a", arm: "b", n: -1, meanReward: 0.5 }] },
      { version: 1, fingerprint: "f", arms: [{ routeKey: "a", arm: "b", n: 1, meanReward: 1.5 }] },
      {
        version: 1,
        fingerprint: "f",
        arms: [{ routeKey: "a", arm: "b", n: 1, meanReward: 0.5, varReward: -1 }],
      },
      {
        version: 1,
        fingerprint: "f",
        arms: [
          { routeKey: "a", arm: "b", n: 1, meanReward: 0.5 },
          { routeKey: "a", arm: "b", n: 2, meanReward: 0.6 },
        ],
      },
    ];
    for (const c of cases) {
      const r = loadPriors(c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("malformed");
    }
  });

  test("an unsupported version is its own reason", () => {
    const r = loadPriors({ ...GOOD, version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported-version");
  });
});

describe("seededScoreLookup", () => {
  test("unseen arms read their prior; an arm with no prior passes through; no priors → live passthrough", () => {
    const loaded = loadPriors(GOOD);
    if (!loaded.ok) throw new Error("expected ok");
    const live = (routeKey: string, arm: string) =>
      routeKey === "easy" && arm === "strong" ? { n: 3, meanReward: 0.5 } : undefined;
    const seeded = seededScoreLookup(live, loaded.priors);
    // No prior for easy|strong → the live score, untouched.
    expect(seeded("easy", "strong")).toEqual({ n: 3, meanReward: 0.5 });
    // A prior stands in for the missing live history and is marked `seeded`
    // so the router skips warm-up for it (its pseudo-count sits under the floor).
    expect(seeded("hard", "strong")).toEqual({ n: 4, meanReward: 0.91, seeded: true });
    expect(seeded("hard", "fast")).toBeUndefined();
    expect(seededScoreLookup(live, undefined)).toBe(live);
  });

  test("a live arm with a prior reads the BLEND, still marked seeded, so one live observation does not re-open warm-up", () => {
    const loaded = loadPriors(GOOD);
    if (!loaded.ok) throw new Error("expected ok");
    // One live observation on hard|strong (prior n=4, mean 0.91).
    const seeded = seededScoreLookup(
      (rk, arm) =>
        rk === "hard" && arm === "strong"
          ? { n: 1, meanReward: 0.5, varReward: 0, meanQuality: 0.7, qualityCount: 1 }
          : undefined,
      loaded.priors,
    );
    const s = seeded("hard", "strong");
    expect(s?.seeded).toBe(true);
    expect(s?.n).toBe(5);
    expect(s?.meanReward).toBeCloseTo((4 * 0.91 + 0.5) / 5, 10);
    // Live-only fields (judged quality) pass through untouched.
    expect(s).toMatchObject({ meanQuality: 0.7, qualityCount: 1 });
    // The prior fades: after many live observations the pooled mean sits at the live mean.
    const many = seededScoreLookup(
      () => ({ n: 1000, meanReward: 0.5, varReward: 0.01 }),
      loaded.priors,
    )("hard", "strong");
    expect(many?.n).toBe(1004);
    expect(many?.meanReward).toBeCloseTo(0.5, 2);
    expect(many?.seeded).toBe(true);
  });

  test("blendPrior is the Chan parallel combine: pooled count, weighted mean, pooled variance", () => {
    // prior: {0.8, 0.8, 1.0} → n=3, mean 0.8667, var 0.01333; live: {0.2, 0.4} → n=2, mean 0.3, var 0.02
    const prior = { n: 3, meanReward: 0.8666666666666667, varReward: 0.013333333333333334 };
    const live = { n: 2, meanReward: 0.3, varReward: 0.02 };
    const b = blendPrior(prior, live);
    expect(b.n).toBe(5);
    expect(b.meanReward).toBeCloseTo(0.64, 10);
    // Sample variance of {0.8, 0.8, 1.0, 0.2, 0.4} = 0.108
    expect(b.varReward).toBeCloseTo(0.108, 10);
    // Missing variances count as zero spread; n=1 each → var is just the between-means term.
    const one = blendPrior({ n: 1, meanReward: 1 }, { n: 1, meanReward: 0 });
    expect(one).toEqual({ n: 2, meanReward: 0.5, varReward: 0.5 });
    expect(blendPrior({ n: 0, meanReward: 0 }, { n: 0, meanReward: 0 })).toEqual({
      n: 0,
      meanReward: 0,
      varReward: 0,
    });
  });

  test("priorsFingerprint keys on the roster alone: a rules/learning edit keeps it, a candidate edit changes it", () => {
    const roster = [
      { model: "claude-haiku-4-5", tags: ["cheap"], profile: "fast" },
      { model: "claude-opus-4-8", tags: ["strong"], profile: "strong" },
    ];
    const a = priorsFingerprint(roster);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    // Same roster, spelled with a different key order → same fingerprint.
    expect(
      priorsFingerprint([
        { profile: "fast", tags: ["cheap"], model: "claude-haiku-4-5" },
        { tags: ["strong"], model: "claude-opus-4-8", profile: "strong" },
      ]),
    ).toBe(a);
    expect(priorsFingerprint([roster[0], { ...roster[1], maxTokens: 2048 }])).not.toBe(a);
    expect(priorsFingerprint([roster[0], { ...roster[1], enabled: false }])).not.toBe(a);
  });

  test("a live arm with n=0 still reads its prior", () => {
    const loaded = loadPriors(GOOD);
    if (!loaded.ok) throw new Error("expected ok");
    const seeded = seededScoreLookup(() => ({ n: 0, meanReward: 0 }), loaded.priors);
    expect(seeded("hard", "strong")?.meanReward).toBe(0.91);
  });
});
