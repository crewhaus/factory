/**
 * Reconciliation: which of these rows are the same event.
 *
 * The rows on both sides are `@crewhaus/tool-money`'s `Transaction` — the
 * shape `StatementParse` produces — imported rather than re-declared, because
 * a second declaration of a row shape is a shape that drifts the first time
 * somebody adds a field to one of them.
 *
 * THE RULE THAT MATTERS: a tolerance does NOT widen matching. A 100.00 and a
 * 100.01 are not the same payment; they are two facts that disagree by a
 * penny, and a report that pairs them has destroyed the only evidence that
 * anything is wrong. So `matched` requires the amounts to be EQUAL, and the
 * tolerance defines a separate `nearMisses` list — the pairs a person should
 * look at. That is the opposite of what most reconcilers do and it is the
 * reason this one is worth running unattended.
 *
 * Everything is deterministic. Candidates are enumerated in a fixed order
 * (date, then id), the grouped pass walks subsets by ascending size and then
 * lexicographically and takes the FIRST that sums exactly — so when several
 * subsets of charges add up to the same payout, the same one is chosen on
 * every rerun and the fee entry proposed alongside it does not move.
 */
import type { Transaction } from "@crewhaus/tool-money";
import { LedgerError, assertIsoDate, byString, dayDiff, formatMajor } from "./amount";

export const MATCH_KINDS = ["reference", "amount-date", "grouped", "grouped-with-fee"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

export const RECONCILE_LIMITS = {
  rowsPerSide: 20_000,
  maxSubsetSize: 8,
  /** Subsets examined for ONE right-hand row before the search gives up. */
  maxCombinations: 200_000,
} as const;

export type ProposalAccounts = {
  readonly bankAccount: string;
  readonly feeAccount: string;
  readonly suspenseAccount: string;
};

export type ReconcileOptions = {
  /** The near-miss radius in minor units. It does NOT widen `matched`. */
  readonly toleranceMinor: bigint;
  readonly windowDays: number;
  readonly allowManyToOne: boolean;
  readonly maxSubsetSize: number;
  readonly maxCombinations: number;
  /** Largest residue a grouped match may absorb as a fee. 0 turns the pass off. */
  readonly feeToleranceMinor: bigint;
  readonly requireReferenceMatch: boolean;
  readonly exponent: number;
  readonly currency: string;
  readonly propose?: ProposalAccounts;
};

export type Match = {
  readonly kind: MatchKind;
  readonly leftIds: ReadonlyArray<string>;
  readonly rightId: string;
  readonly amountMinor: string;
  readonly amount: string;
  readonly dateDeltaDays: number;
  readonly feeMinor: string;
  readonly why: string;
};

export type NearMiss = {
  /**
   * How the pair was noticed. `reference` means both sides carry the same
   * identifier and disagree about the amount, which is the single most
   * interesting pair in a reconciliation and is reported whatever else
   * happens to either row; `tolerance` means only the amounts are close.
   */
  readonly kind: "reference" | "tolerance";
  readonly leftId: string;
  readonly rightId: string;
  readonly amountDeltaMinor: string;
  readonly amountDelta: string;
  readonly dateDeltaDays: number;
  readonly why: string;
};

export type Unmatched = {
  readonly id: string;
  readonly date: string;
  readonly description: string;
  readonly amountMinor: string;
  readonly amount: string;
  readonly reference: string;
};

export type ProposedEntry = {
  readonly date: string;
  readonly memo: string;
  readonly reference: string;
  readonly lines: ReadonlyArray<{
    readonly account: string;
    readonly debitMinor?: string;
    readonly creditMinor?: string;
  }>;
  readonly why: string;
};

export type ReconcileResult = {
  readonly matched: ReadonlyArray<Match>;
  readonly nearMisses: ReadonlyArray<NearMiss>;
  readonly unmatchedLeft: ReadonlyArray<Unmatched>;
  readonly unmatchedRight: ReadonlyArray<Unmatched>;
  readonly proposedEntries: ReadonlyArray<ProposedEntry>;
  readonly summary: {
    readonly leftCount: number;
    readonly rightCount: number;
    readonly leftTotalMinor: string;
    readonly rightTotalMinor: string;
    readonly leftTotal: string;
    readonly rightTotal: string;
    readonly differenceMinor: string;
    readonly difference: string;
    readonly matchedCount: number;
    readonly nearMissCount: number;
    readonly currency: string;
  };
  /** Right-hand rows whose grouped search hit the combination cap. */
  readonly groupingTruncated: ReadonlyArray<string>;
};

/** Rows in a fixed order, and a refusal when two of them share an id. */
function prepare(rows: ReadonlyArray<Transaction>, side: string): Transaction[] {
  if (rows.length > RECONCILE_LIMITS.rowsPerSide) {
    throw new LedgerError(
      `the ${side} side has ${rows.length} rows, over the ${RECONCILE_LIMITS.rowsPerSide} limit`,
    );
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new LedgerError(
        `two rows on the ${side} side share the id "${row.id}" — a match against an ambiguous id cannot be acted on, so fix the ids rather than have this pick one`,
      );
    }
    seen.add(row.id);
    assertIsoDate(row.date, `${side} row "${row.id}" date`);
    if (!Number.isSafeInteger(row.amountMinor)) {
      throw new LedgerError(
        `${side} row "${row.id}" has amountMinor ${row.amountMinor}, which is not a whole number of minor units`,
      );
    }
  }
  // Date then id: the order every later pass iterates in, so "the first
  // candidate" means the same thing on every run and on every machine.
  return [...rows].sort((a, b) => byString(a.date, b.date) || byString(a.id, b.id));
}

