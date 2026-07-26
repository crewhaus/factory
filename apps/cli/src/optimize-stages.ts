/**
 * Evals Wave 5, cluster O (D36 — the optimize half) — run one optimizer
 * CANDIDATE of a multi-stage spec through the Wave-4 eval bridge.
 *
 * Wave 4 (cluster S) made workflow / graph / crew / pipeline evaluable by
 * DRIVING their compiled runtime: `crewhaus compile --with-eval-harness`
 * emits the shape's eval-entry bundle variant and a sibling `target: eval`
 * bundle whose invoker wraps the compiled entry. This module performs the
 * same three steps in-process, once per candidate, so `crewhaus optimize`
 * measures a multi-stage candidate on exactly the artifact the shape ships:
 *
 *   1. `compile(patchedYaml, { evalEntry: true })` — the SAME pipeline
 *      `--with-eval-harness` drives (not a second bespoke emitter), written
 *      into a per-candidate directory. This doubles as the compile gate: a
 *      candidate whose rewritten stage no longer compiles scores 0 and the
 *      search moves on.
 *   2. `import(<candidateDir>/<entry>)` — the compiled runtime entry
 *      (`agent.ts`'s `runForEval` for workflow/graph/pipeline, the additive
 *      `eval-entry.ts` for crew). Each candidate lands in its own directory,
 *      so the module cache never serves candidate N-1's runtime for
 *      candidate N.
 *   3. `createBridgeInvoker(bridge, entry)` + `projectEvalIr(ir)` — the same
 *      invoker and the same descriptor-agent projection the generated bundle
 *      uses, handed to `runEval` through its `opts.invoker` seam.
 *
 * HONEST BOUNDARY — read before promising anything: the emitted candidate
 * bundle carries bare `@crewhaus/*` imports. Importing it resolves those the
 * ordinary Node/Bun way, by walking `node_modules` up from the candidate
 * directory, so the candidate dir MUST live inside a project whose
 * dependencies are installed (the default `-o` puts it under
 * `.crewhaus/optimize/<runId>/` in the operator's own harness, which is
 * exactly that). A candidate dir outside such a tree fails at import with the
 * resolver's own error; {@link BridgedCandidateError} names the cause. The
 * `importEntry` option is the seam tests use to drive the wiring without a
 * workspace.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { compile, lower, parseSpec } from "@crewhaus/compiler";
import type { IrNode } from "@crewhaus/ir";
import { formatWriteBackHeader } from "@crewhaus/spec-patch";
import { EvalBridgeError, projectEvalIr, selectInvoker } from "./eval-bridge";

export class BridgedCandidateError extends Error {
  override readonly name = "BridgedCandidateError";
}

/** Structural mirror of eval-runner's `AgentInvoker` (kept local so this
 *  module needs no value import from the runner). */
type BridgedInvoker = (req: {
  readonly sample: { readonly id: string; readonly input: string };
  readonly runContext: { readonly sessionId: string };
  readonly sessionRootDir: string;
  readonly seed?: number;
}) => Promise<{ readonly agentOutput: string }>;

/** The descriptor IR a bridged run records — structurally the `IrV0` the
 *  generated eval bundle builds (target: cli, bridge-descriptor agent). */
export type BridgedDescriptorIr = {
  readonly version: 0;
  readonly name: string;
  readonly target: "cli";
  readonly agent: { readonly model: string; readonly instructions: string };
  readonly tools: ReadonlyArray<string>;
  readonly toolConfigs: Record<string, never>;
  readonly mcp_servers: Record<string, never>;
  readonly permissions: { readonly rules: ReadonlyArray<never> };
  readonly subAgents: ReadonlyArray<never>;
  readonly compaction: Record<string, never>;
  readonly failureTaxonomy?: unknown;
};

export type PrepareBridgedCandidateOptions = {
  /** The candidate's spec YAML (already carrying the stage rewrite). */
  readonly patchedYaml: string;
  /** Directory this candidate's compiled bundle is written into. */
  readonly candidateDir: string;
  /**
   * Test seam: resolve the compiled entry module. Defaults to a dynamic
   * `import()` of the freshly written file — the production path.
   */
  readonly importEntry?: (entryPath: string) => Promise<Record<string, unknown>>;
  /**
   * Test seam threaded into `createBridgeInvoker` (a scripted
   * `ProviderAdapter`), mirroring the bridge-smoke driver. Never set by the
   * CLI.
   */
  readonly adapter?: unknown;
};

