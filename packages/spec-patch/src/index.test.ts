import { describe, expect, test } from "bun:test";
import {
  DIFF_VALUE_MAX_LENGTH,
  OPTIMIZABLE_PATHS,
  SpecPatchError,
  applySpecEdits,
  applySpecPatch,
  diffSpecYaml,
  formatDiffValue,
  formatWriteBackHeader,
  parseWriteBackHeader,
  specHasPath,
  validatePatch,
} from "./index";

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

describe("parseWriteBackHeader (item 46)", () => {
  test("round-trips every field formatWriteBackHeader writes", () => {
    const header = formatWriteBackHeader({
      runId: "opt_abc123",
      mutator: "claude",
      scoreBefore: 0.3,
      scoreAfter: 1,
      iterations: 14,
      timestamp: "2026-07-01T00:00:00.000Z",
    });
    const info = parseWriteBackHeader(`${header}${CLI_YAML}`);
    expect(info).toBeDefined();
    expect(info?.runId).toBe("opt_abc123");
    expect(info?.mutator).toBe("claude");
    expect(info?.iterations).toBe(14);
    expect(info?.scoreBefore).toBeCloseTo(0.3);
    expect(info?.scoreAfter).toBeCloseTo(1.0);
    expect(info?.generated).toBe("2026-07-01T00:00:00.000Z");
  });

  test("returns undefined for a spec that was never written back (plain leading comments)", () => {
    // CLI_YAML starts with an ordinary `# A simple CLI agent` comment.
    expect(parseWriteBackHeader(CLI_YAML)).toBeUndefined();
    expect(parseWriteBackHeader(PIPELINE_YAML)).toBeUndefined();
  });

  test("a crewhaus-optimize line BELOW the leading comment block is content, not a header", () => {
    const yaml = [
      "target: cli",
      "name: quoted",
      "agent:",
      "  model: m",
      "  instructions: |",
      "    # crewhaus optimize: runId opt_fake",
      "",
    ].join("\n");
    expect(parseWriteBackHeader(yaml)).toBeUndefined();
  });

  test("field lines before the stamp line are ignored; fields after it are read", () => {
    const yaml = [
      "# - mutator: not-a-header-field",
      "# crewhaus optimize: runId opt_ordered",
      "# - mutator: rule-based",
      "target: cli",
      "name: x",
      "agent:",
      "  model: m",
      "  instructions: hi",
      "",
    ].join("\n");
    const info = parseWriteBackHeader(yaml);
    expect(info?.runId).toBe("opt_ordered");
    expect(info?.mutator).toBe("rule-based");
  });
});

