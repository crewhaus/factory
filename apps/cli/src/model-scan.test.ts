/**
 * Item 24 — model-scan / doctor --models / pricing-sync tests.
 */
import { describe, expect, test } from "bun:test";
import type { PricingTable } from "@crewhaus/cost-tracker";
import {
  type ScanCell,
  buildMarketScan,
  buildModelChecks,
  buildProposalArtifact,
  buildScanCandidates,
  parsedModelForTables,
  pricingFeedPath,
  writeModelField,
} from "./model-scan";

const PRICING: PricingTable = {
  version: "2026-05-08",
  providers: {
    anthropic: {
      "claude-opus-4": { inputPer1M: 15, outputPer1M: 75 },
      "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
      "claude-haiku-4": { inputPer1M: 1, outputPer1M: 5 },
    },
  },
};

describe("parsedModelForTables", () => {
  test("maps claude-* to anthropic", () => {
    expect(parsedModelForTables("claude-opus-4-7")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
    });
  });
  test("maps openai/* to openai", () => {
    expect(parsedModelForTables("openai/gpt-4o")).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
  });
  test("skips local/azure/named-host (not in pricing table)", () => {
    expect(parsedModelForTables("local/llama3.2@http://localhost:11434/v1")).toBeUndefined();
    expect(parsedModelForTables("azure/my-deployment")).toBeUndefined();
    expect(parsedModelForTables("groq/llama-3.3-70b")).toBeUndefined();
  });
  test("skips unparseable strings", () => {
    expect(parsedModelForTables("nonsense-model")).toBeUndefined();
  });
});

describe("buildScanCandidates", () => {
  test("enumerates cheaper same-provider siblings, current excluded, cheapest-first", () => {
    const cands = buildScanCandidates("claude-opus-4-7", {
      pricing: PRICING,
      sameProviderOnly: true,
    });
    expect(cands).toEqual(["claude-haiku-4", "claude-sonnet-4"]);
  });
  test("respects the limit", () => {
    const cands = buildScanCandidates("claude-opus-4-7", {
      pricing: PRICING,
      sameProviderOnly: true,
      limit: 1,
    });
    expect(cands).toHaveLength(1);
    expect(cands[0]).toBe("claude-haiku-4");
  });
  test("empty for a model outside the pricing table", () => {
    expect(buildScanCandidates("local/llama@http://x/v1", { pricing: PRICING })).toEqual([]);
  });
});

describe("buildMarketScan", () => {
  const cells: ScanCell[] = [
    { model: "claude-opus-4-7", meanScore: 0.8, costPer1kSamplesUsd: 0.5 },
    { model: "claude-sonnet-4", meanScore: 0.82, costPer1kSamplesUsd: 0.1 }, // better + cheaper
    { model: "claude-haiku-4", meanScore: 0.6, costPer1kSamplesUsd: 0.03 }, // cheaper but worse
  ];

  test("recommends the candidate that beats current on score at lower cost", () => {
    const scan = buildMarketScan("claude-opus-4-7", cells);
    const sonnet = scan.proposals.find((p) => p.candidateModel === "claude-sonnet-4");
    expect(sonnet?.recommended).toBe(true);
    const haiku = scan.proposals.find((p) => p.candidateModel === "claude-haiku-4");
    expect(haiku?.recommended).toBe(false);
    expect(haiku?.reason).toContain("score dropped");
    expect(scan.best?.candidateModel).toBe("claude-sonnet-4");
  });

  test("no recommendation when no candidate holds score AND is cheaper", () => {
    const scan = buildMarketScan("claude-opus-4-7", [
      { model: "claude-opus-4-7", meanScore: 0.8, costPer1kSamplesUsd: 0.5 },
      { model: "claude-haiku-4", meanScore: 0.6, costPer1kSamplesUsd: 0.03 },
    ]);
    expect(scan.best).toBeUndefined();
  });

  test("errored candidate cell becomes a non-recommended proposal", () => {
    const scan = buildMarketScan("claude-opus-4-7", [
      { model: "claude-opus-4-7", meanScore: 0.8, costPer1kSamplesUsd: 0.5 },
      { model: "claude-sonnet-4", error: "all samples errored" },
    ]);
    const p = scan.proposals[0];
    expect(p?.recommended).toBe(false);
    expect(p?.reason).toContain("cell errored");
  });

  test("pricing miss (unknown cost) blocks a recommendation", () => {
    const scan = buildMarketScan("claude-opus-4-7", [
      { model: "claude-opus-4-7", meanScore: 0.8, costPer1kSamplesUsd: 0.5 },
      { model: "claude-sonnet-4", meanScore: 0.9 }, // no cost
    ]);
    expect(scan.proposals[0]?.recommended).toBe(false);
    expect(scan.proposals[0]?.reason).toContain("cost unknown");
  });

  test("buildProposalArtifact emits an agent.model replace patch", () => {
    const scan = buildMarketScan("claude-opus-4-7", cells);
    const artifact = buildProposalArtifact(scan, () => new Date("2026-07-02T00:00:00Z"));
    expect(artifact?.kind).toBe("model-scan-proposal");
    expect(artifact?.recommendedModel).toBe("claude-sonnet-4");
    expect(artifact?.patch).toEqual({
      op: "replace",
      path: ["agent", "model"],
      value: "claude-sonnet-4",
    });
  });
});

