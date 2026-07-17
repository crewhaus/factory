/**
 * Typed error hierarchy for factory.
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
  // `: string` (not the literal) so subclasses (RunFailedError) can narrow.
  override readonly name: string = "RuntimeError";
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
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor so Bun --coverage counts it as a covered function (field-initializer-only classes can't hit 100% function coverage otherwise)
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class McpProtocolError extends McpError {
  override readonly name = "McpProtocolError";
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor so Bun --coverage counts it as a covered function (field-initializer-only classes can't hit 100% function coverage otherwise)
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
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
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor so Bun --coverage counts it as a covered function (field-initializer-only classes can't hit 100% function coverage otherwise)
  constructor(providerId: string, message: string, cause?: unknown) {
    super(providerId, message, cause);
  }
}

// ---------------------------------------------------------------------------
// v0.3.0 Goal 6 — honest failure messaging (failure-taxonomy core).
// One report shape, one exit-code table, one renderer — shared by
// recovery-engine (which builds reports), runtime-core (which throws them),
// apps/cli, and emitted bundles (which render them). Keep this module
// dependency-free: it is imported by compiled bundle output.
// ---------------------------------------------------------------------------

/**
 * Terminal failure classes a run can die with. Broader than `ErrorCode`
 * (which tags where an error was raised): a `FailureClass` tags *why the run
 * stopped*, in end-user vocabulary, and maps 1:1 onto an exit code.
 */
export type FailureClass =
  | "billing"
  | "auth"
  | "rate_limit"
  | "crewhaus_budget"
  | "timeout"
  /** Loop contract 0.4 (G02) — the spec's in-loop `evaluation:` gate scored
   *  the run's final answer below threshold with `on_fail: halt`. Like
   *  `crewhaus_budget`/`timeout`, this is CrewHaus's OWN configured ceiling
   *  ending the run, not a provider failure. */
  | "evaluation"
  /** Loop contract 0.4 (G11) — a tool permission resolved to `ask` on a
   *  NON-interactive surface with `permissions.ask_mode: "pause"` (the
   *  default) and no prior grant/deny for the call: the runtime persisted a
   *  `PendingApproval`, published `approval_requested`, and PARKED the run
   *  to await an out-of-band decision. Unlike the other 3x-band classes this
   *  is not a hard error — it is a resumable pause; the run re-executes
   *  pre-resolved once the approval is granted (one-shot) or denied. */
  | "approval_pending"
  | "mcp_boot"
  | "context_overflow"
  | "spec"
  | "config"
  | "tool"
  | "unknown";

/**
 * The single structured description of a terminal run failure. `detail`
 * carries the raw provider text (with attribution, e.g. `Anthropic said:
 * "…"`); `remediation` is the one actionable next step; `exitCode` comes
 * from `EXIT_CODES` so fleet / the UI host can dispatch without parsing.
 */
export type FailureReport = {
  readonly class: FailureClass;
  readonly title: string;
  readonly detail: string;
  readonly remediation?: string;
  readonly exitCode: number;
  readonly docsUrl?: string;
};

/**
 * Process exit-code table (documented in CLI-REFERENCE). Everything fatal
 * used to be exit 1; these codes let `fleet run` and the UI host tell
 * "account out of funding" from "bad spec" from "tool crash".
 */
export const EXIT_CODES = {
  /** Clean run. */
  ok: 0,
  /** Unclassified fatal error (the pre-0.3.0 catch-all). */
  generic: 1,
  /** Spec parse / validation failure. */
  spec: 20,
  /** Config / missing-env failure. */
  config: 21,
  /** Provider rejected the credentials at runtime (401/403). */
  auth: 30,
  /** Provider account out of funding (credit balance, insufficient_quota, 402). */
  billing: 31,
  /** Provider quota / rate limit exhausted after retries. */
  rate_limit: 32,
  /** CrewHaus's own configured budget cap ended the run. */
  crewhaus_budget: 33,
  /** Loop contract 0.4 (G10) — a configured wall-clock limit
   *  (`limits.deadline_ms` / `turn_timeout_ms` / `model_call_timeout_ms`)
   *  ended the run. Sits in the 3x band beside `crewhaus_budget`: like the
   *  spend cap, it is CrewHaus's OWN configured ceiling, not a provider
   *  failure. */
  timeout: 34,
  /** Loop contract 0.4 (G02) — the spec's in-loop `evaluation:` gate failed
   *  the final answer with `on_fail: halt`. Same 3x band rationale: a
   *  CrewHaus-configured quality floor, not a provider failure. */
  evaluation: 35,
  /** Loop contract 0.4 (G11) — the run PARKED on a headless tool-approval
   *  ask (`permissions.ask_mode: "pause"`). Sits in the 3x band beside the
   *  other CrewHaus-configured stops: a resumable pause awaiting an
   *  out-of-band grant/deny, distinguishable from a hard failure so `fleet`
   *  / the UI host can surface "needs approval" and resume rather than alert. */
  approval_pending: 36,
  /** Tool or MCP failure (including MCP boot). */
  tool: 40,
} as const;

