import { describe, expect, test } from "bun:test";
import { OPTIMIZABLE_PATHS, applySpecPatch, formatWriteBackHeader, validatePatch } from "./index";

const CLI_YAML = `# A simple CLI agent
target: cli
name: hello-cli
agent:
  model: claude-sonnet-4-5
  # The system prompt the model sees on every turn:
  instructions: You are a helpful assistant.
tools:
  - Read
  - Write
`;

const PIPELINE_YAML = `target: pipeline
name: hello-rag
agent:
  model: claude-sonnet-4-5
  instructions: Answer using only the retrieved docs.
retrieve:
  embedderModel: text-embedding-3-small
  defaultK: 3
indexing:
  # Default chunking — deliberately short for testing
  chunkSize: 200
  chunkOverlap: 20
  documents:
    - id: doc1
      text: The capital of France is Paris.
`;

describe("applySpecPatch — round-trip", () => {
  test("replaces agent.instructions and re-parses", () => {
    const patch = {
      target: "cli" as const,
      path: ["agent", "instructions"] as const,
      op: "replace" as const,
      value: "Think step by step before answering.",
    };
    const { yaml, spec } = applySpecPatch(CLI_YAML, patch);
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.agent.instructions).toBe("Think step by step before answering.");
    expect(yaml).toContain("instructions: Think step by step before answering.");
  });

  test("preserves leading comments and structural comments", () => {
    const patch = {
      target: "cli" as const,
      path: ["agent", "instructions"] as const,
      op: "replace" as const,
      value: "Be concise.",
    };
    const { yaml } = applySpecPatch(CLI_YAML, patch);
    expect(yaml).toContain("# A simple CLI agent");
    expect(yaml).toContain("# The system prompt the model sees on every turn");
  });

  test("replaces a numeric field on a pipeline spec", () => {
    const patch = {
      target: "pipeline" as const,
      path: ["indexing", "chunkOverlap"] as const,
      op: "replace" as const,
      value: 50,
    };
    const { yaml, spec } = applySpecPatch(PIPELINE_YAML, patch);
    if (spec.target !== "pipeline") throw new Error("expected pipeline spec");
    expect(spec.indexing.chunkOverlap).toBe(50);
    expect(yaml).toContain("chunkOverlap: 50");
    // Comment on indexing block survives
    expect(yaml).toContain("# Default chunking — deliberately short for testing");
  });
});

describe("applySpecPatch — error cases", () => {
  test("cross-target patch is rejected with a clear error", () => {
    expect(() =>
      applySpecPatch(CLI_YAML, {
        target: "pipeline",
        path: ["agent", "instructions"],
        op: "replace",
        value: "x",
      }),
    ).toThrow(/does not match spec target/);
  });

  test("non-existent replace path is rejected", () => {
    expect(() =>
      applySpecPatch(CLI_YAML, {
        target: "cli",
        path: ["agent", "nonexistent_field"],
        op: "replace",
        value: "x",
      }),
    ).toThrow(/path does not exist/);
  });

  test("add to an existing path is rejected", () => {
    expect(() =>
      applySpecPatch(CLI_YAML, {
        target: "cli",
        path: ["agent", "instructions"],
        op: "add",
        value: "x",
      }),
    ).toThrow(/path already exists/);
  });

  test("remove a non-existent path is rejected", () => {
    expect(() =>
      applySpecPatch(CLI_YAML, {
        target: "cli",
        path: ["agent", "nope"],
        op: "remove",
      }),
    ).toThrow(/path does not exist/);
  });

  test("invalid patch shape (empty path array) is rejected", () => {
    expect(() =>
      applySpecPatch(CLI_YAML, {
        target: "cli",
        // biome-ignore lint/suspicious/noExplicitAny: testing runtime validation
        path: [] as any,
        op: "replace",
        value: "x",
      }),
    ).toThrow(/patch shape is invalid/);
  });

  test("patched YAML that breaks spec schema is rejected", () => {
    // Replacing model with a non-string number should be rejected.
    expect(() =>
      applySpecPatch(CLI_YAML, {
        target: "cli",
        path: ["agent", "model"],
        op: "replace",
        value: 42,
      }),
    ).toThrow(/spec validation failed/);
  });
});

describe("validatePatch", () => {
  test("accepts a whitelisted optimizable path", () => {
    const { spec } = applySpecPatch(PIPELINE_YAML, {
      target: "pipeline",
      path: ["indexing", "chunkOverlap"],
      op: "replace",
      value: 30,
    });
    expect(() =>
      validatePatch(spec, {
        target: "pipeline",
        path: ["indexing", "chunkOverlap"],
        op: "replace",
        value: 40,
      }),
    ).not.toThrow();
  });

  test("rejects a path that's not in OPTIMIZABLE_PATHS", () => {
    const { spec } = applySpecPatch(CLI_YAML, {
      target: "cli",
      path: ["agent", "instructions"],
      op: "replace",
      value: "x",
    });
    expect(() =>
      validatePatch(spec, {
        target: "cli",
        path: ["agent", "model"], // intentionally not in cli's OPTIMIZABLE_PATHS
        op: "replace",
        value: "opus-4",
      }),
    ).toThrow(/not listed in OPTIMIZABLE_PATHS/);
  });

  test("cross-target patch is rejected before path-check", () => {
    const { spec } = applySpecPatch(CLI_YAML, {
      target: "cli",
      path: ["agent", "instructions"],
      op: "replace",
      value: "x",
    });
    expect(() =>
      validatePatch(spec, {
        target: "pipeline",
        path: ["agent", "instructions"],
        op: "replace",
        value: "y",
      }),
    ).toThrow(/does not match spec target/);
  });
});

describe("OPTIMIZABLE_PATHS", () => {
  test("every shipped target shape has at least one whitelisted path", () => {
    const targets = [
      "cli",
      "workflow",
      "channel",
      "graph",
      "managed",
      "pipeline",
      "crew",
      "research",
      "batch",
      "voice",
      "browser",
      "eval",
    ] as const;
    for (const t of targets) {
      expect(OPTIMIZABLE_PATHS[t]).toBeDefined();
      expect(OPTIMIZABLE_PATHS[t].length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("formatWriteBackHeader", () => {
  test("produces a deterministic header given a fixed timestamp", () => {
    const header = formatWriteBackHeader({
      runId: "opt_abc123",
      mutator: "rule-based",
      scoreBefore: 0.45,
      scoreAfter: 0.78,
      iterations: 12,
      timestamp: "2026-05-10T12:00:00Z",
    });
    expect(header).toContain("runId opt_abc123");
    expect(header).toContain("mutator: rule-based");
    expect(header).toContain("iterations: 12");
    expect(header).toContain("score: 0.450 → 0.780 (Δ 0.330)");
    expect(header).toContain("2026-05-10T12:00:00Z");
  });
});
