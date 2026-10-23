/**
 * Shared fixtures for the evaluation-service tests: temp workspaces, session
 * logs written through the real event log the way runtime-core writes them,
 * a scripted judge adapter that records every request, a trace bus that
 * collects its events, pure and impure fake tools, and the lowered
 * provability config at any floor. Kept under `__fixtures__/` so the build
 * excludes it and the runtime tool-name scan never reads its fake tools
 * (scripts/test-only.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CategoricalJudgeOptions } from "@crewhaus/eval-judge";
import { type EventKind, openEventLog } from "@crewhaus/event-log";
import type { IrProvability, IrProvabilityLevel } from "@crewhaus/ir";
import type { ProvabilityTurn } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { z } from "zod";

export const NOW = new Date("2026-10-22T12:00:00.000Z");
export const now = (): Date => NOW;

export const SESSION = "sess_00000000000000aa";
export const OTHER_SESSION = "sess_00000000000000bb";
export const CHILD = "sess_00000000000000cc";

/** A temp directory per test; `cleanup()` removes every one made. */
export function tempDirs(): { make(): string; cleanup(): void } {
  const made: string[] = [];
  return {
    make() {
      const dir = mkdtempSync(join(tmpdir(), "evaluation-service-"));
      made.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Patch = {
  readonly [K in keyof IrProvability]?: IrProvability[K] extends object
    ? IrProvability[K] extends ReadonlyArray<unknown>
      ? IrProvability[K]
      : Partial<IrProvability[K]>
    : IrProvability[K];
};

/** The compiler's lowered defaults at `level`, with `patch` merged one level deep. */
export function config(level: IrProvabilityLevel, patch: Patch = {}): IrProvability {
  const base: IrProvability = {
    level,
    onFail: "retry",
    maxRetries: 1,
    threshold: 1,
    scope: "session",
    assumptions: "allow",
    render: "footer",
    sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
    grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
    execution: {
      allow: ["evaluate", "moneyAdd", "SumFake", "ImpureSum"],
      replay: true,
      maxReplays: 20,
    },
    formal: {
      checkers: ["builtin", "smt"],
      forbid: ["sorry", "axiom", "native_decide"],
      timeoutMs: 30_000,
    },
  };
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
  return out as IrProvability;
}

/** A WebFetch result for `url`, as tool-web prints it. */
export function fetched(url: string, body: string): string {
  return `URL: ${url}\nStatus: 200\nContent-Type: text/html\n\n${body}`;
}

export type LogLine = { readonly kind: EventKind; readonly payload: unknown };

export const userLine = (text: string, synthetic = false): LogLine => ({
  kind: "user_message",
  payload: { content: text, ...(synthetic ? { synthetic: true } : {}) },
});

/** One completed call as runtime-core logs it: `tool_use`, `tool_result`, then the result carrier. */
export function callLines(id: string, name: string, input: unknown, content: string): LogLine[] {
  return [
    { kind: "tool_use", payload: { id, name, input } },
    { kind: "tool_result", payload: { toolUseId: id, content, isError: false } },
    {
      kind: "user_message",
      payload: { content: [{ type: "tool_result", tool_use_id: id, content }] },
    },
  ];
}

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

/** A transcript message (the Anthropic `MessageParam` shape, structurally). */
export type Message = {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<Record<string, unknown>>;
};

export const user = (text: string): Message => ({ role: "user", content: text });
export const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

/** One completed call as transcript messages: the assistant's `tool_use`, then the `tool_result` carrier. */
export function callMessages(id: string, name: string, input: unknown, content: string): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ];
}

/** A bus whose events are collected. */
export function recordingBus(sessionId = SESSION): { bus: TraceEventBus; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const bus = new TraceEventBus({ runId: "run_00000001", sessionId });
  bus.subscribe((event) => {
    events.push(event);
  });
  return { bus, events };
}

/** A completed turn the way runtime-core hands it to `verify`. */
export function turnOf(
  finalText: string,
  opts: {
    readonly messages?: ReadonlyArray<Message>;
    readonly sessionId?: string;
    readonly bus?: TraceEventBus;
    readonly isSynthetic?: (message: Message) => boolean;
    readonly retryIndex?: number;
    readonly turnNumber?: number;
    readonly signal?: AbortSignal;
    readonly judgeShareExhausted?: () => boolean;
    readonly egressAuditSink?: ProvabilityTurn["egressAuditSink"];
  } = {},
): ProvabilityTurn {
  return {
    finalText,
    messages: (opts.messages ?? []) as ProvabilityTurn["messages"],
    usage: { input: 0, output: 0 },
    bus: opts.bus ?? recordingBus().bus,
    turnNumber: opts.turnNumber ?? 1,
    retryIndex: opts.retryIndex ?? 0,
    ...(opts.isSynthetic !== undefined
      ? { isSynthetic: opts.isSynthetic as NonNullable<ProvabilityTurn["isSynthetic"]> }
      : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.judgeShareExhausted !== undefined
      ? { judgeShareExhausted: opts.judgeShareExhausted }
      : {}),
    ...(opts.egressAuditSink !== undefined ? { egressAuditSink: opts.egressAuditSink } : {}),
  };
}

type Adapter = NonNullable<CategoricalJudgeOptions["adapter"]>;
type StreamEvent = Adapter["stream"] extends (req: never) => AsyncIterable<infer E> ? E : never;

export type RecordedRequest = {
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tool?: string;
  readonly system: string;
  readonly user: string;
};

/**
 * A judge adapter that answers every request with the forced tool call
 * `verdict(toolName)` returns, and records what it was asked. Usage is
 * fixed so the priced spend is predictable.
 */
export function scriptedJudge(
  verdict: (toolName: string) => Record<string, unknown>,
  usage = { input: 1000, output: 100 },
): { adapter: Adapter; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const adapter: Adapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      const tool = req.tools?.[0]?.name ?? "submit_score";
      const r = req as unknown as {
        model: string;
        temperature?: number;
        maxTokens?: number;
        system?: ReadonlyArray<{ text: string }>;
        messages: ReadonlyArray<{ content: unknown }>;
      };
      requests.push({
        model: r.model,
        ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
        ...(r.maxTokens !== undefined ? { maxTokens: r.maxTokens } : {}),
        tool,
        system: (r.system ?? []).map((b) => b.text).join("\n"),
        user: String(r.messages[0]?.content ?? ""),
      });
      const answer = verdict(tool);
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start", usage: { input: usage.input, output: 0 } } as StreamEvent;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu", name: tool, input: {} },
        } as StreamEvent;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(answer) },
        } as StreamEvent;
        yield { kind: "content_block_stop", index: 0 } as StreamEvent;
        yield {
          kind: "message_delta",
          stopReason: "tool_use",
          usage: { input: usage.input, output: usage.output },
        } as StreamEvent;
        yield { kind: "message_stop" } as StreamEvent;
      })();
    },
  } as Adapter;
  return { adapter, requests };
}

/** A pure fake tool (read-only, concurrency-safe, internal): sums `a` and `b`. */
export function sumTool(
  name = "SumFake",
  compute: (a: number, b: number) => string = (a, b) => `The sum is ${a + b}.`,
): RegisteredTool {
  return buildTool({
    name,
    description: "Add two numbers.",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    readOnly: true,
    concurrencySafe: true,
    execute: async ({ a, b }) => compute(a, b),
  });
}

/** The same tool, declared with side effects: never replayed. */
export function impureSumTool(onRun: () => void = () => {}): RegisteredTool {
  return buildTool({
    name: "ImpureSum",
    description: "Add two numbers, and write the sum down somewhere.",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    readOnly: false,
    concurrencySafe: false,
    execute: async ({ a, b }) => {
      onRun();
      return `The sum is ${a + b}.`;
    },
  });
}

/** A proof the builtin checker accepts (tool-proof's MEETINGS fixture). */
export const MEETINGS = {
  claim: "No two of the three meetings overlap.",
  statement:
    "let s = [9, 10.5, 13], e = [10, 12, 14] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]",
  proof: "eval",
};
