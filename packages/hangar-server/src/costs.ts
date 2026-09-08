/**
 * Cost folds over durable session logs. A `cost_accrual` line arrives in one
 * of two encodings — the event-log envelope (`{ts, kind, payload: {…}}`) or
 * a flat trace-bus event (fields at the top level) — and this fold accepts
 * both.
 *
 * ---------------------------------------------------------------------------
 * `summary: true` — two different lines wearing one flag (0.6.0 §8.3)
 * ---------------------------------------------------------------------------
 * A ROLE-LESS `summary: true` accrual is a run TOTAL, a sum over per-call
 * accruals this fold has already counted; folding it would double-count, so
 * it stays skipped exactly as before.
 *
 * A ROLE-BEARING one is the opposite: it is a NESTED run's roll-up
 * re-published on the parent bus (`@crewhaus/sub-agent-spawner` publishes
 * `cost_accrual{role: "subagent", summary: true}` inside the sub-agent
 * bracket), priced by its publisher over calls this session never saw. The
 * child's own tracker is opened `suppressEvents: true`, so the child session
 * log carries NO per-call accrual line — skipping the parent's roll-up is the
 * only way this spend can be lost, and until 0.6.0 it was. Folding it is what
 * lets sub-agent spend reach the Costs and Models tabs at all. This is the
 * same split `@crewhaus/cost-tracker` makes on the live bus, and the CLI's
 * `cost-summary` now makes on the same files.
 *
 * A roll-up counts as ONE call in `calls` — it is one line, priced once, over
 * a call count only the child's own log knows. `rollups` reports how many of
 * the folded lines were roll-ups so a reader can see the approximation.
 *
 * The last-7-days window prefers the line's own `ts`; a ts-less line falls
 * back to its file's mtime (honest approximation, flagged nowhere because it
 * only widens the window, never narrows it).
 */
import { readdirSync, statSync } from "node:fs";
import { SESSION_JSONL_RE } from "./constants";
import { readJsonlCapped } from "./jsonl";
import { resolveContained } from "./safety";
import { resolveSessionRoot } from "./sessions";

