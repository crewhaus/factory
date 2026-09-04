/**
 * `buildRequestParams` (§4.4) — the per-candidate request parameters, derived
 * ONCE per candidate at boot. This is the boot-constant logic of
 * runtime-core's `thinkingRequest` / `effectiveMaxTokens`, lifted out so it
 * runs per candidate instead of once per run:
 *
 *   - the budget form of `thinking` maps verbatim; the effort form sets BOTH
 *     `thinking` (converted through the shared preset table for budget-style
 *     providers) and `reasoningEffort` (passed through for native-effort
 *     providers) — adapters ignore whichever they don't support, and every
 *     adapter gives an explicit `thinking` precedence, so the two agree;
 *   - budget-style providers require `max_tokens > thinking.budget_tokens`,
 *     so when the budget crowds the ceiling out the per-request ceiling is
 *     lifted to `budget + maxTokens` (`effectiveMaxTokens`) and the declared
 *     `maxTokens` stays the bridge / sub-agent value;
 *   - N1: a candidate's `maxTokens` is CLAMPED to its `maxOutputTokens` when
 *     the capability table (or a declared override) knows it, so a profile
 *     asking for more than the model can emit never 400s at request time.
 */
import { EFFORT_THINKING_BUDGET_TOKENS } from "@crewhaus/adapter-anthropic";
import type {
  CandidateCapabilities,
  ModelProfile,
  RequestParams,
  RequestParamsBase,
} from "./types.js";

export function buildRequestParams(
  profile: Pick<ModelProfile, "thinking" | "maxTokens" | "temperature">,
  base: RequestParamsBase,
  capabilities: Pick<CandidateCapabilities, "maxOutputTokens"> = {},
): RequestParams {
  const declared = profile.maxTokens ?? base.maxTokens;
  const cap = capabilities.maxOutputTokens;
  const clamped = cap !== undefined && declared > cap;
  const maxTokens = clamped ? (cap as number) : declared;
  const thinking = profile.thinking ?? base.thinking;
  const temperature = profile.temperature ?? base.temperature;

  const thinkingRequest =
    thinking === undefined
      ? undefined
      : "budgetTokens" in thinking
        ? { thinking: { type: "enabled" as const, budgetTokens: thinking.budgetTokens } }
        : {
            thinking: {
              type: "enabled" as const,
              budgetTokens: EFFORT_THINKING_BUDGET_TOKENS[thinking.effort],
            },
            reasoningEffort: thinking.effort,
          };

  const lifted =
    thinkingRequest !== undefined && thinkingRequest.thinking.budgetTokens >= maxTokens
      ? thinkingRequest.thinking.budgetTokens + maxTokens
      : maxTokens;
  // The lift may not exceed the model's output ceiling either — when it
  // would, the ceiling wins and the thinking budget spends from it (the
  // provider still requires budget < max_tokens; a budget at or above the
  // ceiling is a compile-time capability error, not a runtime clamp).
  const effectiveMaxTokens = cap !== undefined && lifted > cap ? cap : lifted;

  return {
    maxTokens,
    effectiveMaxTokens,
    ...(thinkingRequest !== undefined ? thinkingRequest : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(clamped ? { clampedTo: cap } : {}),
  };
}
