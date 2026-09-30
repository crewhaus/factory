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
 *     supplied executor, behind the justification gate.
 *
 * Both kinds cross the network — a read is an `eth_call` to the chain's RPC
 * endpoint, a write is a broadcast to a public ledger — so both declare
 * `scope: "external"` and `ioCapability: "network"`, exactly as `EvmCall`
 * and `EvmSendTransaction`, the tools they stand in for, do.
 *
 * The gateway does NOT itself call the chain or sign anything; it
 * produces `RegisteredTool` records that delegate to runtime executors.
 * Codegen wires the executors at boot.
 *
 * Catalog layer: R4 (built-in tool implementations). Slice 1.
 *
 * Slice-1 scope: ABI parsing + tool emission. Calldata ABI-encoding is
 * a separate concern delegated to the read/write executors so we don't
 * pull a full ABI encoder into the compile-time path. Each executor is
 * handed the function's canonical `signature` and four-byte `selector`,
 * so it can encode the right overload of a name the ABI declares twice.
 *
 * A function the gateway cannot turn into a tool that means one thing is
 * left out when the tools are generated, with the reason, rather than
 * failing when a model first calls it: a type no encoder knows, an input
 * whose name a write tool already uses for its own fields (`walletId`,
 * `justification` — the intent gate's — and `value` on a payable function),
 * an input named like something every object inherits (`toString`), two
 * inputs of one function that would share a key, and a signature the ABI
 * lists twice in different ways. Only that function is left out: the rest
 * of the ABI still becomes tools, and `onSkipped` hears which were not and
 * why. An ABI none of whose functions can be generated is refused with a
 * {@link ContractToolError}. A function listed twice identically (a merged
 * ABI) is one function.
 */
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import { JUSTIFICATION_INPUT_FIELD, type RegisteredTool } from "@crewhaus/tool-catalog";
import { canonicalFunction } from "@crewhaus/tool-onchain";
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

/** An ABI the gateway cannot turn into tools, named when the tools are generated. */
export class ContractToolError extends CrewhausError {
  override readonly name = "ContractToolError";
  constructor(message: string) {
    super("tool", message);
  }
}

/**
 * Read executor — wires the generated tool to `tool-evm`'s `EvmCall`.
 * Codegen supplies one of these at boot; tests inline a stub.
 *
 * `methodName` alone cannot say which overload was meant; `signature` (the
 * canonical `name(type,…)`) and `selector` (`0x` + 8 hex) can.
 */
export type ReadExecutor = (args: {
  readonly chainId: string;
  readonly to: string;
  readonly methodName: string;
  readonly signature: string;
  readonly selector: string;
  readonly inputs: ReadonlyArray<unknown>;
}) => Promise<unknown>;

/**
 * Write executor — wires the generated tool to `tool-evm-tx`'s
 * `EvmSendTransaction`. Returns the JSON-stringified receipt envelope.
 * `value` is only ever present for a payable function.
 */
export type WriteExecutor = (args: {
  readonly walletId: string;
  readonly chainId: string;
  readonly contractId: string;
  readonly to: string;
  readonly methodName: string;
  readonly signature: string;
  readonly selector: string;
  readonly inputs: ReadonlyArray<unknown>;
  readonly value?: string;
}) => Promise<string>;

/** A function left out of the generated tools, and why. */
export type SkippedFunction = {
  /** `name(type,…)` as the ABI writes it (canonical when it could be worked out). */
  readonly signature: string;
  /** One sentence naming the contract, the function and the reason. */
  readonly reason: string;
};

/** One ABI function, with what the generator worked out about it. */
type PlannedFunction = {
  readonly fn: AbiFunction;
  readonly toolName: string;
  readonly signature: string;
  readonly selector: string;
  readonly overloaded: boolean;
  /** The input-schema key of each ABI input, in ABI order. */
  readonly keys: ReadonlyArray<string>;
};

/**
 * Top-level generator. Produces tools named `<contractId>__<methodName>`,
 * or `<contractId>__<methodName>_<selector>` for every function whose name
 * the ABI declares more than once (the selector's 8 hex digits, so which
 * overload gets which name never depends on the order the ABI lists them).
 * Returns an array (preserves ABI order for deterministic codegen output).
 *
 * A function that cannot be a tool that means one thing is left out and
 * reported to `onSkipped`; throws {@link ContractToolError} when that leaves
 * no tool at all from an ABI that has functions.
 */
export function generateContractTools(args: {
  readonly contract: ContractBinding;
  readonly abi: ReadonlyArray<AbiItem>;
  readonly readExecutor: ReadExecutor;
  readonly writeExecutor: WriteExecutor;
  /** Hears each function left out, with the reason. */
  readonly onSkipped?: (skipped: SkippedFunction) => void;
}): RegisteredTool[] {
  const functions = args.abi.filter((item): item is AbiFunction => item.type === "function");
  const skipped: SkippedFunction[] = [];
  const plans = planFunctions(args.contract, functions, skipped);
  for (const s of skipped) args.onSkipped?.(s);
  if (plans.length === 0 && skipped.length > 0) {
    throw new ContractToolError(skipped.map((s) => s.reason).join("; "));
  }
  return plans.map((plan) =>
    plan.fn.stateMutability === "view" || plan.fn.stateMutability === "pure"
      ? buildReadTool(args.contract, plan, args.readExecutor)
      : buildWriteTool(args.contract, plan, args.writeExecutor),
  );
}

/** A Solidity identifier, which is what an input's key must be. */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function planFunctions(
  contract: ContractBinding,
  functions: ReadonlyArray<AbiFunction>,
  skipped: SkippedFunction[],
): PlannedFunction[] {
  // Every function's canonical signature first: one no encoder can read is
  // left out here, and the rest are grouped by what they are.
  const bySignature = new Map<
    string,
    { readonly selector: string; readonly entries: Array<{ fn: AbiFunction; json: string }> }
  >();
  for (const fn of functions) {
    const written = `${fn.name}(${fn.inputs.map((p) => typeString(p)).join(",")})`;
    let id: { signature: string; selector: string };
    try {
      id = canonicalFunction(written);
    } catch (err) {
      skipped.push({
        signature: written,
        reason: `${contract.id}: the ABI's function ${written} cannot be encoded — ${(err as Error).message}`,
      });
      continue;
    }
    const group = bySignature.get(id.signature) ?? { selector: id.selector, entries: [] };
    group.entries.push({ fn, json: stableJson(fn) });
    bySignature.set(id.signature, group);
  }

  // A signature listed twice alike (a merged ABI) is one function; listed
  // twice differently, which entry is true cannot be told, so neither is
  // made a tool.
  const unique: Array<{ fn: AbiFunction; signature: string; selector: string }> = [];
  for (const [signature, group] of bySignature) {
    const first = group.entries[0] as { fn: AbiFunction; json: string };
    if (group.entries.some((e) => e.json !== first.json)) {
      skipped.push({
        signature,
        reason: `${contract.id}: the ABI lists ${signature} ${group.entries.length} times, not all alike, so which one is true cannot be told — remove the wrong entry`,
      });
      continue;
    }
    unique.push({ fn: first.fn, signature, selector: group.selector });
  }

  const declared = new Map<string, number>();
  for (const { fn } of unique) declared.set(fn.name, (declared.get(fn.name) ?? 0) + 1);

  const plans: PlannedFunction[] = [];
  const byToolName = new Map<string, string>();
  for (const { fn, signature, selector } of unique) {
    const overloaded = (declared.get(fn.name) ?? 0) > 1;
    const toolName = overloaded
      ? `${contract.id}__${fn.name}_${selector.slice(2)}`
      : `${contract.id}__${fn.name}`;
    const clash = byToolName.get(toolName);
    if (clash !== undefined) {
      // Two overloads whose selectors share their digits: neither name would
      // say which one it calls.
      skipped.push({
        signature,
        reason: `${contract.id}: ${clash} and ${signature} would both be the tool "${toolName}" — rename one of them in the ABI passed to generateContractTools`,
      });
      continue;
    }
    let keys: string[];
    try {
      keys = inputKeys(contract, fn, signature);
    } catch (err) {
      if (!(err instanceof ContractToolError)) throw err;
      skipped.push({ signature, reason: err.message });
      continue;
    }
    byToolName.set(toolName, signature);
    plans.push({ fn, toolName, signature, selector, overloaded, keys });
  }
  // ABI order, as before, whatever order the groups were read in.
  const order = new Map(functions.map((fn, i) => [fn, i]));
  return plans.sort((a, b) => (order.get(a.fn) ?? 0) - (order.get(b.fn) ?? 0));
}

/** JSON with object keys sorted, so two ABI entries alike compare alike. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The type as it appears in a signature: a `tuple` is written out as its
 * components, keeping any array suffix (`tuple[]` → `(address,uint256)[]`).
 */
function typeString(param: AbiParam): string {
  const tuple = /^tuple((?:\[\d*\])*)$/.exec(param.type);
  if (tuple === null) return param.type;
  const components = param.components ?? [];
  return `(${components.map((c) => typeString(c)).join(",")})${tuple[1]}`;
}

/**
 * The key each ABI input is read from, in ABI order: its name, or `arg<i>`
 * for an unnamed one. Two inputs that would share a key, and an input whose
 * key a write tool already uses for its own fields, are refused — the one
 * key would otherwise feed both, and a signing wallet's id or a native-token
 * amount would be sent as a contract argument, or the other way round.
 */
function inputKeys(contract: ContractBinding, fn: AbiFunction, signature: string): string[] {
  // A write tool is justification-gated, and the gate reads its text from
  // the call's own `justification` field: an ABI input of that name would be
  // both what the judge reads and what is signed and broadcast.
  const reserved = new Set<string>(
    fn.stateMutability === "view" || fn.stateMutability === "pure"
      ? []
      : fn.stateMutability === "payable"
        ? ["walletId", JUSTIFICATION_INPUT_FIELD, "value"]
        : ["walletId", JUSTIFICATION_INPUT_FIELD],
  );
  const where = `${contract.id}: ${signature}`;
  const seen = new Map<string, number>();
  return fn.inputs.map((param, i) => {
    const key = param.name || `arg${i}`;
    if (!IDENTIFIER_RE.test(key) || key === "__proto__") {
      throw new ContractToolError(
        `${where}: input ${i} is named "${key}", which is not an argument name a tool can take`,
      );
    }
    // Every object inherits `toString`, `constructor`, `valueOf`…: the input
    // parser reads such a key as present when the call leaves it out, and
    // the executor was handed Object.prototype's function as the argument.
    if (key in Object.prototype) {
      throw new ContractToolError(
        `${where}: input ${i} is named "${key}", a name every object inherits, so a call that leaves it out would still carry a value — rename the input in the ABI passed to generateContractTools`,
      );
    }
    if (reserved.has(key)) {
      throw new ContractToolError(
        `${where}: input ${i} is named "${key}", which the generated write tool already takes as ${
          key === "walletId"
            ? "the signing wallet's id"
            : key === JUSTIFICATION_INPUT_FIELD
              ? "the reason the intent gate judges before it runs"
              : "the native-token amount to send"
        }, so one field would carry both — leave this function out of the ABI passed to generateContractTools, or rename the input there`,
      );
    }
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw new ContractToolError(
        `${where}: inputs ${earlier} and ${i} would both be read from the key "${key}"`,
      );
    }
    seen.set(key, i);
    return key;
  });
}

