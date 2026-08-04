import { lower } from "@crewhaus/compiler";
import type { IrChannels } from "@crewhaus/ir";
import {
  type CredentialCheck,
  type CredentialProviderId,
  buildChannelEnvSummaryChecks,
} from "@crewhaus/preflight";
import { parseSpec } from "@crewhaus/spec";

/**
 * Model-aware credential checks for `crewhaus doctor` — the check CORE moved
 * to `@crewhaus/preflight` (its doctor-compatible credential layer preserves
 * these checks' semantics and messages byte-for-byte), so any manager can
 * run them against an injected environment. This module stays as the CLI's
 * import surface: the doctor-era names re-export the preflight
 * implementations, and the one piece that needs the compiler — lowering the
 * cwd spec to a channel IR — stays here, feeding preflight's channel-env
 * summary checks.
 */

export {
  buildCredentialChecks,
  extractSpecModel,
  providerCredentialsSatisfied,
  providerEnvStubs,
  selectedProvider,
} from "@crewhaus/preflight";

/** Doctor-level provider id — preflight's `CredentialProviderId` under the
 *  name the doctor surfaces have always imported. */
export type DoctorProviderId = CredentialProviderId;

/** Doctor check shape — identical to preflight's `CredentialCheck`
 *  (label/pass/warn/reason; warn+pass renders as "~"). */
export type DoctorCredentialCheck = CredentialCheck;

/**
 * Item 61 — tolerantly extract the lowered channels block from a
 * crewhaus.yaml text. Returns undefined when the spec doesn't parse/lower or
 * is not a channel target, mirroring `extractSpecModel`'s tolerance —
 * doctor must never fail because the cwd spec is a different shape. Lowering
 * (not raw parsing) is deliberate: `lower()` is where `$VAR_NAME` strings
 * become env-refs, so the check shares the compiled daemon's exact env
 * semantics instead of re-implementing the regex. Kept in the CLI because it
 * needs the compiler, which the preflight package deliberately does not
 * depend on.
 */
export function extractChannelIr(yamlText: string): IrChannels | undefined {
  try {
    const ir = lower(parseSpec(yamlText));
    return ir.target === "channel" ? ir.channels : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Item 61 — channel-target doctor checks: one per configured platform
 * (slack/telegram/discord), asserting that every secret env-ref the compiled
 * daemon requires at boot (target-channel-bot's startup check exits 2 on the
 * same set) is actually set. Returns [] for non-channel specs, so the check
 * only appears when the cwd spec is a channel target. Offline by design —
 * live platform probes (granted scopes, webhook state) belong to
 * `crewhaus channel verify`, which the failure reason points at. The
 * per-platform summary rendering lives in preflight
 * (`buildChannelEnvSummaryChecks`); this wrapper supplies the compiler-
 * lowered channels block.
 */
export function buildChannelEnvChecks(
  yamlText: string,
  env: NodeJS.ProcessEnv,
): DoctorCredentialCheck[] {
  const channels = extractChannelIr(yamlText);
  if (channels === undefined) return [];
  return buildChannelEnvSummaryChecks(channels, env);
}
