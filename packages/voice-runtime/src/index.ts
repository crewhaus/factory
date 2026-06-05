/**
 * Catalog R16 `voice-runtime` — Section 24 VOICE.
 *
 * Provider-agnostic realtime audio adapter. The user-facing surface is
 * a small interface — `RealtimeAdapter` — with one concrete adapter in
 * v0 (`createOpenAIRealtimeAdapter`) and a Vapi stub that lazy-loads.
 *
 * Audio framing: every adapter normalises to 16-bit signed-int PCM at
 * 24kHz mono. The OpenAI adapter speaks this format natively; the Vapi
 * adapter (when implemented) will resample its native Opus stream
 * through a server-side helper. Frames are passed as `Int16Array` so
 * downstream consumers (vad-engine) don't have to re-decode bytes.
 *
 * Event surface:
 *   - `transcript_partial { text }` — incremental transcript chunks
 *   - `transcript_final   { text }` — when the user's utterance ends
 *   - `audio_chunk        { pcm }`  — agent's TTS audio (pcm16 24kHz)
 *   - `tool_use           { id, name, input }` — agent function calls
 *   - `interrupt          { reason }` — emitted on barge-in
 *   - `disconnect         { code?, reason? }` — final
 *
 * The OpenAI adapter is HEADLESS — no microphone, no speakers. The
 * caller pumps PCM in via `sendAudio(pcm)`; the adapter emits audio +
 * transcript events back. This keeps the runtime usable in three
 * deployment modes:
 *   1. Browser → daemon over WebRTC (browser has the mic/speaker).
 *   2. SIP gateway → daemon (telephony provides PCM).
 *   3. Node-only smoke (synthesize PCM in TS, pipe in, assert events).
 */
import { CrewhausError } from "@crewhaus/errors";

export class VoiceRuntimeError extends CrewhausError {
  override readonly name = "VoiceRuntimeError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export type ProviderId = "openai" | "vapi";

export type RealtimeEvent =
  | { kind: "session_created"; sessionId: string }
  | { kind: "transcript_partial"; text: string; itemId?: string }
  | { kind: "transcript_final"; text: string; itemId?: string }
  | { kind: "audio_chunk"; pcm: Int16Array; sampleRate: number }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "interrupt"; reason: string }
  | { kind: "disconnect"; code?: number; reason?: string }
  | { kind: "error"; message: string; cause?: unknown }
  /** Raw provider frame, surfaced verbatim (Vapi adapter passthrough). */
  | { kind: "raw"; provider: ProviderId; ts: string; payload: unknown };

export type RealtimeEventHandler = (event: RealtimeEvent) => void;

export type RealtimeConnectOptions = {
  readonly model: string;
  readonly instructions?: string;
  readonly voice?: string;
  /** Tools (Anthropic-style schemas) the model may call mid-conversation. */
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }>;
  /** Server-side VAD vs none. v0 defaults to "server" (OpenAI's built-in). */
  readonly vad?: "server" | "none";
  /** Max response audio length in seconds. */
  readonly maxResponseSeconds?: number;
};

export interface RealtimeAdapter {
  readonly providerId: ProviderId;
  readonly sampleRate: number;
  /** True after `connect()` resolves and before `disconnect()` is called. */
  readonly connected: boolean;
  connect(opts: RealtimeConnectOptions): Promise<void>;
  /** Push PCM 16-bit signed mono frames at the adapter's sample rate. */
  sendAudio(pcm: Int16Array): void;
  /**
   * Tell the server "this is the end of the user's utterance — process it
   * now". Used by callers that bypass server-side VAD (or when server VAD
   * timing is too slow for a one-shot smoke). Idempotent.
   */
  commitInput(): void;
  /** Inject a text turn (no audio). Useful for tests + chat-only mixed mode. */
  sendText(text: string): void;
  /** Cancel the in-flight response. Used by `barge-in-controller`. */
  interrupt(reason: string): void;
  on(handler: RealtimeEventHandler): () => void;
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// OpenAI Realtime adapter — speaks the v1 WebSocket protocol.
// ---------------------------------------------------------------------------

const OPENAI_REALTIME_SAMPLE_RATE = 24_000;
const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview";
const DEFAULT_OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

/** Test injection: a factory that returns a WebSocket-like (skips `new`). */
export type WebSocketFactory = (
  url: string,
  init?: { headers?: Record<string, string> },
) => WebSocketLike;

export type WebSocketLike = {
  readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "message" | "error",
    handler: (ev: unknown) => void,
  ): void;
};

