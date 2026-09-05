/**
 * 0.6.0 §16 Q6 (PR 9d) — the IN-MEMORY persistence twins behind
 * `runChatLoop({ persistSession: false })`.
 *
 * A hybrid strategy runs nested single-turn side calls — consult, guide,
 * shadow, committee members — each of which is a `runChatLoop` in its own
 * right. Left to the defaults every one of them would create a session
 * `.json` and an event-log `.jsonl` under the sessions dir (a Task child
 * does exactly that), so a committee of three on a ten-step workflow would
 * write thirty child sessions per run that no `--resume`, `sessions tail` or
 * Hangar view ever reads: the side call's spend and stage transitions are
 * re-published on the PARENT bus and persisted in the parent's log. These
 * twins keep the loop's persistence contract (`create` / `update` /
 * `append` / `close` all succeed, ids keep their shape) without touching the
 * filesystem. `read()` replays what was appended so in-run readers behave.
 */
import { randomBytes } from "node:crypto";
import type { AppendEvent, Event, EventLog } from "@crewhaus/event-log";
import type { CreateOpts, Session, SessionPatch, SessionStore } from "@crewhaus/session-store";

/** A `SessionStore` over a Map — the same id shape (`sess_<16 hex>`). */
export function createMemorySessionStore(now: () => Date = () => new Date()): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async create(opts: CreateOpts): Promise<Session> {
      const id = opts.id ?? `sess_${randomBytes(8).toString("hex")}`;
      const ts = now().toISOString();
      const session: Session = {
        id,
        createdAt: ts,
        updatedAt: ts,
        name: opts.name,
        target: opts.target,
        model: opts.model,
        lastTurnIndex: 0,
      };
      sessions.set(id, session);
      return { ...session };
    },
    async get(id: string): Promise<Session | null> {
      const s = sessions.get(id);
      return s === undefined ? null : { ...s };
    },
    async list(): Promise<Session[]> {
      return [...sessions.values()].map((s) => ({ ...s }));
    },
    async update(id: string, patch: SessionPatch): Promise<Session> {
      const existing = sessions.get(id);
      if (existing === undefined) {
        throw new Error(`memory session store: unknown session "${id}"`);
      }
      const { pin, ...rest } = patch;
      const { pin: existingPin, ...keep } = existing;
      const nextPin = pin === null ? undefined : pin === undefined ? existingPin : pin;
      const next: Session = {
        ...keep,
        ...(rest as Partial<Session>),
        ...(nextPin !== undefined ? { pin: nextPin } : {}),
        updatedAt: now().toISOString(),
      };
      sessions.set(id, next);
      return { ...next };
    },
    async delete(id: string): Promise<void> {
      sessions.delete(id);
    },
  };
}

/** An `EventLog` over an array: appends are kept in order and replayable. */
export function createMemoryEventLog(now: () => number = () => Date.now()): EventLog {
  const events: Event[] = [];
  let closed = false;
  return {
    async append(event: AppendEvent): Promise<void> {
      if (closed) throw new Error("memory event log: append after close");
      events.push({ ts: now(), version: 1, kind: event.kind, payload: event.payload });
    },
    read(opts: { since?: number; until?: number } = {}): AsyncIterable<Event> {
      const snapshot = events.filter(
        (e) =>
          (opts.since === undefined || e.ts >= opts.since) &&
          (opts.until === undefined || e.ts <= opts.until),
      );
      return (async function* () {
        for (const e of snapshot) yield e;
      })();
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}
