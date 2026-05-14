/**
 * Section 47 — `permission-tokengated`.
 *
 * Token-gated entitlement resolver. Reads a `TokenGatedSpec` (chain,
 * contract, requirement) plus the user's wallet address, queries the
 * chain via the supplied `ChainAdapter`, and emits a concrete
 * `PermissionRule` (`alwaysAllow` or `alwaysDeny`). The runtime calls
 * `resolveTokenGatedRules()` at session boot, folds the resolved rules
 * into the `RuleSet.builtin` source, and from then on the standard
 * `permission-engine.evaluate()` makes the per-call decision.
 *
 * Why this lives outside `permission-engine`: chain lookups are async,
 * permission-engine's `evaluate()` is sync, and adding a chain dep to
 * permission-engine would pull R5 (`chain-adapter-base`) upstream of
 * R8's permission core. Keeping the resolver in its own package lets
 * the dep arrow stay R4/R5 → R8 (R8 doesn't depend on R5).
 *
 * Catalog layer: R8 (extension of permission-engine; not a rewrite).
 * Slice 1.
 *
 * Pillar 3: chain reads go through `ChainAdapter`, which already runs
 * the §41 classifier — by the time this resolver sees a `balanceOf`
 * return value, the boundary has been checked.
 */
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
import { CrewhausError } from "@crewhaus/errors";
import type { PermissionRule } from "@crewhaus/permission-engine";

export class TokenGatedError extends CrewhausError {
  override readonly name = "TokenGatedError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * One token-gating directive. Authoring example:
 *
 *   permissions:
 *     tokenGated:
 *       - allowTools: ["EvmCall", "EvmGetLogs"]
 *         chainId: base-mainnet
 *         contract: usdc
 *         requirement: { kind: "balanceOf", minBalanceWei: "1000000" }
 *
 * The runtime resolves each entry into one rule per tool in
 * `allowTools`. If the requirement holds, the rules are `alwaysAllow`;
 * if it fails, `alwaysDeny`; if the chain query fails outright, the
 * resolver throws (fail-closed — never silently grant access).
 */
export type TokenGatedRequirement =
  | {
      readonly kind: "balanceOf";
      /** Minimum balance, decimal-string wei. */
      readonly minBalanceWei: string;
    }
  | {
      readonly kind: "ownerOf";
      /** Specific tokenId the wallet must own (decimal string). */
      readonly tokenId: string;
    }
  | {
      readonly kind: "hasAny";
      /** Wallet must own at least one of any tokenId in the contract (ERC-721 balanceOf > 0). */
    };

export type TokenGatedSpec = {
  /** Tool names this rule grants/denies access to. */
  readonly allowTools: readonly string[];
  readonly chainId: string;
  readonly contractAddress: string;
  readonly walletAddress: string;
  readonly requirement: TokenGatedRequirement;
};

/**
 * Resolve a single token-gating directive to a set of permission rules.
 * Returns one rule per entry in `allowTools`. The rule's `source` is
 * `"builtin"` so it sits at the lowest priority — explicit user rules
 * (flag / settings / yaml / hooks) can still override.
 */
export async function resolveTokenGated(
  spec: TokenGatedSpec,
  adapter: ChainAdapter,
): Promise<PermissionRule[]> {
  if (spec.allowTools.length === 0) {
    throw new TokenGatedError("tokenGated.allowTools must be non-empty");
  }
  if (adapter.chainId !== spec.chainId) {
    throw new TokenGatedError(
      `adapter.chainId "${adapter.chainId}" does not match tokenGated.chainId "${spec.chainId}"`,
    );
  }
  const passes = await evaluateRequirement(spec, adapter);
  const type = passes ? "alwaysAllow" : "alwaysDeny";
  return spec.allowTools.map((toolName) => ({
    type,
    pattern: toolName,
    source: "builtin" as const,
  }));
}

/**
 * Resolve a list of token-gating directives. Each directive picks its
 * own adapter via the supplied resolver. Returns the flat concatenation
 * of resolved rules; a failure on any directive aborts the whole
 * resolution (fail-closed).
 */
export async function resolveTokenGatedRules(
  specs: ReadonlyArray<TokenGatedSpec>,
  resolveAdapter: (chainId: string) => ChainAdapter | undefined,
): Promise<PermissionRule[]> {
  const out: PermissionRule[] = [];
  for (const s of specs) {
    const a = resolveAdapter(s.chainId);
    if (a === undefined) {
      throw new TokenGatedError(
        `no chain adapter registered for chainId "${s.chainId}" (tokenGated needs reads)`,
      );
    }
    const rules = await resolveTokenGated(s, a);
    out.push(...rules);
  }
  return out;
}

async function evaluateRequirement(spec: TokenGatedSpec, adapter: ChainAdapter): Promise<boolean> {
  switch (spec.requirement.kind) {
    case "balanceOf":
      return await checkBalanceOf(spec, adapter, spec.requirement.minBalanceWei);
    case "ownerOf":
      return await checkOwnerOf(spec, adapter, spec.requirement.tokenId);
    case "hasAny":
      return await checkBalanceOf(spec, adapter, "1");
  }
}

/** keccak("balanceOf(address)") = 0x70a08231 */
const BALANCE_OF_SELECTOR = "0x70a08231";
/** keccak("ownerOf(uint256)") = 0x6352211e */
const OWNER_OF_SELECTOR = "0x6352211e";

function pad32(hex: string): string {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  return stripped.padStart(64, "0");
}

async function checkBalanceOf(
  spec: TokenGatedSpec,
  adapter: ChainAdapter,
  minBalanceWei: string,
): Promise<boolean> {
  const owner = spec.walletAddress.startsWith("0x")
    ? spec.walletAddress.slice(2)
    : spec.walletAddress;
  const data = `${BALANCE_OF_SELECTOR}${pad32(`0x${owner}`)}`;
  const raw = await adapter.rpcRead("eth_call", [{ to: spec.contractAddress, data }, "latest"]);
  if (typeof raw !== "string") {
    throw new TokenGatedError("eth_call returned non-string for balanceOf");
  }
  const balance = hexToBigInt(raw);
  const required = decimalToBigInt(minBalanceWei);
  return balance >= required;
}

async function checkOwnerOf(
  spec: TokenGatedSpec,
  adapter: ChainAdapter,
  tokenId: string,
): Promise<boolean> {
  const data = `${OWNER_OF_SELECTOR}${pad32(decimalToHex(tokenId))}`;
  let raw: unknown;
  try {
    raw = await adapter.rpcRead("eth_call", [{ to: spec.contractAddress, data }, "latest"]);
  } catch {
    // ERC-721 ownerOf reverts for non-existent tokens — treat as "not the owner".
    return false;
  }
  if (typeof raw !== "string") return false;
  // ownerOf returns an address right-padded into a 32-byte word. The
  // address is the last 20 bytes (40 hex chars).
  const stripped = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (stripped.length < 64) return false;
  const owner = `0x${stripped.slice(24).toLowerCase()}`;
  const wallet = spec.walletAddress.toLowerCase();
  return owner === wallet;
}

function hexToBigInt(hex: string): bigint {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length === 0) return 0n;
  return BigInt(`0x${stripped}`);
}

function decimalToBigInt(decimal: string): bigint {
  if (!/^[0-9]+$/.test(decimal)) {
    throw new TokenGatedError(`expected decimal string, got "${decimal}"`);
  }
  return BigInt(decimal);
}

function decimalToHex(decimal: string): string {
  return decimalToBigInt(decimal).toString(16);
}
