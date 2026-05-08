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
});
