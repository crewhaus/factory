import { describe, expect, test } from "bun:test";
import type { RealtimeAdapter, RealtimeEvent, RealtimeEventHandler } from "@crewhaus/voice-runtime";
import { createBargeInController } from "./index.js";

/**
 * Stub adapter that exposes the event-bus + records interrupt() calls.
 */
function makeStubAdapter(): {
  adapter: RealtimeAdapter;
  fire(event: RealtimeEvent): void;
  interrupts: string[];
} {
  const handlers = new Set<RealtimeEventHandler>();
  const interrupts: string[] = [];
  const adapter: RealtimeAdapter = {
    providerId: "openai",
    sampleRate: 24_000,
    get connected() {
      return true;
    },
    async connect() {},
    sendAudio() {},
    sendText() {},
    interrupt(reason) {
      interrupts.push(reason);
      // Mimic the real adapter: emit a synthetic interrupt event.
      for (const h of handlers) h({ kind: "interrupt", reason });
    },
    on(h) {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },
    async disconnect() {},
  };
  return {
    adapter,
    fire: (event) => {
      for (const h of handlers) h(event);
    },
    interrupts,
  };
}

function speechFrame(): Int16Array {
  // Energy + ZCR sufficient to trigger speech verdict at aggressiveness 1.
  const out = new Int16Array(720);
  for (let i = 0; i < 720; i++) {
    const sig =
      0.7 * Math.sin((2 * Math.PI * 500 * i) / 24_000) +
      0.3 * Math.sin((2 * Math.PI * 1500 * i) / 24_000);
    out[i] = Math.round(sig * 8000);
  }
  return out;
}

function silentFrame(): Int16Array {
  return new Int16Array(720);
}

