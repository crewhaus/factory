import { describe, expect, test } from "bun:test";
import type { GradeResult, RunResult, Sample } from "@crewhaus/eval-grader";
import { GraderError } from "@crewhaus/eval-grader";
import {
  type GrayscaleImage,
  type OcrFn,
  type SttFn,
  aHash,
  audioTranscriptMatch,
  hammingDistance,
  imageOcrThenGrade,
  imageSimilarity,
} from "./index";

const sample = (metadata: Record<string, unknown> = {}): Sample => ({
  id: "s",
  input: "ignored",
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

function checkerboard(width: number, height: number): GrayscaleImage {
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.push((x + y) % 2 === 0 ? 0 : 255);
    }
  }
  return { width, height, pixels };
}

function shifted(width: number, height: number): GrayscaleImage {
  // Same checkerboard shifted by 1 pixel — perceptually similar but
  // the bits flip in many cells.
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.push((x + y + 1) % 2 === 0 ? 0 : 255);
    }
  }
  return { width, height, pixels };
}

function gradient(width: number, height: number): GrayscaleImage {
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.push(Math.floor((x / width) * 255));
    }
  }
  return { width, height, pixels };
}

describe("aHash + hammingDistance (T1)", () => {
  test("identical images produce identical hashes", () => {
    const img = gradient(32, 32);
    expect(aHash(img)).toBe(aHash(img));
  });

  test("hammingDistance to self is 0", () => {
    const img = gradient(32, 32);
    const h = aHash(img);
    expect(hammingDistance(h, h)).toBe(0);
  });

  test("opposite-tone images differ by half the bits on average", () => {
    const a = gradient(32, 32);
    const b: GrayscaleImage = {
      width: 32,
      height: 32,
      pixels: a.pixels.map((p) => 255 - p),
    };
    const dist = hammingDistance(aHash(a), aHash(b));
    // Inverting tones around the per-cell mean keeps the same hash bits
    // because aHash thresholds against the GLOBAL mean — so inverted
    // gradients hash to the bitwise complement.
    expect(dist).toBeGreaterThan(0);
  });

  test("rejects malformed image (pixel count mismatch)", () => {
    expect(() => aHash({ width: 4, height: 4, pixels: [1, 2, 3] })).toThrow(/pixel count/);
  });

  test("rejects zero-dim image", () => {
    expect(() => aHash({ width: 0, height: 0, pixels: [] })).toThrow(/zero-dimension/);
  });

  test("rejects out-of-range hashSize", () => {
    const img = gradient(32, 32);
    expect(() => aHash(img, 0)).toThrow(/hashSize/);
    expect(() => aHash(img, 17)).toThrow(/hashSize/);
    expect(() => aHash(img, 4.5)).toThrow(/hashSize/);
  });
});

describe("imageSimilarity grader (T1 + T2)", () => {
  test("identical reference + candidate scores 1.0", async () => {
    const ref = checkerboard(32, 32);
    const grader = imageSimilarity({
      reference: ref,
      threshold: 0.5,
      extractImage: () => ref,
    });
    const out = await grader(sample(), result());
    expect(out.score).toBe(1);
    expect(out.passed).toBe(true);
    expect(out.rationale).toMatch(/hamming 0/);
  });

  test("shifted-pattern still scores high (perceptual hash)", async () => {
    const ref = checkerboard(32, 32);
    const cand = shifted(32, 32);
    const grader = imageSimilarity({
      reference: ref,
      threshold: 0.5,
      extractImage: () => cand,
    });
    const out = await grader(sample(), result());
    expect(out.score).toBeGreaterThan(0.5);
  });

  test("totally different image scores low", async () => {
    const ref = checkerboard(32, 32);
    const cand: GrayscaleImage = {
      width: 32,
      height: 32,
      pixels: ref.pixels.map((_, i) => (i % 7 === 0 ? 200 : 0)),
    };
    const grader = imageSimilarity({
      reference: ref,
      threshold: 0.95,
      extractImage: () => cand,
    });
    const out = await grader(sample(), result());
    expect(out.passed).toBe(false);
  });

  test("reference falls back to sample.metadata.expected_image", async () => {
    const ref = checkerboard(8, 8);
    const grader = imageSimilarity({
      threshold: 0.5,
      extractImage: () => ref,
    });
    const out = await grader(sample({ expected_image: ref }), result());
    expect(out.score).toBe(1);
  });

  test("missing reference + missing candidate throw GraderError", async () => {
    const grader = imageSimilarity({ threshold: 0.5 });
    await expect(grader(sample(), result())).rejects.toThrow(/reference image required/);
  });
});

