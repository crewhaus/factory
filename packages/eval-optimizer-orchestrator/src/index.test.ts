import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MutationProvider,
  OptimizerState,
  ProviderMutation,
} from "@crewhaus/prompt-optimizer";
import { type CostAccrualEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { optimizeSpec } from "./index";

const CLI_YAML = `# A simple CLI agent
target: cli
name: hello-cli
agent:
  model: claude-sonnet-4-5
  # The system prompt:
  instructions: You are a helpful assistant.
tools:
  - Read
`;

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "optimize-test-"));
});

afterEach(() => {
  // Best-effort cleanup; not critical for correctness.
});

describe("optimizeSpec — end-to-end fitness loop", () => {
  test("identifies improvement via a synthetic fitness function", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    // Fitness: reward longer prompts (proxy for "rule-based provider
    // adds words"). The mutator appends sentences over time, so the
    // best candidate after N iterations should outscore the base.
    const fitness = async (prompt: string) => prompt.length / 100;

    const outDir = join(tmpRoot, "out");
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 5,
      seed: 42,
      outDir,
    });

    expect(result.improvement).toBeGreaterThan(0);
    expect(result.scoreAfter).toBeGreaterThan(result.scoreBefore);
    expect(result.applied).toBe(true);
    expect(result.patch.target).toBe("cli");
    expect(result.patch.path).toEqual(["agent", "instructions"]);
    expect(result.patch.op).toBe("replace");
    expect(typeof result.patch.value).toBe("string");
    expect(result.trajectory.length).toBe(6); // base + 5 iterations
  });

  test("persists patch.json and report.json regardless of writeBack flag", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (prompt: string) => prompt.length / 100;
    const outDir = join(tmpRoot, "out");
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir,
    });

    expect(existsSync(join(result.outDir, "patch.json"))).toBe(true);
    expect(existsSync(join(result.outDir, "report.json"))).toBe(true);
    // prompt-optimizer persists trajectory + best under its own
    // <runId>/ subdir within the supplied outDir, so the path is
    // outDir/runId/trajectory.json.
    expect(existsSync(join(result.outDir, result.runId, "trajectory.json"))).toBe(true);
    expect(existsSync(join(result.outDir, result.runId, "best.json"))).toBe(true);
  });

  test("writeBack: false leaves the source spec untouched", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (prompt: string) => prompt.length / 100;
    await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir: join(tmpRoot, "out"),
      // writeBack omitted — default false
    });

    const source = readFileSync(specPath, "utf8");
    expect(source).toBe(CLI_YAML);
  });

  test("writeBack: true rewrites the source with a header", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (prompt: string) => prompt.length / 100;
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir: join(tmpRoot, "out"),
      writeBack: true,
    });

    expect(result.writtenTo).toBe(specPath);
    const source = readFileSync(specPath, "utf8");
    expect(source).toContain("# crewhaus optimize: runId");
    expect(source).toContain("# A simple CLI agent"); // original leading comment preserved
    expect(source).toContain("# The system prompt:"); // structural comment preserved
  });

  test("rejects workflow/graph/crew targets (v0 limitation)", async () => {
    const WORKFLOW_YAML = `target: workflow
name: hello-workflow
model: claude-sonnet-4-5
steps:
  - name: step1
    instructions: Step one.
`;
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, WORKFLOW_YAML);

    const fitness = async (_p: string) => 0.5;
    await expect(
      optimizeSpec({
        specPath,
        fitness,
        trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
        devSet: [{ id: "d1", input: "x", expected_output: "y" }],
        iterations: 1,
        outDir: join(tmpRoot, "out"),
      }),
    ).rejects.toThrow(/multiple prompts/);
  });

  test("rejects an invalid spec path", async () => {
    const fitness = async (_p: string) => 0.5;
    await expect(
      optimizeSpec({
        specPath: join(tmpRoot, "nope.yaml"),
        fitness,
        trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
        devSet: [{ id: "d1", input: "x", expected_output: "y" }],
        iterations: 1,
        outDir: join(tmpRoot, "out"),
      }),
    ).rejects.toThrow(/cannot read spec/);
  });
});