/**
 * Terminal error carrying a `FailureReport`. Thrown by runtime-core when the
 * recovery engine returns a `halt` action. Extends `RuntimeError` so every
 * existing `instanceof CrewhausError` catch (e.g. `crewhaus run`'s die()
 * routing) keeps working unchanged; PR 3 upgrades those catch sites to
 * render the report and exit with `report.exitCode`.
 */
export class RunFailedError extends RuntimeError {
  override readonly name = "RunFailedError";
  readonly report: FailureReport;

  constructor(report: FailureReport, cause?: unknown) {
    super(`run stopped — ${report.title}: ${report.detail}`, cause);
    this.report = report;
  }
}

/**
 * Render a `FailureReport` as the canonical multi-line failure message:
 *
 *     ✗ run stopped — provider account out of funding
 *       Anthropic said: "Your credit balance is too low to access the Anthropic API."
 *       Fix: add credits at https://console.anthropic.com/settings/billing, then rerun.
 *       (exit 31)
 *
 * `opts.prefix` replaces the leading `✗` (e.g. `crewhaus:` for the CLI).
 * `opts.notes` are surface-specific trailing lines rendered after Fix/Docs
 * and before the exit line (e.g. `crewhaus run`'s "Your session is saved —
 * …" resume hint). Dependency-free by design — emitted bundles inline-import
 * this.
 */
export function formatRunFailure(
  report: FailureReport,
  opts?: { prefix?: string; notes?: readonly string[] },
): string {
  const prefix = opts?.prefix ?? "✗";
  const lines: string[] = [`${prefix} run stopped — ${report.title}`];
  if (report.detail.length > 0) {
    for (const detailLine of report.detail.split("\n")) {
      lines.push(`  ${detailLine}`);
    }
  }
  if (report.remediation !== undefined && report.remediation.length > 0) {
    lines.push(`  Fix: ${report.remediation}`);
  }
  if (report.docsUrl !== undefined && report.docsUrl.length > 0) {
    lines.push(`  Docs: ${report.docsUrl}`);
  }
  for (const note of opts?.notes ?? []) {
    lines.push(`  ${note}`);
  }
  lines.push(`  (exit ${report.exitCode})`);
  return lines.join("\n");
}

/**
 * Is `err` a RunFailedError (or a structurally identical wire twin)? The
 * duck-typed fallback matters for compiled bundles: a bundle and the runtime
 * it embeds can end up with two copies of this package (duplicated install,
 * bundler realm split), in which case `instanceof` lies but the shape —
 * `name === "RunFailedError"` plus a report with a numeric `exitCode` —
 * does not.
 */
export function isRunFailedError(err: unknown): err is RunFailedError {
  if (err instanceof RunFailedError) return true;
  const duck = err as { name?: unknown; report?: { exitCode?: unknown } } | null;
  return (
    duck !== null &&
    typeof duck === "object" &&
    duck.name === "RunFailedError" &&
    typeof duck.report === "object" &&
    duck.report !== null &&
    typeof duck.report.exitCode === "number"
  );
}

/**
 * Coerce any thrown value into a `FailureReport`: a RunFailedError yields
 * its own classified report; everything else synthesizes a best-effort
 * generic report (class `"unknown"`, exit {@link EXIT_CODES.generic}) so
 * every terminal surface — compiled bundles' catch wrappers, daemon mains,
 * `crewhaus run` — renders ONE shape regardless of what escaped.
 */
export function toFailureReport(err: unknown): FailureReport {
  if (isRunFailedError(err)) return err.report;
  const detail = err instanceof Error ? err.message : String(err);
  // A `ConfigError` (missing env var, unresolvable secret ref — e.g. the
  // thredz boot's THREDZ_API_KEY resolution, §4.4) is a classified failure
  // with its own exit code (21), not the generic catch-all. Duck-typed on
  // the stable `code` field so a realm-split copy of this package still
  // classifies.
  const code = (err as { code?: unknown } | null)?.code;
  if (err instanceof Error && code === "config") {
    return {
      class: "config",
      title: "configuration error",
      detail,
      exitCode: EXIT_CODES.config,
    };
  }
  return {
    class: "unknown",
    title: "unexpected error",
    detail,
    exitCode: EXIT_CODES.generic,
  };
}
