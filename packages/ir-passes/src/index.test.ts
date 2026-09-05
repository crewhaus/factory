/**
 * Section 28 — `ir-passes` tests:
 *  - T1 per built-in pass
 *  - T9 idempotence (apply(apply(x)) === apply(x))
 *  - T4 fixture replay
 */
import { describe, expect, test } from "bun:test";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import {
  DEFAULT_PIPELINE,
  IrPassError,
  VALIDATING_PASSES,
  applyPasses,
  deadToolElimination,
  memoryIntegrityPass,
  modelPlanIntegrity,
  permissionRuleCanonicalize,
  promptCachePrefixSort,
  redundantMcpServerCollapse,
  transactionPolicyEnforcement,
  wellFormednessCheck,
} from "./index";

function makeCli(overrides: Partial<IrV0> = {}): IrV0 {
  return {
    version: 0,
    name: "test",
    target: "cli",
    agent: { model: "claude-opus-4-7", instructions: "be helpful" },
    tools: [],
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},
    ...overrides,
  };
}

describe("ir-passes — deadToolElimination (T1)", () => {
  test("no rules + no sub-agents → returns input unchanged (no inference)", () => {
    const ir = makeCli({ tools: ["Read", "Write", "Bash"] });
    const out = deadToolElimination(ir) as IrV0;
    expect(out.tools).toEqual(ir.tools);
  });

  test("with rules referring only to Read+Bash → drops Write", () => {
    const ir = makeCli({
      tools: ["Read", "Write", "Bash"],
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysAllow", pattern: "Bash(*)" },
        ],
      },
    });
    const out = deadToolElimination(ir) as IrV0;
    expect([...out.tools].sort()).toEqual(["Bash", "Read"]);
  });

  test("sub-agent that uses Write keeps Write in the parent's tool list", () => {
    const ir = makeCli({
      tools: ["Read", "Write"],
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Read" }] },
      subAgents: [
        {
          name: "writer",
          description: "writes files",
          instructions: "x",
          tools: ["Write"],
          permissions: "inherit",
          inheritBypass: false,
        },
      ],
    });
    const out = deadToolElimination(ir) as IrV0;
    expect([...out.tools].sort()).toEqual(["Read", "Write"]);
  });

  test("non-cli targets pass through unchanged", () => {
    // Use a fixture-shaped non-cli IR
    const ir: IrNode = {
      version: 0,
      name: "wf",
      target: "workflow",
      steps: [],
    } as unknown as IrNode;
    expect(deadToolElimination(ir)).toBe(ir);
  });
});