const normalizeReference = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const absolute = (v: bigint): bigint => (v < 0n ? -v : v);

export function reconcile(
  leftRows: ReadonlyArray<Transaction>,
  rightRows: ReadonlyArray<Transaction>,
  options: ReconcileOptions,
): ReconcileResult {
  const left = prepare(leftRows, "left");
  const right = prepare(rightRows, "right");
  const money = (v: bigint): string => formatMajor(v, options.exponent);
  const amountOf = (t: Transaction): bigint => BigInt(t.amountMinor);

  const rightDates = new Map(right.map((r) => [r.id, r.date]));
  const claimedLeft = new Set<string>();
  const claimedRight = new Set<string>();
  const matched: Match[] = [];
  const nearMisses: NearMiss[] = [];
  const groupingTruncated: string[] = [];

  const inWindow = (a: Transaction, b: Transaction): boolean =>
    Math.abs(dayDiff(a.date, b.date)) <= options.windowDays;

  // --- pass 1: the reference both sides carry --------------------------------
  // An identifier that matches is the strongest evidence there is, which is
  // exactly why a matching reference with a DIFFERENT amount is reported as a
  // near miss and not matched: that pair is the most interesting row in the
  // file, and pairing it would hide it.
  for (const l of left) {
    if (claimedLeft.has(l.id)) continue;
    const key = normalizeReference(l.reference);
    if (key === "") continue;
    const candidates = right.filter(
      (r) => !claimedRight.has(r.id) && normalizeReference(r.reference) === key,
    );
    const exact = candidates.find((r) => amountOf(r) === amountOf(l));
    if (exact !== undefined) {
      claimedLeft.add(l.id);
      claimedRight.add(exact.id);
      matched.push({
        kind: "reference",
        leftIds: [l.id],
        rightId: exact.id,
        amountMinor: amountOf(l).toString(),
        amount: money(amountOf(l)),
        dateDeltaDays: dayDiff(l.date, exact.date),
        feeMinor: "0",
        why: `reference "${l.reference}" and an identical amount`,
      });
      continue;
    }
    const candidate = candidates[0];
    if (candidate !== undefined) {
      const delta = amountOf(l) - amountOf(candidate);
      nearMisses.push({
        kind: "reference",
        leftId: l.id,
        rightId: candidate.id,
        amountDeltaMinor: delta.toString(),
        amountDelta: money(delta),
        dateDeltaDays: dayDiff(l.date, candidate.date),
        why: `reference "${l.reference}" is the same on both sides but the amounts differ by ${money(delta)} — neither row is matched, because the disagreement is the finding`,
      });
    }
  }

  if (options.requireReferenceMatch) {
    return assemble();
  }

  // --- pass 2: identical amount inside the date window -----------------------
  for (const l of left) {
    if (claimedLeft.has(l.id)) continue;
    const candidates = right
      .filter((r) => !claimedRight.has(r.id) && amountOf(r) === amountOf(l) && inWindow(l, r))
      .sort(
        (a, b) =>
          Math.abs(dayDiff(l.date, a.date)) - Math.abs(dayDiff(l.date, b.date)) ||
          byString(a.date, b.date) ||
          byString(a.id, b.id),
      );
    const pick = candidates[0];
    if (pick === undefined) continue;
    claimedLeft.add(l.id);
    claimedRight.add(pick.id);
    matched.push({
      kind: "amount-date",
      leftIds: [l.id],
      rightId: pick.id,
      amountMinor: amountOf(l).toString(),
      amount: money(amountOf(l)),
      dateDeltaDays: dayDiff(l.date, pick.date),
      feeMinor: "0",
      why: `identical amount within ${options.windowDays} day(s)`,
    });
  }

  // --- pass 3: near misses ---------------------------------------------------
  if (options.toleranceMinor > 0n) {
    for (const l of left) {
      if (claimedLeft.has(l.id)) continue;
      const candidates = right
        .filter((r) => {
          if (claimedRight.has(r.id) || !inWindow(l, r)) return false;
          const delta = absolute(amountOf(l) - amountOf(r));
          return delta > 0n && delta <= options.toleranceMinor;
        })
        .sort((a, b) => {
          const da = absolute(amountOf(l) - amountOf(a));
          const dbb = absolute(amountOf(l) - amountOf(b));
          return da < dbb ? -1 : da > dbb ? 1 : byString(a.date, b.date) || byString(a.id, b.id);
        });
      const pick = candidates[0];
      if (pick === undefined) continue;
      const delta = amountOf(l) - amountOf(pick);
      nearMisses.push({
        kind: "tolerance",
        leftId: l.id,
        rightId: pick.id,
        amountDeltaMinor: delta.toString(),
        amountDelta: money(delta),
        dateDeltaDays: dayDiff(l.date, pick.date),
        why: `the amounts differ by ${money(delta)}, inside the tolerance — reported for a person to decide, NOT matched`,
      });
    }
  }

  // --- pass 4: several left rows bundled into one right row ------------------
  if (options.allowManyToOne) {
    for (const r of right) {
      if (claimedRight.has(r.id)) continue;
      const pool = left.filter((l) => !claimedLeft.has(l.id) && inWindow(l, r));
      const found = findSubset(
        pool,
        amountOf(r),
        options.maxSubsetSize,
        options.maxCombinations,
        options.feeToleranceMinor,
        amountOf,
      );
      if (found.truncated) groupingTruncated.push(r.id);
      if (found.subset === null) continue;
      for (const l of found.subset) claimedLeft.add(l.id);
      claimedRight.add(r.id);
      const sum = found.subset.reduce((s, l) => s + amountOf(l), 0n);
      const fee = sum - amountOf(r);
      matched.push({
        kind: fee === 0n ? "grouped" : "grouped-with-fee",
        leftIds: found.subset.map((l) => l.id),
        rightId: r.id,
        amountMinor: amountOf(r).toString(),
        amount: money(amountOf(r)),
        dateDeltaDays: Math.max(...found.subset.map((l) => Math.abs(dayDiff(l.date, r.date)))),
        feeMinor: fee.toString(),
        why:
          fee === 0n
            ? `${found.subset.length} rows sum exactly to this one`
            : `${found.subset.length} rows sum to ${money(sum)} against ${money(amountOf(r))}; the ${money(fee)} difference is within the fee tolerance and is proposed as a fee entry, never absorbed silently`,
      });
    }
  }

  return assemble();

  function assemble(): ReconcileResult {
    const unmatchedLeft = left.filter((l) => !claimedLeft.has(l.id)).map((l) => describe(l, money));
    const unmatchedRight = right
      .filter((r) => !claimedRight.has(r.id))
      .map((r) => describe(r, money));
    // A row flagged on AMOUNT alone and then explained by a later pass is no
    // longer a near miss; reporting it in both lists would have a reviewer
    // chasing a row that is already accounted for.
    //
    // A REFERENCE disagreement is never dropped, whatever claims the rows
    // afterwards. Pass 2 will happily pair the left row with some other row of
    // the same amount, and dropping the near miss then would delete the only
    // record that two documents carrying one identifier disagree about the
    // money — which is the finding this module says it exists to preserve, and
    // "the amounts happened to match somewhere else" is not an explanation of
    // it.
    const openNearMisses = nearMisses.filter(
      (n) => n.kind === "reference" || (!claimedLeft.has(n.leftId) && !claimedRight.has(n.rightId)),
    );
    const leftTotal = left.reduce((s, l) => s + amountOf(l), 0n);
    const rightTotal = right.reduce((s, r) => s + amountOf(r), 0n);
    return {
      matched,
      nearMisses: openNearMisses,
      unmatchedLeft,
      unmatchedRight,
      proposedEntries: propose(matched, unmatchedRight, rightDates, options, money),
      summary: {
        leftCount: left.length,
        rightCount: right.length,
        leftTotalMinor: leftTotal.toString(),
        rightTotalMinor: rightTotal.toString(),
        leftTotal: money(leftTotal),
        rightTotal: money(rightTotal),
        differenceMinor: (leftTotal - rightTotal).toString(),
        difference: money(leftTotal - rightTotal),
        matchedCount: matched.length,
        nearMissCount: openNearMisses.length,
        currency: options.currency,
      },
      groupingTruncated,
    };
  }
}

