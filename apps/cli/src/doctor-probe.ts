/**
 * v0.3.0 Goal 6 — `crewhaus doctor --probe`: an OPT-IN live credential
 * probe. The default doctor checks only credential PRESENCE, so a present-
 * but-invalid key or an out-of-funding account sails through doctor and
 * dies mid-run. `--probe` issues one ~1-token live call per configured
 * provider (maxTokens: 1, a two-character prompt — fractions of a cent at
 * worst) through the SAME adapter stack the run path uses (model-router's
 * `resolveModel`), so what passes here is exactly what the run will do.
 *
 * Failures classify through recovery-engine's `classify()` — the single
 * choke point all four adapters normalise into — so an unfunded account
 * reports `billing`, a bad key `auth`, and doctor's output names the fix
 * class instead of dumping a raw SDK message shape.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Plan-building is pure; the prober takes an injected `resolve` seam so
 * tests drive it with a mocked adapter and no network.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { resolveModel } from "@crewhaus/model-router";
import { classify } from "@crewhaus/recovery-engine";
import {
  type DoctorCredentialCheck,
  type DoctorProviderId,
  providerCredentialsSatisfied,
  selectedProvider,
} from "./doctor-checks";

/**
 * Cheapest sensible probe model per provider, used for providers whose env
 * is configured but which the cwd spec does not select. The spec's own
 * `agent.model` is always probed verbatim for the selected provider — that
 * also catches per-model access failures (e.g. Bedrock model-access 403s).
 * bedrock and local have no default: bedrock needs a region-dependent model
 * id (probed only when the spec selects it) and local endpoints are covered
 * by `doctor --detect`'s reachability probe.
 */
export const DEFAULT_PROBE_MODELS: Partial<Record<DoctorProviderId, string>> = {
  anthropic: "claude-haiku-4-5",
  openai: "openai/gpt-4o-mini",
  gemini: "gemini/gemini-2.5-flash",
};

export type ProbeTarget = {
  readonly provider: DoctorProviderId;
  readonly model: string;
  /** Why this target is in the plan. */
  readonly reason: "spec-model" | "configured-env";
};

/**
 * Decide which providers to probe: the cwd spec's model (verbatim) for its
 * selected provider, plus the cheap default model for every OTHER provider
 * whose credentials are visibly configured. Pure — no network.
 */
export function buildProbePlan(
  specModel: string | undefined,
  env: NodeJS.ProcessEnv,
): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  const specProvider = specModel !== undefined ? selectedProvider(specModel) : undefined;
  if (specModel !== undefined && specProvider !== undefined) {
    targets.push({ provider: specProvider, model: specModel, reason: "spec-model" });
  }
  for (const [provider, model] of Object.entries(DEFAULT_PROBE_MODELS) as ReadonlyArray<
    [DoctorProviderId, string]
  >) {
    if (provider === specProvider) continue;
    if (!providerCredentialsSatisfied(model, env)) continue;
    targets.push({ provider, model, reason: "configured-env" });
  }
  return targets;
}

export type ProbeResult = {
  readonly provider: DoctorProviderId;
  readonly model: string;
  readonly pass: boolean;
  /** Human-readable outcome ("live call ok (312ms)" / "billing — …"). */
  readonly detail: string;
  /** recovery-engine taxonomy bucket on failure (billing/auth/rate_limit/…). */
  readonly failureClass?: string;
};

export type ProbeDeps = {
  /** Injected model→adapter resolution; production uses model-router's resolveModel. */
  readonly resolve?: (
    model: string,
  ) => Promise<{ readonly adapter: ProviderAdapter; readonly modelId: string }>;
  /** Injected clock for deterministic durations in tests. */
  readonly now?: () => number;
};

/** Issue the ~1-token live call for one target and classify the outcome. */
export async function probeProvider(
  target: ProbeTarget,
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const resolve = deps.resolve ?? (async (m: string) => await resolveModel(m));
  const now = deps.now ?? ((): number => performance.now());
  const startMs = now();
  try {
    const { adapter, modelId } = await resolve(target.model);
    const stream = adapter.stream({
      model: modelId,
      system: [],
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1,
    });
    // Drain — with maxTokens: 1 the whole exchange is a handful of events.
    for await (const _ of stream) {
      // Nothing to do with the token; reaching the end proves the account works.
    }
    return {
      provider: target.provider,
      model: target.model,
      pass: true,
      detail: `live call ok (${Math.round(now() - startMs)}ms)`,
    };
  } catch (err) {
    const failureClass = classify(err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      provider: target.provider,
      model: target.model,
      pass: false,
      detail: failureClass === "unknown" ? message : `${failureClass} — ${message}`,
      failureClass,
    };
  }
}

/** Run the whole plan sequentially (a probe per provider; order = plan order). */
export async function runProviderProbes(
  plan: ReadonlyArray<ProbeTarget>,
  deps: ProbeDeps = {},
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const target of plan) {
    results.push(await probeProvider(target, deps));
  }
  return results;
}

/**
 * Fold probe results into doctor's check shape (✓ / ✗ lines + exit gate).
 * Doctor's renderer prints `✓ <label>` for passes (no reason) and
 * `✗ <label>: <reason>` for failures, so the ok-detail rides in the pass
 * label and the classified failure detail in the reason.
 */
export function probeResultsToChecks(results: ReadonlyArray<ProbeResult>): DoctorCredentialCheck[] {
  return results.map((r) =>
    r.pass
      ? { label: `live probe: ${r.provider} (${r.model}) — ${r.detail}`, pass: true }
      : { label: `live probe: ${r.provider} (${r.model})`, pass: false, reason: r.detail },
  );
}