describe("optimizeSpec — applied=false below threshold", () => {
  test("reports applied=false when improvement is below threshold", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    // Constant fitness — every candidate scores the same, so improvement = 0.
    const fitness = async (_p: string) => 0.5;
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir: join(tmpRoot, "out"),
      improvementThreshold: 0.01,
    });

    expect(result.improvement).toBe(0);
    expect(result.applied).toBe(false);
    expect(result.writtenTo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FR-003 — cost budget gate (`--budget-usd`).
// ---------------------------------------------------------------------------

/**
 * A model-backed stub MutationProvider that follows the offline-injection
 * pattern (no live API). It returns a fixed, longer prompt (so the
 * length-reward fitness adopts it as the new best) and a fixed, large
 * per-call `usage`. It exposes the `modelId` + `maxOutputTokens` getters
 * the orchestrator feature-detects to price calls.
 *
 * Cost arithmetic for claude-sonnet-4-5 ($3/M in, $15/M out):
 *   - actual per call: 200_000 input * $3/M + 2_000 output * $15/M
 *                    = 600_000 + 30_000 = 630_000 micros (= $0.63).
 *   - worst-case pre-call estimate (output ceiling 220_000 tokens):
 *                    ~3.3M micros — deliberately >= actual so the gate is
 *                    conservative and the recorded total stays under budget.
 */
class StubModelMutator implements MutationProvider {
  readonly name = "stub-model";
  private calls = 0;
  constructor(
    private readonly prompt: string,
    private readonly usage: { input: number; output: number; cacheRead?: number },
    readonly modelId = "claude-sonnet-4-5",
    readonly maxOutputTokens = 220_000,
  ) {}
  callCount(): number {
    return this.calls;
  }
  async next(_state: OptimizerState): Promise<ProviderMutation> {
    this.calls += 1;
    return {
      prompt: this.prompt,
      mutations: [{ kind: "rephrase-instruction" }],
      usage: this.usage,
    };
  }
}

const BIG_PROMPT = "You are a meticulous, careful assistant who explains reasoning.";

/**
 * FR-003 (input-estimate gap) — a stub that exposes the `estimateInputChars`
 * hook the orchestrator feature-detects. It models a provider whose actual
 * meta-prompt (system block + a large dev-set failure block) is FAR longer
 * than the candidate prompt alone. The gate must price this full serialized
 * input, not just `best.prompt.length`, or a large dev window could let a
 * gate-passing call exceed budget after the fact.
 */
class StubModelMutatorWithInputEstimate implements MutationProvider {
  readonly name = "stub-model-est";
  private calls = 0;
  constructor(
    private readonly prompt: string,
    private readonly usage: { input: number; output: number },
    private readonly serializedInputChars: number,
    readonly modelId = "claude-sonnet-4-5",
    readonly maxOutputTokens = 100,
  ) {}
  callCount(): number {
    return this.calls;
  }
  // The exact serialized input length the provider would transmit — much
  // larger than `prompt.length` (mirrors ClaudeMutationProvider's
  // system-block + failure-block rendering for a wide dev window).
  estimateInputChars(_state: OptimizerState): number {
    return this.serializedInputChars;
  }
  async next(_state: OptimizerState): Promise<ProviderMutation> {
    this.calls += 1;
    return {
      prompt: this.prompt,
      mutations: [{ kind: "rephrase-instruction" }],
      usage: this.usage,
    };
  }
}

describe("optimizeSpec — FR-003 budget gate", () => {
  test("stops before exceeding --budgetUsd and returns the best-so-far", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    // Reward longer prompts so the stub's BIG_PROMPT becomes the best.
    const fitness = async (p: string) => p.length / 100;
    const mutator = new StubModelMutator(BIG_PROMPT, { input: 200_000, output: 2_000 });

    const budgetUsd = 4.0; // 4_000_000 micros; ~6 calls of $0.63 fit, but the
    // worst-case ~3.3M estimate trips the gate after 2 recorded calls.
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 8,
      mutator,
      budgetUsd,
      outDir: join(tmpRoot, "out"),
    });

    const budgetMicros = budgetUsd * 1_000_000;
    expect(result.stoppedReason).toBe("budget-reached");
    expect(result.spend.stopped).toBe("budget-reached");
    // Never recorded spend above the budget (estimate-before guarantee).
    expect(result.spend.totalUsdMicros).toBeLessThanOrEqual(budgetMicros);
    expect(result.spend.totalUsdMicros).toBeGreaterThan(0);
    // Fewer model calls than the iterations cap → the budget cut it short.
    expect(result.spend.perIteration.length).toBeLessThan(8);
    // The mutator was invoked exactly once per recorded call (no model call
    // issued after the gate tripped).
    expect(mutator.callCount()).toBe(result.spend.perIteration.length);
    // Best-so-far still carried in the patch.
    expect(result.patch.value).toBe(BIG_PROMPT);
    expect(result.spend.totalUsd).toMatch(/^\$\d+\.\d{4}$/);
  });

  test("omitting budgetUsd preserves iterations-cap behaviour", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (p: string) => p.length / 100;
    const mutator = new StubModelMutator(BIG_PROMPT, { input: 200_000, output: 2_000 });

    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 5,
      mutator,
      // budgetUsd omitted
      outDir: join(tmpRoot, "out"),
    });

    expect(result.stoppedReason).toBe("iterations-cap");
    // Every iteration ran a model call → full per-iteration breakdown.
    expect(result.spend.perIteration.length).toBe(5);
    expect(mutator.callCount()).toBe(5);
  });

  test("rule-based run reports $0 and ignores the flag", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (p: string) => p.length / 100;
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 4,
      seed: 42,
      // default rule-based mutator, but a tiny budget is passed:
      budgetUsd: 0.01,
      outDir: join(tmpRoot, "out"),
    });

    // Rule-based makes no model calls → $0, runs to the iterations cap.
    expect(result.spend.totalUsdMicros).toBe(0);
    expect(result.spend.totalUsd).toBe("$0.0000");
    expect(result.stoppedReason).toBe("iterations-cap");
    // Source left untouched (no write-back).
    expect(readFileSync(specPath, "utf8")).toBe(CLI_YAML);
  });

  test("prices the provider's full serialized input, not just the prompt length", async () => {
    // claude-sonnet-4-5: $3/M input, $15/M output. maxOutputTokens=100 keeps
    // the output cushion small (100 * $15/M = 1500 micros) so the INPUT axis
    // governs the estimate. Budget = $0.0025 (2500 micros).
    //
    //   Naive (prompt-only) estimate, short prompt (BIG_PROMPT ~62 chars):
    //     ceil((62 + 800)/4)=216 input tok * $3/M = 648 + 1500 = ~2148 micros
    //     → 2148 <= 2500, so a prompt-only gate would ISSUE the first call.
    //   Full-input estimate (4,000,000 serialized chars):
    //     ceil((4e6 + 800)/4)=1,000,200 tok * $3/M = 3,000,600 + 1500
    //     → ~3.0M micros >> 2500, so the input-aware gate STOPS immediately.
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);
    const fitness = async (p: string) => p.length / 100;
    const budgetUsd = 0.0025;

    // Control: an otherwise-identical provider WITHOUT the hook (prices on
    // prompt length only) issues at least one call under this budget.
    const naive = new StubModelMutator(
      BIG_PROMPT,
      { input: 100, output: 50 },
      "claude-sonnet-4-5",
      100,
    );
    const naiveResult = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 4,
      mutator: naive,
      budgetUsd,
      outDir: join(tmpRoot, "out-naive"),
    });
    expect(naive.callCount()).toBeGreaterThan(0);
    expect(naiveResult.spend.perIteration.length).toBeGreaterThan(0);

    // Subject: the hook-exposing provider, same prompt + budget, prices the
    // full 4M-char serialized input → the gate refuses the very first call.
    const withEstimate = new StubModelMutatorWithInputEstimate(
      BIG_PROMPT,
      { input: 100, output: 50 },
      4_000_000,
    );
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 4,
      mutator: withEstimate,
      budgetUsd,
      outDir: join(tmpRoot, "out-est"),
    });

    expect(result.stoppedReason).toBe("budget-reached");
    // No call was ever issued — the full-input estimate tripped the gate
    // before delegation, where the prompt-only estimate would have allowed it.
    expect(withEstimate.callCount()).toBe(0);
    expect(result.spend.perIteration.length).toBe(0);
    expect(result.spend.totalUsdMicros).toBe(0);
  });

  test("publishes a cost_accrual event per recorded call when a traceBus is provided", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (p: string) => p.length / 100;
    const mutator = new StubModelMutator(BIG_PROMPT, { input: 1_000, output: 500 });

    const bus = new TraceEventBus({ runId: "fr003-run", sessionId: "fr003-sess" });
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e as CostAccrualEvent);
    });

    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      mutator,
      traceBus: bus,
      outDir: join(tmpRoot, "out"),
    });

    // Separate the per-call accruals from the terminal aggregate.
    const perCall = accruals.filter((a) => a.summary !== true);
    const totals = accruals.filter((a) => a.summary === true);

    // One per-call cost_accrual per recorded model call.
    expect(perCall.length).toBe(result.spend.perIteration.length);
    expect(perCall.length).toBeGreaterThan(0);
    const first = perCall[0] as CostAccrualEvent;
    expect(first.provider).toBe("anthropic");
    expect(first.modelId).toBe("claude-sonnet-4-5");
    expect(first.costUsdMicros).toBeGreaterThan(0);
    // input 1000 * $3/M + output 500 * $15/M = 3000 + 7500 = 10500 micros.
    expect(first.costUsdMicros).toBe(10_500);
    // The accrual carries the OPTIMIZE run's id (not the bus session id),
    // so per-run cost aggregation keys on the optimize run.
    expect(first.runId).toBe(result.runId);
    expect(first.inputTokens).toBe(1_000);
    expect(first.outputTokens).toBe(500);

    // Exactly one terminal aggregate (`summary: true`) carrying the run
    // total — this is the "...plus the total" the AC requires on the bus.
    expect(totals.length).toBe(1);
    const total = totals[0] as CostAccrualEvent;
    expect(total.runId).toBe(result.runId);
    expect(total.costUsdMicros).toBe(result.spend.totalUsdMicros);
    // Token fields are the per-call sums.
    expect(total.inputTokens).toBe(perCall.reduce((a, c) => a + c.inputTokens, 0));
    expect(total.outputTokens).toBe(perCall.reduce((a, c) => a + c.outputTokens, 0));
    // The aggregate is the sum of per-call costs.
    expect(total.costUsdMicros).toBe(perCall.reduce((a, c) => a + c.costUsdMicros, 0));
  });

  test("publishes a terminal summary accrual even when zero model calls were recorded", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    // Rule-based (default) mutator → no model calls, no per-call accruals,
    // but the bus should still carry one terminal $0 total for the run.
    const fitness = async (p: string) => p.length / 100;
    const bus = new TraceEventBus({ runId: "fr003-zero", sessionId: "fr003-zero-sess" });
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e as CostAccrualEvent);
    });

    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      traceBus: bus,
      outDir: join(tmpRoot, "out"),
    });

    const perCall = accruals.filter((a) => a.summary !== true);
    const totals = accruals.filter((a) => a.summary === true);
    expect(perCall.length).toBe(0);
    expect(totals.length).toBe(1);
    expect((totals[0] as CostAccrualEvent).costUsdMicros).toBe(0);
    expect(result.spend.totalUsdMicros).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provider-agnostic budget pricing — a model-backed mutator that exposes a
