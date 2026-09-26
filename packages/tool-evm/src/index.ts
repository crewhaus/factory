/**
 * Section 47 — `tool-evm`.
 *
 * Built-in read-only EVM tools. Each tool wraps a single JSON-RPC method
 * exposed by `chain-adapter-evm` and presents it to the model as a typed
 * tool that changes nothing on chain. Every tool is `readOnly: true` and
 * `classifyOutput: true` — the adapter already classified the raw
 * payload, but the second pass is the §41 "double-classify when in
 * doubt" stance: zero-cost cache hit + defense in depth.
 *
 * Permission rules scope these tools by chain AND contract, account or
 * transaction: a rule's argument is `<chainId>/<address-or-hash>`, so
 * `EvmCall(1/0xdAC17F…)` is USDT on mainnet, `EvmCall(**0xdAC17F…)` is that
 * address on any chain, and `EvmGetLogs(1/*)` every log query on mainnet.
 * A bare `EvmCall(0xdAC17F…)` or `EvmGetLogs(*)` matches nothing — `*` does
 * not cross the `/`; write `**` for "any". A deny or ask ignores the letter
 * case of the hex (EIP-55 case is only a checksum).
 *
 * Read-only is not offline: every call sends its arguments (EvmCall's
 * calldata among them) to the chain's RPC endpoint. So every tool is
 * `scope: "external"` with `ioCapability: "network"`, which is what puts
 * the call in front of the egress classifier and the strict scope audit,
 * and passes the call's signal to the adapter, so a cancelled call does not
 * leave its read running.
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
import {
  CHAINS_BLOCK_EXAMPLE,
  type ChainAdapter,
  type ChainAdapterConfig,
  type RpcReadOptions,
} from "@crewhaus/chain-adapter-base";
import { createEvmAdapters } from "@crewhaus/chain-adapter-evm";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
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
 * Bind the adapter resolver. A compiled bundle binds it at boot through
 * {@link bindEvmChains}, from the spec's `chains` block. Tests call it
 * inline.
 */
export function setEvmAdapterResolver(fn: EvmAdapterResolver): void {
  resolver = fn;
}

/**
 * Bind the resolver from the spec's `chains` block — what every generated
 * bundle, `crewhaus run` and `crewhaus eval` call at boot when a spec lists
 * one of these tools. One adapter per declared chain.
 */
export function bindEvmChains(config: {
  readonly chains: ReadonlyArray<ChainAdapterConfig>;
}): void {
  const adapters = createEvmAdapters(config.chains);
  setEvmAdapterResolver((chainId) => adapters.get(chainId));
}

/**
 * What every tool here declares: it changes nothing, and it crosses the
 * network to reach the chain's RPC endpoint.
 */
const RPC_READ = {
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
} as const;

/** The call's cancellation, handed to the adapter. */
function readOptions(ctx: ToolExecuteContext | undefined): RpcReadOptions {
  return ctx?.signal === undefined ? {} : { signal: ctx.signal };
}

/**
 * Resolve an adapter for `chainId` or throw a descriptive error
 * pointing the user at the spec's `chains[]` block.
 */
