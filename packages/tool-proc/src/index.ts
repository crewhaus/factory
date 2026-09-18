/**
 * @crewhaus/tool-proc — running programs, and waiting for the world.
 *
 * Two concerns live here. The first is running a program: `RunCommand`,
 * `RunPipeline` and `Retry` in the foreground, and the `Process*` family for
 * things that must outlive a single tool call. The second is waiting:
 * `WaitForPort`, `WaitForFile` and `WaitForOutput` turn "sleep 5 and hope"
 * into a stated condition with a stated deadline.
 *
 * Three rules hold across the package.
 *
 *   1. There is no shell. Every command is an argv ARRAY handed straight to
 *      the OS, so a model-supplied argument is an argument — never syntax.
 *   2. Every wait has a required deadline, and every spawn has a timeout. A
 *      tool that can hang forever is a defect, so none of them can.
 *   3. Determinism means the same inputs against the same world produce the
 *      same output: no unseeded randomness, no unordered listings, and a
 *      pinned child environment (see ./lib/env) so a program's own output
 *      does not drift with the machine's locale or timezone.
 *
 * Results are compact JSON, because every byte returned is a byte in
 * somebody's context window, and a caller's mistake comes back as a
 * readable string rather than an exception.
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { connect } from "node:net";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type BackoffPolicy, backoffDelayMs, totalBackoffMs } from "./lib/backoff";
import { FALLBACK_PATH, buildSpawnEnv, inspectEnv } from "./lib/env";
import { capText, compileSafePattern, formatArgv } from "./lib/format";
import {
  type BgProc,
  __resetRegistryForTest,
  getProc,
  listProcs,
  markKilled,
  reapProc,
  startBackground,
} from "./registry";
import { recheckContainment, resolveSafe, resolveSafeDir } from "./safe-path";
import { runOnce, sleep } from "./spawn";

export { __resetRegistryForTest };

/** Compact JSON — the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
/** The longest any wait may be asked to block, deadline or not. */
const MAX_WAIT_MS = 600_000;
const DEFAULT_MAX_OUTPUT = 100_000;
const MAX_MAX_OUTPUT = 1_000_000;
const DEFAULT_POLL_MS = 100;

// ---------------------------------------------------------------------------
// shared schema pieces
// ---------------------------------------------------------------------------

const argvSchema = z
  .array(z.string())
  .min(1)
  .max(128)
  .describe(
    'the program and each argument as separate strings, e.g. ["git","log","-n","1"] — never a single shell string',
  );

const envForwardSchema = z
  .array(z.string())
  .max(64)
  .optional()
  .describe(
    "names of harness environment variables to forward; nothing else is inherited, so secrets stay out of the child unless named",
  );

const envSetSchema = z
  .record(z.string())
  .optional()
  .describe("literal environment values for the child; these win over forwarded ones");