// `providerId` getter (ClaudeMutationProvider built on a non-Anthropic
// adapter) must be priced against ITS provider's table, not Anthropic's.
// ---------------------------------------------------------------------------

class StubOpenAIMutator implements MutationProvider {
  readonly name = "stub-openai";
  constructor(
    private readonly prompt: string,
    private readonly usage: { input: number; output: number },
    readonly modelId = "gpt-4o-mini",
    readonly maxOutputTokens = 100,
    readonly providerId = "openai",
  ) {}
  async next(_state: OptimizerState): Promise<ProviderMutation> {
    return {
      prompt: this.prompt,
      mutations: [{ kind: "rephrase-instruction" }],
      usage: this.usage,
    };
  }
}

describe("optimizeSpec — provider-aware budget pricing (FR-003)", () => {
  test("a mutator exposing providerId=openai prices against the openai table", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (p: string) => p.length / 100;
    const mutator = new StubOpenAIMutator(
      "You are a meticulous, careful assistant who explains reasoning.",
      { input: 1_000, output: 500 },
    );

    const bus = new TraceEventBus({ runId: "prov-run", sessionId: "prov-sess" });
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e as CostAccrualEvent);
    });

    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      mutator,
      traceBus: bus,
      outDir: join(tmpRoot, "out"),
    });

    const perCall = accruals.filter((a) => a.summary !== true);
    expect(perCall.length).toBe(result.spend.perIteration.length);
    expect(perCall.length).toBeGreaterThan(0);
    const first = perCall[0] as CostAccrualEvent;
    expect(first.provider).toBe("openai");
    expect(first.modelId).toBe("gpt-4o-mini");
    // gpt-4o-mini: $0.15/M input, $0.60/M output.
    // 1000 * 0.15 + 500 * 0.60 = 150 + 300 = 450 micros — NOT the 10_500
    // micros the old hardcoded "anthropic" pricing would have produced
    // (well, a pricing miss → $0 here; the point is the real row resolves).
    expect(first.costUsdMicros).toBe(450);
  });

  test("a mutator with an unknown providerId string falls back to anthropic pricing (non-breaking)", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (p: string) => p.length / 100;
    const mutator = new StubOpenAIMutator(
      "You are a meticulous, careful assistant who explains reasoning.",
      { input: 1_000, output: 500 },
      "claude-sonnet-4-5",
      100,
      "not-a-provider",
    );

    const bus = new TraceEventBus({ runId: "prov-run2", sessionId: "prov-sess2" });
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e as CostAccrualEvent);
    });

    await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 2,
      mutator,
      traceBus: bus,
      outDir: join(tmpRoot, "out"),
    });

    const perCall = accruals.filter((a) => a.summary !== true);
    expect(perCall.length).toBeGreaterThan(0);
    expect((perCall[0] as CostAccrualEvent).provider).toBe("anthropic");
    // claude-sonnet-4-5: 1000 * $3/M + 500 * $15/M = 3000 + 7500 micros.
    expect((perCall[0] as CostAccrualEvent).costUsdMicros).toBe(10_500);
  });
});

