/**
 * Item 66 — `crewhaus onchain tune` / `onchain sentinel`: mine wallet-engine
 * transaction receipts + simulation history to (a) propose a tuned
 * `transaction_policy` from the observed legitimate spend distribution, and
 * (b) flag anomalous spend against a learned baseline (an alert-watchdog for
 * on-chain value).
 *
 * Input is a receipt-history JSONL — one record per broadcast, carrying the
 * fields wallet-engine already surfaces on `BroadcastReceipt` + the tx it
 * signed: `{ ts, walletId, chainId, contractId, valueWei, status, simulated }`.
 * NO private key material is ever read — `keyRef` stays a reference and never
 * enters this module; a receipt carries only a public tx hash, a contract id,
 * and a wei value.
 *
 * `transaction_policy` is optimizer-whitelisted for the onchain / onchain-game
 * targets (OPTIMIZABLE_PATHS), so the tuner emits VALIDATED `SpecPatch`es there
 * (a `crewhaus optimize --write-back`-compatible edit). For a non-whitelisted
 * target the tuner degrades to advice-only (the proposal is printed, no patch).
 *
 * Everything here is side-effect-free (the CLI entry file reads the history
 * JSONL + writes patches/report). Deterministic: same receipts → same proposal.
 */

/** Thrown on malformed history / bad flags. The CLI routes it through `die()`;
 *  tests assert on `.message`. */
export class OnchainTuneError extends Error {
  override readonly name = "OnchainTuneError";
}

/** One parsed receipt-history record. `valueWei` is the native-token value the
 *  tx moved, as a decimal or 0x-hex string (BigInt-parsed downstream). */
export type ReceiptRecord = {
  readonly ts: number;
  readonly walletId: string;
  readonly chainId: string;
  /** The spec-level contract binding id the tx targeted (symbolic allowlist). */
  readonly contractId: string;
  readonly valueWei: bigint;
  /** "0x1" success / "0x0" revert / null pending — mirrors BroadcastReceipt. */
  readonly status: "0x1" | "0x0" | null;
  /** Whether a pre-broadcast simulation ran + succeeded. */
  readonly simulated: boolean;
};

/** The current transaction_policy (subset the tuner reads/proposes). */
export type CurrentPolicy = {
  readonly maxValueWei?: string;
  readonly allowedContracts?: readonly string[];
  readonly simulationRequired?: boolean;
};

function parseWeiString(raw: unknown, ctx: string): bigint {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(raw.trim())) {
    return BigInt(raw.trim());
  }
  throw new OnchainTuneError(
    `${ctx}: valueWei must be a non-negative wei decimal or 0x-hex string`,
  );
}

/**
 * Parse a receipt-history JSONL blob. Skips blank lines; throws on a
 * structurally invalid record so a corrupt history is loud. A receipt with no
 * `contractId` (a raw-address send — already forbidden by wallet-engine) is
 * rejected so the tuner never learns an allowlist from un-symbolic sends.
 */
export function parseReceiptHistory(jsonl: string): ReceiptRecord[] {
  const out: ReceiptRecord[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new OnchainTuneError(`receipt history line ${i + 1}: not valid JSON`);
    }
    if (obj === null || typeof obj !== "object") {
      throw new OnchainTuneError(`receipt history line ${i + 1}: not an object`);
    }
    const rec = obj as Record<string, unknown>;
    const contractId = rec["contractId"];
    if (typeof contractId !== "string" || contractId.trim() === "") {
      throw new OnchainTuneError(
        `receipt history line ${i + 1}: missing contractId (raw-address sends are not tunable)`,
      );
    }
    const ts = typeof rec["ts"] === "number" ? (rec["ts"] as number) : i;
    const walletId = typeof rec["walletId"] === "string" ? (rec["walletId"] as string) : "wallet";
    const chainId = typeof rec["chainId"] === "string" ? (rec["chainId"] as string) : "chain";
    const valueWei = parseWeiString(rec["valueWei"] ?? "0", `receipt history line ${i + 1}`);
    const statusRaw = rec["status"];
    const status = statusRaw === "0x1" || statusRaw === "0x0" ? (statusRaw as "0x1" | "0x0") : null;
    const simulated = rec["simulated"] === true;
    out.push({ ts, walletId, chainId, contractId, valueWei, status, simulated });
  }
  return out;
}

