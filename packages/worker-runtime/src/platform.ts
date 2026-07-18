/**
 * @crewhaus/worker-runtime — the injected-platform seam.
 *
 * The loop core in this package touches NO ambient host capability. Every
 * source of non-determinism or I/O — the clock, unique-id generation,
 * outbound HTTP, and durable key/value storage — arrives through a single
 * {@link WorkerPlatform} value the caller constructs for its environment.
 *
 * WHY (Cloudflare Workers): a compiled CrewHaus worker runs on the edge,
 * where `Date.now()` is frozen outside an I/O boundary (a spectre
 * mitigation) and `Math.random()` must never seed anything security-bearing.
 * A loop that reaches for those globals directly is both non-portable and
 * subtly broken on the very target this package exists to serve — so both
 * are FORBIDDEN in this package (a source-grep test enforces it) and the
 * runtime reads `platform.now()` / `platform.randomId()` instead.
 */

/**
 * The minimal durable key/value surface the loop needs for pending-approval
 * parking and tool-call idempotency. Deliberately a subset of the Cloudflare
 * Workers KV binding (and trivially satisfiable by an in-memory `Map` in
 * tests or a Durable Object's storage): the loop never assumes list, TTL
 * metadata, or transactions.
 *
 * OPTIONAL on {@link WorkerPlatform}: a stateless worker (request→response,
 * no binding) omits it, and the loop degrades to no parking / no
 * idempotency rather than failing to boot.
 */
export interface KVLike {
  get(key: string): Promise<string | null>;
  /**
   * `expirationTtl` is seconds-from-now, matching the Cloudflare KV binding.
   * Backends without TTL support MAY ignore it.
   */
  put(key: string, value: string, options?: { readonly expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The platform capabilities the worker loop is parameterised over. One value,
 * constructed once per environment, threaded into {@link runWorkerLoop}.
 *
 * A stateless Cloudflare Worker builds it as:
 * ```ts
 * const platform: WorkerPlatform = {
 *   now: () => Date.now(),            // resolved at the call site, never inside the loop
 *   randomId: () => crypto.randomUUID(),
 *   fetch: fetch.bind(globalThis),
 *   // storage omitted — stateless
 * };
 * ```
 * A stateful worker additionally passes `storage: env.APPROVALS_KV`.
 */
export interface WorkerPlatform {
  /**
   * Milliseconds since the Unix epoch. The loop reads this at every turn
   * boundary for deadline enforcement and trace timestamps. Injected — the
   * package NEVER calls `Date.now()` itself (see the module docblock).
   */
  now(): number;
  /**
   * A fresh unique identifier (run id, span id, idempotency key). Injected —
   * the package NEVER calls `Math.random()` itself. Typically
   * `crypto.randomUUID()`; any collision-resistant string is acceptable.
   */
  randomId(): string;
  /**
   * Durable key/value storage for pending-approval persistence and tool
   * idempotency. Absent on stateless workers → those features no-op.
   */
  storage?: KVLike;
  /**
   * The `fetch` implementation used for every model call (and by
   * fetch-backed tools). Injected rather than closed over the global so the
   * loop is drivable from a scripted transport in tests and portable across
   * runtimes whose global `fetch` differs.
   */
  fetch: typeof fetch;
}
