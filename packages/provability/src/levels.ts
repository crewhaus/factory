/**
 * The ladder's order (design §2): four rungs above `off`, totally ordered,
 * and `"none"` below them for evidence that meets no rung at all.
 *
 * Higher-rung evidence satisfies a lower floor — an execution result
 * satisfies `cited` — so every comparison in the package goes through
 * {@link levelRank} rather than through string equality.
 */
import { PROVABILITY_LEVELS, type ProvabilityLevel, type Rung } from "./types";

const RANK: Readonly<Record<Rung, number>> = {
  none: 0,
  cited: 1,
  grounded: 2,
  checked: 3,
  proven: 4,
};

/** `none` 0, `cited` 1, `grounded` 2, `checked` 3, `proven` 4. */
export function levelRank(rung: Rung): number {
  return RANK[rung];
}

/** The rung at a rank (0..4); anything outside clamps to `none` / `proven`. */
export function rungOfRank(rank: number): Rung {
  if (!(rank >= 1)) return "none";
  return PROVABILITY_LEVELS[Math.min(Math.floor(rank), PROVABILITY_LEVELS.length) - 1] as Rung;
}

/** Does evidence at `rung` satisfy a `floor`? */
export function meetsFloor(rung: Rung, floor: ProvabilityLevel): boolean {
  return RANK[rung] >= RANK[floor];
}

/** The highest of `rungs`; `none` when given none. */
export function maxRung(...rungs: ReadonlyArray<Rung>): Rung {
  let best: Rung = "none";
  for (const rung of rungs) if (RANK[rung] > RANK[best]) best = rung;
  return best;
}

/** Is `value` one of the four rungs (not `none`, not `off`)? */
export function isProvabilityLevel(value: unknown): value is ProvabilityLevel {
  return typeof value === "string" && (PROVABILITY_LEVELS as readonly string[]).includes(value);
}
