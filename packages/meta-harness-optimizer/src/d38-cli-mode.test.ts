/**
 * D38 (Evals Wave 5, cluster O) — the CLI-mode additions to the §56 provider:
 * an honestly-named candidate artifact, the proposer's optimizer-state second
 * argument, and the token-usage / pricing metadata the orchestrator's FR-003
 * budget gate feature-detects.
 *
 * Everything here is additive: the pre-D38 two-argument constructor and the
 * one-argument proposer keep working unchanged, which the first block pins.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OptimizerState } from "@crewhaus/prompt-optimizer";
import {
  MetaHarnessMutationProvider,
  type ProposerFn,
  persistCandidate,
  readExperienceStore,
} from "./index";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meta-harness-d38-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const STATE: OptimizerState = {
  iteration: 3,
  best: { id: "candidate-2", prompt: "current best prompt", mutations: [], score: 0.6 },
  bestGrades: [{ input: "q", score: 0.2, rationale: "no source cited" }],
  trajectory: [],
  trainSet: [],
  devSet: [],
};

describe("persistCandidate({ candidateFileName })", () => {
  test("defaults to agent.ts — the bundle-rewriting mode is untouched", () => {
    const rec = persistCandidate({
      rootDir: dir,
      candidateId: "candidate_000",
      bundleSource: "// bundle",
      scores: { s1: 1 },
      traceLines: [],
    });
    expect(rec.bundlePath.endsWith(join("bundle", "agent.ts"))).toBe(true);
    expect(readExperienceStore(dir).records[0]?.bundlePath).toBe(rec.bundlePath);
  });

  test("names the artifact honestly in the CLI's spec-shaped mode, and the store reads it back", () => {
    const rec = persistCandidate({
      rootDir: dir,
      candidateId: "candidate_001",
      bundleSource: "You are a careful assistant.",
      candidateFileName: "instructions.txt",
      scores: { s1: 0.5, s2: 1 },
      traceLines: [JSON.stringify({ sampleId: "s1", score: 0.5 })],
    });
    expect(rec.bundlePath.endsWith(join("bundle", "instructions.txt"))).toBe(true);
    expect(existsSync(rec.bundlePath)).toBe(true);
    expect(readFileSync(rec.bundlePath, "utf-8")).toBe("You are a careful assistant.");
    // Mean of the numeric scores.
    expect(rec.aggregateScore).toBeCloseTo(0.75, 6);

    const summary = readExperienceStore(dir);
    expect(summary.candidateCount).toBe(1);
    // The store resolves the REAL file name — a hardcoded agent.ts here would
    // hand the proposer a path that does not exist.
    expect(summary.records[0]?.bundlePath).toBe(rec.bundlePath);
    expect(summary.bestCandidate?.candidateId).toBe("candidate_001");
  });
});

describe("MetaHarnessMutationProvider — D38 seams", () => {
  test("passes the optimizer state to the proposer and threads its usage through", async () => {
    persistCandidate({
      rootDir: dir,
      candidateId: "candidate_000",
      bundleSource: "seed",
      candidateFileName: "instructions.txt",
      scores: { s1: 0.4 },
      traceLines: [],
    });
    let seenState: OptimizerState | undefined;
    let seenCount = -1;
    const proposer: ProposerFn = async (summary, state) => {
      seenState = state;
      seenCount = summary.candidateCount;
      return {
        bundleSource: "rewritten instructions",
        rationale: "targets the missing-source failure",
        usage: { input: 1200, output: 300, cacheRead: 50 },
      };
    };
    const provider = new MetaHarnessMutationProvider(dir, proposer, {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      maxOutputTokens: 2048,
      candidateFileName: "instructions.txt",
      estimateInputChars: (s) => s.best.prompt.length + 100,
    });

    // The pricing surface the orchestrator's budget gate feature-detects.
    expect(provider.name).toBe("meta-harness");
    expect(provider.providerId).toBe("anthropic");
    expect(provider.modelId).toBe("claude-sonnet-4-5");
    expect(provider.maxOutputTokens).toBe(2048);
    expect(provider.candidateFileName).toBe("instructions.txt");
    expect(provider.estimateInputChars(STATE)).toBe("current best prompt".length + 100);

    const mutation = await provider.next(STATE);
    expect(seenCount).toBe(1);
    expect(seenState?.best.prompt).toBe("current best prompt");
    expect(seenState?.bestGrades?.[0]?.rationale).toBe("no source cited");
    expect(mutation.prompt).toBe("rewritten instructions");
    expect(mutation.usage).toEqual({ input: 1200, output: 300, cacheRead: 50 });
    expect(mutation.rationale).toContain("meta-harness iter 1");
  });

  test("a proposer with no pricing metadata leaves the gate unpriced (pre-D38 behaviour)", async () => {
    const provider = new MetaHarnessMutationProvider(dir, async () => ({
      bundleSource: "// bundle",
      rationale: "deterministic",
    }));
    expect(provider.modelId).toBeUndefined();
    expect(provider.providerId).toBeUndefined();
    expect(provider.maxOutputTokens).toBeUndefined();
    expect(provider.candidateFileName).toBe("agent.ts");
    expect(provider.estimateInputChars(STATE)).toBeUndefined();
    const mutation = await provider.next(STATE);
    // No usage reported ⇒ the meter never accumulates ⇒ the budget gate is
    // inert, exactly as it is for the rule-based provider.
    expect(mutation.usage).toBeUndefined();
  });
});
