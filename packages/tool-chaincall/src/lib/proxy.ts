/**
 * Telling a proxy from a contract, and a fact from a claim.
 *
 * Proxy detection has no single specification. Four different mechanisms are
 * in wide use and they disagree about where the implementation address even
 * lives, so this file reports SIGNALS and only then tries to reconcile them:
 *
 *   - **EIP-1967** puts it in a fixed storage slot. That is state, read with
 *     `eth_getStorageAt`, and it is a fact about the contract.
 *   - **EIP-1967 beacon** puts a beacon address in a different fixed slot;
 *     the implementation is whatever that beacon's `implementation()`
 *     returns right now, which makes it a fact plus one hop.
 *   - **EIP-1167** carries the target inside the runtime bytecode. Also a
 *     fact, and the only one that does not need a second read.
 *   - **EIP-1822** uses `keccak256("PROXIABLE")` as the slot.
 *
 * And **EIP-2535 diamonds** have no single implementation at all: each
 * selector routes to a different facet. There is no address to report, so
 * none is invented — the answer is "unresolved, and here is why", because a
 * wrong implementation address means the caller fetches the wrong ABI and
 * every call it composes afterwards is wrong.
 *
 * ERC-165 is on the other side of the line. `supportsInterface` is the
 * contract answering a question about itself, and a contract can lie or
 * simply be wrong. It is never reported as verification.
 */

/** `keccak256("eip1967.proxy.implementation") - 1`. */
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** `keccak256("eip1967.proxy.admin") - 1`. */
export const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/** `keccak256("eip1967.proxy.beacon") - 1`. */
export const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

/** `keccak256("PROXIABLE")`, the EIP-1822 slot. */
export const EIP1822_SLOT = "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bec8";

/**
 * The EIP-1167 minimal proxy's runtime code, with the 20-byte target between
 * the two halves. 45 bytes exactly.
 */
const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

/**
 * Read an EIP-1167 clone's target out of its bytecode, or null.
 *
 * Only the canonical form matches. The optimized "vanity" variants that
 * shave bytes by pushing a shorter address do not, and a near-match is
 * reported as no match rather than as a guess: these 45 bytes are the one
 * place a proxy's target can be read with no second call, so a pattern that
 * is almost right is a pattern whose address is almost right.
 */
export function minimalProxyTarget(code: string): string | null {
  const body = code.replace(/^0x/, "").toLowerCase();
  if (body.length !== EIP1167_PREFIX.length + 40 + EIP1167_SUFFIX.length) return null;
  if (!body.startsWith(EIP1167_PREFIX) || !body.endsWith(EIP1167_SUFFIX)) return null;
  return `0x${body.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40)}`;
}

/**
 * Interface ids this package probes by default, with what each one means.
 *
 * The ids come from their EIPs. Three of them are single-function
 * interfaces, so the id IS that function's selector and `lib.test.ts`
 * recomputes them; the rest are XORs of several selectors and are carried as
 * published constants.
 */
export const KNOWN_INTERFACES: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  /** The single function this id is the selector of, when there is one. */
  readonly singleFunction?: string;
}> = Object.freeze([
  { id: "0x01ffc9a7", name: "ERC-165", singleFunction: "supportsInterface(bytes4)" },
  { id: "0x80ac58cd", name: "ERC-721" },
  { id: "0x5b5e139f", name: "ERC-721Metadata" },
  { id: "0x780e9d63", name: "ERC-721Enumerable" },
  { id: "0xd9b67a26", name: "ERC-1155" },
  { id: "0x0e89341c", name: "ERC-1155MetadataURI", singleFunction: "uri(uint256)" },
  {
    id: "0x2a55205a",
    name: "ERC-2981 (royalties)",
    singleFunction: "royaltyInfo(uint256,uint256)",
  },
  { id: "0x49064906", name: "ERC-4906 (metadata update)" },
  { id: "0x1626ba7e", name: "ERC-1271 (contract signatures)" },
  { id: "0x7965db0b", name: "AccessControl" },
  { id: "0x48e2b093", name: "EIP-2535 DiamondLoupe" },
]);

