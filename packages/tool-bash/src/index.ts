import { randomBytes } from "node:crypto";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";
import { z } from "zod";

/**
 * Built-in Bash tool family. Layer R4. Pairs with the `target-cli` codegen
 * contract (`bash`/`bashOutput`/`killShell` exports).
 *
 * `Bash` spawns `sh -c` via `Bun.spawn` and captures stdout + stderr:
 *   - Foreground (default): waits for the command, enforces a 30s default
 *     (max 10min) timeout by SIGKILLing on the deadline, and returns a
 *     human-readable string encoding both streams + the exit code.
 *   - Background (`background: true`): spawns the command, registers it in a
 *     per-process registry keyed by a `bash_<hex>` id, and returns
 *     immediately WITHOUT waiting. The command keeps running across turns;
 *     `BashOutput` polls its incremental output + status and `KillShell`
 *     stops it. This mirrors Claude Code's background-shell workflow for
 *     dev servers, watchers, and other long-running processes that must
 *     outlive a single tool call.
 *
 * Linux note (foreground): when `sh` forks a long-running grandchild (e.g.
 * `sleep 10`), SIGKILL on the shell does not propagate to the orphan, which
 * keeps the pipe write-end alive and prevents `text()` from ever EOFing.
 * After the shell exits we give each stream a fixed drain grace window
 * before falling back to an empty string.
 *
 * Cleanup: still-running background processes are SIGKILLed when the host
 * process exits (a `process.on("exit")` backstop installed lazily on the
 * first background spawn). For the CLI REPL, process exit == session end.
 * A background process is otherwise reaped when it exits on its own or when
 * `KillShell` stops it. (If the host is SIGKILLed outright the backstop
 * cannot run and the OS reparents the children — the usual orphan caveat.)
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const DRAIN_GRACE_MS = 500;
// Per-stream retained-output cap for a background process. Older output is
// dropped (head-first) past this so a chatty long-runner can't grow the
// buffer without bound; `BashOutput` reports when truncation occurred.
const MAX_BG_STREAM_CHARS = 256_000;

type Subproc = ReturnType<typeof Bun.spawn>;

type BgProc = {
  readonly id: string;
  readonly command: string;
  readonly proc: Subproc;
  stdout: string;
  stderr: string;
  /** Chars already handed back by a prior BashOutput poll (per stream). */
  stdoutReturned: number;
  stderrReturned: number;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  readonly startedAt: number;
  truncated: boolean;
};

const bgProcs = new Map<string, BgProc>();