function describe(t: Transaction, money: (v: bigint) => string): Unmatched {
  return {
    id: t.id,
    date: t.date,
    description: t.description,
    amountMinor: String(t.amountMinor),
    amount: money(BigInt(t.amountMinor)),
    reference: t.reference,
  };
}

/**
 * The first subset, in canonical order, that sums to `target` — or to
 * `target` plus a residue no larger than `feeTolerance` when that is on.
 *
 * "First in canonical order" is the whole design. Subsets are walked by
 * ascending SIZE and then lexicographically over a pool already sorted by
 * (date, id), and the search returns immediately on a hit. So when three
 * different bundles of charges add up to the same payout — which happens
 * constantly with round numbers — the same bundle is chosen every time, and
 * the fee entry proposed next to it does not move between runs. Collecting
 * every solution and then picking would give the same answer and cost the
 * exponential blow-up this cap exists to avoid.
 */
function findSubset(
  pool: ReadonlyArray<Transaction>,
  target: bigint,
  maxSize: number,
  maxCombinations: number,
  feeTolerance: bigint,
  amountOf: (t: Transaction) => bigint,
): { subset: Transaction[] | null; truncated: boolean } {
  let examined = 0;
  const acceptable = (sum: bigint): boolean => {
    if (sum === target) return true;
    if (feeTolerance === 0n) return false;
    const residue = sum - target;
    // A fee is withheld FROM the bundle, so the payout is smaller in
    // magnitude. A residue the other way means the payout exceeds the charges
    // it supposedly bundles, which is not a fee and is not quietly absorbed.
    if (residue === 0n) return false;
    if (absolute(sum) <= absolute(target)) return false;
    return absolute(residue) <= feeTolerance;
  };

  for (let size = 2; size <= Math.min(maxSize, pool.length); size++) {
    const indices = Array.from({ length: size }, (_, i) => i);
    for (;;) {
      examined += 1;
      if (examined > maxCombinations) return { subset: null, truncated: true };
      const subset = indices.map((i) => pool[i] as Transaction);
      if (acceptable(subset.reduce((s, t) => s + amountOf(t), 0n))) {
        return { subset, truncated: false };
      }
      // Standard lexicographic successor over combinations.
      let cursor = size - 1;
      while (cursor >= 0 && (indices[cursor] as number) === pool.length - size + cursor) cursor--;
      if (cursor < 0) break;
      indices[cursor] = (indices[cursor] as number) + 1;
      for (let j = cursor + 1; j < size; j++) indices[j] = (indices[j - 1] as number) + 1;
    }
  }
  return { subset: null, truncated: false };
}

