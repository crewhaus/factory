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
 * The same store carries the run's lineage: {@link runWithScope} names what
 * started the work (`trigger`), what it may be resumed as (`resumeScope`), the
 * work item it serves and the parked run it continues. Every context created
 * inside takes these for any field its own options leave unset; `continues`
 * goes to the first context only, like the run input. It can also name who the
 * run serves (`subject`), which no context carries: {@link currentSubject}
 * reads it, for the run row's keyed digest.
 *
 * One store, kept on `globalThis` under
 * `Symbol.for("@crewhaus/run-context/ambient")`, so two copies of this package
 * in one process (a bundle that duplicated it) share it. Two helpers open a
 * nested scope on it, {@link withInboundContent} and {@link runWithScope}, and
 * both follow one contract: copy the current store, and copy its shared slots
 * (`inbound`, and `run.continues`) BY REFERENCE (never a clone of their
 * `consumed`/`taken` flag), so a context created in the nested scope consumes
 * the same entries the outer one would. Only {@link withInboundContent}
 * replaces `inbound`; only a {@link runWithScope} that names `continues`
 * replaces that slot. Either helper nests inside the other.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Trigger } from "@crewhaus/control-contract";
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

/**
 * What a library knows about the run it hands work to. Every field is
 * optional; a field a context's own options set wins over the scope's.
 */
export type RunScope = {
  /** What the run may be resumed as: `session:`, `job:`, `lane:`, `run:` or `work:` and an id. */
  readonly resumeScope?: string;
  /** What started the run. */
  readonly trigger?: Trigger;
  /** The parked run this one continues. Taken by the first context in the scope only. */
  readonly continues?: string;
  /** The work item (`wi_…`) the run serves. */
  readonly workItem?: string;
  /**
   * Who the run serves, as a verified source named them (a managed daemon's
   * `app:<tenant>:<sub>`, from the token's verified `sub`). Read with
   * {@link currentSubject}; it never goes on a context, its lineage or a trace
   * envelope, and a run row holds only a keyed digest of it.
   */
  readonly subject?: string;
};

/** Shared and mutable, like {@link InboundSlot}: the first context takes it. */
type ContinuesSlot = { readonly id: string; taken: boolean };

type RunFields = {
  readonly resumeScope?: string;
  readonly trigger?: Trigger;
  readonly workItem?: string;
  readonly continues?: ContinuesSlot;
  readonly subject?: string;
};

type AmbientStore = { readonly inbound?: InboundSlot; readonly run?: RunFields };

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

/**
 * Run `fn` in a scope that names the run's lineage. The scope keeps the
 * current store's other fields, merges the outer scope's run fields under
 * `scope`'s, and keeps the outer `continues` slot by reference unless `scope`
 * names its own. Every context created inside, at any depth of awaits, takes
 * these fields for any its own options leave unset.
 */
export function runWithScope<T>(scope: RunScope, fn: () => T): T {
  const store = ambient();
  const current = store.getStore();
  const outer = current?.run;
  const run: RunFields = {
    ...outer,
    ...(scope.resumeScope !== undefined ? { resumeScope: scope.resumeScope } : {}),
    ...(scope.trigger !== undefined ? { trigger: scope.trigger } : {}),
    ...(scope.workItem !== undefined ? { workItem: scope.workItem } : {}),
    ...(scope.continues !== undefined ? { continues: { id: scope.continues, taken: false } } : {}),
    ...(scope.subject !== undefined ? { subject: scope.subject } : {}),
  };
  return store.run({ ...current, run }, fn);
}

/**
 * The subject the current scope names (`RunScope.subject`), or `undefined` with
 * none. Reading takes nothing: every caller in the scope sees the same subject.
 */
export function currentSubject(): string | undefined {
  return ambient().getStore()?.run?.subject;
}

/** The lineage a new context takes from the current scope. */
export type AmbientRun = {
  readonly resumeScope?: string;
  readonly trigger?: Trigger;
  readonly workItem?: string;
  readonly continues?: string;
};

/**
 * The current scope's run fields, taking its `continues` (the first caller
 * gets it, later ones do not); `{}` with no scope. `createRunContext` calls
 * this once.
 */
export function takeAmbientRun(): AmbientRun {
  const run = ambient().getStore()?.run;
  if (run === undefined) return {};
  const slot = run.continues;
  const continues = slot !== undefined && !slot.taken ? slot.id : undefined;
  if (slot !== undefined) slot.taken = true;
  return {
    ...(run.resumeScope !== undefined ? { resumeScope: run.resumeScope } : {}),
    ...(run.trigger !== undefined ? { trigger: run.trigger } : {}),
    ...(run.workItem !== undefined ? { workItem: run.workItem } : {}),
    ...(continues !== undefined ? { continues } : {}),
  };
}
