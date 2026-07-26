/**
 * Track E (§56) — `meta-harness-optimizer`.
 *
 * **EXPERIMENTAL — opt-in only.** The default optimizer mutator stays
 * `rule-based`.
 *
 * TWO consumption modes, and the difference matters:
 *
 *   1. **Programmatic bundle rewriting (BREAKING).** Pass a
 *      `MetaHarnessMutationProvider` whose `ProposerFn` returns BUNDLE SOURCE
 *      to `optimizeSpec({ mutator })` together with a bundle-aware fitness.
 *      The optimizer's output is then a rewritten `agent.ts` that no longer
 *      round-trips through `parseSpec` — full expressiveness over the runtime
 *      program, at the cost of the spec-as-source-of-truth invariant.
 *      {@link formatBreakingChangeHeader} stamps the divergence into the
 *      bundle so a reviewer sees it immediately. This mode stays
 *      library-only, deliberately: `crewhaus optimize` writes back through
 *      `spec-patch` (`OPTIMIZABLE_PATHS` + a strict `parseSpec` re-parse),
 *      which is exactly what makes an automated write-back reviewable, and a
 *      model-authored bundle has neither gate.
 *   2. **CLI `--mutator meta-harness` (D38, Wave 5).** The CLI supplies a
 *      Claude-backed proposer that returns REPLACEMENT INSTRUCTIONS for the
 *      spec's optimised prompt, not bundle source. The paper's finding this
 *      mode adopts is about the proposer's INPUT — filesystem-backed full
 *      history beats scores-only/summary-only ablations — so the experience
 *      store below is the point, and the candidate artifact stays a
 *      spec-shaped rewrite behind the same eval-gated accept loop, budget
 *      meter and `OPTIMIZABLE_PATHS` validation as `--mutator claude`.
 *      `persistCandidate({ candidateFileName })` names the artifact honestly
 *      in that mode (`instructions.txt`, not `agent.ts`).
 *
 * Source: Meta-Harness (Lee et al., Stanford/KRAFTON/MIT,
 * arxiv 2603.28052, March 2026). The paper's key empirical finding:
 * a coding-agent proposer with **filesystem-backed full history**
 * (median 82 files per iteration, full execution traces) beats
 * scores-only and summary-only ablations by 50% vs 35% accuracy.
 * Summaries do not recover the diagnostic signal that raw traces
 * preserve.
 *
 * v0 ships the experience-store layout + the `MetaHarnessMutationProvider`
 * adapter. The actual proposer is supplied by the caller as a `ProposerFn`
 * so this package stays pure and testable (the CLI wires Claude Code
 * SDK calls as the proposer).
 *
 * Layout under `.crewhaus/optimize/<runId>/`:
 *
 *   experience/
 *     candidate_000/
 *       bundle/agent.ts         (the harness code — or `instructions.txt`
 *                                in the CLI's spec-shaped mode)
 *       scores.json             (per-sample scores)
 *       trace.jsonl             (full execution trace events)
 *     candidate_001/
 *       …
 *   meta-harness-runlog.jsonl   (one line per proposer iteration)
 *
 * Cited paper: Meta-Harness (arxiv 2603.28052, Lee et al., 2026-03).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type {
  Mutation,
  MutationProvider,
  OptimizerState,
  ProviderMutation,
} from "@crewhaus/prompt-optimizer";

export class MetaHarnessError extends CrewhausError {
  override readonly name = "MetaHarnessError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Per-candidate experience record. The full history is the union of
 * all candidate records in the experience-store directory; the proposer
 * reads selectively via filesystem operations rather than loading
 * everything into context (per the paper's median-82-files finding).
 */
export type ExperienceRecord = {
  readonly candidateId: string;
  readonly bundlePath: string;
  readonly scoresPath: string;
  readonly tracePath: string;
  /** Aggregate score for sorting candidates by quality. */
  readonly aggregateScore: number;
};

/**
 * Summary of the experience store — what the proposer sees on entry.
 * Same shape regardless of how many candidates the store contains.
 */
export type ExperienceStoreSummary = {
  readonly rootDir: string;
  readonly candidateCount: number;
  readonly bestCandidate?: ExperienceRecord;
  readonly worstCandidate?: ExperienceRecord;
  readonly records: ReadonlyArray<ExperienceRecord>;
};

/**
 * The proposer signature. In production this wraps a model call; for tests
 * it's deterministic. The proposer is told the experience-store root and
 * asked to produce the next candidate's source — the provider handles
 * handing it back to the optimizer loop.
 *
 * D38 — the SECOND argument is the optimizer's live state (current best
 * prompt, its per-sample grades, the trajectory). It is additive: a proposer
 * written before D38 declares one parameter and ignores it, unchanged. The
 * optional `usage` in the return is likewise additive — a model-backed
 * proposer reports its call's token counts so the orchestrator's `--budget-usd`
 * meter can gate the run exactly as it gates `--mutator claude`; omitting it
 * leaves the meter at $0 (the pre-D38 behaviour).
 */
