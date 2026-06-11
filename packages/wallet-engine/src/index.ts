import { type BoundaryResult, classifyBoundary } from "@crewhaus/boundary-classifier";
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
/**
 * Section 47 — `wallet-engine`.
 *
 * Custody and sign-request orchestration. Every destructive transaction
 * routes through `requestSignAndBroadcast()`, which:
 *
 *   1. Routes the unsigned transaction through `simulate()` when the
 *      transaction-policy block requires it (default: yes).
 *   2. Enforces the static-checkable pieces of the policy (allowed
 *      contracts, max-value, simulationRequired). Mismatches throw
 *      before any approval prompt or key access.
 *   3. Hands the signing request to a `CustodyProvider` keyed by the
 *      wallet's `custody` value (user-controlled / kms / hsm / local).
 *   4. Broadcasts the signed transaction through the chain adapter and
 *      classifies the receipt with `origin: "chain"` before returning.
 *
 * Catalog layer: R8 (permission / policy / safety) — adjacent to
 * `permission-engine`. Slice 1 surface; non-EVM custody adapters are
 * deferred.
 *
 * Pillar 3 contract: every `simulate()` result, every receipt, and any
 * peer-signed attestation forwarded by an external signer SHALL pass
 * through `classifyBoundary({ origin: "chain" })` before reaching the
 * model context. The wallet-engine implements this on every read path;
 * custody adapters that read peer signatures must call it themselves.
 */
import { CrewhausError } from "@crewhaus/errors";

export class WalletEngineError extends CrewhausError {
  override readonly name = "WalletEngineError";
  readonly walletId: string;

  constructor(walletId: string, message: string, cause?: unknown) {
    super("config", `[wallet ${walletId}] ${message}`, cause);
    this.walletId = walletId;
  }
}

/**
 * Static configuration for a wallet binding, lowered from IR. The
 * runtime constructs one of these per `IrWalletBinding` at boot.
 */
export type WalletConfig = {
  readonly id: string;
  readonly chainId: string;
  readonly custody: "user-controlled" | "kms" | "hsm" | "local";
  readonly signingPolicy: "explicit-user-approval" | "policy-gated" | "automated";
  /**
   * Optional secret reference. Required for `kms` / `hsm` / `local`
   * custody (the key id / handle / path); omitted for
   * `user-controlled` (WalletConnect, MetaMask, etc.) where signing
   * happens externally.
   */
  readonly keyRef?: string;
};

/**
 * Mirrors `IrTransactionPolicy`. Carried alongside the wallet because
 * a single bundle may declare one policy that applies to every wallet.
 * The IR pass (slice 1 `transactionPolicyEnforcement`) validates that
 * `allowedContracts` references declared contracts; the wallet-engine
 * enforces it again at runtime as a defense-in-depth check.
 */
export type TransactionPolicy = {
  readonly defaultWriteApproval: "required" | "policy" | "none";
  readonly maxValueUsd?: number;
  /**
   * Native-token value ceiling in wei (decimal or 0x-hex). Oracle-free and
   * enforced pre-broadcast (#152).
   */
  readonly maxValueWei?: string;
  readonly allowedContracts: readonly string[];
  /**
   * Resolved `contractId` → address map. When present, `tx.to` is bound to the
   * address registered for `tx.contractId`, so a whitelisted id cannot be used
   * to send to an arbitrary address (#151). The runtime should populate this
   * from the spec's `contracts[]`; the stronger long-term fix is to drop `to`
   * from the tool input entirely and resolve it from `contractId` here.
   */
  readonly contractAddresses?: Readonly<Record<string, string>>;
  readonly simulationRequired: boolean;
};

/**
 * The unsigned-transaction shape the wallet-engine accepts. Generic
 * over EVM today; the `chainId` field steers the right adapter.
 *
 * `contractId` is the spec-level binding id (from `contracts[]`),
 * resolved into `to` (address) by the caller. Carrying both lets the
 * policy engine compare against `allowedContracts` symbolically rather
 * than by raw address (less brittle when contracts get redeployed).
 */
export type UnsignedTx = {
  readonly chainId: string;
  readonly walletId: string;
  readonly contractId?: string;
  readonly to: string;
  /** Hex-encoded calldata, 0x-prefixed. */
  readonly data: string;
  /** Hex-encoded native-token value (wei), 0x-prefixed. Defaults to "0x0". */
  readonly value?: string;
  /** Optional gas limit (hex). Adapter estimates if omitted. */
  readonly gasLimit?: string;
};

/**
 * Parse a wei amount expressed as a decimal or 0x-hex string. Throws a
 * WalletEngineError (fail-closed) on a malformed value.
 */