describe("diffSpecYaml (item 46 structural differ)", () => {
  const BASE = [
    "target: cli",
    "name: hello",
    "agent:",
    "  model: claude-sonnet-4-5",
    "  instructions: Be helpful.",
    "compaction:",
    "  threshold: 0.8",
    "tools:",
    "  - Read",
    "  - Write",
    "",
  ].join("\n");

  test("reports a changed nested scalar with old → new", () => {
    const next = BASE.replace("Be helpful.", "Be concise.");
    const diff = diffSpecYaml(BASE, next);
    expect(diff).toEqual([
      {
        kind: "changed",
        path: "agent.instructions",
        before: '"Be helpful."',
        after: '"Be concise."',
      },
    ]);
  });

  test("reports added and removed nested paths", () => {
    const next = BASE.replace("  threshold: 0.8", "  curate: true");
    const diff = diffSpecYaml(BASE, next);
    expect(diff).toContainEqual({
      kind: "removed",
      path: "compaction.threshold",
      before: "0.8",
    });
    expect(diff).toContainEqual({
      kind: "added",
      path: "compaction.curate",
      after: "true",
    });
    expect(diff).toHaveLength(2);
  });

  test("sequence elements diff by index with [i] paths", () => {
    const next = `${BASE.replace("  - Write", "  - Edit")}  - Bash\n`;
    const diff = diffSpecYaml(BASE, next);
    expect(diff).toContainEqual({
      kind: "changed",
      path: "tools[1]",
      before: '"Write"',
      after: '"Edit"',
    });
    expect(diff).toContainEqual({ kind: "added", path: "tools[2]", after: '"Bash"' });
  });

  test("identical values modulo comments/formatting produce an empty diff", () => {
    const commented = `# a leading comment\n${BASE.replace("agent:", "agent: # inline comment")}`;
    expect(diffSpecYaml(BASE, commented)).toEqual([]);
  });

  test("long values are truncated with a trailing ellipsis", () => {
    const long = "x".repeat(300);
    const next = BASE.replace("Be helpful.", long);
    const diff = diffSpecYaml(BASE, next);
    expect(diff).toHaveLength(1);
    const after = diff[0]?.after ?? "";
    expect(after.length).toBe(DIFF_VALUE_MAX_LENGTH);
    expect(after.endsWith("…")).toBe(true);
    // formatDiffValue is the shared primitive behind the truncation.
    expect(formatDiffValue(long, 10)).toHaveLength(10);
    expect(formatDiffValue("short")).toBe('"short"');
  });

  test("a map → sequence type change reports one changed entry at that path", () => {
    const before = "roles:\n  a:\n    x: 1\n";
    const after = "roles:\n  - a\n";
    const diff = diffSpecYaml(before, after);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.kind).toBe("changed");
    expect(diff[0]?.path).toBe("roles");
  });

  test("unparseable YAML throws SpecPatchError", () => {
    expect(() => diffSpecYaml("a: [unclosed", BASE)).toThrow(SpecPatchError);
    expect(() => diffSpecYaml(BASE, "a: [unclosed")).toThrow(SpecPatchError);
  });
});

describe("diffSpecYaml — credential redaction (adversarial review F1)", () => {
  const BASE = [
    "target: cli",
    "name: hello",
    "agent:",
    "  model: claude-sonnet-4-5",
    "  instructions: Be helpful.",
    "",
  ].join("\n");

  test("reviewer repro: an sk-live token pasted into instructions is masked, never printed", () => {
    const next = BASE.replace(
      "instructions: Be helpful.",
      "instructions: Call the API with key sk-live-DEADBEEFDEADBEEF please.",
    );
    const diff = diffSpecYaml(BASE, next);
    expect(diff).toHaveLength(1);
    const after = diff[0]?.after ?? "";
    expect(after).not.toContain("sk-live");
    expect(after).not.toContain("DEADBEEF");
    expect(after).toContain("***");
    expect(diff[0]?.path).toBe("agent.instructions");
  });

  test("reviewer repro: an agent.api_key change renders [redacted] on both sides", () => {
    const withKey = (v: string) =>
      BASE.replace("  instructions: Be helpful.", `  instructions: Be helpful.\n  api_key: ${v}`);
    const diff = diffSpecYaml(withKey("old-secret-value"), withKey("new-secret-value"));
    expect(diff).toEqual([
      {
        kind: "changed",
        path: "agent.api_key",
        before: "[redacted]",
        after: "[redacted]",
      },
    ]);
    expect(JSON.stringify(diff)).not.toContain("secret-value");
  });

  test("reviewer repro: MCP env password values render [redacted] for added, changed, AND removed", () => {
    const mcp = (password: string | undefined) =>
      [
        BASE.trimEnd(),
        "mcp_servers:",
        "  db:",
        "    command: pg-mcp",
        "    env:",
        ...(password !== undefined ? [`      PASSWORD: ${password}`] : ["      OTHER: x"]),
        "",
      ].join("\n");
    const added = diffSpecYaml(mcp(undefined), mcp("hunter2"));
    expect(added).toContainEqual({
      kind: "added",
      path: "mcp_servers.db.env.PASSWORD",
      after: "[redacted]",
    });
    const changed = diffSpecYaml(mcp("hunter2"), mcp("hunter3"));
    expect(changed).toEqual([
      {
        kind: "changed",
        path: "mcp_servers.db.env.PASSWORD",
        before: "[redacted]",
        after: "[redacted]",
      },
    ]);
    const removed = diffSpecYaml(mcp("hunter2"), mcp(undefined));
    expect(removed).toContainEqual({
      kind: "removed",
      path: "mcp_servers.db.env.PASSWORD",
      before: "[redacted]",
    });
    for (const diff of [added, changed, removed]) {
      expect(JSON.stringify(diff)).not.toContain("hunter");
    }
  });

  test("a whole added MCP server subtree redacts nested credential values in its JSON rendering", () => {
    const next = [
      BASE.trimEnd(),
      "mcp_servers:",
      "  gh:",
      "    command: gh-mcp",
      "    env:",
      "      GITHUB_TOKEN: ghp_abcdefghij0123456789",
      "",
    ].join("\n");
    const diff = diffSpecYaml(BASE, next);
    expect(diff).toHaveLength(1);
    const after = diff[0]?.after ?? "";
    expect(after).not.toContain("ghp_");
    expect(after).toContain("[redacted]");
    expect(after).toContain("gh-mcp"); // non-credential structure still renders
  });

  test("a benign instructions edit renders normally (no false redaction)", () => {
    const next = BASE.replace("Be helpful.", "Think step by step before answering.");
    const diff = diffSpecYaml(BASE, next);
    expect(diff).toEqual([
      {
        kind: "changed",
        path: "agent.instructions",
        before: '"Be helpful."',
        after: '"Think step by step before answering."',
      },
    ]);
  });
});

