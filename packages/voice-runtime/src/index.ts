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
 *   - `input_blocked      { itemId?, rules }` — the prompt-injection check
 *     refused the caller's input (a transcript of their speech, or text
 *     passed to `sendText`); the call goes on
 *   - `input_warned       { itemId?, rules }` — it kept the input, flagged
 *   - `disconnect         { code?, reason? }` — final
 *
 * The caller's input is screened at TrustOrigin `channel`. On the OpenAI
 * Realtime adapter the session asks the provider to transcribe the caller,
 * and each transcript is classified: a malicious one cancels the reply in
 * progress and deletes the caller's item, so later replies do not build on
 * it. Text passed to `sendText` is classified before it is sent, on both
 * adapters. The two input events carry rule ids, never the text.
 *
 * The OpenAI adapter is HEADLESS — no microphone, no speakers. The
 * caller pumps PCM in via `sendAudio(pcm)`; the adapter emits audio +
 * transcript events back. This keeps the runtime usable in three
 * deployment modes:
 *   1. Browser → daemon over WebRTC (browser has the mic/speaker).
 *   2. SIP gateway → daemon (telephony provides PCM).
 *   3. Node-only smoke (synthesize PCM in TS, pipe in, assert events).
 */
import {
  type BoundaryAction,
  boundaryRuleIds,
  classifyBoundary,
} from "@crewhaus/boundary-classifier";
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
  | { kind: "raw"; provider: ProviderId; ts: string; payload: unknown }
  /**
   * The prompt-injection check refused the caller's input: a transcript of
   * their speech (`itemId` is its conversation item, deleted) or text passed
   * to `sendText` (not sent). The detector's rule ids, never the text.
   */
  | { kind: "input_blocked"; itemId?: string; rules: string[] }
  /** The check kept the caller's input but flagged it. Rule ids, never the text. */
  | { kind: "input_warned"; itemId?: string; rules: string[] };

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
  /**
   * Inject a text turn (no audio). Useful for tests + chat-only mixed mode.
   * The text is classified at TrustOrigin `channel` before it is sent:
   * malicious text is not sent (an `input_blocked` event; the call goes on),
   * suspicious text is sent with an `input_warned` event. Throws at call time
   * when not connected; otherwise the returned promise resolves once the
   * text is sent or refused, in call order, and never rejects (a send that
   * fails after the check is an `error` event).
   */
  sendText(text: string): void | Promise<void>;
  /** Cancel the in-flight response. Used by `barge-in-controller`. */
  interrupt(reason: string): void;
  on(handler: RealtimeEventHandler): () => void;
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Caller input screening — shared by both adapters.
// ---------------------------------------------------------------------------

type Emit = (event: RealtimeEvent) => void;

/**
 * One adapter's input lane: each check, and what follows it (a send, a
 * cancel), runs in the order it was queued, and a failure surfaces as an
 * `error` event, never as a rejected promise.
 */
function createInputLane(emit: Emit): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    const next = tail.then(task).catch((err: unknown) => {
      emit({ kind: "error", message: `input check: ${errorText(err)}` });
    });
    tail = next;
    return next;
  };
}

/** Classify caller input at TrustOrigin `channel`: the action and the rule ids. */
async function checkCallerInput(
  text: string,
): Promise<{ readonly action: BoundaryAction; readonly rules: string[] }> {
  const boundary = await classifyBoundary(text, { origin: "channel" });
  return { action: boundary.action, rules: boundaryRuleIds(boundary.verdict) };
}

/**
 * `sendText`'s body after the call-time connection check: classify, then
 * `deliver` unless refused. A delivery that throws (the socket closed during
 * the check) is an `error` event.
 */