function parseWei(walletId: string, label: string, v: string): bigint {
  try {
    return BigInt(v.trim());
  } catch {
    throw new WalletEngineError(
      walletId,
      `invalid ${label} "${v}" (expected wei as a decimal or 0x-hex string)`,
    );
  }
}

/**
 * Simulation result. Conservatively typed — real adapters surface
 * decoded balance deltas, permission deltas, etc. Slice 1 carries
 * the minimum payload the approval prompt needs.
 */
export type SimulationResult = {
  readonly success: boolean;
  readonly gasUsed: string;
  readonly returnData?: string;
  /** Adapter-decoded error string when `success === false`. */
  readonly revertReason?: string;
  /**
   * Boundary verdict on the simulator's raw response. Always present.
   * Callers that promote sim output into the model context use this
   * to decide whether to redact.
   */
  readonly boundary: BoundaryResult;
};

/**
 * Receipt of a broadcast transaction. Same Pillar 3 boundary wrap.
 */
export type BroadcastReceipt = {
  readonly txHash: string;
  /**
   * Block number the transaction landed in. `null` while pending; the
   * caller polls with `EvmGetTransactionReceipt` to wait for finality.
   */
  readonly blockNumber: string | null;
  readonly status: "0x0" | "0x1" | null;
  readonly boundary: BoundaryResult;
};

/**
 * The approval gate. Slice 1 ships an in-process resolver that the
 * runtime wires to the §7 permission engine (or the CLI HITL prompt
 * for `default` mode). Tests provide a deterministic resolver.
 */
export type ApprovalDecision = "allow" | "deny";
export type ApprovalRequest = {
  readonly walletId: string;
  readonly chainId: string;
  readonly tx: UnsignedTx;
  readonly simulation?: SimulationResult;
  readonly reason: string;
};
export type ApprovalResolver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * Custody adapter — abstracts the signing primitive across user-
 * controlled wallets, KMS, HSM, and local-key custody. Slice 1 ships
 * the interface plus a `LocalSignerStub` for tests; real KMS / HSM
 * integrations are follow-up packages.
 */
export interface CustodyProvider {
  readonly custody: WalletConfig["custody"];
  /**
   * Sign + broadcast. The provider is responsible for whatever
   * external loop the custody type requires (WalletConnect QR scan,
   * KMS signRequest, HSM PKCS#11 call, local-key signing). Returns
   * the raw tx hash; the wallet-engine wraps it in a `BroadcastReceipt`.
   */
  signAndBroadcast(args: {
    readonly tx: UnsignedTx;
    readonly walletConfig: WalletConfig;
    readonly adapter: ChainAdapter;
  }): Promise<string>;
}

/**
 * The slice-1 wallet engine. Construct one per bundle; register one
 * custody provider per custody kind in use; resolve adapters from the
 * `chains[]` block via the supplied resolver.
 */
export type WalletEngine = {
  readonly registerCustody: (provider: CustodyProvider) => void;
  readonly requestSignAndBroadcast: (args: {
    readonly tx: UnsignedTx;
    readonly policy: TransactionPolicy;
    readonly wallet: WalletConfig;
  }) => Promise<BroadcastReceipt>;
  readonly simulate: (args: {
    readonly tx: UnsignedTx;
  }) => Promise<SimulationResult>;
};

export type WalletEngineOptions = {
  readonly resolveAdapter: (chainId: string) => ChainAdapter | undefined;
  readonly approve: ApprovalResolver;
};

