/**
 * D38 (Evals Wave 5, cluster O) — `--mutator meta-harness` smoke.
 *
 * The provider is driven with a SCRIPTED `ProviderAdapter` (no credentials, no
 * network) through the injectable `adapter` seam, so this covers the real
 * proposer code path — prompt assembly from the filesystem experience store,
 * JSON extraction, and every degenerate fallback — plus the end-to-end budget
 * gate through `optimizeSpec`, which is the invariant that matters: an
 * experimental mutator must not be able to spend past `--budget-usd`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { optimizeSpec } from "@crewhaus/eval-optimizer-orchestrator";
import { persistCandidate, readExperienceStore } from "@crewhaus/meta-harness-optimizer";
import type { OptimizerState } from "@crewhaus/prompt-optimizer";
import {
  META_HARNESS_SYSTEM_BLOCK,
  buildMetaHarnessUserMessage,
  createMetaHarnessMutator,
  createMetaHarnessProposer,
} from "./meta-harness-mutator";

const CLI_YAML = `name: hello-cli
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: You are a helpful assistant.
tools:
  - Read
`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function newTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "meta-harness-cli-"));
  tempDirs.push(dir);
  return dir;
}

const STATE: OptimizerState = {
  iteration: 1,
  best: { id: "candidate-0", prompt: "BASE PROMPT", mutations: [], score: 0.4 },
  bestGrades: [{ input: "who wrote it?", score: 0.1, rationale: "no source cited" }],
  trajectory: [],
  trainSet: [],
  devSet: [],
};

/** A scripted adapter: one text block + a fixed usage bill per call. */
function scriptedAdapter(opts: {
  readonly text?: string;
  readonly throwOnCall?: boolean;
  readonly usage?: { input: number; output: number };
  readonly onCall?: (req: { system: unknown; messages: unknown }) => void;
}): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req) => {
      opts.onCall?.({ system: req.system, messages: req.messages });
      if (opts.throwOnCall === true) {
        // A stream that throws on first pull — the transport-failure path.
        // Written as a plain async iterable (a generator body with no `yield`
        // trips lint/correctness/useYield).
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("transport exploded")),
          }),
        } as AsyncIterable<StreamEvent>;
      }
      const usage = opts.usage ?? { input: 1000, output: 500 };
      const text = opts.text ?? "";
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { kind: "message_start", usage: { input: usage.input, output: 0 } } as StreamEvent;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        } as StreamEvent;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        } as StreamEvent;
        yield { kind: "content_block_stop", index: 0 } as StreamEvent;
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: usage.input, output: usage.output },
        } as StreamEvent;
        yield { kind: "message_stop" } as StreamEvent;
      })();
    },
  };
}

describe("buildMetaHarnessUserMessage", () => {
  test("indexes the experience store by PATH and carries the failing grades", () => {
    const dir = newTmp();
    persistCandidate({
      rootDir: dir,
      candidateId: "candidate_000",
      bundleSource: "seed instructions",
      candidateFileName: "instructions.txt",
      scores: { s1: 0.4 },
      traceLines: [JSON.stringify({ sampleId: "s1", score: 0.4 })],
    });
    const msg = buildMetaHarnessUserMessage(readExperienceStore(dir), STATE);
    expect(msg).toContain("EXPERIENCE STORE:");
    expect(msg).toContain("candidate_000");
    // Paths, not contents — the proposer reads selectively.
    expect(msg).toContain(join("bundle", "instructions.txt"));
    expect(msg).toContain("trace.jsonl");
    expect(msg).not.toContain("seed instructions");
    expect(msg).toContain("BASE PROMPT");
    expect(msg).toContain("no source cited");
  });

  test("an empty store still renders (the first iteration has no history)", () => {
    const dir = newTmp();
    const msg = buildMetaHarnessUserMessage(readExperienceStore(dir), STATE);
    expect(msg).toContain("(0 candidate(s))");
    expect(msg).toContain("BASE PROMPT");
  });
});