export type ModelCostRow = {
  readonly provider: string;
  readonly modelId: string;
  readonly calls: number;
  readonly usdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/**
 * 0.6.0 §8.3 — spend grouped by the attribution the 0.6.0 events carry.
 * `role` is `model_response.role` ridden onto the accrual verbatim
 * (`primary` when a priced call carried none — that IS the main turn);
 * `profile` is the `models:` profile of the serving candidate, and a call
 * that resolved no profile is grouped under `"(none)"` rather than dropped,
 * because a per-profile table whose rows do not sum to the total is worse
 * than one that says where the remainder went.
 */
export type RoleCostRow = {
  readonly role: string;
  readonly calls: number;
  readonly usdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type ProfileCostRow = {
  readonly profile: string;
  readonly calls: number;
  readonly usdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/** The role an accrual carrying none belongs to: the main turn. */
export const DEFAULT_COST_ROLE = "primary";

/** The profile bucket for a call that resolved no `models:` profile. */
export const NO_PROFILE = "(none)";

/** One calendar day (UTC) of the trailing-7-day bar series. */
export type DailyCostRow = {
  /** `YYYY-MM-DD` (UTC). */
  readonly day: string;
  readonly usdMicros: number;
  readonly calls: number;
};

export type HarnessCosts = {
  readonly totalUsdMicros: number;
  readonly calls: number;
  readonly spend7dUsdMicros: number;
  readonly byModel: readonly ModelCostRow[];
  /** 0.6.0 — spend by `role`, biggest first (ties broken by name). */
  readonly byRole: readonly RoleCostRow[];
  /** 0.6.0 — spend by `models:` profile, biggest first. */
  readonly byProfile: readonly ProfileCostRow[];
  /** How many folded lines were role-bearing `summary: true` roll-ups. */
  readonly rollups: number;
  /**
   * The last 7 UTC calendar days (oldest first, today last), zero-filled so
   * a no-spend day is visibly present. Per-day buckets are calendar-dated,
   * while `spend7dUsdMicros` is a rolling window — the two may differ at the
   * oldest edge by design.
   */
  readonly days: readonly DailyCostRow[];
  /** Session files whose read hit a cap (the totals are floors, not lies). */
  readonly truncatedFiles: number;
};

type AccrualFields = {
  summary?: boolean;
  role?: string;
  profile?: string;
  provider?: string;
  modelId?: string;
  costUsdMicros?: number;
  inputTokens?: number;
  outputTokens?: number;
  ts?: string;
};

/** One `{calls, usdMicros, inputTokens, outputTokens}` accumulator. */
type Bucket = {
  calls: number;
  usdMicros: number;
  inputTokens: number;
  outputTokens: number;
};

function fold(
  into: Map<string, Bucket>,
  key: string,
  micros: number,
  inputTokens: number,
  outputTokens: number,
): void {
  const b = into.get(key) ?? { calls: 0, usdMicros: 0, inputTokens: 0, outputTokens: 0 };
  b.calls += 1;
  b.usdMicros += micros;
  b.inputTokens += inputTokens;
  b.outputTokens += outputTokens;
  into.set(key, b);
}

/** Biggest spend first; equal spend sorts by key so the order is stable. */
function rankBuckets(buckets: Map<string, Bucket>): Array<{ key: string } & Bucket> {
  return [...buckets.entries()]
    .map(([key, b]) => ({ key, ...b }))
    .sort((a, b) => b.usdMicros - a.usdMicros || a.key.localeCompare(b.key));
}

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

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
  let rollups = 0;
  const byModel = new Map<string, ModelCostRow>();
  const byRole = new Map<string, Bucket>();
  const byProfile = new Map<string, Bucket>();
  // Zero-filled trailing-7-day buckets, oldest first — the UI bar chart
  // renders absence as a baseline sliver, never as missing data.
  const byDay = new Map<string, { usdMicros: number; calls: number }>();
  for (let i = 6; i >= 0; i -= 1) {
    byDay.set(utcDay(nowMs - i * DAY_MS), { usdMicros: 0, calls: 0 });
  }

  for (const file of files.sort()) {
    // Containment per file: a symlink in the session root must not pull an
    // arbitrary log into the cost fold.
    const path = resolveContained(root, file);
    if (path === undefined) continue;
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
      // See the module docblock: a role-LESS roll-up is a run total already
      // counted per call; a role-BEARING one is a nested run whose per-call
      // lines live in another log (or, for a suppressed child tracker, in no
      // log at all).
      const role = typeof fields.role === "string" && fields.role !== "" ? fields.role : undefined;
      if (fields.summary === true) {
        if (role === undefined) continue;
        rollups += 1;
      }
      const micros = typeof fields.costUsdMicros === "number" ? fields.costUsdMicros : 0;
      const provider = typeof fields.provider === "string" ? fields.provider : "unknown";
      const modelId = typeof fields.modelId === "string" ? fields.modelId : "unknown";
      const inputTokens = typeof fields.inputTokens === "number" ? fields.inputTokens : 0;
      const outputTokens = typeof fields.outputTokens === "number" ? fields.outputTokens : 0;
      const profile =
        typeof fields.profile === "string" && fields.profile !== "" ? fields.profile : NO_PROFILE;
      totalUsdMicros += micros;
      calls += 1;
      fold(byRole, role ?? DEFAULT_COST_ROLE, micros, inputTokens, outputTokens);
      fold(byProfile, profile, micros, inputTokens, outputTokens);
      const tsRaw =
        typeof fields.ts === "string" ? fields.ts : typeof top.ts === "string" ? top.ts : undefined;
      const tsMs =
        tsRaw !== undefined && !Number.isNaN(Date.parse(tsRaw)) ? Date.parse(tsRaw) : mtimeMs;
      if (nowMs - tsMs <= WEEK_MS) spend7d += micros;
      const bucket = byDay.get(utcDay(tsMs));
      if (bucket !== undefined) {
        bucket.usdMicros += micros;
        bucket.calls += 1;
      }
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
        inputTokens: row.inputTokens + inputTokens,
        outputTokens: row.outputTokens + outputTokens,
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
    byRole: rankBuckets(byRole).map(({ key, ...b }) => ({ role: key, ...b })),
    byProfile: rankBuckets(byProfile).map(({ key, ...b }) => ({ profile: key, ...b })),
    rollups,
    days: [...byDay.entries()].map(([day, b]) => ({ day, ...b })),
    truncatedFiles,
  };
}
