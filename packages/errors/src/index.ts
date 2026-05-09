/**
 * Typed error hierarchy for crewhaus-factory.
 * Catalog F-foundations (`error-types`) — every later layer imports this
 * for structured error reporting instead of throwing raw `Error`s.
 *
 * Each error carries a stable `code` for programmatic dispatch and serializes
 * its full cause chain via `toJSON()` for the logging layer.
 */

export type ErrorCode =
  | "spec_parse"
  | "compiler"
  | "runtime"
  | "config"
  | "tool"
  | "mcp"
  | "adapter"
  | "channel";

export type SerializedError = {
  name: string;
  code: ErrorCode;
  message: string;
  cause?: SerializedError | { name?: string; message: string };
};

export class CrewhausError extends Error {
  override readonly name: string = "CrewhausError";
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
  }

  toJSON(): SerializedError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      cause: serializeCause(this.cause),
    };
  }
}

function serializeCause(cause: unknown): SerializedError["cause"] {
  if (cause === undefined) return undefined;
  if (cause instanceof CrewhausError) return cause.toJSON();
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return { message: String(cause) };
}

export class SpecParseError extends CrewhausError {
  override readonly name = "SpecParseError";
  constructor(message: string, cause?: unknown) {
    super("spec_parse", message, cause);
  }
}

export class CompilerError extends CrewhausError {
  override readonly name = "CompilerError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

export class RuntimeError extends CrewhausError {
  override readonly name = "RuntimeError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export class ConfigError extends CrewhausError {
  override readonly name = "ConfigError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export class McpError extends CrewhausError {
  override readonly name: string = "McpError";
  constructor(message: string, cause?: unknown) {
    super("mcp", message, cause);
  }
}

export class McpConnectionError extends McpError {
  override readonly name = "McpConnectionError";
}

export class McpProtocolError extends McpError {
  override readonly name = "McpProtocolError";
}

/**
 * Section 17 — base for all model-provider adapter failures (auth, request
 * marshalling, stream parsing, network). Carries `providerId` so callers can
 * branch on which adapter raised; `cause` keeps the underlying SDK error
 * accessible via `toJSON()` for the trace/log layer.
 */
export class AdapterError extends CrewhausError {
  override readonly name: string = "AdapterError";
  readonly providerId: string;
  constructor(providerId: string, message: string, cause?: unknown) {
    super("adapter", message, cause);
    this.providerId = providerId;
  }
}

/**
 * Section 17 — missing or invalid credentials for a model provider. Surfaces
 * with a setup hint pointing at the relevant env var.
 */
export class ProviderAuthError extends AdapterError {
  override readonly name = "ProviderAuthError";
}
