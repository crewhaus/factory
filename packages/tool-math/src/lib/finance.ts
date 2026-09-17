/**
 * Percentage relationships, loan amortization, net present value and internal
 * rate of return.
 *
 * Two families of quiet errors live here, so both are named explicitly:
 *
 *   1. MARKUP vs MARGIN. Both are "the profit as a percentage", over
 *      different denominators: markup is profit/cost, margin is profit/price.
 *      A 50% markup is a 33.3% margin. Every result below reports both, so
 *      the confusion cannot survive contact with the output.
 *
 *   2. THE t=0 CONVENTION in NPV. Here cashflow[0] sits at t=0 and is NOT
 *      discounted, which is what a finance textbook means by NPV. Excel's
 *      NPV() discounts its first argument by one full period, so the two
 *      disagree by a factor of (1+r) unless you handle it. `firstPeriod: 1`
 *      reproduces the Excel behaviour on purpose.
 *
 * Amortization is computed on integer minor units with exact rational
 * interest — balance * rate / (100 * periodsPerYear), rounded once per period
 * with the caller's rounding mode. The periodic payment itself comes from the
 * standard annuity formula, which needs (1+i)^n and therefore double
 * arithmetic; it is rounded to whole minor units immediately, and the final
 * payment is adjusted so the balance closes at exactly zero. That last step
 * is what real lenders do, and it is why the last row's payment differs by a
 * cent or two.
 */

import { type Decimal, type RoundingMode, divideRound, parseDecimal, pow10 } from "./decimal";

export class FinanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceError";
  }
}

// --- percentages -----------------------------------------------------------

export type PercentChange = {
  from: number;
  to: number;
  absoluteChange: number;
  percentChange: number;
  /** Percentage POINTS, which is what a change between two percentages is. */
  note: string;
};

/** (to - from) / |from| * 100. Undefined when `from` is 0, and refused there. */
export function percentChange(from: number, to: number): PercentChange {
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new FinanceError("both values must be finite numbers");
  }
  if (from === 0) {
    throw new FinanceError(
      "percent change from 0 is undefined (every increase would be infinite) — report the absolute change instead",
    );
  }
  return {
    from,
    to,
    absoluteChange: to - from,
    percentChange: ((to - from) / Math.abs(from)) * 100,
    note: "(to - from) / |from| * 100; if both inputs are themselves percentages, the absolute change is in percentage POINTS",
  };
}

export type PercentOfTotal = { part: number; total: number; percent: number; remainder: number };

export function percentOfTotal(part: number, total: number): PercentOfTotal {
  if (!Number.isFinite(part) || !Number.isFinite(total)) {
    throw new FinanceError("both values must be finite numbers");
  }
  if (total === 0) throw new FinanceError("percent of a zero total is undefined");
  return { part, total, percent: (part / total) * 100, remainder: total - part };
}

export type MarkupMargin = {
  cost: number;
  price: number;
  profit: number;
  markupPercent: number;
  marginPercent: number;
  definitions: { markup: string; margin: string };
};

/**
 * Complete the cost/price/markup/margin square from any two of them.
 * Definitions, because they are the whole point:
 *   markup% = (price - cost) / cost * 100
 *   margin% = (price - cost) / price * 100
 */