describe("optimizeSpec — item 9 baseline/best eval-run dirs", () => {
  test("surfaces baselineEvalDir + bestEvalDir when the fitness fn reports runDir", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    // Mirror the CLI's fitness fn: each measurement persists an eval run
    // and reports where. Longer prompts score higher, so the base prompt
    // is call 1 and the winner is some later call.
    let call = 0;
    const dirs: string[] = [];
    const fitness = async (prompt: string) => {
      call += 1;
      const runDir = join(tmpRoot, "evals", `${call}`);
      dirs.push(runDir);
      return { score: prompt.length / 100, runDir };
    };

    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir: join(tmpRoot, "out"),
    });

    expect(result.applied).toBe(true);
    // Candidate-0's measurement is always the first fitness call.
    expect(result.baselineEvalDir).toBe(dirs[0] as string);
    // The winner improved over the base, so its dir is a later call's —
    // and one this run actually reported.
    expect(result.bestEvalDir).not.toBe(dirs[0] as string);
    expect(dirs).toContain(result.bestEvalDir as string);
  });

  test("dirs stay undefined for fitness fns that don't report runDir (back-compat)", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const result = await optimizeSpec({
      specPath,
      fitness: async (prompt: string) => prompt.length / 100,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 2,
      seed: 42,
      outDir: join(tmpRoot, "out"),
    });

    expect(result.baselineEvalDir).toBeUndefined();
    expect(result.bestEvalDir).toBeUndefined();
  });
});

