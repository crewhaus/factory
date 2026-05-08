import { describe, expect, test } from "bun:test";
import {
  type RealtimeEvent,
  type WebSocketFactory,
  type WebSocketLike,
  createOpenAIRealtimeAdapter,
  createRealtimeAdapter,
  createVapiRealtimeAdapter,
  decodePcm16Base64,
  encodePcm16Base64,
} from "./index.js";

/**
 * Scripted WebSocket stub. Exposes `mockServerEmit({type, ...})` for
 * tests to drive incoming events, and `lastSent` to assert outbound
 * messages.
 */
function makeStubWs(): {
  ctor: WebSocketFactory;
  socket: WebSocketLike & {
    mockServerEmit(event: Record<string, unknown>): void;
    lastSent: Record<string, unknown>[];
    triggerOpen(): void;
    triggerClose(code?: number, reason?: string): void;
  };
} {
  const lastSent: Record<string, unknown>[] = [];
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const socket = {
    readyState: 0,
    send(data: string | ArrayBuffer): void {
      if (typeof data === "string") {
        lastSent.push(JSON.parse(data));
      }
    },
    close(code?: number, reason?: string): void {
      this.readyState = 3;
      const handlers = listeners.get("close") ?? [];
      for (const h of handlers) h({ code, reason });
    },
    addEventListener(type: string, handler: (ev: unknown) => void): void {
      const arr = listeners.get(type) ?? [];
      arr.push(handler);
      listeners.set(type, arr);
    },
    mockServerEmit(event: Record<string, unknown>): void {
      const handlers = listeners.get("message") ?? [];
      for (const h of handlers) h({ data: JSON.stringify(event) });
    },
    lastSent,
    triggerOpen(): void {
      this.readyState = 1;
      const handlers = listeners.get("open") ?? [];
      for (const h of handlers) h({});
    },
    triggerClose(code?: number, reason?: string): void {
      this.readyState = 3;
      const handlers = listeners.get("close") ?? [];
      for (const h of handlers) h({ code, reason });
    },
  };
  const ctor: WebSocketFactory = () => socket;
  return { ctor, socket };
}

