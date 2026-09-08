/**
 * 0.6.0 §9.1 (loop 1) — `crewhaus route propose`.
 *
 * The load-bearing assertion is the negative one: every patch this verb emits
 * survives `validatePatch`, and a patch on a roster or identity path is
 * HARD-REFUSED by the whitelist rather than quietly proposed (acceptance item
 * 10 of §1's scenario). The positive assertions pin the two mining rules and
 * the separation bar that keeps a policy flip off noise.
 */
import { describe, expect, test } from "bun:test";
import type { ArmStats } from "@crewhaus/routing-store";
import { parseSpec } from "@crewhaus/spec";
import { validatePatch } from "@crewhaus/spec-patch";
import {
  bandSeparation,
  buildRouteProposals,
  formatRouteProposals,
  routeSuggestionsFile,
} from "./route-propose";

function arm(over: Partial<ArmStats> & { routeKey: string; model: string; n: number }): ArmStats {
  return {
    meanReward: 0.5,
    varReward: 0.001,
    meanLatencyMs: 100,
    meanCostUsd: 0.001,
    costCount: over.n,
    meanQuality: 0,
    varQuality: 0,
    qualityCount: 0,
    ungraded: 0,
    ...over,
  };
}

const POOL_YAML = `
name: pooled
target: cli
agent:
  model: claude-haiku-4-5
  instructions: hi
  model_pool:
    candidates:
      - { model: claude-haiku-4-5, tags: [cheap] }
      - { model: claude-opus-5,    tags: [strong] }
    policy: heuristic
    learning: { minSamplesPerArm: 10, seed: "s1" }
`;

const LEARNED_YAML = POOL_YAML.replace("policy: heuristic", "policy: learned");

/** A clearly separated band: the leader's lower bound clears the runner-up. */
const SEPARATED: ArmStats[] = [
  arm({ routeKey: "hard", model: "claude-opus-5", n: 200, meanReward: 0.9, varReward: 0.001 }),
  arm({ routeKey: "hard", model: "claude-haiku-4-5", n: 200, meanReward: 0.4 }),
];

/** Covered but not separated: overlapping intervals. */
const OVERLAPPING: ArmStats[] = [
  arm({ routeKey: "hard", model: "claude-opus-5", n: 30, meanReward: 0.55, varReward: 0.4 }),
  arm({ routeKey: "hard", model: "claude-haiku-4-5", n: 30, meanReward: 0.5, varReward: 0.4 }),
];