describe("ir-passes — redundantMcpServerCollapse (T1)", () => {
  test("dedup stdio servers by (command, args)", () => {
    const ir = makeCli({
      mcp_servers: {
        a: { transport: "stdio", command: "npx", args: ["@x"] },
        b: { transport: "stdio", command: "npx", args: ["@x"] },
        c: { transport: "stdio", command: "npx", args: ["@y"] },
      },
    });
    const out = redundantMcpServerCollapse(ir) as IrV0;
    expect(Object.keys(out.mcp_servers).sort()).toEqual(["a", "c"]);
  });

  test("dedup sse servers by url", () => {
    const ir = makeCli({
      mcp_servers: {
        a: { transport: "sse", url: "http://x" },
        b: { transport: "sse", url: "http://x" },
        c: { transport: "sse", url: "http://y" },
      },
    });
    const out = redundantMcpServerCollapse(ir) as IrV0;
    expect(Object.keys(out.mcp_servers).sort()).toEqual(["a", "c"]);
  });

  test("returns input unchanged when no duplicates", () => {
    const ir = makeCli({
      mcp_servers: {
        a: { transport: "stdio", command: "x", args: [] },
      },
    });
    expect(redundantMcpServerCollapse(ir)).toBe(ir);
  });

  test("stdio servers with identical IrSecretRef env still dedupe (structural comparison, 0.3.0)", () => {
    const ir = makeCli({
      mcp_servers: {
        a: {
          transport: "stdio",
          command: "npx",
          args: ["@x"],
          env: { API_KEY: { kind: "env", name: "API_KEY" } },
        },
        b: {
          transport: "stdio",
          command: "npx",
          args: ["@x"],
          env: { API_KEY: { kind: "env", name: "API_KEY" } },
        },
      },
    });
    const out = redundantMcpServerCollapse(ir) as IrV0;
    expect(Object.keys(out.mcp_servers)).toEqual(["a"]);
  });

  test("stdio servers that differ only in env refs do NOT collapse (different credentials)", () => {
    const ir = makeCli({
      mcp_servers: {
        a: {
          transport: "stdio",
          command: "npx",
          args: ["@x"],
          env: { API_KEY: { kind: "env", name: "KEY_A" } },
        },
        b: {
          transport: "stdio",
          command: "npx",
          args: ["@x"],
          env: { API_KEY: { kind: "env", name: "KEY_B" } },
        },
      },
    });
    expect(redundantMcpServerCollapse(ir)).toBe(ir);
  });

  test('an env ref $X never collides with the literal string "$X"', () => {
    const ir = makeCli({
      mcp_servers: {
        a: {
          transport: "stdio",
          command: "npx",
          args: ["@x"],
          env: { API_KEY: { kind: "env", name: "X" } },
        },
        b: {
          transport: "stdio",
          command: "npx",
          args: ["@x"],
          env: { API_KEY: { kind: "literal", value: "$X" } },
        },
      },
    });
    expect(redundantMcpServerCollapse(ir)).toBe(ir);
  });

  test("sse servers dedupe on (url, headers) — same headers collapse, different keep", () => {
    const same = makeCli({
      mcp_servers: {
        a: {
          transport: "sse",
          url: "http://x",
          headers: { Authorization: { kind: "env", name: "TOK" } },
        },
        b: {
          transport: "sse",
          url: "http://x",
          headers: { Authorization: { kind: "env", name: "TOK" } },
        },
      },
    });
    expect(Object.keys((redundantMcpServerCollapse(same) as IrV0).mcp_servers)).toEqual(["a"]);

    const different = makeCli({
      mcp_servers: {
        a: {
          transport: "sse",
          url: "http://x",
          headers: { Authorization: { kind: "env", name: "TOK_A" } },
        },
        b: {
          transport: "sse",
          url: "http://x",
          headers: { Authorization: { kind: "env", name: "TOK_B" } },
        },
      },
    });
    expect(redundantMcpServerCollapse(different)).toBe(different);
  });
});

describe("ir-passes — permissionRuleCanonicalize (T1)", () => {
  test("sorts by tier (deny > ask > allow) then alpha within tier", () => {
    const ir = makeCli({
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysDeny", pattern: "Bash(rm *)" },
          { type: "alwaysAsk", pattern: "Edit" },
          { type: "alwaysAllow", pattern: "Bash" },
          { type: "alwaysDeny", pattern: "Write" },
        ],
      },
    });
    const out = permissionRuleCanonicalize(ir) as IrV0;
    expect(out.permissions.rules.map((r) => `${r.type}:${r.pattern}`)).toEqual([
      "alwaysDeny:Bash(rm *)",
      "alwaysDeny:Write",
      "alwaysAsk:Edit",
      "alwaysAllow:Bash",
      "alwaysAllow:Read",
    ]);
  });

  test("dedups exact duplicates", () => {
    const ir = makeCli({
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysAllow", pattern: "Bash" },
        ],
      },
    });
    const out = permissionRuleCanonicalize(ir) as IrV0;
    expect(out.permissions.rules.length).toBe(2);
  });

  test("returns input unchanged when already canonical", () => {
    const ir = makeCli({
      permissions: {
        rules: [
          { type: "alwaysDeny", pattern: "Bash(rm *)" },
          { type: "alwaysAllow", pattern: "Read" },
        ],
      },
    });
    const out = permissionRuleCanonicalize(ir);
    expect(out).toBe(ir);
  });
});

