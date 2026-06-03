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

  // #151 activation — the policy must carry a resolved contractId -> address
  // map so the wallet-engine can bind tx.to to the declared contract.
  test("populates transaction_policy.contractAddresses from declared contracts[]", () => {
    const bundle = emitOnchain(
      baseIr({
        contracts: [
          { id: "treasury", chainId: "base-mainnet", address: "0xTREASURY", abiRef: "abi://safe" },
          { id: "vault", chainId: "base-mainnet", address: "0xVAULT", abiRef: "abi://erc20" },
        ],
      }),
    );
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('"contractAddresses":{"treasury":"0xTREASURY","vault":"0xVAULT"}');
  });

  test("omits contractAddresses when no contracts are declared", () => {
    const bundle = emitOnchain(baseIr({ contracts: [] }));
    const c = bundle.files[0]?.content ?? "";
    expect(c).not.toContain("contractAddresses");
  });

  // #159 (CWE-798) — a wallet keyRef that is an env ref or a kms:// / hsm://
  // handle is fine; a bare literal (esp. a raw hex private key) must not be
  // baked into the emitted artifact.
  test("renders a wallet env-ref keyRef as a process.env lookup", () => {
    const bundle = emitOnchain(
      baseIr({
        wallets: [
          {
            id: "treasurer",
            chainId: "base-mainnet",
            custody: "kms",
            signingPolicy: "policy-gated",
            keyRef: { kind: "env", name: "TREASURER_KEY" },
          },
        ],
      }),
    );
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('process.env["TREASURER_KEY"]');
  });

  test("renders a kms:// keyRef handle verbatim", () => {
    const bundle = emitOnchain(
      baseIr({
        wallets: [
          {
            id: "treasurer",
            chainId: "base-mainnet",
            custody: "kms",
            signingPolicy: "policy-gated",
            keyRef: { kind: "literal", value: "kms://aws/treasurer-key" },
          },
        ],
      }),
    );
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('"kms://aws/treasurer-key"');
  });

  test("rejects a literal (hex private key) wallet keyRef", () => {
    expect(() =>
      emitOnchain(
        baseIr({
          wallets: [
            {
              id: "treasurer",
              chainId: "base-mainnet",
              custody: "local",
              signingPolicy: "automated",
              keyRef: {
                kind: "literal",
                value: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
              },
            },
          ],
        }),
      ),
    ).toThrow(TargetEmitError);
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

describe("emitOnchain — spec-name codegen injection (#147)", () => {
  test("a crafted name cannot break out of the header comment", () => {
    // Block-comment escape: a `*/` (plus a newline) in the name would, with a
    // raw `/* … */` header, terminate the comment and inject top-level code.
    const evil = "safe */ globalThis.__PWNED_ONCHAIN__ = 1; /*\nmore";
    const content = emitOnchain(baseIr({ name: evil })).files[0]?.content ?? "";
    // Header is now a `//` line comment using the JSON-escaped name.
    expect(content).toMatch(/^\/\/ Compiled from spec:/m);
    // The payload only ever appears inside the escaped SPEC_NAME string and the
    // comment — never as a top-level statement at column 0.
    expect(content).not.toMatch(/^globalThis\.__PWNED_ONCHAIN__/m);
    expect(content).not.toContain("*/\nglobalThis");
  });
});
