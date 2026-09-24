/**
 * Section 47 — `tool-evm-tx`.
 *
 * Destructive EVM transaction tools. Each tool is `destructive: true`
 * so the §7 permission engine auto-gates the call behind an approval
 * prompt; the tool's `execute` then runs the unsigned tx through the
 * §47 `wallet-engine` flow (simulate → static-policy check → approval
 * → custody sign → broadcast → receipt).
 *
 * Catalog layer: R4 (built-in tool implementations). Slice 1.
 *
 * Why the wallet-engine indirection is mandatory: the permission engine
 * gates *whether* the tool may run; the wallet engine enforces *what
 * the tx may do* (allowed contracts, max value, simulation required).
 * Both layers run; the wallet-engine refuses even if a permission rule
 * blanket-allows the tool, and the permission engine refuses even if
 * the transaction-policy is permissive. Two-of-two gates by design.
 */
import { CHAINS_BLOCK_EXAMPLE, type ChainAdapterConfig } from "@crewhaus/chain-adapter-base";
import { createEvmAdapters } from "@crewhaus/chain-adapter-evm";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type TransactionPolicy,
  type UnsignedTx,
  type WalletConfig,
  type WalletEngine,
  createWalletEngine,
} from "@crewhaus/wallet-engine";
import { z } from "zod";

/**
 * Resolver pattern matching `tool-evm`. The runtime binds these
 * resolvers at boot from the IR's `wallets[]`, `transaction_policy`,
 * and the engine factory. Tests inline.
 */
export type WalletResolver = (walletId: string) => WalletConfig | undefined;
export type TransactionPolicyResolver = () => TransactionPolicy | undefined;
export type WalletEngineResolver = () => WalletEngine | undefined;

let walletResolver: WalletResolver | undefined;
let policyResolver: TransactionPolicyResolver | undefined;
let engineResolver: WalletEngineResolver | undefined;

export function setWalletResolver(fn: WalletResolver): void {
  walletResolver = fn;
}
export function setTransactionPolicyResolver(fn: TransactionPolicyResolver): void {
  policyResolver = fn;
}
export function setWalletEngineResolver(fn: WalletEngineResolver): void {
  engineResolver = fn;
}

/** What a spec writes to give these tools a wallet — quoted by every refusal about it. */
const WALLETS_EXAMPLE = `wallets: [{ id: ops, chainId: "1", custody: user-controlled }] beside ${CHAINS_BLOCK_EXAMPLE}`;

/** The spec's chain blocks, as a bundle hands them over at boot. */
export type EvmTxChainConfig = {
  readonly chains: ReadonlyArray<ChainAdapterConfig>;
  readonly wallets?: ReadonlyArray<Omit<WalletConfig, "keyRef">>;
  readonly contracts?: ReadonlyArray<{ readonly id: string; readonly address: string }>;
  readonly transactionPolicy?: Omit<TransactionPolicy, "contractAddresses">;
};

/**
 * Bind the three resolvers from the spec's `chains`, `wallets`, `contracts`
 * and `transaction_policy` blocks — what every generated bundle, `crewhaus
 * run` and `crewhaus eval` call at boot when a spec lists one of these tools.
 *
 * The engine's own approval step always answers "deny": no custody provider
 * that can sign ships in this release, so a broadcast cannot happen whatever
 * it answers, and `EvmSimulate` never reaches that step. Nothing here reads a
 * wallet's `keyRef`.
 */
export function bindEvmTxChains(config: EvmTxChainConfig): void {
  const adapters = createEvmAdapters(config.chains);
  const wallets = new Map((config.wallets ?? []).map((w) => [w.id, w]));
  const contractAddresses: Record<string, string> = {};
  for (const c of config.contracts ?? []) contractAddresses[c.id] = c.address;
  const policy: TransactionPolicy | undefined =
    config.transactionPolicy === undefined
      ? undefined
      : {
          ...config.transactionPolicy,
          ...(Object.keys(contractAddresses).length > 0 ? { contractAddresses } : {}),
        };
  const engine = createWalletEngine({
    resolveAdapter: (chainId) => adapters.get(chainId),
    approve: async () => "deny",
  });
  setWalletResolver((walletId) => wallets.get(walletId));
  setTransactionPolicyResolver(() => policy);
  setWalletEngineResolver(() => engine);
}

function requireWallet(walletId: string, toolName: string): WalletConfig {
  if (walletResolver === undefined) {
    throw new Error(
      `${toolName}: no chain or wallet is configured. Declare them in the spec — ${WALLETS_EXAMPLE}.`,
    );
  }
  const w = walletResolver(walletId);
  if (w === undefined) {
    throw new Error(
      `${toolName}: no wallet "${walletId}" is declared. Add it to the spec's wallets block — ${WALLETS_EXAMPLE}.`,
    );
  }
  return w;
}