describe("0.3.0 memory release — memory/continuity knob paths (§7.5, PR 20)", () => {
  const MEMORY_YAML = `# a memory-carrying support harness
target: cli
name: support-bot
agent:
  model: claude-sonnet-4-6
  instructions: Help users with support tickets.
memory:
  enabled: true
  ttl: 90d
  # The semantic tier — the local wiki:
  wiki:
    enabled: true
    recallK: 6
  dream:
    every: 24h
continuity:
  # keep the volatile tail small
  focusMaxChars: 4096
`;

  const MEMORY_KNOB_PATHS = [
    ["memory", "recallK"],
    ["memory", "autoCaptureThreshold"],
    ["memory", "ttl"],
    ["memory", "wiki", "recallK"],
    ["memory", "dream", "budget_usd"],
    ["continuity", "focusMaxChars"],
  ] as const;

  test("the six knobs are registered on all five emit-wired memory shapes", () => {
    for (const target of ["cli", "channel", "managed", "research", "crew"] as const) {
      for (const path of MEMORY_KNOB_PATHS) {
        expect(OPTIMIZABLE_PATHS[target]).toContainEqual([...path]);
      }
    }
  });

  test("a nested memory.wiki.recallK patch round-trips with comments and key order intact", () => {
    const { yaml, spec } = applySpecPatch(MEMORY_YAML, {
      target: "cli",
      path: ["memory", "wiki", "recallK"],
      op: "replace",
      value: 12,
    });
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.memory?.wiki?.recallK).toBe(12);
    expect(yaml).toContain("recallK: 12");
    // Comments survive the CST round-trip …
    expect(yaml).toContain("# a memory-carrying support harness");
    expect(yaml).toContain("# The semantic tier — the local wiki:");
    expect(yaml).toContain("# keep the volatile tail small");
    // … and key order does too: ttl before wiki, memory before continuity.
    expect(yaml.indexOf("ttl: 90d")).toBeLessThan(yaml.indexOf("wiki:"));
    expect(yaml.indexOf("memory:")).toBeLessThan(yaml.indexOf("continuity:"));
    // Only the touched value changed — untouched siblings keep their bytes.
    expect(yaml).toContain("ttl: 90d");
    expect(yaml).toContain("every: 24h");
  });

  test("a continuity.focusMaxChars patch round-trips with its comment preserved", () => {
    const { yaml, spec } = applySpecPatch(MEMORY_YAML, {
      target: "cli",
      path: ["continuity", "focusMaxChars"],
      op: "replace",
      value: 2048,
    });
    if (spec.target !== "cli") throw new Error("expected cli spec");
    const continuity = spec.continuity;
    if (typeof continuity === "boolean" || continuity === undefined) {
      throw new Error("expected the continuity object form");
    }
    expect(continuity.focusMaxChars).toBe(2048);
    expect(yaml).toContain("focusMaxChars: 2048");
    expect(yaml).toContain("# keep the volatile tail small");
  });

  test("an add patch creates memory.dream.budget_usd inside the existing dream block", () => {
    expect(specHasPath(MEMORY_YAML, ["memory", "dream", "budget_usd"])).toBe(false);
    const { yaml, spec } = applySpecPatch(MEMORY_YAML, {
      target: "cli",
      path: ["memory", "dream", "budget_usd"],
      op: "add",
      value: 0.25,
    });
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.memory?.dream?.budget_usd).toBe(0.25);
    expect(yaml).toContain("budget_usd: 0.25");
  });

  test("validatePatch accepts every registered knob and an out-of-bounds value still fails apply", () => {
    const { spec } = applySpecPatch(MEMORY_YAML, {
      target: "cli",
      path: ["memory", "wiki", "recallK"],
      op: "replace",
      value: 8,
    });
    for (const path of MEMORY_KNOB_PATHS) {
      expect(() =>
        validatePatch(spec, { target: "cli", path: [...path], op: "replace", value: 1 }),
      ).not.toThrow();
    }
    // Bounds are owned by the spec schema: recallK is capped at 50, so an
    // optimizer overshoot is rejected at apply time by the re-parse.
    expect(() =>
      applySpecPatch(MEMORY_YAML, {
        target: "cli",
        path: ["memory", "wiki", "recallK"],
        op: "replace",
        value: 500,
      }),
    ).toThrow(/spec validation failed/);
  });

  test("enum/behavioral switches stay OUT of the optimization surface", () => {
    const { spec } = applySpecPatch(MEMORY_YAML, {
      target: "cli",
      path: ["memory", "recallK"],
      op: "add",
      value: 5,
    });
    const excluded = [
      ["memory", "backend"], // store flip
      ["memory", "dream", "every"], // side-effecting schedule
      ["memory", "dream", "mode"], // model-spend switch
      ["continuity", "proof"], // proof-ladder strictness
      ["continuity", "scope"], // store scoping
      ["continuity", "enabled"], // the release's sanctioned default
      ["thredz"], // credentials
      ["learning", "sources"], // allowlist = security
      ["compaction", "preserve_user_messages"], // safety
    ];
    for (const path of excluded) {
      expect(() => validatePatch(spec, { target: "cli", path, op: "replace", value: "x" })).toThrow(
        /not listed in OPTIMIZABLE_PATHS/,
      );
    }
  });
});

