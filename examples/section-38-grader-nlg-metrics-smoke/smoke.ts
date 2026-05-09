#!/usr/bin/env bun
/**
 * Section 38 grader-nlg-metrics smoke.
 *
 * Probes:
 *   A) ROUGE-1 / ROUGE-L / BLEU-4 / METEOR each registerable in
 *      @crewhaus/grader-registry under their canonical names
 *   B) 5-sample fixture pass-rate matches snapshot
 *   C) score-monotonicity property: longer overlap ⇒ higher score
 *      across every metric
 */
import type { RunResult, Sample } from "@crewhaus/eval-grader";
import { bleu1, bleu4, meteor, rouge1, rouge2, rougeL } from "@crewhaus/grader-nlg-metrics";
import { GraderRegistry } from "@crewhaus/grader-registry";

const log = (s: string) => process.stdout.write(`[section-38-nlg] ${s}\n`);
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

// ── Probe A: registry registration ────────────────────────────────────────
log("probe A: register the §38 grader family in §29 grader-registry");
{
  const reg = new GraderRegistry();
  reg.register("rouge_1", rouge1({ threshold: 0.5 }));
  reg.register("rouge_2", rouge2({ threshold: 0.5 }));
  reg.register("rouge_l", rougeL({ threshold: 0.5 }));
  reg.register("bleu_1", bleu1({ threshold: 0.5 }));
  reg.register("bleu_4", bleu4({ threshold: 0.5 }));
  reg.register("meteor", meteor({ threshold: 0.5 }));
  const names = reg.list();
  check("registered 6 graders", names.length === 6);
  check("rouge_l present", reg.has("rouge_l"));
  check("bleu_4 present", reg.has("bleu_4"));
  check("meteor present", reg.has("meteor"));
}

// ── Probe B: 5-sample fixture pass-rate snapshot ──────────────────────────
log("probe B: 5-sample fixture pass-rate matches snapshot");
{
  const fixture: ReadonlyArray<{ ref: string; out: string; expectedPass: boolean }> = [
    { ref: "the cat sat on the mat", out: "the cat sat on the mat", expectedPass: true },
    { ref: "alpha beta gamma delta", out: "alpha beta gamma delta", expectedPass: true },
    { ref: "the cat sat on the mat", out: "the cat sat on the rug", expectedPass: true },
    { ref: "completely different", out: "no overlap whatsoever here", expectedPass: false },
    { ref: "hello world", out: "goodbye moon", expectedPass: false },
  ];
  const grader = rougeL({ threshold: 0.5 });
  let actualPasses = 0;
  let expectedPasses = 0;
  for (const f of fixture) {
    if (f.expectedPass) expectedPasses += 1;
    const r = await grader(sample(`f-${f.ref}`, f.ref), result(f.out));
    if (r.passed) actualPasses += 1;
  }
  check(
    `pass-rate snapshot: expected ${expectedPasses}, got ${actualPasses}`,
    actualPasses === expectedPasses,
  );
}

// ── Probe C: monotonicity property ────────────────────────────────────────
log("probe C: T9 — score-monotonicity across all metrics");
{
  const ref = "alpha beta gamma delta epsilon";
  const hyps = [
    "alpha",
    "alpha beta",
    "alpha beta gamma",
    "alpha beta gamma delta",
    "alpha beta gamma delta epsilon",
  ];
  const metrics: Array<{ name: string; grader: ReturnType<typeof rouge1> }> = [
    { name: "rouge_1", grader: rouge1({ threshold: 0 }) },
    { name: "rouge_l", grader: rougeL({ threshold: 0 }) },
    { name: "meteor", grader: meteor({ threshold: 0 }) },
  ];
  for (const m of metrics) {
    let prev = -1;
    let monotone = true;
    for (const h of hyps) {
      const g = await m.grader(sample("s", ref), result(h));
      if (g.score < prev - 1e-9) {
        monotone = false;
        break;
      }
      prev = g.score;
    }
    check(`${m.name}: longer overlap ⇒ higher score`, monotone);
  }
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
