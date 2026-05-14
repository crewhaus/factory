/**
 * Section 47 — `tool-contract-gateway`.
 *
 * Compile-time ABI → typed tool generator. Given a parsed ABI plus a
 * contract binding (chainId, address, id), emits one tool per function:
 *
 *   - `stateMutability: "view" | "pure"` → `readOnly: true` tool that
 *     ABI-encodes calldata and dispatches `EvmCall` semantics via the
 *     supplied executor.
 *   - everything else → `destructive: true` tool that builds calldata
 *     and dispatches the wallet-engine sign-and-broadcast flow via the
 *     supplied executor.
 *
 * The gateway does NOT itself call the chain or sign anything; it
 * produces `RegisteredTool` records that delegate to runtime executors.
 * Codegen wires the executors at boot.
 *
 * Catalog layer: R4 (built-in tool implementations). Slice 1.
 *
 * Slice-1 scope: ABI parsing + tool emission. Calldata ABI-encoding is
 * a separate concern delegated to the read/write executors so we don't
 * pull a full ABI encoder into the compile-time path (a follow-up slice
 * may add a deterministic encoder here for the simple types — uint256,
 * address, bool, bytes — that cover the vast majority of contract calls).
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * A single ABI input or output. Mirrors the Solidity ABI JSON.
 */
export type AbiParam = {
  readonly name: string;
  readonly type: string;
  readonly internalType?: string;
  readonly components?: ReadonlyArray<AbiParam>;
};

export type AbiFunction = {
  readonly type: "function";
  readonly name: string;
  readonly inputs: ReadonlyArray<AbiParam>;
  readonly outputs: ReadonlyArray<AbiParam>;
  readonly stateMutability: "pure" | "view" | "nonpayable" | "payable";
};

export type AbiEvent = {
  readonly type: "event";
  readonly name: string;
  readonly inputs: ReadonlyArray<AbiParam & { readonly indexed?: boolean }>;
  readonly anonymous?: boolean;
};

export type AbiItem =
  | AbiFunction
  | AbiEvent
  | { readonly type: "constructor" | "fallback" | "receive" };

/**
 * Contract binding mirroring the IR `IrContractBinding`. The gateway
 * doesn't depend on `@crewhaus/ir` (keeps the runtime dep arrow
 * clean); codegen passes the lowered shape directly.
 */
export type ContractBinding = {
  readonly id: string;
  readonly chainId: string;
  readonly address: string;
};

/**
 * Read executor — wires the generated tool to `tool-evm`'s `EvmCall`.
 * Codegen supplies one of these at boot; tests inline a stub.
 */
export type ReadExecutor = (args: {
  readonly chainId: string;
  readonly to: string;
  readonly methodName: string;
  readonly inputs: ReadonlyArray<unknown>;
}) => Promise<unknown>;

/**
 * Write executor — wires the generated tool to `tool-evm-tx`'s
 * `EvmSendTransaction`. Returns the JSON-stringified receipt envelope.
 */
export type WriteExecutor = (args: {
  readonly walletId: string;
  readonly chainId: string;
  readonly contractId: string;
  readonly to: string;
  readonly methodName: string;
  readonly inputs: ReadonlyArray<unknown>;
  readonly value?: string;
}) => Promise<string>;

/**
 * Top-level generator. Produces tools named `<contractId>__<methodName>`.
 * Returns an array (preserves ABI order for deterministic codegen
 * output).
 */
export function generateContractTools(args: {
  readonly contract: ContractBinding;
  readonly abi: ReadonlyArray<AbiItem>;
  readonly readExecutor: ReadExecutor;
  readonly writeExecutor: WriteExecutor;
}): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  for (const item of args.abi) {
    if (item.type !== "function") continue;
    const fn = item as AbiFunction;
    if (fn.stateMutability === "view" || fn.stateMutability === "pure") {
      tools.push(buildReadTool(args.contract, fn, args.readExecutor));
    } else {
      tools.push(buildWriteTool(args.contract, fn, args.writeExecutor));
    }
  }
  return tools;
}

function buildInputSchema(fn: AbiFunction): z.ZodTypeAny {
  // Map each ABI input to a permissive z.unknown() with a description
  // so the model sees the names + types. The read/write executor is
  // responsible for ABI-encoding the runtime values; pushing strict
  // type validation into the gateway is a follow-up. v0 is structural.
  const shape: Record<string, z.ZodTypeAny> = {};
  for (let i = 0; i < fn.inputs.length; i++) {
    const param = fn.inputs[i];
    if (param === undefined) continue;
    const key = param.name || `arg${i}`;
    shape[key] = z.unknown().describe(`${param.type}${param.name ? ` (${param.name})` : ""}`);
  }
  return z.object(shape);
}

function paramsArray(fn: AbiFunction, input: Record<string, unknown>): ReadonlyArray<unknown> {
  const out: unknown[] = [];
  for (let i = 0; i < fn.inputs.length; i++) {
    const param = fn.inputs[i];
    if (param === undefined) continue;
    const key = param.name || `arg${i}`;
    out.push(input[key]);
  }
  return out;
}

function buildReadTool(
  contract: ContractBinding,
  fn: AbiFunction,
  exec: ReadExecutor,
): RegisteredTool {
  const inputSchema = buildInputSchema(fn);
  return buildTool({
    name: `${contract.id}__${fn.name}`,
    description: `${fn.stateMutability} call on ${contract.id}.${fn.name}(${fn.inputs.map((i) => `${i.type} ${i.name}`).join(", ")}) → (${fn.outputs.map((o) => o.type).join(", ")})`,
    inputSchema,
    readOnly: true,
    concurrencySafe: true,
    execute: async (input) => {
      const result = await exec({
        chainId: contract.chainId,
        to: contract.address,
        methodName: fn.name,
        inputs: paramsArray(fn, input as Record<string, unknown>),
      });
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  });
}

function buildWriteTool(
  contract: ContractBinding,
  fn: AbiFunction,
  exec: WriteExecutor,
): RegisteredTool {
  const baseSchema = buildInputSchema(fn);
  const writeSchema = (baseSchema as z.ZodObject<z.ZodRawShape>).extend({
    walletId: z.string().min(1).describe("Id of the signing wallet from spec.wallets[]"),
    ...(fn.stateMutability === "payable"
      ? {
          value: z
            .string()
            .min(1)
            .optional()
            .describe("Native-token value to send, hex wei (0x-prefixed)"),
        }
      : {}),
  });
  return buildTool({
    name: `${contract.id}__${fn.name}`,
    description: `${fn.stateMutability} call on ${contract.id}.${fn.name}(${fn.inputs.map((i) => `${i.type} ${i.name}`).join(", ")}). Routes through wallet-engine: simulate → policy → approval → sign → broadcast.`,
    inputSchema: writeSchema,
    destructive: true,
    classifyOutput: true,
    execute: async (input) => {
      const i = input as Record<string, unknown>;
      const walletId = i["walletId"];
      if (typeof walletId !== "string") {
        throw new Error(`${contract.id}__${fn.name}: walletId is required`);
      }
      const value = typeof i["value"] === "string" ? (i["value"] as string) : undefined;
      const args: Parameters<WriteExecutor>[0] = {
        walletId,
        chainId: contract.chainId,
        contractId: contract.id,
        to: contract.address,
        methodName: fn.name,
        inputs: paramsArray(fn, i),
        ...(value !== undefined ? { value } : {}),
      };
      return exec(args);
    },
  });
}
