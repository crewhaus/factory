/**
 * vault backend — HashiCorp Vault KV v2 over HTTP. Reads
 * `<addr>/v1/<mount>/data/<name>` and writes via PUT to the same path.
 *
 * Auth: token via `VAULT_TOKEN` (or constructor option). The simplest
 * path that doesn't need approles or k8s service accounts.
 */
import { type SecretValue, type SecretsBackend, SecretsError } from "../index";

export type VaultBackendOptions = {
  /** Vault address (e.g. `http://127.0.0.1:8200`). */
  readonly addr: string;
  /** KV v2 mount point (default: `secret`). */
  readonly mount?: string;
  /** Vault token. Falls back to `VAULT_TOKEN` env. */
  readonly token?: string;
  /** Optional fetch override for tests. */
  readonly fetchImpl?: typeof fetch;
};

export function createVaultBackend(opts: VaultBackendOptions): SecretsBackend {
  const mount = opts.mount ?? "secret";
  const fetchImpl = opts.fetchImpl ?? fetch;

  function getToken(): string {
    const t = opts.token ?? process.env["VAULT_TOKEN"];
    if (!t) {
      throw new SecretsError(
        "vault backend requires a token (constructor opts.token or VAULT_TOKEN env)",
      );
    }
    return t;
  }

  function dataUrl(name: string): string {
    if (!/^[A-Za-z0-9_/.-]+$/.test(name)) {
      throw new SecretsError(`invalid secret name "${name}" for vault backend`);
    }
    return `${opts.addr}/v1/${encodeURIComponent(mount)}/data/${name}`;
  }

  return {
    id: "vault",
    async get(name: string): Promise<SecretValue> {
      const url = dataUrl(name);
      const res = await fetchImpl(url, {
        headers: { "X-Vault-Token": getToken() },
      });
      if (res.status === 404) {
        throw new SecretsError(`secret "${name}" not found in vault at ${url}`);
      }
      if (!res.ok) {
        throw new SecretsError(`vault GET ${name} returned ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as { data?: { data?: { value?: string } } };
      const v = body?.data?.data?.value;
      if (typeof v !== "string") {
        throw new SecretsError(
          `vault response for "${name}" missing data.data.value (KV v2 expected)`,
        );
      }
      return v;
    },
    async rotate(name: string, rotateOpts): Promise<SecretValue> {
      const url = dataUrl(name);
      const newValue = rotateOpts?.newValue ?? generateRandomSecret();
      const res = await fetchImpl(url, {
        method: "PUT",
        headers: {
          "X-Vault-Token": getToken(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: { value: newValue } }),
      });
      if (!res.ok) {
        throw new SecretsError(`vault PUT ${name} returned ${res.status}: ${await res.text()}`);
      }
      return newValue;
    },
  };
}

function generateRandomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
