/**
 * Catalog R-eval `eval-runner` — run an agent against a dataset.
 *
 * Per-sample isolation: fresh `RunContext` (and therefore fresh
 * `TraceEventBus` + `sessionId`) so concurrent samples don't see each
 * other's events. Concurrency is enforced by a tiny in-package semaphore
 * (default 4). Per-sample artifacts persist to
 * `.crewhaus/evals/<runId>/<sampleId>/{transcript.jsonl, events.jsonl,
 * grades.json, meta.json}`. Run-level: `run.json` (config snapshot)
 * + `results.json` (aggregates).
 *
 * `--seed` is honored only for providers that surface temperature
 * reproducibility (Anthropic does not). Document divergence; do not
 * promise byte-identical reruns.
 *
 * `permissionMode` is forced to `"auto"` so `alwaysAsk` rules auto-deny
 * rather than blocking on stdin in a non-interactive eval run.
 *
 * MCP servers are shared across samples (read-mostly assumption). An
 * `isolateMcpPerSample` escape hatch is reserved for future use.
 *
 * Reference: build-roadmap.md §16.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import type { CompiledGrader, Grader } from "@crewhaus/eval-grader";
import { createJudgeGrader, loadRubric } from "@crewhaus/eval-judge";
import type { IrV0 } from "@crewhaus/ir";
import { memoryFragmentFromIr, wireMemory } from "@crewhaus/memory-service";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createSkillTool } from "@crewhaus/skills-registry";
import { currentTenantContext } from "@crewhaus/tenancy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { aggregate } from "./aggregate";
import { RunnerError } from "./errors";
import { runSample } from "./run-sample";
import { Semaphore } from "./semaphore";
import type {
  AgentInvoker,
  EvalRunSummary,
  GraderEntry,
  GraderLookup,
  RunEvalOptions,
  SampleResult,
} from "./types";
import { type SharedAgentDeps, wireRunOnce } from "./wire-once";

export type {
  AgentInvoker,
  EvalRunSummary,
  GraderEntry,
  GraderLookup,
  RunEvalOptions,
  SampleResult,
};
export type { SharedAgentDeps };
export { wireRunOnce };
export { Semaphore };
export { aggregate };
export { RunnerError };
export { runSample };

const DEFAULT_CONCURRENCY = 4;

export type RunEvalArgs = {
  /** Lowered agent IR (target: cli). Caller is responsible for narrowing. */
  readonly ir: IrV0;
  readonly dataset: { name: string; samples: AsyncIterable<Sample> };
  readonly compiledGraders: ReadonlyArray<CompiledGrader>;
  readonly opts?: RunEvalOptions;
};

/**
 * Resolve the eval output directory. When an eval runs inside a tenant scope
 * (e.g. a cloud/managed eval), the tenant's rebased `evalRoot` is used so one
 * tenant's eval artifacts never share a directory with another's; the global
 * default is only used outside any tenant scope (#150). An explicit
 * `optsOutDir` always wins for trusted callers.
 */
export function resolveEvalOutDir(runId: string, optsOutDir?: string): string {
  if (optsOutDir !== undefined) return optsOutDir;
  const tenant = currentTenantContext()?.tenant;
  if (tenant !== undefined) return join(tenant.evalRoot, runId);
  return join(".crewhaus", "evals", runId);
}

/**
 * Execute an evaluation. Returns a summary; per-sample artifacts and
 * the summary itself are also persisted under `outDir`.
 */