const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds before the command is SIGTERMed (default ${DEFAULT_TIMEOUT_MS})`);

const maxOutputSchema = z.number().int().min(100).max(MAX_MAX_OUTPUT).optional();

const deadlineSchema = (what: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(MAX_WAIT_MS)
    .describe(`required deadline in milliseconds — ${what} never waits longer than this`);

const intervalSchema = z
  .number()
  .int()
  .min(10)
  .max(60_000)
  .optional()
  .describe(`milliseconds between checks (default ${DEFAULT_POLL_MS})`);

// ---------------------------------------------------------------------------
// shared preparation
// ---------------------------------------------------------------------------

type Prepared =
  | {
      readonly ok: true;
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly envMissing: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

function prepare(
  toolName: string,
  input: {
    readonly cwd?: string;
    readonly env?: readonly string[];
    readonly envSet?: Record<string, string>;
  },
): Prepared {
  let cwd = process.cwd();
  if (input.cwd !== undefined) {
    const resolved = resolveSafeDir(toolName, input.cwd);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    cwd = resolved.path;
  }
  const built = buildSpawnEnv(process.env, {
    forward: input.env ?? [],
    set: input.envSet ?? {},
  });
  if (built.invalid.length > 0) {
    return {
      ok: false,
      message: `[${toolName} error] not environment-variable names: ${built.invalid.join(", ")}`,
    };
  }
  return { ok: true, cwd, env: built.env, envMissing: built.missing };
}

/** argv itself must name a program; an empty argv[0] would spawn nothing. */
function checkArgv(toolName: string, argv: readonly string[]): string | undefined {
  const program = argv[0];
  if (program === undefined || program.trim() === "") {
    return `[${toolName} error] argv[0] must name a program to run.`;
  }
  for (const arg of argv) {
    if (arg.includes("\0")) return `[${toolName} error] argv may not contain a NUL byte.`;
  }
  return undefined;
}

/** The fields every foreground run reports, in one shape. */
function outcomeJson(outcome: Awaited<ReturnType<typeof runOnce>>): Record<string, unknown> {
  return {
    argv: outcome.argv,
    ...(outcome.spawnError !== undefined ? { spawnError: outcome.spawnError } : {}),
    ...(outcome.abandoned === true ? { abandoned: true } : {}),
    exitCode: outcome.exitCode,
    ok: outcome.spawnError === undefined && outcome.abandoned !== true && outcome.exitCode === 0,
    timedOut: outcome.timedOut,
    // Wall-clock duration is reported because measuring the run is part of
    // what a caller asks RunCommand for; nothing else here reads a clock.
    durationMs: outcome.durationMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    ...(outcome.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(outcome.stderrTruncated ? { stderrTruncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// running programs
// ---------------------------------------------------------------------------

export const runCommand: RegisteredTool = buildTool({
  name: "RunCommand",
  description:
    "Run a program from an argv array — the program and each argument as separate strings, with no shell anywhere, so an argument containing a space, a quote or $(...) stays an argument. Use it whenever a harness needs a program's exit code and output without the injection surface of a shell command line. The child inherits no environment except the names you forward, and always has a timeout.",
  inputSchema: z.object({
    argv: argvSchema,
    cwd: z.string().optional().describe("working directory, inside the workspace root"),
    env: envForwardSchema,
    envSet: envSetSchema,
    stdin: z.string().max(1_000_000).optional(),
    timeoutMs: timeoutSchema,
    maxOutputChars: maxOutputSchema,
  }),
  destructive: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const bad = checkArgv("RunCommand", input.argv);
    if (bad !== undefined) return bad;
    const prep = prepare("RunCommand", input);
    if (!prep.ok) return prep.message;
    const outcome = await runOnce(input.argv, {
      cwd: prep.cwd,
      env: prep.env,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputChars: input.maxOutputChars ?? DEFAULT_MAX_OUTPUT,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    return json({
      ...outcomeJson(outcome),
      ...(prep.envMissing.length > 0 ? { envNotSet: prep.envMissing } : {}),
    });
  },
});

export const runPipeline: RegisteredTool = buildTool({
  name: "RunPipeline",
  description:
    "Run several argv commands in order, stopping at the first non-zero exit, and return every step's result. Use it for a short ordered chain — install, then build, then test — without spending a model turn between the steps. Steps run in sequence and do not pipe into each other; each gets its own stdin and its own timeout.",
  inputSchema: z.object({
    steps: z
      .array(
        z.object({
          argv: argvSchema,
          cwd: z.string().optional(),
          stdin: z.string().max(1_000_000).optional(),
          label: z.string().max(80).optional(),
        }),
      )
      .min(1)
      .max(20),
    cwd: z.string().optional().describe("default working directory for every step"),
    env: envForwardSchema,
    envSet: envSetSchema,
    timeoutMs: timeoutSchema.describe("per-step timeout in milliseconds"),
    maxOutputChars: maxOutputSchema,
    continueOnError: z
      .boolean()
      .optional()
      .describe("run every step even after one fails (default false)"),
  }),
  destructive: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    for (const step of input.steps) {
      const bad = checkArgv("RunPipeline", step.argv);
      if (bad !== undefined) return bad;
    }
    const prep = prepare("RunPipeline", input);
    if (!prep.ok) return prep.message;

    // Resolve EVERY step's cwd before running any of them. Resolving inside
    // the loop meant a bad cwd on step 3 was only discovered after steps 1
    // and 2 had already had their effects, and the refusal then replaced the
    // whole result — so the caller was told nothing about what did run.
    const cwds: string[] = [];
    for (const step of input.steps) {
      if (step.cwd === undefined) {
        cwds.push(prep.cwd);
        continue;
      }
      const resolved = resolveSafeDir("RunPipeline", step.cwd);
      if (!resolved.ok) return resolved.message;
      cwds.push(resolved.path);
    }

    const results: Record<string, unknown>[] = [];
    let failedAt: number | null = null;
    for (const [index, step] of input.steps.entries()) {
      const cwd = cwds[index] as string;
      const outcome = await runOnce(step.argv, {
        cwd,
        env: prep.env,
        ...(step.stdin !== undefined ? { stdin: step.stdin } : {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputChars: input.maxOutputChars ?? DEFAULT_MAX_OUTPUT,
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      results.push({
        step: index,
        ...(step.label !== undefined ? { label: step.label } : {}),
        ...outcomeJson(outcome),
      });
      const failed = outcome.spawnError !== undefined || outcome.exitCode !== 0;
      if (failed && failedAt === null) failedAt = index;
      if (failed && input.continueOnError !== true) break;
      if (ctx?.signal?.aborted === true) break;
    }
    return json({
      steps: input.steps.length,
      ran: results.length,
      ok: failedAt === null,
      ...(failedAt !== null ? { failedAtStep: failedAt } : {}),
      results,
      ...(prep.envMissing.length > 0 ? { envNotSet: prep.envMissing } : {}),
    });
  },
});

const backoffSchema = z
  .union([
    z.object({
      kind: z.literal("fixed"),
      delayMs: z.number().int().min(0).max(60_000),
    }),
    z.object({
      kind: z.literal("exponential"),
      baseMs: z.number().int().min(0).max(60_000),
      factor: z.number().min(1).max(10).optional().describe("multiplier per attempt (default 2)"),
      maxDelayMs: z.number().int().min(0).max(300_000).optional(),
    }),
  ])
  .describe(
    "the wait between attempts; declared by the caller, with no jitter, so a retry plan replays identically",
  );

export const retry: RegisteredTool = buildTool({
  name: "Retry",
  description:
    "Re-run an argv command until it succeeds or a bounded attempt count runs out, waiting a caller-declared backoff between attempts. Use it for a flaky step — a service still starting, a lock still held — instead of asking a model to decide when to try again. The backoff is fixed or exponential with an explicit base and carries no jitter, and every attempt is reported.",
  inputSchema: z.object({
    argv: argvSchema,
    maxAttempts: z.number().int().min(1).max(10),
    backoff: backoffSchema,
    cwd: z.string().optional(),
    env: envForwardSchema,
    envSet: envSetSchema,
    stdin: z.string().max(1_000_000).optional(),
    timeoutMs: timeoutSchema.describe("per-attempt timeout in milliseconds"),
    maxOutputChars: maxOutputSchema.describe("per-attempt output cap (default 20000)"),
    successExitCodes: z
      .array(z.number().int().min(0).max(255))
      .max(16)
      .optional()
      .describe("exit codes that count as success (default [0])"),
    deadlineMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_WAIT_MS)
      .optional()
      .describe("overall deadline; no new attempt starts once it has passed"),
  }),
  destructive: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const bad = checkArgv("Retry", input.argv);
    if (bad !== undefined) return bad;
    const prep = prepare("Retry", input);
    if (!prep.ok) return prep.message;

    const policy = input.backoff as BackoffPolicy;
    if (input.deadlineMs !== undefined) {
      const waiting = totalBackoffMs(policy, input.maxAttempts);
      if (waiting >= input.deadlineMs) {
        return `[Retry error] the declared backoff waits ${waiting}ms across ${input.maxAttempts} attempts, which already exceeds the ${input.deadlineMs}ms deadline — shorten the backoff or raise the deadline.`;
      }
    }
    const success = new Set(input.successExitCodes ?? [0]);
    const startedAt = Date.now();
    const attempts: Record<string, unknown>[] = [];
    let succeeded = false;
    let stoppedBy: string | null = null;

    for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
      const delay = backoffDelayMs(policy, attempt);
      if (delay > 0) {
        if (input.deadlineMs !== undefined && Date.now() - startedAt + delay >= input.deadlineMs) {
          stoppedBy = "deadline";
          break;
        }
        await sleep(delay, ctx?.signal);
      }
      if (ctx?.signal?.aborted === true) {
        stoppedBy = "aborted";
        break;
      }
      if (input.deadlineMs !== undefined && Date.now() - startedAt >= input.deadlineMs) {
        stoppedBy = "deadline";
        break;
      }
      const outcome = await runOnce(input.argv, {
        cwd: prep.cwd,
        env: prep.env,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputChars: input.maxOutputChars ?? 20_000,
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      const ok = outcome.spawnError === undefined && success.has(outcome.exitCode);
      attempts.push({
        attempt,
        waitedBeforeMs: delay,
        exitCode: outcome.exitCode,
        ok,
        timedOut: outcome.timedOut,
        ...(outcome.spawnError !== undefined ? { spawnError: outcome.spawnError } : {}),
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      });
      if (ok) {
        succeeded = true;
        break;
      }
    }
    return json({
      argv: input.argv,
      succeeded,
      attemptsUsed: attempts.length,
      maxAttempts: input.maxAttempts,
      ...(stoppedBy !== null ? { stoppedBy } : {}),
      attempts,
    });
  },
});

// ---------------------------------------------------------------------------
// background processes
// ---------------------------------------------------------------------------

const procIdSchema = z.string().min(1).describe("an id returned by ProcessStart, e.g. proc_1");

function procStateJson(bg: BgProc): Record<string, unknown> {
  return {
    id: bg.id,
    ...(bg.label !== undefined ? { label: bg.label } : {}),
    command: formatArgv(bg.argv),
    status: bg.status,
    exitCode: bg.exitCode,
    pendingStdoutChars: bg.stdout.length - bg.stdoutReturned,
    pendingStderrChars: bg.stderr.length - bg.stderrReturned,
    ...(bg.truncated ? { earlierOutputDropped: true } : {}),
  };
}

function noSuchProc(toolName: string, id: string): string {
  const known = listProcs().map((p) => p.id);
  return `[${toolName} error] no background process with id "${id}". Known ids: ${known.length === 0 ? "(none)" : known.join(", ")}.`;
}

export const processStart: RegisteredTool = buildTool({
  name: "ProcessStart",
  description:
    "Start a program in the background from an argv array and return an id immediately, without waiting for it to finish. Use it for something that must outlive one tool call — a dev server, a watcher, a tail — then poll it with ProcessStatus and ProcessOutput and end it with ProcessStop. The process is killed if the harness exits, so a session never leaks children.",
  inputSchema: z.object({
    argv: argvSchema,
    cwd: z.string().optional(),
    env: envForwardSchema,
    envSet: envSetSchema,
    stdin: z.string().max(1_000_000).optional(),
    label: z.string().max(80).optional().describe("a name for this process in listings"),
  }),
  destructive: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input) => {
    const bad = checkArgv("ProcessStart", input.argv);
    if (bad !== undefined) return bad;
    const prep = prepare("ProcessStart", input);
    if (!prep.ok) return prep.message;
    const started = startBackground(input.argv, {
      cwd: prep.cwd,
      env: prep.env,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
    });
    if (!started.ok) return `[ProcessStart error] ${started.message}`;
    return json({
      ...procStateJson(started.proc),
      ...(started.evicted > 0 ? { evictedFinishedEntries: started.evicted } : {}),
      note: "poll with ProcessOutput; stop with ProcessStop",
    });
  },
});

export const processStatus: RegisteredTool = buildTool({
  name: "ProcessStatus",
  description:
    "Report whether a background process is still running, and its exit code once it is not. Use it to check on a ProcessStart id without consuming its buffered output, which ProcessOutput would. It reports no timestamps, so the same state answers with the same bytes.",
  inputSchema: z.object({ id: procIdSchema }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const bg = getProc(input.id);
    if (bg === undefined) return noSuchProc("ProcessStatus", input.id);
    return json(procStateJson(bg));
  },
});

export const processOutput: RegisteredTool = buildTool({
  name: "ProcessOutput",
  description:
    "Return what a background process has written since the last poll, and its current status. Use it to follow a long-running process incrementally instead of buffering everything until it exits. Each call advances a per-stream cursor, so output is returned exactly once — use ProcessStatus for a look that consumes nothing.",
  inputSchema: z.object({
    id: procIdSchema,
    stream: z.enum(["stdout", "stderr", "both"]).optional(),
    maxChars: maxOutputSchema.describe("cap per stream for this poll (default 100000)"),
  }),
  // Advancing a read cursor is state: not read-only, and not safe to run
  // beside a sibling that would consume the same bytes.
  execute: async (input) => {
    const bg = getProc(input.id);
    if (bg === undefined) return noSuchProc("ProcessOutput", input.id);
    const which = input.stream ?? "both";
    const cap = input.maxChars ?? DEFAULT_MAX_OUTPUT;
    const result: Record<string, unknown> = { id: bg.id, status: bg.status, exitCode: bg.exitCode };
    if (which === "stdout" || which === "both") {
      const fresh = capText(bg.stdout.slice(bg.stdoutReturned), cap);
      bg.stdoutReturned = bg.stdout.length;
      result["stdout"] = fresh.text;
      if (fresh.truncated) result["stdoutTruncated"] = true;
    }
    if (which === "stderr" || which === "both") {
      const fresh = capText(bg.stderr.slice(bg.stderrReturned), cap);
      bg.stderrReturned = bg.stderr.length;
      result["stderr"] = fresh.text;
      if (fresh.truncated) result["stderrTruncated"] = true;
    }
    if (bg.truncated) result["earlierOutputDropped"] = true;
    return json(result);
  },
});

export const processStop: RegisteredTool = buildTool({
  name: "ProcessStop",
  description:
    "Stop a background process: signal it, wait a bounded grace period, then SIGKILL it if it is still alive. Use it to end a dev server or watcher deterministically rather than leaving it running past the task. Pass reap to drop the entry entirely; otherwise it stays readable so its final output can still be collected.",
  inputSchema: z.object({
    id: procIdSchema,
    signal: z.enum(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"]).optional(),
    killAfterMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe("grace period before escalating to SIGKILL (default 5000)"),
    reap: z.boolean().optional().describe("forget the process entirely once it is stopped"),
  }),
  destructive: true,
  // Signalling an OS process is an effect the runtime cannot re-classify
  // afterwards, exactly like starting one — so this declares the same
  // capability ProcessStart does rather than passing as a registry edit.
  scope: "external",
  ioCapability: "process",
  execute: async (input) => {
    const bg = getProc(input.id);
    if (bg === undefined) return noSuchProc("ProcessStop", input.id);
    if (bg.status !== "running") {
      const reaped = input.reap === true ? reapProc(bg.id) : false;
      return json({
        id: bg.id,
        stopped: false,
        alreadyFinished: true,
        status: bg.status,
        exitCode: bg.exitCode,
        reaped,
      });
    }
    const signal = input.signal ?? "SIGTERM";
    const grace = input.killAfterMs ?? 5_000;
    try {
      bg.proc.kill(signal);
    } catch (err) {
      return `[ProcessStop error] could not signal ${bg.id}: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Record intent before awaiting: the exit handler only fills in the code,
    // so the status stays "killed" rather than looking like a natural exit.
    markKilled(bg);
    let escalated = false;
    const exited = bg.proc.exited.then(() => true);
    const finished = await Promise.race([exited, sleep(grace).then(() => false)]);
    if (!finished) {
      escalated = true;
      try {
        bg.proc.kill("SIGKILL");
      } catch {
        // Gone between the race and the kill.
      }
      // SIGKILL cannot be ignored, but still bound the wait rather than
      // blocking the turn on an unreapable child.
      await Promise.race([exited, sleep(2_000).then(() => false)]);
    }
    const reaped = input.reap === true ? reapProc(bg.id) : false;
    return json({
      id: bg.id,
      stopped: true,
      signal,
      escalatedToSigkill: escalated,
      status: bg.status,
      exitCode: bg.exitCode,
      reaped,
    });
  },
});

