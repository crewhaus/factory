/**
 * Route a record to an owner by a declared roster.
 *
 * This is {@link ./score}'s sibling. "Which rep gets this lead?" is the same
 * shape of question as "what does this lead score?": a set of declared rules
 * against one record, answered the same way every time and explainable
 * afterwards to the rep who did or did not get it. Eligibility is expressed
 * in the same `when` the `Assert` tool evaluates, through the same
 * evaluator — there is no second vocabulary for territories.
 *
 * Two things this deliberately does not do, because the package does not:
 *
 * - **It does not persist the assignment.** The load figures come in as an
 *   argument, the way {@link ./stall} takes its history, and the advanced
 *   rotation cursor goes back out. Durable counters are
 *   `@crewhaus/tool-state`; a rotation that this tool stored itself would be
 *   a hidden write in a tool marked read-only.
 * - **It does not fall back when it cannot tell.** A roster missing a fact
 *   the strategy needs is a configuration bug, and routing it to the
 *   catch-all owner would bury that bug in somebody's inbox for a quarter.
 *   "Nobody is eligible" and "I could not work out who is" are different
 *   answers, and only the first one uses `fallback`.
 */
import { type Check, runChecks } from "@crewhaus/tool-schema";
import type { MatchMode } from "./branch";

/** How the winner is picked from the owners that are eligible. */
export const ASSIGN_STRATEGIES = ["first", "specific", "least_loaded", "round_robin"] as const;
export type AssignStrategy = (typeof ASSIGN_STRATEGIES)[number];

export type Owner = {
  readonly id: string;
  /** Eligibility. Never empty — see {@link assignOwner}. */
  readonly when: ReadonlyArray<Check>;
  readonly match?: MatchMode;
  /** Assignments this owner already holds, as the caller counts them. */
  readonly load?: number;
  /** The most this owner takes; at or above it they are skipped. */
  readonly capacity?: number;
  /**
   * Availability, as some other chain wrote it. Absent means no
   * out-of-office record exists, which is not the same as being out — the
   * flag is only ever set to take somebody out of the rotation.
   */
  readonly available?: boolean;
};

export type Roster = {
  /** Echoed into the answer, so an assignment is attributable to a revision. */
  readonly version?: string;
  readonly strategy: AssignStrategy;
  readonly owners: ReadonlyArray<Owner>;
  /**
   * `round_robin` only: where the last rotation left off. Counted over the
   * declared roster, not over whoever happens to be eligible today.
   */
  readonly cursor?: number;
  /** Used when no owner is eligible. Without it, a miss is `assigned: false`. */
  readonly fallback?: { readonly id: string };
};

/** Why one owner was in or out of the running, for the rep who asks. */
export type OwnerReport = {
  readonly id: string;
  /**
   * True in the running, false ruled out, and **null when it could not be
   * worked out** — a rep whose capacity has no load to measure against it has
   * not been shown to have room, and saying `true` there states a fact the
   * roster did not supply. This report is what the rep is shown when they
   * ask why a lead went elsewhere, so it has to be able to say "I don't
   * know" as well as "no".
   */
  readonly eligible: boolean | null;
  /** Why they were ruled out, or which fact is missing; empty when eligible. */
  readonly reason: string;
  /**
   * How many of this owner's conditions held. Not the `specific` ranking —
   * see {@link specificityOf}, which counts the conditions the territory
   * *requires* rather than the ones this record happened to satisfy.
   */
  readonly matched: number;
};

export type AssignResult = {
  /** False only when the roster could not answer; see `conflict`. */
  readonly ok: boolean;
  readonly assigned: boolean;
  readonly owner: string | null;
  /** True when `owner` came from `fallback` rather than from the roster. */
  readonly fallback: boolean;
  readonly strategy: AssignStrategy;
  readonly version: string | null;
  /**
   * Owners shown to be in the running. An owner the roster could not settle
   * — see `conflict` — is not one of them, and appears in `considered` with
   * `eligible: null`.
   */
  readonly eligible: ReadonlyArray<string>;
  /**
   * Where the next `round_robin` call should resume. Null under any other
   * strategy, and null when nothing was picked out of the roster — a
   * fallback, a miss and a refusal all leave the rotation where it was, so a
   * caller that stores this should keep its old cursor rather than clear it.
   */
  readonly cursor: number | null;
  /** Set when the roster could not answer: a tie, or a fact the strategy needs. */
  readonly conflict: string | null;
  readonly considered: ReadonlyArray<OwnerReport>;
};