describe("adaptive model routing — model_pool policy paths", () => {
  const POOL_YAML = `target: cli
name: pooled
agent:
  model: claude-sonnet-4-5
  instructions: help
  model_pool:
    candidates:
      - { model: claude-haiku-4-5, tags: [cheap] }
      - { model: claude-opus-4-1, tags: [strong] }
`;

  test("pool POLICY paths are whitelisted for cli/channel/managed; roster paths are not", () => {
    const { spec } = applySpecPatch(POOL_YAML, {
      target: "cli",
      path: ["agent", "model_pool", "policy"],
      op: "add",
      value: "learned",
    });
    for (const path of [
      ["agent", "model_pool", "policy"],
      ["agent", "model_pool", "routing"],
      ["agent", "model_pool", "learning"],
    ]) {
      expect(() =>
        validatePatch(spec, { target: "cli", path, op: "replace", value: "x" }),
      ).not.toThrow(/not listed/);
    }
    // The candidate ROSTER stays human-owned — like ["agent","model"] itself.
    expect(() =>
      validatePatch(spec, {
        target: "cli",
        path: ["agent", "model_pool", "candidates"],
        op: "replace",
        value: [],
      }),
    ).toThrow(/not listed in OPTIMIZABLE_PATHS/);
    expect(() =>
      validatePatch(spec, {
        target: "cli",
        path: ["agent", "model_pool"],
        op: "replace",
        value: {},
      }),
    ).toThrow(/not listed in OPTIMIZABLE_PATHS/);
  });

  test("an add patch on the zod-defaulted policy key round-trips the YAML", () => {
    const { yaml, spec } = applySpecPatch(POOL_YAML, {
      target: "cli",
      path: ["agent", "model_pool", "policy"],
      op: "add",
      value: "learned",
    });
    expect(yaml).toContain("policy: learned");
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.agent.model_pool?.policy).toBe("learned");
  });

  test("specHasPath sees textual keys, not zod defaults", () => {
    // POOL_YAML omits `policy` — the parsed spec defaults it, the text lacks it.
    expect(specHasPath(POOL_YAML, ["agent", "model_pool", "policy"])).toBe(false);
    expect(specHasPath(POOL_YAML, ["agent", "model_pool", "candidates"])).toBe(true);
    expect(specHasPath(POOL_YAML, ["agent", "model"])).toBe(true);
    expect(specHasPath("not: [valid", ["agent"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch B, G40) — applySpecEdits
// ---------------------------------------------------------------------------

const WORKFLOW_YAML = `# Release-notes workflow
target: workflow
name: notes
model: claude-sonnet-4-5
steps:
  # First pass: get the facts down
  - name: draft
    instructions: Draft the notes.
  - name: polish
    instructions: Polish the notes.
`;

const EVAL_CLI_YAML = `target: cli
name: gated-cli
agent:
  model: claude-sonnet-4-5
  instructions: Answer carefully.
# In-loop gate — its dials are optimizer-tunable
evaluation:
  grader:
    type: llm_judge
    criteria: response is factually grounded
  threshold: 0.7
  on_fail: retry
  max_retries: 1
`;

describe("applySpecEdits — author surface (upsert / delete-on-undefined)", () => {
  test("upserts an existing scalar and preserves comments", () => {
    const { yaml, spec, applied } = applySpecEdits(CLI_YAML, [
      { path: ["agent", "instructions"], value: "Be concise." },
    ]);
    expect(applied).toBe(1);
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.agent.instructions).toBe("Be concise.");
    expect(yaml).toContain("# A simple CLI agent");
    expect(yaml).toContain("# The system prompt the model sees on every turn");
  });

  test("upserts through missing intermediate collections", () => {
    // CLI_YAML has no `limits:` block — the declarative surface creates it.
    const { spec, applied } = applySpecEdits(CLI_YAML, [
      { path: ["limits", "max_tool_iterations"], value: 25 },
    ]);
    expect(applied).toBe(1);
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.limits?.max_tool_iterations).toBe(25);
  });

  test("author surface may edit fields outside OPTIMIZABLE_PATHS", () => {
    // ["agent","model"] is deliberately NOT whitelisted for the optimizer;
    // the author surface (no restrictToOptimizable) edits it freely.
    const { spec } = applySpecEdits(CLI_YAML, [
      { path: ["agent", "model"], value: "claude-opus-4-8" },
    ]);
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.agent.model).toBe("claude-opus-4-8");
  });

  test("undefined value deletes an existing path", () => {
    const { yaml, spec, applied } = applySpecEdits(CLI_YAML, [
      { path: ["tools"], value: undefined },
    ]);
    expect(applied).toBe(1);
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.tools).toBeUndefined();
    expect(yaml).not.toContain("tools:");
    expect(yaml).toContain("# A simple CLI agent");
  });

  test("omitting the value key entirely also deletes", () => {
    const { spec, applied } = applySpecEdits(CLI_YAML, [{ path: ["tools"] }]);
    expect(applied).toBe(1);
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.tools).toBeUndefined();
  });

  test("deleting an absent path is an idempotent no-op", () => {
    const { yaml, applied } = applySpecEdits(CLI_YAML, [
      { path: ["budget"], value: undefined },
      { path: ["agent", "thinking"], value: undefined },
    ]);
    expect(applied).toBe(0);
    expect(diffSpecYaml(CLI_YAML, yaml)).toEqual([]);
  });

  test("zero-edit batch validates and returns the input byte-identical", () => {
    const { yaml, spec, applied } = applySpecEdits(CLI_YAML, []);
    expect(yaml).toBe(CLI_YAML); // no CST round-trip reformatting
    expect(applied).toBe(0);
    expect(spec.target).toBe("cli");
  });

  test("zero-edit batch still rejects an invalid spec", () => {
    expect(() => applySpecEdits("target: cli\n", [])).toThrow(/input YAML failed spec validation/);
  });

  test("a batch that produces an invalid spec throws atomically", () => {
    const edits = [
      { path: ["agent", "instructions"], value: "ok" },
      { path: ["agent", "model"], value: 42 }, // breaks the schema
    ];
    expect(() => applySpecEdits(CLI_YAML, edits)).toThrow(SpecPatchError);
    expect(() => applySpecEdits(CLI_YAML, edits)).toThrow(/edited YAML failed spec validation/);
    // The same batch minus the poison edit applies cleanly — the failure
    // above came from the atomic re-validation, not the first edit.
    const first = edits[0];
    if (first === undefined) throw new Error("unreachable");
    expect(() => applySpecEdits(CLI_YAML, [first])).not.toThrow();
  });

  test("malformed edit shape (empty path) is rejected with its index", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime validation
    expect(() => applySpecEdits(CLI_YAML, [{ path: [] as any, value: 1 }])).toThrow(
      /edit #0 shape is invalid/,
    );
  });

  test("unparseable input YAML is rejected", () => {
    expect(() => applySpecEdits("not: [valid", [{ path: ["name"], value: "x" }])).toThrow(
      /not parseable/,
    );
  });
});

