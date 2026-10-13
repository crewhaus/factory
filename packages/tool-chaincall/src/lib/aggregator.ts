/**
 * Which Multicall3 answers a batch — decided by the operator, never by a call.
 *
 * A batch is ONE `eth_call` to Multicall3, and every row in it — each view
 * call's return data, whether it succeeded, the block number the batch pins —
 * is whatever that contract returns. Any contract can implement `aggregate3`
 * and return rows it made up. So a model-supplied `multicall3Address` was a
 * way to make EvmMulticall report a balance nobody holds as `success: true`,
 * ContractInspect report interfaces a contract never claimed, and
 * EvmSimulateBundle's balance tracking report deltas that never happened.
 *
 * The aggregator is the canonical deployment unless the operator names
 * another for that chain in `tool_config.chaincall.multicall3` (a chain whose
 * Multicall3 is elsewhere, such as zkSync Era). A call may still pass
 * `multicall3Address`, which older callers do, but only the address that
 * would be used anyway is accepted; anything else is refused before a read.
 * This is `@crewhaus/tool-token`'s rule, applied to this package's batches.
 */
import { MULTICALL3_ADDRESS, parseMulticallMap } from "@crewhaus/tool-onchain";
import { ChainCallError } from "./rpc";

/** Who served a batch, as every batched answer reports it. */
export type Aggregator = {
  /** EIP-55. */
  readonly address: string;
  /** `canonical`: the deterministic deploy. `config`: the operator's tool_config. */
  readonly source: "canonical" | "config";
};

/** The spec's `tool_config.chaincall` block. */
export type ChaincallConfigInput = {
  /** chain id → the Multicall3 deployment batches on that chain go to. */
  readonly multicall3?: Readonly<Record<string, string>>;
};

/**
 * The operator's Multicall3 deployments by chain id, from
 * `tool_config.chaincall.multicall3`. Only {@link registerChaincallConfig}
 * writes it.
 */
let configured: ReadonlyMap<string, string> = new Map();

function parseChaincallMulticall(input: unknown): ReadonlyMap<string, string> {
  try {
    return parseMulticallMap(input, "tool_config.chaincall.multicall3");
  } catch (err) {
    throw new ChainCallError((err as Error).message);
  }
}

/**
 * Apply `tool_config.chaincall` at boot: the Multicall3 deployments in
 * `multicall3`, each held to the address check (shape and EIP-55 checksum).
 * A block without it leaves every chain on the canonical deployment.
 */
export function registerChaincallConfig(input: ChaincallConfigInput): void {
  const block = (input ?? {}) as Record<string, unknown>;
  configured = parseChaincallMulticall(block["multicall3"]);
}

/**
 * The map one call runs under: the serving candidate's own `tool_config`
 * block when it has one (it replaces the boot registration, as every
 * tool_config block does), else the boot registration.
 */
function mapFor(toolConfig: unknown): ReadonlyMap<string, string> {
  if (typeof toolConfig === "object" && toolConfig !== null && !Array.isArray(toolConfig)) {
    return parseChaincallMulticall((toolConfig as Record<string, unknown>)["multicall3"]);
  }
  return configured;
}

/**
 * The aggregator a batch on `chainId` goes to, and where that came from. A
 * `requested` address other than that one is refused: which contract answers
 * every row is not a per-call choice.
 */
export function resolveAggregator(
  chainId: string,
  requested: string | undefined,
  toolConfig: unknown,
  toolName: string,
): Aggregator {
  const override = mapFor(toolConfig).get(chainId);
  const aggregator: Aggregator =
    override === undefined
      ? { address: MULTICALL3_ADDRESS, source: "canonical" }
      : { address: override, source: "config" };
  if (
    requested !== undefined &&
    requested.trim().toLowerCase() !== aggregator.address.toLowerCase()
  ) {
    throw new ChainCallError(
      `${toolName}: multicall3Address ${JSON.stringify(requested.slice(0, 64))} is not the Multicall3 chain "${chainId}" reads through (${aggregator.address}). The aggregator answers every row of a batch — return data, success, the block number — so which contract that is belongs to the operator: name it in tool_config.chaincall.multicall3 for chain "${chainId}", and leave multicall3Address out.`,
    );
  }
  return aggregator;
}