function buildInputSchema(plan: PlannedFunction): z.ZodObject<z.ZodRawShape> {
  // Map each ABI input to a permissive z.unknown() with a description
  // so the model sees the names + types. The read/write executor is
  // responsible for ABI-encoding the runtime values; pushing strict
  // type validation into the gateway is a follow-up. v0 is structural.
  const shape: Record<string, z.ZodTypeAny> = {};
  plan.fn.inputs.forEach((param, i) => {
    shape[plan.keys[i] as string] = z
      .unknown()
      .describe(`${param.type}${param.name ? ` (${param.name})` : ""}`);
  });
  return z.object(shape);
}

function paramsArray(
  plan: PlannedFunction,
  input: Record<string, unknown>,
): ReadonlyArray<unknown> {
  return plan.keys.map((key) => input[key]);
}

/** What the model reads: the call, and which overload it is when there are several. */
function describeCall(contract: ContractBinding, plan: PlannedFunction): string {
  const { fn } = plan;
  const call = `${contract.id}.${fn.name}(${fn.inputs.map((i) => `${i.type} ${i.name}`).join(", ")})`;
  return plan.overloaded
    ? `${call} — the overload ${plan.signature}, selector ${plan.selector}`
    : call;
}

function buildReadTool(
  contract: ContractBinding,
  plan: PlannedFunction,
  readExecutor: ReadExecutor,
): RegisteredTool {
  const { fn } = plan;
  return buildTool({
    name: plan.toolName,
    description: `${fn.stateMutability} call on ${describeCall(contract, plan)} → (${fn.outputs.map((o) => o.type).join(", ")})`,
    inputSchema: buildInputSchema(plan),
    readOnly: true,
    concurrencySafe: true,
    // An eth_call carries the model's arguments to the chain's RPC endpoint,
    // as EvmCall does.
    scope: "external",
    ioCapability: "network",
    execute: async (input) => {
      const result = await readExecutor({
        chainId: contract.chainId,
        to: contract.address,
        methodName: fn.name,
        signature: plan.signature,
        selector: plan.selector,
        inputs: paramsArray(plan, input as Record<string, unknown>),
      });
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  });
}

function buildWriteTool(
  contract: ContractBinding,
  plan: PlannedFunction,
  writeExecutor: WriteExecutor,
): RegisteredTool {
  const { fn } = plan;
  const payable = fn.stateMutability === "payable";
  const writeSchema = buildInputSchema(plan).extend({
    walletId: z.string().min(1).describe("Id of the signing wallet from spec.wallets[]"),
    ...(payable
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
    name: plan.toolName,
    description: `${fn.stateMutability} call on ${describeCall(contract, plan)}. Routes through wallet-engine: simulate → policy → approval → sign → broadcast.`,
    inputSchema: writeSchema,
    destructive: true,
    classifyOutput: true,
    // Broadcasting writes to a public ledger over the network, and it moves
    // value irreversibly: the same flags EvmSendTransaction carries, the
    // justification gate included.
    scope: "external",
    ioCapability: "network",
    requireJustification: true,
    execute: async (input) => {
      const i = input as Record<string, unknown>;
      const walletId = i["walletId"];
      if (typeof walletId !== "string") {
        throw new Error(`${plan.toolName}: walletId is required`);
      }
      // Only a payable function sends native value. A nonpayable one's
      // `value` key is an ABI argument (OpenZeppelin's ERC-20 names the
      // transfer amount `value`), never an amount of ether.
      const value = payable && typeof i["value"] === "string" ? (i["value"] as string) : undefined;
      const args: Parameters<WriteExecutor>[0] = {
        walletId,
        chainId: contract.chainId,
        contractId: contract.id,
        to: contract.address,
        methodName: fn.name,
        signature: plan.signature,
        selector: plan.selector,
        inputs: paramsArray(plan, i),
        ...(value !== undefined ? { value } : {}),
      };
      return writeExecutor(args);
    },
  });
}
