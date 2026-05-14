import { describe, expect, test } from "bun:test";
import type { IrChainV0 } from "@crewhaus/ir";
import { TargetEmitError, emitOnchain } from "./index";

function baseIr(overrides: Partial<IrChainV0> = {}): IrChainV0 {
  return {
    version: 0,
    name: "treasury-watch",
    target: "onchain",
    agent: { model: "claude-opus-4-7", instructions: "Watch the treasury." },
    chains: [
      {
        id: "base-mainnet",
        kind: "evm",
        rpcUrls: [{ kind: "env", name: "BASE_RPC" }],
        rpcPolicy: "single",
        finality: { kind: "confirmations", count: 12 },
        reorgTolerant: true,
      },
    ],
    wallets: [],
    contracts: [
      {
        id: "treasury",
        chainId: "base-mainnet",
        address: "0xtreasury",
        abiRef: "abi://safe",
      },
    ],
    transactionPolicy: {
      defaultWriteApproval: "required",
      allowedContracts: [],
      simulationRequired: true,
    },
    triggers: [
      {
        kind: "event",
        chainId: "base-mainnet",
        contract: "treasury",
        event: "ExecutionSuccess",
      },
    ],
    idempotencyWindowMs: 60_000,
    tools: [],
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    compaction: {},
    ...overrides,
  };
}

describe("emitOnchain — happy path", () => {
  test("emits a single agent.ts with the daemon metadata", () => {
    const bundle = emitOnchain(baseIr());
    expect(bundle.files).toHaveLength(1);
    const file = bundle.files[0];
    expect(file?.path).toBe("agent.ts");
    expect(file?.content).toContain('SPEC_NAME = "treasury-watch"');
    expect(file?.content).toContain('AGENT_MODEL = "claude-opus-4-7"');
    expect(file?.content).toContain('AGENT_INSTRUCTIONS = "Watch the treasury."');
    expect(file?.content).toContain("IDEMPOTENCY_WINDOW_MS = 60000");
    expect(file?.content).toContain('chainId: "base-mainnet"');
    expect(file?.content).toContain("createEvmAdapter");
    expect(file?.content).toContain('event: "ExecutionSuccess"');
    expect(file?.content).toContain("classifyBoundary");
    expect(file?.content).toContain('origin: "chain"');
  });

  test("env-ref secrets render as process.env lookups", () => {
    const bundle = emitOnchain(baseIr());
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('process.env["BASE_RPC"]');
    expect(content).toContain("missing required env var BASE_RPC");
  });

  test("literal secrets render verbatim", () => {
    const ir = baseIr();
    const firstChain = ir.chains[0];
    if (firstChain === undefined) throw new Error("baseIr should produce a chain");
    const bundle = emitOnchain({
      ...ir,
      chains: [
        {
          ...firstChain,
          rpcUrls: [{ kind: "literal", value: "https://rpc.example.com" }],
        },
      ],
    });
    expect(bundle.files[0]?.content).toContain("https://rpc.example.com");
  });

  test("renders the three trigger kinds", () => {
    const bundle = emitOnchain(
      baseIr({
        triggers: [
          {
            kind: "event",
            chainId: "base-mainnet",
            contract: "treasury",
            event: "ExecutionSuccess",
          },
          { kind: "block", chainId: "base-mainnet", scanIntervalMs: 30_000 },
          {
            kind: "address",
            chainId: "base-mainnet",
            address: "0xwhale",
            direction: "both",
          },
        ],
      }),
    );
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('kind: "event"');
    expect(c).toContain('kind: "block"');
    expect(c).toContain('kind: "address"');
    expect(c).toContain("scanIntervalMs: 30000");
    expect(c).toContain('direction: "both"');
  });

  test("renders transaction_policy literal", () => {
    const bundle = emitOnchain(
      baseIr({
        transactionPolicy: {
          defaultWriteApproval: "required",
          allowedContracts: ["treasury"],
          simulationRequired: true,
          maxValueUsd: 5000,
        },
      }),
    );
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('"allowedContracts":["treasury"]');
    expect(c).toContain('"maxValueUsd":5000');
  });
});

describe("emitOnchain — validation", () => {
  test("rejects empty chains[]", () => {
    expect(() => emitOnchain(baseIr({ chains: [] }))).toThrow(TargetEmitError);
  });

  test("rejects empty triggers[]", () => {
    expect(() => emitOnchain(baseIr({ triggers: [] }))).toThrow(TargetEmitError);
  });

  test("rejects a trigger that references an undeclared chainId", () => {
    expect(() =>
      emitOnchain(
        baseIr({
          triggers: [{ kind: "block", chainId: "polygon-mainnet", scanIntervalMs: 10_000 }],
        }),
      ),
    ).toThrow(/not declared in chains/);
  });
});
