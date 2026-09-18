/**
 * Pixel operations on decoded RGBA: resampling, cropping, comparison and a
 * perceptual hash.
 *
 * Everything here is integer-deterministic. Resampling rounds with
 * `Math.round` on a value computed in the same order every time, so two
 * runs on the same pixels produce byte-identical output — which is the
 * whole point of a screenshot-regression primitive.
 */
import { MediaFormatError } from "./bytes";
import { type RgbaImage, luma } from "./png";

export type Resampling = "nearest" | "bilinear";

/** A blank image, fully transparent. */
export function blankImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/**
 * Resize to exactly `width` x `height`.
 *
 * `nearest` preserves exact colours (right for pixel art, palettes and QR
 * codes); `bilinear` averages the four neighbours (right for photographs,
 * and the only one of the two that does not alias badly when shrinking by
 * a large factor — though neither does the area-averaging a proper
 * downscaler would, which is stated rather than hidden).
 */
export function resizeImage(
  image: RgbaImage,
  width: number,
  height: number,
  method: Resampling,
): RgbaImage {
  if (width <= 0 || height <= 0) {
    throw new MediaFormatError(`cannot resize to ${width}x${height}`);
  }
  const out = new Uint8Array(width * height * 4);
  const src = image.data;
  const sw = image.width;
  const sh = image.height;
  const xRatio = sw / width;
  const yRatio = sh / height;

  if (method === "nearest") {
    for (let y = 0; y < height; y++) {
      const sy = Math.min(sh - 1, Math.floor((y + 0.5) * yRatio));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(sw - 1, Math.floor((x + 0.5) * xRatio));
        const s = (sy * sw + sx) * 4;
        const d = (y * width + x) * 4;
        out[d] = src[s] as number;
        out[d + 1] = src[s + 1] as number;
        out[d + 2] = src[s + 2] as number;
        out[d + 3] = src[s + 3] as number;
      }
    }
    return { width, height, data: out };
  }

  for (let y = 0; y < height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const p00 = (y0 * sw + x0) * 4;
      const p01 = (y0 * sw + x1) * 4;
      const p10 = (y1 * sw + x0) * 4;
      const p11 = (y1 * sw + x1) * 4;
      const d = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = (src[p00 + c] as number) * (1 - wx) + (src[p01 + c] as number) * wx;
        const bottom = (src[p10 + c] as number) * (1 - wx) + (src[p11 + c] as number) * wx;
        out[d + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return { width, height, data: out };
}

/** The size that fits `width`/`height` while preserving the aspect ratio. */
export function fitDimensions(
  source: { readonly width: number; readonly height: number },
  wanted: { readonly width?: number; readonly height?: number },
): { width: number; height: number } {
  const { width, height } = wanted;
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) {
    return { width, height: Math.max(1, Math.round((width * source.height) / source.width)) };
  }
  if (height !== undefined) {
    return { width: Math.max(1, Math.round((height * source.width) / source.height)), height };
  }
  return { width: source.width, height: source.height };
}

/** Cut a rectangle out. The rectangle must lie entirely inside the image. */
export function cropImage(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
): RgbaImage {
  if (width <= 0 || height <= 0) throw new MediaFormatError(`cannot crop to ${width}x${height}`);
  if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) {
    throw new MediaFormatError(
      `crop ${width}x${height}+${x}+${y} is not inside the ${image.width}x${image.height} image`,
    );
  }
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4;
    out.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// Comparison

export type DiffResult = {
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly differingPixels: number;
  /** `differingPixels / totalPixels`, rounded to six places. */
  readonly fraction: number;
  /** Largest single-channel absolute difference anywhere. */
  readonly maxChannelDelta: number;
  /** Mean absolute channel difference across every channel of every pixel. */
  readonly meanChannelDelta: number;
  /** Tight box around every differing pixel, or `null` when none differ. */
  readonly boundingBox: { x: number; y: number; width: number; height: number } | null;
};

/** Round to six decimal places, so a fraction is stable across runs. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Compare two same-sized images. A pixel counts as differing when any of its
 * four channels differs by more than `threshold` (0 means exact equality).
 */
