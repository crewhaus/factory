/**
 * Durability warnings: configurations that WORK but lose state or spend
 * without a cap in ways operators repeatedly regret. Everything here is
 * WARN — a manager may surface these prominently but never refuses to
 * start on them.
 */

import { type PreflightEnv, type PreflightItem, isEnvSet } from "./types";

export type DurabilityInput = {
  /** The spec's target shape (e.g. "channel", "cli"); undefined when the
   *  spec did not parse. */
  readonly target?: string;
  /** Whether the spec declares a `budget:` block. */
  readonly hasBudgetBlock: boolean;
  /** Whether real, spendable provider credentials are visibly set for at
   *  least one model the spec routes to (see `hasLiveProviderCredentials`). */
  readonly liveProviderCredentials: boolean;
};

export function durabilityItems(input: DurabilityInput, env: PreflightEnv): PreflightItem[] {
  const items: PreflightItem[] = [];

  // Channel daemons dedup inbound webhook deliveries by id; the default
  // store is in-memory, so every restart resets the replay window and a
  // redelivered webhook can double-run a turn.
  if (input.target === "channel" && !isEnvSet(env, "CREWHAUS_DEDUP_STORE")) {
    items.push({
      id: "durability.dedup-store",
      area: "durability",
      level: "warn",
      message:
        "channel daemon without CREWHAUS_DEDUP_STORE — the webhook dedup window resets on every restart, so redelivered events can double-run turns",
      remediation: "set CREWHAUS_DEDUP_STORE=sqlite:<path> so seen webhook ids survive restarts",
      envVar: "CREWHAUS_DEDUP_STORE",
    });
  }

  // Live credentials with no spend ceiling: a runaway loop (or a stuck
  // retry) spends uncapped until someone notices.
  if (input.liveProviderCredentials && !input.hasBudgetBlock) {
    items.push({
      id: "durability.budget",
      area: "durability",
      level: "warn",
      message:
        "live provider credentials are set but the spec declares no budget: block — a runaway loop spends uncapped",
      remediation: "add `budget: { usd: <cap> }` to the spec (on_exceed defaults to stop)",
    });
  }

  return items;
}
