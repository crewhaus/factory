import {
  type CandidateProvider,
  type CapabilityRequirement,
  DEFAULT_CAPABILITIES,
  DEFAULT_PRICING,
  type ModelCandidate,
  type PricingTable,
  classifyPricingStaleness,
  enumerateCandidates,
  findSunset,
  resolvePricing,
} from "@crewhaus/cost-tracker";
/**
 * Item 24 — `crewhaus model-scan`, `crewhaus doctor --models`, and
 * `crewhaus pricing sync`, in a side-effect-free module (the CLI entry file
 * runs an argv switch on import) mirroring `eval-matrix.ts` / `doctor-checks.ts`.
 *
 * All three read the pricing/capability tables that ship in `@crewhaus/cost-tracker`:
 *   - model-scan enumerates capability-compatible replacement candidates for
 *     the cwd spec's `agent.model`, evals each on the spec's dataset (the same
 *     `--models` matrix machinery, injected as `runMatrix`), and emits a
 *     proposal + patch.json when a candidate beats current on score at lower
 *     cost. NEVER auto-applied — model fields are outside OPTIMIZABLE_PATHS by
 *     design, so `--write` does its OWN comment-preserving CST edit
 *     (`writeModelField`, reusing spec-patch's yaml-document technique).
 *   - doctor --models flags pricing misses / staleness / known sunsets.
 *   - pricing sync loads a versioned feed into ~/.crewhaus/pricing/.
 */
import { parseModelString } from "@crewhaus/model-router";
import type { Spec } from "@crewhaus/spec";
import { applySpecPatch } from "@crewhaus/spec-patch";

/** Thrown on a malformed model-scan / pricing-sync invocation. */
export class ModelScanError extends Error {
  override readonly name = "ModelScanError";
}

// ---------- provider mapping ----------

const CANDIDATE_PROVIDERS = ["anthropic", "openai", "gemini", "bedrock"] as const;

/** A spec model string → the `(provider, modelId)` the cost-tracker tables
 *  key on. `undefined` when unparseable or routed to a provider the tables
 *  don't cover (local/, azure/, named hosts). */
export function parsedModelForTables(
  modelString: string,
): { readonly provider: CandidateProvider; readonly modelId: string } | undefined {
  let parsed: ReturnType<typeof parseModelString>;
  try {
    parsed = parseModelString(modelString);
  } catch {
    return undefined;
  }
  // local/azure/named-host all parse to providerId "openai" but with a
  // baseUrl/azure/hostId — those aren't in the pricing table, so skip.
  if (parsed.providerId === "openai") {
    if (parsed.baseUrl !== undefined || parsed.azure !== undefined || parsed.hostId !== undefined) {
      return undefined;
    }
  }
  if (!(CANDIDATE_PROVIDERS as readonly string[]).includes(parsed.providerId)) return undefined;
  return { provider: parsed.providerId as CandidateProvider, modelId: parsed.modelId };
}

// ---------- market scan (proposal generation) ----------

/** One evaluated candidate cell — the model-scan input from the matrix run. */
export type ScanCell = {
  readonly model: string;
  readonly passRate?: number;
  readonly meanScore?: number;
  readonly costPer1kSamplesUsd?: number;
  readonly error?: string;
};

export type ScanProposal = {
  readonly currentModel: string;
  readonly candidateModel: string;
  readonly scoreDelta: number;
  readonly costDeltaPer1kUsd: number;
  /** True when the candidate strictly beats current: >= score AND < cost. */
  readonly recommended: boolean;
  readonly reason: string;
};

export type MarketScanResult = {
  readonly currentModel: string;
  readonly current?: ScanCell;
  readonly candidates: ReadonlyArray<string>;
  readonly proposals: ReadonlyArray<ScanProposal>;
  /** The single best recommended proposal (highest score at lowest cost), if any. */
  readonly best?: ScanProposal;
};

export type BuildScanCandidatesOptions = {
  readonly pricing?: PricingTable;
  readonly require?: CapabilityRequirement;
  /** Cross-provider replacements are in scope for a human-reviewed proposal. */
  readonly sameProviderOnly?: boolean;
  /** Cap the number of candidates evaled (cheapest-first). Default 6. */
  readonly limit?: number;
};

/**
 * Enumerate the replacement models model-scan will eval. Cheapest-blended
 * first, current family excluded, capped. Returns spec model strings.
 */
