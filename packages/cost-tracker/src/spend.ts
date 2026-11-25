/**
 * The spend meter (`@crewhaus/cost-tracker/spend`): a budget that holds for
 * calls that spend at the same time.
 *
 * Every model call in a budgeted run reserves its worst case before it is
 * dispatched and settles on its response. A call that was never sent spends
 * nothing (`release`); a call that was sent and failed counts the usage it
 * reported, or its reserved worst case when it reported none
 * (`settleUnreported`). A call is admitted while, in every scope it spends
 * from (the run, each enclosing sub-agent share, the harness's budget
 * period), the spend so far plus the OTHER active reservations stays under
 * that scope's cap; equality refuses. A call's own estimate is not added, so
 * a run that makes one call at a time decides exactly as a cap check on spend
 * so far does. A sub-agent spends from its parent's meter as it goes
 * (`child()`), so its reservations count against every ancestor's cap at once.
 *
 * A call made inside a tool never waits on the call running that tool: that
 * call settles only after the tool returns. A nested loop reserves through a
 * view (`within(id)`) that names the enclosing call's reservation as an
 * ancestor. An ancestor's reservation still counts against the cap, but it is
 * never waited for: when spend so far plus the ancestors' reservations reach a
 * cap, the answer is final (`on: "spent"`, `inFlight: true`).
 *
 * Unknown cost is never $0: an estimate of `undefined` (the model has no
 * price) reserves nothing and always admits, and a settle nothing can price
 * counts one unknown call and adds nothing to spend.
 *
 * The harness-wide period ledger is an injected port ({@link SpendLedgerPort}),
 * so this module stays filesystem-free: the worker-safe compiler imports this
 * package. `@crewhaus/control-records/budget` implements the port.
 */
import type { ProviderId } from "@crewhaus/trace-event-bus";
import { DEFAULT_PRICING, type PricingTable, computeCostMicros, resolvePricing } from "./pricing";

/** A completed call's usage, with the model it is priced under. */
export type SpendUsage = {
  readonly provider: ProviderId;
  /** WIRE model id, as `resolvePricing` looks it up. */
  readonly modelId: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheCreate?: number;
};

/** What a reservation is for: recorded on the period ledger, never content. */
export type SpendReserveMeta = {
  readonly run?: string;
  readonly root?: string;
  readonly role?: string;
  /** WIRE model id. */
  readonly model?: string;
};

/** The answer to a reservation. */
export type SpendAdmission =
  | { readonly admit: true }
  /**
   * Spend so far alone reaches a cap: waiting cannot help. `scope` says
   * which cap (the meter sets it; a ledger's own answer may omit it).
   * `held` (period scope only): the cap is reached only with reservations
   * past their lease whose holders cannot be proved gone; they still count,
   * and nothing would ever settle them, so the answer is final.
   */
  | {
      readonly admit: false;
      readonly on: "spent";
      readonly scope?: SpendScope;
      readonly held?: true;
      /**
       * The cap is reached only counting the reservation of a call still in
       * progress that this call runs inside (an ancestor): it settles only
       * after this call returns, so waiting could not end.
       */
      readonly inFlight?: true;
    }
  /**
   * Only other calls' reservations stand in the way: `settled` resolves when
   * one of them settles or releases, and the caller asks again. It never
   * resolves on a timer of its own: the calls it waits for end on their own
   * deadlines.
   */
  | { readonly admit: false; readonly on: "others"; readonly settled: Promise<void> };

/** Which cap refused, when one did. */
export type SpendScope = "run" | "share" | "period";

/**
 * The harness-wide period ledger, as the meter sees it. A type only: the
 * implementation lives where files may be written
 * (`@crewhaus/control-records/budget`), and matches it structurally.
 */
export type SpendLedgerPort = {
  /**
   * Reserve `usdMicros` against the period under the same admission rule as
   * the meter's own scopes, with the period's cap plus its top-ups.
   * `ancestors` names reservations of calls this one runs inside: they count,
   * but are never waited for (the answer is `on: "spent"`, `inFlight: true`).
   */
  reserve(entry: {
    readonly id: string;
    readonly usdMicros: number;
    readonly meta?: SpendReserveMeta;
    readonly ancestors?: readonly string[];
  }): Promise<SpendAdmission>;
  /** The call's real cost; `null` when nothing could price it. */
  settle(entry: {
    readonly id: string;
    readonly usdMicros: number | null;
    readonly meta?: SpendReserveMeta;
  }): Promise<void>;
  release(id: string): Promise<void>;
};

/** A point-in-time view of one meter scope. */
export type SpendSnapshot = {
  readonly capMicros?: number;
  readonly spentMicros: number;
  /** The sum of active reservations in this scope (its children's included). */
  readonly reservedMicros: number;
  readonly activeReservations: number;
  /** Settles nothing could price, in this scope and below. */
  readonly unknownCalls: number;
};

/** What a settle found the call cost. */
export type SpendSettled = { readonly usdMicros: number | undefined };

