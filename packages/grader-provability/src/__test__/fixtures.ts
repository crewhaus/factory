/**
 * Test fixtures: REAL proof bundles from `@crewhaus/provability`'s own
 * `verifyDocument` over a hand-built evidence index — so the graders are
 * tested against the shape the gate actually produces, not a guess at it —
 * plus a RunResult / trace-event builder.
 */
import type { RunResult, Sample } from "@crewhaus/eval-grader";
import {
  type ProofBundle,
  type ProvabilityConfig,
  type ProvabilityLevel,
  type VerifyOptions,
  buildEvidenceIndex,
  recordFromCall,
  verifyDocument,
} from "@crewhaus/provability";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

export const NOW = new Date("2026-10-22T12:00:00.000Z");
export const POLICY = "https://acme.example/policy";

type Patch = { readonly [K in keyof ProvabilityConfig]?: unknown };

/** The compiler's resolved defaults at `level`, `patch` merged one level deep. */
export function config(level: ProvabilityLevel, patch: Patch = {}): ProvabilityConfig {
  const base: ProvabilityConfig = {
    level,
    onFail: "retry",
    maxRetries: 1,
    threshold: 1,
    scope: "session",
    assumptions: "allow",
    render: "footer",
    sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
    grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
    execution: { allow: ["moneyAdd", "mcp__calc__add"], replay: true, maxReplays: 20 },
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
  return out as ProvabilityConfig;
}

export type Call = {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
  readonly content: string;
  readonly isError?: boolean;
};

/** A WebFetch result for `url`, as tool-web prints it. */
export function fetched(url: string, body: string): string {
  return `URL: ${url}\nStatus: 200\nContent-Type: text/html\n\n${body}`;
}

export const moneyAdd = (amount: string): string =>
  JSON.stringify({ currency: "USD", minorUnits: amount.replace(".", ""), exponent: 2, amount });

/** The gate's bundle for `text` at `level` over `calls`. */
export async function bundleFor(
  text: string,
  level: ProvabilityLevel,
  calls: ReadonlyArray<Call> = [],
  extra: Omit<Partial<VerifyOptions>, "config" | "evidence"> & { readonly patch?: Patch } = {},
): Promise<ProofBundle> {
  const { patch, ...rest } = extra;
  const evidence = buildEvidenceIndex(
    calls.map((c) =>
      recordFromCall({
        toolUseId: c.id,
        toolName: c.name,
        input: c.input ?? {},
        content: c.content,
        isError: c.isError ?? false,
      }),
    ),
  );
  return verifyDocument(text, {
    config: config(level, patch),
    evidence,
    now: () => NOW,
    ...rest,
  });
}

/** One WebFetch of POLICY whose body says the refund window is 14 days. */
export const POLICY_FETCH: Call = {
  id: "toolu_fetch",
  name: "WebFetch",
  input: { url: POLICY },
  content: fetched(POLICY, "Our refund window is 14 days from delivery."),
};

/** A RunResult carrying `proof` (or none), with `events`. */
export function runWith(
  proof: ProofBundle | undefined,
  events: ReadonlyArray<TraceEvent> = [],
): RunResult {
  return {
    agentOutput: "",
    events,
    transcript: [],
    toolCalls: [],
    turns: 1,
    latencyMs: 0,
    artifacts: {
      sampleDir: "/tmp/sample",
      sessionId: "sess_0000000000000000",
      transcriptPath: "/tmp/sample/transcript.jsonl",
      stateRootDir: "/tmp/sample/.crewhaus",
      ...(proof !== undefined ? { proof } : {}),
    },
  };
}

export const sample = (metadata?: Record<string, unknown>): Sample => ({
  id: "s1",
  input: "What is the refund window?",
  ...(metadata !== undefined ? { metadata } : {}),
});

let seq = 0;
/** A trace event with a full envelope on turn `turnNumber` (default 1). */
export function ev(fields: Record<string, unknown>, turnNumber = 1): TraceEvent {
  seq += 1;
  return {
    runId: "run_1",
    sessionId: "sess_0000000000000000",
    turnNumber,
    traceId: "0".repeat(32),
    spanId: seq.toString(16).padStart(16, "0"),
    timestamp: NOW.toISOString(),
    ...fields,
  } as unknown as TraceEvent;
}

/** A `provability_graded` pass. */
export const pass = (
  verdict: "pass" | "fail",
  retryIndex: number,
  extra: Record<string, unknown> = {},
  turnNumber = 1,
): TraceEvent =>
  ev(
    {
      kind: "provability_graded",
      level: "grounded",
      verdict,
      score: verdict === "pass" ? 1 : 0,
      threshold: 1,
      achieved: verdict === "pass" ? "grounded" : "none",
      claims: 1,
      met: verdict === "pass" ? 1 : 0,
      unmet: verdict === "pass" ? 0 : 1,
      assumptions: 0,
      retryIndex,
      maxRetries: 2,
      bundleHash: `sha256:${retryIndex}`,
      ...extra,
    },
    turnNumber,
  );

/** A `cost_accrual` of `micros`. */
export const accrual = (
  micros: number,
  extra: Record<string, unknown> = {},
  turnNumber = 1,
): TraceEvent =>
  ev(
    {
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 0,
      costUsdMicros: micros,
      ...extra,
    },
    turnNumber,
  );

/** A `model_response` with `input`/`output` tokens. */
export const response = (
  input: number,
  output: number,
  extra: Record<string, unknown> = {},
  turnNumber = 1,
): TraceEvent =>
  ev(
    {
      kind: "model_response",
      model: "claude-haiku-4-5",
      stopReason: "end_turn",
      usage: { input, output },
      durationMs: 10,
      ...extra,
    },
    turnNumber,
  );