function requireAdapter(chainId: string, toolName: string): ChainAdapter {
  if (resolver === undefined) {
    throw new Error(
      `${toolName}: no chain is configured. Declare one in the spec — ${CHAINS_BLOCK_EXAMPLE}.`,
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
  operativeArgs: [{ field: "to", kind: "id", within: "chainId" }],
  description:
    "Execute a read-only EVM `eth_call` against a contract. Returns the ABI-encoded result as a hex string. Use for view/pure functions like `balanceOf`, `allowance`, `getOwner`. For writes, see tool-evm-tx (slice 1).",
  inputSchema: callSchema,
  ...RPC_READ,
  execute: async (input, ctx) => {
    const a = requireAdapter(input.chainId, "EvmCall");
    const result = await a.rpcRead(
      "eth_call",
      [{ to: input.to, data: input.data }, input.blockTag ?? "latest"],
      readOptions(ctx),
    );
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
  // A call without `address` reads EVERY contract's logs, the broadest query
  // there is, so it must carry a value a rule can see: it is matched as
  // `<chainId>/*`, which `EvmGetLogs(1/*)` and `EvmGetLogs(**)` cover.
  operativeArgs: [{ field: "address", kind: "id", within: "chainId", default: "*" }],
  description:
    "Fetch event logs matching the given filter. Returns an array of decoded log entries. The agent should normally request a bounded block range (≤ 5000 blocks) to avoid timeouts.",
  inputSchema: getLogsSchema,
  ...RPC_READ,
  execute: async (input, ctx) => {
    const a = requireAdapter(input.chainId, "EvmGetLogs");
    const filter: Record<string, unknown> = {
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    };
    if (input.address !== undefined) filter["address"] = input.address;
    if (input.topics !== undefined) filter["topics"] = input.topics;
    const result = await a.rpcRead("eth_getLogs", [filter], readOptions(ctx));
    return JSON.stringify(result);
  },
});

const getTxSchema = z.object({
  chainId: z.string().min(1),
  txHash: z.string().min(1).describe("Transaction hash (0x-prefixed, 32 bytes)"),
});

export const evmGetTransaction: RegisteredTool = buildTool({
  name: "EvmGetTransaction",
  operativeArgs: [{ field: "txHash", kind: "id", within: "chainId" }],
  description:
    "Look up an EVM transaction by hash. Returns the transaction envelope (from, to, value, input, gas, status). Combine with EvmGetTransactionReceipt for confirmation count.",
  inputSchema: getTxSchema,
  ...RPC_READ,
  execute: async (input, ctx) => {
    const a = requireAdapter(input.chainId, "EvmGetTransaction");
    const result = await a.rpcRead("eth_getTransactionByHash", [input.txHash], readOptions(ctx));
    return JSON.stringify(result);
  },
});

export const evmGetTransactionReceipt: RegisteredTool = buildTool({
  name: "EvmGetTransactionReceipt",
  operativeArgs: [{ field: "txHash", kind: "id", within: "chainId" }],
  description:
    "Fetch the receipt for a transaction hash. Includes status (0x1 success / 0x0 revert), gasUsed, logs, and blockNumber. Use blockNumber + EvmBlockNumber to compute confirmation count for finality checks.",
  inputSchema: getTxSchema,
  ...RPC_READ,
  execute: async (input, ctx) => {
    const a = requireAdapter(input.chainId, "EvmGetTransactionReceipt");
    const result = await a.rpcRead("eth_getTransactionReceipt", [input.txHash], readOptions(ctx));
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
  operativeArgs: [{ field: "address", kind: "id", within: "chainId" }],
  description:
    "Read the native-token balance of an address (in wei, hex-encoded). For ERC-20 balances use EvmCall against the token contract's `balanceOf(address)` method.",
  inputSchema: getBalanceSchema,
  ...RPC_READ,
  execute: async (input, ctx) => {
    const a = requireAdapter(input.chainId, "EvmGetBalance");
    const result = await a.rpcRead(
      "eth_getBalance",
      [input.address, input.blockTag ?? "latest"],
      readOptions(ctx),
    );
    return typeof result === "string" ? result : JSON.stringify(result);
  },
});

const blockNumberSchema = z.object({
  chainId: z.string().min(1),
});

export const evmBlockNumber: RegisteredTool = buildTool({
  name: "EvmBlockNumber",
  operativeArgs: [{ field: "chainId", kind: "id" }],
  description:
    "Return the latest block number on the chain (hex-encoded). Use for finality and confirmation-count calculations.",
  inputSchema: blockNumberSchema,
  ...RPC_READ,
  execute: async (input, ctx) => {
    const a = requireAdapter(input.chainId, "EvmBlockNumber");
    const result = await a.rpcRead("eth_blockNumber", [], readOptions(ctx));
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