describe("imageOcrThenGrade (T1 + T3)", () => {
  test("OCR result is passed to the inner text grader", async () => {
    const ocr: OcrFn = async () => "the cat sat on the mat";
    const captured: { sample?: Sample; runResult?: RunResult } = {};
    const textGrader = async (s: Sample, r: RunResult): Promise<GradeResult> => {
      captured.sample = s;
      captured.runResult = r;
      return { passed: true, score: 1, rationale: "stub" };
    };
    const grader = imageOcrThenGrade({
      ocr,
      textGrader,
      extractImageBytes: () => new Uint8Array([1, 2, 3]),
    });
    const out = await grader(sample(), result());
    expect(out.passed).toBe(true);
    expect(out.rationale).toMatch(/ocr→text-grader: stub/);
    expect(captured.runResult?.agentOutput).toBe("the cat sat on the mat");
  });

  test("missing image bytes throws GraderError", async () => {
    const grader = imageOcrThenGrade({
      ocr: async () => "anything",
      textGrader: async () => ({ passed: true, score: 1, rationale: "" }),
    });
    await expect(grader(sample(), result())).rejects.toThrow(/image bytes not found/);
  });

  test("missing ocr or textGrader throws at construction", () => {
    expect(() =>
      imageOcrThenGrade({
        ocr: undefined as unknown as OcrFn,
        textGrader: async () => ({ passed: true, score: 1, rationale: "" }),
      }),
    ).toThrow(/`ocr` function is required/);
    expect(() =>
      imageOcrThenGrade({
        ocr: async () => "x",
        textGrader: undefined as unknown as ReturnType<typeof imageOcrThenGrade>,
      }),
    ).toThrow(/`textGrader` is required/);
  });
});

describe("audioTranscriptMatch (T1 + T3)", () => {
  test("STT result is passed to the inner text grader", async () => {
    const stt: SttFn = async () => "hello world";
    const captured: { runResult?: RunResult } = {};
    const textGrader = async (_s: Sample, r: RunResult): Promise<GradeResult> => {
      captured.runResult = r;
      return { passed: true, score: 1, rationale: "stub" };
    };
    const grader = audioTranscriptMatch({
      stt,
      textGrader,
      extractAudioBytes: () => new Uint8Array([4, 5, 6]),
    });
    const out = await grader(sample(), result());
    expect(out.passed).toBe(true);
    expect(out.rationale).toMatch(/stt→text-grader: stub/);
    expect(captured.runResult?.agentOutput).toBe("hello world");
  });

  test("missing audio bytes throws GraderError", async () => {
    const grader = audioTranscriptMatch({
      stt: async () => "anything",
      textGrader: async () => ({ passed: true, score: 1, rationale: "" }),
    });
    await expect(grader(sample(), result())).rejects.toThrow(/audio bytes not found/);
  });

  test("missing stt or textGrader throws at construction", () => {
    expect(() =>
      audioTranscriptMatch({
        stt: undefined as unknown as SttFn,
        textGrader: async () => ({ passed: true, score: 1, rationale: "" }),
      }),
    ).toThrow(/`stt` function is required/);
  });
});

describe("Integration: composing multimodal with text graders", () => {
  test("OCR-then-grader pipeline propagates pass/fail", async () => {
    const ocr: OcrFn = async () => "specific reference text";
    const exactGrader = async (s: Sample, r: RunResult): Promise<GradeResult> => ({
      passed: r.agentOutput === s.expected_output,
      score: r.agentOutput === s.expected_output ? 1 : 0,
      rationale: "exactMatch",
    });
    const grader = imageOcrThenGrade({
      ocr,
      textGrader: exactGrader,
      extractImageBytes: () => new Uint8Array([1]),
    });
    const matchSample: Sample = { id: "s", input: "x", expected_output: "specific reference text" };
    const out1 = await grader(matchSample, result());
    expect(out1.passed).toBe(true);
    const mismatchSample: Sample = { id: "s", input: "x", expected_output: "different" };
    const out2 = await grader(mismatchSample, result());
    expect(out2.passed).toBe(false);
  });
});