describe("route propose", () => {
  test("proposes the learned flip only when the band's leader is SEPARATED", () => {
    const spec = parseSpec(POOL_YAML);
    const ready = buildRouteProposals({ spec, arms: SEPARATED });
    expect(ready.proposals.map((p) => p.id)).toContain("route-policy-flip");
    const flip = ready.proposals.find((p) => p.id === "route-policy-flip");
    expect(flip?.patch.path).toEqual(["agent", "model_pool", "policy"]);
    expect(flip?.patch.value).toBe("learned");

    const noisy = buildRouteProposals({ spec, arms: OVERLAPPING });
    expect(noisy.proposals.map((p) => p.id)).not.toContain("route-policy-flip");
    expect(noisy.skipped.map((s) => s.reason).join(" ")).toContain("exploit noise");
  });

  test("every emitted patch passes validatePatch — the whitelist is the floor", () => {
    const spec = parseSpec(POOL_YAML);
    const result = buildRouteProposals({ spec, arms: SEPARATED });
    expect(result.proposals.length).toBeGreaterThan(0);
    for (const p of result.proposals) {
      expect(() => validatePatch(spec, p.patch)).not.toThrow();
    }
  });

  test("a roster or identity path HARD-FAILS validatePatch, so it can never be proposed", () => {
    const spec = parseSpec(POOL_YAML);
    for (const path of [
      ["agent", "model"],
      ["agent", "model_pool", "candidates"],
      ["agent", "model_pool", "candidates", "0", "model"],
      ["agent", "model_pool", "reward", "floor", "arm"],
      ["agent", "model_pool", "rules", "0", "use"],
      ["agent", "model_pool", "classifier", "model"],
    ]) {
      expect(() =>
        validatePatch(spec, { target: "cli", path, op: "replace", value: "anything" }),
      ).toThrow();
    }
  });

  test("adds an exploration floor to a converged learned pool, PRESERVING the pinned seed", () => {
    const spec = parseSpec(LEARNED_YAML);
    const result = buildRouteProposals({ spec, arms: SEPARATED });
    const floor = result.proposals.find((p) => p.id === "route-exploration-floor");
    expect(floor?.patch.path).toEqual(["agent", "model_pool", "learning"]);
    // The seed rides along — dropping it would silently re-randomize the very
    // lineage a routed eval pins.
    expect(floor?.patch.value).toMatchObject({ seed: "s1", explorationRate: 0.05 });
  });

  test("proposes nothing for a pool-less spec, and says why", () => {
    const spec = parseSpec(
      "name: bare\ntarget: cli\nagent:\n  model: claude-opus-5\n  instructions: hi\n",
    );
    const result = buildRouteProposals({ spec, arms: SEPARATED });
    expect(result.proposals).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("no `agent.model_pool`");
  });

  test("an observe-only lane never justifies a live policy change on its own", () => {
    const spec = parseSpec(POOL_YAML);
    const laneOnly = SEPARATED.map((a) => ({ ...a, routeKey: `shadow:${a.routeKey}` }));
    const result = buildRouteProposals({ spec, arms: laneOnly });
    expect(result.proposals.map((p) => p.id)).not.toContain("route-policy-flip");
    expect(result.skipped.map((s) => s.id)).toContain("no-arms");
  });

  test("winds the audition down once the shadow lane clears the power floor", () => {
    const withShadow = parseSpec(
      `${POOL_YAML}    strategy:\n      shadow: { candidate: claude-sonnet-4-5, sample_rate: 0.1 }\n`,
    );
    const arms = [
      ...SEPARATED,
      arm({ routeKey: "shadow:hard", model: "claude-sonnet-4-5", n: 40, meanReward: 0.8 }),
    ];
    const result = buildRouteProposals({ spec: withShadow, arms });
    const windDown = result.proposals.find((p) => p.id === "route-audition-wind-down");
    expect(windDown?.patch.path).toEqual([
      "agent",
      "model_pool",
      "strategy",
      "shadow",
      "sample_rate",
    ]);
    expect(windDown?.patch.value).toBe(0);
  });

  test("rule toggles are deferred to `advise`, with the reason stated", () => {
    const withRules = parseSpec(
      `${POOL_YAML}    rules:\n      - { id: images-need-vision, when: { has_images: true }, use: strong }\n`,
    );
    const result = buildRouteProposals({ spec: withRules, arms: SEPARATED });
    const skip = result.skipped.find((s) => s.id === "route-rule-hygiene");
    expect(skip?.reason).toContain("model_route.ruleId");
    expect(skip?.reason).toContain("crewhaus advise");
  });

  test("the suggestions file is the shape `optimize --from-advice` parses", () => {
    const spec = parseSpec(POOL_YAML);
    const file = routeSuggestionsFile(
      buildRouteProposals({ spec, arms: SEPARATED }),
      "2026-09-07T00:00:00.000Z",
    );
    expect(file.generatedAt).toBe("2026-09-07T00:00:00.000Z");
    expect(file.suggestions.length).toBeGreaterThan(0);
    for (const s of file.suggestions) {
      expect(typeof s.findingId).toBe("string");
      expect(Array.isArray(s.patch.path)).toBe(true);
      expect(["replace", "add", "remove"]).toContain(s.patch.op);
    }
  });

  test("the human report names the eval-gating command, never an apply", () => {
    const spec = parseSpec(POOL_YAML);
    const text = formatRouteProposals(
      buildRouteProposals({ spec, arms: SEPARATED }),
      "/tmp/suggestions.json",
    );
    expect(text).toContain("Nothing is applied");
    expect(text).toContain("--from-advice");
    expect(text).toContain("--routing as-declared");
    // The write-back it names is the FROM-ADVICE one, which runs only after
    // the gate holds — this verb itself writes nothing but the bundle.
    expect(text).toContain("accepted only if the gate holds");
    expect(text).not.toContain("applied ");
  });

  test("bandSeparation needs two measured arms", () => {
    expect(bandSeparation([SEPARATED[0] as ArmStats], "hard")).toBeUndefined();
    expect(bandSeparation(SEPARATED, "hard")?.separated).toBe(true);
    expect(bandSeparation(OVERLAPPING, "hard")?.separated).toBe(false);
  });
});
