/**
 * What a run request reserves against its tenant's token budget before it runs (#516):
 * its input at about four characters a token, plus an output ceiling. A tenant's
 * in-flight requests then count against its budget while they run, not only once their
 * usage is recorded. Methods that start no model call reserve nothing.
 */
import type { MethodT } from "@crewhaus/gateway-protocol";
import type { UsageDelta } from "./index";

/**
 * The output tokens one run is reserved for. A run request carries no output limit of
 * its own, so the estimate takes a turn's usual ceiling: the reservation is released
 * when the run ends, and the run's real usage is what is recorded.
 */
export const DEFAULT_ESTIMATE_OUTPUT_TOKENS = 4096;

/** The methods whose params carry the input a run is given. */
const RUN_METHODS: ReadonlySet<string> = new Set(["runs.create", "runs.continue"]);

/**
 * The tokens a request may spend, as {@link UsageDelta}: for `runs.create` and
 * `runs.continue`, `ceil(input characters / 4)` input tokens and
 * {@link DEFAULT_ESTIMATE_OUTPUT_TOKENS} output tokens; zero for every other method.
 */
export function estimateRunUsage(args: {
  readonly method: MethodT | string;
  readonly params: unknown;
}): UsageDelta {
  if (!RUN_METHODS.has(args.method)) return { input: 0, output: 0 };
  const input = (args.params as { readonly input?: unknown } | null | undefined)?.input;
  const chars = typeof input === "string" ? input.length : 0;
  return { input: Math.ceil(chars / 4), output: DEFAULT_ESTIMATE_OUTPUT_TOKENS };
}