describe("applySpecEdits — sequence index paths", () => {
  test("replaces a field on a step by integer index, comments intact", () => {
    const { yaml, spec, applied } = applySpecEdits(WORKFLOW_YAML, [
      { path: ["steps", 0, "instructions"], value: "Draft thoroughly." },
    ]);
    expect(applied).toBe(1);
    if (spec.target !== "workflow") throw new Error("expected workflow spec");
    expect(spec.steps[0]?.instructions).toBe("Draft thoroughly.");
    expect(spec.steps[1]?.instructions).toBe("Polish the notes.");
    expect(yaml).toContain("# Release-notes workflow");
    expect(yaml).toContain("# First pass: get the facts down");
  });

  test("numeric-string indices address sequences too", () => {
    const { spec } = applySpecEdits(WORKFLOW_YAML, [
      { path: ["steps", "1", "instructions"], value: "Polish harder." },
    ]);
    if (spec.target !== "workflow") throw new Error("expected workflow spec");
    expect(spec.steps[1]?.instructions).toBe("Polish harder.");
  });

  test("index === length appends", () => {
    const { spec, applied } = applySpecEdits(WORKFLOW_YAML, [
      { path: ["steps", 2], value: { name: "review", instructions: "Review the notes." } },
    ]);
    expect(applied).toBe(1);
    if (spec.target !== "workflow") throw new Error("expected workflow spec");
    expect(spec.steps).toHaveLength(3);
    expect(spec.steps[2]?.name).toBe("review");
  });

  test("index past length is rejected — never null-padded", () => {
    expect(() =>
      applySpecEdits(WORKFLOW_YAML, [{ path: ["steps", 5], value: { name: "x" } }]),
    ).toThrow(/index 5 is out of bounds .* \(length 2; index 2 appends\)/);
  });

  test("a brand-new sequence can only start at index 0", () => {
    const item = { class: "rate-limit", pattern: "429", recovery: "retry" };
    expect(() =>
      applySpecEdits(CLI_YAML, [{ path: ["failure_taxonomy", 1], value: item }]),
    ).toThrow(/a new sequence starts at index 0/);
    const { spec } = applySpecEdits(CLI_YAML, [{ path: ["failure_taxonomy", 0], value: item }]);
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.failure_taxonomy).toHaveLength(1);
  });
});

