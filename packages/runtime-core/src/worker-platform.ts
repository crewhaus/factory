/**
 * runtime-core — the NODE {@link WorkerPlatform} implementation.
 *
 * G12 splits the agent loop into a platform-neutral core
 * (`@crewhaus/worker-runtime`, which imports no `node:*`) and the host
 * services that surround it. On the edge those services are a stateless
 * `WorkerPlatform` the cf-worker bundle constructs; on Node THIS module is the
 * platform — `Date.now()` for the clock, `node:crypto` for ids, the global
 * `fetch`, and (optionally) an in-memory KV — so the same
 * {@link runWorkerLoop} core runs unchanged in a Node process.
 *
 * runtime-core keeps its own richer node-coupled services (event log, session
 * store, compaction, recovery, audit sinks) around `runChatLoop`; this
 * platform is the seam through which a Node caller drives the *shared* core
 * (e.g. to exercise the exact loop a cf-worker will run) without reaching for
 * the edge globals directly.
 */
import { randomUUID } from "node:crypto";
import type { KVLike, WorkerPlatform } from "@crewhaus/worker-runtime";

/**
 * Build a Node-backed {@link WorkerPlatform}. `overrides` win over the
 * defaults (tests inject a fixed clock / deterministic id / scripted fetch;
 * production callers may pass a durable `storage`).
 */
export function createNodeWorkerPlatform(overrides: Partial<WorkerPlatform> = {}): WorkerPlatform {
  return {
    now: () => Date.now(),
    randomId: () => randomUUID(),
    // Bind to globalThis so the reference stays valid when destructured, and
    // undici's `fetch` keeps its receiver.
    fetch: globalThis.fetch.bind(globalThis),
    ...overrides,
  };
}

/**
 * A process-local {@link KVLike} backed by a `Map` — a convenience for tests,
 * single-process daemons, and the Node platform's optional `storage` slot.
 * TTL is honoured against `Date.now()`; it is NOT durable across restarts (a
 * real deployment wires Cloudflare KV, a Durable Object, or a database here).
 */
export function createInMemoryKV(): KVLike {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  return {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(
      key: string,
      value: string,
      options?: { readonly expirationTtl?: number },
    ): Promise<void> {
      store.set(key, {
        value,
        ...(options?.expirationTtl !== undefined
          ? { expiresAt: Date.now() + options.expirationTtl * 1000 }
          : {}),
      });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}