export function markupMargin(input: {
  cost?: number;
  price?: number;
  markupPercent?: number;
  marginPercent?: number;
}): MarkupMargin {
  const given = Object.entries(input).filter(([, v]) => v !== undefined);
  if (given.length !== 2) {
    // Exactly two, as the message has always said. One cannot determine the
    // others; three or four over-determine them, and the code silently ignored
    // the extras rather than checking that they agreed.
    const names = given.map(([key]) => key).join(", ") || "none";
    throw new FinanceError(
      given.length > 2
        ? `supply exactly two of cost, price, markupPercent, marginPercent — ${given.length} were given (${names}), which over-determines the square; drop the ones you are not certain of rather than having them silently ignored`
        : `supply exactly two of cost, price, markupPercent, marginPercent — ${given.length} was given (${names}), and one value cannot determine the others`,
    );
  }
  for (const [key, value] of given) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new FinanceError(`${key} must be a finite number`);
    }
  }
  let { cost, price } = input;
  const { markupPercent, marginPercent } = input;
  if (cost !== undefined && price === undefined) {
    if (cost === 0) throw new FinanceError("cost of 0 makes markup undefined");
    if (markupPercent !== undefined) price = cost * (1 + markupPercent / 100);
    else if (marginPercent !== undefined) {
      if (marginPercent >= 100) {
        throw new FinanceError("a margin of 100% or more implies an infinite or negative price");
      }
      price = cost / (1 - marginPercent / 100);
    }
  } else if (price !== undefined && cost === undefined) {
    if (price === 0) throw new FinanceError("price of 0 makes margin undefined");
    if (markupPercent !== undefined) {
      if (markupPercent <= -100)
        throw new FinanceError("a markup of -100% or less implies a non-positive cost");
      cost = price / (1 + markupPercent / 100);
    } else if (marginPercent !== undefined) cost = price * (1 - marginPercent / 100);
  }
  if (cost === undefined || price === undefined) {
    throw new FinanceError(
      "cost and price could not be determined from the values given; supply cost or price plus one percentage, or both cost and price",
    );
  }
  if (cost === 0) throw new FinanceError("cost of 0 makes markup undefined");
  if (price === 0) throw new FinanceError("price of 0 makes margin undefined");
  const profit = price - cost;
  return {
    cost,
    price,
    profit,
    markupPercent: (profit / cost) * 100,
    marginPercent: (profit / price) * 100,
    definitions: {
      markup: "(price - cost) / cost * 100 — profit over COST",
      margin: "(price - cost) / price * 100 — profit over PRICE",
    },
  };
}

// --- amortization ----------------------------------------------------------

export const MAX_PERIODS = 1_200;

export type AmortizationRow = {
  period: number;
  payment: string;
  interest: string;
  principal: string;
  balance: string;
};

export type Amortization = {
  periodicPaymentMinor: string;
  finalPaymentMinor: string;
  totalPaidMinor: string;
  totalInterestMinor: string;
  periods: number;
  periodRatePercent: string;
  schedule: AmortizationRow[];
  method: string;
};

