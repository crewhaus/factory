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
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type {
  TransactionPolicy,
  UnsignedTx,
  WalletConfig,
  WalletEngine,
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

function requireWallet(walletId: string, toolName: string): WalletConfig {
  if (walletResolver === undefined) {
    throw new Error(
      `${toolName}: no WalletResolver bound. The runtime must call setWalletResolver() at boot.`,
    );
  }
  const w = walletResolver(walletId);
  if (w === undefined) {
    throw new Error(
      `${toolName}: no wallet registered for walletId "${walletId}". Declare it in spec.wallets[].`,
    );
  }
  return w;
}

function requirePolicy(toolName: string): TransactionPolicy {
  if (policyResolver === undefined) {
    throw new Error(
      `${toolName}: no TransactionPolicyResolver bound. The runtime must call setTransactionPolicyResolver() at boot.`,
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
      `${toolName}: no WalletEngine bound. The runtime must call setWalletEngineResolver() at boot.`,
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
  description:
    "Sign and broadcast an EVM transaction. Goes through the wallet-engine flow: simulate, enforce transaction_policy, prompt approval, sign via custody adapter, broadcast, fetch receipt. Returns the tx hash plus block + status when the receipt is available.",
  inputSchema: sendTxSchema,
  destructive: true,
  classifyOutput: true,
  // Pillar 3 sink-side: broadcasting a tx writes data permanently to a
  // public ledger — the most-external sink we have.
  scope: "external",
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