export function createWalletEngine(opts: WalletEngineOptions): WalletEngine {
  const custodies = new Map<WalletConfig["custody"], CustodyProvider>();

  function requireAdapter(chainId: string, walletId: string): ChainAdapter {
    const a = opts.resolveAdapter(chainId);
    if (a === undefined) {
      throw new WalletEngineError(
        walletId,
        `no chain adapter registered for chainId "${chainId}". Declare it in spec.chains[].`,
      );
    }
    return a;
  }

  async function simulate(args: { tx: UnsignedTx }): Promise<SimulationResult> {
    const adapter = requireAdapter(args.tx.chainId, args.tx.walletId);
    const callParams: Record<string, unknown> = {
      to: args.tx.to,
      data: args.tx.data,
    };
    if (args.tx.value !== undefined) callParams["value"] = args.tx.value;
    // Prefer eth_call for state-read; fall back to estimateGas for revert detection.
    let returnData: string | undefined;
    let success = true;
    let revertReason: string | undefined;
    let raw = "";
    try {
      const callResult = await adapter.rpcRead("eth_call", [callParams, "latest"]);
      returnData = typeof callResult === "string" ? callResult : undefined;
      raw = JSON.stringify({ kind: "call", result: callResult });
    } catch (err) {
      success = false;
      revertReason = (err as Error).message;
      raw = JSON.stringify({ kind: "revert", message: revertReason });
    }
    let gasUsed = "0x0";
    if (success) {
      try {
        const est = await adapter.rpcRead("eth_estimateGas", [callParams]);
        if (typeof est === "string") gasUsed = est;
      } catch {
        /* tolerate — gasUsed stays 0x0 */
      }
    }
    const boundary = await classifyBoundary(raw, { origin: "chain" });
    return {
      success,
      gasUsed,
      ...(returnData !== undefined ? { returnData } : {}),
      ...(revertReason !== undefined ? { revertReason } : {}),
      boundary,
    };
  }

  function enforceStaticPolicy(tx: UnsignedTx, policy: TransactionPolicy): void {
    // Fail CLOSED on an empty `allowedContracts`. Previously empty meant "allow
    // every contract", so an onchain agent on the default policy (allowedContracts
    // defaults to []) let a prompt-injected model send arbitrary calldata/value
    // to ANY address — a wallet-drain primitive. Operators must now declare the
    // callable contract ids in transaction_policy.allowedContracts to permit sends.
    if (policy.allowedContracts.length === 0) {
      throw new WalletEngineError(
        tx.walletId,
        "transaction_policy.allowedContracts is empty — sends are denied (fail-closed). Declare the callable contract ids in transaction_policy.allowedContracts (bound to addresses via contracts[]).",
      );
    }
    // Non-empty: contractId must be present and whitelisted. Raw-address calls
    // (no contractId) are rejected — the spec author must declare every callable
    // contract symbolically.
    if (tx.contractId === undefined) {
      throw new WalletEngineError(
        tx.walletId,
        `transaction_policy.allowedContracts is non-empty; raw-address calls forbidden (to=${tx.to}). Declare a contracts[] entry and pass its id.`,
      );
    }
    if (!policy.allowedContracts.includes(tx.contractId)) {
      throw new WalletEngineError(
        tx.walletId,
        `contract id "${tx.contractId}" not in transaction_policy.allowedContracts ${JSON.stringify(policy.allowedContracts)}`,
      );
    }

    // #151 — bind `to` to the claimed contractId. `allowedContracts` alone is a
    // symbolic gate; without this an attacker can claim a whitelisted id and
    // still send to an arbitrary address. When the resolved address map is
    // present, `tx.to` MUST equal the address registered for `tx.contractId`.
    if (tx.contractId !== undefined && policy.contractAddresses !== undefined) {
      const expected = policy.contractAddresses[tx.contractId];
      if (expected === undefined) {
        throw new WalletEngineError(
          tx.walletId,
          `contract id "${tx.contractId}" has no resolved address in transaction_policy.contractAddresses`,
        );
      }
      if (tx.to.toLowerCase() !== expected.toLowerCase()) {
        throw new WalletEngineError(
          tx.walletId,
          `tx.to "${tx.to}" does not match the address ${expected} bound to contract id "${tx.contractId}"`,
        );
      }
    }

    // #152 — value caps. maxValueWei is an oracle-free native ceiling enforced
    // here. maxValueUsd cannot be enforced without a price oracle (none is
    // wired in this build), so fail closed rather than give false assurance.
    if (policy.maxValueWei !== undefined) {
      const cap = parseWei(tx.walletId, "transaction_policy.maxValueWei", policy.maxValueWei);
      const val = parseWei(tx.walletId, "tx.value", tx.value ?? "0x0");
      if (val > cap) {
        throw new WalletEngineError(
          tx.walletId,
          `tx value ${val} wei exceeds transaction_policy.maxValueWei (${cap} wei)`,
        );
      }
    }
    if (policy.maxValueUsd !== undefined) {
      throw new WalletEngineError(
        tx.walletId,
        `transaction_policy.maxValueUsd (${policy.maxValueUsd}) cannot be enforced: USD value caps require a price oracle, which is not wired in this build. Use transaction_policy.maxValueWei for a native-token ceiling.`,
      );
    }
    // `none` (defaultWriteApproval) is only valid under `automated` custody —
    // documented invariant. The runtime layers that allow this combo perform
    // a stronger check at boot; this layer just rejects the obvious misuse.
    if (policy.defaultWriteApproval === "none") {
      // We can't read wallet custody from here without the wallet arg; the
      // caller passes the wallet — see requestSignAndBroadcast below.
    }
  }

  async function requestSignAndBroadcast(args: {
    tx: UnsignedTx;
    policy: TransactionPolicy;
    wallet: WalletConfig;
  }): Promise<BroadcastReceipt> {
    if (args.tx.walletId !== args.wallet.id) {
      throw new WalletEngineError(
        args.wallet.id,
        `tx.walletId "${args.tx.walletId}" does not match wallet.id "${args.wallet.id}"`,
      );
    }
    if (args.tx.chainId !== args.wallet.chainId) {
      throw new WalletEngineError(
        args.wallet.id,
        `tx.chainId "${args.tx.chainId}" does not match wallet.chainId "${args.wallet.chainId}"`,
      );
    }
    enforceStaticPolicy(args.tx, args.policy);
    if (args.policy.defaultWriteApproval === "none" && args.wallet.signingPolicy !== "automated") {
      throw new WalletEngineError(
        args.wallet.id,
        `transaction_policy.defaultWriteApproval="none" requires signingPolicy="automated" (got "${args.wallet.signingPolicy}")`,
      );
    }

    const adapter = requireAdapter(args.tx.chainId, args.wallet.id);

    let sim: SimulationResult | undefined;
    if (args.policy.simulationRequired) {
      sim = await simulate({ tx: args.tx });
      if (!sim.success) {
        throw new WalletEngineError(
          args.wallet.id,
          `simulation failed: ${sim.revertReason ?? "(no revert reason)"}; transaction_policy.simulationRequired=true and simulation must succeed before approval`,
        );
      }
    }

    // Approval gate. `policy-gated` defers to the resolver's own
    // adjudication; `explicit-user-approval` always prompts;
    // `automated` skips the resolver entirely.
    const needApproval =
      args.wallet.signingPolicy !== "automated" || args.policy.defaultWriteApproval === "required";
    if (needApproval) {
      const decision = await opts.approve({
        walletId: args.wallet.id,
        chainId: args.tx.chainId,
        tx: args.tx,
        ...(sim !== undefined ? { simulation: sim } : {}),
        reason: `sign ${args.tx.data.length > 10 ? `${args.tx.data.slice(0, 10)}…` : args.tx.data} to ${args.tx.to} on ${args.tx.chainId}`,
      });
      if (decision !== "allow") {
        throw new WalletEngineError(args.wallet.id, "approval denied; transaction not broadcast");
      }
    }

    const provider = custodies.get(args.wallet.custody);
    if (provider === undefined) {
      throw new WalletEngineError(
        args.wallet.id,
        `no CustodyProvider registered for custody="${args.wallet.custody}". Call registerCustody() at boot.`,
      );
    }
    const txHash = await provider.signAndBroadcast({
      tx: args.tx,
      walletConfig: args.wallet,
      adapter,
    });

    // Fetch the receipt for the caller. Receipts may be null when the
    // tx is still pending; the receipt-poll loop is the caller's concern.
    let receiptRaw: unknown;
    try {
      receiptRaw = await adapter.rpcRead("eth_getTransactionReceipt", [txHash]);
    } catch {
      receiptRaw = null;
    }
    const boundary = await classifyBoundary(JSON.stringify(receiptRaw ?? null), {
      origin: "chain",
    });
    if (receiptRaw === null || typeof receiptRaw !== "object") {
      return { txHash, blockNumber: null, status: null, boundary };
    }
    const r = receiptRaw as Record<string, unknown>;
    const blockNumber = typeof r["blockNumber"] === "string" ? (r["blockNumber"] as string) : null;
    const statusRaw = r["status"];
    const status = statusRaw === "0x0" || statusRaw === "0x1" ? (statusRaw as "0x0" | "0x1") : null;
    return { txHash, blockNumber, status, boundary };
  }

  return {
    registerCustody(provider) {
      custodies.set(provider.custody, provider);
    },
    requestSignAndBroadcast,
    simulate,
  };
}

/**
 * Test-only custody stub. Implements the `local` custody kind with a
 * deterministic tx-hash mint. Real implementations live in follow-up
 * packages (`wallet-custody-kms`, `wallet-custody-wc`, etc.).
 */
export function createLocalSignerStub(): CustodyProvider {
  let nonce = 0;
  return {
    custody: "local",
    async signAndBroadcast({ tx }) {
      nonce += 1;
      // Deterministic hash for tests: hex of walletId|chainId|nonce.
      const seed = `${tx.walletId}:${tx.chainId}:${nonce}`;
      const bytes = new TextEncoder().encode(seed);
      let acc = 0n;
      for (const b of bytes) acc = (acc * 31n + BigInt(b)) & ((1n << 256n) - 1n);
      return `0x${acc.toString(16).padStart(64, "0")}`;
    },
  };
}
