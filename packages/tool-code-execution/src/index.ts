import { randomBytes } from "node:crypto";
import { ConfigError, CrewhausError } from "@crewhaus/errors";
import {
  SANDBOX_DEFAULT_TIMEOUT_MS,
  type Sandbox,
  type SandboxBackend,
  type SandboxExecResult,
  type SandboxMount,
  createSandbox,
} from "@crewhaus/sandbox";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";

/**
 * Re-exported so a compiled bundle that grants python/javascript/shell can
 * decide the sandbox floor with the SAME reading of `CREWHAUS_SANDBOX` the
 * sandbox itself uses, from a package it already imports (security-6#1).
 */
export { sandboxAvailableFromEnv } from "@crewhaus/sandbox";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";
import { z } from "zod";

/**
 * Catalog R4 `tool-code-execution` — three sandboxed REPL tools:
 *
 *   Python — `python:3.13-slim`, runs `python3 -c <code>`
 *   JavaScript — `node:22-alpine`, runs `node -e <code>`
 *   Shell — `alpine:3.19`, runs `sh -c <code>`
 *
 * Each tool delegates execution to `@crewhaus/sandbox`, which enforces
 * the production safety floor (network=none, read-only root, tmpfs /tmp,
 * image allowlist, mount whitelist, a wall-clock kill, 1 MiB of each output
 * stream). Without a sandbox registered, the tool returns an error message
 * at first call — the permission engine should refuse them earlier
 * (`requiresSandbox: true`).
 *
 * Timeout: 60 s unless the operator's `default_timeout_ms` says otherwise.
 * The model may ask for its own `timeout` (up to 10 minutes) — unless the
 * operator sets `max_timeout_ms`, which caps every call: the model's
 * timeout, the default, and an injected sandbox's own default alike
 * (security-6#15). A model pool candidate's block may lower the cap, never
 * raise it, and — as every candidate block does since 0.6.0 — it applies
 * per tool: under `python` it caps Python calls, under `codeExecution` all
 * three, and compile warns when a candidate caps one of them while the
 * others are listed. (At boot a block under any of those keys configures
 * all three, because there is one registration.)
 *
 * `CREWHAUS_SANDBOX=noop` turns code execution OFF: the permission floor
 * denies these tools, and if a call reaches them anyway (bypass mode, or a
 * caller that told the loop a sandbox exists) they refuse rather than run
 * model code on the host. The in-process noop backend runs only when trusted
 * code chose it — `registerCodeExecutionConfig({ backend: "noop" })` or an
 * injected `sandbox` — which is how tests use it. (Until 0.7.0 a test could
 * set `CREWHAUS_SANDBOX=noop` instead; that now refuses.)
 *
 * Output is streamed line-by-line via `ctx.onStreamChunk` so runtime-core
 * can publish `tool_stream_chunk` trace events.
 *
 * Layer R4. Pairs with `sandbox` (R8) and `permission-engine` (R8).
 */

export type CodeExecutionConfig = {
  readonly sandbox?: Sandbox;
  readonly backend?: SandboxBackend;
  readonly allowedImages?: ReadonlyArray<string>;
  readonly mountWhitelist?: ReadonlyArray<string>;
  readonly defaultTimeoutMs?: number;
  /**
   * The longest timeout any call may run with, in ms. The model's `timeout`,
   * the default, a serving candidate's default and an injected sandbox's
   * default are all clamped to it. Unset: the model may ask for up to
   * 600 000 (the input schema's limit).
   */
  readonly maxTimeoutMs?: number;
  /** Optional warm pool size per language. Reserved for v1; v0 ignores. */
  readonly warmPoolSize?: number;
  /** Per-language image override. Defaults to the curated images. */
  readonly images?: {
    readonly python?: string;
    readonly javascript?: string;
    readonly shell?: string;
  };
  /**
   * Files the agent is allowed to expose to the container, mapped
   * { hostAbsolutePath: containerPath }. Each entry must pass the
   * sandbox's mount whitelist; otherwise the tool refuses the call.
   */
  readonly mounts?: Readonly<Record<string, string>>;
};

export type CodeExecutionConfigInput = {
  readonly sandbox?: Sandbox;
  readonly backend?: SandboxBackend;
  readonly allowed_images?: ReadonlyArray<string>;
  readonly allowedImages?: ReadonlyArray<string>;
  readonly mount_whitelist?: ReadonlyArray<string>;
  readonly mountWhitelist?: ReadonlyArray<string>;
  readonly default_timeout_ms?: number;
  readonly defaultTimeoutMs?: number;
  readonly max_timeout_ms?: number;
  readonly maxTimeoutMs?: number;
  readonly warm_pool_size?: number;
  readonly warmPoolSize?: number;
  readonly images?: {
    readonly python?: string;
    readonly javascript?: string;
    readonly shell?: string;
  };
  readonly mounts?: Readonly<Record<string, string>>;
};

