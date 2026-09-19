/**
 * Fixture builders for the tests: an evals directory, a run directory, session
 * logs, golden verdicts and a graders config.
 *
 * Everything is written to a real temporary directory and read back through
 * the tools, because every claim this package makes is a claim about files —
 * a stub reader would test the stub. Timestamps are explicit and mtimes are
 * SET rather than inherited, so no ordering here depends on how fast the test
 * machine is.
 */
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EVALS_DIR = ".crewhaus/evals";
export const SESSIONS_DIR = ".crewhaus/sessions";

/** A workspace root under the OS temp dir, realpath'd so the containment
 *  resolver's own realpath of `process.cwd()` matches it on macOS. */
export function makeWorkspace(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "evalops-")));
}

export type Row = {
  runId: string;
  specName: string;
  specHash: string;
  datasetName: string;
  datasetHash: string;
  gradersHash?: string;
  judgeModel?: string;
  passRate: number;
  meanScore: number;
  sampleCount: number;
  p95LatencyMs?: number;
  costUsd?: number;
  flakyCount?: number;
  partial?: boolean;
  replayed?: boolean;
  armId?: string;
  routing?: string;
  policyVersion?: string;
  armsDigest?: string;
  ts: string;
  outDir: string;
};

/** One index row, with the fields a current CLI always writes. */
export function row(overrides: Partial<Row> & { runId: string; ts: string }): Row {
  return {
    specName: "shop",
    specHash: "spec-1",
    datasetName: "smoke",
    datasetHash: "data-1",
    gradersHash: "graders-1",
    passRate: 0.5,
    meanScore: 0.5,
    sampleCount: 10,
    outDir: join(EVALS_DIR, overrides.runId),
    ...overrides,
  };
}

/** Write `index.jsonl`. Raw strings are written verbatim, which is how a torn
 *  line gets into a fixture. */
export function writeIndex(root: string, rows: ReadonlyArray<Row | string>): void {
  const dir = join(root, EVALS_DIR);
  mkdirSync(dir, { recursive: true });
  const lines = rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
  writeFileSync(join(dir, "index.jsonl"), `${lines.join("\n")}\n`);
}

