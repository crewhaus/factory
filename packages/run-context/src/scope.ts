/**
 * The ambient scope: what a library that hands work to a run knows about that
 * run's input, carried to the run's first `RunContext` without a parameter.
 *
 * A library that takes run input in, such as the managed gateway or the queue
 * consumer, classifies the text where it enters and runs the run's handler
 * inside {@link withInboundContent}. The handler's code was compiled from a
 * spec and creates the run's context itself; the first `createRunContext`
 * created inside the scope adopts the scope's entries: it tags each one into
 * its lineage at the entry's origin (`tagContent`, so the egress check sees
 * the text), and for an entry kept with a warning it publishes one
 * `permission_decision` event (`outcome: "warned"`) on its trace bus and logs
 * one line naming the origin, the door, the rule ids and the score (never the
 * text). Child and side-call contexts created later in the same scope adopt
 * nothing. With no scope, `createRunContext` adopts nothing: no lineage key, no
 * event and no log line.
 *
 * The event lands in the bus's replay buffer, so a stream that replays the
 * run's events (a managed `runs.subscribe`) carries it; it is published
 * before the runtime attaches its own subscribers, so the log line is what an
 * operator of a process without such a stream sees.
 *
 * One store, kept on `globalThis` under
 * `Symbol.for("@crewhaus/run-context/ambient")`, so two copies of this package
 * in one process (a bundle that duplicated it) share it. Contract for every
 * helper that opens a nested scope on this store: copy the current store, and
 * copy its `inbound` object BY REFERENCE (never a clone of `consumed`), so a
 * context created in the nested scope consumes the same entries the outer one
 * would. Only {@link withInboundContent} replaces `inbound`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { TrustOrigin } from "./index";

/** Run input a library classified and kept, waiting for the run's first context. */
export type InboundContent = {
  readonly content: string;
  readonly origin: TrustOrigin;
  /** Where it came in, e.g. `runs.create`, `runs.continue`, `queue`. */
  readonly door: string;
  /** Set when the text was kept with a warning: the verdict, never the text. */
  readonly warning?: { readonly rules: readonly string[]; readonly score: number };
};

/** Shared and mutable: every scope nested inside holds the same object. */
type InboundSlot = { readonly entries: readonly InboundContent[]; consumed: boolean };

type AmbientStore = { readonly inbound?: InboundSlot };

const AMBIENT_KEY = Symbol.for("@crewhaus/run-context/ambient");

function ambient(): AsyncLocalStorage<AmbientStore> {
  const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<AmbientStore>>;
  let store = holder[AMBIENT_KEY];
  if (store === undefined) {
    store = new AsyncLocalStorage<AmbientStore>();
    holder[AMBIENT_KEY] = store;
  }
  return store;
}

/**
 * Run `fn` in a scope whose run input is `entries`. The scope keeps the
 * current store's other fields and holds a fresh `{ entries, consumed: false }`
 * slot; the first `createRunContext` created inside it, at any depth of
 * awaits, takes the entries.
 */
export function withInboundContent<T>(entries: readonly InboundContent[], fn: () => T): T {
  const store = ambient();
  return store.run({ ...store.getStore(), inbound: { entries, consumed: false } }, fn);
}

/**
 * The current scope's entries, marking the scope consumed; `[]` when there is
 * no scope or a context already took them. `createRunContext` calls this once.
 */
export function takePendingInbound(): readonly InboundContent[] {
  const slot = ambient().getStore()?.inbound;
  if (slot === undefined || slot.consumed) return [];
  slot.consumed = true;
  return slot.entries;
}