export type SpendMeter = {
  /**
   * Reserve `estimateMicros` for call `id` before it is dispatched.
   * `undefined` (an unpriced model) reserves nothing and always admits.
   */
  reserve(
    id: string,
    estimateMicros: number | undefined,
    meta?: SpendReserveMeta,
  ): Promise<SpendAdmission>;
  /** The call answered: price `usage` with the meter's table and record the spend. */
  settle(id: string, usage: SpendUsage, meta?: SpendReserveMeta): Promise<SpendSettled>;
  /** The call was never sent: drop its reservation, spending nothing. */
  release(id: string): Promise<void>;
  /**
   * The call was sent and reported no usage: count what it reserved as spent
   * in every scope and on the period. A call that reserved nothing (an
   * unpriced model) counts one unknown call and settles the period with
   * `null`.
   */
  settleUnreported(id: string, meta?: SpendReserveMeta): Promise<SpendSettled>;
  /** A meter for a sub-agent, spending from this one live, with its own share cap. */
  child(opts?: { readonly capMicros?: number }): SpendMeter;
  /**
   * A view on the same scopes, ledger and pricing whose reservations treat
   * `ancestor` (the reservation of the call a nested loop runs inside) as an
   * ancestor: it counts against the caps but is never waited for. The id is
   * fixed when the view is made. Views chain: a view's `within()` adds to the
   * ancestors it has, and its `child()` keeps them. An id reserved through a
   * view settles or releases through the view or its base alike.
   */
  within(ancestor: string | undefined): SpendMeter;
  snapshot(): SpendSnapshot;
  /** The table this meter prices with. */
  readonly pricing: PricingTable;
};

export type CreateSpendMeterOptions = {
  /** The run's cap, in USD-micros. Absent: this scope has no cap of its own. */
  readonly capMicros?: number;
  /** Spend already counted against the cap (a session-scoped budget's resume seed). */
  readonly seedMicros?: number;
  /** The harness-wide period, when the spec declares `budget.period`. */
  readonly ledger?: SpendLedgerPort;
  /** The effective pricing table (declared prices merged over the installed table). */
  readonly pricing: PricingTable;
};

type Reservation = {
  readonly micros: number;
  readonly done: Promise<void>;
  readonly resolve: () => void;
};

type Scope = {
  readonly parent: Scope | undefined;
  readonly capMicros: number | undefined;
  spent: number;
  unknownCalls: number;
  readonly active: Map<string, Reservation>;
};

function scopeChain(scope: Scope): Scope[] {
  const chain: Scope[] = [];
  for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) chain.push(s);
  return chain;
}

/** The scope's active reservations other than `id`, split into ancestors and the rest. */
function standingIn(
  scope: Scope,
  id: string,
  ancestors: ReadonlySet<string>,
): { anc: number; others: number; waitOn: Promise<void>[] } {
  let anc = 0;
  let others = 0;
  const waitOn: Promise<void>[] = [];
  for (const [rid, r] of scope.active) {
    if (rid === id) continue;
    if (ancestors.has(rid)) {
      anc += r.micros;
    } else {
      others += r.micros;
      waitOn.push(r.done);
    }
  }
  return { anc, others, waitOn };
}

const NO_ANCESTORS: ReadonlySet<string> = new Set();

/** Create the meter for one run tree. */
export function createSpendMeter(opts: CreateSpendMeterOptions): SpendMeter {
  const root: Scope = {
    parent: undefined,
    capMicros: opts.capMicros,
    spent: Math.max(0, opts.seedMicros ?? 0),
    unknownCalls: 0,
    active: new Map(),
  };
  return meterFor(root, opts.ledger, opts.pricing, NO_ANCESTORS, new Set());
}