export function buildScanCandidates(
  currentModel: string,
  opts: BuildScanCandidatesOptions = {},
): string[] {
  const parsed = parsedModelForTables(currentModel);
  if (parsed === undefined) return [];
  const cands = enumerateCandidates(parsed, {
    pricing: opts.pricing ?? DEFAULT_PRICING,
    capabilities: DEFAULT_CAPABILITIES,
    ...(opts.require !== undefined ? { require: opts.require } : {}),
    sameProviderOnly: opts.sameProviderOnly === true,
    excludeCurrent: true,
  });
  const limit = opts.limit ?? 6;
  return cands.slice(0, limit).map((c: ModelCandidate) => c.modelString);
}

/**
 * Fold matrix cells into scan proposals. `current` is the cell for the spec's
 * existing model; each candidate cell becomes a proposal comparing score +
 * projected cost. A candidate is RECOMMENDED when it holds score (>= current)
 * AND costs less — the strict "beats current on score at lower cost" bar. The
 * `best` proposal maximizes score then minimizes cost among recommended.
 */
export function buildMarketScan(
  currentModel: string,
  cells: ReadonlyArray<ScanCell>,
): MarketScanResult {
  const current = cells.find((c) => c.model === currentModel);
  const candidateCells = cells.filter((c) => c.model !== currentModel);
  const curScore = current?.meanScore ?? 0;
  const curCost = current?.costPer1kSamplesUsd;

  const proposals: ScanProposal[] = candidateCells.map((cell): ScanProposal => {
    if (cell.error !== undefined || cell.meanScore === undefined) {
      return {
        currentModel,
        candidateModel: cell.model,
        scoreDelta: 0,
        costDeltaPer1kUsd: 0,
        recommended: false,
        reason: cell.error !== undefined ? `cell errored: ${cell.error}` : "no score",
      };
    }
    const scoreDelta = cell.meanScore - curScore;
    const candCost = cell.costPer1kSamplesUsd;
    const costDelta =
      candCost !== undefined && curCost !== undefined ? candCost - curCost : Number.NaN;
    const cheaper = Number.isFinite(costDelta) && costDelta < 0;
    const holdsScore = scoreDelta >= 0;
    const recommended = holdsScore && cheaper;
    return {
      currentModel,
      candidateModel: cell.model,
      scoreDelta,
      costDeltaPer1kUsd: Number.isFinite(costDelta) ? costDelta : 0,
      recommended,
      reason: recommended
        ? `+${scoreDelta.toFixed(3)} score at ${(costDelta as number) < 0 ? "" : "+"}${(costDelta as number).toFixed(4)} $/1k`
        : !Number.isFinite(costDelta)
          ? "cost unknown (pricing miss) — cannot compare spend"
          : !holdsScore
            ? `score dropped ${scoreDelta.toFixed(3)}`
            : "not cheaper than current",
    };
  });

  const recommended = proposals.filter((p) => p.recommended);
  // Best: max score delta, then min (most-negative) cost delta.
  const best = recommended.sort((a, b) => {
    if (b.scoreDelta !== a.scoreDelta) return b.scoreDelta - a.scoreDelta;
    return a.costDeltaPer1kUsd - b.costDeltaPer1kUsd;
  })[0];

  return {
    currentModel,
    ...(current !== undefined ? { current } : {}),
    candidates: candidateCells.map((c) => c.model),
    proposals,
    ...(best !== undefined ? { best } : {}),
  };
}

/** The machine-readable proposal artifact model-scan writes next to a report. */
export type ScanProposalArtifact = {
  readonly kind: "model-scan-proposal";
  readonly generatedAt: string;
  readonly currentModel: string;
  readonly recommendedModel: string;
  readonly scoreDelta: number;
  readonly costDeltaPer1kUsd: number;
  /** The spec edit a human (or `--write`) applies: replace agent.model. */
  readonly patch: {
    readonly op: "replace";
    readonly path: ReadonlyArray<string>;
    readonly value: string;
  };
};

/** Build the patch.json artifact for the best proposal (caller guards `best`). */
export function buildProposalArtifact(
  result: MarketScanResult,
  now: () => Date = () => new Date(),
): ScanProposalArtifact | undefined {
  if (result.best === undefined) return undefined;
  return {
    kind: "model-scan-proposal",
    generatedAt: now().toISOString(),
    currentModel: result.currentModel,
    recommendedModel: result.best.candidateModel,
    scoreDelta: result.best.scoreDelta,
    costDeltaPer1kUsd: result.best.costDeltaPer1kUsd,
    patch: { op: "replace", path: ["agent", "model"], value: result.best.candidateModel },
  };
}

// ---------- doctor --models ----------