export type PreparedBridgedCandidate = {
  /** Descriptor IR for `runEval` (run identity + the shape's recorded model). */
  readonly ir: BridgedDescriptorIr;
  /** The invoker that drives this candidate's compiled runtime per sample. */
  readonly invoker: BridgedInvoker;
  /** Absolute path of the compiled entry module that was imported. */
  readonly entryPath: string;
  /** The bridge kind driving it (`workflow-run`, `crew-run`, …). */
  readonly invokerKind: string;
};

/**
 * Compile ONE candidate spec into `candidateDir` and wrap its compiled
 * runtime entry in the Wave-4 bridge invoker.
 *
 * Throws `BridgedCandidateError` when the shape has no compiled entry to
 * drive (an entry-less bridge is evaluated by the runner's default invoker —
 * the caller should not be here) or when the emitted bundle does not carry
 * the entry file. Compile failures propagate from `compile()` verbatim so the
 * caller can score the candidate 0 and continue.
 */
export async function prepareBridgedCandidate(
  opts: PrepareBridgedCandidateOptions,
): Promise<PreparedBridgedCandidate> {
  const sourceIr = lower(parseSpec(opts.patchedYaml)) as IrNode;
  const strategy = selectInvoker(sourceIr.target);
  if (strategy.entryImport === undefined) {
    throw new BridgedCandidateError(
      `target: ${sourceIr.target} has no compiled runtime entry to drive — it is evaluated through the eval-runner's default invoker, so it never needs a bridged candidate`,
    );
  }
  let projected: ReturnType<typeof projectEvalIr>;
  try {
    projected = projectEvalIr(sourceIr);
  } catch (err) {
    if (err instanceof EvalBridgeError) throw new BridgedCandidateError(err.message);
    throw err;
  }

  // 1 — the SAME emission `crewhaus compile --with-eval-harness` performs.
  // README emission is off: a candidate bundle is a measurement artifact, not
  // something a human reads, and the README is the slowest file to render.
  const bundle = compile(opts.patchedYaml, { readme: false, evalEntry: true });
  const absDir = resolve(opts.candidateDir);
  mkdirSync(absDir, { recursive: true });
  for (const file of bundle.files) {
    const full = join(absDir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, { mode: 0o600 });
  }
  // `entryImport` is written relative to the EVAL bundle dir (`../agent.ts`);
  // here the primary bundle IS the candidate dir, so only the file name applies.
  const entryFile = basename(strategy.entryImport);
  if (!bundle.files.some((f) => f.path === entryFile)) {
    throw new BridgedCandidateError(
      `the compiled ${sourceIr.target} bundle does not contain ${entryFile} — the eval-entry variant should have emitted it (files: ${bundle.files.map((f) => f.path).join(", ")})`,
    );
  }
  const entryPath = join(absDir, entryFile);

  // 2 — import the compiled entry. A fresh directory per candidate keeps the
  // module cache from serving an earlier candidate's runtime.
  const importer = opts.importEntry ?? defaultImportEntry;
  let entry: Record<string, unknown>;
  try {
    entry = await importer(entryPath);
  } catch (err) {
    throw new BridgedCandidateError(
      `could not import the compiled ${sourceIr.target} entry at ${entryPath}: ${err instanceof Error ? err.message : String(err)} — a bridged optimize run resolves the bundle's @crewhaus/* imports from the candidate directory upward, so run it inside a harness whose dependencies are installed`,
      { cause: err },
    );
  }

  // 3 — the bridge invoker + descriptor IR, exactly as the generated bundle
  // assembles them.
  const { createBridgeInvoker } = await import("@crewhaus/target-eval-bundle/runtime");
  const bridge = {
    sourceTarget: sourceIr.target,
    kind: strategy.kind,
    chatCapable: strategy.chatCapable,
    entryImport: strategy.entryImport,
  } as const;
  const invoker = createBridgeInvoker(
    bridge,
    entry,
    opts.adapter !== undefined ? { _adapter: opts.adapter } : {},
  ) as unknown as BridgedInvoker;

  const ir: BridgedDescriptorIr = {
    version: 0,
    name: projected.name,
    target: "cli",
    agent: { model: projected.agent.model, instructions: projected.agent.instructions },
    tools: projected.agent.tools,
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},
    ...(projected.failureTaxonomy !== undefined
      ? { failureTaxonomy: projected.failureTaxonomy }
      : {}),
  };
  return { ir, invoker, entryPath, invokerKind: strategy.kind };
}

/** Production entry resolution — a plain dynamic import of the written file. */
async function defaultImportEntry(entryPath: string): Promise<Record<string, unknown>> {
  return (await import(entryPath)) as Record<string, unknown>;
}

/**
 * One line per stage for `--help` and the run header, e.g.
 * `draft (step), polish (step)`.
 */
export function formatStageSummary(
  stages: ReadonlyArray<{ readonly name: string; readonly kind: string }>,
): string {
  return stages.map((s) => `${s.name} (${s.kind})`).join(", ");
}