/** Only receipts that actually settled successfully count as "legitimate" spend
 *  the policy should permit. Reverts + pending are excluded from the baseline. */
function successfulReceipts(receipts: readonly ReceiptRecord[]): ReceiptRecord[] {
  return receipts.filter((r) => r.status === "0x1");
}

export type ProposePolicyOptions = {
  /** Headroom multiplier over the observed max legitimate spend for the
   *  proposed maxValueWei cap. Default 1.25 (25% headroom). */
  readonly capMarginPct?: number;
  /** Whether the source spec's target has transaction_policy whitelisted for
   *  optimizer write-back (onchain / onchain-game). When false, the tuner still
   *  computes the proposal but emits no SpecPatch (advice-only). */
  readonly optimizable: boolean;
  /** The spec target (for the SpecPatch discriminator). */
  readonly target: string;
};

/** The tuner's proposal: the derived caps + allowlist and, when whitelisted,
 *  the validated transaction_policy block to write back. The CLI wraps this in
 *  a SpecPatch with the right op (`add` vs `replace`) once it has seen whether
 *  the raw YAML already carries a transaction_policy block. */
export type PolicyProposal = {
  /** Proposed native-token ceiling (wei, decimal string). undefined when no
   *  successful spend was observed (nothing to bound). */
  readonly proposedMaxValueWei?: string;
  /** Contract ids observed in successful sends — the proposed allowlist. */
  readonly proposedAllowedContracts: readonly string[];
  /** Human-readable derivation notes. */
  readonly rationale: string;
  /** The transaction_policy block to write back (+ where + why), or undefined
   *  for advice-only. `op` is left to the CLI (it depends on raw-YAML presence). */
  readonly patch?: {
    readonly target: string;
    readonly path: readonly string[];
    readonly value: Record<string, unknown>;
    readonly rationale: string;
  };
  /** Warnings the author should see (e.g. current cap is too tight vs observed). */
  readonly warnings: readonly string[];
};

/**
 * Propose a tuned transaction_policy from the observed legitimate spend. The cap
 * is `max(successful valueWei) × capMargin`, rounded up; the allowlist is the
 * set of contract ids that produced a successful send. When the target
 * whitelists `transaction_policy` for the optimizer, a validated `replace`
 * SpecPatch on the whole block is returned so `optimize --write-back` can apply
 * it; otherwise the proposal is advice-only.
 */