describe("ir-passes — promptCachePrefixSort (T1 stub)", () => {
  test("v0 stub returns input unchanged", () => {
    const ir = makeCli();
    expect(promptCachePrefixSort(ir)).toBe(ir);
  });
});

describe("ir-passes — applyPasses + idempotence (T9)", () => {
  test("applyPasses runs the default pipeline", () => {
    const ir = makeCli({
      tools: ["Read", "Write", "Bash"],
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysAllow", pattern: "Read" },
        ],
      },
      mcp_servers: {
        a: { transport: "stdio", command: "x", args: [] },
        b: { transport: "stdio", command: "x", args: [] },
      },
    });
    const once = applyPasses(ir) as IrV0;
    expect([...once.tools].sort()).toEqual(["Read"]);
    expect(once.permissions.rules.length).toBe(1);
    expect(Object.keys(once.mcp_servers).length).toBe(1);
  });

  test("idempotence: applyPasses(applyPasses(x)) === applyPasses(x)", () => {
    const ir = makeCli({
      tools: ["Read", "Write", "Bash"],
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysDeny", pattern: "Bash" },
        ],
      },
      mcp_servers: {
        a: { transport: "stdio", command: "x", args: ["y"] },
        b: { transport: "stdio", command: "x", args: ["y"] },
      },
    });
    const a = applyPasses(ir);
    const b = applyPasses(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("custom pipeline applied in order", () => {
    const calls: string[] = [];
    const passes = [
      (n: IrNode) => {
        calls.push("a");
        return n;
      },
      (n: IrNode) => {
        calls.push("b");
        return n;
      },
    ];
    applyPasses(makeCli(), { passes });
    expect(calls).toEqual(["a", "b"]);
  });

  test("DEFAULT_PIPELINE has 8 passes (+ memoryIntegrityPass from v0.3.0 PR 11, + modelPlanIntegrity from 0.6.0 PR 7)", () => {
    expect(DEFAULT_PIPELINE.length).toBe(8);
  });

  // G45 (loop contract 0.4) — the validating/rewriting split. The compiler
  // runs VALIDATING_PASSES unconditionally inside compile(); this pin keeps
  // the exported marker honest: exactly the three validation-only passes,
  // in the DEFAULT_PIPELINE's relative order, embedded contiguously so the
  // full pipeline and the standalone validating run cannot disagree.
  test("VALIDATING_PASSES is the ordered validation-only subset of DEFAULT_PIPELINE", () => {
    expect(VALIDATING_PASSES).toEqual([
      transactionPolicyEnforcement,
      wellFormednessCheck,
      memoryIntegrityPass,
      modelPlanIntegrity,
    ]);
    const start = DEFAULT_PIPELINE.indexOf(
      VALIDATING_PASSES[0] as (typeof DEFAULT_PIPELINE)[number],
    );
    expect(start).toBeGreaterThan(-1);
    expect(DEFAULT_PIPELINE.slice(start, start + VALIDATING_PASSES.length)).toEqual([
      ...VALIDATING_PASSES,
    ]);
  });
});