let cleanupInstalled = false;
function ensureBackgroundCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  // SIGKILL any still-running background process when the host exits so a
  // session never leaks live children. Synchronous — safe in an exit handler.
  process.on("exit", () => {
    for (const bg of bgProcs.values()) {
      if (bg.status === "running") {
        try {
          bg.proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
}

/** Append to a background stream, dropping head past the cap and keeping the
 *  "already returned" cursor consistent with the retained window. */
function appendStdout(bg: BgProc, chunk: string): void {
  bg.stdout += chunk;
  if (bg.stdout.length > MAX_BG_STREAM_CHARS) {
    const drop = bg.stdout.length - MAX_BG_STREAM_CHARS;
    bg.stdout = bg.stdout.slice(drop);
    bg.stdoutReturned = Math.max(0, bg.stdoutReturned - drop);
    bg.truncated = true;
  }
}
function appendStderr(bg: BgProc, chunk: string): void {
  bg.stderr += chunk;
  if (bg.stderr.length > MAX_BG_STREAM_CHARS) {
    const drop = bg.stderr.length - MAX_BG_STREAM_CHARS;
    bg.stderr = bg.stderr.slice(drop);
    bg.stderrReturned = Math.max(0, bg.stderrReturned - drop);
    bg.truncated = true;
  }
}

/** Drain a piped stream into a background buffer without blocking the caller. */
async function pump(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk: (text: string) => void,
): Promise<void> {
  if (stream === null || stream === undefined) return;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      onChunk(decoder.decode(chunk, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail.length > 0) onChunk(tail);
  } catch {
    // Stream torn down (process killed) — stop draining.
  }
}

type BashOutputResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
};

/**
 * Section 57 / loop contract 0.4 (Batch C, G59) — resolve the run's
 * `TraceEventBus` from a tool-execute context. The runtime threads the
 * `RunContext` on EVERY tool execute via `ctx.bridge.runContext` (and, where
 * available, the first-class `ctx.runContext`), mirroring tool-mcp /
 * skills-registry. Returns undefined when neither is present (bare unit
 * calls) so publishing is a strict no-op off the loop.
 */
function resolveEventBus(ctx?: ToolExecuteContext): TraceEventBus | undefined {
  const rc =
    ctx?.runContext ??
    (ctx?.bridge as { runContext?: { eventBus?: TraceEventBus } } | undefined)?.runContext;
  return rc?.eventBus;
}

/**
 * Section 57 / loop contract 0.4 (Batch C, G59) — publish ONE `program_output`
 * summary at a foreground command's exit (per-chunk stdout/stderr is the
 * separate `tool_stream_chunk` stream). The event carries only byte COUNTS +
 * the exit code + duration — never the raw stdout/stderr — so it is inherently
 * size-capped. Fire-and-forget: a missing bus skips silently.
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

function formatResult(out: BashOutputResult): string {
  const parts: string[] = [];
  if (out.stdout.length > 0) parts.push(out.stdout.replace(/\n+$/, ""));
  if (out.stderr.length > 0) {
    parts.push("[stderr]");
    parts.push(out.stderr.replace(/\n+$/, ""));
  }
  const exitLine = out.timedOut
    ? `[exit] ${out.exitCode} (timed out after ${out.timeoutMs}ms)`
    : `[exit] ${out.exitCode}`;
  parts.push(exitLine);
  return parts.join("\n");
}

const bashSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run detached and return a bash_id immediately instead of waiting. Poll with BashOutput, stop with KillShell. Use for dev servers, watchers, and other long-running commands.",
    ),
});

function startBackground(command: string): string {
  ensureBackgroundCleanup();
  const id = `bash_${randomBytes(6).toString("hex")}`;
  const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const bg: BgProc = {
    id,
    command,
    proc,
    stdout: "",
    stderr: "",
    stdoutReturned: 0,
    stderrReturned: 0,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    truncated: false,
  };
  bgProcs.set(id, bg);
  // Fire-and-forget: keep draining both streams and record the exit code. Do
  // NOT await — the tool returns while the command keeps running.
  void pump(proc.stdout as ReadableStream<Uint8Array>, (t) => appendStdout(bg, t));
  void pump(proc.stderr as ReadableStream<Uint8Array>, (t) => appendStderr(bg, t));
  void proc.exited.then((code) => {
    if (bg.status === "running") {
      bg.status = "exited";
      bg.exitCode = code;
    }
  });
  return (
    `[background] started ${id}\n$ ${command}\n` +
    `Poll its output with BashOutput({ bash_id: "${id}" }); stop it with KillShell({ bash_id: "${id}" }).`
  );
}

export const bash: RegisteredTool = buildTool({
  name: "Bash",
  description:
    "Run a shell command via `sh -c`. Captures stdout and stderr; default timeout 30s, max 10min. Pass `background: true` to detach a long-running command and get a bash_id to poll with BashOutput / stop with KillShell.",
  inputSchema: bashSchema,
  destructive: true,
  // Pillar 3 sink-side: Bash spawns a host process and its command string is an
  // exfiltration channel (curl, nc, `base64 | sh`, …). Mark it external +
  // process so runtime-core runs classifyEgress on the command payload and the
  // substring matcher can flag tagged secrets on the command line (#146).
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx) => {
    if (input.background === true) {
      return startBackground(input.command);
    }
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const t0 = performance.now();
    const proc = Bun.spawn(["sh", "-c", input.command], {
      stdout: "pipe",
      stderr: "pipe",
      // When the orchestrator aborts the turn (Ctrl-C, recovery exhaustion),
      // Bun forwards the signal as SIGTERM to the spawned shell.
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process already exited between the timer firing and the kill call.
      }
    }, timeoutMs);
    try {
      const stdoutText = new Response(proc.stdout).text();
      const stderrText = new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      const drainFallback = (): Promise<string> =>
        new Promise((resolve) => setTimeout(() => resolve(""), DRAIN_GRACE_MS));
      const [stdout, stderr] = await Promise.all([
        Promise.race([stdoutText, drainFallback()]),
        Promise.race([stderrText, drainFallback()]),
      ]);
      // G59 — publish the per-process summary at exit (byte counts + exit code
      // + duration only) for the runtime feedback channel.
      publishProgramOutput(resolveEventBus(ctx), {
        stdout,
        stderr,
        exitCode,
        durationMs: performance.now() - t0,
      });
      return formatResult({ stdout, stderr, exitCode, timedOut, timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  },
});

const bashIdSchema = z.object({
  bash_id: z.string().min(1).describe("The id returned by a `Bash({ background: true })` call."),
});

export const bashOutput: RegisteredTool = buildTool({
  name: "BashOutput",
  description:
    "Return the stdout/stderr a background Bash process has produced since the last poll, plus its status (running / exited with code / killed). Poll a `bash_id` from a `Bash({ background: true })` call.",
  inputSchema: bashIdSchema,
  // Advances a per-process read cursor, so not read-only (must run serially).
  execute: async (input) => {
    const bg = bgProcs.get(input.bash_id);
    if (bg === undefined) {
      return `[BashOutput error] no background process with id "${input.bash_id}". It may have been reaped, or the id is wrong.`;
    }
    const newStdout = bg.stdout.slice(bg.stdoutReturned);
    const newStderr = bg.stderr.slice(bg.stderrReturned);
    bg.stdoutReturned = bg.stdout.length;
    bg.stderrReturned = bg.stderr.length;

    const statusLine =
      bg.status === "running"
        ? "[status] running"
        : bg.status === "killed"
          ? "[status] killed"
          : `[status] exited ${bg.exitCode ?? "?"}`;

    const parts: string[] = [];
    if (newStdout.length > 0) parts.push(newStdout.replace(/\n+$/, ""));
    if (newStderr.length > 0) {
      parts.push("[stderr]");
      parts.push(newStderr.replace(/\n+$/, ""));
    }
    if (parts.length === 0) parts.push("[no new output]");
    if (bg.truncated) parts.push("[note] earlier output was truncated (buffer cap reached)");
    parts.push(statusLine);
    return parts.join("\n");
  },
});

export const killShell: RegisteredTool = buildTool({
  name: "KillShell",
  description:
    "Stop a background Bash process (SIGKILL) started with `Bash({ background: true })`. Pass its bash_id.",
  inputSchema: bashIdSchema,
  destructive: true,
  execute: async (input) => {
    const bg = bgProcs.get(input.bash_id);
    if (bg === undefined) {
      return `[KillShell error] no background process with id "${input.bash_id}".`;
    }
    if (bg.status !== "running") {
      const how =
        bg.status === "killed" ? "already killed" : `already exited ${bg.exitCode ?? "?"}`;
      return `[KillShell] ${input.bash_id} is ${how}; nothing to do.`;
    }
    try {
      bg.proc.kill("SIGKILL");
      bg.status = "killed";
      return `[KillShell] sent SIGKILL to ${input.bash_id} ($ ${bg.command}).`;
    } catch (err) {
      return `[KillShell error] failed to kill ${input.bash_id}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

/**
 * Test-only: clear the background-process registry (killing any live procs).
 * Not part of the tool surface; used to isolate unit tests.
 */
export function __resetBackgroundProcsForTest(): void {
  for (const bg of bgProcs.values()) {
    if (bg.status === "running") {
      try {
        bg.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  bgProcs.clear();
}
