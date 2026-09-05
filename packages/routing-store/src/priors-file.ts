/**
 * 0.6.0 §7.11 N2 — the fs half of eval-seeded priors. `eval leaderboard
 * --export-priors` writes `<rootDir>/routing/priors.json` (the
 * `@crewhaus/model-plan` `PriorsFile` shape, reward units, pseudo-count
 * capped); this module only READS the raw JSON beside the arms so the pure
 * validator (`loadPriors`) stays fs-free and runtime-core owns the boot
 * warning. A missing file is `undefined`; a file that is not valid JSON is
 * reported as `{ error }` — never thrown, because a corrupt priors file must
 * degrade to cold warm-up, not stop the run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROUTING_PRIORS_FILE = "priors.json";

/** `<rootDir>/routing/priors.json`. */
export function routingPriorsPath(rootDir: string): string {
  return join(rootDir, "routing", ROUTING_PRIORS_FILE);
}

export type RawRoutingPriors =
  | { readonly ok: true; readonly raw: unknown; readonly path: string }
  | { readonly ok: false; readonly error: string; readonly path: string };

/** Read the priors file as raw JSON (validation is `loadPriors`'s job). */
export function readRoutingPriorsRaw(rootDir: string): RawRoutingPriors | undefined {
  const path = routingPriorsPath(rootDir);
  if (!existsSync(path)) return undefined;
  try {
    return { ok: true, raw: JSON.parse(readFileSync(path, "utf8")), path };
  } catch (err) {
    return {
      ok: false,
      error: `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      path,
    };
  }
}
