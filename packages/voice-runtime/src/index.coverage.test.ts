/**
 * Coverage-hardening suite for `voice-runtime`. Drives every adapter
 * branch deterministically with a scripted WebSocket stub — no real
 * sockets, no real timers, no leaked handles. Complements the contract
 * tests in `index.test.ts`; this file targets the lines those tests do
 * not reach (default WS factory, error/close handlers, sendText /
 * commitInput / interrupt, the Vapi adapter passthrough, and the
 * subscriber-isolation paths).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type RealtimeConnectOptions,
  type RealtimeEvent,
  type WebSocketFactory,
  type WebSocketLike,
  createOpenAIRealtimeAdapter,
  createVapiRealtimeAdapter,
} from "./index.js";

/**
 * Fully synchronous WebSocket stub. Listeners fire only when the test
 * calls `triggerOpen` / `triggerError` / `triggerClose` / `emit`, so
 * there is no clock and no ordering ambiguity. `readyState` starts at 0
 * (CONNECTING) and flips to 1 (OPEN) on `triggerOpen`.
 */
class StubWs implements WebSocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | undefined;
  closeThrows = false;
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  send(data: string | ArrayBuffer): void {
    if (typeof data === "string") this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    if (this.closeThrows) throw new Error("close boom");
    this.readyState = 3;
    this.closed = { code, reason };
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(handler);
    this.listeners.set(type, arr);
  }

  private fire(type: string, ev: unknown): void {
    for (const h of this.listeners.get(type) ?? []) h(ev);
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.fire("open", {});
  }

  triggerError(ev: unknown): void {
    this.fire("error", ev);
  }

  triggerClose(code?: number, reason?: string): void {
    this.readyState = 3;
    this.fire("close", { code, reason });
  }

  emit(event: Record<string, unknown>): void {
    this.fire("message", { data: JSON.stringify(event) });
  }

  emitRaw(data: unknown): void {
    this.fire("message", { data });
  }
}

/** Connect an OpenAI adapter against a fresh StubWs, opening synchronously. */
async function connectedOpenAI(
  connectOpts: RealtimeConnectOptions = { model: "m" },
): Promise<{ adapter: ReturnType<typeof createOpenAIRealtimeAdapter>; socket: StubWs }> {
  const socket = new StubWs();
  const ctor: WebSocketFactory = () => socket;
  const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: ctor });
  const cp = adapter.connect(connectOpts);
  socket.triggerOpen();
  await cp;
  socket.sent.length = 0; // discard the session.update so assertions start clean
  return { adapter, socket };
}

// ===========================================================================
// OpenAI adapter — uncovered branches
// ===========================================================================

describe("createOpenAIRealtimeAdapter — default WebSocket factory (251-256)", () => {
  const realWs = globalThis.WebSocket;
  let constructed: { url: string; init: unknown } | undefined;
  let lastSocket: StubWs | undefined;

  beforeEach(() => {
    constructed = undefined;
    lastSocket = undefined;
    // Swap the global constructor for a stub the default factory will `new`.
    // Extending StubWs means `new` yields a real StubWs instance (no constructor
    // return needed); `this` captures the recorded url/init.
    (globalThis as { WebSocket: unknown }).WebSocket = class extends StubWs {
      constructor(url: string, init?: unknown) {
        super();
        constructed = { url, init };
        lastSocket = this;
      }
    } as unknown as typeof WebSocket;
  });

  afterEach(() => {
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket = realWs;
  });

  test("uses globalThis.WebSocket when no _ws is injected", async () => {
    // No `_ws` → exercises the default factory arrow that calls `new`.
    const adapter = createOpenAIRealtimeAdapter({
      apiKey: "sk-test",
      url: "wss://example.test/rt",
    });
    const cp = adapter.connect({ model: "gpt-realtime" });
    expect(lastSocket).toBeDefined();
    lastSocket?.triggerOpen();
    await cp;
    expect(adapter.connected).toBe(true);
    expect(constructed?.url).toContain("wss://example.test/rt");
    expect(constructed?.url).toContain("model=gpt-realtime");
    // Auth is threaded through `init` — and NOTHING else. Issue #24: the
    // retired `OpenAI-Beta: realtime=v1` upgrade header selects the beta
    // wire shape, which the server now closes with code 4000.
    const init = constructed?.init as { headers?: Record<string, string> };
    expect(init.headers?.["Authorization"]).toBe("Bearer sk-test");
    expect(init.headers?.["OpenAI-Beta"]).toBeUndefined();
    expect(Object.keys(init.headers ?? {})).toEqual(["Authorization"]);
    await adapter.disconnect();
  });

  test("falls back to the GA default model when an empty model string is passed", async () => {
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test" });
    const cp = adapter.connect({ model: "" });
    lastSocket?.triggerOpen();
    await cp;
    expect(constructed?.url).toContain("model=gpt-realtime");
    // …and the same default lands in session.update, not an empty string.
    expect((lastSocket?.sent[0]?.["session"] as Record<string, unknown>)["model"]).toBe(
      "gpt-realtime",
    );
    await adapter.disconnect();
  });
});