export const processList: RegisteredTool = buildTool({
  name: "ProcessList",
  description:
    "List the background processes this harness started, in start order, with their status and how much output is waiting. Use it to find an id you have lost or to check nothing was left running at the end of a task. It shows only processes started through ProcessStart — never the machine's other processes.",
  inputSchema: z.object({
    includeFinished: z
      .boolean()
      .optional()
      .describe("include processes that have exited or been killed (default true)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const all = listProcs();
    const shown = input.includeFinished === false ? all.filter((p) => p.status === "running") : all;
    return json({
      count: shown.length,
      running: all.filter((p) => p.status === "running").length,
      processes: shown.map(procStateJson),
    });
  },
});

// ---------------------------------------------------------------------------
// waiting
// ---------------------------------------------------------------------------

/**
 * One TCP connect attempt. Resolves true when the port accepts, false on
 * refusal, unreachability or its own short timeout — the socket is always
 * destroyed, so a poll loop cannot leak descriptors.
 */
function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: ReturnType<typeof connect>;
    try {
      socket = connect({ host, port });
    } catch {
      // A host the resolver rejects outright: an answer, not an exception to
      // throw out of a tool call.
      resolve(false);
      return;
    }
    let settled = false;
    const done = (open: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      try {
        socket.destroy();
      } catch {
        // Already destroyed.
      }
      resolve(open);
    };
    // The socket's own timeout is the normal bound; this one exists because
    // the probe is the only part of the poll loop the deadline cannot
    // interrupt, and a socket that emitted none of the four events below
    // would hang the whole wait. `done` is never called before this line —
    // every caller of it is an event handler or this timer.
    const hardStop = setTimeout(() => done(false), timeoutMs + 1_000);
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

const HOSTNAME = /^[A-Za-z0-9._:-]+$/;

export const waitForPort: RegisteredTool = buildTool({
  name: "WaitForPort",
  description:
    "Poll a TCP host and port until it is accepting connections, or until it stops, within a required deadline. Use it to wait for a server the harness just started to be ready, instead of guessing with a sleep. It reports whether the condition was met and how many probes it took, and never waits past the deadline.",
  inputSchema: z.object({
    port: z.number().int().min(1).max(65_535),
    host: z.string().max(255).optional().describe("default 127.0.0.1"),
    state: z.enum(["open", "closed"]).optional().describe("the state to wait for (default open)"),
    timeoutMs: deadlineSchema("the poll"),
    intervalMs: intervalSchema,
  }),
  readOnly: true,
  concurrencySafe: true,
  // Opening a socket crosses a network boundary even though nothing is sent
  // on it, so the egress fabric must see this call.
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const host = input.host ?? "127.0.0.1";
    if (!HOSTNAME.test(host)) {
      return `[WaitForPort error] "${host}" is not a hostname or address.`;
    }
    const want = input.state ?? "open";
    const interval = input.intervalMs ?? DEFAULT_POLL_MS;
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutMs;
    let attempts = 0;
    let open = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      attempts++;
      open = await probePort(host, input.port, Math.max(1, Math.min(1_000, remaining)));
      if ((want === "open") === open) {
        return json({
          satisfied: true,
          state: open ? "open" : "closed",
          host,
          port: input.port,
          attempts,
          waitedMs: Date.now() - startedAt,
        });
      }
      if (ctx?.signal?.aborted === true) break;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(interval, left), ctx?.signal);
    }
    return json({
      satisfied: false,
      state: open ? "open" : "closed",
      wanted: want,
      host,
      port: input.port,
      attempts,
      waitedMs: Date.now() - startedAt,
      reason: ctx?.signal?.aborted === true ? "aborted" : "deadline",
    });
  },
});