/** The DiamondLoupe id, which changes what "the implementation" even means. */
export const DIAMOND_LOUPE_ID = "0x48e2b093";

/**
 * The reserved id every ERC-165 contract must answer FALSE for.
 *
 * This is the whole compliance test, and skipping it is how a claim list
 * becomes fiction: a contract whose fallback returns a non-zero word answers
 * `true` to every `supportsInterface` call ever made. Its claims then say
 * nothing at all, and a list of eleven interfaces it "supports" is eleven
 * wrong facts that a caller has no way to spot.
 */
export const ERC165_INVALID_ID = "0xffffffff";

export type ProxySignal = {
  readonly kind: "eip1967" | "eip1967-beacon" | "eip1167-minimal" | "eip1822" | "diamond";
  /** The implementation this signal points at, when it points at one. */
  readonly implementation: string | null;
  /** Where it was read from, in enough detail to go and check. */
  readonly source: string;
  /** Whether the value came from storage/bytecode (fact) or a view call. */
  readonly evidence: "storage" | "bytecode" | "call";
};

export type ProxyVerdict = {
  readonly isProxy: boolean;
  readonly resolved: boolean;
  readonly kind: string;
  readonly implementation: string | null;
  readonly signals: ReadonlyArray<ProxySignal>;
  /** Present whenever `resolved` is false, saying what to do instead. */
  readonly unresolvedReason?: string;
};

/**
 * Reconcile the signals into one answer, or decline to.
 *
 * Two signals naming two different implementations is the case this exists
 * for. It happens — a clone of a proxy, a half-migrated upgrade, a contract
 * that writes the 1967 slot for tooling while actually dispatching somewhere
 * else — and picking one is how a caller ends up with an ABI that decodes
 * the wrong contract's storage. So: one implementation, or none and a
 * reason.
 */
export function reconcileProxy(signals: ReadonlyArray<ProxySignal>): ProxyVerdict {
  if (signals.length === 0) {
    return { isProxy: false, resolved: true, kind: "none", implementation: null, signals };
  }

  const diamond = signals.find((s) => s.kind === "diamond");
  if (diamond !== undefined) {
    return {
      isProxy: true,
      resolved: false,
      kind: "diamond",
      implementation: null,
      signals,
      unresolvedReason:
        "this contract CLAIMS the EIP-2535 DiamondLoupe interface (self-reported, via ERC-165), and a diamond routes every selector to a different facet — there is no single implementation to report. Enumerate the facets with facets() and inspect each one. A claim can only make this answer more cautious, never more confident, which is why it is allowed to withdraw an address but never to supply one.",
    };
  }

  const addressed = signals.filter(
    (s): s is ProxySignal & { implementation: string } => s.implementation !== null,
  );
  const distinct = [...new Set(addressed.map((s) => s.implementation.toLowerCase()))];

  if (distinct.length === 0) {
    const kinds = signals.map((s) => s.kind).join(", ");
    return {
      isProxy: true,
      resolved: false,
      kind: signals[0]?.kind ?? "unknown",
      implementation: null,
      signals,
      unresolvedReason: `this contract looks like a proxy (${kinds}) but no implementation address could be read from it`,
    };
  }

  if (distinct.length > 1) {
    const detail = addressed.map((s) => `${s.implementation} (${s.source})`).join(" and ");
    return {
      isProxy: true,
      resolved: false,
      kind: "conflicting",
      implementation: null,
      signals,
      unresolvedReason: `two proxy mechanisms on this contract name different implementations — ${detail}. Reporting either one would send you to the wrong ABI, so neither is reported.`,
    };
  }

  const primary = addressed[0] as ProxySignal & { implementation: string };
  return {
    isProxy: true,
    resolved: true,
    kind: primary.kind,
    implementation: primary.implementation,
    signals,
  };
}
