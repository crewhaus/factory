/**
 * Anonymous + OAuth-signed-in quota for the playground server.
 *
 * Pure function — the server passes in current usage, gets back an
 * accept/reject decision + the new state to persist. Decoupling the
 * decision from storage lets us swap in Redis / Postgres in production
 * without touching the policy.
 */
import { CrewhausError } from "@crewhaus/errors";

export class PlaygroundQuotaError extends CrewhausError {
  override readonly name = "PlaygroundQuotaError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type Tier = "anonymous" | "signed-in" | "team";

export type QuotaConfig = {
  /** Max runs in `windowSeconds`. */
  readonly maxRuns: number;
  /** Window in seconds. */
  readonly windowSeconds: number;
};

export const DEFAULT_QUOTA: Readonly<Record<Tier, QuotaConfig>> = {
  anonymous: { maxRuns: 5, windowSeconds: 60 * 60 },
  "signed-in": { maxRuns: 50, windowSeconds: 60 * 60 },
  team: { maxRuns: 500, windowSeconds: 60 * 60 },
};

export type QuotaState = {
  /** Wall-clock timestamps (ms since epoch) of each prior run in the active window. */
  readonly runs: ReadonlyArray<number>;
};

export type QuotaDecision =
  | { readonly accepted: true; readonly state: QuotaState; readonly remaining: number }
  | {
      readonly accepted: false;
      readonly reason: string;
      readonly retryAfterSeconds: number;
      readonly state: QuotaState;
    };

export function enforceQuota(args: {
  state: QuotaState;
  tier: Tier;
  now?: number;
  config?: QuotaConfig;
}): QuotaDecision {
  const config = args.config ?? DEFAULT_QUOTA[args.tier];
  if (!config) {
    throw new PlaygroundQuotaError(`unknown tier: ${args.tier}`);
  }
  const now = args.now ?? Date.now();
  const cutoff = now - config.windowSeconds * 1000;
  const recent = args.state.runs.filter((ts) => ts > cutoff);
  if (recent.length >= config.maxRuns) {
    const oldest = recent[0] ?? now;
    const retryAfterSeconds = Math.ceil((oldest + config.windowSeconds * 1000 - now) / 1000);
    return {
      accepted: false,
      reason: `quota exceeded for ${args.tier} tier (${recent.length}/${config.maxRuns} in last ${config.windowSeconds}s)`,
      retryAfterSeconds: Math.max(retryAfterSeconds, 1),
      state: { runs: recent },
    };
  }
  const newRuns = [...recent, now];
  return {
    accepted: true,
    state: { runs: newRuns },
    remaining: config.maxRuns - newRuns.length,
  };
}
