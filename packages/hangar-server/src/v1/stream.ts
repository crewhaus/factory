/**
 * The versioned API's one event-stream writer (#507, #513). Every v1 stream — a run's, a
 * harness's, Home's — is sent through it, so each says the same things the same way:
 *
 * - The body opens with the comment `: open`, and a `: ping` comment keeps a quiet
 *   connection (and any proxy) awake.
 * - Every frame is `id: <cursor>`, `event: <type>`, `data: <envelope>`. Its `id` is a
 *   cursor a client resumes from with no duplicate. Each frame passes the stream's people
 *   exit, then the dispatch masker with the scrubber the router chose (`scrub` is
 *   required).
 * - A cap of frames or of time ends the stream with `stream.pause {reason, resumeFrom}`,
 *   never with a terminal event: a client that reconnects from `resumeFrom` gets the next
 *   frame. A session that ends closes it with `auth.expired`, and a session or a re-check
 *   that refuses it with `auth.revoked`.
 * - `dispose` is called exactly once, whatever ends the stream: its own end, a cap, an
 *   abort, the client going away, or a read that throws.
 *
 * Reads are paced by the writer: one batch at a time, again at once when a batch says
 * there is more, else after `pollMs`. Timers and the clock are injectable, so a test runs
 * a stream with no wall-clock wait.
 */
import type { EventEnvelope, EventType } from "@crewhaus/control-contract";
import { PEOPLE_SENSITIVITY, type RequestAccess, withholdPeople } from "../access";
import { type TextScrubber, maskDeep } from "../mask";
import { MAX_SSE_FRAMES, SSE_HEADERS, SSE_HEARTBEAT_MS } from "../runs";

/** One frame, before the people exit and the masker. */
export type StreamFrame = {
  readonly id: string;
  readonly event: EventType;
  readonly data: EventEnvelope;
};

export type StreamBatch = {
  readonly frames: readonly StreamFrame[];
  /** Where a client resumes once every frame of this batch was sent. */
  readonly next: string;
  /** Read again at once: the batch stopped at a cap of its own. */
  readonly more?: boolean;
  /** Nothing more will come: the stream ends once these frames are sent. */
  readonly done?: boolean;
  /** The stream ends after these frames with `stream.pause` for this reason. */
  readonly pause?: "execution";
};

/** What a stream handler hands the router: where it opened, how to read, how it ends. */
export type StreamPlan = {
  /** The cursor the stream opened at: what a pause resumes from before any frame. */
  readonly start: string;
  /** One batch, decided on the caller's authority as it stands now. */
  read(access: RequestAccess): Promise<StreamBatch> | StreamBatch;
  readonly signal: AbortSignal | undefined;
  /** Called exactly once when the stream finishes, for every reason. */
  dispose(): void;
  /** The people exit; the default releases a people frame only where the caller may see it. */
  readonly exitFrame?: (frame: StreamFrame, access: RequestAccess, at: string) => StreamFrame;
};

export type StreamTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type StreamTimings = {
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly maxFrames?: number;
  readonly maxMs?: number;
  readonly timers?: StreamTimers;
  readonly now?: () => number;
};

/** How long one connection streams before it pauses: a client reconnects past it. */
export const STREAM_MAX_MS = 15 * 60 * 1000;
/** How often a stream with nothing new reads again. */
export const STREAM_POLL_MS = 500;

const SYSTEM_TIMERS: StreamTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A frame the stream makes itself, about itself. */
export function streamEnvelope(
  type: EventType,
  id: string,
  at: string,
  payload?: Readonly<Record<string, unknown>>,
): StreamFrame {
  return {
    id,
    event: type,
    data: {
      v: 1,
      id,
      type,
      at,
      ingestedAt: at,
      sensitivity: "internal",
      ...(payload !== undefined ? { payload } : {}),
    },
  };
}

/**
 * The people exit of a stream frame. A frame about people (`sensitivity: "people"`) is
 * released only where the caller may see it (a frame with no `ref` never is); otherwise it
 * is replaced by `stream.gap {reason: "withheld", hidden: ["people"]}` carrying only its
 * cursor, stamped `at`. Any other frame passes `withholdPeople`, so a people item in its
 * payload is withheld and its data says `hidden: ["people"]`.
 */
export function peopleExitFrame(
  frame: StreamFrame,
  access: RequestAccess,
  at: string,
): StreamFrame {
  if (frame.data.sensitivity === PEOPLE_SENSITIVITY) {
    if (access.peopleAllowed(frame.data as unknown as Record<string, unknown>)) return frame;
    return streamEnvelope("stream.gap", frame.id, at, {
      reason: "withheld",
      hidden: [PEOPLE_SENSITIVITY],
    });
  }
  const data = withholdPeople(frame.data, access.peopleAllowed);
  return data === frame.data ? frame : { ...frame, data: data as EventEnvelope };
}