describe("createBargeInController", () => {
  test("does NOT interrupt when the agent is idle (T1)", () => {
    const { adapter, interrupts } = makeStubAdapter();
    const ctrl = createBargeInController({ adapter });
    for (let i = 0; i < 10; i++) ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(0);
    ctrl.stop();
  });

  test("does NOT interrupt on a single speech frame (hysteresis)", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const ctrl = createBargeInController({ adapter, triggerFrames: 4 });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    ctrl.feedAudioFrame(speechFrame());
    ctrl.feedAudioFrame(silentFrame());
    expect(interrupts).toHaveLength(0);
    ctrl.stop();
  });

  test("interrupts after triggerFrames consecutive speech frames during agent playback (T3)", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const onBargeIn: { hits: number } = { hits: 0 };
    const ctrl = createBargeInController({
      adapter,
      triggerFrames: 4,
      windowMs: 200,
      frameMs: 30,
      onBargeIn: () => {
        onBargeIn.hits += 1;
      },
    });
    // Mark agent speaking.
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    expect(ctrl.isAgentSpeaking()).toBe(true);

    for (let i = 0; i < 4; i++) ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]).toBe("user barged in");
    expect(onBargeIn.hits).toBe(1);
    expect(ctrl.isAgentSpeaking()).toBe(false);
    ctrl.stop();
  });

  test("idle agent → speech doesn't trigger interrupt", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const ctrl = createBargeInController({ adapter, triggerFrames: 2, windowMs: 200, frameMs: 30 });
    // Without an audio_chunk event, agent stays idle.
    for (let i = 0; i < 10; i++) ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(0);
    // Now mark agent idle->speaking and feed speech: SHOULD trigger.
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    ctrl.feedAudioFrame(speechFrame());
    ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(1);
    ctrl.stop();
  });

  test("transcript_final marks agent idle and resets the speech-frame window", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const ctrl = createBargeInController({ adapter, triggerFrames: 4, windowMs: 200, frameMs: 30 });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    ctrl.feedAudioFrame(speechFrame());
    ctrl.feedAudioFrame(speechFrame());
    fire({ kind: "transcript_final", text: "..." });
    expect(ctrl.isAgentSpeaking()).toBe(false);
    // Now agent idle: 2 more speech frames shouldn't trigger.
    ctrl.feedAudioFrame(speechFrame());
    ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(0);
    ctrl.stop();
  });

  test("disconnect marks agent idle and resets the speech-frame window", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const ctrl = createBargeInController({ adapter, triggerFrames: 4, windowMs: 200, frameMs: 30 });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    ctrl.feedAudioFrame(speechFrame());
    ctrl.feedAudioFrame(speechFrame());
    fire({ kind: "disconnect", code: 1000, reason: "bye" });
    expect(ctrl.isAgentSpeaking()).toBe(false);
    // Window was reset on disconnect: 2 more frames (had agent stayed speaking)
    // would have hit triggerFrames=4, but the agent is idle so nothing fires.
    ctrl.feedAudioFrame(speechFrame());
    ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(0);
    ctrl.stop();
  });

  test("returns the raw VAD verdict for diagnostics (speech + silence)", () => {
    const { adapter, fire } = makeStubAdapter();
    const ctrl = createBargeInController({
      adapter,
      triggerFrames: 99,
      windowMs: 200,
      frameMs: 30,
    });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    // Agent is speaking; a silent frame must not be counted as speech, and the
    // verdict is surfaced verbatim.
    expect(ctrl.feedAudioFrame(silentFrame())).toBe("silence");
    expect(ctrl.feedAudioFrame(speechFrame())).toBe("speech");
    ctrl.stop();
  });

  test("does NOT interrupt when speech frames age out of the sliding window", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    // windowMs (60) only holds ~2 frames at frameMs 30, so a steady stream of
    // speech never accumulates the 4 required *within the window*.
    const ctrl = createBargeInController({ adapter, triggerFrames: 4, windowMs: 60, frameMs: 30 });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    for (let i = 0; i < 20; i++) {
      expect(ctrl.feedAudioFrame(speechFrame())).toBe("speech");
    }
    expect(interrupts).toHaveLength(0);
    expect(ctrl.isAgentSpeaking()).toBe(true);
    ctrl.stop();
  });

  test("idle agent: speech frames also age out of the window (no stale carry-over)", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const ctrl = createBargeInController({ adapter, triggerFrames: 4, windowMs: 60, frameMs: 30 });
    // Agent idle: feed a long stream of speech. The window trims as it grows so
    // it never accumulates, then a later audio_chunk + brief speech is still
    // governed solely by the in-window count.
    for (let i = 0; i < 20; i++) ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(0);
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(0);
    ctrl.stop();
  });

  test("fires onBargeIn with the in-window speech-frame count", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const seen: Array<{ reason: string; speechFrames: number }> = [];
    const ctrl = createBargeInController({
      adapter,
      triggerFrames: 4,
      windowMs: 200,
      frameMs: 30,
      onBargeIn: (info) => seen.push(info),
    });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    for (let i = 0; i < 4; i++) ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toEqual(["user barged in"]);
    expect(seen).toEqual([{ reason: "user barged in", speechFrames: 4 }]);
    ctrl.stop();
  });

  test("interrupts even when no onBargeIn callback is supplied", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const ctrl = createBargeInController({ adapter, triggerFrames: 2, windowMs: 200, frameMs: 30 });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    ctrl.feedAudioFrame(speechFrame());
    ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toEqual(["user barged in"]);
    ctrl.stop();
  });

  test("tolerates an adapter whose interrupt() throws mid-barge-in", () => {
    // Custom adapter: interrupt() throws (e.g. socket already closed). The
    // controller must swallow it, still mark the agent idle, and still fire
    // the onBargeIn observer.
    const handlers = new Set<RealtimeEventHandler>();
    let interruptCalls = 0;
    const adapter: RealtimeAdapter = {
      providerId: "openai",
      sampleRate: 24_000,
      get connected() {
        return true;
      },
      async connect() {},
      sendAudio() {},
      sendText() {},
      interrupt() {
        interruptCalls += 1;
        throw new Error("socket closed");
      },
      on(h) {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
      async disconnect() {},
    };
    const fire = (event: RealtimeEvent): void => {
      for (const h of handlers) h(event);
    };
    let info: { reason: string; speechFrames: number } | undefined;
    const ctrl = createBargeInController({
      adapter,
      triggerFrames: 4,
      onBargeIn: (i) => {
        info = i;
      },
    });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    expect(() => {
      for (let i = 0; i < 4; i++) ctrl.feedAudioFrame(speechFrame());
    }).not.toThrow();
    expect(interruptCalls).toBe(1);
    expect(info).toEqual({ reason: "user barged in", speechFrames: 4 });
    expect(ctrl.isAgentSpeaking()).toBe(false);
    ctrl.stop();
  });

  test("uses an injected detector instead of the default", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    let detectCalls = 0;
    // Deterministic detector that always classifies frames as speech.
    const detector = {
      aggressiveness: 2 as const,
      detect(): "speech" | "silence" | "transitioning" {
        detectCalls += 1;
        return "speech";
      },
    };
    const ctrl = createBargeInController({ adapter, detector, triggerFrames: 2 });
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    // Even silent frames count as speech because the injected detector says so.
    expect(ctrl.feedAudioFrame(silentFrame())).toBe("speech");
    expect(ctrl.feedAudioFrame(silentFrame())).toBe("speech");
    expect(detectCalls).toBe(2);
    expect(interrupts).toEqual(["user barged in"]);
    ctrl.stop();
  });

  test("stop() detaches the adapter listener (later events are ignored)", () => {
    const { adapter, fire, interrupts } = makeStubAdapter();
    const ctrl = createBargeInController({ adapter, triggerFrames: 2 });
    ctrl.stop();
    // After stop(), an audio_chunk must not flip the agent to speaking, so a
    // subsequent speech burst cannot barge in.
    fire({ kind: "audio_chunk", pcm: new Int16Array(0), sampleRate: 24_000 });
    expect(ctrl.isAgentSpeaking()).toBe(false);
    ctrl.feedAudioFrame(speechFrame());
    ctrl.feedAudioFrame(speechFrame());
    expect(interrupts).toHaveLength(0);
  });
});