/** Write `baselines.json`. A raw string goes in verbatim (malformed fixtures). */
export function writeBaselines(root: string, content: Record<string, unknown> | string): void {
  const dir = join(root, EVALS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "baselines.json"),
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

/** A pin in the shape `setBaseline` writes. */
export function pin(r: Row): Record<string, unknown> {
  return {
    specName: r.specName,
    datasetName: r.datasetName,
    runId: r.runId,
    outDir: join(r.outDir),
    datasetHash: r.datasetHash,
    ...(r.gradersHash !== undefined ? { gradersHash: r.gradersHash } : {}),
    ...(r.armId !== undefined ? { armId: r.armId } : {}),
    ...(r.routing !== undefined ? { routing: r.routing } : {}),
    ts: r.ts,
  };
}

export type SampleOverrides = {
  sampleId?: string;
  passed?: boolean;
  score?: number;
  abstained?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
  trials?: ReadonlyArray<{ passed: boolean }>;
  latencyMs?: number;
  turns?: number;
  tokens?: { input: number; output: number } | null;
};

/** One `SampleResult`, in the shape a persisted results.json carries. */
export function sample(o: SampleOverrides = {}): Record<string, unknown> {
  const passed = o.passed ?? true;
  const base: Record<string, unknown> = {
    sampleId: o.sampleId ?? "s1",
    sessionId: "sess",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    latencyMs: o.latencyMs ?? 100,
    turns: o.turns ?? 1,
    model: "test-model",
    agentOutput: "out",
    grades: {
      overall: {
        passed,
        score: o.score ?? (passed ? 1 : 0),
        ...(o.abstained === true ? { abstained: true } : {}),
      },
      perGrader: [],
    },
    ...(o.metadata !== undefined ? { metadata: o.metadata } : {}),
    ...(o.error !== undefined ? { error: o.error } : {}),
    ...(o.trials !== undefined
      ? {
          trials: o.trials.map((t, i) => ({
            trial: i + 1,
            passed: t.passed,
            score: t.passed ? 1 : 0,
            latencyMs: 100,
            turns: 1,
            tokens: { input: 1, output: 1 },
          })),
          trialPassRate: o.trials.filter((t) => t.passed).length / o.trials.length,
        }
      : {}),
  };
  // `tokens: null` is how a test asks for the field to be MISSING — the shape
  // an older persisted run has, and the one that makes the engine's fold throw.
  if (o.tokens !== null) base["tokens"] = o.tokens ?? { input: 10, output: 20 };
  return base;
}

/**
 * Write a run directory: `results.json` plus one directory per sample with an
 * `events.jsonl`, exactly as the runner lays one out.
 */
export function writeRun(
  root: string,
  runId: string,
  opts: {
    samples: ReadonlyArray<Record<string, unknown>>;
    aggregates?: Record<string, unknown>;
    config?: Record<string, unknown>;
    /** sampleId -> tool names the run really called. */
    events?: Record<string, ReadonlyArray<string>>;
    dir?: string;
  },
): string {
  const rel = opts.dir ?? join(EVALS_DIR, runId);
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  const summary: Record<string, unknown> = {
    runId,
    samples: opts.samples,
    config: opts.config ?? { datasetName: "smoke" },
    ...(opts.aggregates !== undefined ? { aggregates: opts.aggregates } : {}),
  };
  writeFileSync(join(dir, "results.json"), `${JSON.stringify(summary, null, 2)}\n`);
  for (const [sampleId, tools] of Object.entries(opts.events ?? {})) {
    const sampleDir = join(dir, sampleId);
    mkdirSync(sampleDir, { recursive: true });
    // The shape `toolNamesFromEventsJsonl` reads: `kind: "tool_call_end"` with
    // a `toolName`. The production session logs use a different shape
    // (`assistant_message` with `tool_use` blocks) and both are exercised.
    const lines = tools.map((toolName) => JSON.stringify({ kind: "tool_call_end", toolName }));
    writeFileSync(join(sampleDir, "events.jsonl"), `${lines.join("\n")}\n`);
  }
  return rel;
}

/** A production session log: assistant turns with tool_use blocks. */
export function writeSession(
  root: string,
  id: string,
  opts: {
    tools: ReadonlyArray<ReadonlyArray<string>>;
    inputs?: ReadonlyArray<string>;
    compaction?: boolean;
    /** Written verbatim, for torn-line fixtures. */
    extraLines?: ReadonlyArray<string>;
    /** Explicit mtime so recency never depends on write speed. */
    mtimeSeconds?: number;
  },
): void {
  const dir = join(root, SESSIONS_DIR);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const input of opts.inputs ?? []) {
    lines.push(JSON.stringify({ kind: "user_message", payload: { content: input } }));
  }
  for (const turn of opts.tools) {
    lines.push(
      JSON.stringify({
        kind: "assistant_message",
        payload: { content: turn.map((name) => ({ type: "tool_use", name })) },
      }),
    );
  }
  if (opts.compaction === true) lines.push(JSON.stringify({ kind: "compaction", payload: {} }));
  for (const extra of opts.extraLines ?? []) lines.push(extra);
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  if (opts.mtimeSeconds !== undefined) utimesSync(file, opts.mtimeSeconds, opts.mtimeSeconds);
}

/** A dataset JSONL. */
export function writeDataset(
  root: string,
  rel: string,
  samples: ReadonlyArray<Record<string, unknown>>,
): string {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`);
  return rel;
}

/** Golden verdicts, in the strict schema `parseGoldenVerdicts` enforces. */
export function goldens(
  rows: ReadonlyArray<{ id: string; output: string; expected: boolean; score?: number }>,
): string {
  return `${rows
    .map((r) =>
      JSON.stringify({
        id: r.id,
        input: "q",
        agent_output: r.output,
        expected_passed: r.expected,
        ...(r.score !== undefined ? { expected_score: r.score } : {}),
      }),
    )
    .join("\n")}\n`;
}

/** A graders config with a deterministic `contains` grader. */
export const CONTAINS_YAML = `graders:
  - name: has_ok
    type: contains
    substring: ok
`;

/** A config whose only entry needs a model call. */
export const JUDGE_YAML = `graders:
  - name: judge
    type: llm_judge
    rubric:
      criteria:
        - name: c1
          description: ok
          anchors: { 1: bad, 2: meh, 3: ok, 4: good, 5: great }
`;

/** A config whose only entry resolves through the pack registry. */
export const REGISTRY_YAML = `graders:
  - name: reg
    type: registry
    grader: nlg.rougeL
`;
