/**
 * Catalog R7 `state-store` — tiny zustand-style in-process state container.
 *
 * `createStore<T>(initial)` returns a `Store<T>` exposing `get`, `set`,
 * `subscribe`, and `select`. The root listener fires whenever `set` produces
 * a state where `Object.is(next, prev) === false`. `select(selector)`
 * returns a derived view whose listeners fire only when
 * `Object.is(selector(next), selector(prev)) === false` — referential
 * equality on the selector output, mirroring zustand's
 * `subscribeWithSelector` middleware.
 *
 * Used per-`runChatLoop` invocation as a coordination surface for hooks,
 * skills, and tools (Section 11+). The runtime instantiates one per run
 * and threads it through `RunContext` consumers.
 *
 * Reference: `claude-code/state/store.ts` (40 lines).
 */

export type Store<T> = {
  get(): T;
  set(partial: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(listener: (next: T, prev: T) => void): () => void;
  select<U>(selector: (s: T) => U): SelectorView<U>;
};

export type SelectorView<U> = {
  get(): U;
  subscribe(listener: (next: U, prev: U) => void): () => void;
};

/**
 * Build a fresh state container around `initial`. The container's `set`
 * shallow-merges the supplied partial (or the partial returned by the
 * functional form) into the current state and notifies subscribers iff the
 * merged reference differs from the previous reference (`Object.is`).
 *
 * Listener exceptions are swallowed and reported via `console.error` so a
 * misbehaving subscriber does not poison its siblings — keeps the
 * notification semantics predictable for downstream tools/hooks.
 */
export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = initial;
  const listeners = new Set<(next: T, prev: T) => void>();

  function get(): T {
    return state;
  }

  function set(partial: Partial<T> | ((s: T) => Partial<T>)): void {
    const change = typeof partial === "function" ? partial(state) : partial;
    const next = { ...state, ...change } as T;
    if (Object.is(next, state)) return;
    const prev = state;
    state = next;
    for (const l of listeners) {
      try {
        l(next, prev);
      } catch (err) {
        console.error("state-store: subscriber threw", err);
      }
    }
  }

  function subscribe(listener: (next: T, prev: T) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function select<U>(selector: (s: T) => U): SelectorView<U> {
    return {
      get(): U {
        return selector(state);
      },
      subscribe(listener: (next: U, prev: U) => void): () => void {
        const wrapped = (next: T, prev: T): void => {
          const a = selector(next);
          const b = selector(prev);
          if (Object.is(a, b)) return;
          listener(a, b);
        };
        return subscribe(wrapped);
      },
    };
  }

  return { get, set, subscribe, select };
}
