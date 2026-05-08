import type { AuditLog } from "@crewhaus/audit-log";
/**
 * Section 27 — `secrets-manager`. Pluggable secret storage with rotation
 * callbacks and audit-log integration. Three backends:
 *  - **env-var** (default; rotation is a no-op + warning)
 *  - **file** (reads from `.crewhaus/secrets/<name>`; rotation = atomic rewrite)
 *  - **vault** (HashiCorp Vault HTTP API, KV v2 backend)
 *
 * Long-running daemons (CHN gateway, MGD gateway, RES daemon) subscribe to
 * `onRotation(handler)` so they refresh in-flight credentials without
 * restart. Every `get` and `rotate` is audit-logged when a tenant id is
 * configured.
 */
import { CrewhausError } from "@crewhaus/errors";
import { createEnvVarBackend } from "./backends/env-var";
import { createFileBackend } from "./backends/file";
import { createVaultBackend } from "./backends/vault";

export class SecretsError extends CrewhausError {
  override readonly name = "SecretsError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type SecretValue = string;

export type RotationHandler = (event: {
  readonly name: string;
  readonly newValue: SecretValue;
  readonly rotatedAt: number;
}) => void | Promise<void>;

export interface SecretsBackend {
  readonly id: "env-var" | "file" | "vault";
  /** Returns the current value, or throws SecretsError if missing. */
  get(name: string): Promise<SecretValue>;
  /**
   * Rotate the named secret. Implementations may generate a new value or
   * accept an externally-supplied one via `opts.newValue`. Returns the
   * new value so callers can verify the rotation took.
   */
  rotate(name: string, opts?: { readonly newValue?: SecretValue }): Promise<SecretValue>;
  /** Optional health check. Returns the names this backend can resolve. */
  list?(): Promise<ReadonlyArray<string>>;
}

export interface Secrets {
  /** Resolve the named secret. Audit-logs the access when tenantId is set. */
  get(name: string): Promise<SecretValue>;
  /**
   * Rotate the named secret, fire all `onRotation` handlers, and audit-log
   * the rotation when tenantId is set. Returns the new value.
   */
  rotate(name: string, opts?: { readonly newValue?: SecretValue }): Promise<SecretValue>;
  /** Subscribe to rotation events. Returns an unsubscribe function. */
  onRotation(handler: RotationHandler): () => void;
  /** Switch to a fresh backend. Used by tests + the doctor command. */
  doctor(): Promise<DoctorReport>;
  /** Backend identifier for diagnostics. */
  readonly backendId: SecretsBackend["id"];
}

export type DoctorReport = {
  readonly backend: SecretsBackend["id"];
  readonly available: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  /** Rotation TTLs known to be due (file/vault track this; env-var returns []). */
  readonly rotationDue: ReadonlyArray<string>;
};

export type CreateSecretsOptions = {
  readonly backend: SecretsBackend;
  readonly auditLog?: AuditLog;
  readonly tenantId?: string;
  /** Names to validate in `doctor()`. */
  readonly knownSecrets?: ReadonlyArray<string>;
};

export function createSecrets(opts: CreateSecretsOptions): Secrets {
  const handlers = new Set<RotationHandler>();
  return {
    backendId: opts.backend.id,

    async get(name): Promise<SecretValue> {
      const value = await opts.backend.get(name);
      if (opts.auditLog && opts.tenantId !== undefined) {
        await opts.auditLog.append({
          kind: "secrets_access",
          payload: { tenantId: opts.tenantId, name, backend: opts.backend.id },
        });
      }
      return value;
    },

    async rotate(name, rotateOpts): Promise<SecretValue> {
      const newValue = await opts.backend.rotate(name, rotateOpts);
      const rotatedAt = Date.now();
      if (opts.auditLog && opts.tenantId !== undefined) {
        await opts.auditLog.append({
          kind: "secrets_rotation",
          payload: {
            tenantId: opts.tenantId,
            name,
            backend: opts.backend.id,
            rotatedAt,
          },
        });
      }
      // Fire handlers in order. A handler that throws does not block siblings.
      const event = { name, newValue, rotatedAt };
      const promises: Array<Promise<void>> = [];
      for (const h of handlers) {
        try {
          const result = h(event);
          if (result && typeof (result as Promise<void>).then === "function") {
            promises.push(
              (result as Promise<void>).catch(() => {
                /* swallow per-handler errors */
              }),
            );
          }
        } catch {
          /* swallow per-handler errors */
        }
      }
      await Promise.all(promises);
      return newValue;
    },

    onRotation(h): () => void {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },

    async doctor(): Promise<DoctorReport> {
      const known = opts.knownSecrets ?? [];
      const available: string[] = [];
      const missing: string[] = [];
      for (const name of known) {
        try {
          await opts.backend.get(name);
          available.push(name);
        } catch {
          missing.push(name);
        }
      }
      return {
        backend: opts.backend.id,
        available,
        missing,
        rotationDue: [],
      };
    },
  };
}

// Re-export backends so callers can construct directly.
export { createEnvVarBackend, createFileBackend, createVaultBackend };