/**
 * How narrowly this owner's territory is drawn, which is what `specific`
 * ranks on.
 *
 * Under `all` that is every condition, and for an eligible owner it is also
 * how many held. Under `any` exactly one is required however many happen to
 * hold, so counting the holders would rank the *record* rather than the
 * roster: `[country=DE OR language=de OR tier=smb]` would beat
 * `[country=DE AND state=BY]` for one Bavarian lead and lose to it for the
 * next, over fields neither territory asked for. An `any` territory is as
 * narrow as the one condition it insists on, so it ranks 1 — and a tie
 * against a one-condition `all` owner is reported as the overlap it is.
 */
const specificityOf = (owner: Owner): number =>
  (owner.match ?? "all") === "all" ? owner.when.length : 1;

/**
 * Pick the owner for `value` from `roster`.
 *
 * Three shapes are rejected rather than accommodated, for the reasons the
 * rest of this package rejects them:
 *
 * - **An owner with no conditions**, which is eligible for everything and
 *   would win every `first` assignment while looking like a territory. A
 *   catch-all owner is spelled `fallback`.
 * - **Two owners with one id**, because the id is what the caller writes on
 *   the record and what the rotation cursor lands on.
 * - **A non-finite load or capacity**, which makes every comparison against
 *   it false and so reads as the lowest load in the roster. A cursor that is
 *   not a whole position goes the same way.
 */