describe("createOpenAIRealtimeAdapter — error handler (271-278)", () => {
  test("error before open rejects connect AND emits an error event", async () => {
    const socket = new StubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: () => socket });
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    const cp = adapter.connect({ model: "m" });
    socket.triggerError({ message: "handshake failed" });
    await expect(cp).rejects.toThrow(/handshake failed/);
    // The handler also emits an error event regardless of connect state.
    expect(events.some((e) => e.kind === "error" && e.message === "handshake failed")).toBe(true);
  });

  test("error with no message uses the 'websocket error' fallback", async () => {
    const socket = new StubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: () => socket });
    const cp = adapter.connect({ model: "m" });
    socket.triggerError({}); // object without `message`
    await expect(cp).rejects.toThrow(/websocket error/);
  });

  test("error AFTER connect does not reject — only emits (connected branch false)", async () => {
    const { adapter, socket } = await connectedOpenAI();
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    // Already connected: `if (!connected) reject(...)` is skipped, emit still runs.
    socket.triggerError({ message: "late blip" });
    expect(adapter.connected).toBe(true);
    expect(events).toEqual([{ kind: "error", message: "late blip" }]);
    await adapter.disconnect();
  });
});

describe("createOpenAIRealtimeAdapter — tools in session.update (317-321)", () => {
  test("maps Anthropic-style tool schemas into OpenAI function tools", async () => {
    const socket = new StubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: () => socket });
    const cp = adapter.connect({
      model: "m",
      vad: "none",
      tools: [
        {
          name: "get_weather",
          description: "Look up weather",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    socket.triggerOpen();
    await cp;
    const session = socket.sent[0]?.["session"] as Record<string, unknown>;
    const audioIn = (session["audio"] as { input?: Record<string, unknown> }).input;
    expect(audioIn?.["turn_detection"]).toBeNull(); // vad: "none"
    const tools = session["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: "function",
      name: "get_weather",
      description: "Look up weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    });
    await adapter.disconnect();
  });

  test("empty tools array is omitted from the session payload", async () => {
    const socket = new StubWs();
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: () => socket });
    const cp = adapter.connect({ model: "m", tools: [] });
    socket.triggerOpen();
    await cp;
    const session = socket.sent[0]?.["session"] as Record<string, unknown>;
    expect(session["tools"]).toBeUndefined();
    await adapter.disconnect();
  });
});

describe("createOpenAIRealtimeAdapter — commitInput (334-340)", () => {
  test("sends input_audio_buffer.commit then response.create", async () => {
    const { adapter, socket } = await connectedOpenAI();
    adapter.commitInput();
    expect(socket.sent.map((m) => m["type"])).toEqual([
      "input_audio_buffer.commit",
      "response.create",
    ]);
    await adapter.disconnect();
  });

  test("commitInput on a never-connected adapter swallows the throw", () => {
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: () => new StubWs() });
    // No connect() → send() throws → caught by the try/catch.
    expect(() => adapter.commitInput()).not.toThrow();
  });
});

describe("createOpenAIRealtimeAdapter — sendText (343-352)", () => {
  test("creates a user message item then requests a response", async () => {
    const { adapter, socket } = await connectedOpenAI();
    adapter.sendText("hello there");
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]).toEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello there" }],
      },
    });
    expect(socket.sent[1]?.["type"]).toBe("response.create");
    await adapter.disconnect();
  });

  test("sendText before connect throws (not swallowed, unlike commitInput)", () => {
    const adapter = createOpenAIRealtimeAdapter({ apiKey: "sk-test", _ws: () => new StubWs() });
    expect(() => adapter.sendText("nope")).toThrow(/not connected/);
  });
});

