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
 * Loop contract 0.4 (Batch G, G75) — the async secret backend an MCP boot
 * routes through when one is configured. A structural `{ get(name):
 * Promise<string> }` so `@crewhaus/mcp-host` stays free of a hard dependency
 * on `@crewhaus/secrets-manager` (the same duplicate-the-shape stance the
 * rest of this module takes); secrets-manager's `Secrets` satisfies it
 * directly. Resolution order for a `{ kind: "env", name }` ref is
 * secrets-backend FIRST, then the `process.env` (or injected `env`) fallback.
 */
export interface SecretsResolver {
  get(name: string): Promise<string>;
}

/**
 * A plain literal / hand-written string that STILL looks like an unexpanded
 * shell variable (`$FOO` or `${FOO}`). The compiler lowers real `env` refs to
 * `{ kind: "env" }`, so a surviving `$…` literal means the value was
 * hand-authored and will be shipped VERBATIM — the transports never expand
 * it. G75 warns rather than silently forwarding a broken credential.
 */
const UNPARSED_ENV_REF = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

export type ResolveSecretRefAsyncOptions = ResolveSecretRefOptions & {
  /** Async secret backend consulted first for `{ kind: "env" }` refs. */
  readonly secrets?: SecretsResolver;
  /** Warning sink for unparsed `$…` literals. Default: a `[mcp]` stderr line. */
  readonly onWarn?: (message: string) => void;
};

function warnIfUnparsedDollar(value: string, opts: ResolveSecretRefAsyncOptions): void {
  if (!UNPARSED_ENV_REF.test(value.trim())) return;
  const warn =
    opts.onWarn ?? ((m: string): void => void process.stderr.write(`[mcp] warning: ${m}\n`));
  const where = opts.what !== undefined ? `${opts.what} ` : "";
  const literal = JSON.stringify(value);
  warn(
    `${where}is the literal ${literal} — a leading "$" is NOT expanded by the MCP transports; use an env-ref (the compiler lowers env-name values) or resolve it through a secrets backend`,
  );
}

/**
 * Loop contract 0.4 (Batch G, G75) — async twin of {@link resolveSecretRef}.
 * A `{ kind: "env", name }` ref is resolved through the configured
 * `secrets` backend first (its async `get`, e.g. vault/file-backed), then
 * falls back to the synchronous `process.env`/`env` read (which throws,
 * naming the variable, when the fallback is also unset — so a misconfigured
 * boot still fails fast). `literal`/plain-string values pass through, but a
 * value that still looks like an unexpanded `$FOO`/`${FOO}` triggers a G75
 * warning. A secrets-backend miss (throw OR empty) is not fatal on its own —
 * it degrades to the env fallback, matching the env-var backend's semantics.
 */
export async function resolveSecretRefAsync(
  ref: McpSecretLike,
  opts: ResolveSecretRefAsyncOptions = {},
): Promise<string> {
  if (typeof ref === "string") {
    warnIfUnparsedDollar(ref, opts);
    return ref;
  }
  if (ref.kind === "literal") {
    warnIfUnparsedDollar(ref.value, opts);
    return ref.value;
  }
  if (opts.secrets !== undefined) {
    try {
      const value = await opts.secrets.get(ref.name);
      if (value !== "") return value;
    } catch {
      // Backend miss (missing/unavailable) — degrade to the env fallback
      // below rather than failing the whole boot on the backend alone.
    }
  }
  return resolveSecretRef(ref, opts);
}

export type ResolveMcpServerConfigAsyncOptions = ResolveMcpServerConfigOptions & {
  /** See {@link ResolveSecretRefAsyncOptions.secrets}. */
  readonly secrets?: SecretsResolver;
  /** See {@link ResolveSecretRefAsyncOptions.onWarn}. */
  readonly onWarn?: (message: string) => void;
};

/**
 * Loop contract 0.4 (Batch G, G75) — async twin of
 * {@link resolveMcpServerConfig}. Every env/header value resolves through
 * {@link resolveSecretRefAsync}, so a configured `secrets` backend (async,
 * pre-boot) takes precedence over `process.env`, with the env read as the
 * fallback. Use this from a boot path that has a secrets backend wired; the
 * sync `resolveMcpServerConfig` remains for the plain env-only path.
 */
export async function resolveMcpServerConfigAsync(
  config: UnresolvedMcpServerConfig,
  opts: ResolveMcpServerConfigAsyncOptions = {},
): Promise<McpServerConfig> {
  const serverLabel =
    opts.name !== undefined ? `mcp server ${JSON.stringify(opts.name)}` : "mcp server";
  const passthrough: Omit<ResolveSecretRefAsyncOptions, "what"> = {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
    ...(opts.onWarn !== undefined ? { onWarn: opts.onWarn } : {}),
  };
  if (config.transport === "stdio") {
    const resolved: StdioServerConfig = {
      transport: "stdio",
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.env !== undefined
        ? { env: await resolveSecretMapAsync(config.env, `${serverLabel} env`, passthrough) }
        : {}),
    };
    return resolved;
  }
  const resolved: SseServerConfig = {
    transport: "sse",
    url: config.url,
    ...(config.headers !== undefined
      ? {
          headers: await resolveSecretMapAsync(
            config.headers,
            `${serverLabel} header`,
            passthrough,
          ),
        }
      : {}),
  };
  return resolved;
}

async function resolveSecretMapAsync(
  map: Readonly<Record<string, McpSecretLike>>,
  labelPrefix: string,
  passthrough: Omit<ResolveSecretRefAsyncOptions, "what">,
): Promise<Readonly<Record<string, string>>> {
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(map)) {
    out[key] = await resolveSecretRefAsync(ref, {
      ...passthrough,
      what: `${labelPrefix} ${key}`,
    });
  }
  return out;
}

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