describe("applySpecEdits — restrictToOptimizable (optimizer surface)", () => {
  test("rejects a path outside the whitelist", () => {
    expect(() =>
      applySpecEdits(CLI_YAML, [{ path: ["agent", "model"], value: "m" }], {
        restrictToOptimizable: true,
      }),
    ).toThrow(/not listed in OPTIMIZABLE_PATHS/);
  });

  test("accepts an indexed sub-path under a whitelisted prefix", () => {
    // ["steps"] is whitelisted for workflow — fine-grained edits below it pass.
    const { spec } = applySpecEdits(
      WORKFLOW_YAML,
      [{ path: ["steps", 0, "instructions"], value: "Draft with citations." }],
      { restrictToOptimizable: true },
    );
    if (spec.target !== "workflow") throw new Error("expected workflow spec");
    expect(spec.steps[0]?.instructions).toBe("Draft with citations.");
  });

  test("evaluation.threshold and evaluation.max_retries are tunable dials", () => {
    const { yaml, spec, applied } = applySpecEdits(
      EVAL_CLI_YAML,
      [
        { path: ["evaluation", "threshold"], value: 0.9 },
        { path: ["evaluation", "max_retries"], value: 3 },
      ],
      { restrictToOptimizable: true },
    );
    expect(applied).toBe(2);
    if (spec.target !== "cli") throw new Error("expected cli spec");
    expect(spec.evaluation?.threshold).toBe(0.9);
    expect(spec.evaluation?.max_retries).toBe(3);
    expect(yaml).toContain("# In-loop gate — its dials are optimizer-tunable");
  });

  test("evaluation.grader stays human-owned", () => {
    expect(() =>
      applySpecEdits(
        EVAL_CLI_YAML,
        [{ path: ["evaluation", "grader", "criteria"], value: "always pass" }],
        { restrictToOptimizable: true },
      ),
    ).toThrow(/not listed in OPTIMIZABLE_PATHS/);
  });

  test("a threshold patch on a deterministic grader fails the atomic re-parse", () => {
    const containsYaml = EVAL_CLI_YAML.replace(
      "    type: llm_judge\n    criteria: response is factually grounded\n  threshold: 0.7\n",
      "    type: contains\n    value: DONE\n",
    );
    expect(() =>
      applySpecEdits(containsYaml, [{ path: ["evaluation", "threshold"], value: 0.9 }], {
        restrictToOptimizable: true,
      }),
    ).toThrow(/failed spec validation/);
  });

  test("unknown spec target cannot be restricted", () => {
    expect(() =>
      applySpecEdits("target: bogus\nname: x\n", [{ path: ["name"], value: "y" }], {
        restrictToOptimizable: true,
      }),
    ).toThrow(/is not a known target/);
  });
});

describe("validatePatch — evaluation dials", () => {
  test("accepts the newly whitelisted evaluation paths", () => {
    const { spec } = applySpecEdits(EVAL_CLI_YAML, []);
    expect(() =>
      validatePatch(spec, {
        target: "cli",
        path: ["evaluation", "threshold"],
        op: "replace",
        value: 0.85,
      }),
    ).not.toThrow();
    expect(() =>
      validatePatch(spec, {
        target: "cli",
        path: ["evaluation", "max_retries"],
        op: "replace",
        value: 2,
      }),
    ).not.toThrow();
    expect(() =>
      validatePatch(spec, {
        target: "cli",
        path: ["evaluation", "on_fail"], // behavioral switch — human-owned
        op: "replace",
        value: "halt",
      }),
    ).toThrow(/not listed in OPTIMIZABLE_PATHS/);
  });
});