export type CreateOpenAIRealtimeAdapterOptions = {
  readonly apiKey?: string;
  readonly url?: string;
  /** Override the URL→WebSocket factory; tests pass a stub. Default uses globalThis.WebSocket. */
  readonly _ws?: WebSocketFactory;
  readonly _now?: () => Date;
};

export function createOpenAIRealtimeAdapter(
  opts: CreateOpenAIRealtimeAdapterOptions = {},
): RealtimeAdapter {
  let ws: WebSocketLike | undefined;
  let connected = false;
  let disconnected = false;
  const handlers = new Set<RealtimeEventHandler>();

  function emit(event: RealtimeEvent): void {
    for (const h of handlers) {
      try {
        h(event);
      } catch {
        /* subscribers must not crash the adapter */
      }
    }
  }

  function send(message: Record<string, unknown>): void {
    if (ws === undefined || ws.readyState !== 1 /* OPEN */) {
      throw new VoiceRuntimeError("adapter is not connected (or socket is not open)");
    }
    ws.send(JSON.stringify(message));
  }

  function handleServerEvent(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const ev = raw as { type?: string; [k: string]: unknown };
    switch (ev.type) {
      case "session.created": {
        const sess = ev["session"] as { id?: string } | undefined;
        emit({ kind: "session_created", sessionId: sess?.id ?? "(unknown)" });
        break;
      }
      case "response.created": {
        // No-op for now; reserved for future response-id tracking when
        // response.cancel needs the most recent response_id.
        break;
      }
      case "response.audio_transcript.delta": {
        const delta = ev["delta"];
        const itemId = ev["item_id"];
        if (typeof delta === "string") {
          emit({
            kind: "transcript_partial",
            text: delta,
            ...(typeof itemId === "string" ? { itemId } : {}),
          });
        }
        break;
      }
      case "response.audio_transcript.done": {
        const transcript = ev["transcript"];
        const itemId = ev["item_id"];
        if (typeof transcript === "string") {
          emit({
            kind: "transcript_final",
            text: transcript,
            ...(typeof itemId === "string" ? { itemId } : {}),
          });
        }
        break;
      }
      case "response.audio.delta": {
        const b64 = ev["delta"];
        if (typeof b64 === "string") {
          const pcm = decodePcm16Base64(b64);
          emit({ kind: "audio_chunk", pcm, sampleRate: OPENAI_REALTIME_SAMPLE_RATE });
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const id = ev["call_id"];
        const name = ev["name"];
        const argsStr = ev["arguments"];
        let parsed: unknown = {};
        if (typeof argsStr === "string") {
          try {
            parsed = JSON.parse(argsStr);
          } catch {
            parsed = argsStr;
          }
        }
        emit({
          kind: "tool_use",
          id: typeof id === "string" ? id : `call_${Date.now()}`,
          name: typeof name === "string" ? name : "(unknown)",
          input: parsed,
        });
        break;
      }
      case "response.cancelled":
      case "response.cancel":
        emit({ kind: "interrupt", reason: "response cancelled" });
        break;
      case "error": {
        const errObj = ev["error"] as { message?: string } | undefined;
        emit({ kind: "error", message: errObj?.message ?? "unknown error" });
        break;
      }
      default:
        // unknown event — ignore for forward compat
        break;
    }
  }

  return {
    providerId: "openai",
    sampleRate: OPENAI_REALTIME_SAMPLE_RATE,

    get connected() {
      return connected && !disconnected;
    },

    async connect(connectOpts) {
      if (connected) {
        throw new VoiceRuntimeError("already connected");
      }
      const apiKey = opts.apiKey ?? process.env["OPENAI_API_KEY"];
      if (!apiKey) {
        throw new VoiceRuntimeError(
          "OpenAI Realtime adapter: OPENAI_API_KEY is not set (pass `apiKey` or env)",
        );
      }
      const baseUrl = opts.url ?? DEFAULT_OPENAI_REALTIME_URL;
      const url = `${baseUrl}?model=${encodeURIComponent(connectOpts.model || DEFAULT_OPENAI_REALTIME_MODEL)}`;
      const factory: WebSocketFactory =
        opts._ws ??
        ((u, init) =>
          new (
            globalThis.WebSocket as unknown as new (
              url: string,
              protocolsOrInit?: string | string[] | { headers?: Record<string, string> },
            ) => WebSocketLike
          )(u, init));
      ws = factory(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      const socket = ws;
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          connected = true;
          resolve();
        };
        const onError = (ev: unknown): void => {
          const message =
            ev && typeof ev === "object" && "message" in ev
              ? String((ev as { message: unknown }).message)
              : "websocket error";
          if (!connected) reject(new VoiceRuntimeError(`OpenAI Realtime: ${message}`));
          emit({ kind: "error", message });
        };
        const onClose = (ev: unknown): void => {
          const close = ev as { code?: number; reason?: string };
          disconnected = true;
          emit({
            kind: "disconnect",
            ...(typeof close.code === "number" ? { code: close.code } : {}),
            ...(typeof close.reason === "string" ? { reason: close.reason } : {}),
          });
        };
        const onMessage = (ev: unknown): void => {
          const data = (ev as { data?: unknown }).data;
          if (typeof data !== "string") return;
          try {
            handleServerEvent(JSON.parse(data));
          } catch (err) {
            emit({ kind: "error", message: `server event parse: ${(err as Error).message}` });
          }
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
        socket.addEventListener("message", onMessage);
      });

      // Configure session.
      send({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          ...(connectOpts.instructions !== undefined
            ? { instructions: connectOpts.instructions }
            : {}),
          ...(connectOpts.voice !== undefined ? { voice: connectOpts.voice } : {}),
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: connectOpts.vad === "none" ? null : { type: "server_vad" },
          ...(connectOpts.tools !== undefined && connectOpts.tools.length > 0
            ? {
                tools: connectOpts.tools.map((t) => ({
                  type: "function",
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                })),
              }
            : {}),
        },
      });
    },

    sendAudio(pcm) {
      const b64 = encodePcm16Base64(pcm);
      send({ type: "input_audio_buffer.append", audio: b64 });
    },

    commitInput() {
      try {
        send({ type: "input_audio_buffer.commit" });
        send({ type: "response.create" });
      } catch {
        /* tolerate not-connected */
      }
    },

    sendText(text) {
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
      send({ type: "response.create" });
    },

    interrupt(reason) {
      try {
        send({ type: "response.cancel" });
      } catch {
        /* tolerate cancel-not-supported edge cases */
      }
      emit({ kind: "interrupt", reason });
    },

    on(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    async disconnect() {
      if (disconnected) return;
      disconnected = true;
      try {
        ws?.close(1000, "client closed");
      } catch {
        /* tolerate */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Vapi adapter — stub that lazy-loads. Throws a clean diagnostic when invoked
// without a VAPI_API_KEY or before the package is implemented.
// ---------------------------------------------------------------------------

export type CreateVapiRealtimeAdapterOptions = {
  readonly apiKey?: string;
  readonly assistantId?: string;
  /** Test injection — same shape as OpenAI's. */
  readonly _ws?: WebSocketFactory;
  readonly _now?: () => Date;
  /** Override the WebSocket URL. Default: `wss://api.vapi.ai/v1/realtime`. */
  readonly url?: string;
};

const DEFAULT_VAPI_REALTIME_URL = "wss://api.vapi.ai/v1/realtime";

/**
 * Section 30 — Vapi realtime adapter. Maps to the same `RealtimeAdapter`
 * interface as OpenAI Realtime so callers can swap providers via spec
 * config. The connect handshake takes an `assistantId` (Vapi's preset)
 * plus the same instructions/voice/temperature knobs the OpenAI path
 * supports.
 *
 * Without `VAPI_API_KEY` set or an `_ws` injection, `connect()` throws
 * with a clear message — production deployments enable this when the
 * env var is present.
 */
export function createVapiRealtimeAdapter(
  opts: CreateVapiRealtimeAdapterOptions = {},
): RealtimeAdapter {
  const apiKey = opts.apiKey ?? process.env["VAPI_API_KEY"];
  let ws: WebSocketLike | undefined;
  let connected = false;
  let disconnected = false;
  const handlers = new Set<RealtimeEventHandler>();

  function emit(event: RealtimeEvent): void {
    for (const h of handlers) {
      try {
        h(event);
      } catch {
        /* subscribers must not crash the adapter */
      }
    }
  }

  function send(message: Record<string, unknown>): void {
    if (ws === undefined || ws.readyState !== 1) {
      throw new VoiceRuntimeError("vapi adapter is not connected (or socket is not open)");
    }
    ws.send(JSON.stringify(message));
  }

  return {
    providerId: "vapi",
    sampleRate: OPENAI_REALTIME_SAMPLE_RATE,
    get connected() {
      return connected;
    },
    async connect(connectOpts: RealtimeConnectOptions): Promise<void> {
      if (!apiKey) {
        throw new VoiceRuntimeError("voice-runtime: vapi adapter requires VAPI_API_KEY");
      }
      if (disconnected) throw new VoiceRuntimeError("vapi adapter has been disconnected");
      const wsFactory =
        opts._ws ??
        (((url: string, init: { headers?: Record<string, string> }) =>
          new (
            globalThis as { WebSocket: new (u: string, init?: unknown) => WebSocketLike }
          ).WebSocket(url, init) as unknown as WebSocketLike) as WebSocketFactory);
      const url = opts.url ?? DEFAULT_VAPI_REALTIME_URL;
      ws = wsFactory(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      await new Promise<void>((resolve, reject) => {
        if (!ws) return reject(new VoiceRuntimeError("ws factory returned undefined"));
        ws.addEventListener("open", () => {
          connected = true;
          // Vapi configuration handshake.
          send({
            type: "session.update",
            session: {
              voice: connectOpts.voice,
              instructions: connectOpts.instructions,
              ...(opts.assistantId !== undefined ? { assistant_id: opts.assistantId } : {}),
            },
          });
          resolve();
        });
        ws.addEventListener("error", (ev) => {
          reject(
            new VoiceRuntimeError(
              `vapi ws error: ${String((ev as { message?: string })?.message ?? ev)}`,
            ),
          );
        });
        ws.addEventListener("close", () => {
          connected = false;
        });
        ws.addEventListener("message", (ev) => {
          const raw = (ev as { data?: string }).data ?? "";
          try {
            const parsed = JSON.parse(raw) as { type?: string };
            if (typeof parsed.type === "string") {
              emit({
                kind: "raw",
                provider: "vapi",
                ts: (opts._now ?? ((): Date => new Date()))().toISOString(),
                payload: parsed,
              });
            }
          } catch {
            /* swallow malformed frames */
          }
        });
      });
    },
    sendAudio(pcm: Int16Array): void {
      // Vapi accepts base64-encoded PCM in `input_audio_buffer.append`.
      const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      send({ type: "input_audio_buffer.append", audio: buf.toString("base64") });
    },
    commitInput(): void {
      send({ type: "input_audio_buffer.commit" });
    },
    sendText(text: string): void {
      send({ type: "response.create", response: { modalities: ["text", "audio"], input: text } });
    },
    interrupt(_reason: string): void {
      try {
        send({ type: "response.cancel" });
      } catch {
        /* idempotent */
      }
    },
    on(handler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async disconnect(): Promise<void> {
      if (ws) {
        try {
          ws.close();
        } catch {
          /* best effort */
        }
        ws = undefined;
      }
      disconnected = true;
      connected = false;
    },
  };
}

/**
 * Resolve a provider string to an adapter factory. Mirrors the
 * `model-router` pattern — the spec carries `voice.provider: "openai" |
 * "vapi"` and the daemon constructs the right adapter at boot.
 */
export function createRealtimeAdapter(
  provider: ProviderId,
  opts: CreateOpenAIRealtimeAdapterOptions = {},
): RealtimeAdapter {
  if (provider === "openai") return createOpenAIRealtimeAdapter(opts);
  if (provider === "vapi") return createVapiRealtimeAdapter(opts);
  throw new VoiceRuntimeError(`unknown realtime provider: ${provider}`);
}

// ---------------------------------------------------------------------------
// PCM ↔ base64 helpers. Exported because vad-engine + tests use them.
// ---------------------------------------------------------------------------

/**
 * Encode an Int16Array of PCM 16-bit samples (little-endian) as base64.
 * Bun's Buffer is a polyfill; this implementation works in Node, Bun,
 * and the browser when used with the global `btoa` fallback.
 */
export function encodePcm16Base64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.from(bytes).toString("base64");
}

export function decodePcm16Base64(b64: string): Int16Array {
  const buf = Buffer.from(b64, "base64");
  // Copy to a new ArrayBuffer aligned for Int16Array (Buffer's underlying
  // ArrayBuffer can have an unaligned offset; alignment matters here).
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(buf);
  return new Int16Array(aligned);
}
