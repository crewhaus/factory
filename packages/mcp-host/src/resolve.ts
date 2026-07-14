/**
 * 0.3.0 — boot-time resolution of secret-ref-shaped MCP server configs.
 *
 * The compiler lowers `mcp_servers` stdio `env` / sse `headers` VALUES to
 * `IrSecretRef`-shaped objects (`{ kind: "literal", value }` |
 * `{ kind: "env", name }`) so real secrets never land in compiled
 * artifacts. Emitted bundles (and the `crewhaus run` interpreter) embed
 * that unresolved config verbatim and call `resolveMcpServerConfig` at
 * process start to materialise the plain-string shape the SDK transports
 * need. Resolution therefore happens against the RUNNING process's
 * environment, not the compile machine's.
 *
 * The types here are structural mirrors of `IrSecretRef` /
 * `IrMcpServerConfig` from `@crewhaus/ir` — duplicated deliberately so the
 * runtime package stays free of a compile-time IR dependency (the same
 * stance `McpServerConfig` itself takes). TypeScript's structural typing
 * keeps the two in lockstep at every call site.
 *
 * Documented seam — secrets-manager: `@crewhaus/secrets-manager`'s
 * backends (env-var / file / vault, with rotation + audit) expose an async
 * `get(name): Promise<string>`, which does not fit this synchronous boot
 * path (`McpHost.addServer` is sync, and emitted boot blocks resolve
 * inline). Callers that want vault/file-backed resolution pre-resolve
 * through secrets-manager and hand the materialised values in via
 * `opts.env` (e.g. `{ [name]: await secrets.get(name) }`); the default is
 * a direct `process.env` read, which matches secrets-manager's env-var
 * backend semantics (missing OR empty ⇒ error).
 */
import { ConfigError } from "@crewhaus/errors";
import type { McpServerConfig, SseServerConfig, StdioServerConfig } from "./types.js";

/** Structural mirror of `@crewhaus/ir`'s `IrSecretRef`. */
export type McpSecretRef =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "env"; readonly name: string };

/**
 * A map value that still needs resolving. Plain strings are accepted and
 * passed through so hand-rolled configs keep working and resolution is
 * idempotent (`resolveMcpServerConfig(resolveMcpServerConfig(c)) ≡` once).
 */
export type McpSecretLike = string | McpSecretRef;

export type UnresolvedStdioServerConfig = {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, McpSecretLike>>;
};

export type UnresolvedSseServerConfig = {
  readonly transport: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, McpSecretLike>>;
};

export type UnresolvedMcpServerConfig = UnresolvedStdioServerConfig | UnresolvedSseServerConfig;

export type ResolveSecretRefOptions = {
  /**
   * Environment record consulted for `{ kind: "env" }` refs. Default:
   * `process.env`. Inject for tests, or to pre-resolve through
   * `@crewhaus/secrets-manager` (see the module docstring).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Context prefix for error messages, e.g. `mcp server "thredz" env
   * THREDZ_API_KEY`. Purely diagnostic.
   */
  readonly what?: string;
};

/**
 * Resolve one secret ref to its plain-string value. `literal` returns the
 * embedded value; `env` reads the named variable, throwing a `ConfigError`
 * that names the missing variable (missing and empty are both errors —
 * matching secrets-manager's env-var backend) so a misconfigured harness
 * fails fast at boot instead of shipping an empty credential to a child
 * process or remote server.
 */
export function resolveSecretRef(ref: McpSecretLike, opts: ResolveSecretRefOptions = {}): string {
  if (typeof ref === "string") return ref;
  if (ref.kind === "literal") return ref.value;
  const env = opts.env ?? process.env;
  const value = env[ref.name];
  if (value === undefined || value === "") {
    const where = opts.what !== undefined ? ` (required by ${opts.what})` : "";
    throw new ConfigError(
      `environment variable ${ref.name} is not set${where} — export it before launching, e.g. \`export ${ref.name}=…\``,
    );
  }
  return value;
}

export type ResolveMcpServerConfigOptions = {
  /** See {@link ResolveSecretRefOptions.env}. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Server name, used only to contextualise error messages. */
  readonly name?: string;
};

/**
 * Resolve every env/header value of an unresolved MCP server config into
 * the plain-string `McpServerConfig` the SDK transports consume. Throws
 * `ConfigError` (naming the variable AND the server/field) on the first
 * unresolvable `{ kind: "env" }` ref.
 */
export function resolveMcpServerConfig(
  config: UnresolvedMcpServerConfig,
  opts: ResolveMcpServerConfigOptions = {},
): McpServerConfig {
  const serverLabel =
    opts.name !== undefined ? `mcp server ${JSON.stringify(opts.name)}` : "mcp server";
  if (config.transport === "stdio") {
    const resolved: StdioServerConfig = {
      transport: "stdio",
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.env !== undefined
        ? { env: resolveSecretMap(config.env, `${serverLabel} env`, opts.env) }
        : {}),
    };
    return resolved;
  }
  const resolved: SseServerConfig = {
    transport: "sse",
    url: config.url,
    ...(config.headers !== undefined
      ? { headers: resolveSecretMap(config.headers, `${serverLabel} header`, opts.env) }
      : {}),
  };
  return resolved;
}

function resolveSecretMap(
  map: Readonly<Record<string, McpSecretLike>>,
  labelPrefix: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(map)) {
    out[key] = resolveSecretRef(ref, {
      what: `${labelPrefix} ${key}`,
      ...(env !== undefined ? { env } : {}),
    });
  }
  return out;
}
