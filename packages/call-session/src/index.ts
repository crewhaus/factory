/**
 * Catalog R16 `call-session` — Section 24 VOICE.
 *
 * Call lifecycle state machine with pluggable telephony adapter slots.
 *
 *   idle ─dial()→ dialing ─answer()→ connected ─hold()→ on-hold
 *                                   │              │
 *                                   │              └─resume()→ connected
 *                                   ├─transfer()→ transferred ─end()→ terminated
 *                                   └─end()─────────────────────→ terminated
 *
 * Telephony adapters (Twilio, LiveKit SIP, Vonage) are STUBS in v0 —
 * the interface is exercised by an in-memory adapter the tests + the
 * smoke harness use to drive transitions deterministically. Real
 * telephony lands in follow-up PRs (the kickoff explicitly defers it).
 *
 * Per-state hooks fire on transitions — the daemon uses them to log
 * trace events, measure connect-time, etc. Hook errors are isolated:
 * a misbehaving listener is logged but cannot wedge the state machine.
 */
import { CrewhausError } from "@crewhaus/errors";

export class CallSessionError extends CrewhausError {
  override readonly name = "CallSessionError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

// Section 30 — additional telephony adapters
export {
  createTwilioTelephonyAdapter,
  type TwilioAdapterOptions,
} from "./adapters/twilio";
export {
  createLiveKitSipAdapter,
  type LiveKitSipAdapterOptions,
} from "./adapters/livekit-sip";

export type CallState = "idle" | "dialing" | "connected" | "on-hold" | "transferred" | "terminated";

export type CallTransition = {
  readonly from: CallState;
  readonly to: CallState;
  readonly at: string;
  readonly reason?: string;
};

export type CallStateListener = (transition: CallTransition) => void;

export interface TelephonyAdapter {
  readonly kind: string;
  /** Begin the outbound dial — promise resolves on adapter ack. */
  dial(toUri: string): Promise<void>;
  /** Answer an incoming call (no-op for outbound flows). */
  answer(): Promise<void>;
  /** Briefly suspend the bidirectional audio path. */
  hold(): Promise<void>;
  resume(): Promise<void>;
  /** Hand the call off to another agent / number. */
  transfer(toUri: string): Promise<void>;
  /** Hang up. */
  end(reason: string): Promise<void>;
}

export interface CallSession {
  readonly state: CallState;
  dial(toUri: string, opts?: { reason?: string }): Promise<void>;
  answer(opts?: { reason?: string }): Promise<void>;
  hold(opts?: { reason?: string }): Promise<void>;
  resume(opts?: { reason?: string }): Promise<void>;
  transfer(toUri: string, opts?: { reason?: string }): Promise<void>;
  end(opts?: { reason?: string }): Promise<void>;
  on(listener: CallStateListener): () => void;
  /** Diagnostic — full transition history (newest last). */
  history(): ReadonlyArray<CallTransition>;
}

export type CreateCallSessionOptions = {
  readonly adapter: TelephonyAdapter;
  readonly now?: () => Date;
};

const TRANSITIONS: Readonly<Record<CallState, ReadonlyArray<CallState>>> = {
  idle: ["dialing"],
  dialing: ["connected", "terminated"],
  connected: ["on-hold", "transferred", "terminated"],
  "on-hold": ["connected", "terminated"],
  transferred: ["terminated"],
  terminated: [],
};

export function createCallSession(opts: CreateCallSessionOptions): CallSession {
  const now = opts.now ?? (() => new Date());
  const listeners = new Set<CallStateListener>();
  const log: CallTransition[] = [];
  let state: CallState = "idle";

  function transitionTo(target: CallState, reason?: string): void {
    const allowed = TRANSITIONS[state];
    if (!allowed.includes(target)) {
      throw new CallSessionError(
        `illegal transition ${state} → ${target}${reason ? ` (reason: ${reason})` : ""}`,
      );
    }
    const t: CallTransition = {
      from: state,
      to: target,
      at: now().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    };
    state = target;
    log.push(t);
    for (const l of listeners) {
      try {
        l(t);
      } catch {
        // Isolate listener errors.
      }
    }
  }

  return {
    get state() {
      return state;
    },
    async dial(toUri, callOpts = {}) {
      transitionTo("dialing", callOpts.reason);
      try {
        await opts.adapter.dial(toUri);
      } catch (err) {
        transitionTo("terminated", `dial failed: ${(err as Error).message ?? String(err)}`);
        throw err;
      }
    },
    async answer(callOpts = {}) {
      await opts.adapter.answer();
      transitionTo("connected", callOpts.reason);
    },
    async hold(callOpts = {}) {
      await opts.adapter.hold();
      transitionTo("on-hold", callOpts.reason);
    },
    async resume(callOpts = {}) {
      await opts.adapter.resume();
      transitionTo("connected", callOpts.reason);
    },
    async transfer(toUri, callOpts = {}) {
      await opts.adapter.transfer(toUri);
      transitionTo("transferred", callOpts.reason);
    },
    async end(callOpts = {}) {
      await opts.adapter.end(callOpts.reason ?? "end");
      transitionTo("terminated", callOpts.reason);
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    history() {
      return [...log];
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory adapter — for tests + the smoke harness.
// ---------------------------------------------------------------------------

export interface InMemoryTelephonyAdapter extends TelephonyAdapter {
  readonly kind: "in-memory";
  /** Test seam — every adapter call is recorded here in order. */
  readonly calls: ReadonlyArray<{ readonly verb: string; readonly arg?: string }>;
  /** Inject a failure on the next `dial(...)` call. */
  failNextDial(message?: string): void;
}

export function createInMemoryTelephonyAdapter(): InMemoryTelephonyAdapter {
  const calls: { verb: string; arg?: string }[] = [];
  let nextDialFailure: string | undefined;
  return {
    kind: "in-memory",
    calls,
    failNextDial(message = "in-memory: dial failed") {
      nextDialFailure = message;
    },
    async dial(toUri) {
      calls.push({ verb: "dial", arg: toUri });
      if (nextDialFailure !== undefined) {
        const m = nextDialFailure;
        nextDialFailure = undefined;
        throw new CallSessionError(m);
      }
    },
    async answer() {
      calls.push({ verb: "answer" });
    },
    async hold() {
      calls.push({ verb: "hold" });
    },
    async resume() {
      calls.push({ verb: "resume" });
    },
    async transfer(toUri) {
      calls.push({ verb: "transfer", arg: toUri });
    },
    async end(reason) {
      calls.push({ verb: "end", arg: reason });
    },
  };
}
