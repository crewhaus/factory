/**
 * Track E (§56) — `meta-harness-optimizer`.
 *
 * **BREAKING — opt-in only.** Default optimizer mutator stays `rule`;
 * this mutator is invoked explicitly via `crewhaus optimize --mutator
 * meta-harness`. When used, the optimizer's output is a rewritten
 * bundle (`agent.ts`) that no longer round-trips through `parseSpec`.
 * That sidesteps the spec-as-source-of-truth invariant in exchange
 * for full expressiveness over the runtime program. A run header
 * comment is prepended to the bundle so reviewers see the divergence
 * immediately.
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
 *       bundle/agent.ts         (the harness code)
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
 * The proposer signature. In production this wraps a Claude Code SDK
 * call; for tests it's deterministic. The proposer is told the
 * experience-store root and asked to produce the next candidate
 * bundle's source — the orchestrator handles writing it to disk.
 */
export type ProposerFn = (summary: ExperienceStoreSummary) => Promise<{
  readonly bundleSource: string;
  readonly rationale: string;
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
}): ExperienceRecord {
  const rootAbs = ensureExperienceStore(opts.rootDir);
  const dir = join(rootAbs, "experience", opts.candidateId);
  const bundleDir = join(dir, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  const bundlePath = join(bundleDir, "agent.ts");
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
      bundlePath: join(dir, "bundle", "agent.ts"),
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
 * Optimizer-loop adapter. Wraps a `ProposerFn` so meta-harness can
 * drop into the existing `eval-optimizer-orchestrator`. Each `next()`
 * call invokes the proposer, persists the candidate, and emits a
 * `ProviderMutation` whose `prompt` field carries the bundle source
 * itself. The orchestrator's fitness function is expected to know
 * how to handle a bundle-source prompt (the CLI's --mutator
 * meta-harness mode swaps in a bundle-aware fitness).
 */
export class MetaHarnessMutationProvider implements MutationProvider {
  readonly name = "meta-harness";
  private iter = 0;

  constructor(
    private readonly rootDir: string,
    private readonly proposer: ProposerFn,
  ) {}

  async next(_state: OptimizerState): Promise<ProviderMutation> {
    const summary = readExperienceStore(this.rootDir);
    const { bundleSource, rationale } = await this.proposer(summary);
    this.iter++;
    const mutation: Mutation = { kind: "rephrase-instruction" };
    return {
      prompt: bundleSource,
      mutations: [mutation],
      rationale: `meta-harness iter ${this.iter}: ${rationale}`,
    };
  }
}
