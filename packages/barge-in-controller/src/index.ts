/**
 * Catalog R16 `barge-in-controller` — Section 24 VOICE.
 *
 * Coordinator between `vad-engine` and a `RealtimeAdapter`. Watches
 * inbound user audio frames; when the user starts speaking AND the
 * agent is currently playing audio back, fires `adapter.interrupt()`
 * so the agent's response is cancelled and the user's turn takes over.
 *
 * Hysteresis: a single 30ms speech frame is not enough to barge in
 * (rejects a 50ms cough). The controller waits for `triggerFrames`
 * consecutive speech-classified frames within a `windowMs` window
 * before firing. Defaults: 4 frames in 200ms.
 *
 * Playback tracking: the controller listens for `audio_chunk` events on
 * the adapter to mark the agent as "speaking", and for
 * `transcript_final` / `interrupt` / `disconnect` to mark the agent as
 * "idle". Barge-in only fires while the agent is speaking — when it's
 * idle, `feedAudioFrame` is a no-op (the user's normal turn ends with
 * server VAD, no need to interrupt anything).
 */
import { type VadDetector, createVadDetector } from "@crewhaus/vad-engine";
import type { RealtimeAdapter } from "@crewhaus/voice-runtime";

export type BargeInOptions = {
  readonly adapter: RealtimeAdapter;
  readonly detector?: VadDetector;
  /**
   * Consecutive speech frames inside `windowMs` to trigger an
   * interrupt. Defaults to 4 (≈ 120ms of continuous speech at 30ms
   * framing).
   */
  readonly triggerFrames?: number;
  /** Sliding-window bound for the trigger count. Defaults to 200ms. */
  readonly windowMs?: number;
  /** Per-frame elapsed time advances. Defaults to 30ms. */
  readonly frameMs?: number;
  readonly onBargeIn?: (info: { reason: string; speechFrames: number }) => void;
};

export interface BargeInController {
  /** Push one inbound user-mic PCM frame. Returns the VAD verdict for diagnostics. */
  feedAudioFrame(frame: Int16Array): "speech" | "silence" | "transitioning";
  /** Whether the agent is currently speaking (set by adapter `audio_chunk` events). */
  isAgentSpeaking(): boolean;
  /** Detach the adapter listener. */
  stop(): void;
}

const DEFAULT_TRIGGER_FRAMES = 4;
const DEFAULT_WINDOW_MS = 200;
const DEFAULT_FRAME_MS = 30;

export function createBargeInController(opts: BargeInOptions): BargeInController {
  const detector = opts.detector ?? createVadDetector({ aggressiveness: 1 });
  const triggerFrames = opts.triggerFrames ?? DEFAULT_TRIGGER_FRAMES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;

  let agentSpeaking = false;
  let virtualNowMs = 0;
  // Sliding window of speech frame timestamps.
  const speechFrameStamps: number[] = [];

  const off = opts.adapter.on((event) => {
    if (event.kind === "audio_chunk") {
      agentSpeaking = true;
    } else if (
      event.kind === "transcript_final" ||
      event.kind === "interrupt" ||
      event.kind === "disconnect"
    ) {
      agentSpeaking = false;
      // Reset window so a stray pre-event frame doesn't carry over.
      speechFrameStamps.length = 0;
    }
  });

  return {
    feedAudioFrame(frame) {
      virtualNowMs += frameMs;
      const verdict = detector.detect(frame);
      if (!agentSpeaking) {
        // No audio playing → no barge-in needed. Still advance the
        // window so it doesn't accumulate stale frames.
        if (verdict === "speech") {
          speechFrameStamps.push(virtualNowMs);
        }
        // Trim window
        const cutoff = virtualNowMs - windowMs;
        while (speechFrameStamps.length > 0 && (speechFrameStamps[0] ?? cutoff) < cutoff) {
          speechFrameStamps.shift();
        }
        return verdict;
      }

      if (verdict === "speech") {
        speechFrameStamps.push(virtualNowMs);
      }
      const cutoff = virtualNowMs - windowMs;
      while (speechFrameStamps.length > 0 && (speechFrameStamps[0] ?? cutoff) < cutoff) {
        speechFrameStamps.shift();
      }

      if (speechFrameStamps.length >= triggerFrames) {
        const count = speechFrameStamps.length;
        speechFrameStamps.length = 0;
        agentSpeaking = false;
        try {
          opts.adapter.interrupt("user barged in");
        } catch {
          /* tolerate adapter disconnect mid-barge-in */
        }
        opts.onBargeIn?.({ reason: "user barged in", speechFrames: count });
      }
      return verdict;
    },
    isAgentSpeaking() {
      return agentSpeaking;
    },
    stop() {
      off();
    },
  };
}
