#!/usr/bin/env bun
/**
 * Section 38 grader-semantic-similarity smoke.
 *
 * Probes:
 *   A) registers in §29 grader-registry under "semantic_similarity"
 *   B) 5-sample fixture pass-rate snapshot via mock embedder
 *   C) embedder error → ROUGE-L fallback (verbose rationale captured)
 *   D) live probe with the configured embedder when
 *      CREWHAUS_SECTION38_LIVE_EMBEDDER points at a real provider
 */
import { type Embedder, createEmbedder } from "@crewhaus/embedder";
import type { RunResult, Sample } from "@crewhaus/eval-grader";
import { GraderRegistry } from "@crewhaus/grader-registry";
import { semanticSimilarity } from "@crewhaus/grader-semantic-similarity";

const log = (s: string) => process.stdout.write(`[section-38-semantic] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const sample = (id: string, expected: string): Sample => ({
  id,
  input: "ignored",
  expected_output: expected,
});
const result = (output: string): RunResult => ({
  agentOutput: output,
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 100,
});

const mock = createEmbedder({ model: "mock/test" });

// ── Probe A: registry registration ────────────────────────────────────────
log("probe A: register in §29 grader-registry");
{
  const reg = new GraderRegistry();
  reg.register("semantic_similarity", semanticSimilarity({ embedder: mock, threshold: 0.7 }));
  check("registered semantic_similarity", reg.has("semantic_similarity"));
  check("list contains the entry", reg.list().includes("semantic_similarity"));
}

// ── Probe B: 5-sample fixture pass-rate snapshot ──────────────────────────
log("probe B: 5-sample fixture pass-rate matches snapshot");
{
  const grader = semanticSimilarity({ embedder: mock, threshold: 0.7 });
  const fixture: ReadonlyArray<{ ref: string; out: string; expected: boolean }> = [
    { ref: "the cat sat", out: "the cat sat", expected: true },
    { ref: "alpha beta gamma", out: "alpha beta gamma", expected: true },
    { ref: "the cat sat on the mat", out: "the dog ran on the road", expected: false },
    { ref: "completely different", out: "no overlap whatsoever", expected: false },
    { ref: "hello world", out: "hello world", expected: true },
  ];
  let actualPass = 0;
  let expectPass = 0;
  for (const f of fixture) {
    if (f.expected) expectPass += 1;
    const r = await grader(sample("s", f.ref), result(f.out));
    if (r.passed) actualPass += 1;
  }
  check(`pass-rate snapshot: expected ${expectPass}, got ${actualPass}`, actualPass === expectPass);
}

// ── Probe C: embedder-error fallback ──────────────────────────────────────
log("probe C: embedder error → ROUGE-L fallback");
{
  class FailingEmbedder implements Embedder {
    readonly model = "mock/failing";
    readonly provider = "mock" as const;
    async embed(): Promise<number[][]> {
      throw new Error("simulated rate limit");
    }
  }
  const grader = semanticSimilarity({ embedder: new FailingEmbedder(), threshold: 0.7 });
  const out = await grader(sample("s", "the cat sat"), result("the cat sat"));
  check("fallback rationale", out.rationale.includes("fallback ROUGE-L"));
  check("rate-limit error surfaced in rationale", out.rationale.includes("simulated rate limit"));
  check("identical strings still pass via fallback", out.passed === true && out.score === 1);
}

// ── Probe D: live embedder probe ──────────────────────────────────────────
const liveModel = process.env["CREWHAUS_SECTION38_LIVE_EMBEDDER"];
log(`probe D: live embedder probe (gate=${liveModel ?? "off"})`);
if (liveModel) {
  try {
    const live = createEmbedder({ model: liveModel });
    const grader = semanticSimilarity({ embedder: live, threshold: 0.5 });
    const out = await grader(sample("s", "Hello world"), result("Hello world"));
    check("live embedder identical strings pass", out.passed);
    check(`live embedder score > 0.5 (got ${out.score.toFixed(3)})`, out.score > 0.5);
  } catch (err) {
    log(`  ✗ live probe failed: ${(err as Error).message}`);
    failed += 1;
  }
} else {
  log("  ⓘ skipped (set CREWHAUS_SECTION38_LIVE_EMBEDDER to e.g. openai/text-embedding-3-small)");
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
