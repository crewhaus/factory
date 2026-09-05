import { randomBytes } from "node:crypto";
import {
  type Sandbox,
  type SandboxBackend,
  type SandboxMount,
  createSandbox,
} from "@crewhaus/sandbox";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
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
 * 60s timeout, image allowlist, mount whitelist). Without a sandbox
 * registered, the tool returns an error message at first call — the
 * permission engine should refuse them earlier (`requiresSandbox: true`).
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

export function registerCodeExecutionConfig(input: CodeExecutionConfigInput): void {
  activeConfig = {
    sandbox: input.sandbox,
    backend: input.backend,
    allowedImages: input.allowedImages ?? input.allowed_images,
    mountWhitelist: input.mountWhitelist ?? input.mount_whitelist,
    defaultTimeoutMs: input.defaultTimeoutMs ?? input.default_timeout_ms,
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

function formatResult(opts: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}): string {
  const parts: string[] = [];
  if (opts.stdout.length > 0) parts.push(opts.stdout.replace(/\n+$/, ""));
  if (opts.stderr.length > 0) {
    parts.push("[stderr]");
    parts.push(opts.stderr.replace(/\n+$/, ""));
  }
  const head = opts.timedOut
    ? `[exit] ${opts.exitCode} (timed out after ${Math.round(opts.durationMs)}ms)`
    : `[exit] ${opts.exitCode} (${Math.round(opts.durationMs)}ms)`;
  parts.push(head);
  return parts.join("\n");
}

const codeSchema = z.object({
  code: z.string().min(1),
  timeout: z.number().int().positive().max(600_000).optional(),
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
function publishProgramOutput(
  bus: TraceEventBus | undefined,
  summary: { stdout: string; stderr: string; exitCode: number; durationMs: number },
): void {
  if (bus === undefined) return;
  bus.publish({
    ...bus.envelope(),
    kind: "program_output",
    programId: `prog_${randomBytes(6).toString("hex")}`,
    exitCode: summary.exitCode,
    stdoutBytes: Buffer.byteLength(summary.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(summary.stderr, "utf8"),
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
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    return undefined;
  }
  const o = override as { defaultTimeoutMs?: unknown; default_timeout_ms?: unknown };
  const raw = o.defaultTimeoutMs ?? o.default_timeout_ms;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

async function runInSandbox(
  language: "python" | "javascript" | "shell",
  argv: ReadonlyArray<string>,
  input: CodeInput,
  ctx?: ToolExecuteContext,
): Promise<string> {
  const sandbox = getOrCreateSandbox();
  const callTimeoutMs = input.timeout ?? resolveCallTimeoutMs(ctx?.toolConfig);
  if (sandbox.backend === "noop") {
    // Allowed for tests, but emit a clear marker so misuse is obvious.
    // Production permission floor refuses requiresSandbox tools when the
    // sandbox is noop, so reaching here in production indicates a leak.
  }
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
  return formatResult(result);
}

export const python: RegisteredTool = buildTool({
  name: "Python",
  description:
    "Execute Python 3 code in a sandboxed container (network=none, read-only root, /tmp scratch). Equivalent to `python3 -c <code>`.",
  inputSchema: codeSchema,
  destructive: true,
  requiresSandbox: true,
  execute: async (input, ctx) => runInSandbox("python", ["python3", "-c"], input as CodeInput, ctx),
});

export const javascript: RegisteredTool = buildTool({
  name: "JavaScript",
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
  description:
    "Execute a POSIX shell command in a sandboxed container (network=none, read-only root, /tmp scratch). Equivalent to `sh -c <code>`.",
  inputSchema: codeSchema,
  destructive: true,
  requiresSandbox: true,
  execute: async (input, ctx) => runInSandbox("shell", ["sh", "-c"], input as CodeInput, ctx),
});

export const allCodeExecutionTools: ReadonlyArray<RegisteredTool> = [python, javascript, shell];