function sendChecked(
  lane: (task: () => Promise<void>) => Promise<void>,
  emit: Emit,
  text: string,
  deliver: () => void,
): Promise<void> {
  return lane(async () => {
    const verdict = await checkCallerInput(text);
    if (verdict.action === "redact") {
      emit({ kind: "input_blocked", rules: verdict.rules });
      return;
    }
    try {
      deliver();
    } catch (err) {
      emit({ kind: "error", message: `sendText: ${errorText(err)}` });
      return;
    }
    if (verdict.action === "warn") emit({ kind: "input_warned", rules: verdict.rules });
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// OpenAI Realtime adapter — speaks the GA `/v1/realtime` WebSocket protocol.
//
// The beta interface (`OpenAI-Beta: realtime=v1` upgrade header + the flat
// `session.update` shape) is RETIRED server-side: connecting with it closes
// the socket with code 4000 / `invalid_request_error.beta_api_shape_disabled`
// and the error event "The Realtime Beta API is no longer supported. Please
// use /v1/realtime for the GA API." The GA differences this adapter honours:
//
//   - no `OpenAI-Beta` header (sending it is what triggers the beta shape)
//   - `session.type: "realtime"` is required
//   - `modalities` → `output_modalities`, and text+audio may NOT be combined
//     (audio output still emits transcript events, so `["audio"]` gives us
//     both halves of this adapter's event surface)
//   - `input_audio_format`/`output_audio_format` string enums → nested
//     `audio.input.format` / `audio.output.format` objects
//   - `voice` → `audio.output.voice`; `turn_detection` → `audio.input.turn_detection`
//   - server events renamed: `response.audio.delta` →
//     `response.output_audio.delta`, `response.audio_transcript.{delta,done}`
//     → `response.output_audio_transcript.{delta,done}`
//   - input transcription is `audio.input.transcription` (the beta
//     `input_audio_transcription` field is never sent)
//
// The READ path still accepts the legacy event names as aliases — they cost
// three case labels and keep the adapter usable against a gateway or proxy
// (`opts.url`) that has not finished its own migration. The WRITE path is GA
// only: there is no live endpoint left that accepts the beta payload, so a
// "speak beta" toggle would be dead configuration.
// ---------------------------------------------------------------------------

const OPENAI_REALTIME_SAMPLE_RATE = 24_000;
/**
 * GA model alias. The beta-era `gpt-4o-realtime-preview` was removed from
 * the API in March 2026 — it is not a valid fallback any more.
 */
const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime";
const DEFAULT_OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
/**
 * The model a session asks to transcribe the caller's speech
 * (`session.audio.input.transcription.model`), so each transcript can be
 * classified before later replies build on it. The provider bills it as
 * transcription.
 */
export const DEFAULT_INPUT_TRANSCRIPTION_MODEL = "gpt-transcribe";

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

  function openSocket(): WebSocketLike {
    if (ws === undefined || ws.readyState !== 1 /* OPEN */) {
      throw new VoiceRuntimeError("adapter is not connected (or socket is not open)");
    }
    return ws;
  }

  function send(message: Record<string, unknown>): void {
    openSocket().send(JSON.stringify(message));
  }

  const inputLane = createInputLane(emit);

  /**
   * A transcript of the caller's speech (`undefined` when the provider could
   * not make one), classified at `channel`. Malicious, or unreadable: the
   * reply in progress is cancelled and the caller's item deleted, so later
   * replies do not build on it, and `input_blocked` is emitted; the call goes
   * on. Suspicious: `input_warned`. The transcript is never emitted.
   */
  function checkTranscript(itemId: string | undefined, transcript: string | undefined): void {
    void inputLane(async () => {
      const verdict =
        transcript === undefined
          ? { action: "redact" as const, rules: ["transcription-failed"] }
          : await checkCallerInput(transcript);
      const item = itemId !== undefined ? { itemId } : {};
      if (verdict.action === "redact") {
        // Each send tolerates a closed socket: the verdict is reported either way.
        for (const message of [
          { type: "response.cancel" },
          ...(itemId !== undefined ? [{ type: "conversation.item.delete", item_id: itemId }] : []),
        ]) {
          try {
            send(message);
          } catch {
            /* socket closed: nothing left to cancel or delete */
          }
        }
        emit({ kind: "input_blocked", ...item, rules: verdict.rules });
      } else if (verdict.action === "warn") {
        emit({ kind: "input_warned", ...item, rules: verdict.rules });
      }
    });
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
      // GA name first; the beta name is kept as a read-path alias.
      case "response.output_audio_transcript.delta":
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
      case "response.output_audio_transcript.done":
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
      case "response.output_audio.delta":
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
      // The caller's own speech, transcribed because the session asks for it
      // (the transcript events above are the AGENT's). Each one is checked.
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = ev["transcript"];
        checkTranscript(
          typeof ev["item_id"] === "string" ? ev["item_id"] : undefined,
          typeof transcript === "string" ? transcript : undefined,
        );
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        checkTranscript(typeof ev["item_id"] === "string" ? ev["item_id"] : undefined, undefined);
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
      // GA takes Authorization only. Sending `OpenAI-Beta: realtime=v1` here
      // is what selects the retired beta wire shape and kills the socket.
      ws = factory(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
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

      // Configure session — GA shape. `output_modalities` is audio-only
      // because GA rejects a combined ["text","audio"] request; the audio
      // response still streams transcript deltas, which is where this
      // adapter's transcript_partial/transcript_final events come from.
      // `audio.input.transcription` asks for the CALLER's transcript too, so
      // each utterance can be classified (see checkTranscript).
      send({
        type: "session.update",
        session: {
          type: "realtime",
          model: connectOpts.model || DEFAULT_OPENAI_REALTIME_MODEL,
          output_modalities: ["audio"],
          ...(connectOpts.instructions !== undefined
            ? { instructions: connectOpts.instructions }
            : {}),
          audio: {
            input: {
              format: { type: "audio/pcm", rate: OPENAI_REALTIME_SAMPLE_RATE },
              turn_detection: connectOpts.vad === "none" ? null : { type: "server_vad" },
              transcription: { model: DEFAULT_INPUT_TRANSCRIPTION_MODEL },
            },
            output: {
              // `rate` is REQUIRED on an audio/pcm output format — the server
              // rejects the session with "Missing required parameter:
              // 'session.audio.output.format.rate'" if it is omitted (the
              // published docs example omits it, but that example uses
              // audio/pcmu, which is 8kHz-only).
              format: { type: "audio/pcm", rate: OPENAI_REALTIME_SAMPLE_RATE },
              ...(connectOpts.voice !== undefined ? { voice: connectOpts.voice } : {}),
            },
          },
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
      openSocket(); // not connected: refused at call time
      return sendChecked(inputLane, emit, text, () => {
        send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        });
        send({ type: "response.create" });
      });
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

  function openSocket(): WebSocketLike {
    if (ws === undefined || ws.readyState !== 1) {
      throw new VoiceRuntimeError("vapi adapter is not connected (or socket is not open)");
    }
    return ws;
  }

  function send(message: Record<string, unknown>): void {
    openSocket().send(JSON.stringify(message));
  }

  const inputLane = createInputLane(emit);

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
    sendText(text: string): Promise<void> {
      openSocket(); // not connected: refused at call time
      return sendChecked(inputLane, emit, text, () => {
        send({ type: "response.create", response: { modalities: ["text", "audio"], input: text } });
      });
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