describe("createOpenAIRealtimeAdapter — on()/disconnect (366-379)", () => {
  test("unsubscribe stops delivery to that handler", async () => {
    const { adapter, socket } = await connectedOpenAI();
    const seen: RealtimeEvent[] = [];
    const off = adapter.on((e) => seen.push(e));
    socket.emit({ type: "response.audio_transcript.delta", delta: "a" });
    expect(seen).toHaveLength(1);
    off(); // remove the handler
    socket.emit({ type: "response.audio_transcript.delta", delta: "b" });
    expect(seen).toHaveLength(1); // no new delivery
    await adapter.disconnect();
  });

  test("disconnect closes the socket with 1000 and flips connected=false", async () => {
    const { adapter, socket } = await connectedOpenAI();
    expect(adapter.connected).toBe(true);
    await adapter.disconnect();
    expect(socket.closed).toEqual({ code: 1000, reason: "client closed" });
    expect(adapter.connected).toBe(false);
  });

  test("disconnect is idempotent (second call returns early)", async () => {
    const { adapter, socket } = await connectedOpenAI();
    await adapter.disconnect();
    socket.closed = undefined; // detect a second close() call
    await adapter.disconnect();
    expect(socket.closed).toBeUndefined(); // early return — close() not called again
  });

  test("disconnect tolerates a throwing close()", async () => {
    const { adapter, socket } = await connectedOpenAI();
    socket.closeThrows = true;
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(adapter.connected).toBe(false);
  });
});

// ===========================================================================
// Vapi adapter — uncovered branches (420-534)
// ===========================================================================

/** Connect a Vapi adapter against a fresh StubWs (readyState OPEN, sync open). */
async function connectedVapi(opts: {
  assistantId?: string;
  now?: () => Date;
  connect?: RealtimeConnectOptions;
}): Promise<{ adapter: ReturnType<typeof createVapiRealtimeAdapter>; socket: StubWs }> {
  const socket = new StubWs();
  socket.readyState = 1; // Vapi sends inside the open handler, needs OPEN already
  const adapter = createVapiRealtimeAdapter({
    apiKey: "vapi_test",
    _ws: () => socket,
    ...(opts.assistantId !== undefined ? { assistantId: opts.assistantId } : {}),
    ...(opts.now !== undefined ? { _now: opts.now } : {}),
  });
  const cp = adapter.connect(
    opts.connect ?? { model: "m", instructions: "be brief", voice: "alloy" },
  );
  socket.triggerOpen();
  await cp;
  socket.sent.length = 0;
  return { adapter, socket };
}

describe("createVapiRealtimeAdapter — default WebSocket factory (450-453)", () => {
  const realWs = globalThis.WebSocket;
  let lastSocket: StubWs | undefined;
  let lastUrl: string | undefined;

  beforeEach(() => {
    lastSocket = undefined;
    lastUrl = undefined;
    (globalThis as { WebSocket: unknown }).WebSocket = class extends StubWs {
      constructor(url: string) {
        super();
        this.readyState = 1;
        lastSocket = this;
        lastUrl = url;
      }
    } as unknown as typeof WebSocket;
  });

  afterEach(() => {
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket = realWs;
  });

  test("constructs globalThis.WebSocket at the default Vapi URL", async () => {
    const adapter = createVapiRealtimeAdapter({ apiKey: "vapi_test" });
    const cp = adapter.connect({ model: "m" });
    lastSocket?.triggerOpen();
    await cp;
    expect(adapter.connected).toBe(true);
    expect(lastUrl).toBe("wss://api.vapi.ai/v1/realtime");
    await adapter.disconnect();
  });

  test("honors a custom url override", async () => {
    const adapter = createVapiRealtimeAdapter({ apiKey: "vapi_test", url: "wss://custom.vapi/rt" });
    const cp = adapter.connect({ model: "m" });
    lastSocket?.triggerOpen();
    await cp;
    expect(lastUrl).toBe("wss://custom.vapi/rt");
    await adapter.disconnect();
  });
});