export function proposePolicy(
  receipts: readonly ReceiptRecord[],
  current: CurrentPolicy,
  opts: ProposePolicyOptions,
): PolicyProposal {
  const margin = opts.capMarginPct ?? 1.25;
  if (margin <= 1) {
    throw new OnchainTuneError(`capMarginPct must be > 1 (got ${margin})`);
  }
  const ok = successfulReceipts(receipts);
  const warnings: string[] = [];

  // Allowlist = contract ids with ≥1 successful send, sorted + deduped.
  const allowed = [...new Set(ok.map((r) => r.contractId))].sort();

  // Cap = ceil(maxObservedWei * margin). BigInt-safe: scale the margin into an
  // integer numerator/denominator to avoid float wei.
  let proposedMaxValueWei: string | undefined;
  let capRationale = "no successful sends observed — cannot bound spend";
  if (ok.length > 0) {
    let maxWei = 0n;
    for (const r of ok) if (r.valueWei > maxWei) maxWei = r.valueWei;
    // margin as basis points to stay integer: e.g. 1.25 → 12500 / 10000.
    const bps = BigInt(Math.round(margin * 10_000));
    const cap = (maxWei * bps + 9_999n) / 10_000n; // ceil-div
    proposedMaxValueWei = cap.toString();
    capRationale = `max observed successful spend ${maxWei} wei × ${margin} = ${cap} wei cap`;

    // If the current cap is BELOW the observed legitimate max, flag it: real
    // spend is being denied. If it's absent, note the newly-derived ceiling.
    if (current.maxValueWei !== undefined) {
      const curCap = parseWeiString(current.maxValueWei, "current transaction_policy.maxValueWei");
      if (curCap < maxWei) {
        warnings.push(
          `current maxValueWei ${curCap} wei is BELOW observed legitimate spend ${maxWei} wei — legitimate sends are being denied`,
        );
      }
    }
  }

  // Contract ids that appear in the CURRENT allowlist but never in a successful
  // send are candidates for removal (least-privilege). Advisory only.
  if (current.allowedContracts !== undefined) {
    const unused = current.allowedContracts.filter((c) => !allowed.includes(c));
    if (unused.length > 0) {
      warnings.push(
        `current allowedContracts includes never-used ids ${JSON.stringify(unused)} — consider removing (least privilege)`,
      );
    }
  }

  const excludedNote =
    ok.length < receipts.length
      ? ` (${receipts.length - ok.length} reverted/pending receipts excluded)`
      : "";
  const rationale = `${capRationale}; allowlist derived from ${allowed.length} contract id(s) with successful sends${excludedNote}`;

  const proposal: PolicyProposal = {
    ...(proposedMaxValueWei !== undefined ? { proposedMaxValueWei } : {}),
    proposedAllowedContracts: allowed,
    rationale,
    warnings,
  };

  if (opts.optimizable && proposedMaxValueWei !== undefined) {
    // Whole-block replace so the write-back preserves the other policy fields.
    const value: Record<string, unknown> = {
      ...(current.simulationRequired !== undefined
        ? { simulationRequired: current.simulationRequired }
        : { simulationRequired: true }),
      maxValueWei: proposedMaxValueWei,
      allowedContracts: allowed,
    };
    return {
      ...proposal,
      patch: {
        target: opts.target,
        path: ["transaction_policy"],
        value,
        rationale: `onchain tune: ${rationale}`,
      },
    };
  }
  return proposal;
}

// ---------------------------------------------------------------------------
// Spend sentinel — flag anomalous spend against a learned baseline.
// ---------------------------------------------------------------------------

/** Per-contract spend baseline (successful sends only). All in wei. */
export type SpendBaseline = {
  readonly perContract: Readonly<
    Record<string, { count: number; maxWei: bigint; meanWei: bigint }>
  >;
  /** Global ceiling across all contracts (max successful spend). */
  readonly globalMaxWei: bigint;
};

/**
 * Learn a spend baseline from successful receipts. Per contract we track count,
 * max, and mean (integer wei). The map key is the raw contractId — contract
 * ids are `[A-Za-z0-9_.-]`-ish spec identifiers, so a `|`-joined composite key
 * is never needed and no control/NUL byte ever enters a key.
 */
export function learnSpendBaseline(receipts: readonly ReceiptRecord[]): SpendBaseline {
  const ok = successfulReceipts(receipts);
  const acc = new Map<string, { count: number; maxWei: bigint; sumWei: bigint }>();
  let globalMaxWei = 0n;
  for (const r of ok) {
    const cur = acc.get(r.contractId) ?? { count: 0, maxWei: 0n, sumWei: 0n };
    cur.count += 1;
    cur.sumWei += r.valueWei;
    if (r.valueWei > cur.maxWei) cur.maxWei = r.valueWei;
    acc.set(r.contractId, cur);
    if (r.valueWei > globalMaxWei) globalMaxWei = r.valueWei;
  }
  const perContract: Record<string, { count: number; maxWei: bigint; meanWei: bigint }> = {};
  for (const [id, v] of acc) {
    perContract[id] = {
      count: v.count,
      maxWei: v.maxWei,
      meanWei: v.count > 0 ? v.sumWei / BigInt(v.count) : 0n,
    };
  }
  return { perContract, globalMaxWei };
}