export function diffImages(a: RgbaImage, b: RgbaImage, threshold: number): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new MediaFormatError(
      `cannot compare a ${a.width}x${a.height} image with a ${b.width}x${b.height} one`,
    );
  }
  let differing = 0;
  let maxDelta = 0;
  let deltaSum = 0;
  let minX = a.width;
  let minY = a.height;
  let maxX = -1;
  let maxY = -1;
  const total = a.width * a.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    let pixelMax = 0;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs((a.data[o + c] as number) - (b.data[o + c] as number));
      deltaSum += delta;
      if (delta > pixelMax) pixelMax = delta;
    }
    if (pixelMax > maxDelta) maxDelta = pixelMax;
    if (pixelMax > threshold) {
      differing++;
      const x = i % a.width;
      const y = (i - x) / a.width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    width: a.width,
    height: a.height,
    totalPixels: total,
    differingPixels: differing,
    fraction: round6(differing / total),
    maxChannelDelta: maxDelta,
    meanChannelDelta: round6(deltaSum / (total * 4)),
    boundingBox:
      maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

/**
 * A 64-bit difference hash: reduce to 9x8 greyscale, then emit one bit per
 * adjacent horizontal pair saying whether the left sample is brighter.
 * Robust to scaling and mild compression, which is what makes it the right
 * "are these the same picture?" signal when the pixels are not identical.
 *
 * Returned as 16 lowercase hex digits, most significant bit first.
 */
export function differenceHash(image: RgbaImage): string {
  const small = resizeImage(image, 9, 8, "bilinear");
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let rowBits = 0;
    for (let x = 0; x < 8; x++) {
      const l = (y * 9 + x) * 4;
      const r = (y * 9 + x + 1) * 4;
      const left = luma(
        small.data[l] as number,
        small.data[l + 1] as number,
        small.data[l + 2] as number,
      );
      const right = luma(
        small.data[r] as number,
        small.data[r + 1] as number,
        small.data[r + 2] as number,
      );
      rowBits = (rowBits << 1) | (left > right ? 1 : 0);
    }
    hex += rowBits.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Bits that differ between two hex hashes of equal length. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new MediaFormatError(
      `cannot compare a ${a.length}-digit hash with a ${b.length}-digit one`,
    );
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let x = Number.parseInt(a[i] as string, 16) ^ Number.parseInt(b[i] as string, 16);
    while (x > 0) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/** Per-channel mean and extremes, for `PngRead`'s statistics mode. */
export function imageStats(image: RgbaImage): {
  mean: { r: number; g: number; b: number; a: number };
  min: { r: number; g: number; b: number; a: number };
  max: { r: number; g: number; b: number; a: number };
  opaquePixels: number;
  distinctColorsCapped: number;
  capped: boolean;
} {
  const sums = [0, 0, 0, 0];
  const mins = [255, 255, 255, 255];
  const maxs = [0, 0, 0, 0];
  let opaque = 0;
  const distinct = new Set<number>();
  const CAP = 4096;
  let capped = false;
  const total = image.width * image.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    for (let c = 0; c < 4; c++) {
      const v = image.data[o + c] as number;
      sums[c] = (sums[c] as number) + v;
      if (v < (mins[c] as number)) mins[c] = v;
      if (v > (maxs[c] as number)) maxs[c] = v;
    }
    if (image.data[o + 3] === 255) opaque++;
    if (!capped) {
      const key =
        ((image.data[o] as number) << 16) |
        ((image.data[o + 1] as number) << 8) |
        (image.data[o + 2] as number);
      distinct.add(key);
      if (distinct.size >= CAP) capped = true;
    }
  }
  const at = (i: number) => round6((sums[i] as number) / total);
  return {
    mean: { r: at(0), g: at(1), b: at(2), a: at(3) },
    min: { r: mins[0] as number, g: mins[1] as number, b: mins[2] as number, a: mins[3] as number },
    max: { r: maxs[0] as number, g: maxs[1] as number, b: maxs[2] as number, a: maxs[3] as number },
    opaquePixels: opaque,
    distinctColorsCapped: distinct.size,
    capped,
  };
}
