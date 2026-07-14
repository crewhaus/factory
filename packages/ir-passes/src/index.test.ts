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
  applyPasses,
  deadToolElimination,
  memoryIntegrityPass,
  permissionRuleCanonicalize,
  promptCachePrefixSort,
  redundantMcpServerCollapse,
  transactionPolicyEnforcement,
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

  test("DEFAULT_PIPELINE has 7 passes (+ memoryIntegrityPass from v0.3.0 PR 11)", () => {
    expect(DEFAULT_PIPELINE.length).toBe(7);
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