describe("ir-passes — transactionPolicyEnforcement (T1, T8)", () => {
  const baseChain = {
    id: "base-mainnet",
    kind: "evm" as const,
    rpcUrls: [{ kind: "literal" as const, value: "https://rpc.test" }],
    rpcPolicy: "single" as const,
    finality: { kind: "finalized" as const },
    reorgTolerant: true,
  };
  const treasuryWallet = {
    id: "treasury",
    chainId: "base-mainnet",
    custody: "user-controlled" as const,
    signingPolicy: "explicit-user-approval" as const,
  };
  const usdcContract = {
    id: "usdc",
    chainId: "base-mainnet",
    address: "0xusdc",
    abiRef: "abi://erc20",
  };

  test("empty subsystem is a no-op (existing specs untouched)", () => {
    const ir = makeCli();
    expect(transactionPolicyEnforcement(ir)).toBe(ir);
  });

  test("valid subsystem passes through unchanged", () => {
    const ir = makeCli({
      chains: [baseChain],
      wallets: [treasuryWallet],
      contracts: [usdcContract],
      transactionPolicy: {
        defaultWriteApproval: "required",
        allowedContracts: ["usdc"],
        simulationRequired: true,
      },
    });
    expect(transactionPolicyEnforcement(ir)).toBe(ir);
  });

  test("rejects wallets[].chainId not declared in chains[]", () => {
    const ir = makeCli({
      chains: [baseChain],
      wallets: [{ ...treasuryWallet, chainId: "polygon-mainnet" }],
    });
    expect(() => transactionPolicyEnforcement(ir)).toThrow(IrPassError);
  });

  test("rejects contracts[].chainId not declared in chains[]", () => {
    const ir = makeCli({
      chains: [baseChain],
      contracts: [{ ...usdcContract, chainId: "polygon-mainnet" }],
    });
    expect(() => transactionPolicyEnforcement(ir)).toThrow(/not declared in chains\[\]/);
  });

  test("rejects allowedContracts entry not in contracts[].id", () => {
    const ir = makeCli({
      chains: [baseChain],
      contracts: [usdcContract],
      transactionPolicy: {
        defaultWriteApproval: "required",
        allowedContracts: ["unknown-token"],
        simulationRequired: true,
      },
    });
    expect(() => transactionPolicyEnforcement(ir)).toThrow(/unknown-token/);
  });

  test("rejects approval=none with non-automated wallet", () => {
    const ir = makeCli({
      chains: [baseChain],
      wallets: [treasuryWallet],
      contracts: [usdcContract],
      transactionPolicy: {
        defaultWriteApproval: "none",
        allowedContracts: ["usdc"],
        simulationRequired: false,
      },
    });
    expect(() => transactionPolicyEnforcement(ir)).toThrow(/automated/);
  });

  test("accepts approval=none when every wallet is automated", () => {
    const ir = makeCli({
      chains: [baseChain],
      wallets: [
        {
          ...treasuryWallet,
          custody: "kms",
          signingPolicy: "automated",
          keyRef: { kind: "env", name: "KMS_KEY" },
        },
      ],
      contracts: [usdcContract],
      transactionPolicy: {
        defaultWriteApproval: "none",
        allowedContracts: ["usdc"],
        simulationRequired: false,
      },
    });
    expect(transactionPolicyEnforcement(ir)).toBe(ir);
  });

  test("rejects kms wallet without keyRef", () => {
    const ir = makeCli({
      chains: [baseChain],
      wallets: [{ ...treasuryWallet, custody: "kms" }],
    });
    expect(() => transactionPolicyEnforcement(ir)).toThrow(/keyRef/);
  });

  test("rejects duplicate chains[].id", () => {
    const ir = makeCli({ chains: [baseChain, baseChain] });
    expect(() => transactionPolicyEnforcement(ir)).toThrow(/duplicate chains/);
  });

  test("rejects duplicate wallets[].id", () => {
    const ir = makeCli({
      chains: [baseChain],
      wallets: [treasuryWallet, treasuryWallet],
    });
    expect(() => transactionPolicyEnforcement(ir)).toThrow(/duplicate wallets/);
  });

  test("non-blockchain shapes (managed, voice, browser, eval) pass through unchanged", () => {
    const ir: IrNode = {
      version: 0,
      name: "test-mgd",
      target: "managed",
      agent: { model: "claude-opus-4-7", instructions: "hi" },
      tenants: [{ id: "t1", budget: { maxInputTokens: 1, maxOutputTokens: 1 } }],
      permissions: { rules: [] },
      compaction: {},
    };
    expect(transactionPolicyEnforcement(ir)).toBe(ir);
  });
});