export async function runEval(args: RunEvalArgs): Promise<EvalRunSummary> {
  const { ir, dataset, compiledGraders } = args;
  const opts = args.opts ?? {};

  const runId = opts.runId ?? generateRunId();
  const outDir = resolveEvalOutDir(runId, opts.outDir);
  mkdirSync(outDir, { recursive: true });

  // Resolve graders. Replace any `llm_judge` placeholder with a real judge
  // grader bound to the runner's judgeModel (or the per-grader override),
  // and any `registry` placeholder with the named grader from the caller's
  // grader registry (PR 19 — loud at run start, not per-sample).
  const graders: GraderEntry[] = compiledGraders.map((g) => {
    if (g.judgeSpec) {
      const rubric = loadRubric(g.judgeSpec.rubric);
      const model = g.judgeSpec.model ?? opts.judgeModel;
      const grader = createJudgeGrader(rubric, model !== undefined ? { model } : {});
      return { name: g.name, grader };
    }
    if (g.registrySpec) {
      if (opts.graderRegistry === undefined) {
        throw new RunnerError(
          `grader "${g.name}" resolves by registry name "${g.registrySpec.grader}" but no graderRegistry was supplied — pass RunEvalOptions.graderRegistry (and register the pack, e.g. registerContinuityGraders(registry))`,
        );
      }
      return { name: g.name, grader: opts.graderRegistry.lookup(g.registrySpec.grader) };
    }
    return { name: g.name, grader: g.grader };
  });

  // The default invoker calls runChatLoop with the per-sample fresh runContext.
  const invoker = opts.invoker ?? (await defaultInvoker(ir, opts));

  const startedAt = new Date().toISOString();
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const sem = new Semaphore(concurrency);

  // Persist run-level config snapshot up front so SIGINT mid-run still leaves
  // a usable directory.
  const specHash = await hashSpec(ir);
  await Bun.write(
    join(outDir, "run.json"),
    JSON.stringify(
      {
        runId,
        startedAt,
        specHash,
        datasetName: dataset.name,
        ...(opts.datasetHash !== undefined ? { datasetHash: opts.datasetHash } : {}),
        ...(opts.gradersHash !== undefined ? { gradersHash: opts.gradersHash } : {}),
        graderNames: graders.map((g) => g.name),
        model: ir.agent.model,
        ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
        concurrency,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      },
      null,
      2,
    ),
  );

  // Materialize the dataset into a list so we can run samples concurrently.
  // For very large datasets the streaming loaders still avoid loading the
  // whole file into memory — but eventually all sample objects sit in RAM.
  const samples: Sample[] = [];
  for await (const s of dataset.samples) samples.push(s);
  if (samples.length === 0) {
    throw new RunnerError(`dataset "${dataset.name}" yielded zero samples`);
  }

  let interrupted = false;
  const abortHandler = () => {
    interrupted = true;
  };
  process.once("SIGINT", abortHandler);

  const settled = await Promise.allSettled(
    samples.map(async (sample) => {
      const release = await sem.acquire();
      // Check *after* acquiring the slot: every callback's synchronous prefix
      // runs during `.map()` (before any SIGINT can fire), so a pre-acquire
      // check would never observe a mid-run interrupt. Samples still queued on
      // the semaphore when SIGINT arrives are skipped here as their turn comes.
      if (interrupted) {
        release();
        throw new RunnerError(`run interrupted before sample "${sample.id}"`);
      }
      try {
        const runOnce = () =>
          runSample({
            sample,
            invoker,
            graders,
            outDir,
            model: ir.agent.model,
            specName: ir.name,
            ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          });
        const first = await runOnce();
        // Noise auto-retry (failure-arbiter item 7): an errored SampleResult
        // means the INVOKER failed (provider timeout, 429, sandbox blip),
        // and a graderError means a GRADER threw (judge infra blip) — both
        // are infra noise, not graded failures. Retry exactly once within
        // the run; the retried outcome replaces the errored one wholesale
        // (the second runSample rewrites the same per-sample artifact dir)
        // and is tagged `retried: true` so reports and triage can tell.
        // Skipped on SIGINT or when the caller opted out (`--no-retry`).
        const infraNoise = first.error !== undefined || first.graderError !== undefined;
        if (!infraNoise || opts.retryErrors === false || interrupted) {
          return first;
        }
        return { ...(await runOnce()), retried: true };
      } finally {
        release();
      }
    }),
  );

  process.removeListener("SIGINT", abortHandler);

  const results: SampleResult[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const sample = samples[i];
    return {
      sampleId: sample?.id ?? `unknown-${i}`,
      sessionId: "(unset)",
      startedAt,
      endedAt: new Date().toISOString(),
      latencyMs: 0,
      turns: 0,
      tokens: { input: 0, output: 0 },
      model: ir.agent.model,
      agentOutput: "",
      grades: {
        overall: { passed: false, score: 0, rationale: "sample failed entirely" },
        perGrader: [],
      },
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });

  const endedAt = new Date().toISOString();
  const aggregates = aggregate(results);

  const summary: EvalRunSummary = {
    runId,
    startedAt,
    endedAt,
    samples: results,
    aggregates,
    config: {
      specHash,
      datasetName: dataset.name,
      ...(opts.datasetHash !== undefined ? { datasetHash: opts.datasetHash } : {}),
      ...(opts.gradersHash !== undefined ? { gradersHash: opts.gradersHash } : {}),
      graderNames: graders.map((g) => g.name),
      model: ir.agent.model,
      ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
      concurrency,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    },
    outDir,
  };

  await Bun.write(join(outDir, "results.json"), JSON.stringify(summary, null, 2));

  return summary;
}