export const waitForFile: RegisteredTool = buildTool({
  name: "WaitForFile",
  description:
    "Wait for a workspace path to appear, to disappear, or to stop changing size, within a required deadline. Use it to hand off to a process that writes a file — a build artifact, a lock, a downloaded asset — without polling by hand. The path must stay inside the workspace root, and the wait always ends at the deadline.",
  inputSchema: z.object({
    path: z.string().min(1),
    condition: z
      .enum(["exists", "absent", "stable"])
      .optional()
      .describe("'stable' means present and unchanged in size for stableForMs (default exists)"),
    timeoutMs: deadlineSchema("the wait"),
    intervalMs: intervalSchema,
    stableForMs: z
      .number()
      .int()
      .min(10)
      .max(60_000)
      .optional()
      .describe("how long the size must hold still for 'stable' (default 500)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx?: ToolExecuteContext) => {
    const resolved = resolveSafe("WaitForFile", input.path);
    if (!resolved.ok) return resolved.message;
    const target = resolved.path;
    const condition = input.condition ?? "exists";
    const interval = input.intervalMs ?? DEFAULT_POLL_MS;
    const stableFor = input.stableForMs ?? 500;
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutMs;

    /**
     * `null` means "nothing there", a number is the size, and `"escaped"`
     * means the path now resolves outside the root. Containment is re-checked
     * on EVERY poll, not just once up front: the leaf may not exist when the
     * wait starts, so the only honest moment to resolve its symlinks is the
     * moment it does.
     */
    const sizeOf = (): number | "escaped" | null => {
      const where = recheckContainment(target);
      if (where === "escaped") return "escaped";
      if (where === "absent") return null;
      try {
        return statSync(target).size;
      } catch {
        return null;
      }
    };

    let attempts = 0;
    let lastSize: number | null = null;
    let sameSince = 0;
    let size: number | null = null;
    while (Date.now() < deadline) {
      attempts++;
      const probed = sizeOf();
      if (probed === "escaped") {
        return `[WaitForFile error] refused path "${input.path}": it now resolves outside the workspace root through a symlink. Paths must stay inside the workspace root.`;
      }
      size = probed;
      const now = Date.now();
      let satisfied = false;
      if (condition === "exists") satisfied = size !== null;
      else if (condition === "absent") satisfied = size === null;
      else {
        if (size === null) {
          lastSize = null;
          sameSince = 0;
        } else if (size !== lastSize) {
          lastSize = size;
          sameSince = now;
        } else if (now - sameSince >= stableFor) {
          satisfied = true;
        }
      }
      if (satisfied) {
        return json({
          satisfied: true,
          condition,
          path: input.path,
          exists: size !== null,
          ...(size !== null ? { sizeBytes: size } : {}),
          attempts,
          waitedMs: Date.now() - startedAt,
        });
      }
      if (ctx?.signal?.aborted === true) break;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(interval, left), ctx?.signal);
    }
    return json({
      satisfied: false,
      condition,
      path: input.path,
      exists: size !== null,
      attempts,
      waitedMs: Date.now() - startedAt,
      reason: ctx?.signal?.aborted === true ? "aborted" : "deadline",
    });
  },
});

export const waitForOutput: RegisteredTool = buildTool({
  name: "WaitForOutput",
  description:
    "Watch a background process's output until a pattern matches, a failure pattern matches first, or a required deadline passes. Use it to wait for the line that means ready — 'Listening on', 'compiled successfully' — and to give up early when the line that means broken shows up instead. It reads without consuming, so ProcessOutput still returns everything afterwards.",
  inputSchema: z.object({
    id: procIdSchema,
    pattern: z.string().min(1).describe("a JavaScript regular expression source"),
    failurePattern: z
      .string()
      .min(1)
      .optional()
      .describe("when this matches first, stop waiting and report the failure"),
    flags: z.string().max(8).optional().describe("regex flags, e.g. 'i'"),
    stream: z.enum(["stdout", "stderr", "both"]).optional(),
    timeoutMs: deadlineSchema("the watch"),
    intervalMs: intervalSchema,
  }),
  // Matching does not move the output cursor, so two callers can watch the
  // same process without stealing each other's bytes.
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx?: ToolExecuteContext) => {
    const bg = getProc(input.id);
    if (bg === undefined) return noSuchProc("WaitForOutput", input.id);
    const success = compileSafePattern(input.pattern, input.flags ?? "");
    if (!success.ok) return `[WaitForOutput error] ${success.message}`;
    let failure: RegExp | undefined;
    if (input.failurePattern !== undefined) {
      const compiled = compileSafePattern(input.failurePattern, input.flags ?? "");
      if (!compiled.ok) return `[WaitForOutput error] failurePattern — ${compiled.message}`;
      failure = compiled.regex;
    }
    const which = input.stream ?? "both";
    const interval = input.intervalMs ?? DEFAULT_POLL_MS;
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutMs;

    const haystack = (): string =>
      which === "stdout"
        ? bg.stdout
        : which === "stderr"
          ? bg.stderr
          : `${bg.stdout}\n${bg.stderr}`;

    for (;;) {
      const text = haystack();
      const failed = failure?.exec(text) ?? null;
      if (failed !== null) {
        return json({
          matched: false,
          matchedFailure: true,
          id: bg.id,
          match: failed[0],
          status: bg.status,
          exitCode: bg.exitCode,
          waitedMs: Date.now() - startedAt,
        });
      }
      const hit = success.regex.exec(text);
      if (hit !== null) {
        return json({
          matched: true,
          id: bg.id,
          match: hit[0],
          status: bg.status,
          exitCode: bg.exitCode,
          waitedMs: Date.now() - startedAt,
        });
      }
      // A process that has exited will never produce the line; one last look
      // has already happened above, so stop instead of burning the deadline.
      if (bg.status !== "running") {
        return json({
          matched: false,
          id: bg.id,
          reason: "process finished without matching",
          status: bg.status,
          exitCode: bg.exitCode,
          waitedMs: Date.now() - startedAt,
        });
      }
      if (ctx?.signal?.aborted === true) {
        return json({
          matched: false,
          id: bg.id,
          reason: "aborted",
          status: bg.status,
          waitedMs: Date.now() - startedAt,
        });
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return json({
          matched: false,
          id: bg.id,
          reason: "deadline",
          status: bg.status,
          exitCode: bg.exitCode,
          waitedMs: Date.now() - startedAt,
        });
      }
      await sleep(Math.min(interval, left), ctx?.signal);
    }
  },
});