describe("buildModelChecks (doctor --models)", () => {
  test("flags a model missing from the pricing table", () => {
    const checks = buildModelChecks("claude-unknownium-9", {
      pricing: PRICING,
      now: new Date("2026-06-01"),
    });
    const pricing = checks.find((c) => c.label.includes("pricing"));
    expect(pricing?.pass).toBe(false);
    expect(pricing?.reason).toContain("no pricing row");
  });

  test("passes for a priced model", () => {
    const checks = buildModelChecks("claude-opus-4-7", {
      pricing: PRICING,
      now: new Date("2026-06-01"),
    });
    expect(checks.find((c) => c.label.includes("agent.model pricing"))?.pass).toBe(true);
  });

  test("warns (not fails) for local/named-host models billed $0", () => {
    const checks = buildModelChecks("local/llama@http://x/v1", {
      pricing: PRICING,
      now: new Date("2026-06-01"),
    });
    const c = checks.find((c) => c.label.includes("pricing"));
    expect(c?.pass).toBe(true);
    expect(c?.warn).toBe(true);
    expect(c?.reason).toContain("outside the pricing table");
  });

  test("flags a known-sunset model with its replacement", () => {
    const checks = buildModelChecks("claude-3-5-haiku", {
      pricing: {
        version: "2026-05-08",
        providers: { anthropic: { "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4 } } },
      },
      now: new Date("2026-06-01"),
    });
    const sunset = checks.find((c) => c.label.includes("sunset"));
    expect(sunset?.warn).toBe(true);
    expect(sunset?.reason).toContain("claude-haiku-4-5");
  });

  test("warns when the pricing table is stale", () => {
    const checks = buildModelChecks("claude-opus-4-7", {
      pricing: PRICING,
      now: new Date("2027-01-01"),
      maxAgeDays: 90,
    });
    const fresh = checks.find((c) => c.label.includes("freshness"));
    expect(fresh?.warn).toBe(true);
    expect(fresh?.reason).toContain("days old");
  });

  test("checks aux models (compaction / judge) too", () => {
    const checks = buildModelChecks("claude-opus-4-7", {
      pricing: PRICING,
      now: new Date("2026-06-01"),
      auxModels: [{ slot: "compaction.model", model: "claude-mystery-2" }],
    });
    const aux = checks.find((c) => c.label.includes("compaction.model"));
    expect(aux?.pass).toBe(false);
  });
});

describe("pricingFeedPath", () => {
  test("targets ~/.crewhaus/pricing/<version>.json", () => {
    expect(pricingFeedPath("/home/max", "2026-07-01")).toBe(
      "/home/max/.crewhaus/pricing/2026-07-01.json",
    );
  });
  test("sanitizes an unsafe version", () => {
    expect(pricingFeedPath("/home/max", "v1/../etc")).toBe(
      "/home/max/.crewhaus/pricing/v1_.._etc.json",
    );
  });
});

describe("writeModelField — direct comment-preserving CST edit", () => {
  const SPEC = `# my agent
name: concierge
target: cli
agent:
  model: claude-opus-4-7 # the primary
  instructions: |
    Be helpful.
`;

  test("rewrites agent.model preserving comments + structure", () => {
    const out = writeModelField(SPEC, "cli", ["agent", "model"], "claude-sonnet-4-5");
    expect(out).toContain("model: claude-sonnet-4-5");
    // Comments preserved.
    expect(out).toContain("# my agent");
    expect(out).toContain("# the primary");
    expect(out).toContain("Be helpful.");
    // Old value gone.
    expect(out).not.toContain("claude-opus-4-7");
  });

  test("an invalid resulting spec throws (re-parsed by applySpecPatch)", () => {
    // Empty model is rejected by the spec schema.
    expect(() => writeModelField(SPEC, "cli", ["agent", "model"], "")).toThrow();
  });
});