/**
 * Entries a caller could post, returned and never posted.
 *
 * Nothing in this package writes to the ledger from a reconciliation, and
 * nothing anywhere in it transmits a payment instruction. These are drafts:
 * the fee a payout withheld, and a statement line the ledger has never seen,
 * parked in suspense for a person to code.
 */
function propose(
  matched: ReadonlyArray<Match>,
  unmatchedRight: ReadonlyArray<Unmatched>,
  rightDates: ReadonlyMap<string, string>,
  options: ReconcileOptions,
  money: (v: bigint) => string,
): ProposedEntry[] {
  const accounts = options.propose;
  if (accounts === undefined) return [];
  const out: ProposedEntry[] = [];
  for (const match of matched) {
    const fee = BigInt(match.feeMinor);
    if (fee === 0n) continue;
    const magnitude = absolute(fee);
    out.push({
      // The payout's own date, not an empty string: a draft entry has to be
      // something LedgerPost would actually accept.
      date: rightDates.get(match.rightId) ?? "",
      memo: `processor fee withheld from ${match.rightId}`,
      reference: match.rightId,
      lines: [
        { account: accounts.feeAccount, debitMinor: magnitude.toString() },
        { account: accounts.bankAccount, creditMinor: magnitude.toString() },
      ],
      why: `the bundle exceeds the payout by ${money(fee)}`,
    });
  }
  for (const row of unmatchedRight) {
    const amount = BigInt(row.amountMinor);
    const magnitude = absolute(amount);
    out.push({
      date: row.date,
      memo: row.description === "" ? `unmatched statement line ${row.id}` : row.description,
      reference: row.reference,
      lines:
        amount >= 0n
          ? [
              { account: accounts.bankAccount, debitMinor: magnitude.toString() },
              { account: accounts.suspenseAccount, creditMinor: magnitude.toString() },
            ]
          : [
              { account: accounts.suspenseAccount, debitMinor: magnitude.toString() },
              { account: accounts.bankAccount, creditMinor: magnitude.toString() },
            ],
      why: "the ledger has no line for this statement row; parked in suspense for a person to code",
    });
  }
  return out;
}