// ---------------------------------------------------------------------------
// asking about the environment
// ---------------------------------------------------------------------------

export const commandExists: RegisteredTool = buildTool({
  name: "CommandExists",
  description:
    "Report whether a program is on PATH and where it resolves, without running it. Use it to check a prerequisite before building a plan around it, so a missing binary is a clear answer rather than a failed command. It searches the same PATH RunCommand would use, in order, and returns the first executable match.",
  inputSchema: z.object({
    name: z.string().min(1).max(255).describe("a bare program name such as 'git' — not a path"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if (input.name.includes("/") || input.name.includes("\\") || input.name.includes("\0")) {
      return `[CommandExists error] "${input.name}" is a path, not a program name — pass a bare name such as "git".`;
    }
    const raw = process.env["PATH"] ?? FALLBACK_PATH;
    const dirs = raw.split(path.delimiter).filter((d) => d !== "");
    for (const dir of dirs) {
      const candidate = path.join(dir, input.name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, fsConstants.X_OK);
        return json({ name: input.name, found: true, path: candidate, searchedDirs: dirs.length });
      } catch {
        // Not here, or not executable — keep looking.
      }
    }
    return json({ name: input.name, found: false, path: null, searchedDirs: dirs.length });
  },
});

export const envInspect: RegisteredTool = buildTool({
  name: "EnvInspect",
  description:
    "Report whether named environment variables are set, and how long their values are, revealing a value only when the caller names it. Use it to check that a credential or configuration variable is present before running something that needs it, without pulling the secret into context. There is no way to list the environment: a name you do not ask for is a name you learn nothing about.",
  inputSchema: z.object({
    names: z
      .array(z.string().min(1).max(255))
      .min(1)
      .max(64)
      .describe("the explicit allow-list of variables to inspect"),
    reveal: z
      .array(z.string().min(1).max(255))
      .max(16)
      .optional()
      .describe("variables whose actual value should be returned; must also appear in names"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const named = new Set(input.names);
    const reveal = input.reveal ?? [];
    const notNamed = reveal.filter((r) => !named.has(r));
    if (notNamed.length > 0) {
      return `[EnvInspect error] reveal lists ${notNamed.join(", ")}, which names does not — add them to names to inspect them.`;
    }
    const { views, invalid } = inspectEnv(process.env, input.names, reveal);
    return json({
      variables: views,
      ...(invalid.length > 0 ? { notEnvironmentNames: invalid } : {}),
      note: "values are withheld unless named in reveal",
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const PROC_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  commandExists,
  envInspect,
  processList,
  processOutput,
  processStart,
  processStatus,
  processStop,
  retry,
  runCommand,
  runPipeline,
  waitForFile,
  waitForOutput,
  waitForPort,
]);
