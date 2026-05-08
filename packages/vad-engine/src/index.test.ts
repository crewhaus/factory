import { describe, expect, test } from "bun:test";
import { createVadDetector, frames30ms } from "./index.js";

function silence(n: number): Int16Array {
  return new Int16Array(n);
}

function whiteNoise(n: number, amplitude: number, seed = 1): Int16Array {
  // Linear-congruential PRNG so tests are deterministic.
  let s = seed;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const r = ((s % 1000) - 500) / 500; // [-1, 1)
    out[i] = Math.round(r * amplitude);
  }
  return out;
}

function tone(n: number, freqHz: number, sampleRate: number, amplitude: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amplitude);
  }
  return out;
}

/**
 * Speech-like signal: a sum of two formants (F1 ≈ 500Hz, F2 ≈ 1500Hz)
 * with amplitude modulation to approximate voicing. Enough to push both
 * energy and ZCR into the speech band for aggressiveness ≤ 2.
 */
function speechLike(n: number, sampleRate: number, amplitude: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * 5 * i) / sampleRate);
    const sig =
      0.7 * Math.sin((2 * Math.PI * 500 * i) / sampleRate) +
      0.3 * Math.sin((2 * Math.PI * 1500 * i) / sampleRate);
    out[i] = Math.round(env * sig * amplitude);
  }
  return out;
}

describe("createVadDetector — energy + ZCR heuristic (T1)", () => {
  test("silent frame → silence at every aggressiveness", () => {
    for (const a of [0, 1, 2, 3] as const) {
      const det = createVadDetector({ aggressiveness: a });
      expect(det.detect(silence(720))).toBe("silence");
    }
  });

  test("speech-like signal → speech at aggressiveness 0..2", () => {
    const f = speechLike(720, 24_000, 8000);
    for (const a of [0, 1, 2] as const) {
      const det = createVadDetector({ aggressiveness: a });
      expect(det.detect(f)).toBe("speech");
    }
  });

  test("aggressiveness=3 ignores low-amplitude speech-shaped signal", () => {
    const det = createVadDetector({ aggressiveness: 3 });
    const f = speechLike(720, 24_000, 1500);
    // Low energy at aggressiveness 3: should NOT be classified as speech.
    expect(det.detect(f)).not.toBe("speech");
  });

  test("low-energy white noise → silence (T9 noise rejection at aggressiveness ≥ 2)", () => {
    const det = createVadDetector({ aggressiveness: 2 });
    const f = whiteNoise(720, 250);
    // Low-amplitude noise → energy below threshold.
    expect(det.detect(f)).toBe("silence");
  });

  test("loud white noise → not speech (ZCR too high)", () => {
    // White noise has ZCR much higher than the speech band.
    const det = createVadDetector({ aggressiveness: 1 });
    const f = whiteNoise(720, 12000);
    // High energy but ZCR way out of band → transitioning, NOT speech.
    expect(det.detect(f)).not.toBe("speech");
  });

  test("pure tone at 60Hz → not speech (ZCR too low)", () => {
    const det = createVadDetector({ aggressiveness: 1 });
    const f = tone(720, 60, 24_000, 8000);
    // Energy passes but ZCR is too low → not speech.
    expect(det.detect(f)).not.toBe("speech");
  });

  test("empty frame → silence", () => {
    const det = createVadDetector({ aggressiveness: 1 });
    expect(det.detect(new Int16Array(0))).toBe("silence");
  });
});

describe("frames30ms helper", () => {
  test("splits a 2-second PCM buffer into 66 30ms frames at 24kHz", () => {
    const pcm = new Int16Array(24_000 * 2);
    const fs = frames30ms(pcm, 24_000);
    expect(fs.length).toBe(66); // floor(48000 / 720) = 66
    expect(fs[0]?.length).toBe(720);
  });

  test("drops a partial tail shorter than one frame", () => {
    const pcm = new Int16Array(720 + 100);
    const fs = frames30ms(pcm, 24_000);
    expect(fs.length).toBe(1);
  });
});

describe("T9 noise-injection stability — random noise at aggressiveness 2+ never reports speech", () => {
  test("10-second white-noise stream → 0 speech verdicts at aggressiveness 2", () => {
    const sr = 24_000;
    const det = createVadDetector({ aggressiveness: 2 });
    const pcm = whiteNoise(sr * 10, 6000, 42);
    const fs = frames30ms(pcm, sr);
    const counts = { speech: 0, silence: 0, transitioning: 0 };
    for (const f of fs) {
      counts[det.detect(f)] += 1;
    }
    expect(counts.speech).toBe(0);
    expect(counts.silence + counts.transitioning).toBe(fs.length);
  });
});