export type ProposerFn = (
  summary: ExperienceStoreSummary,
  state?: OptimizerState,
) => Promise<{
  readonly bundleSource: string;
  readonly rationale: string;
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
  };
}>;

/**
 * Initialize the experience store directory if it doesn't exist.
 * Idempotent; safe to call on every optimizer iteration.
 */
export function ensureExperienceStore(rootDir: string): string {
  const abs = resolve(rootDir);
  mkdirSync(join(abs, "experience"), { recursive: true });
  return abs;
}

/**
 * Persist a candidate's full record to the experience store.
 * Returns the directory the candidate landed in.
 */
export function persistCandidate(opts: {
  readonly rootDir: string;
  readonly candidateId: string;
  readonly bundleSource: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly traceLines: ReadonlyArray<string>;
  /**
   * D38 — file name for the candidate artifact inside `bundle/`. Defaults to
   * `agent.ts` (the bundle-rewriting mode, unchanged). The CLI's spec-shaped
   * mode passes `instructions.txt` so the store never claims a prose block is
   * TypeScript. {@link readExperienceStore} resolves whatever name is there.
   */
  readonly candidateFileName?: string;
}): ExperienceRecord {
  const rootAbs = ensureExperienceStore(opts.rootDir);
  const dir = join(rootAbs, "experience", opts.candidateId);
  const bundleDir = join(dir, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  const bundlePath = join(bundleDir, opts.candidateFileName ?? "agent.ts");
  const scoresPath = join(dir, "scores.json");
  const tracePath = join(dir, "trace.jsonl");
  writeFileSync(bundlePath, opts.bundleSource, { mode: 0o600 });
  writeFileSync(scoresPath, JSON.stringify(opts.scores, null, 2), { mode: 0o600 });
  writeFileSync(tracePath, opts.traceLines.join("\n") + (opts.traceLines.length > 0 ? "\n" : ""), {
    mode: 0o600,
  });
  // Aggregate score: simple mean of any numeric values in `scores`.
  let total = 0;
  let count = 0;
  for (const v of Object.values(opts.scores)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      count++;
    }
  }
  const aggregateScore = count === 0 ? 0 : total / count;
  return {
    candidateId: opts.candidateId,
    bundlePath,
    scoresPath,
    tracePath,
    aggregateScore,
  };
}

/**
 * D38 — the candidate artifact's real file name inside a `bundle/` dir. The
 * bundle-rewriting mode writes `agent.ts`; the CLI's spec-shaped mode writes
 * `instructions.txt`. Prefers `agent.ts` when present so an existing store
 * reads back byte-identically, otherwise takes the first entry (sorted), and
 * falls back to `agent.ts` for an unreadable/empty dir — the record then names
 * the conventional path exactly as it did before this option existed.
 */
function resolveCandidateFileName(bundleDir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(bundleDir).sort();
  } catch {
    return "agent.ts";
  }
  if (entries.includes("agent.ts")) return "agent.ts";
  return entries[0] ?? "agent.ts";
}

/**
 * Scan the experience store and produce a summary the proposer can
 * inspect. Does NOT load file contents — that's the proposer's
 * responsibility (it'll `cat` and `grep` selectively, per the paper).
 */
export function readExperienceStore(rootDir: string): ExperienceStoreSummary {
  const abs = resolve(rootDir);
  const expDir = join(abs, "experience");
  let entries: string[];
  try {
    entries = readdirSync(expDir).sort();
  } catch {
    return {
      rootDir: abs,
      candidateCount: 0,
      records: [],
    };
  }
  const records: ExperienceRecord[] = [];
  for (const name of entries) {
    const dir = join(expDir, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // ignore
    }
    if (!isDir) continue;
    const scoresPath = join(dir, "scores.json");
    let scores: Record<string, number> = {};
    try {
      scores = JSON.parse(readFileSync(scoresPath, "utf8")) as Record<string, number>;
    } catch {
      // Missing or unreadable scores — skip aggregate but include the record.
    }
    let total = 0;
    let count = 0;
    for (const v of Object.values(scores)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        total += v;
        count++;
      }
    }
    records.push({
      candidateId: name,
      bundlePath: join(dir, "bundle", resolveCandidateFileName(join(dir, "bundle"))),
      scoresPath,
      tracePath: join(dir, "trace.jsonl"),
      aggregateScore: count === 0 ? 0 : total / count,
    });
  }
  let best: ExperienceRecord | undefined;
  let worst: ExperienceRecord | undefined;
  for (const r of records) {
    if (best === undefined || r.aggregateScore > best.aggregateScore) best = r;
    if (worst === undefined || r.aggregateScore < worst.aggregateScore) worst = r;
  }
  return {
    rootDir: abs,
    candidateCount: records.length,
    ...(best !== undefined ? { bestCandidate: best } : {}),
    ...(worst !== undefined ? { worstCandidate: worst } : {}),
    records,
  };
}

