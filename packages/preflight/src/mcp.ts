/**
 * MCP dry-run: predict, without spawning anything, exactly how a compiled
 * bundle's boot-time `resolveMcpServerConfig` call will behave for every
 * `mcp_servers` entry in the spec.
 *
 * Three finding classes:
 *
 *   - BLOCKING — an env-ref (`$UPPER_SNAKE` value) whose variable is unset
 *     in the injected env. The bundle's boot resolves refs through
 *     `@crewhaus/mcp-host`, which throws a `ConfigError` naming the
 *     variable; we call the same resolver so the predicted message is the
 *     byte-identical one the boot would die with.
 *   - BLOCKING — a credential-shaped key (`*_KEY`/`*_TOKEN`/`*_SECRET`/
 *     `*_PASSWORD`, or the `Authorization`/`x-api-key` headers) whose value
 *     starts with `$` but is not a valid reference: compilation itself
 *     fails on these, so no daemon can exist.
 *   - WARN — a literal that still looks like a shell variable
 *     (`$foo`, `${FOO}`): the MCP transports NEVER expand `$…` values, so
 *     the string ships verbatim and fails only at runtime auth. Also WARN —
 *     a plain literal pasted into a credential-shaped key (the secret is
 *     baked into the spec and every compiled artifact; prefer a $ENV ref).
 */

import { ConfigError } from "@crewhaus/errors";
import { resolveSecretRef } from "@crewhaus/mcp-host";
import {
  CREDENTIAL_HEADER_NAMES,
  CREDENTIAL_SHAPED_KEY_RE,
  ENV_REF_RE,
  UNPARSED_ENV_REF_RE,
  isMalformedEnvRef,
  lowerSecretString,
  malformedEnvRefMessage,
} from "./secret-grammar";
import type { PreflightEnv, PreflightItem } from "./types";

/** Structural subset of the spec's `mcp_servers` block (raw, pre-lowering:
 *  env/header values are plain strings). */
export type McpServersSpec = Readonly<
  Record<
    string,
    | {
        readonly transport: "stdio";
        readonly command: string;
        readonly args?: readonly string[];
        readonly env?: Readonly<Record<string, string>>;
        /** #406 — `required: false` marks the server optional. */
        readonly required?: boolean;
      }
    | {
        readonly transport: "sse";
        readonly url: string;
        readonly headers?: Readonly<Record<string, string>>;
        /** #406 — `required: false` marks the server optional. */
        readonly required?: boolean;
      }
  >
>;

function credentialShaped(key: string, kind: "env" | "header"): boolean {
  return (
    CREDENTIAL_SHAPED_KEY_RE.test(key) ||
    (kind === "header" && CREDENTIAL_HEADER_NAMES.has(key.toLowerCase()))
  );
}

function dryRunValue(
  server: string,
  kind: "env" | "header",
  key: string,
  raw: string,
  env: PreflightEnv,
  optional: boolean,
): PreflightItem | undefined {
  const id = `mcp.${server}.${kind}.${key}`;
  const what = `mcp server ${JSON.stringify(server)} ${kind} ${key}`;
  const isCredential = credentialShaped(key, kind);

  // Compile-time rejection: malformed `$…` on a credential-shaped key.
  if (isCredential && isMalformedEnvRef(raw)) {
    return {
      id,
      area: "mcp",
      level: "blocking",
      message: `compilation will fail: ${malformedEnvRefMessage(`mcp_servers.${server}.${kind === "env" ? "env" : "headers"}.${key}`, raw)}`,
    };
  }

  const ref = lowerSecretString(raw);
  if (ref.kind === "env") {
    // Same resolver the bundle's boot runs — the predicted ConfigError
    // message is the one the process would die with.
    try {
      resolveSecretRef(ref, { env, what });
      return {
        id,
        area: "mcp",
        level: "info",
        message: `${what}: $${ref.name} resolves`,
        envVar: ref.name,
      };
    } catch (err) {
      const message = err instanceof ConfigError ? err.message : String(err);
      // #406 — an OPTIONAL server's unresolvable ref DEGRADES at boot
      // (registerOptionalMcpServer warns and skips the server) instead of
      // killing the process, so the finding is a warn, not a blocker.
      if (optional) {
        return {
          id,
          area: "mcp",
          level: "warn",
          message: `optional server will be skipped: ${message}`,
          remediation: `export ${ref.name}=… before launching`,
          envVar: ref.name,
        };
      }
      return {
        id,
        area: "mcp",
        level: "blocking",
        message: `will not boot: ${message}`,
        remediation: `export ${ref.name}=… before launching`,
        envVar: ref.name,
      };
    }
  }

  // Literal that still looks like a shell variable — never expanded.
  if (UNPARSED_ENV_REF_RE.test(raw.trim()) && !ENV_REF_RE.test(raw.trim())) {
    return {
      id,
      area: "mcp",
      level: "warn",
      message: `${what} is the literal ${JSON.stringify(raw)} — a leading "$" is NOT expanded by the MCP transports; use a $UPPER_SNAKE env-ref (the compiler lowers those) or resolve it through a secrets backend`,
    };
  }

  // Plain literal pasted into a credential-shaped key.
  if (isCredential) {
    return {
      id,
      area: "mcp",
      level: "warn",
      message: `${what} is an inline literal — prefer a $ENV ref so the credential stays out of the spec and compiled bundles`,
    };
  }

  return undefined;
}

/**
 * Dry-run every `mcp_servers` entry against `env`. Order is deterministic:
 * servers in declaration order, then env keys, then header keys.
 */
export function mcpDryRunItems(
  mcpServers: McpServersSpec | undefined,
  env: PreflightEnv,
): PreflightItem[] {
  if (mcpServers === undefined) return [];
  const items: PreflightItem[] = [];
  for (const [server, config] of Object.entries(mcpServers)) {
    // #406 — surface the optional contract where the operator reads boot
    // predictions: a failed boot (unreachable peer or unresolvable config)
    // degrades, and the server's tools are absent until it connects.
    const optional = config.required === false;
    if (optional) {
      items.push({
        id: `mcp.${server}.optional`,
        area: "mcp",
        level: "info",
        message: `mcp server ${JSON.stringify(server)} is optional (required: false) — a failed boot degrades: the run continues without its tools until the server connects`,
      });
    }
    if (config.transport === "stdio") {
      for (const [key, raw] of Object.entries(config.env ?? {})) {
        const item = dryRunValue(server, "env", key, raw, env, optional);
        if (item !== undefined) items.push(item);
      }
    } else {
      for (const [key, raw] of Object.entries(config.headers ?? {})) {
        const item = dryRunValue(server, "header", key, raw, env, optional);
        if (item !== undefined) items.push(item);
      }
    }
  }
  return items;
}
