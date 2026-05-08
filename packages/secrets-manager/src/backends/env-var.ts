/**
 * env-var backend — the default. `rotate()` is a no-op (the OS owns the
 * env, not us); a logger warning is emitted when one is supplied so the
 * caller knows the rotation didn't really happen.
 */
import type { Logger } from "@crewhaus/logging";
import { type SecretValue, type SecretsBackend, SecretsError } from "../index";

export type EnvVarBackendOptions = {
  /** Default: `process.env`. Override for tests. */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
};

export function createEnvVarBackend(opts: EnvVarBackendOptions = {}): SecretsBackend {
  const env = opts.env ?? process.env;
  return {
    id: "env-var",
    async get(name: string): Promise<SecretValue> {
      const value = env[name];
      if (value === undefined || value === "") {
        throw new SecretsError(`secret "${name}" not found in env (env-var backend)`);
      }
      return value;
    },
    async rotate(name: string, rotateOpts): Promise<SecretValue> {
      // env-var is read-only at the secrets layer; rotation requires
      // restarting the process with new env. We accept an explicit
      // newValue so callers can model "I just exported $NAME" — but we
      // can't actually mutate the parent process's env.
      if (rotateOpts?.newValue !== undefined) {
        env[name] = rotateOpts.newValue;
      }
      if (opts.logger) {
        opts.logger.warn("secrets.rotate.env-var.no-op", {
          name,
          msg: "env-var backend does not own rotation; rotate at the orchestrator instead",
        });
      }
      const v = env[name];
      if (v === undefined) {
        throw new SecretsError(
          `secret "${name}" cannot be rotated via env-var backend without a newValue`,
        );
      }
      return v;
    },
    async list(): Promise<ReadonlyArray<string>> {
      return Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== "");
    },
  };
}