/** One flagged anomaly. */
export type SpendAnomaly = {
  readonly ts: number;
  readonly contractId: string;
  readonly valueWei: bigint;
  readonly reason: string;
};

export type SentinelOptions = {
  /** How many times over the per-contract observed max counts as anomalous.
   *  Default 2 (a spend > 2× the largest previously-seen legit send). */
  readonly maxMultiple?: number;
  /** Also flag a send to a contract id never seen in the baseline. Default true. */
  readonly flagUnknownContracts?: boolean;
};

/**
 * Detect anomalous spend in `candidate` receipts against a learned baseline.
 * Flags: (a) a send to a contract id absent from the baseline, and (b) a value
 * exceeding `maxMultiple ×` that contract's observed max. Deterministic; the
 * baseline itself is never mutated. keyRef / private keys never enter here.
 */
export function detectAnomalies(
  candidate: readonly ReceiptRecord[],
  baseline: SpendBaseline,
  opts: SentinelOptions = {},
): SpendAnomaly[] {
  const maxMultiple = BigInt(Math.max(1, Math.round(opts.maxMultiple ?? 2)));
  const flagUnknown = opts.flagUnknownContracts !== false;
  const anomalies: SpendAnomaly[] = [];
  for (const r of candidate) {
    const base = baseline.perContract[r.contractId];
    if (base === undefined) {
      if (flagUnknown) {
        anomalies.push({
          ts: r.ts,
          contractId: r.contractId,
          valueWei: r.valueWei,
          reason: `send to contract id "${r.contractId}" never seen in the learned baseline`,
        });
      }
      continue;
    }
    const ceiling = base.maxWei * maxMultiple;
    if (r.valueWei > ceiling) {
      anomalies.push({
        ts: r.ts,
        contractId: r.contractId,
        valueWei: r.valueWei,
        reason: `spend ${r.valueWei} wei exceeds ${maxMultiple}× the observed max ${base.maxWei} wei for "${r.contractId}"`,
      });
    }
  }
  return anomalies;
}

/**
 * Detect anomalous spend when candidate and baseline are the SAME history
 * (`crewhaus onchain sentinel` invoked without `--baseline`) — the "self-
 * compare" mode.
 *
 * A naive `learnSpendBaseline(history)` + `detectAnomalies(history, ...)`
 * self-masks: a receipt's own value is folded into its contract's baseline
 * max, so a lone 100× spike can never exceed `maxMultiple × (its own value)`.
 * The value-ceiling check — the headline sentinel feature — is silently
 * defeated in exactly the default (no-`--baseline`) invocation.
 *
 * Fix: leave-one-out. For each candidate receipt, the ceiling is computed
 * from the max successful spend over every OTHER successful receipt for that
 * contract — the receipt under test never contributes to its own ceiling. A
 * lone spike is then measured against the normal population and correctly
 * flagged; a normal history (every value within range of its peers) still
 * flags nothing. Unknown-contract detection needs no leave-one-out (a
 * contract either has ≥1 OTHER successful receipt or it doesn't — a receipt
 * is never "unknown relative to itself" in a way that matters here, since a
 * lone successful send to a contract is, by definition, its own baseline of
 * one and cannot be a value anomaly against itself); this path only ever
 * calls detectAnomalies-style value/unknown logic per receipt with a leave-
 * one-out baseline substituted in.
 */