describe("createMetaHarnessProposer", () => {
  test("extracts the rewrite + rationale and reports usage", async () => {
    const dir = newTmp();
    let seenSystem: unknown;
    const proposer = createMetaHarnessProposer({
      adapter: scriptedAdapter({
        text: 'here you go:\n```json\n{"rewrite":"Cite a source for every claim.","rationale":"grader wants sources"}\n```',
        usage: { input: 800, output: 120 },
        onCall: (r) => {
          seenSystem = r.system;
        },
      }),
      modelId: "claude-sonnet-4-5",
    });
    const out = await proposer(readExperienceStore(dir), STATE);
    expect(out.bundleSource).toBe("Cite a source for every claim.");
    expect(out.rationale).toBe("grader wants sources");
    expect(out.usage).toEqual({ input: 800, output: 120 });
    expect(JSON.stringify(seenSystem)).toContain(META_HARNESS_SYSTEM_BLOCK.slice(0, 40));
  });

  test("a transport failure falls back to the current best with NO usage billed", async () => {
    const dir = newTmp();
    const proposer = createMetaHarnessProposer({
      adapter: scriptedAdapter({ throwOnCall: true }),
      modelId: "claude-sonnet-4-5",
    });
    const out = await proposer(readExperienceStore(dir), STATE);
    expect(out.bundleSource).toBe("BASE PROMPT");
    expect(out.rationale).toContain("proposer error");
    expect(out.usage).toBeUndefined();
  });

  test("an unusable response still bills its usage and keeps the current best", async () => {
    const dir = newTmp();
    const noJson = createMetaHarnessProposer({
      adapter: scriptedAdapter({ text: "I would rather not.", usage: { input: 10, output: 5 } }),
      modelId: "claude-sonnet-4-5",
    });
    const a = await noJson(readExperienceStore(dir), STATE);
    expect(a.bundleSource).toBe("BASE PROMPT");
    expect(a.rationale).toContain("no JSON object");
    expect(a.usage).toEqual({ input: 10, output: 5 });

    const noRewrite = createMetaHarnessProposer({
      adapter: scriptedAdapter({ text: '{"rationale":"thinking about it"}' }),
      modelId: "claude-sonnet-4-5",
    });
    const b = await noRewrite(readExperienceStore(dir), STATE);
    expect(b.bundleSource).toBe("BASE PROMPT");
    expect(b.rationale).toContain("no rewrite");
  });
});

describe("createMetaHarnessMutator through optimizeSpec", () => {
  test("drives the eval-gated accept loop and emits an OPTIMIZABLE_PATHS patch", async () => {
    const dir = newTmp();
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);
    const outDir = join(dir, "out");
    const mutator = createMetaHarnessMutator({
      storeRootDir: outDir,
      adapter: scriptedAdapter({
        text: '{"rewrite":"Cite a source for every claim, then answer.","rationale":"sources"}',
      }),
      modelId: "claude-sonnet-4-5",
    });
    const result = await optimizeSpec({
      specPath,
      // Longer prompt = better, so the proposer's rewrite wins.
      fitness: async (prompt: string) => prompt.length / 100,
      trainSet: [{ id: "t1", input: "x" }],
      devSet: [{ id: "d1", input: "x" }],
      iterations: 2,
      outDir,
      mutator,
    });
    expect(result.applied).toBe(true);
    expect(result.patch.path).toEqual(["agent", "instructions"]);
    expect(result.patch.value).toBe("Cite a source for every claim, then answer.");
    expect(result.patch.rationale).toContain("meta-harness");
    // Accept-then-write: the source is untouched without writeBack.
    expect(readFileSync(specPath, "utf-8")).toBe(CLI_YAML);
  });

  test("--budget-usd stops the run before the first over-budget proposer call", async () => {
    const dir = newTmp();
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);
    const outDir = join(dir, "out");
    let calls = 0;
    const mutator = createMetaHarnessMutator({
      storeRootDir: outDir,
      adapter: scriptedAdapter({
        text: '{"rewrite":"a much much longer instruction block that would win","rationale":"x"}',
        // A deliberately expensive call so the meter trips on iteration 2.
        usage: { input: 400_000, output: 2000 },
        onCall: () => {
          calls += 1;
        },
      }),
      modelId: "claude-sonnet-4-5",
    });
    const result = await optimizeSpec({
      specPath,
      fitness: async (prompt: string) => prompt.length / 100,
      trainSet: [{ id: "t1", input: "x" }],
      devSet: [{ id: "d1", input: "x" }],
      iterations: 6,
      // ~$1.20 of Sonnet input per call at 400k tokens — one call fits, the
      // second does not.
      budgetUsd: 2,
      outDir,
      mutator,
    });
    expect(result.stoppedReason).toBe("budget-reached");
    expect(result.spend.stopped).toBe("budget-reached");
    // The gate refuses BEFORE the call, so the model is never asked again.
    expect(calls).toBeLessThan(6);
    expect(result.spend.perIteration.length).toBe(calls);
    // The trajectory is still complete (the gate no-ops, it never throws out).
    expect(result.trajectory.length).toBe(7);
  });

  test("the mutator exposes the pricing metadata the budget gate feature-detects", () => {
    const dir = newTmp();
    const mutator = createMetaHarnessMutator({
      storeRootDir: dir,
      adapter: scriptedAdapter({}),
      modelId: "claude-sonnet-4-5",
    }) as unknown as {
      name: string;
      providerId?: string;
      modelId?: string;
      maxOutputTokens?: number;
      estimateInputChars(s: OptimizerState): number | undefined;
    };
    expect(mutator.name).toBe("meta-harness");
    expect(mutator.providerId).toBe("anthropic");
    expect(mutator.modelId).toBe("claude-sonnet-4-5");
    expect(mutator.maxOutputTokens).toBe(2048);
    // The estimate covers the FULL serialized input, not just the prompt.
    const est = mutator.estimateInputChars(STATE) ?? 0;
    expect(est).toBeGreaterThan(META_HARNESS_SYSTEM_BLOCK.length);
  });
});
