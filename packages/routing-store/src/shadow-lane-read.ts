/**
 * 0.6.0 §7.8 / §9.1 — reading the shadow lane's TWO SIDES apart.
 *
 * A `shadow:<scope>/<band>` audition records BOTH halves of one comparison
 * under the primary's routeKey: the candidate that re-ran the turn, and the
 * arm that actually served it. The only thing separating them is the `at`
 * stamp on the raw line ({@link SHADOW_LANE_SHADOW_ARM} /
 * {@link SHADOW_LANE_PRIMARY_ARM}) — `lanes.ts` says so explicitly, and
 * `route promote` reads that stamp to decide which side may fold.
 *
 * `ArmStats` does NOT carry it: the scoreboard folds `(routeKey, model)` and
 * an aggregate line cannot hold one attribution for N observations. So a
 * reader that only has the snapshot cannot tell the audition candidate from
 * the incumbent it was graded against — and every consumer that guesses (the
 * arm with the most observations, say) can pick the INCUMBENT, because each
 * graded turn writes one observation per side and the two counts move
 * together.
 *
 * This is the discriminant, read straight off the lines: which ARM IDS
 * appear in the lane stamped as the shadow side, and which as the primary
 * side. Cheap (one sequential read of the append-only file, no folding, no
 * Welford) and honest — a lane line with no `at` stamp lands in neither set,
 * because "unattributed" is a different answer from "the candidate".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SHADOW_LANE_PREFIX, SHADOW_LANE_PRIMARY_ARM, SHADOW_LANE_SHADOW_ARM } from "./lanes.js";

/** Which arm ids the shadow lane recorded on each side of the audition. */
export type ShadowLaneSides = {
  /** Arm ids stamped {@link SHADOW_LANE_SHADOW_ARM} — the audition candidates. */
  readonly shadow: ReadonlySet<string>;
  /** Arm ids stamped {@link SHADOW_LANE_PRIMARY_ARM} — the incumbents graded against. */
  readonly primary: ReadonlySet<string>;
  /** Arm ids seen in the lane with NO `at` stamp (pre-stamp vintage). */
  readonly unattributed: ReadonlySet<string>;
};

/**
 * Read `<rootDir>/routing/arms.jsonl` and split the shadow lane's arm ids by
 * their `at` stamp. Missing file → three empty sets; a torn or non-JSON line
 * is skipped, exactly as `promoteLanes` skips it.
 */
export function readShadowLaneSides(rootDir: string): ShadowLaneSides {
  const shadow = new Set<string>();
  const primary = new Set<string>();
  const unattributed = new Set<string>();
  const path = join(rootDir, "routing", "arms.jsonl");
  if (!existsSync(path)) return { shadow, primary, unattributed };
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const routeKey = rec["k"];
    const model = rec["m"];
    if (typeof routeKey !== "string" || typeof model !== "string") continue;
    if (!routeKey.startsWith(SHADOW_LANE_PREFIX)) continue;
    const at = rec["at"];
    if (at === SHADOW_LANE_SHADOW_ARM) shadow.add(model);
    else if (at === SHADOW_LANE_PRIMARY_ARM) primary.add(model);
    else unattributed.add(model);
  }
  return { shadow, primary, unattributed };
}
