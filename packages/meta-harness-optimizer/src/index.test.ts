import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  MetaHarnessError,
  MetaHarnessMutationProvider,
  ensureExperienceStore,
  formatBreakingChangeHeader,
  persistCandidate,
  readExperienceStore,
} from "./index";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meta-harness-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureExperienceStore", () => {
  test("creates the experience subdirectory if absent", () => {
    const abs = ensureExperienceStore(dir);
    expect(abs).toBe(dir);
    // Calling again is idempotent.
    expect(() => ensureExperienceStore(dir)).not.toThrow();
  });
});

describe("persistCandidate + readExperienceStore", () => {
  test("a persisted candidate appears in the store summary", () => {
    persistCandidate({
      rootDir: dir,
      candidateId: "candidate_000",
      bundleSource: "// hello world",
      scores: { acc: 0.7, latency: 0.5 },
      traceLines: ['{"kind":"start"}', '{"kind":"end"}'],
    });
    const summary = readExperienceStore(dir);
    expect(summary.candidateCount).toBe(1);
    expect(summary.records[0]?.candidateId).toBe("candidate_000");
    expect(summary.bestCandidate?.candidateId).toBe("candidate_000");
    expect(summary.bestCandidate?.aggregateScore).toBeCloseTo(0.6, 5);
  });

  test("best and worst track aggregate score across multiple candidates", () => {
    persistCandidate({
      rootDir: dir,
      candidateId: "c_a",
      bundleSource: "// a",
      scores: { acc: 0.5 },
      traceLines: [],
    });
    persistCandidate({
      rootDir: dir,
      candidateId: "c_b",
      bundleSource: "// b",
      scores: { acc: 0.9 },
      traceLines: [],
    });
    persistCandidate({
      rootDir: dir,
      candidateId: "c_c",
      bundleSource: "// c",
      scores: { acc: 0.2 },
      traceLines: [],
    });
    const summary = readExperienceStore(dir);
    expect(summary.candidateCount).toBe(3);
    expect(summary.bestCandidate?.candidateId).toBe("c_b");
    expect(summary.worstCandidate?.candidateId).toBe("c_c");
  });

  test("readExperienceStore returns empty summary when dir is missing", () => {
    const summary = readExperienceStore(join(dir, "does-not-exist"));
    expect(summary.candidateCount).toBe(0);
    expect(summary.records.length).toBe(0);
    expect(summary.bestCandidate).toBeUndefined();
  });
});

describe("formatBreakingChangeHeader", () => {
  test("starts with the warning marker", () => {
    const h = formatBreakingChangeHeader({
      runId: "opt_abc",
      proposerName: "claude-code-sdk",
      iterationsRun: 5,
      bestAggregateScore: 0.812,
    });
    expect(h).toMatch(/^\/\/ ⚠ meta-harness-optimizer/);
    expect(h).toContain("opt_abc");
    expect(h).toContain("claude-code-sdk");
    expect(h).toContain("0.812");
  });
});

describe("MetaHarnessError", () => {
  // Exported structured-error type for callers that wrap meta-harness failures
  // (e.g. a proposer that cannot write the experience store). Nothing in the
  // pure adapter throws it today, so assert its public contract directly: the
  // typed `code`, stable `name`, message, cause chaining, and toJSON() output.
  test("carries the 'compiler' code, stable name, and message", () => {
    const err = new MetaHarnessError("experience store is unwritable");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err).toBeInstanceOf(MetaHarnessError);
    expect(err.name).toBe("MetaHarnessError");
    expect(err.code).toBe("compiler");
    expect(err.message).toBe("experience store is unwritable");
  });

  test("preserves the cause and serializes the chain via toJSON()", () => {
    const cause = new Error("ENOSPC: no space left on device");
    const err = new MetaHarnessError("failed to persist candidate", cause);
    expect(err.cause).toBe(cause);
    expect(err.toJSON()).toEqual({
      name: "MetaHarnessError",
      code: "compiler",
      message: "failed to persist candidate",
      cause: { name: "Error", message: "ENOSPC: no space left on device" },
    });
  });
});

describe("MetaHarnessMutationProvider", () => {
  test("invokes proposer with the experience-store summary", async () => {
    persistCandidate({
      rootDir: dir,
      candidateId: "seed",
      bundleSource: "// seed",
      scores: { acc: 0.5 },
      traceLines: [],
    });
    let seenCount = -1;
    const provider = new MetaHarnessMutationProvider(dir, async (s) => {
      seenCount = s.candidateCount;
      return { bundleSource: "// new bundle", rationale: "test" };
    });
    const mutation = await provider.next({
      iteration: 1,
      best: { id: "x", prompt: "x", mutations: [], score: 0 },
      trajectory: [],
      trainSet: [],
      devSet: [],
    });
    expect(seenCount).toBe(1);
    expect(mutation.prompt).toBe("// new bundle");
    expect(mutation.rationale).toContain("test");
  });
});