describe("optimizeSpec — D43 knob/fitness contract", () => {
  const KNOB_YAML = `target: cli
name: hello-cli
agent:
  model: claude-sonnet-4-5
  instructions: You are a helpful assistant.
limits:
  max_tool_iterations: 10
tools:
  - Read
`;
  const DIAL = {
    path: ["limits", "max_tool_iterations"] as const,
    value: 10,
    min: 1,
    max: 20,
    step: 2,
    integer: true,
  };

  test("REFUSES a knob-blind fitness instead of writing an unmeasured patch", async () => {
    // A one-parameter fitness measures the SAME candidate for every dial
    // value, so a knob "win" is pure variance — and the emitted patch would
    // carry an "(eval-gated)" rationale for a comparison that never happened.
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, KNOB_YAML);
    const blind = async (prompt: string) => prompt.length / 100;
    await expect(
      optimizeSpec({
        specPath,
        fitness: blind,
        trainSet: [{ id: "t1", input: "x" }],
        devSet: [{ id: "d1", input: "x" }],
        iterations: 2,
        seed: 42,
        outDir: join(tmpRoot, "out-blind"),
        knobs: [DIAL],
      }),
    ).rejects.toThrow(/knob-blind fitness/);
  });

  test("accepts a knob-aware fitness (declared second parameter)", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, KNOB_YAML);
    const seen: Array<number | undefined> = [];
    const aware = async (
      prompt: string,
      knobs?: ReadonlyArray<{ path: ReadonlyArray<string>; value: number }>,
    ) => {
      seen.push(knobs?.[0]?.value);
      // Reward BOTH a longer prompt and a higher dial, so the search has a
      // real gradient on the knob rather than noise.
      return prompt.length / 100 + (knobs?.[0]?.value ?? 0) / 100;
    };
    const result = await optimizeSpec({
      specPath,
      fitness: aware,
      trainSet: [{ id: "t1", input: "x" }],
      devSet: [{ id: "d1", input: "x" }],
      iterations: 4,
      seed: 42,
      outDir: join(tmpRoot, "out-aware"),
      knobs: [DIAL],
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(result.patch.path).toEqual(["agent", "instructions"]);
  });

  test("no knobs declared → a one-parameter fitness is unaffected", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, KNOB_YAML);
    const result = await optimizeSpec({
      specPath,
      fitness: async (prompt: string) => prompt.length / 100,
      trainSet: [{ id: "t1", input: "x" }],
      devSet: [{ id: "d1", input: "x" }],
      iterations: 2,
      seed: 42,
      outDir: join(tmpRoot, "out-none"),
    });
    expect(result.patches).toHaveLength(1);
  });
});
