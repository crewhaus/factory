/**
 * Catalog R16 `vad-engine` — Section 24 VOICE.
 *
 * Voice activity detection. WebRTC-VAD-style heuristic over PCM 16-bit
 * frames: a frame is "speech" when BOTH (a) RMS energy crosses an
 * aggressiveness-tuned threshold and (b) zero-crossing-rate sits in a
 * speech-shaped band. Either signal alone produces a "transitioning"
 * verdict, used by `barge-in-controller` to apply hysteresis (don't
 * bargle in on a 50ms cough).
 *
 * Frame size is conventional: 30ms at the input sample rate. At 24kHz
 * mono that's 720 samples; the detector accepts ANY length but reports
 * the verdict as if it were a single frame, so callers framing at
 * higher granularity will simply get richer output.
 *
 * Aggressiveness:
 *   0 — most permissive (high speech recall, low false positives)
 *   1 — default
 *   2 — moderately aggressive (ignores low-amplitude background)
 *   3 — most aggressive (rejects most non-vocal audio)
 *
 * No external ML deps: pure heuristic. Adequate for barge-in and as a
 * pre-filter for paid VAD models. `T9` random-noise stability test
 * proves a 10-second white-noise stream produces zero "speech" verdicts
 * at aggressiveness 2+.
 */

export type Aggressiveness = 0 | 1 | 2 | 3;

export type VadVerdict = "speech" | "silence" | "transitioning";

export type DetectorOptions = {
  readonly aggressiveness?: Aggressiveness;
  /** Sample rate of incoming PCM (Hz). Default 24kHz. */
  readonly sampleRate?: number;
};

const ENERGY_THRESHOLDS: Record<Aggressiveness, number> = {
  0: 280,
  1: 540,
  2: 900,
  3: 1500,
};

// Speech-shaped ZCR band (per 1k samples). Empirical for 24kHz speech
// vs ambient noise vs single-frequency tones. The lower bound rejects
// pure low-frequency tones (e.g. 60Hz mains hum); the upper bound
// rejects white noise / high-frequency hiss.
const ZCR_LOW_PER_1K = 15;
const ZCR_HIGH_PER_1K = 220;

export interface VadDetector {
  detect(frame: Int16Array): VadVerdict;
  readonly aggressiveness: Aggressiveness;
}

export function createVadDetector(opts: DetectorOptions = {}): VadDetector {
  const aggressiveness = opts.aggressiveness ?? 1;
  void opts.sampleRate; // currently unused; reserved for future bandpass filter

  return {
    aggressiveness,
    detect(frame: Int16Array): VadVerdict {
      if (frame.length === 0) return "silence";
      let sumSq = 0;
      let zeroCrossings = 0;
      let prev = frame[0] ?? 0;
      for (let i = 0; i < frame.length; i++) {
        const v = frame[i] ?? 0;
        sumSq += v * v;
        if (i > 0 && Math.sign(v) !== Math.sign(prev) && (v !== 0 || prev !== 0)) {
          zeroCrossings += 1;
        }
        prev = v;
      }
      const rms = Math.sqrt(sumSq / frame.length);
      const zcrPer1k = (zeroCrossings * 1000) / frame.length;

      const energyOk = rms >= ENERGY_THRESHOLDS[aggressiveness];
      const zcrInBand = zcrPer1k >= ZCR_LOW_PER_1K && zcrPer1k <= ZCR_HIGH_PER_1K;

      if (energyOk && zcrInBand) return "speech";
      if (!energyOk && !zcrInBand) return "silence";
      return "transitioning";
    },
  };
}

/**
 * Helper: split a long PCM buffer into 30ms frames at `sampleRate`. Tail
 * shorter than one frame is dropped (caller can decide to pad).
 */
export function frames30ms(pcm: Int16Array, sampleRate = 24_000): Int16Array[] {
  const n = Math.floor(sampleRate * 0.03);
  const out: Int16Array[] = [];
  for (let i = 0; i + n <= pcm.length; i += n) {
    out.push(pcm.subarray(i, i + n));
  }
  return out;
}
