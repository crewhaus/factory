import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Built-in Bash tool. Spawns the command through `sh -c` via `Bun.spawn`,
 * captures stdout + stderr, and enforces a default 30s timeout (max 10min)
 * by SIGKILLing the subprocess when the deadline elapses. The returned
 * string is human-readable and encodes both streams plus the exit code.
 *
 * Layer R4. Pairs with the `target-cli` codegen contract (`bash` export).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

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
  execute: async (input) => {
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const proc = Bun.spawn(["sh", "-c", input.command], {
      stdout: "pipe",
      stderr: "pipe",
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
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return formatResult({ stdout, stderr, exitCode, timedOut, timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  },
});
