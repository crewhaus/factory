/**
 * Cost folds over durable session logs. A `cost_accrual` line arrives in one
 * of two encodings — the event-log envelope (`{ts, kind, payload: {…}}`) or
 * a flat trace-bus event (fields at the top level) — and this fold accepts
 * both, skipping the terminal `summary: true` aggregate line so a run total
 * is never double-counted (the same stance as the CLI's cost-summary and
 * incident folds).
 *
 * The last-7-days window prefers the line's own `ts`; a ts-less line falls
 * back to its file's mtime (honest approximation, flagged nowhere because it
 * only widens the window, never narrows it).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSION_JSONL_RE } from "./constants";
import { readJsonlCapped } from "./jsonl";
import { resolveSessionRoot } from "./sessions";

export type ModelCostRow = {
  readonly provider: string;
  readonly modelId: string;
  readonly calls: number;
  readonly usdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type HarnessCosts = {
  readonly totalUsdMicros: number;
  readonly calls: number;
  readonly spend7dUsdMicros: number;
  readonly byModel: readonly ModelCostRow[];
  /** Session files whose read hit a cap (the totals are floors, not lies). */
  readonly truncatedFiles: number;
};

type AccrualFields = {
  summary?: boolean;
  provider?: string;
  modelId?: string;
  costUsdMicros?: number;
  inputTokens?: number;
  outputTokens?: number;
  ts?: string;
};

const WEEK_MS = 7 * 86_400_000;

/** Fold every `sess_*.jsonl` under the harness's resolved session root. */
export function foldHarnessCosts(harnessDir: string, nowMs: number): HarnessCosts {
  const { root } = resolveSessionRoot(harnessDir);
  let files: string[];
  try {
    files = readdirSync(root).filter((f) => SESSION_JSONL_RE.test(f));
  } catch {
    files = [];
  }
  let totalUsdMicros = 0;
  let calls = 0;
  let spend7d = 0;
  let truncatedFiles = 0;
  const byModel = new Map<string, ModelCostRow>();

  for (const file of files.sort()) {
    const path = join(root, file);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // vanished mid-scan
    }
    const read = readJsonlCapped(path);
    if (read.truncated) truncatedFiles += 1;
    for (const obj of read.objects) {
      if (typeof obj !== "object" || obj === null) continue;
      const top = obj as { kind?: unknown; payload?: unknown; ts?: unknown };
      if (top.kind !== "cost_accrual") continue;
      // Prefer the nested payload (session-log envelope); fall back flat.
      const fields = (
        typeof top.payload === "object" && top.payload !== null ? top.payload : obj
      ) as AccrualFields;
      if (fields.summary === true) continue;
      const micros = typeof fields.costUsdMicros === "number" ? fields.costUsdMicros : 0;
      const provider = typeof fields.provider === "string" ? fields.provider : "unknown";
      const modelId = typeof fields.modelId === "string" ? fields.modelId : "unknown";
      totalUsdMicros += micros;
      calls += 1;
      const tsRaw =
        typeof fields.ts === "string" ? fields.ts : typeof top.ts === "string" ? top.ts : undefined;
      const tsMs =
        tsRaw !== undefined && !Number.isNaN(Date.parse(tsRaw)) ? Date.parse(tsRaw) : mtimeMs;
      if (nowMs - tsMs <= WEEK_MS) spend7d += micros;
      const key = `${provider}/${modelId}`;
      const row = byModel.get(key) ?? {
        provider,
        modelId,
        calls: 0,
        usdMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      byModel.set(key, {
        ...row,
        calls: row.calls + 1,
        usdMicros: row.usdMicros + micros,
        inputTokens:
          row.inputTokens + (typeof fields.inputTokens === "number" ? fields.inputTokens : 0),
        outputTokens:
          row.outputTokens + (typeof fields.outputTokens === "number" ? fields.outputTokens : 0),
      });
    }
  }

  return {
    totalUsdMicros,
    calls,
    spend7dUsdMicros: spend7d,
    byModel: [...byModel.values()].sort((a, b) =>
      `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`),
    ),
    truncatedFiles,
  };
}
