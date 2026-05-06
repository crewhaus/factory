import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Built-in Bash tool. Spawns the command through `sh -c` via `Bun.spawn`,
 * captures stdout + stderr, and enforces a default 30s timeout (max 10min)
 * by SIGKILLing the subprocess when the deadline elapses. The returned
 * string is human-readable and encodes both streams plus the exit code.
 *
 * Linux note: when `sh` forks a long-running grandchild (e.g. `sleep 10`),
 * SIGKILL on the shell does not propagate to the orphan, which keeps the
 * pipe write-end alive and prevents `text()` from ever EOFing. After the
 * shell exits we therefore give each stream a fixed drain grace window
 * before falling back to an empty string — the orphan still exits on its
 * own, but the tool call returns within `timeoutMs + DRAIN_GRACE_MS`.
 *
 * Layer R4. Pairs with the `target-cli` codegen contract (`bash` export).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const DRAIN_GRACE_MS = 500;

const bashSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

type BashOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
};

function formatResult(out: BashOutput): string {
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

export const bash: RegisteredTool = buildTool({
  name: "Bash",
  description:
    "Run a shell command via `sh -c`. Captures stdout and stderr; default timeout 30s, max 10min.",
  inputSchema: bashSchema,
  destructive: true,
  execute: async (input, ctx) => {
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
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
      return formatResult({ stdout, stderr, exitCode, timedOut, timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  },
});
