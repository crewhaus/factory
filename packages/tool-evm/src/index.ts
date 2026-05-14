/**
 * Section 47 — `tool-evm`.
 *
 * Built-in read-only EVM tools. Each tool wraps a single JSON-RPC method
 * exposed by `chain-adapter-evm` and presents it to the model as a
 * typed, side-effect-free tool. Every tool is `readOnly: true` and
 * `classifyOutput: true` — the adapter already classified the raw
 * payload, but the second pass is the §41 "double-classify when in
 * doubt" stance: zero-cost cache hit + defense in depth.
 *
 * Catalog layer: R4 (built-in tool implementations). Slice 0 surface.
 * Destructive (signing) tools land in slice 1 as `@crewhaus/tool-evm-tx`.
 *
 * The tools require a `ChainAdapter` resolver — `getAdapter(chainId)`
 * — supplied by the runtime when the bundle boots. The resolver
 * pattern keeps the tools agnostic of how chains are configured
 * (whether the bundle uses `chain-adapter-evm` directly or a future
 * `chain-adapter-solana`). The bundle's `daemon.ts` wires the resolver
 * from the IR's `chains` block (see compiler / target emitters).
 */
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Resolver function the runtime injects at boot. Tools call this with
 * the user-provided `chainId` and receive a configured adapter for
 * that chain. The runtime is responsible for binding the resolver to
 * the bundle's `chains[]` IR block.
 *
 * In tests, provide an inline resolver returning a stub adapter.
 */
export type EvmAdapterResolver = (chainId: string) => ChainAdapter | undefined;

let resolver: EvmAdapterResolver | undefined;

/**
 * Bind the adapter resolver at boot. Generated daemons call this
 * before registering the tools. Tests call it inline.
 */
export function setEvmAdapterResolver(fn: EvmAdapterResolver): void {
  resolver = fn;
}

/**
 * Resolve an adapter for `chainId` or throw a descriptive error
 * pointing the user at the spec's `chains[]` block.
 */
function requireAdapter(chainId: string, toolName: string): ChainAdapter {
  if (resolver === undefined) {
    throw new Error(
      `${toolName}: no EvmAdapterResolver bound. The runtime must call setEvmAdapterResolver() at boot.`,
    );
  }
  const a = resolver(chainId);
  if (a === undefined) {
    throw new Error(
      `${toolName}: no chain adapter registered for chainId "${chainId}". Declare it in spec.chains[].`,
    );
  }
  return a;
}

const callSchema = z.object({
  chainId: z.string().min(1).describe("Id of the chain from spec.chains[]"),
  to: z.string().min(1).describe("Target contract address (0x-prefixed)"),
  data: z.string().min(1).describe("ABI-encoded calldata (0x-prefixed)"),
  blockTag: z
    .string()
    .min(1)
    .optional()
    .describe("Block tag: 'latest' | 'finalized' | 'safe' | hex block number"),
});

export const evmCall: RegisteredTool = buildTool({
  name: "EvmCall",
  description:
    "Execute a read-only EVM `eth_call` against a contract. Returns the ABI-encoded result as a hex string. Use for view/pure functions like `balanceOf`, `allowance`, `getOwner`. For writes, see tool-evm-tx (slice 1).",
  inputSchema: callSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = requireAdapter(input.chainId, "EvmCall");
    const result = await a.rpcRead("eth_call", [
      { to: input.to, data: input.data },
      input.blockTag ?? "latest",
    ]);
    return typeof result === "string" ? result : JSON.stringify(result);
  },
});

const getLogsSchema = z.object({
  chainId: z.string().min(1),
  address: z.string().min(1).optional().describe("Contract address to filter logs by"),
  fromBlock: z.string().min(1).describe("Starting block (hex or 'earliest')"),
  toBlock: z.string().min(1).describe("Ending block (hex or 'latest')"),
  topics: z
    .array(z.union([z.string(), z.array(z.string()), z.null()]))
    .optional()
    .describe("Topic filters; topic[0] is the event signature hash"),
});

export const evmGetLogs: RegisteredTool = buildTool({
  name: "EvmGetLogs",
  description:
    "Fetch event logs matching the given filter. Returns an array of decoded log entries. The agent should normally request a bounded block range (≤ 5000 blocks) to avoid timeouts.",
  inputSchema: getLogsSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = requireAdapter(input.chainId, "EvmGetLogs");
    const filter: Record<string, unknown> = {
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    };
    if (input.address !== undefined) filter["address"] = input.address;
    if (input.topics !== undefined) filter["topics"] = input.topics;
    const result = await a.rpcRead("eth_getLogs", [filter]);
    return JSON.stringify(result);
  },
});

const getTxSchema = z.object({
  chainId: z.string().min(1),
  txHash: z.string().min(1).describe("Transaction hash (0x-prefixed, 32 bytes)"),
});

export const evmGetTransaction: RegisteredTool = buildTool({
  name: "EvmGetTransaction",
  description:
    "Look up an EVM transaction by hash. Returns the transaction envelope (from, to, value, input, gas, status). Combine with EvmGetTransactionReceipt for confirmation count.",
  inputSchema: getTxSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = requireAdapter(input.chainId, "EvmGetTransaction");
    const result = await a.rpcRead("eth_getTransactionByHash", [input.txHash]);
    return JSON.stringify(result);
  },
});

export const evmGetTransactionReceipt: RegisteredTool = buildTool({
  name: "EvmGetTransactionReceipt",
  description:
    "Fetch the receipt for a transaction hash. Includes status (0x1 success / 0x0 revert), gasUsed, logs, and blockNumber. Use blockNumber + EvmBlockNumber to compute confirmation count for finality checks.",
  inputSchema: getTxSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = requireAdapter(input.chainId, "EvmGetTransactionReceipt");
    const result = await a.rpcRead("eth_getTransactionReceipt", [input.txHash]);
    return JSON.stringify(result);
  },
});

const getBalanceSchema = z.object({
  chainId: z.string().min(1),
  address: z.string().min(1),
  blockTag: z.string().min(1).optional(),
});

export const evmGetBalance: RegisteredTool = buildTool({
  name: "EvmGetBalance",
  description:
    "Read the native-token balance of an address (in wei, hex-encoded). For ERC-20 balances use EvmCall against the token contract's `balanceOf(address)` method.",
  inputSchema: getBalanceSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = requireAdapter(input.chainId, "EvmGetBalance");
    const result = await a.rpcRead("eth_getBalance", [input.address, input.blockTag ?? "latest"]);
    return typeof result === "string" ? result : JSON.stringify(result);
  },
});

const blockNumberSchema = z.object({
  chainId: z.string().min(1),
});

export const evmBlockNumber: RegisteredTool = buildTool({
  name: "EvmBlockNumber",
  description:
    "Return the latest block number on the chain (hex-encoded). Use for finality and confirmation-count calculations.",
  inputSchema: blockNumberSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = requireAdapter(input.chainId, "EvmBlockNumber");
    const result = await a.rpcRead("eth_blockNumber", []);
    return typeof result === "string" ? result : JSON.stringify(result);
  },
});

/**
 * The complete slice-0 EVM tool bundle. Generated daemons import this
 * record by name; the IR's `tools[]` allowlist filters which entries
 * end up in the final tool catalog.
 */
export const EVM_TOOL_MAP = {
  evmCall,
  evmGetLogs,
  evmGetTransaction,
  evmGetTransactionReceipt,
  evmGetBalance,
  evmBlockNumber,
} as const;