/**
 * Run-header comment prepended to any bundle produced by this
 * optimizer. Makes the divergence from the source spec immediately
 * visible to a future reviewer reading the bundle.
 */
export function formatBreakingChangeHeader(opts: {
  readonly runId: string;
  readonly proposerName: string;
  readonly iterationsRun: number;
  readonly bestAggregateScore: number;
}): string {
  return [
    "// ⚠ meta-harness-optimizer rewrote this bundle.",
    `// run: ${opts.runId}`,
    `// proposer: ${opts.proposerName}`,
    `// iterations: ${opts.iterationsRun}`,
    `// best aggregate score: ${opts.bestAggregateScore.toFixed(3)}`,
    "// This bundle no longer corresponds to a re-compileable spec.",
    "// Source: Meta-Harness (arxiv 2603.28052). See factory/CHANGELOG.md Track E.",
    "",
  ].join("\n");
}

/**
 * D38 — pricing/metering metadata a MODEL-backed proposer exposes so the
 * orchestrator's FR-003 budget gate can treat this provider exactly like
 * `ClaudeMutationProvider`. The orchestrator feature-detects the matching
 * getters (`providerId` / `modelId` / `maxOutputTokens`) and the optional
 * `estimateInputChars(state)` hook; omitting these options leaves the meter
 * unpriced ($0, gate inert) — the pre-D38 behaviour for a deterministic
 * proposer that issues no model call.
 */
export type MetaHarnessMutationProviderOptions = {
  /** Adapter provider id (`anthropic` / `openai` / …) for the pricing table. */
  readonly providerId?: string;
  /** Wire model id the proposer calls. */
  readonly modelId?: string;
  /** Output-token ceiling per proposer call (the gate's worst case). */
  readonly maxOutputTokens?: number;
  /** Exact serialized INPUT char count the proposer will transmit for `state`. */
  readonly estimateInputChars?: (state: OptimizerState) => number;
  /** Artifact file name the store records for this run's candidates. */
  readonly candidateFileName?: string;
};

/**
 * Optimizer-loop adapter. Wraps a `ProposerFn` so meta-harness can
 * drop into the existing `eval-optimizer-orchestrator`. Each `next()`
 * call reads the experience store, invokes the proposer, and emits a
 * `ProviderMutation` whose `prompt` field carries whatever the proposer
 * produced — bundle source in the programmatic mode, replacement
 * instructions in the CLI's spec-shaped mode (see the module docs). The
 * caller's fitness function owns the interpretation; writing the candidates
 * BACK into the store (so the next proposer call sees full history) is also
 * the caller's job, via {@link persistCandidate}.
 */
export class MetaHarnessMutationProvider implements MutationProvider {
  readonly name = "meta-harness";
  private iter = 0;
  private readonly opts: MetaHarnessMutationProviderOptions;

  constructor(
    private readonly rootDir: string,
    private readonly proposer: ProposerFn,
    opts: MetaHarnessMutationProviderOptions = {},
  ) {
    this.opts = opts;
  }

  /** FR-003 cost-gate seam — see {@link MetaHarnessMutationProviderOptions}. */
  get modelId(): string | undefined {
    return this.opts.modelId;
  }

  get providerId(): string | undefined {
    return this.opts.providerId;
  }

  get maxOutputTokens(): number | undefined {
    return this.opts.maxOutputTokens;
  }

  /** The artifact file name this run's candidates are stored under. */
  get candidateFileName(): string {
    return this.opts.candidateFileName ?? "agent.ts";
  }

  /** FR-003 — exact input size of the upcoming proposer call, when known. */
  estimateInputChars(state: OptimizerState): number | undefined {
    return this.opts.estimateInputChars?.(state);
  }

  async next(state: OptimizerState): Promise<ProviderMutation> {
    const summary = readExperienceStore(this.rootDir);
    const { bundleSource, rationale, usage } = await this.proposer(summary, state);
    this.iter++;
    const mutation: Mutation = { kind: "rephrase-instruction" };
    return {
      prompt: bundleSource,
      mutations: [mutation],
      rationale: `meta-harness iter ${this.iter}: ${rationale}`,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}
