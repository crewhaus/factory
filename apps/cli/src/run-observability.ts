/**
 * Loop contract 0.4 (Batch C, G26) — the pure resolution behind
 * `crewhaus run`'s observability env application (`--trace` + cost-on-by-
 * default). Side-effect-free so the precedence rules are unit-testable; the
 * entry file (`index.ts`) reads these and mutates `process.env` once, before
 * the runtime's subscriber layer (which is env-driven) attaches.
 *
 * The compiled bundles stamp the same env at boot (`CREWHAUS_TRACE ??=` for
 * pretty/json; `CREWHAUS_COST_TRACKING ??= "1"` unless cost is disabled); this
 * keeps `crewhaus run` byte-for-byte consistent with them, with `--trace` as
 * the per-run override that wins over both the spec block and ambient env.
 */

/** The trace levels `--trace` and `observability.trace.level` accept. */
export const TRACE_LEVELS = ["off", "ring", "pretty", "json"] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];

export function isValidTraceLevel(value: string): value is TraceLevel {
  return (TRACE_LEVELS as readonly string[]).includes(value);
}

/**
 * The value to assign to `CREWHAUS_TRACE` for this run, or `undefined` to leave
 * the ambient env untouched.
 *
 * - `--trace` present → stamp it verbatim (the flag wins absolutely over the
 *   spec block AND ambient env). `attachIfEnvSet` attaches a printer ONLY for
 *   `pretty`/`json`, so `off`/`ring` stamp a value that yields no printer.
 * - `--trace` absent → the spec's `pretty`/`json` sets a default, but only when
 *   the env is unset (env-wins, mirroring the emitters' `??=`). A spec `off`/
 *   `ring` (or absent block) leaves the env untouched.
 */
export function resolveTraceEnv(
  traceFlag: string | undefined,
  specLevel: string | undefined,
  currentTrace: string | undefined,
): string | undefined {
  if (traceFlag !== undefined) return traceFlag;
  if ((specLevel === "pretty" || specLevel === "json") && currentTrace === undefined) {
    return specLevel;
  }
  return undefined;
}

/**
 * The value to assign to `CREWHAUS_COST_TRACKING`, or `undefined` to leave the
 * env untouched. Cost tracking is ON by default (a run always meters spend)
 * unless the spec sets `observability.cost.enabled: false`; an already-set env
 * wins (`??=`).
 */
export function resolveCostEnv(
  specCostEnabled: boolean | undefined,
  currentCost: string | undefined,
): string | undefined {
  if ((specCostEnabled ?? true) === true && currentCost === undefined) return "1";
  return undefined;
}

/**
 * "Watch me" (watch-me §6.3) — the value to assign to `CREWHAUS_WATCHME`
 * (the gate runtime-core's `attachWatchmeCapture` reads), or `undefined` to
 * leave the env untouched. Unlike cost this is OFF by default: it turns on
 * when the spec opted into full capture (`watchme.enabled` with
 * `capture: "full"`, resolved by the caller into `specEnabled`) OR the
 * harness state file says watching (`.crewhaus/watchme/state.json`, so
 * `crewhaus watchme start` captures without a spec edit). An already-set
 * ambient env always wins (`??=`), matching the compiled bundles' boot
 * stamps — target-cli's preamble and target-channel-bot's G26 emitter stamp
 * the same env; keep the three in sync.
 */
export function resolveWatchmeEnv(
  specEnabled: boolean | undefined,
  stateWatching: boolean,
  current: string | undefined,
): string | undefined {
  if (current !== undefined) return undefined;
  if (specEnabled === true || stateWatching) return "1";
  return undefined;
}