/** An abort reason as the frame a stream closes with. */
function authFrameOf(reason: unknown): EventType | undefined {
  if (reason === "auth.expired") return "auth.expired";
  if (reason === "auth.revoked" || reason === "revoked") return "auth.revoked";
  return undefined;
}

export type V1StreamOptions = StreamTimings &
  StreamPlan & {
    /** The dispatch masker's scrubber for this stream: the harness's, or the fleet's. */
    readonly scrub: TextScrubber;
    /** The caller's authority as it stands now, taken once per batch. */
    readonly accessNow: () => RequestAccess;
    readonly headers?: Readonly<Record<string, string>>;
    readonly onWarn?: (message: string) => void;
  };

/** Send a stream plan as an SSE response. */
export function v1EventStream(options: V1StreamOptions): Response {
  const timers = options.timers ?? SYSTEM_TIMERS;
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const pollMs = options.pollMs ?? STREAM_POLL_MS;
  const maxFrames = options.maxFrames ?? MAX_SSE_FRAMES;
  const maxMs = options.maxMs ?? STREAM_MAX_MS;
  const exitFrame = options.exitFrame ?? peopleExitFrame;
  const encoder = new TextEncoder();
  let closed = false;
  let finishFn: ((reason: string) => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let frames = 0;
      let resumeFrom = options.start;
      // The three timers a stream arms: its next read, its keep-alive and its time cap.
      const armed: { read?: unknown; ping?: unknown; cap?: unknown } = {};
      let disposed = false;
      const iso = (): string => new Date(now()).toISOString();

      const write = (text: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          finish("client-gone");
          return false;
        }
      };

      const send = (frame: StreamFrame): boolean => {
        const masked = maskDeep(frame.data, options.scrub);
        return write(`id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(masked)}\n\n`);
      };

      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        options.dispose();
      };

      const onAbort = (): void => {
        const reason = options.signal?.reason;
        finish(typeof reason === "string" ? reason : "aborted");
      };

      const finish = (reason: string): void => {
        if (closed) return;
        // The closing frame goes out before the stream is marked closed.
        const pause =
          reason === "frame-cap" || reason === "time-cap" || reason === "execution"
            ? reason
            : undefined;
        const auth = authFrameOf(reason);
        if (pause !== undefined) {
          send(streamEnvelope("stream.pause", resumeFrom, iso(), { reason: pause, resumeFrom }));
        } else if (auth !== undefined) {
          send(streamEnvelope(auth, resumeFrom, iso(), {}));
        }
        closed = true;
        for (const handle of [armed.read, armed.ping, armed.cap]) {
          if (handle !== undefined) timers.clearTimeout(handle);
        }
        options.signal?.removeEventListener("abort", onAbort);
        dispose();
        if (reason !== "client-gone") {
          try {
            controller.close();
          } catch {
            // Already closed by the runtime.
          }
        }
      };
      finishFn = finish;

      const ping = (): void => {
        armed.ping = undefined;
        if (closed) return;
        if (write(": ping\n\n")) armed.ping = timers.setTimeout(ping, heartbeatMs);
      };

      const readOnce = async (): Promise<void> => {
        armed.read = undefined;
        if (closed) return;
        const access = options.accessNow();
        let batch: StreamBatch;
        try {
          batch = await options.read(access);
        } catch (err) {
          options.onWarn?.(
            `hangar-server: an event stream stopped: ${err instanceof Error ? err.message : String(err)}`,
          );
          finish("error");
          return;
        }
        if (closed) return;
        const at = iso();
        for (const [index, frame] of batch.frames.entries()) {
          if (!send(exitFrame(frame, access, at))) return;
          frames += 1;
          resumeFrom = index === batch.frames.length - 1 ? batch.next : frame.id;
          if (frames >= maxFrames) {
            finish("frame-cap");
            return;
          }
        }
        resumeFrom = batch.next;
        if (batch.pause !== undefined) {
          finish(batch.pause);
          return;
        }
        if (batch.done === true) {
          finish("end");
          return;
        }
        armed.read = timers.setTimeout(() => void readOnce(), batch.more === true ? 0 : pollMs);
      };

      if (!write(": open\n\n")) return;
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      armed.ping = timers.setTimeout(ping, heartbeatMs);
      armed.cap = timers.setTimeout(() => finish("time-cap"), maxMs);
      armed.read = timers.setTimeout(() => void readOnce(), 0);
    },
    cancel() {
      finishFn?.("client-gone");
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS, ...(options.headers ?? {}) } });
}