const DEFAULT_IMAGES = {
  python: "python:3.13-slim",
  javascript: "node:22-alpine",
  shell: "alpine:3.19",
} as const;

let activeConfig: CodeExecutionConfig = {};
let activeSandbox: Sandbox | undefined;

/** The model's `timeout` can never exceed this (the input schema's limit). */
const MODEL_TIMEOUT_LIMIT_MS = 600_000;

export function registerCodeExecutionConfig(input: CodeExecutionConfigInput): void {
  const maxTimeoutMs = input.maxTimeoutMs ?? input.max_timeout_ms;
  if (
    maxTimeoutMs !== undefined &&
    (typeof maxTimeoutMs !== "number" || !Number.isFinite(maxTimeoutMs) || maxTimeoutMs <= 0)
  ) {
    // A cap that cannot be read must not become "no cap".
    throw new ConfigError(
      `code execution max_timeout_ms must be a number of milliseconds > 0, got ${JSON.stringify(maxTimeoutMs)}`,
    );
  }
  activeConfig = {
    sandbox: input.sandbox,
    backend: input.backend,
    allowedImages: input.allowedImages ?? input.allowed_images,
    mountWhitelist: input.mountWhitelist ?? input.mount_whitelist,
    defaultTimeoutMs: input.defaultTimeoutMs ?? input.default_timeout_ms,
    ...(maxTimeoutMs !== undefined ? { maxTimeoutMs } : {}),
    warmPoolSize: input.warmPoolSize ?? input.warm_pool_size,
    images: input.images,
    mounts: input.mounts,
  };
  // Reset cached lazy sandbox so the next call constructs from the new
  // config. If the caller supplied an explicit sandbox, use it directly.
  activeSandbox = input.sandbox;
}

export function getCodeExecutionConfig(): CodeExecutionConfig {
  return activeConfig;
}

/** Test-only — clears all cached state. */
export function _resetCodeExecutionConfig(): void {
  activeConfig = {};
  activeSandbox = undefined;
}

function getOrCreateSandbox(): Sandbox {
  if (activeSandbox !== undefined) return activeSandbox;
  activeSandbox = createSandbox({
    ...(activeConfig.backend !== undefined ? { backend: activeConfig.backend } : {}),
    ...(activeConfig.allowedImages !== undefined
      ? { allowedImages: activeConfig.allowedImages }
      : {}),
    ...(activeConfig.mountWhitelist !== undefined
      ? { mountWhitelist: activeConfig.mountWhitelist }
      : {}),
    ...(activeConfig.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: activeConfig.defaultTimeoutMs }
      : {}),
  });
  return activeSandbox;
}

function configuredImage(lang: keyof typeof DEFAULT_IMAGES): string {
  const overrides = activeConfig.images;
  return overrides?.[lang] ?? DEFAULT_IMAGES[lang];
}

function buildMounts(): ReadonlyArray<SandboxMount> {
  const m = activeConfig.mounts;
  if (m === undefined) return [];
  return Object.entries(m).map(([src, dst]) => ({ src, dst, readonly: true }));
}

/** `text` without its trailing newlines — a loop, not `/\n+$/`, which is quadratic on a long run of newlines. */
function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  return text.slice(0, end);
}

function formatResult(result: SandboxExecResult, timeoutNote: string | undefined): string {
  const parts: string[] = [];
  if (result.stdout.length > 0) parts.push(trimTrailingNewlines(result.stdout));
  if (result.stderr.length > 0) {
    parts.push("[stderr]");
    parts.push(trimTrailingNewlines(result.stderr));
  }
  if (result.outputComplete === false) {
    parts.push(
      "[output incomplete: reading stopped before the output ended (something the program started still held it open), so the text above may not be all of it]",
    );
  }
  const ms = Math.round(result.durationMs);
  const how =
    result.aborted === true
      ? `cancelled after ${ms}ms`
      : result.timedOut
        ? `timed out after ${ms}ms`
        : `${ms}ms`;
  parts.push(
    `[exit] ${result.exitCode} (${how}${timeoutNote !== undefined ? `; ${timeoutNote}` : ""})`,
  );
  return parts.join("\n");
}

const codeSchema = z.object({
  code: z.string().min(1),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MODEL_TIMEOUT_LIMIT_MS)
    .optional()
    .describe(
      "Milliseconds before the program is killed, at most 600000. Omitted, the operator's default applies (60000 unless configured). The operator may cap it lower.",
    ),
});

