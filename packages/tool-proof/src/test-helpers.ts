/**
 * Shared fixtures for the tool-proof tests: temp workspaces, a session event
 * log written the way runtime-core writes it, a tool context carrying a run
 * context, a bus and an event log the way the runtime's bridge does, a
 * scripted sandbox, and the lowered provability config at any floor.
 * Excluded from the build by name (scripts/test-only.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventKind, openEventLog } from "@crewhaus/event-log";
import type { SandboxLike } from "@crewhaus/proof-checker";
import type { ProvabilityConfig, ProvabilityLevel } from "@crewhaus/provability";
import type { ToolExecuteContext } from "@crewhaus/tool-catalog";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { defaultProvabilityConfig } from "./lib/config";

export const NOW = new Date("2026-10-22T12:00:00.000Z");
export const now = (): Date => NOW;

export const SESSION = "sess_00000000000000aa";
export const CHILD = "sess_00000000000000bb";
export const GRANDCHILD = "sess_00000000000000cc";

/** A temp directory per test; `cleanup()` removes every one made. */
export function tempDirs(): { make(): string; cleanup(): void } {
  const made: string[] = [];
  return {
    make() {
      const dir = mkdtempSync(join(tmpdir(), "tool-proof-"));
      made.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Patch = {
  readonly [K in keyof ProvabilityConfig]?: ProvabilityConfig[K] extends object
    ? ProvabilityConfig[K] extends ReadonlyArray<unknown>
      ? ProvabilityConfig[K]
      : Partial<ProvabilityConfig[K]>
    : ProvabilityConfig[K];
};

/** The lowered defaults at `level`, with `patch` merged one level deep. */
export function config(level: ProvabilityLevel, patch: Patch = {}): ProvabilityConfig {
  const base: ProvabilityConfig = { ...defaultProvabilityConfig(), level };
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prior = (base as Record<string, unknown>)[key];
    out[key] =
      prior !== null &&
      typeof prior === "object" &&
      !Array.isArray(prior) &&
      typeof value === "object"
        ? { ...(prior as object), ...(value as object) }
        : value;
  }
  return out as ProvabilityConfig;
}

/** A WebFetch result for `url`, as tool-web prints it. */
export function fetched(url: string, body: string): string {
  return `URL: ${url}\nStatus: 200\nContent-Type: text/html\n\n${body}`;
}

export type LogLine = { readonly kind: EventKind; readonly payload: unknown };

export const userMessage = (text: string, synthetic = false): LogLine => ({
  kind: "user_message",
  payload: { content: text, ...(synthetic ? { synthetic: true } : {}) },
});

/** One completed call: its `tool_use`, the tool-result carrier and the `tool_result`. */
export function call(
  id: string,
  name: string,
  input: unknown,
  content: string,
  isError = false,
): LogLine[] {
  return [
    { kind: "tool_use", payload: { id, name, input } },
    { kind: "tool_result", payload: { toolUseId: id, content, isError } },
    {
      kind: "user_message",
      payload: { content: [{ type: "tool_result", tool_use_id: id, content }] },
    },
  ];
}

export const subAgent = (childSessionId: string): LogLine => ({
  kind: "sub_agent_start",
  payload: { childSessionId },
});

/** Append `lines` to `<rootDir>/<sessionId>.jsonl` through the real event log. */
export async function writeLog(
  rootDir: string,
  sessionId: string,
  lines: ReadonlyArray<LogLine>,
): Promise<void> {
  const log = await openEventLog(sessionId, { rootDir });
  try {
    for (const line of lines) await log.append(line);
  } finally {
    await log.close();
  }
}

/** Every line of a session log. */
export async function readLog(rootDir: string, sessionId: string): Promise<LogLine[]> {
  const log = await openEventLog(sessionId, { rootDir });
  const out: LogLine[] = [];
  try {
    for await (const event of log.read()) out.push({ kind: event.kind, payload: event.payload });
  } finally {
    await log.close();
  }
  return out;
}

export type FakeRun = {
  readonly ctx: ToolExecuteContext;
  readonly events: TraceEvent[];
  readonly appended: Array<{ kind: string; payload: unknown }>;
  readonly warnings: string[];
};

/**
 * A tool context the way runtime-core hands one over: the run context on
 * the bridge (and nowhere else — the executor forwards only the bridge), a
 * real trace bus whose events are collected, an event log whose appends are
 * collected, and the session root.
 */
export function fakeRun(
  opts: {
    readonly sessionId?: string;
    readonly sessionRootDir?: string;
    readonly sandboxAvailable?: boolean;
    readonly signal?: AbortSignal;
    readonly appendThrows?: boolean;
    readonly specName?: string;
  } = {},
): FakeRun {
  const sessionId = opts.sessionId ?? SESSION;
  const events: TraceEvent[] = [];
  const appended: Array<{ kind: string; payload: unknown }> = [];
  const warnings: string[] = [];
  const eventBus = new TraceEventBus({ runId: "run_00000001", sessionId });
  eventBus.subscribe((event) => {
    events.push(event);
  });
  const runContext = {
    runId: "run_00000001",
    sessionId,
    turnNumber: 1,
    eventBus,
    logger: { warn: (msg: string) => warnings.push(msg) },
    ...(opts.specName !== undefined ? { specName: opts.specName } : {}),
  };
  const bridge = {
    runContext,
    eventLog: {
      async append(event: { kind: string; payload: unknown }) {
        if (opts.appendThrows === true) throw new Error("disk full");
        appended.push(event);
      },
    },
    ...(opts.sessionRootDir !== undefined ? { sessionRootDir: opts.sessionRootDir } : {}),
    ...(opts.sandboxAvailable === true ? { sandboxAvailable: true } : {}),
  };
  return {
    ctx: { bridge, ...(opts.signal !== undefined ? { signal: opts.signal } : {}) },
    events,
    appended,
    warnings,
  };
}

export type ExecCall = {
  readonly image: string;
  readonly argv: ReadonlyArray<string>;
  readonly stdin?: string;
};

export type FakeReply = {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
};

/** A scripted sandbox: records every exec and answers from `reply`. */
export function fakeSandbox(
  reply: (call: ExecCall) => FakeReply,
  backend = "docker",
): SandboxLike & { readonly calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    backend,
    calls,
    async exec(opts) {
      const call: ExecCall = {
        image: opts.image,
        argv: [...opts.argv],
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      };
      calls.push(call);
      const r = reply(call);
      return {
        exitCode: r.exitCode === undefined ? 0 : r.exitCode,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        ...(r.timedOut !== undefined ? { timedOut: r.timedOut } : {}),
      };
    },
  };
}

/**
 * What real Z3 prints for the smt checker's two-check script (captured from
 * z3 4.x; proof-checker's smt tests pin the same strings). The health probe
 * (`z3 --version`) gets a version line.
 */
export const Z3 = {
  version: "Z3 version 4.13.0 - 64 bit\n",
  proved: 'sat\nunsat\n(error "line 11 column 10: model is not available")\n',
  counterexample:
    "sat\nsat\n(\n  (define-fun x () Int\n    4)\n  (define-fun y () Int\n    (- 6))\n)\n",
};

/** A sandbox that answers the z3 health probe and then `answer` for every check. */
export function z3Sandbox(answer: string): ReturnType<typeof fakeSandbox> {
  return fakeSandbox((call) =>
    call.argv.includes("--version") ? { stdout: Z3.version } : { stdout: answer },
  );
}

/** A certificate the builtin checker accepts: no two of three meetings overlap. */
export const MEETINGS = {
  claim: "No two of the three meetings overlap.",
  statement:
    "let s = [9, 10.5, 13], e = [10, 12, 14] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]",
  proof: "eval",
  /** The same claim over meetings that do overlap (meeting 1 ends at 10.5, meeting 2 starts at 10). */
  falseStatement:
    "let s = [9, 10, 13], e = [10.5, 12, 14] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]",
};