export type ModelDoctorCheck = {
  readonly label: string;
  readonly pass: boolean;
  readonly warn?: boolean;
  readonly reason?: string;
};

export type BuildModelChecksOptions = {
  readonly pricing?: PricingTable;
  readonly now?: Date;
  /** Warn when the pricing table is older than this many days. Default 120. */
  readonly maxAgeDays?: number;
  /** Extra model strings to check (compaction.model, judge model, sub-agents). */
  readonly auxModels?: ReadonlyArray<{ readonly slot: string; readonly model: string }>;
};

/**
 * doctor --models: (a) every spec model missing from the pricing table
 * (silently billed $0 today — surfaces the gap), (b) pricing-table staleness,
 * (c) known-sunset model ids. Pure — the CLI reads the spec + prints.
 */
export function buildModelChecks(
  agentModel: string | undefined,
  opts: BuildModelChecksOptions = {},
): ModelDoctorCheck[] {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const now = opts.now ?? new Date();
  const checks: ModelDoctorCheck[] = [];

  const models: Array<{ slot: string; model: string }> = [];
  if (agentModel !== undefined) models.push({ slot: "agent.model", model: agentModel });
  for (const aux of opts.auxModels ?? []) models.push({ slot: aux.slot, model: aux.model });

  for (const { slot, model } of models) {
    const parsed = parsedModelForTables(model);
    if (parsed === undefined) {
      checks.push({
        label: `${slot} pricing (${model})`,
        pass: true,
        warn: true,
        reason:
          "routed to a provider outside the pricing table (local/azure/named-host or unparseable) — cost tracking reports $0 for this model",
      });
      continue;
    }
    const row = resolvePricing(pricing, parsed.provider, parsed.modelId);
    if (row === undefined) {
      checks.push({
        label: `${slot} pricing (${model})`,
        pass: false,
        reason: `no pricing row for ${parsed.provider}/${parsed.modelId} — cost-tracker silently bills it $0; add a row to DEFAULT_PRICING or \`crewhaus pricing sync\` a feed`,
      });
    } else {
      checks.push({ label: `${slot} pricing (${model})`, pass: true });
    }
    // Sunset watch.
    const sunset = findSunset(parsed.provider, parsed.modelId);
    if (sunset !== undefined) {
      checks.push({
        label: `${slot} sunset (${model})`,
        pass: true,
        warn: true,
        reason: `retires ${sunset.retiresOn} — migrate to ${sunset.replacement}${sunset.note !== undefined ? ` (${sunset.note})` : ""}`,
      });
    }
  }

  // Pricing-table freshness.
  const staleness = classifyPricingStaleness(pricing, now, opts.maxAgeDays ?? 120);
  checks.push({
    label: `pricing table freshness (v${staleness.version})`,
    pass: true,
    ...(staleness.stale ? { warn: true, reason: staleness.reason } : {}),
  });

  return checks;
}

// ---------- pricing sync ----------

/** ~/.crewhaus/pricing/<version>.json target path for a feed version. */
export function pricingFeedPath(homeDir: string, version: string): string {
  // Basename-safe version (dates are already safe; be defensive).
  const safe = version.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${homeDir}/.crewhaus/pricing/${safe}.json`;
}

// ---------- --write: direct comment-preserving CST edit of agent.model ----------

/**
 * Model fields are OUTSIDE `OPTIMIZABLE_PATHS` by design, so the normal
 * optimizer apply path (`validatePatch` → `applySpecPatch`) REFUSES a model
 * patch. `crewhaus model-scan --write` deliberately bypasses the whitelist
 * gate: it calls `applySpecPatch` DIRECTLY (which never consults
 * OPTIMIZABLE_PATHS — that check lives only in the separately-invoked
 * `validatePatch`), reusing spec-patch's yaml-document CST technique to
 * rewrite the value while preserving every comment, key order, and blank
 * line. The resulting YAML is re-parsed by `applySpecPatch` (so an invalid
 * model still fails loudly), and every `model-scan --write` is a
 * human-initiated action on a human-reviewed proposal — never automatic.
 *
 * Returns the rewritten YAML text (caller writes it back to disk).
 */
export function writeModelField(
  yamlText: string,
  target: Spec["target"],
  path: ReadonlyArray<string>,
  value: string,
): string {
  const { yaml } = applySpecPatch(yamlText, {
    target,
    path: [...path],
    op: "replace",
    value,
    rationale: "model-scan --write: human-reviewed model replacement (outside OPTIMIZABLE_PATHS)",
  });
  return yaml;
}