export function assignOwner(value: unknown, roster: Roster): AssignResult {
  if (roster.owners.length === 0) throw new Error("the roster has no owners");

  const seen = new Set<string>();
  for (const owner of roster.owners) {
    if (owner.when.length === 0) {
      throw new Error(
        `owner "${owner.id}" has no conditions — an owner with no conditions is eligible for everything; use "fallback" for a catch-all`,
      );
    }
    if (seen.has(owner.id)) throw new Error(`two owners share the id "${owner.id}"`);
    seen.add(owner.id);
    for (const [field, n] of [
      ["load", owner.load],
      ["capacity", owner.capacity],
    ] as const) {
      if (n !== undefined && !Number.isFinite(n)) {
        throw new Error(`owner "${owner.id}" has a non-finite ${field}`);
      }
    }
  }
  if (roster.cursor !== undefined && !Number.isInteger(roster.cursor)) {
    throw new Error(`cursor (${roster.cursor}) must be a whole number of positions`);
  }
  if (roster.cursor !== undefined && roster.cursor < 0) {
    throw new Error(`cursor (${roster.cursor}) must not be negative`);
  }

  const considered: OwnerReport[] = [];
  const candidates: Array<{ owner: Owner; index: number; specificity: number }> = [];
  /** Facts the strategy needs and the roster did not supply; see below. */
  const undetermined: string[] = [];

  for (const [index, owner] of roster.owners.entries()) {
    const report = runChecks(value, owner.when as Check[]);
    const passes = (owner.match ?? "all") === "all" ? report.ok : report.passed > 0;
    const out = (reason: string): void => {
      considered.push({ id: owner.id, eligible: false, reason, matched: report.passed });
    };

    if (!passes) {
      out(report.failures[0]?.reason ?? "no condition held");
      continue;
    }
    if (owner.available === false) {
      out("unavailable");
      continue;
    }
    // A fact the strategy needs and the roster did not supply. A capacity
    // with nothing to measure against it has not been shown to have room —
    // reading the absent load as zero is how a rep who is already full gets
    // the next twenty leads — and an absent load under least_loaded is not a
    // load of zero, which would win every rotation.
    //
    // Only owners that are otherwise eligible get here: a rep already ruled
    // out by territory does not need a load, and refusing over their missing
    // one would be a false alarm.
    //
    // Such an owner is recorded as neither in nor out. `eligible: true` here
    // would be the same mistake one level down: the answer as a whole
    // refuses, while the per-owner report a rep is shown would state, with
    // no reason, that the one owner the roster could not rank was in the
    // running.
    const missing =
      owner.capacity !== undefined && owner.load === undefined
        ? `owner "${owner.id}" declares a capacity but no load`
        : roster.strategy === "least_loaded" && owner.load === undefined
          ? `owner "${owner.id}" has no load, which least_loaded ranks on`
          : null;
    if (missing !== null) {
      undetermined.push(missing);
      considered.push({ id: owner.id, eligible: null, reason: missing, matched: report.passed });
      continue;
    }
    if (owner.capacity !== undefined && (owner.load as number) >= owner.capacity) {
      out(`at capacity (${owner.load} of ${owner.capacity})`);
      continue;
    }

    considered.push({ id: owner.id, eligible: true, reason: "", matched: report.passed });
    candidates.push({ owner, index, specificity: specificityOf(owner) });
  }

  const base = {
    strategy: roster.strategy,
    version: roster.version ?? null,
    eligible: candidates.map((c) => c.owner.id),
    considered,
  } as const;

  const refuse = (conflict: string): AssignResult => ({
    ...base,
    ok: false,
    assigned: false,
    owner: null,
    fallback: false,
    cursor: null,
    conflict,
  });

  // A missing fact is reported before anything is picked, even when only one
  // candidate is left: a roster where a rep has no load is broken now, and
  // finding that out only on the day a second rep becomes eligible is how
  // this kind of bug survives a quarter.
  if (undetermined.length > 0) return refuse(undetermined.join("; "));

  if (candidates.length === 0) {
    if (roster.fallback) {
      return {
        ...base,
        ok: true,
        assigned: true,
        owner: roster.fallback.id,
        fallback: true,
        cursor: null,
        conflict: null,
      };
    }
    return {
      ...base,
      ok: true,
      assigned: false,
      owner: null,
      fallback: false,
      cursor: null,
      conflict: null,
    };
  }

  const won = (id: string, cursor: number | null): AssignResult => ({
    ...base,
    ok: true,
    assigned: true,
    owner: id,
    fallback: false,
    cursor,
    conflict: null,
  });

  const first = candidates[0] as (typeof candidates)[number];

  switch (roster.strategy) {
    case "first":
      return won(first.owner.id, null);

    case "specific": {
      // The narrowest territory wins, so a rep insisting on country+state
      // beats one insisting on country — and the answer depends on neither
      // the order the roster was written in nor on fields the territories
      // did not ask for (see {@link specificityOf}). A tie means two
      // territories are equally narrow about the same lead, which is the
      // overlap this strategy exists to surface, not something to break by
      // position.
      let best = first;
      let tied = [first];
      for (const candidate of candidates.slice(1)) {
        if (candidate.specificity > best.specificity) {
          best = candidate;
          tied = [candidate];
        } else if (candidate.specificity === best.specificity) {
          tied.push(candidate);
        }
      }
      return tied.length === 1
        ? won(best.owner.id, null)
        : refuse(
            `owners ${tied.map((c) => `"${c.owner.id}"`).join(", ")} are equally specific (${best.specificity} conditions required each)`,
          );
    }

    case "least_loaded": {
      // Every candidate has a load by here, checked above. Ties go to the
      // earlier declaration rather than being refused, because a tie is the
      // normal state of this strategy — on the first morning every rep is on
      // zero — and the caller incrementing the winner's load is what makes
      // the next call pick somebody else.
      let best = first;
      for (const candidate of candidates.slice(1)) {
        if ((candidate.owner.load as number) < (best.owner.load as number)) best = candidate;
      }
      return won(best.owner.id, null);
    }

    case "round_robin": {
      // The cursor counts positions in the declared roster, not in today's
      // eligible subset. Indexing the subset would mean one rep going out of
      // office silently re-deals everybody else's turn, and two leads with
      // different eligible sets would fight over the same counter.
      const size = roster.owners.length;
      const start = (roster.cursor ?? 0) % size;
      const winner =
        candidates.find((c) => c.index >= start) ?? (candidates[0] as (typeof candidates)[number]);
      return won(winner.owner.id, (winner.index + 1) % size);
    }
  }
}