describe("createOpenAIRealtimeAdapter — connect + protocol contract (T2)", () => {
  test("connect() sends a session.update after the WebSocket opens", async () => {
    const { ctor, socket } = makeStubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: ctor });
    const connectPromise = adapter.connect({
      model: "gpt-4o-realtime-preview",
      instructions: "be brief",
      voice: "alloy",
      vad: "server",
    });
    socket.triggerOpen();
    await connectPromise;
    expect(adapter.connected).toBe(true);
    expect(socket.lastSent[0]).toBeDefined();
    const sessionUpdate = socket.lastSent[0];
    if (sessionUpdate === undefined) throw new Error("missing session.update");
    expect(sessionUpdate["type"]).toBe("session.update");
    const session = sessionUpdate["session"] as Record<string, unknown>;
    expect(session["instructions"]).toBe("be brief");
    expect(session["voice"]).toBe("alloy");
    expect(session["input_audio_format"]).toBe("pcm16");
    expect(session["output_audio_format"]).toBe("pcm16");
    expect((session["turn_detection"] as { type?: string })["type"]).toBe("server_vad");
  });

  test("sendAudio packs Int16Array as base64 and emits input_audio_buffer.append", async () => {
    const { ctor, socket } = makeStubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: ctor });
    const cp = adapter.connect({ model: "m" });
    socket.triggerOpen();
    await cp;
    socket.lastSent.length = 0;

    const pcm = new Int16Array([0, 1024, -1024]);
    adapter.sendAudio(pcm);
    expect(socket.lastSent[0]?.["type"]).toBe("input_audio_buffer.append");
    const audio = socket.lastSent[0]?.["audio"] as string;
    expect(typeof audio).toBe("string");
    const decoded = decodePcm16Base64(audio);
    expect(decoded[0]).toBe(0);
    expect(decoded[1]).toBe(1024);
    expect(decoded[2]).toBe(-1024);
  });

  test("server response.audio_transcript.delta → transcript_partial event", async () => {
    const { ctor, socket } = makeStubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: ctor });
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    const cp = adapter.connect({ model: "m" });
    socket.triggerOpen();
    await cp;

    socket.mockServerEmit({
      type: "response.audio_transcript.delta",
      delta: "Hello",
      item_id: "item_1",
    });
    socket.mockServerEmit({
      type: "response.audio_transcript.delta",
      delta: " world",
      item_id: "item_1",
    });
    socket.mockServerEmit({
      type: "response.audio_transcript.done",
      transcript: "Hello world",
      item_id: "item_1",
    });

    const partials = events.filter((e) => e.kind === "transcript_partial");
    expect(partials.map((e) => (e.kind === "transcript_partial" ? e.text : ""))).toEqual([
      "Hello",
      " world",
    ]);
    const final = events.find((e) => e.kind === "transcript_final");
    expect(final).toBeDefined();
    if (final?.kind === "transcript_final") {
      expect(final.text).toBe("Hello world");
    }
  });

  test("server response.audio.delta → audio_chunk event with PCM Int16Array", async () => {
    const { ctor, socket } = makeStubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: ctor });
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    const cp = adapter.connect({ model: "m" });
    socket.triggerOpen();
    await cp;

    const pcm = new Int16Array([100, 200, 300]);
    socket.mockServerEmit({
      type: "response.audio.delta",
      delta: encodePcm16Base64(pcm),
    });

    const audio = events.find((e) => e.kind === "audio_chunk");
    expect(audio).toBeDefined();
    if (audio?.kind === "audio_chunk") {
      expect(audio.sampleRate).toBe(24_000);
      expect(audio.pcm[0]).toBe(100);
      expect(audio.pcm[1]).toBe(200);
      expect(audio.pcm[2]).toBe(300);
    }
  });

  test("interrupt() sends response.cancel and emits interrupt event", async () => {
    const { ctor, socket } = makeStubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: ctor });
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    const cp = adapter.connect({ model: "m" });
    socket.triggerOpen();
    await cp;
    socket.lastSent.length = 0;

    adapter.interrupt("user spoke");
    expect(socket.lastSent[0]?.["type"]).toBe("response.cancel");
    expect(events.some((e) => e.kind === "interrupt")).toBe(true);
  });

  test("close from server → disconnect event", async () => {
    const { ctor, socket } = makeStubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: ctor });
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    const cp = adapter.connect({ model: "m" });
    socket.triggerOpen();
    await cp;

    socket.triggerClose(1000, "ok");
    expect(events.some((e) => e.kind === "disconnect")).toBe(true);
  });

  test("missing API key throws on connect", async () => {
    const { ctor } = makeStubWs();
    const saved = process.env["OPENAI_API_KEY"];
    (process.env as Record<string, string | undefined>)["OPENAI_API_KEY"] = undefined;
    try {
      const adapter = createOpenAIRealtimeAdapter({ _ws: ctor });
      await expect(adapter.connect({ model: "m" })).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) {
        (process.env as Record<string, string | undefined>)["OPENAI_API_KEY"] = saved;
      }
    }
  });
});

describe("createRealtimeAdapter dispatch", () => {
  test("openai → openai adapter", () => {
    const a = createRealtimeAdapter("openai", { apiKey: "sk-test" });
    expect(a.providerId).toBe("openai");
  });

  test("vapi → vapi stub adapter", () => {
    const a = createRealtimeAdapter("vapi", { apiKey: "test" });
    expect(a.providerId).toBe("vapi");
  });

  test("unknown provider throws", () => {
    expect(() => createRealtimeAdapter("unknown" as unknown as "openai", { apiKey: "x" })).toThrow(
      /unknown realtime provider/,
    );
  });
});

describe("createVapiRealtimeAdapter", () => {
  test("connect throws a clean diagnostic in v0", async () => {
    const adapter = createVapiRealtimeAdapter({ apiKey: "vapi_test" });
    await expect(adapter.connect({ model: "m" })).rejects.toThrow(/not implemented in v0/);
  });
});

describe("encodePcm16Base64 / decodePcm16Base64", () => {
  test("round-trips an Int16Array of mixed values", () => {
    const samples = new Int16Array([-32768, -1, 0, 1, 32767, 1234, -5678]);
    const b64 = encodePcm16Base64(samples);
    const decoded = decodePcm16Base64(b64);
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });

  test("handles a 30ms-frame-sized buffer (720 samples at 24kHz)", () => {
    const samples = new Int16Array(720);
    for (let i = 0; i < samples.length; i++) samples[i] = (i * 37) & 0xffff;
    const decoded = decodePcm16Base64(encodePcm16Base64(samples));
    expect(decoded.length).toBe(720);
    expect(decoded[0]).toBe(samples[0]);
    expect(decoded[719]).toBe(samples[719]);
  });
});
