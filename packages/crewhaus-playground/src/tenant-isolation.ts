/**
 * Cross-tenant isolation for the playground server.
 *
 * Two anonymous browsers share a single backend deployment. We mint
 * each one a session id at first contact, then prefix every server-
 * generated identifier (run ids, spec store keys, trace fetch tokens)
 * with that session id. Lookups must come back through this layer so
 * a malicious tab can't request another tab's run output by guessing
 * the run id.
 */
import { CrewhausError } from "@crewhaus/errors";

export class PlaygroundTenantError extends CrewhausError {
  override readonly name = "PlaygroundTenantError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type SessionScope = {
  /** Opaque session id (e.g. cookie / OAuth subject). */
  readonly sessionId: string;
};

const SCOPE_RE = /^([a-zA-Z0-9_-]{8,128}):([a-zA-Z0-9_-]+)$/;

/** Wrap a runtime-minted run id in `<sessionId>:<runId>`. */
export function scopeRunId(scope: SessionScope, runId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(scope.sessionId)) {
    throw new PlaygroundTenantError(`invalid sessionId: ${scope.sessionId}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new PlaygroundTenantError(`invalid runId: ${runId}`);
  }
  return `${scope.sessionId}:${runId}`;
}

export function parseRunIdScope(scoped: string): { sessionId: string; runId: string } | null {
  const m = SCOPE_RE.exec(scoped);
  if (!m) return null;
  return { sessionId: m[1] ?? "", runId: m[2] ?? "" };
}

export type IsolatedRunStore<TRunRecord> = {
  put(scope: SessionScope, runId: string, record: TRunRecord): string;
  /** Returns null when the requesting scope does not match the stored scope. */
  get(scope: SessionScope, scopedId: string): TRunRecord | null;
  list(scope: SessionScope): readonly { id: string; record: TRunRecord }[];
};

/** In-memory implementation used by the smoke + tests. Production wraps Redis. */
export function isolatedRunStore<TRunRecord>(): IsolatedRunStore<TRunRecord> {
  const store = new Map<string, { sessionId: string; record: TRunRecord }>();
  return {
    put(scope, runId, record) {
      const scoped = scopeRunId(scope, runId);
      store.set(scoped, { sessionId: scope.sessionId, record });
      return scoped;
    },
    get(scope, scopedId) {
      const entry = store.get(scopedId);
      if (!entry) return null;
      if (entry.sessionId !== scope.sessionId) return null;
      return entry.record;
    },
    list(scope) {
      const out: { id: string; record: TRunRecord }[] = [];
      for (const [id, entry] of store.entries()) {
        if (entry.sessionId === scope.sessionId) out.push({ id, record: entry.record });
      }
      return out;
    },
  };
}