describe("ir-passes — memoryIntegrityPass (v0.3.0 PR 11)", () => {
  const CONTINUITY = {
    plan: true,
    proof: "ladder" as const,
    ledger: true,
    handoff: true,
    scope: "spec" as const,
  };

  test("no memory/continuity → returns input unchanged", () => {
    const ir = makeCli();
    expect(memoryIntegrityPass(ir)).toBe(ir);
  });

  test("valid memory + continuity pass through unchanged", () => {
    const ir = makeCli({
      memory: { autoRecall: true, ttlMs: 7_776_000_000, wiki: { recallK: 6 } },
      continuity: CONTINUITY,
    });
    expect(memoryIntegrityPass(ir)).toBe(ir);
  });

  test("wiki.recallK out of 1–50 throws", () => {
    expect(() => memoryIntegrityPass(makeCli({ memory: { wiki: { recallK: 0 } } }))).toThrow(
      IrPassError,
    );
    expect(() => memoryIntegrityPass(makeCli({ memory: { wiki: { recallK: 51 } } }))).toThrow(
      IrPassError,
    );
    expect(() => memoryIntegrityPass(makeCli({ memory: { wiki: { recallK: 2.5 } } }))).toThrow(
      IrPassError,
    );
  });

  test("ttlMs below the 1h floor throws (mirror of the compiler's rule)", () => {
    expect(() => memoryIntegrityPass(makeCli({ memory: { ttlMs: 30 * 60 * 1000 } }))).toThrow(
      IrPassError,
    );
    expect(() => memoryIntegrityPass(makeCli({ memory: { ttlMs: 60 * 60 * 1000 } }))).not.toThrow();
  });

  test("dream.everyMs below the 5m floor throws (mirror of the compiler's PR 14 rule)", () => {
    expect(() =>
      memoryIntegrityPass(makeCli({ memory: { dream: { everyMs: 4 * 60 * 1000, mode: "full" } } })),
    ).toThrow(IrPassError);
    expect(() =>
      memoryIntegrityPass(makeCli({ memory: { dream: { everyMs: 5 * 60 * 1000, mode: "full" } } })),
    ).not.toThrow();
    expect(() =>
      memoryIntegrityPass(
        makeCli({
          memory: { dream: { everyMs: 86_400_000, mode: "full", budgetUsd: 0.5 } },
        }),
      ),
    ).not.toThrow();
  });

  test('continuity.scope "session" only on shapes with session routing (channel)', () => {
    expect(() =>
      memoryIntegrityPass(makeCli({ continuity: { ...CONTINUITY, scope: "session" } })),
    ).toThrow(IrPassError);
    // The channel shape has the session router — session scope is legal there.
    const channel = {
      version: 0,
      name: "ch",
      target: "channel",
      agent: { model: "m", instructions: "i" },
      tools: [],
      toolConfigs: {},
      channels: {},
      routing: { sessionKey: "thread" },
      mcp_servers: {},
      permissions: { rules: [] },
      subAgents: [],
      compaction: {},
      continuity: { ...CONTINUITY, scope: "session" },
    } as unknown as IrNode;
    expect(memoryIntegrityPass(channel)).toBe(channel);
  });

  test("non-JSON-serializable blocks throw (emitters stringify the fragment)", () => {
    const withDate = makeCli({
      memory: { ttlMs: 60 * 60 * 1000 },
      continuity: { ...CONTINUITY, focusMaxChars: new Date() as unknown as number },
    });
    expect(() => memoryIntegrityPass(withDate)).toThrow(IrPassError);
  });

  // v0.3.0 PR 17 — the learning mirror of the compiler's cross-field check.
  const LEARNING = { domain: "coffee", study: { onHeartbeat: true, onDream: true } };

  test("learning with an enabled wiki passes through unchanged", () => {
    const ir = makeCli({ memory: { wiki: { enabled: true } }, learning: LEARNING });
    expect(memoryIntegrityPass(ir)).toBe(ir);
  });

  test("learning with a thredz block (no local wiki) passes through unchanged", () => {
    const ir = makeCli({
      learning: LEARNING,
      thredz: {
        apiKey: { kind: "env", name: "THREDZ_API_KEY" },
        visibility: "private",
        goals: true,
      },
    } as never);
    expect(memoryIntegrityPass(ir)).toBe(ir);
  });

  test("learning without a wiki (no memory.wiki, no thredz) throws", () => {
    expect(() => memoryIntegrityPass(makeCli({ learning: LEARNING }))).toThrow(
      /learning needs a wiki/,
    );
    expect(() =>
      memoryIntegrityPass(makeCli({ memory: { autoRecall: true }, learning: LEARNING })),
    ).toThrow(IrPassError);
    expect(() =>
      memoryIntegrityPass(makeCli({ memory: { wiki: { enabled: false } }, learning: LEARNING })),
    ).toThrow(IrPassError);
  });

  test("an empty learning.domain throws (direct-IR builders skip the zod bound)", () => {
    expect(() =>
      memoryIntegrityPass(
        makeCli({ memory: { wiki: { enabled: true } }, learning: { ...LEARNING, domain: "" } }),
      ),
    ).toThrow(/learning.domain/);
  });

  test("a non-JSON-serializable learning block throws", () => {
    expect(() =>
      memoryIntegrityPass(
        makeCli({
          memory: { wiki: { enabled: true } },
          learning: { ...LEARNING, curriculum: new Date() as unknown as string },
        }),
      ),
    ).toThrow(IrPassError);
  });

  test("shapes without the fabric fields pass through untouched", () => {
    const graph = {
      version: 0,
      name: "g",
      target: "graph",
      model: "m",
      entry: "a",
      nodes: [{ name: "a", instructions: "i", model: "m", tools: [], toolConfigs: {} }],
      edges: [],
      permissions: { rules: [] },
      compaction: {},
    } as unknown as IrNode;
    expect(memoryIntegrityPass(graph)).toBe(graph);
  });
});

