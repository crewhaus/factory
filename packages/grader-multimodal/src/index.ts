import { GraderError } from "@crewhaus/eval-grader";
import type { GradeResult, Grader, RunResult, Sample } from "@crewhaus/eval-grader";

/**
 * Catalog R15 `grader-multimodal` — Section 38 image / audio / OCR graders.
 *
 * Three graders, each pluggable into §29 grader-registry independently:
 *
 *   imageSimilarity({ reference, threshold?, hashSize? })
 *     Perceptual-hash distance (aHash on caller-supplied 8-bit
 *     grayscale matrix) + optional DSSIM via a custom comparator.
 *     Pure-TS, no native deps. Reference image is a `GrayscaleImage`
 *     supplied either via `options.reference` or by reading
 *     `sample.metadata.expected_image` (a base64-encoded matrix the
 *     dataset loader serializes).
 *
 *   imageOcrThenGrade({ ocr, textGrader })
 *     Caller supplies an `OcrFn` that takes raw image bytes and
 *     returns text; the result is passed to a configured text grader
 *     (typically rougeL / semanticSimilarity / exactMatch).
 *
 *   audioTranscriptMatch({ stt, textGrader })
 *     Mirrors the OCR path: caller supplies a `SttFn`, then routes
 *     through a text grader.
 *
 * The OCR / STT shapes are intentionally minimal interfaces so
 * callers can wire Tesseract.js, Whisper, GCP Speech, etc. without
 * a hard dependency.
 *
 * Layer R15.
 */

// --------------------------------------------------------------------
// Image similarity (perceptual hash)
// --------------------------------------------------------------------

export type GrayscaleImage = {
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
  /** Row-major 8-bit grayscale pixels. Length must equal width*height. */
  readonly pixels: ReadonlyArray<number>;
};

/** Average-hash (aHash) — one of the simplest perceptual hashes. */
export function aHash(image: GrayscaleImage, hashSize = 8): bigint {
  if (hashSize <= 0 || hashSize > 16 || !Number.isInteger(hashSize)) {
    throw new GraderError(`aHash hashSize must be an integer in (0, 16] (got ${hashSize})`);
  }
  if (image.pixels.length !== image.width * image.height) {
    throw new GraderError(
      `aHash: pixel count ${image.pixels.length} != width*height ${image.width * image.height}`,
    );
  }
  if (image.width === 0 || image.height === 0) {
    throw new GraderError("aHash: zero-dimension image");
  }
  const cellW = image.width / hashSize;
  const cellH = image.height / hashSize;
  const buckets = new Array<number>(hashSize * hashSize).fill(0);
  const counts = new Array<number>(hashSize * hashSize).fill(0);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const cx = Math.min(hashSize - 1, Math.floor(x / cellW));
      const cy = Math.min(hashSize - 1, Math.floor(y / cellH));
      const idx = cy * hashSize + cx;
      buckets[idx] = (buckets[idx] ?? 0) + (image.pixels[y * image.width + x] ?? 0);
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
  }
  const cellAvg = buckets.map((sum, i) => sum / Math.max(1, counts[i] ?? 1));
  let total = 0;
  for (const v of cellAvg) total += v;
  const mean = total / cellAvg.length;
  let bits = 0n;
  for (let i = 0; i < cellAvg.length; i++) {
    if ((cellAvg[i] ?? 0) >= mean) {
      bits |= 1n << BigInt(i);
    }
  }
  return bits;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    if ((x & 1n) === 1n) count += 1;
    x >>= 1n;
  }
  return count;
}

export type ImageSimilarityOptions = {
  /** Reference image (else read from `sample.metadata.expected_image`). */
  readonly reference?: GrayscaleImage;
  readonly hashSize?: number;
  /** 0..1 pass/fail boundary on the normalized similarity. Default 0.85. */
  readonly threshold?: number;
  /**
   * Where to find the agent's image in the run result. By default the
   * grader expects `runResult.events` to carry the latest
   * `tool_call_end` containing an `image` payload, which is impractical
   * for the current §16 RunResult shape. So we instead expect callers
   * to pre-extract the image into `runResult.toolCalls[i].toolName === "imageOutput"`
   * pseudo-shim, OR — more practically — to use the `extractImage`
   * helper to pull the image out of a metadata field.
   */
  readonly extractImage?: (runResult: RunResult) => GrayscaleImage | undefined;
};

const DEFAULT_HASH_SIZE = 8;
const DEFAULT_IMG_THRESHOLD = 0.85;
const DEFAULT_OCR_THRESHOLD = 0.7;
const DEFAULT_STT_THRESHOLD = 0.7;

function decodeImageFromMetadata(value: unknown): GrayscaleImage | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    "width" in value &&
    "height" in value &&
    "pixels" in value
  ) {
    const v = value as { width: unknown; height: unknown; pixels: unknown };
    if (
      typeof v.width === "number" &&
      typeof v.height === "number" &&
      Array.isArray(v.pixels) &&
      v.pixels.every((p) => typeof p === "number")
    ) {
      return {
        width: v.width,
        height: v.height,
        pixels: v.pixels as number[],
      };
    }
  }
  return undefined;
}