describe("createVapiRealtimeAdapter — connect rejections", () => {
  test("rejects when already disconnected", async () => {
    const socket = new StubWs();
    socket.readyState = 1;
    const adapter = createVapiRealtimeAdapter({ apiKey: "k", _ws: () => socket });
    await adapter.disconnect(); // sets disconnected=true without ever connecting
    await expect(adapter.connect({ model: "m" })).rejects.toThrow(/has been disconnected/);
  });

  test("rejects when the factory returns undefined", async () => {
    const adapter = createVapiRealtimeAdapter({
      apiKey: "k",
      _ws: () => undefined as unknown as WebSocketLike,
    });
    await expect(adapter.connect({ model: "m" })).rejects.toThrow(/ws factory returned undefined/);
  });

  test("rejects on a ws error during the handshake (473-477)", async () => {
    const socket = new StubWs();
    socket.readyState = 1;
    const adapter = createVapiRealtimeAdapter({ apiKey: "k", _ws: () => socket });
    const cp = adapter.connect({ model: "m" });
    socket.triggerError({ message: "vapi down" });
    await expect(cp).rejects.toThrow(/vapi ws error: vapi down/);
  });

  test("ws error with no message stringifies the raw event (473-477)", async () => {
    const socket = new StubWs();
    socket.readyState = 1;
    const adapter = createVapiRealtimeAdapter({ apiKey: "k", _ws: () => socket });
    const cp = adapter.connect({ model: "m" });
    socket.triggerError("plain-string-error");
    await expect(cp).rejects.toThrow(/vapi ws error: plain-string-error/);
  });
});

describe("createVapiRealtimeAdapter — session.update handshake (463-471)", () => {
  test("includes assistant_id only when provided", async () => {
    const { adapter, socket } = await connectedVapi({ assistantId: "asst_9" });
    // sent[] was cleared post-connect; re-run a fresh connect to inspect the update.
    await adapter.disconnect();
    const s2 = new StubWs();
    s2.readyState = 1;
    const a2 = createVapiRealtimeAdapter({ apiKey: "k", _ws: () => s2 });
    const cp = a2.connect({ model: "m", instructions: "hi", voice: "nova" });
    s2.triggerOpen();
    await cp;
    const session = s2.sent[0]?.["session"] as Record<string, unknown>;
    expect(session["voice"]).toBe("nova");
    expect(session["instructions"]).toBe("hi");
    expect(session["assistant_id"]).toBeUndefined(); // no assistantId on a2
    await a2.disconnect();
    expect(socket.closed).toBeDefined();
  });
});

describe("createVapiRealtimeAdapter — close handler (480-482)", () => {
  test("a server close flips connected back to false", async () => {
    const { adapter, socket } = await connectedVapi({});
    expect(adapter.connected).toBe(true);
    socket.triggerClose(1001, "going away");
    expect(adapter.connected).toBe(false);
    await adapter.disconnect();
  });
});

describe("createVapiRealtimeAdapter — message handler (483-494)", () => {
  test("emits a raw passthrough event with a fixed timestamp via _now", async () => {
    const fixed = new Date("2026-06-04T12:00:00.000Z");
    const { adapter, socket } = await connectedVapi({ now: () => fixed });
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    socket.emit({ type: "speech-update", status: "started" });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.kind).toBe("raw");
    if (ev?.kind === "raw") {
      expect(ev.provider).toBe("vapi");
      expect(ev.ts).toBe("2026-06-04T12:00:00.000Z");
      expect(ev.payload).toEqual({ type: "speech-update", status: "started" });
    }
    await adapter.disconnect();
  });

  test("default _now produces a real ISO timestamp when not injected", async () => {
    const { adapter, socket } = await connectedVapi({});
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    socket.emit({ type: "transcript", text: "hi" });
    const ev = events[0];
    expect(ev?.kind).toBe("raw");
    if (ev?.kind === "raw") {
      // ISO-8601 shape; value is real-clock but format is deterministic.
      expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    await adapter.disconnect();
  });

  test("frames without a string type are ignored", async () => {
    const { adapter, socket } = await connectedVapi({});
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    socket.emit({ noType: true }); // valid JSON, but type is not a string
    expect(events).toHaveLength(0);
    await adapter.disconnect();
  });

  test("malformed (non-JSON) frames are swallowed", async () => {
    const { adapter, socket } = await connectedVapi({});
    const events: RealtimeEvent[] = [];
    adapter.on((e) => events.push(e));
    expect(() => socket.emitRaw("{not json")).not.toThrow();
    expect(events).toHaveLength(0);
    // Missing data → defaults to "" → JSON.parse throws → swallowed.
    expect(() => socket.emitRaw(undefined)).not.toThrow();
    expect(events).toHaveLength(0);
    await adapter.disconnect();
  });
});