export function amortize(options: {
  principalMinor: bigint;
  annualRatePercent: Decimal;
  periods: number;
  periodsPerYear: number;
  mode: RoundingMode;
  includeSchedule: boolean;
}): Amortization {
  const { principalMinor, annualRatePercent, periods, periodsPerYear, mode } = options;
  if (principalMinor <= 0n) throw new FinanceError("the principal must be greater than zero");
  if (!Number.isInteger(periods) || periods < 1 || periods > MAX_PERIODS) {
    throw new FinanceError(`periods must be an integer between 1 and ${MAX_PERIODS}`);
  }
  if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1 || periodsPerYear > 365) {
    throw new FinanceError("periodsPerYear must be an integer between 1 and 365");
  }
  if (annualRatePercent.unscaled < 0n) throw new FinanceError("the rate must not be negative");

  // Interest denominator: rate is a percentage per YEAR, so a period's
  // interest is balance * rate / (100 * periodsPerYear). Exact, as a ratio.
  const rateDenominator = pow10(annualRatePercent.scale) * 100n * BigInt(periodsPerYear);
  const rateNumerator = annualRatePercent.unscaled;
  const periodRate = Number(rateNumerator) / Number(rateDenominator);

  let payment: bigint;
  if (rateNumerator === 0n) {
    payment = divideRound(principalMinor, BigInt(periods), "ceiling");
  } else {
    const p = Number(principalMinor);
    const factor = (1 + periodRate) ** periods;
    const raw = (p * periodRate * factor) / (factor - 1);
    if (!Number.isFinite(raw)) {
      throw new FinanceError(
        "the payment is not finite at this rate and term — the numbers are outside what this schedule can represent",
      );
    }
    payment = roundNumberToBigint(raw, mode);
  }

  let balance = principalMinor;
  let totalInterest = 0n;
  let totalPaid = 0n;
  const schedule: AmortizationRow[] = [];
  let finalPayment = payment;
  let periodsUsed = 0;
  for (let period = 1; period <= periods; period++) {
    periodsUsed = period;
    const interest = divideRound(balance * rateNumerator, rateDenominator, mode);
    if (period === 1 && payment <= interest && periods > 1) {
      throw new FinanceError(
        `the level payment (${payment} minor units) does not cover the first period's interest (${interest}) — this loan never amortizes at that rate and term`,
      );
    }
    let due = payment;
    let principalPart = due - interest;
    if (period === periods || principalPart >= balance) {
      // Close the loan exactly: the last payment absorbs the rounding drift.
      principalPart = balance;
      due = balance + interest;
    }
    balance -= principalPart;
    totalInterest += interest;
    totalPaid += due;
    finalPayment = due;
    if (options.includeSchedule) {
      schedule.push({
        period,
        payment: due.toString(),
        interest: interest.toString(),
        principal: principalPart.toString(),
        balance: balance.toString(),
      });
    }
    if (balance === 0n) break;
  }
  if (balance !== 0n) {
    throw new FinanceError(
      `the schedule did not close: ${balance} minor units remain after ${periods} periods`,
    );
  }
  return {
    periodicPaymentMinor: payment.toString(),
    finalPaymentMinor: finalPayment.toString(),
    totalPaidMinor: totalPaid.toString(),
    totalInterestMinor: totalInterest.toString(),
    periods: periodsUsed,
    periodRatePercent: String(periodRate * 100),
    schedule,
    method:
      "level payment from the standard annuity formula, rounded to whole minor units; interest each period is balance * rate / (100 * periodsPerYear) rounded with the same mode; the final payment is adjusted so the balance closes at exactly zero",
  };
}

/** Round a double to a bigint through its exact decimal digits, honouring the mode. */
function roundNumberToBigint(value: number, mode: RoundingMode): bigint {
  const decimal = parseDecimal(value);
  return divideRound(decimal.unscaled, pow10(decimal.scale), mode);
}

// --- NPV / IRR -------------------------------------------------------------

export const MAX_CASHFLOWS = 2_000;

export type NpvResult = {
  rate: number;
  npv: number;
  firstPeriod: number;
  discounted: number[];
  convention: string;
};

/**
 * Net present value: sum of cashflow[t] / (1+rate)^(t + firstPeriod).
 * With `firstPeriod: 0` (the default) the first cashflow is at t=0 and is not
 * discounted. With `firstPeriod: 1` it is discounted one period, which is
 * what Excel's NPV() does.
 */
export function npv(
  rate: number,
  cashflows: ReadonlyArray<number>,
  firstPeriod: number,
): NpvResult {
  if (cashflows.length === 0) throw new FinanceError("at least one cashflow is required");
  if (cashflows.length > MAX_CASHFLOWS) {
    throw new FinanceError(`at most ${MAX_CASHFLOWS} cashflows are supported`);
  }
  if (!Number.isFinite(rate)) throw new FinanceError("rate must be a finite number");
  if (rate <= -1) {
    throw new FinanceError("a rate of -100% or lower makes the discount factor zero or negative");
  }
  const discounted = cashflows.map((cf, i) => {
    if (!Number.isFinite(cf)) throw new FinanceError(`cashflow[${i}] must be a finite number`);
    return cf / (1 + rate) ** (i + firstPeriod);
  });
  let total = 0;
  for (const d of discounted) total += d;
  if (!Number.isFinite(total)) {
    throw new FinanceError(
      "the discounted total overflowed; check the rate and the number of periods",
    );
  }
  return {
    rate,
    npv: total,
    firstPeriod,
    discounted,
    convention:
      firstPeriod === 0
        ? "cashflow[0] is at t=0 and is not discounted (textbook NPV)"
        : "cashflow[0] is discounted one period (Excel NPV() convention)",
  };
}