function meterFor(
  scope: Scope,
  ledger: SpendLedgerPort | undefined,
  pricing: PricingTable,
  ancestors: ReadonlySet<string>,
  /** Ids the run tree reserved on the ledger, so settle and release know to write. */
  onLedger: Set<string>,
): SpendMeter {
  const chain = scopeChain(scope);

  const drop = (id: string): void => {
    const held = scope.active.get(id);
    if (held === undefined) return;
    for (const s of chain) s.active.delete(id);
    held.resolve();
  };

  const check = (id: string): SpendAdmission => {
    let others: Promise<void>[] | undefined;
    for (const s of chain) {
      if (s.capMicros === undefined) continue;
      const scopeName: SpendScope = s.parent === undefined ? "run" : "share";
      if (s.spent >= s.capMicros) {
        return { admit: false, on: "spent", scope: scopeName };
      }
      const standing = standingIn(s, id, ancestors);
      // An ancestor settles only after this call returns: never wait on it.
      if (s.spent + standing.anc >= s.capMicros) {
        return { admit: false, on: "spent", scope: scopeName, inFlight: true };
      }
      if (s.spent + standing.anc + standing.others >= s.capMicros) {
        others = [...(others ?? []), ...standing.waitOn];
      }
    }
    if (others !== undefined) {
      return { admit: false, on: "others", settled: Promise.race(others) };
    }
    return { admit: true };
  };

  return {
    pricing,
    async reserve(id, estimateMicros, meta) {
      if (estimateMicros === undefined) return { admit: true };
      const local = check(id);
      if (!local.admit) return local;
      // Hold the reservation in every scope before asking the period, so a
      // second call in this process sees it while the ledger lock is awaited.
      let resolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      const held: Reservation = { micros: Math.max(0, estimateMicros), done, resolve };
      for (const s of chain) s.active.set(id, held);
      if (ledger === undefined) return { admit: true };
      let answer: SpendAdmission;
      try {
        const onPeriod = [...ancestors].filter((a) => a !== id && onLedger.has(a));
        answer = await ledger.reserve({
          id,
          usdMicros: held.micros,
          ...(meta !== undefined ? { meta } : {}),
          ...(onPeriod.length > 0 ? { ancestors: onPeriod } : {}),
        });
      } catch (err) {
        drop(id);
        throw err;
      }
      if (!answer.admit) {
        drop(id);
        if (answer.on !== "spent") return answer;
        return {
          admit: false,
          on: "spent",
          scope: "period",
          ...(answer.held === true ? { held: true as const } : {}),
          ...(answer.inFlight === true ? { inFlight: true as const } : {}),
        };
      }
      onLedger.add(id);
      return answer;
    },
    async settle(id, usage, meta) {
      drop(id);
      const row = resolvePricing(pricing, usage.provider, usage.modelId);
      const micros =
        row === undefined
          ? undefined
          : computeCostMicros(
              row,
              usage.input,
              usage.output,
              usage.cacheRead ?? 0,
              usage.cacheCreate ?? 0,
            );
      for (const s of chain) {
        if (micros === undefined) s.unknownCalls += 1;
        else s.spent += micros;
      }
      if (ledger !== undefined) {
        onLedger.delete(id);
        await ledger.settle({
          id,
          usdMicros: micros ?? null,
          ...(meta !== undefined ? { meta } : {}),
        });
      }
      return { usdMicros: micros };
    },
    async release(id) {
      drop(id);
      if (ledger !== undefined && onLedger.delete(id)) await ledger.release(id);
    },
    async settleUnreported(id, meta) {
      const held = scope.active.get(id);
      drop(id);
      const micros = held?.micros;
      for (const s of chain) {
        if (micros === undefined) s.unknownCalls += 1;
        else s.spent += micros;
      }
      if (ledger !== undefined) {
        onLedger.delete(id);
        await ledger.settle({
          id,
          usdMicros: micros ?? null,
          ...(meta !== undefined ? { meta } : {}),
        });
      }
      return { usdMicros: micros };
    },
    child(childOpts = {}) {
      return meterFor(
        {
          parent: scope,
          capMicros: childOpts.capMicros,
          spent: 0,
          unknownCalls: 0,
          active: new Map(),
        },
        ledger,
        pricing,
        ancestors,
        onLedger,
      );
    },
    within(ancestor) {
      if (ancestor === undefined || ancestors.has(ancestor)) {
        return meterFor(scope, ledger, pricing, ancestors, onLedger);
      }
      return meterFor(scope, ledger, pricing, new Set([...ancestors, ancestor]), onLedger);
    },
    snapshot() {
      let reserved = 0;
      for (const r of scope.active.values()) reserved += r.micros;
      return {
        ...(scope.capMicros !== undefined ? { capMicros: scope.capMicros } : {}),
        spentMicros: scope.spent,
        reservedMicros: reserved,
        activeReservations: scope.active.size,
        unknownCalls: scope.unknownCalls,
      };
    },
  };
}

/**
 * Worst-case USD-micros for an upcoming call: `(inputChars +
 * metaOverheadChars) / 4` input tokens at the input rate, plus the full
 * `maxOutputTokens` ceiling at the output rate. `undefined` when the model
 * has no price: its cost is unknown, and an unknown estimate reserves
 * nothing and never blocks.
 */
export function estimateCallMicros(
  inputChars: number,
  metaOverheadChars: number,
  maxOutputTokens: number,
  provider: ProviderId,
  modelId: string,
  pricing: PricingTable = DEFAULT_PRICING,
): number | undefined {
  const row = resolvePricing(pricing, provider, modelId);
  if (!row) return undefined;
  const estInput = Math.ceil((inputChars + metaOverheadChars) / 4);
  return computeCostMicros(row, estInput, maxOutputTokens, 0);
}

/** Per-call token usage, for {@link actualCallMicros}. */
export type CallUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
};

/**
 * USD-micros for a completed call given its `usage`; `undefined` when the
 * model has no price (the cost is unknown, never $0).
 */
export function actualCallMicros(
  usage: CallUsage,
  provider: ProviderId,
  modelId: string,
  pricing: PricingTable = DEFAULT_PRICING,
): number | undefined {
  const row = resolvePricing(pricing, provider, modelId);
  if (!row) return undefined;
  return computeCostMicros(row, usage.input, usage.output, usage.cacheRead ?? 0);
}