async function defaultInvoker(ir: IrV0, opts: RunEvalOptions): Promise<AgentInvoker> {
  const wired: SharedAgentDeps = await wireRunOnce(
    ir,
    opts.cwd !== undefined ? { cwd: opts.cwd } : {},
  );
  // v0.3.0 §7.2 — eval/optimizer state ISOLATION. When the IR carries the
  // memory fabric (an enabled `memory` block and/or `continuity`, which is
  // DEFAULT-ON on the cli shape since 0.3.0), each sample gets its OWN
  // ephemeral stores rooted under its per-sample artifact directory
  // (`.crewhaus/evals/<runId>/<sampleId>/.crewhaus/…`): plan/focus/handoff/
  // facts written by sample N must never leak into sample N+1 — Pillar 2
  // assumes spec patches are the only cross-run channel. The per-sample
  // `sessionRootDir` doubles as the fabric's session-log root so proof
  // evidence resolves against the sample's own transcript, and `homeDir`
  // is pinned inside the sample dir so the operator's `~/.crewhaus` skills
  // can never bleed into a measurement.
  const fabricOn =
    (ir.memory !== undefined && ir.memory.enabled !== false) || ir.continuity !== undefined;
  return async (req) => {
    let tools: RegisteredTool[] = [...wired.tools];
    let skills = wired.skills;
    let slashCommands = wired.slashCommands;
    let memoryOpt: Parameters<typeof runChatLoop>[0]["memory"];
    let continuityOpt: Parameters<typeof runChatLoop>[0]["continuity"];
    if (fabricOn) {
      const memWired = await wireMemory(memoryFragmentFromIr(ir), {
        catalog: {
          register: (tool) => {
            tools.push(tool);
          },
        },
        cwd: req.sessionRootDir,
        sessionRootDir: req.sessionRootDir,
        homeDir: req.sessionRootDir,
      });
      memoryOpt = memWired.options.memory;
      continuityOpt = memWired.options.continuity;
      if (memWired.options.skills !== undefined) {
        // The fabric owns the skill surface (builtin `continuity` skill at
        // lowest precedence): replace any Skill tool wireRunOnce registered
        // so the tool list never advertises two.
        skills = memWired.options.skills;
        tools = tools.filter((t) => t.name !== "Skill");
        if (skills.length > 0) tools.push(createSkillTool(skills));
      }
      if (memWired.options.slashCommands !== undefined) {
        slashCommands = memWired.options.slashCommands;
      }
    }
    const agentOutput = await runChatLoop({
      model: wired.model,
      instructions: wired.instructions,
      tools,
      hooks: wired.hooks,
      skills,
      slashCommands,
      ...(wired.subAgents !== undefined && wired.spawnSubAgent !== undefined
        ? { subAgents: wired.subAgents, spawnSubAgent: wired.spawnSubAgent }
        : {}),
      ...(memoryOpt !== undefined ? { memory: memoryOpt } : {}),
      ...(continuityOpt !== undefined ? { continuity: continuityOpt } : {}),
      permissionRules: wired.permissionRules,
      permissionMode: "auto",
      sessionName: `${wired.sessionName}_${req.sample.id}`,
      sessionTarget: wired.sessionTarget,
      runContext: req.runContext,
      sessionRootDir: req.sessionRootDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: req.sample.input }],
    });
    return { agentOutput };
  };
}

function generateRunId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `run_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function hashSpec(ir: IrV0): Promise<string> {
  const text = JSON.stringify({
    name: ir.name,
    target: ir.target,
    model: ir.agent.model,
    instructions: ir.agent.instructions,
    tools: ir.tools,
  });
  return Bun.hash(text).toString(16);
}
