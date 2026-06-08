/**
 * file backend — reads `<rootDir>/<name>` (mode 0o600 enforced on write).
 * Rotation is an atomic rewrite: write to `.<name>.tmp`, then rename.
 *
 * The file content is the raw secret value (no JSON wrapper, no
 * trailing newline-stripping ambiguity). Whitespace is preserved as-is
 * for tokens that may legitimately contain it.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SecretValue, type SecretsBackend, SecretsError } from "../index";

export type FileBackendOptions = {
  /** Default: `.crewhaus/secrets`. */
  readonly rootDir: string;
};

export function createFileBackend(opts: FileBackendOptions): SecretsBackend {
  const rootDir = opts.rootDir;

  function pathFor(name: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new SecretsError("invalid secret name (must match [A-Za-z0-9_.-]+)");
    }
    return join(rootDir, name);
  }

  return {
    id: "file",
    async get(name: string): Promise<SecretValue> {
      const p = pathFor(name);
      if (!existsSync(p)) {
        throw new SecretsError("secret file read failed (not found)");
      }
      return readFileSync(p, "utf8");
    },
    async rotate(name: string, rotateOpts): Promise<SecretValue> {
      const p = pathFor(name);
      const newValue = rotateOpts?.newValue ?? generateRandomSecret();
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, newValue, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, p);
      return newValue;
    },
    async list(): Promise<ReadonlyArray<string>> {
      if (!existsSync(rootDir)) return [];
      return readdirSync(rootDir).filter((f) => !f.endsWith(".tmp") && !f.startsWith("."));
    },
  };
}

function generateRandomSecret(): string {
  // 32 bytes hex → 64 chars; sufficient for tokens.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