// ---------------------------------------------------------------------------
// D36 — the SEQUENTIAL multi-stage driver.
// ---------------------------------------------------------------------------

/** What one stage's optimize pass produced. Mirrors the orchestrator's
 *  `OptimizeSpecResult` fields the driver needs, kept structural so this
 *  module has no dependency on the orchestrator. */
export type StageRunOutcome = {
  readonly applied: boolean;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly improvement: number;
  /** The candidate YAML the winning patch produced (composed into the next
   *  stage's starting point when `applied`). */
  readonly patchedYaml: string;
  /** Spend this stage consumed, in USD micros (0 for a rule-based search). */
  readonly spentUsdMicros: number;
  /** Whether the stage's own run stopped on the budget rather than iterations. */
  readonly budgetExhausted: boolean;
};

export type StageRunRequest<S extends OptimizableStageLike = OptimizableStageLike> = {
  readonly stage: S;
  /** The spec the stage's search must read (composed from earlier accepts). */
  readonly specPath: string;
  /** Remaining run budget in USD, when the operator set one. */
  readonly budgetUsd?: number;
  /** 1-based position, for run ids / out-dir naming. */
  readonly index: number;
};

/** Structural mirror of the orchestrator's `OptimizableStage`. */
export type OptimizableStageLike = {
  readonly name: string;
  readonly kind: string;
  readonly path: ReadonlyArray<string>;
  readonly instructions: string;
};

export type RunStagedOptimizeOptions<S extends OptimizableStageLike = OptimizableStageLike> = {
  readonly stages: ReadonlyArray<S>;
  /** The spec the FIRST stage starts from. */
  readonly startingYamlPath: string;
  /** Directory the composed working copies are written into. */
  readonly workingDir: string;
  /** Run-level dollar ceiling, threaded down as REMAINING budget per stage. */
  readonly budgetUsd?: number;
  readonly runStage: (req: StageRunRequest<S>) => Promise<StageRunOutcome>;
  readonly log?: (line: string) => void;
};

export type StagedOptimizeResult<S extends OptimizableStageLike = OptimizableStageLike> = {
  readonly perStage: ReadonlyArray<{
    readonly stage: S;
    readonly outcome: StageRunOutcome;
  }>;
  readonly acceptedCount: number;
  /** Path of the spec carrying every accepted stage — equals
   *  `startingYamlPath` when nothing was accepted (nothing was written). */
  readonly finalYamlPath: string;
  readonly totalSpentUsdMicros: number;
  /** True when the run stopped before visiting every stage (budget). */
  readonly stoppedEarly: boolean;
  /** Stages never visited because the budget ran out. */
  readonly skipped: ReadonlyArray<S>;
};

/**
 * Optimize a multi-stage spec ONE STAGE AT A TIME, in declaration order, each
 * gated independently by `runStage`'s own accept decision.
 *
 * Composition: a stage that is ACCEPTED writes its patched YAML into
 * `workingDir` and the next stage starts from that file, so later stages are
 * measured against the improvements earlier ones bought. A stage that is
 * REJECTED leaves the working spec exactly as it was — its candidates are
 * discarded, and the run moves on rather than aborting (one stage failing to
 * improve says nothing about the next).
 *
 * Budget: `budgetUsd` is a RUN ceiling, not a per-stage one. Each stage is
 * handed the REMAINING budget; once a stage reports the budget exhausted (or
 * the remainder rounds to zero) the driver stops and reports the unvisited
 * stages instead of silently spending N x the cap.
 *
 * The source spec is never touched here — the caller owns write-back.
 */
