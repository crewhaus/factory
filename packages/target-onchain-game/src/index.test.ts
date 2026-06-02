import { describe, expect, test } from "bun:test";
import type { IrChainGameV0 } from "@crewhaus/ir";
import { TargetEmitError, emitOnchainGame } from "./index";

function baseIr(overrides: Partial<IrChainGameV0> = {}): IrChainGameV0 {
  return {
    version: 0,
    name: "tic-tac-toe-agent",
    target: "onchain-game",
    agent: { model: "claude-opus-4-7", instructions: "Play optimal moves." },
    chain: {
      id: "base-sepolia",
      kind: "evm",
      rpcUrls: [{ kind: "env", name: "BASE_SEPOLIA_RPC" }],
      rpcPolicy: "single",
      finality: { kind: "confirmations", count: 1 },
      reorgTolerant: true,
    },
    wallet: {
      id: "player",
      chainId: "base-sepolia",
      custody: "local",
      signingPolicy: "automated",
      keyRef: { kind: "env", name: "PLAYER_KEY" },
    },
    game: {
      contract: {
        id: "tictactoe",
        chainId: "base-sepolia",
        address: "0xgame",
        abiRef: "abi://tictactoe",
      },
      stateReader: "9af14a16",
      turnSemantics: "turn-based",
      objective: "Win or draw — never lose.",
    },
    transactionPolicy: {
      defaultWriteApproval: "policy",
      allowedContracts: ["tictactoe"],
      simulationRequired: true,
    },
    tools: [],
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    compaction: {},
    ...overrides,
  };
}

describe("emitOnchainGame — happy path", () => {
  test("emits a single agent.ts with game metadata", () => {
    const bundle = emitOnchainGame(baseIr());
    expect(bundle.files).toHaveLength(1);
    const file = bundle.files[0];
    expect(file?.path).toBe("agent.ts");
    expect(file?.content).toContain('SPEC_NAME = "tic-tac-toe-agent"');
    expect(file?.content).toContain('AGENT_MODEL = "claude-opus-4-7"');
    expect(file?.content).toContain('AGENT_INSTRUCTIONS = "Play optimal moves."');
    expect(file?.content).toContain('chainId: "base-sepolia"');
    expect(file?.content).toContain('id: "tictactoe"');
    expect(file?.content).toContain('stateReader: "9af14a16"');
    expect(file?.content).toContain('turnSemantics: "turn-based"');
    expect(file?.content).toContain('objective: "Win or draw');
    expect(file?.content).toContain("createEvmAdapter");
    expect(file?.content).toContain("classifyBoundary");
    expect(file?.content).toContain('origin: "chain"');
  });

  test("wallet keyRef env-secret renders as process.env lookup", () => {
    const bundle = emitOnchainGame(baseIr());
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('process.env["PLAYER_KEY"]');
  });

  test("renders the transaction_policy literal", () => {
    const bundle = emitOnchainGame(baseIr());
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('"allowedContracts":["tictactoe"]');
    expect(c).toContain('"simulationRequired":true');
  });

  // #151 activation — the single game contract is resolved into the policy's
  // contractId -> address map so the wallet-engine binds tx.to.
  test("populates transaction_policy.contractAddresses from the game contract", () => {
    const bundle = emitOnchainGame(baseIr());
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('"contractAddresses":{"tictactoe":"0xgame"}');
  });

  // #159 (CWE-798) — a kms:// / hsm:// key handle is a permitted literal.
  test("renders a kms:// keyRef handle verbatim", () => {
    const bundle = emitOnchainGame(
      baseIr({
        wallet: {
          id: "player",
          chainId: "base-sepolia",
          custody: "kms",
          signingPolicy: "automated",
          keyRef: { kind: "literal", value: "kms://aws/player-key" },
        },
      }),
    );
    const c = bundle.files[0]?.content ?? "";
    expect(c).toContain('"kms://aws/player-key"');
  });
});

describe("emitOnchainGame — validation", () => {
  test("rejects when wallet.chainId differs from chain.id", () => {
    expect(() =>
      emitOnchainGame(
        baseIr({
          wallet: {
            id: "player",
            chainId: "polygon-mainnet",
            custody: "local",
            signingPolicy: "automated",
            keyRef: { kind: "env", name: "PLAYER_KEY" },
          },
        }),
      ),
    ).toThrow(TargetEmitError);
  });

  test("rejects when game.contract.chainId differs from chain.id", () => {
    const ir = baseIr();
    expect(() =>
      emitOnchainGame({
        ...ir,
        game: {
          ...ir.game,
          contract: { ...ir.game.contract, chainId: "polygon-mainnet" },
        },
      }),
    ).toThrow(TargetEmitError);
  });

  test("rejects real-time games without moveTimeoutMs", () => {
    const ir = baseIr();
    expect(() =>
      emitOnchainGame({
        ...ir,
        game: { ...ir.game, turnSemantics: "real-time" },
      }),
    ).toThrow(/moveTimeoutMs/);
  });

  // #159 (CWE-798) — a literal (raw hex private key) wallet keyRef must not be
  // baked into the emitted artifact.
  test("rejects a literal (hex private key) wallet keyRef", () => {
    expect(() =>
      emitOnchainGame(
        baseIr({
          wallet: {
            id: "player",
            chainId: "base-sepolia",
            custody: "local",
            signingPolicy: "automated",
            keyRef: {
              kind: "literal",
              value: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
            },
          },
        }),
      ),
    ).toThrow(TargetEmitError);
  });
});