export type IrrResult = {
  irr: number;
  npvAtIrr: number;
  iterations: number;
  tolerance: number;
  bracket: [number, number];
  signChanges: number;
  method: string;
  warning?: string;
};

/**
 * Internal rate of return by BISECTION — the rate at which NPV is zero.
 *
 * Bisection rather than Newton-Raphson on purpose: it cannot diverge, it
 * needs no derivative, and given a bracket with a sign change it converges
 * every time, which is what a tool that must not lie needs. The cost is
 * speed, which is irrelevant at this size.
 *
 * The bracket starts at [-0.9999, 1] and the upper end doubles until the sign
 * changes or it passes 1e6 (100,000,000% — past that there is nothing useful
 * to say). Iteration stops when the bracket is narrower than `tolerance` or
 * after `maxIterations`, and the NPV at the answer is reported so the caller
 * can see how close to zero it really is.
 *
 * A cashflow series with more than one sign change can have several IRRs;
 * Descartes' rule bounds them by the number of sign changes. That case is
 * flagged, because returning one root of three without saying so is exactly
 * the confidently-wrong answer this package refuses to give.
 */
export function irr(
  cashflows: ReadonlyArray<number>,
  tolerance: number,
  maxIterations: number,
): IrrResult {
  if (cashflows.length < 2) throw new FinanceError("at least two cashflows are required");
  if (cashflows.length > MAX_CASHFLOWS) {
    throw new FinanceError(`at most ${MAX_CASHFLOWS} cashflows are supported`);
  }
  if (!(tolerance > 0) || tolerance > 0.1) {
    throw new FinanceError("tolerance must be greater than 0 and no larger than 0.1");
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10_000) {
    throw new FinanceError("maxIterations must be an integer between 1 and 10000");
  }
  let signChanges = 0;
  let previous = 0;
  for (const cf of cashflows) {
    if (!Number.isFinite(cf)) throw new FinanceError("every cashflow must be a finite number");
    const sign = Math.sign(cf);
    if (sign !== 0) {
      if (previous !== 0 && sign !== previous) signChanges++;
      previous = sign;
    }
  }
  if (signChanges === 0) {
    throw new FinanceError(
      "every cashflow has the same sign, so there is no rate at which they net to zero — an IRR does not exist for this series",
    );
  }
  const f = (rate: number): number => {
    let total = 0;
    for (let i = 0; i < cashflows.length; i++) {
      total += (cashflows[i] as number) / (1 + rate) ** i;
    }
    return total;
  };
  let lo = -0.9999;
  let hi = 1;
  const fLo = f(lo);
  let fHi = f(hi);
  if (!Number.isFinite(fLo)) throw new FinanceError("the NPV is not finite at the lower bracket");
  while (Math.sign(fLo) === Math.sign(fHi) && hi < 1e6) {
    hi *= 2;
    fHi = f(hi);
  }
  if (Math.sign(fLo) === Math.sign(fHi)) {
    throw new FinanceError(
      `no IRR found between -99.99% and ${hi * 100}%: the NPV never changes sign over that range, so no rate in it zeroes the series`,
    );
  }
  let iterations = 0;
  let mid = (lo + hi) / 2;
  while (iterations < maxIterations && hi - lo > tolerance) {
    mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (fMid === 0) break;
    if (Math.sign(fMid) === Math.sign(fLo)) lo = mid;
    else hi = mid;
    iterations++;
  }
  mid = (lo + hi) / 2;
  const result: IrrResult = {
    irr: mid,
    npvAtIrr: f(mid),
    iterations,
    tolerance,
    bracket: [lo, hi],
    signChanges,
    method: `bisection on NPV(rate)=0, stopping when the bracket is narrower than ${tolerance} or after ${maxIterations} iterations`,
  };
  if (signChanges > 1) {
    result.warning = `the cashflows change sign ${signChanges} times, so up to ${signChanges} internal rates of return can exist; this is the one found in the bracket [-0.9999, ${hi}] and may not be the only or the meaningful one`;
  }
  return result;
}