describe("createVapiRealtimeAdapter — emit isolates throwing subscribers (420-426)", () => {
  test("a handler that throws does not break sibling handlers", async () => {
    const { adapter, socket } = await connectedVapi({});
    const good: RealtimeEvent[] = [];
    adapter.on(() => {
      throw new Error("subscriber blew up");
    });
    adapter.on((e) => good.push(e));
    expect(() => socket.emit({ type: "any" })).not.toThrow();
    expect(good).toHaveLength(1); // the well-behaved subscriber still received it
    await adapter.disconnect();
  });
});

describe("createVapiRealtimeAdapter — send path methods (501-518)", () => {
  test("sendAudio base64-encodes the PCM frame", async () => {
    const { adapter, socket } = await connectedVapi({});
    const pcm = new Int16Array([1, 2, 3, 4]);
    adapter.sendAudio(pcm);
    expect(socket.sent[0]?.["type"]).toBe("input_audio_buffer.append");
    const audio = socket.sent[0]?.["audio"] as string;
    // Decode and confirm the bytes round-trip (little-endian int16).
    const back = new Int16Array(Buffer.from(audio, "base64").buffer.slice(0));
    expect(Array.from(back)).toEqual([1, 2, 3, 4]);
    await adapter.disconnect();
  });

  test("sendAudio respects a non-zero byteOffset view", async () => {
    const { adapter, socket } = await connectedVapi({});
    const backing = new Int16Array([9, 8, 7, 6]);
    const view = backing.subarray(1, 3); // [8, 7], offset != 0
    adapter.sendAudio(view);
    const audio = socket.sent[0]?.["audio"] as string;
    const bytes = Buffer.from(audio, "base64");
    expect(bytes.byteLength).toBe(4); // 2 samples * 2 bytes
    const back = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 4));
    expect(Array.from(back)).toEqual([8, 7]);
    await adapter.disconnect();
  });

  test("commitInput sends a single input_audio_buffer.commit", async () => {
    const { adapter, socket } = await connectedVapi({});
    adapter.commitInput();
    expect(socket.sent).toEqual([{ type: "input_audio_buffer.commit" }]);
    await adapter.disconnect();
  });

  test("sendText sends response.create with the text input", async () => {
    const { adapter, socket } = await connectedVapi({});
    adapter.sendText("say hi");
    expect(socket.sent[0]).toEqual({
      type: "response.create",
      response: { modalities: ["text", "audio"], input: "say hi" },
    });
    await adapter.disconnect();
  });

  test("interrupt sends response.cancel when connected", async () => {
    const { adapter, socket } = await connectedVapi({});
    adapter.interrupt("barge-in");
    expect(socket.sent[0]?.["type"]).toBe("response.cancel");
    await adapter.disconnect();
  });

  test("interrupt swallows the throw when the socket is closed", async () => {
    const { adapter, socket } = await connectedVapi({});
    socket.readyState = 3; // not OPEN → send() throws
    expect(() => adapter.interrupt("barge-in")).not.toThrow();
    await adapter.disconnect();
  });
});

describe("createVapiRealtimeAdapter — on()/disconnect (519-536)", () => {
  test("unsubscribe removes the handler", async () => {
    const { adapter, socket } = await connectedVapi({});
    const seen: RealtimeEvent[] = [];
    const off = adapter.on((e) => seen.push(e));
    socket.emit({ type: "a" });
    expect(seen).toHaveLength(1);
    off();
    socket.emit({ type: "b" });
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("disconnect closes the socket and clears state", async () => {
    const { adapter, socket } = await connectedVapi({});
    await adapter.disconnect();
    expect(socket.closed).toEqual({ code: undefined, reason: undefined });
    expect(adapter.connected).toBe(false);
  });

  test("disconnect tolerates a throwing close() and still clears state", async () => {
    const { adapter, socket } = await connectedVapi({});
    socket.closeThrows = true;
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(adapter.connected).toBe(false);
    // A second disconnect with no ws is a no-op (ws === undefined branch).
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });
});