function requirePolicy(toolName: string): TransactionPolicy {
  if (policyResolver === undefined) {
    throw new Error(
      `${toolName}: no chain or wallet is configured. Declare them in the spec — ${WALLETS_EXAMPLE}.`,
    );
  }
  const p = policyResolver();
  if (p === undefined) {
    throw new Error(
      `${toolName}: no transaction_policy declared. Add a transaction_policy block to the spec.`,
    );
  }
  return p;
}

function requireEngine(toolName: string): WalletEngine {
  if (engineResolver === undefined) {
    throw new Error(
      `${toolName}: no chain or wallet is configured. Declare them in the spec — ${WALLETS_EXAMPLE}.`,
    );
  }
  const e = engineResolver();
  if (e === undefined) {
    throw new Error(`${toolName}: WalletEngine resolver returned undefined.`);
  }
  return e;
}

const sendTxSchema = z.object({
  walletId: z.string().min(1).describe("Id of the wallet from spec.wallets[]"),
  contractId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Id of the target contract from spec.contracts[]. Required when transaction_policy.allowedContracts is non-empty.",
    ),
  to: z.string().min(1).describe("Target contract address (0x-prefixed)"),
  data: z.string().min(1).describe("ABI-encoded calldata (0x-prefixed)"),
  value: z
    .string()
    .min(1)
    .optional()
    .describe("Native-token value to send, hex-encoded wei (0x-prefixed). Defaults to 0."),
  gasLimit: z
    .string()
    .min(1)
    .optional()
    .describe("Hex-encoded gas limit. Adapter estimates if omitted."),
});

export const evmSendTransaction: RegisteredTool = buildTool({
  name: "EvmSendTransaction",
  // The address the transaction goes to is what a rule scopes:
  // `EvmSendTransaction(0xabc…)` allows one counterparty. It is a
  // `recipient`, a destination the model picks, as the egress fabric has
  // always treated it.
  operativeArgs: [{ field: "to", kind: "recipient" }],
  description:
    "Sign and broadcast an EVM transaction. Goes through the wallet-engine flow: simulate, enforce transaction_policy, prompt approval, sign via custody adapter, broadcast, fetch receipt. Returns the tx hash plus block + status when the receipt is available.",
  inputSchema: sendTxSchema,
  destructive: true,
  classifyOutput: true,
  // Pillar 3 sink-side: broadcasting a tx writes data permanently to a
  // public ledger — the most-external sink we have.
  scope: "external",
  // FR-002 — declare the io-capability fact (RPC broadcast over the network).
  ioCapability: "network",
  // Pillar 3 intent gate: tx broadcast is destructive AND irreversible AND
  // costs money. Mandatory justification gate.
  requireJustification: true,
  execute: async (input) => {
    const wallet = requireWallet(input.walletId, "EvmSendTransaction");
    const policy = requirePolicy("EvmSendTransaction");
    const engine = requireEngine("EvmSendTransaction");
    const tx: UnsignedTx = {
      chainId: wallet.chainId,
      walletId: wallet.id,
      to: input.to,
      data: input.data,
      ...(input.contractId !== undefined ? { contractId: input.contractId } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.gasLimit !== undefined ? { gasLimit: input.gasLimit } : {}),
    };
    const receipt = await engine.requestSignAndBroadcast({ tx, policy, wallet });
    return JSON.stringify({
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
    });
  },
});

const simulateSchema = z.object({
  walletId: z.string().min(1),
  to: z.string().min(1),
  data: z.string().min(1),
  value: z.string().min(1).optional(),
});

export const evmSimulate: RegisteredTool = buildTool({
  name: "EvmSimulate",
  description:
    "Simulate an EVM transaction without broadcasting. Useful as a pre-flight check before requesting approval. Returns success, gasUsed, returnData, and (if failed) revertReason. No state mutation.",
  inputSchema: simulateSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const wallet = requireWallet(input.walletId, "EvmSimulate");
    const engine = requireEngine("EvmSimulate");
    const tx: UnsignedTx = {
      chainId: wallet.chainId,
      walletId: wallet.id,
      to: input.to,
      data: input.data,
      ...(input.value !== undefined ? { value: input.value } : {}),
    };
    const sim = await engine.simulate({ tx });
    return JSON.stringify({
      success: sim.success,
      gasUsed: sim.gasUsed,
      returnData: sim.returnData,
      revertReason: sim.revertReason,
    });
  },
});

export const EVM_TX_TOOL_MAP = {
  evmSendTransaction,
  evmSimulate,
} as const;