export async function runStagedOptimize<S extends OptimizableStageLike>(
  opts: RunStagedOptimizeOptions<S>,
): Promise<StagedOptimizeResult<S>> {
  const log = opts.log ?? (() => {});
  const perStage: Array<{ stage: S; outcome: StageRunOutcome }> = [];
  const skipped: S[] = [];
  let currentPath = opts.startingYamlPath;
  let acceptedCount = 0;
  let totalSpentUsdMicros = 0;
  let stoppedEarly = false;
  const budgetMicros =
    opts.budgetUsd !== undefined ? Math.round(opts.budgetUsd * 1_000_000) : undefined;

  mkdirSync(resolve(opts.workingDir), { recursive: true });

  for (let i = 0; i < opts.stages.length; i += 1) {
    const stage = opts.stages[i] as S;
    if (stoppedEarly) {
      skipped.push(stage);
      continue;
    }
    let remainingUsd: number | undefined;
    if (budgetMicros !== undefined) {
      const remainingMicros = budgetMicros - totalSpentUsdMicros;
      if (remainingMicros <= 0) {
        stoppedEarly = true;
        skipped.push(stage);
        continue;
      }
      remainingUsd = remainingMicros / 1_000_000;
    }
    log(
      `stage ${i + 1}/${opts.stages.length}: ${stage.name} (${stage.kind}) — path ${stage.path.join(".")}`,
    );
    const outcome = await opts.runStage({
      stage,
      specPath: currentPath,
      index: i + 1,
      ...(remainingUsd !== undefined ? { budgetUsd: remainingUsd } : {}),
    });
    perStage.push({ stage, outcome });
    totalSpentUsdMicros += outcome.spentUsdMicros;
    if (outcome.applied) {
      acceptedCount += 1;
      const composed = join(resolve(opts.workingDir), `after-${i + 1}-${stage.name}.yaml`);
      writeFileSync(composed, outcome.patchedYaml, { mode: 0o600 });
      currentPath = composed;
      log(
        `stage ${stage.name}: ACCEPTED (${outcome.scoreBefore.toFixed(3)} → ${outcome.scoreAfter.toFixed(3)}); composed spec → ${composed}`,
      );
    } else {
      log(
        `stage ${stage.name}: rejected (Δ ${outcome.improvement >= 0 ? "+" : ""}${outcome.improvement.toFixed(3)}); working spec unchanged`,
      );
    }
    if (outcome.budgetExhausted) stoppedEarly = true;
  }

  return {
    perStage,
    acceptedCount,
    finalYamlPath: currentPath,
    totalSpentUsdMicros,
    stoppedEarly,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// D36 — the staged WRITE-BACK. The only code on this path that overwrites the
// operator's tracked spec, so it lives here (pure over its inputs, exercised
// hermetically by optimize-stages.test.ts) rather than inline in the CLI.
// ---------------------------------------------------------------------------

export type StagedWriteBackOptions<S extends OptimizableStageLike = OptimizableStageLike> = {
  /** The driver's result — only the fields the stamp is derived from. */
  readonly result: Pick<StagedOptimizeResult<S>, "perStage" | "acceptedCount" | "finalYamlPath">;
  /** The tracked spec being overwritten (absolute). */
  readonly targetSpecPath: string;
  readonly runId: string;
  /** Mutator name as the operator selected it (`rule-based` when unset). */
  readonly mutator: string;
  readonly iterations: number;
  /** Test seam: pin the stamp's `generated:` line. */
  readonly timestamp?: string;
};

export type StagedWriteBackResult = {
  /** The full text written to `targetSpecPath`. */
  readonly written: string;
  /** The `formatWriteBackHeader` stamp prefixed to the composed YAML. */
  readonly header: string;
  /** Names of the stages whose patches the composed YAML carries, in order. */
  readonly acceptedStages: ReadonlyArray<string>;
};

/**
 * Apply the composed multi-stage result to the source spec — ONE write, for
 * the composition of every ACCEPTED stage.
 *
 * The composed YAML already carries exactly the accepted stages' rewrites
 * (a rejected stage never entered the composition chain — see
 * {@link runStagedOptimize}), so this only prepends the provenance stamp and
 * writes. The stamp's score range spans the run: `scoreBefore` of the FIRST
 * accepted stage → `scoreAfter` of the LAST, with the accepted stage names in
 * the mutator field so `crewhaus spec log` shows which prompts moved.
 *
 * Callers must not invoke this when `acceptedCount === 0`: with nothing
 * accepted `finalYamlPath` is the untouched starting spec, and stamping it
 * would rewrite a tracked file to say an optimization landed when none did.
 */
export function writeBackStagedResult<S extends OptimizableStageLike>(
  opts: StagedWriteBackOptions<S>,
): StagedWriteBackResult {
  const accepted = opts.result.perStage.filter((p) => p.outcome.applied);
  if (accepted.length === 0) {
    throw new BridgedCandidateError(
      "refusing to write back a staged optimize run in which no stage was accepted — the composed spec is the untouched source",
    );
  }
  const composed = readFileSync(opts.result.finalYamlPath, "utf-8");
  const first = accepted[0]?.outcome;
  const last = accepted[accepted.length - 1]?.outcome;
  const acceptedStages = accepted.map((p) => p.stage.name);
  const header = formatWriteBackHeader({
    runId: opts.runId,
    mutator: `${opts.mutator} (${opts.result.acceptedCount} stage(s): ${acceptedStages.join(", ")})`,
    scoreBefore: first?.scoreBefore ?? 0,
    scoreAfter: last?.scoreAfter ?? 0,
    iterations: opts.iterations,
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  });
  const written = `${header}${composed}`;
  writeFileSync(resolve(opts.targetSpecPath), written);
  return { written, header, acceptedStages };
}