describe("ir-passes — modelPlanIntegrity (0.6.0 PR 7)", () => {
  const POOL = {
    candidates: [
      { model: "claude-haiku-4-5", tags: ["cheap"], profile: "fast", tools: ["read"] },
      { model: "claude-opus-4-8", tags: ["strong"] },
    ],
    policy: "heuristic" as const,
  };

  test("no models / pools → returns input unchanged (byte-identity)", () => {
    const ir = makeCli();
    expect(modelPlanIntegrity(ir)).toBe(ir);
  });

  test("a well-formed registry + pool passes through unchanged", () => {
    const ir = makeCli({
      models: { fast: { profile: "fast", model: "claude-haiku-4-5", tags: ["cheap"] } },
      tools: ["read", "bash"],
      agent: {
        model: "m",
        instructions: "i",
        modelPool: {
          ...POOL,
          strategy: { cascade: { draft: "cheap", escalateTo: "fast" } },
          rules: [{ id: "r", when: { has_images: true }, use: "strong" }],
          reward: { floor: { arm: "strong" } },
        },
      },
    });
    expect(modelPlanIntegrity(ir)).toBe(ir);
  });

  test("candidate tools must be a subset of the block's tools (case-insensitive)", () => {
    const ir = makeCli({
      tools: ["Read"],
      agent: { model: "m", instructions: "i", modelPool: POOL },
    });
    expect(modelPlanIntegrity(ir)).toBe(ir);
    const bad = makeCli({
      tools: ["bash"],
      agent: { model: "m", instructions: "i", modelPool: POOL },
    });
    expect(() => modelPlanIntegrity(bad)).toThrow(IrPassError);
    expect(() => modelPlanIntegrity(bad)).toThrow(
      /candidates\[0\]\.tools\[0\]: "read" is not one of the block's tools/,
    );
  });

  test("MCP selectors must name a declared server; Consult / Escalate need strategy.modelDirected", () => {
    const mcp = {
      candidates: [
        { model: "a", tags: ["x"], tools: ["mcp__github__*"] },
        { model: "b", tags: ["y"] },
      ],
      policy: "static" as const,
    };
    const ok = makeCli({
      mcp_servers: { github: { transport: "stdio", command: "npx", args: [] } },
      agent: { model: "m", instructions: "i", modelPool: mcp },
    });
    expect(modelPlanIntegrity(ok)).toBe(ok);
    expect(() =>
      modelPlanIntegrity(makeCli({ agent: { model: "m", instructions: "i", modelPool: mcp } })),
    ).toThrow(/names MCP server "github", which mcp_servers does not declare/);
    const consult = {
      candidates: [
        { model: "a", tags: ["x"], tools: ["Escalate"] },
        { model: "b", tags: ["y"] },
      ],
      policy: "static" as const,
    };
    expect(() =>
      modelPlanIntegrity(makeCli({ agent: { model: "m", instructions: "i", modelPool: consult } })),
    ).toThrow(/registered only when a model_pool declares strategy\.model_directed/);
    const directed = makeCli({
      agent: {
        model: "m",
        instructions: "i",
        modelPool: { ...consult, strategy: { modelDirected: true } },
      },
    });
    expect(modelPlanIntegrity(directed)).toBe(directed);
  });

  test("a block without a tool catalog (pipeline) admits no candidate tools", () => {
    const pipeline = {
      version: 0,
      name: "p",
      target: "pipeline",
      agent: { model: "m", instructions: "i", modelPool: POOL },
      retrieve: { embedderModel: "e", vectorBackend: "in-memory", defaultK: 3 },
      indexing: { chunkStrategy: "fixed", chunkSize: 400, chunkOverlap: 0, documents: [] },
      permissions: { rules: [] },
      compaction: {},
    } as unknown as IrNode;
    expect(() => modelPlanIntegrity(pipeline)).toThrow(/registers no tool catalog/);
  });

  test("profile permissions are deny / ask ONLY", () => {
    const bad = makeCli({
      agent: {
        model: "m",
        instructions: "i",
        modelPool: {
          candidates: [
            {
              model: "a",
              tags: ["x"],
              permissions: { alwaysAllow: ["Bash(*)"] } as unknown as { deny?: string[] },
            },
            { model: "b", tags: ["y"] },
          ],
          policy: "static",
        },
      },
    });
    expect(() => modelPlanIntegrity(bad)).toThrow(
      /permissions\.alwaysAllow: a model profile's permissions may only NARROW/,
    );
  });

  test("enabled: false must leave a routable candidate", () => {
    const bad = makeCli({
      agent: {
        model: "m",
        instructions: "i",
        modelPool: {
          candidates: [
            { model: "a", tags: ["x"], enabled: false },
            { model: "b", tags: ["y"], enabled: false },
          ],
          policy: "static",
        },
      },
    });
    expect(() => modelPlanIntegrity(bad)).toThrow(/every candidate is enabled: false/);
  });

  test("strategy / rule / floor role slots name a declared tag or arm id; classifier ⇔ policy", () => {
    const withStrategy = (strategy: unknown, extra: Record<string, unknown> = {}): IrV0 =>
      makeCli({
        tools: ["read"],
        agent: {
          model: "m",
          instructions: "i",
          modelPool: { ...POOL, strategy, ...extra } as unknown as IrV0["agent"]["modelPool"],
        },
      });
    expect(() =>
      modelPlanIntegrity(withStrategy({ cascade: { draft: "cheap", escalateTo: "huge" } })),
    ).toThrow(/strategy\.cascade\.escalateTo: "huge" is neither a candidate tag/);
    expect(() =>
      modelPlanIntegrity(withStrategy({ committee: { members: ["cheap", "nope"] } })),
    ).toThrow(/committee\.members\[1\]/);
    expect(() =>
      modelPlanIntegrity(withStrategy(undefined, { reward: { floor: { arm: "ghost" } } })),
    ).toThrow(/reward\.floor\.arm/);
    expect(() =>
      modelPlanIntegrity(
        withStrategy(undefined, { rules: [{ id: "r", when: { has_images: true }, use: "ghost" }] }),
      ),
    ).toThrow(/rules\[0\]\.use/);
    expect(() => modelPlanIntegrity(withStrategy(undefined, { policy: "classifier" }))).toThrow(
      /requires a classifier block/,
    );
    expect(() =>
      modelPlanIntegrity(
        withStrategy(undefined, { classifier: { model: "c", labels: { nope: "x" } } }),
      ),
    ).toThrow(/classifier is declared but policy is "heuristic"/);
    expect(() =>
      modelPlanIntegrity(
        withStrategy(undefined, {
          policy: "classifier",
          classifier: { model: "c", labels: { nope: "x" } },
        }),
      ),
    ).toThrow(/classifier\.labels\["nope"\]/);
    // An arm id (the candidate's profile name) is a legal role-slot target.
    const arm = withStrategy({ cascade: { draft: "fast", escalateTo: "claude-opus-4-8" } });
    expect(modelPlanIntegrity(arm)).toBe(arm);
  });

  test("an unresolved $ref on a candidate or profile is refused (the compiler resolves every ref)", () => {
    expect(() =>
      modelPlanIntegrity(
        makeCli({
          agent: {
            model: "m",
            instructions: "i",
            modelPool: {
              candidates: [
                { model: "$fast", tags: [] },
                { model: "b", tags: [] },
              ],
              policy: "static",
            },
          },
        }),
      ),
    ).toThrow(/unresolved profile reference/);
    expect(() => modelPlanIntegrity(makeCli({ models: { Fast: { model: "m" } } }))).toThrow(
      /profile names must match/,
    );
  });

  test("the pool blob must survive a JSON round-trip (emitters stringify it)", () => {
    const bad = makeCli({
      agent: {
        model: "m",
        instructions: "i",
        modelPool: {
          candidates: [
            { model: "a", tags: ["x"], maxTokens: Number.NaN },
            { model: "b", tags: ["y"] },
          ],
          policy: "static",
        },
      },
    });
    expect(() => modelPlanIntegrity(bad)).toThrow(/not JSON-serializable/);
  });

  test("workflow steps, graph nodes, crew roles and sub-agents are all checked", () => {
    const step = {
      version: 0,
      name: "w",
      target: "workflow",
      steps: [
        {
          name: "draft",
          instructions: "x",
          model: "m",
          tools: ["read"],
          toolConfigs: {},
          modelPool: {
            candidates: [
              { model: "a", tags: ["x"], tools: ["bash"] },
              { model: "b", tags: ["y"] },
            ],
            policy: "static",
          },
        },
      ],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    } as unknown as IrNode;
    expect(() => modelPlanIntegrity(step)).toThrow(
      /steps\[0\]\.model_pool\.candidates\[0\]\.tools\[0\]/,
    );
    const sub = makeCli({
      tools: ["read", "bash"],
      subAgents: [
        {
          name: "helper",
          description: "d",
          instructions: "i",
          tools: ["read"],
          permissions: "inherit",
          inheritBypass: false,
          modelPool: {
            candidates: [
              { model: "a", tags: ["x"], tools: ["bash"] },
              { model: "b", tags: ["y"] },
            ],
            policy: "static",
          },
        },
      ],
    });
    expect(() => modelPlanIntegrity(sub)).toThrow(
      /agent\.sub_agents\.helper\.model_pool\.candidates\[0\]\.tools\[0\]/,
    );
  });
});

describe("ir-passes — deadToolElimination counts pool-candidate tools (0.6.0 PR 7)", () => {
  test("a tool only a candidate names survives elimination", () => {
    const ir = makeCli({
      tools: ["Read", "Write", "Bash"],
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Read" }] },
      agent: {
        model: "m",
        instructions: "i",
        modelPool: {
          candidates: [
            { model: "a", tags: ["x"], tools: ["Bash"] },
            { model: "b", tags: ["y"] },
          ],
          policy: "static",
        },
      },
    });
    const out = deadToolElimination(ir) as IrV0;
    expect([...out.tools].sort()).toEqual(["Bash", "Read"]);
  });
});
