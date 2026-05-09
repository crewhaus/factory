#!/usr/bin/env bun
/**
 * Section 38 grader-multimodal smoke. Closes out §38.
 *
 * Probes:
 *   A) imageSimilarity / imageOcrThenGrade / audioTranscriptMatch
 *      each registerable in §29 grader-registry
 *   B) 5-sample fixture pass-rate snapshot for imageSimilarity
 *   C) OCR-then-rougeL pipeline composes correctly
 *   D) STT-then-rougeL pipeline composes correctly
 */
import type { GradeResult, Grader, RunResult, Sample } from "@crewhaus/eval-grader";
import {
  type GrayscaleImage,
  audioTranscriptMatch,
  imageOcrThenGrade,
  imageSimilarity,
} from "@crewhaus/grader-multimodal";
import { rougeL } from "@crewhaus/grader-nlg-metrics";
import { GraderRegistry } from "@crewhaus/grader-registry";

const log = (s: string) => process.stdout.write(`[section-38-mm] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const sample = (metadata: Record<string, unknown> = {}, expected_output?: string): Sample => ({
  id: "s",
  input: "ignored",
  ...(expected_output !== undefined ? { expected_output } : {}),
  metadata,
});
const result = (output = "", extra: Record<string, unknown> = {}): RunResult => ({
  agentOutput: output,
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 100,
  ...extra,
});

function checker(width: number, height: number, parity = 0): GrayscaleImage {
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.push((x + y + parity) % 2 === 0 ? 0 : 255);
    }
  }
  return { width, height, pixels };
}

// ── Probe A: registry registration ────────────────────────────────────────
log("probe A: register the §38 multimodal family in §29 grader-registry");
{
  const reg = new GraderRegistry();
  reg.register(
    "image_similarity",
    imageSimilarity({
      reference: checker(8, 8),
      threshold: 0.85,
      extractImage: () => checker(8, 8),
    }),
  );
  reg.register(
    "image_ocr_then_grade",
    imageOcrThenGrade({
      ocr: async () => "ocr output",
      textGrader: rougeL({ threshold: 0.5 }),
      extractImageBytes: () => new Uint8Array([1, 2, 3]),
    }),
  );
  reg.register(
    "audio_transcript_match",
    audioTranscriptMatch({
      stt: async () => "transcript",
      textGrader: rougeL({ threshold: 0.5 }),
      extractAudioBytes: () => new Uint8Array([4, 5, 6]),
    }),
  );
  check("registered 3 multimodal graders", reg.list().length === 3);
  check("image_similarity present", reg.has("image_similarity"));
  check("image_ocr_then_grade present", reg.has("image_ocr_then_grade"));
  check("audio_transcript_match present", reg.has("audio_transcript_match"));
}

// ── Probe B: 5-sample fixture pass-rate (imageSimilarity) ────────────────
log("probe B: 5-sample fixture pass-rate matches snapshot");
{
  // aHash hashes by per-cell average vs global mean. Checkerboards
  // and uniform-tone images are aHash-degenerate (same global mean,
  // same all-cells-equal-mean signature). Use directional gradients
  // so the per-cell averages actually vary.
  const horiz = (w = 32, h = 32, invert = false): GrayscaleImage => {
    const pixels: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.floor((x / w) * 255);
        pixels.push(invert ? 255 - v : v);
      }
    }
    return { width: w, height: h, pixels };
  };
  const vert = (w = 32, h = 32): GrayscaleImage => {
    const pixels: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        pixels.push(Math.floor((y / h) * 255));
      }
    }
    return { width: w, height: h, pixels };
  };
  const ref = horiz();
  const fixture: ReadonlyArray<{ name: string; cand: GrayscaleImage; expectedPass: boolean }> = [
    { name: "identical", cand: ref, expectedPass: true },
    { name: "vertical-gradient", cand: vert(), expectedPass: false },
    { name: "identical-2", cand: ref, expectedPass: true },
    { name: "inverted-horiz", cand: horiz(32, 32, true), expectedPass: false },
    { name: "identical-3", cand: ref, expectedPass: true },
  ];
  let actualPass = 0;
  let expectPass = 0;
  for (const f of fixture) {
    if (f.expectedPass) expectPass += 1;
    const g = imageSimilarity({ reference: ref, threshold: 0.8, extractImage: () => f.cand });
    const r = await g(sample(), result());
    if (r.passed) actualPass += 1;
  }
  check(`pass-rate snapshot: expected ${expectPass}, got ${actualPass}`, actualPass === expectPass);
  // Suppress unused-variable warning on `checker` helper.
  void checker;
}

// ── Probe C: OCR-then-rougeL pipeline ─────────────────────────────────────
log("probe C: imageOcrThenGrade composes with rougeL");
{
  const ocr = async () => "Hello, world!";
  const inner = rougeL({ threshold: 0.5 });
  const grader = imageOcrThenGrade({
    ocr,
    textGrader: inner,
    extractImageBytes: () => new Uint8Array([1, 2, 3]),
  });
  const out = await grader(sample({}, "Hello, world!"), result());
  check("OCR text matches expected_output via ROUGE-L", out.passed);
  check("rationale tagged with ocr→text-grader", out.rationale.includes("ocr→text-grader"));
}

// ── Probe D: STT-then-rougeL pipeline ─────────────────────────────────────
log("probe D: audioTranscriptMatch composes with rougeL");
{
  const stt = async () => "the deploy succeeded";
  const grader = audioTranscriptMatch({
    stt,
    textGrader: rougeL({ threshold: 0.5 }),
    extractAudioBytes: () => new Uint8Array([4, 5, 6]),
  });
  const out = await grader(sample({}, "the deploy succeeded"), result());
  check("STT text matches expected_output via ROUGE-L", out.passed);
  check("rationale tagged with stt→text-grader", out.rationale.includes("stt→text-grader"));
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