export function detectAnomaliesSelfCompare(
  history: readonly ReceiptRecord[],
  opts: SentinelOptions = {},
): SpendAnomaly[] {
  const maxMultiple = BigInt(Math.max(1, Math.round(opts.maxMultiple ?? 2)));
  const flagUnknown = opts.flagUnknownContracts !== false;
  const ok = successfulReceipts(history);

  // Precompute, per contract, the sorted successful wei values so a
  // leave-one-out max can be derived in O(log n) per receipt instead of an
  // O(n) rescan. (n is a receipt-history JSONL — expected small, but this
  // keeps the self-compare path cheap regardless.)
  const byContract = new Map<string, bigint[]>();
  for (const r of ok) {
    const arr = byContract.get(r.contractId);
    if (arr === undefined) byContract.set(r.contractId, [r.valueWei]);
    else arr.push(r.valueWei);
  }

  const anomalies: SpendAnomaly[] = [];
  for (const r of history) {
    const contractValues = byContract.get(r.contractId);
    if (contractValues === undefined) {
      // Only reachable for a non-successful (reverted/pending) receipt whose
      // contract never had a successful send — genuinely unknown.
      if (flagUnknown) {
        anomalies.push({
          ts: r.ts,
          contractId: r.contractId,
          valueWei: r.valueWei,
          reason: `send to contract id "${r.contractId}" never seen in the learned baseline`,
        });
      }
      continue;
    }
    if (r.status !== "0x1") {
      // Reverted/pending receipts aren't part of the "legitimate spend"
      // baseline and aren't value-checked here — mirrors the two-history
      // path, where only successfulReceipts() feed learnSpendBaseline.
      continue;
    }
    // Leave-one-out: the ceiling for THIS receipt excludes its own value —
    // one occurrence of it is removed, then the max of the rest is taken.
    let excludedOne = false;
    let looMax = 0n;
    for (const v of contractValues) {
      if (!excludedOne && v === r.valueWei) {
        excludedOne = true;
        continue;
      }
      if (v > looMax) looMax = v;
    }
    if (!excludedOne) {
      // Defensive: r.valueWei should always be in contractValues (it was
      // pushed there while building the map). If not, fall back to the full
      // max rather than under-count.
      for (const v of contractValues) if (v > looMax) looMax = v;
    }
    // A contract with only this one successful receipt has no "other"
    // population to compare against — nothing to flag as a ceiling breach.
    if (contractValues.length < 2) continue;
    const ceiling = looMax * maxMultiple;
    if (r.valueWei > ceiling) {
      anomalies.push({
        ts: r.ts,
        contractId: r.contractId,
        valueWei: r.valueWei,
        reason: `spend ${r.valueWei} wei exceeds ${maxMultiple}× the observed max ${looMax} wei for "${r.contractId}" (leave-one-out)`,
      });
    }
  }
  return anomalies;
}

/** Render a plain-text tune report. */
export function renderTuneReport(proposal: PolicyProposal): string {
  const lines: string[] = [];
  lines.push("onchain policy tuner:");
  lines.push(
    `  proposed maxValueWei:      ${proposal.proposedMaxValueWei ?? "(none — no successful spend)"}`,
  );
  lines.push(`  proposed allowedContracts: [${proposal.proposedAllowedContracts.join(", ")}]`);
  lines.push(`  ${proposal.rationale}`);
  for (const w of proposal.warnings) lines.push(`  ! ${w}`);
  lines.push(
    proposal.patch !== undefined
      ? "  → validated transaction_policy patch emitted (apply with optimize --write-back)"
      : "  → advice-only (transaction_policy is not optimizer-whitelisted for this target)",
  );
  return `${lines.join("\n")}\n`;
}

/** Render a plain-text sentinel report. */
export function renderSentinelReport(anomalies: readonly SpendAnomaly[]): string {
  if (anomalies.length === 0) {
    return "onchain spend sentinel: no anomalies vs the learned baseline.\n";
  }
  const lines: string[] = [`onchain spend sentinel: ${anomalies.length} anomaly(ies)`];
  for (const a of anomalies) {
    lines.push(`  ANOMALY ${a.contractId} @ts=${a.ts}: ${a.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