export function imageSimilarity(opts: ImageSimilarityOptions = {}): Grader {
  const hashSize = opts.hashSize ?? DEFAULT_HASH_SIZE;
  const threshold = opts.threshold ?? DEFAULT_IMG_THRESHOLD;
  const maxBits = hashSize * hashSize;

  return async (sample: Sample, runResult: RunResult): Promise<GradeResult> => {
    const reference =
      opts.reference ?? decodeImageFromMetadata(sample.metadata?.["expected_image"]);
    if (reference === undefined) {
      throw new GraderError(
        "imageSimilarity: reference image required (options.reference or sample.metadata.expected_image)",
      );
    }
    const candidate = opts.extractImage
      ? opts.extractImage(runResult)
      : decodeImageFromMetadata(
          (runResult as unknown as { producedImage?: unknown }).producedImage,
        );
    if (candidate === undefined) {
      throw new GraderError(
        "imageSimilarity: candidate image not found — supply opts.extractImage or attach runResult.producedImage",
      );
    }
    const refHash = aHash(reference, hashSize);
    const candHash = aHash(candidate, hashSize);
    const dist = hammingDistance(refHash, candHash);
    // Normalize: score = 1 - dist / maxBits.
    const score = Math.max(0, 1 - dist / maxBits);
    return {
      passed: score >= threshold,
      score,
      rationale: `image hamming ${dist}/${maxBits} → similarity ${score.toFixed(3)} (threshold ${threshold.toFixed(2)})`,
    };
  };
}

// --------------------------------------------------------------------
// OCR-then-grade
// --------------------------------------------------------------------

export type OcrFn = (image: Uint8Array | string, lang?: string) => Promise<string>;

export type ImageOcrThenGradeOptions = {
  /** Caller-supplied OCR function (Tesseract.js, GCP Vision, etc.). */
  readonly ocr: OcrFn;
  /** Text grader — typically rougeL / semanticSimilarity / exactMatch. */
  readonly textGrader: Grader;
  /** ISO 639-1 language hint passed to the OCR backend. Default "en". */
  readonly lang?: string;
  /** How to extract the image bytes from the run result. */
  readonly extractImageBytes?: (runResult: RunResult) => Uint8Array | string | undefined;
};

export function imageOcrThenGrade(opts: ImageOcrThenGradeOptions): Grader {
  if (opts.ocr === undefined || typeof opts.ocr !== "function") {
    throw new GraderError("imageOcrThenGrade: `ocr` function is required");
  }
  if (opts.textGrader === undefined || typeof opts.textGrader !== "function") {
    throw new GraderError("imageOcrThenGrade: `textGrader` is required");
  }
  const lang = opts.lang ?? "en";
  return async (sample: Sample, runResult: RunResult): Promise<GradeResult> => {
    const bytes = opts.extractImageBytes
      ? opts.extractImageBytes(runResult)
      : ((runResult as unknown as { imageBytes?: Uint8Array | string }).imageBytes ?? undefined);
    if (bytes === undefined) {
      throw new GraderError(
        "imageOcrThenGrade: image bytes not found — supply opts.extractImageBytes",
      );
    }
    const text = await opts.ocr(bytes, lang);
    const wrappedRunResult: RunResult = {
      ...runResult,
      agentOutput: text,
    };
    const inner = await opts.textGrader(sample, wrappedRunResult);
    return {
      passed: inner.passed,
      score: inner.score,
      rationale: `ocr→text-grader: ${inner.rationale}`,
    };
  };
}

// --------------------------------------------------------------------
// Audio-transcript-match
// --------------------------------------------------------------------

export type SttFn = (audio: Uint8Array | string, lang?: string) => Promise<string>;

export type AudioTranscriptMatchOptions = {
  readonly stt: SttFn;
  readonly textGrader: Grader;
  readonly lang?: string;
  readonly extractAudioBytes?: (runResult: RunResult) => Uint8Array | string | undefined;
};

export function audioTranscriptMatch(opts: AudioTranscriptMatchOptions): Grader {
  if (opts.stt === undefined || typeof opts.stt !== "function") {
    throw new GraderError("audioTranscriptMatch: `stt` function is required");
  }
  if (opts.textGrader === undefined || typeof opts.textGrader !== "function") {
    throw new GraderError("audioTranscriptMatch: `textGrader` is required");
  }
  const lang = opts.lang ?? "en";
  return async (sample: Sample, runResult: RunResult): Promise<GradeResult> => {
    const audio = opts.extractAudioBytes
      ? opts.extractAudioBytes(runResult)
      : ((runResult as unknown as { audioBytes?: Uint8Array | string }).audioBytes ?? undefined);
    if (audio === undefined) {
      throw new GraderError(
        "audioTranscriptMatch: audio bytes not found — supply opts.extractAudioBytes",
      );
    }
    const text = await opts.stt(audio, lang);
    const wrappedRunResult: RunResult = {
      ...runResult,
      agentOutput: text,
    };
    const inner = await opts.textGrader(sample, wrappedRunResult);
    return {
      passed: inner.passed,
      score: inner.score,
      rationale: `stt→text-grader: ${inner.rationale}`,
    };
  };
}

export {
  decodeImageFromMetadata as _decodeImageFromMetadataForTest,
  DEFAULT_HASH_SIZE as _defaultHashSizeForTest,
  DEFAULT_IMG_THRESHOLD as _defaultImgThresholdForTest,
  DEFAULT_OCR_THRESHOLD as _defaultOcrThresholdForTest,
  DEFAULT_STT_THRESHOLD as _defaultSttThresholdForTest,
};