type CodeInput = z.infer<typeof codeSchema>;

/**
 * Section 57 / loop contract 0.4 (Batch C, G59) — resolve the run's
 * `TraceEventBus` from a tool-execute context. The runtime threads the
 * `RunContext` on EVERY tool execute via `ctx.bridge.runContext` (and, where
 * available, the first-class `ctx.runContext`), mirroring how tool-mcp /
 * skills-registry reach the run context. Returns undefined when neither is
 * present (bare unit calls / tests that pass no context) so publishing is a
 * strict no-op off the loop.
 */
function resolveEventBus(ctx?: ToolExecuteContext): TraceEventBus | undefined {
  const rc =
    ctx?.runContext ??
    (ctx?.bridge as { runContext?: { eventBus?: TraceEventBus } } | undefined)?.runContext;
  return rc?.eventBus;
}

/**
 * Section 57 / loop contract 0.4 (Batch C, G59) — the AgentFlow feedback
 * channel for a sandboxed program run: publish ONE `program_output` summary
 * at process exit (per-chunk stdout/stderr is the separate `tool_stream_chunk`
 * stream). The event carries only byte COUNTS + the exit code + duration —
 * never the raw stdout/stderr — so it is inherently size-capped and safe to
 * emit for chatty programs. Fire-and-forget: a missing bus (no run context)
 * skips silently.
 */
function publishProgramOutput(bus: TraceEventBus | undefined, summary: SandboxExecResult): void {
  if (bus === undefined) return;
  bus.publish({
    ...bus.envelope(),
    kind: "program_output",
    programId: `prog_${randomBytes(6).toString("hex")}`,
    exitCode: summary.exitCode,
    // What the program wrote, not what was kept after the output cap.
    stdoutBytes: summary.stdoutBytes ?? Buffer.byteLength(summary.stdout, "utf8"),
    stderrBytes: summary.stderrBytes ?? Buffer.byteLength(summary.stderr, "utf8"),
    durationMs: Math.round(summary.durationMs),
  });
}

/**
 * 0.6.0 §4.4 — the per-call override a serving candidate's
 * `tool_config.<python|javascript|shell|codeExecution>` block supplies
 * (`ToolExecuteContext.toolConfig`). Only the NON-security knob the spec's
 * `toolConfigBlock` superRefine lets a profile declare is honoured per call:
 * `default_timeout_ms` / `defaultTimeoutMs`, applied when the model passed no
 * explicit `timeout`. The sandbox boundary itself (backend, images, mounts,
 * allow-lists) is process-global by design — it comes from trusted operator
 * config, never from a spec block, so a per-call override cannot reach it.
 */
export function resolveCallTimeoutMs(override: unknown): number | undefined {
  return readPositiveMs(override, "defaultTimeoutMs", "default_timeout_ms");
}

/**
 * The per-call `max_timeout_ms` / `maxTimeoutMs` a serving candidate's
 * tool_config block supplies, or undefined. It can only LOWER the operator's
 * cap (see {@link resolveEffectiveTimeout}).
 */
export function resolveCallMaxTimeoutMs(override: unknown): number | undefined {
  return readPositiveMs(override, "maxTimeoutMs", "max_timeout_ms");
}

function readPositiveMs(override: unknown, camel: string, snake: string): number | undefined {
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    return undefined;
  }
  const o = override as Record<string, unknown>;
  const raw = o[camel] ?? o[snake];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * The timeout a call runs with, and a note for the model when its request
 * was cut. The model's `timeout` wins over the defaults, as before; the cap
 * (`max_timeout_ms`, lowered further by a candidate's own) bounds all of
 * them. With no cap configured anywhere this is exactly the 0.7.0 rule.
 *
 * `timeoutMs` undefined means "the sandbox's own default", which is left to
 * the sandbox only when no cap applies. With a cap, the default is read from
 * the config or the sandbox (`Sandbox.execDefaults`); an injected
 * sandbox that does not say its default runs such a call with the cap.
 */
export function resolveEffectiveTimeout(
  input: { readonly timeout?: number },
  toolConfig: unknown,
  config: CodeExecutionConfig = activeConfig,
): { readonly timeoutMs: number | undefined; readonly note?: string } {
  const requested = input.timeout ?? resolveCallTimeoutMs(toolConfig);
  const caps = [config.maxTimeoutMs, resolveCallMaxTimeoutMs(toolConfig)].filter(
    (c): c is number => c !== undefined,
  );
  if (caps.length === 0) return { timeoutMs: requested };
  const cap = Math.min(...caps);
  const knownDefault =
    config.defaultTimeoutMs ??
    (config.sandbox === undefined
      ? SANDBOX_DEFAULT_TIMEOUT_MS
      : config.sandbox.execDefaults?.timeoutMs);
  const base = requested ?? knownDefault;
  // A default nobody can read here may be longer than the cap: the cap is
  // the most the call may run, so it is the timeout.
  if (base === undefined) return { timeoutMs: cap };
  if (base <= cap) return { timeoutMs: base };
  return {
    timeoutMs: cap,
    ...(input.timeout !== undefined && input.timeout > cap
      ? {
          note: `timeout capped at ${cap}ms by the operator's max_timeout_ms (asked for ${input.timeout}ms)`,
        }
      : {}),
  };
}

/**
 * The noop backend runs code on the host. It may run only when trusted code
 * picked it: an injected sandbox, or `backend: "noop"` registered
 * programmatically (a spec cannot set `backend`). Picked by
 * `CREWHAUS_SANDBOX=noop`, it means "code execution off" — the permission
 * floor already denies these tools, and this refuses what gets past it
 * (bypass mode, a loop told a sandbox exists) (security-6#1).
 */
function refuseEnvironmentNoop(sandbox: Sandbox, toolName: string): void {
  if (sandbox.backend !== "noop") return;
  if (activeConfig.sandbox !== undefined || activeConfig.backend === "noop") return;
  throw new CrewhausError(
    "tool",
    `${toolName} refused: CREWHAUS_SANDBOX=noop turns code execution off (the noop backend would run this code on the host with no isolation). Set CREWHAUS_SANDBOX=docker or podman to run it in a container. A test that wants the in-process backend registers it instead: registerCodeExecutionConfig({ backend: "noop" }).`,
  );
}

const TOOL_NAMES = { python: "Python", javascript: "JavaScript", shell: "Shell" } as const;

async function runInSandbox(
  language: "python" | "javascript" | "shell",
  argv: ReadonlyArray<string>,
  input: CodeInput,
  ctx?: ToolExecuteContext,
): Promise<string> {
  const sandbox = getOrCreateSandbox();
  refuseEnvironmentNoop(sandbox, TOOL_NAMES[language]);
  const { timeoutMs: callTimeoutMs, note } = resolveEffectiveTimeout(input, ctx?.toolConfig);
  const image = configuredImage(language);
  const mounts = buildMounts();
  const onStreamChunk = ctx?.onStreamChunk;
  const result = await sandbox.exec({
    image,
    argv: [...argv, input.code],
    ...(callTimeoutMs !== undefined ? { timeoutMs: callTimeoutMs } : {}),
    ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(mounts.length > 0 ? { mounts } : {}),
    onStdoutChunk: onStreamChunk ? (chunk) => onStreamChunk("stdout", chunk) : undefined,
    onStderrChunk: onStreamChunk ? (chunk) => onStreamChunk("stderr", chunk) : undefined,
  });
  // G59 — publish the per-process summary at exit (byte counts + exit code +
  // duration only) for the runtime feedback channel.
  publishProgramOutput(resolveEventBus(ctx), result);
  return formatResult(result, note);
}

export const python: RegisteredTool = buildTool({
  name: "Python",
  operativeArgs: [{ field: "code", kind: "command" }],
  description:
    "Execute Python 3 code in a sandboxed container (network=none, read-only root, /tmp scratch). Equivalent to `python3 -c <code>`.",
  inputSchema: codeSchema,
  destructive: true,
  requiresSandbox: true,
  execute: async (input, ctx) => runInSandbox("python", ["python3", "-c"], input as CodeInput, ctx),
});

export const javascript: RegisteredTool = buildTool({
  name: "JavaScript",
  operativeArgs: [{ field: "code", kind: "command" }],
  description:
    "Execute JavaScript code in a sandboxed container (network=none, read-only root, /tmp scratch). Equivalent to `node -e <code>`.",
  inputSchema: codeSchema,
  destructive: true,
  requiresSandbox: true,
  execute: async (input, ctx) =>
    runInSandbox("javascript", ["node", "-e"], input as CodeInput, ctx),
});

export const shell: RegisteredTool = buildTool({
  name: "Shell",
  operativeArgs: [{ field: "code", kind: "command" }],
  description:
    "Execute a POSIX shell command in a sandboxed container (network=none, read-only root, /tmp scratch). Equivalent to `sh -c <code>`.",
  inputSchema: codeSchema,
  destructive: true,
  requiresSandbox: true,
  execute: async (input, ctx) => runInSandbox("shell", ["sh", "-c"], input as CodeInput, ctx),
});

export const allCodeExecutionTools: ReadonlyArray<RegisteredTool> = [python, javascript, shell];
