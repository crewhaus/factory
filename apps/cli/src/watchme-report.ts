/**
 * "Watch me" report assembly — the pure phase-1/phase-2 core behind
 * `crewhaus watchme report` (design/watch-me.md §7, §8, §9).
 *
 * Phase 1 is deterministic and replayable: enumerate sessions past the store
 * watermark, reconstruct turns with the ONE canonical `deriveTurns` (the
 * turnNumber contract), attribute per-turn model/cost usage (`joinConfidence:
 * "exact"` from the `.events.jsonl` sibling's `model_response` envelopes vs
 * `"ordered"` from the durable mirrors — ordered data aggregates at SESSION
 * level only, never per-turn), run the five deterministic continuity graders
 * and the three real `twelve.*` factuality graders, replay a counterfactual
 * cheaper-model analysis from the pricing table (unpriced = UNKNOWN, never
 * free), cluster recurring intents, join the human feedback signal, and append
 * redacted `WatchmeObservation` digests to the long-horizon store.
 *
 * Phase 2 is the ONE budgeted model pass: a sampled judge over ungraded turns,
 * refused outright for an unpriced judge model (the dream-engine pattern — a
 * refusal consumes the report window; a transient model failure does not),
 * hard-stopped at the budget cap, with evidence derived by scanning the judge
 * phase's OWN session JSONL — never by trusting model claims. Verdicts land in
 * watchme's own `judgments.jsonl`, NOT the human feedback channel (§9); the
 * explicit `--emit-feedback` bridge converts them to bare FeedbackRecords with
 * source `"watchme"`, and the explicit `--feed-routing` bridge records SHADOW
 * `q:`-prefixed scoreboard arms through `joinQualityToArms` + `computeReward`
 * with the new `RouteObservation.quality` field (§8).
 *
 * Everything effectful is INJECTED (fs, clock, deriveTurns, the intents
 * functions, the grader registry, the scoreboard opener, pricing, the redact
 * callback, the JudgePhase seam, the shared-findings recall seam) so the
 * module is unit-testable without a live harness — the watch.ts/feedback.ts
 * pure-module convention. The CLI entry file wires the real seams.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CandidateProvider,
  CapabilityRequirement,
  CapabilityTable,
  PricingTable,
} from "@crewhaus/cost-tracker";
import {
  cacheProfileFromTotals,
  computeCostMicros,
  enumerateCandidates,
  providerOfSpecString,
  rankCandidates,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, Grader, RunResult, ToolCall } from "@crewhaus/eval-grader";
import type { ArmStats, Scoreboard } from "@crewhaus/routing-store";
import { computeReward } from "@crewhaus/routing-store";
import { parseSessionLog } from "@crewhaus/session-store";
import type {
  HarnessEntry,
  QualityArmRow,
  RouteDecision,
  TurnQuality,
  WatchmeAggregate,
  WatchmeJudgment,
  WatchmeObservation,
  WatchmeStore,
} from "@crewhaus/watchme-store";
import type { AdviceFinding } from "./advise-rules";
import { buildSuggestionsFile } from "./advise-rules";
import type { DerivedTurn, FeedbackRecord, LoggedEvent, SessionTurn } from "./feedback";
import {
  buildFeedbackRecord,
  extractFeedbackRecords,
  mergeFeedback,
  normalizeRating,
} from "./feedback";
import { harvestFewShot } from "./fewshot";
import type { IntentDigest, OrderedTurn, TurnSignal } from "./intents";

/** Thrown on unusable inputs; the CLI routes it through `die()`. */
export class WatchmeReportError extends Error {
  override readonly name = "WatchmeReportError";
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Report-window cadence for the phase-2 judge (`windowKey` granularity):
 *  one budgeted judge pass per window per harness (dream-engine semantics). */
export const WATCHME_JUDGE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Raw observation lines at/above which the store is compacted after a report
 *  (the scoreboard-style bounded-file discipline). */
export const WATCHME_COMPACT_THRESHOLD = 256;

/** Cap on the durable per-session `observed` cursor and the `fedRoutingKeys`
 *  list held in `state.json` (which `compact()` never rewrites). Keeps the
 *  state document small on long-lived harnesses; the cursor evicts its oldest
 *  entries by `mtimeMs`, the fed-key list evicts oldest-first. A session whose
 *  cursor entry was evicted falls back to the scalar watermark pre-filter. */
export const WATCHME_STATE_CURSOR_CAP = 5000;

/** Keep only the most-recently-touched `observed` cursor entries (by mtimeMs). */
function boundObserved(
  observed: Record<string, { mtimeMs: number; turnCount: number }>,
): Record<string, { mtimeMs: number; turnCount: number }> {
  const entries = Object.entries(observed);
  if (entries.length <= WATCHME_STATE_CURSOR_CAP) return observed;
  return Object.fromEntries(
    entries.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs).slice(0, WATCHME_STATE_CURSOR_CAP),
  );
}

/** Keep only the most-recent fed-routing keys (oldest-first eviction). */
function boundFedKeys(keys: ReadonlyArray<string>): string[] {
  return keys.length <= WATCHME_STATE_CURSOR_CAP
    ? [...keys]
    : keys.slice(keys.length - WATCHME_STATE_CURSOR_CAP);
}

/** The five report.md section headings, in render order — pinned by tests. */
export const REPORT_SECTION_TITLES: ReadonlyArray<string> = [
  "Response quality",
  "Continuity",
  "Factuality",
  "Model usage & counterfactuals",
  "Recurring intents",
];

/** Machine-consumable verification argv attached to every counterfactual row —
 *  verification is DELEGATED to the eval-gated right-size flow; watchme never
 *  patches the roster. */
export const WATCHME_VERIFY_ARGV: ReadonlyArray<string> = [
  "crewhaus",
  "model",
  "right-size",
  "--dataset",
  "eval/dataset.jsonl",
  "--graders",
  "eval/graders.yaml",
];

/**
 * Mirror of `@crewhaus/grader-continuity` CONTINUITY_METRIC_SPECS — apps/cli
 * has no dependency edge on that package (the registry reaches it lazily via
 * eval-runner), so the name/threshold/direction table is pinned here. Keep in
 * sync; the direction flag drives every roll-up (lower-is-better metrics
 * breach ABOVE their threshold).
 */
export const WATCHME_CONTINUITY_SPECS: ReadonlyArray<{
  readonly name: string;
  readonly threshold: number;
  readonly higherIsBetter: boolean;
}> = [
  { name: "continuity.reAskRate", threshold: 0, higherIsBetter: false },
  { name: "continuity.reqRetention", threshold: 0.9, higherIsBetter: true },
  { name: "continuity.proofHonesty", threshold: 0.9, higherIsBetter: true },
  { name: "continuity.pickupSuccess", threshold: 0.75, higherIsBetter: true },
  { name: "continuity.costPerProvenOutcome", threshold: 0.25, higherIsBetter: false },
];

const FACTUALITY_GRADERS = [
  "twelve.answerFaithfulness",
  "twelve.answerRelevance",
  "twelve.hallucinationRate",
] as const;

const SESSION_FILE_REGEX = /^(sess_[0-9a-f]{16})\.jsonl$/;

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

// ---------------------------------------------------------------------------
// injected seams
// ---------------------------------------------------------------------------

/** Filesystem seam — the CLI wires node:fs (`nodeReportFs`); tests may fake. */
export type WatchmeReportFs = {
  exists(path: string): boolean;
  /** File text, or undefined when missing/unreadable. */
  readFile(path: string): string | undefined;
  /** Directory entries; [] when the directory is missing. */
  listDir(dir: string): string[];
  statMtimeMs(path: string): number | undefined;
  mkdirp(dir: string): void;
  /** Whole-file write, mode 0600. */
  writeFile(path: string, text: string): void;
  /** O_APPEND write, mode 0600. */
  appendFile(path: string, text: string): void;
};

/** The default node:fs-backed seam. */
export const nodeReportFs: WatchmeReportFs = {
  exists: (path) => existsSync(path),
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  listDir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  statMtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  },
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  },
  writeFile: (path, text) => {
    writeFileSync(path, text, { mode: 0o600 });
  },
  appendFile: (path, text) => {
    appendFileSync(path, text, { mode: 0o600 });
  },
};

/** Structural view of `@crewhaus/grader-registry`'s GraderRegistry. */
export type WatchmeGraderRegistry = {
  has(name: string): boolean;
  lookup(name: string): Grader;
};

/** What the injected judge phase receives for ONE sampled turn. */
export type WatchmeJudgeTurnInput = {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly input: string;
  readonly output: string;
  readonly budgetRemainingUsd: number;
};

export type WatchmeJudgeTurnVerdict = {
  /** Judge score in [0,1] (clamped on append). */
  readonly score: number;
  readonly rationale: string;
  /** Observed spend for this call in USD (cost-tracker over the phase's bus). */
  readonly spentUsd: number;
};

/**
 * The injected phase-2 judge seam — DreamModelPhase-shaped: `model` is the
 * spec model string the driver pricing-gates BEFORE any call; the CLI builds
 * the implementation on `runChatLoop` exactly like `buildDreamModelPhase`
 * (one budgeted judge session; `judgeTurn` is one sampled `createJudgeGrader`
 * call inside it). `sessionId()` exposes the phase's own session id so the
 * driver can scan ITS JSONL for evidence (never trusting model claims).
 */
export type WatchmeJudgePhase = {
  readonly model: string;
  judgeTurn(input: WatchmeJudgeTurnInput): Promise<WatchmeJudgeTurnVerdict>;
  sessionId?(): string | undefined;
};

/** One peer finding recalled from the shared wiki/Thredz (`watchme/*`
 *  articles). Bodies inherit the `memory` TrustOrigin — advisory data only. */
export type SharedWatchmeFinding = {
  readonly agentName: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  /** Wiki confidence signal in [0,1] — peers are rendered weighted by it. */
  readonly confidence: number;
};

export type WatchmeReportDeps = {
  readonly fs: WatchmeReportFs;
  readonly now: () => number;
  readonly store: WatchmeStore;
  /** The ONE turnNumber authority (feedback.ts deriveTurns). */
  readonly deriveTurns: (events: ReadonlyArray<LoggedEvent>) => DerivedTurn[];
  readonly clusterIntents: (
    turns: ReadonlyArray<OrderedTurn>,
    feedback: ReadonlyArray<FeedbackRecord>,
    failedTurnKeys: ReadonlyArray<TurnSignal>,
  ) => IntentDigest;
  readonly orderedTurnsFromSessions: (
    perSession: ReadonlyArray<{ sessionId: string; events: ReadonlyArray<LoggedEvent> }>,
    deriveTurns: (events: ReadonlyArray<LoggedEvent>) => Array<Omit<SessionTurn, "sessionId">>,
  ) => OrderedTurn[];
  readonly redactDigest: (digest: IntentDigest, redact: (s: string) => string) => IntentDigest;
  /** PII/secret redactor applied to EVERY text field before persist/render. */
  readonly redact: (s: string) => string;
  readonly graderRegistry: () => Promise<WatchmeGraderRegistry>;
  readonly openScoreboard: (rootDir: string) => Scoreboard;
  readonly pricing: PricingTable;
  readonly capabilities?: CapabilityTable;
  /** `@crewhaus/watchme-store` joinQualityToArms, injected (§8). */
  readonly joinQualityToArms: (
    decisions: ReadonlyArray<RouteDecision>,
    quality: ReadonlyArray<TurnQuality>,
  ) => ReadonlyArray<QualityArmRow>;
  readonly judgePhase?: WatchmeJudgePhase;
  readonly warn?: (message: string) => void;
};

export type WatchmeReportOptions = {
  /** The harness `.crewhaus` directory (standalone-harness convention). */
  readonly crewhausDir: string;
  readonly specName: string;
  readonly target: string;
  readonly agentId?: string;
  /** Restrict analysis to one session (`--session`); bypasses the watermark. */
  readonly sessionId?: string;
  /** Report directory override (`--out`); default
   *  `<crewhausDir>/watchme/reports/<ts>/`. */
  readonly outDir?: string;
  readonly feedRouting?: boolean;
  readonly emitFeedback?: boolean;
  /** `--no-model` — force a deterministic-only report. */
  readonly noModel?: boolean;
  /** Resolved `watchme.judge` block; absent = deterministic-only. */
  readonly judge?: {
    readonly model: string;
    readonly sampleRate: number;
    readonly budgetUsd: number;
  };
  readonly windowMs?: number;
};

// ---------------------------------------------------------------------------
// unpriced-model refusal (dream-engine §6.2 pattern, cost-tracker primitives)
// ---------------------------------------------------------------------------

/**
 * The clear pre-call pricing check for the phase-2 judge: the refusal message
 * for an unpriced model, or null when the budget cap can bind. Same shape as
 * dream-engine's `unpricedModelReason` (apps/cli carries no dream-engine
 * dependency edge, so the check is restated on cost-tracker primitives).
 */
export function watchmeUnpricedModelReason(model: string, pricing: PricingTable): string | null {
  const parsed = providerOfSpecString(model);
  if (parsed === undefined) {
    return `watchme: judge model "${model}" has an unrecognized provider prefix, so it cannot be priced — the budget cap would be a silent no-op. Use a priced model for watchme.judge, or drop judge.budget_usd to 0.`;
  }
  if (resolvePricing(pricing, parsed.provider, parsed.modelId) === undefined) {
    return `watchme: judge model "${model}" has no pricing entry (provider ${parsed.provider}), so the $-budget cap would be a silent no-op. Use a priced model for watchme.judge, or drop judge.budget_usd to 0.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// turn/session helpers
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

const payloadOf = (ev: LoggedEvent): Payload =>
  typeof ev.payload === "object" && ev.payload !== null ? (ev.payload as Payload) : {};

/** Does this `user_message` payload open a turn? Mirrors feedback.ts's rules
 *  (string content, or an array with a text block and no tool_result block;
 *  `synthetic: true` runtime nudges are NOT turns) so the local turn cursor
 *  stays aligned with the injected `deriveTurns`. */
function isUserTextTurn(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Payload;
  if (p["synthetic"] === true) return false;
  const content = p["content"];
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  const blocks = content as Array<{ type?: string }>;
  if (blocks.some((b) => b.type === "tool_result")) return false;
  return blocks.some((b) => b.type === "text");
}

/** Per-turn struggle signals: `error`/`run_failed` events and error
 *  tool_results, attributed to the turn open at the time. */
function failedTurnSignals(sessionId: string, events: ReadonlyArray<LoggedEvent>): TurnSignal[] {
  let turn = 0;
  const failed = new Set<number>();
  for (const ev of events) {
    if (ev.kind === "user_message") {
      if (isUserTextTurn(ev.payload)) turn += 1;
    } else if (ev.kind === "error" || ev.kind === "run_failed") {
      if (turn > 0) failed.add(turn);
    } else if (ev.kind === "tool_result" && payloadOf(ev)["isError"] === true) {
      if (turn > 0) failed.add(turn);
    }
  }
  return [...failed].sort((a, b) => a - b).map((turnNumber) => ({ sessionId, turnNumber }));
}

function toolStatsOf(
  events: ReadonlyArray<LoggedEvent>,
): Array<{ name: string; calls: number; errors: number }> {
  const tally = new Map<string, { calls: number; errors: number }>();
  const bump = (name: string, isError: boolean): void => {
    const t = tally.get(name) ?? { calls: 0, errors: 0 };
    t.calls += 1;
    if (isError) t.errors += 1;
    tally.set(name, t);
  };
  const mirrored = events.filter((e) => e.kind === "tool_stats");
  if (mirrored.length > 0) {
    for (const ev of mirrored) {
      const p = payloadOf(ev);
      if (typeof p["toolName"] === "string") bump(p["toolName"], p["isError"] === true);
    }
  } else {
    const nameByUseId = new Map<string, string>();
    for (const ev of events) {
      if (ev.kind === "tool_use") {
        const p = payloadOf(ev);
        if (typeof p["id"] === "string" && typeof p["name"] === "string") {
          nameByUseId.set(p["id"], p["name"]);
          bump(p["name"], false);
        }
      } else if (ev.kind === "tool_result" && payloadOf(ev)["isError"] === true) {
        const id = payloadOf(ev)["toolUseId"];
        const name = typeof id === "string" ? nameByUseId.get(id) : undefined;
        if (name !== undefined) {
          const t = tally.get(name);
          if (t !== undefined) t.errors += 1;
        }
      }
    }
  }
  return [...tally.entries()]
    .map(([name, t]) => ({ name, calls: t.calls, errors: t.errors }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Capabilities the window's sessions actually exercised — the candidate
 *  filter for the counterfactual analysis (never over-promise). */
function exercisedCapabilities(events: ReadonlyArray<LoggedEvent>): CapabilityRequirement {
  let toolUse = false;
  let vision = false;
  for (const ev of events) {
    if (ev.kind === "tool_use") toolUse = true;
    else if (ev.kind === "user_message") {
      const content = payloadOf(ev)["content"];
      if (
        Array.isArray(content) &&
        content.some((b) => (b as { type?: string }).type === "image")
      ) {
        vision = true;
      }
    }
  }
  return { ...(toolUse ? { tool_use: true } : {}), ...(vision ? { vision: true } : {}) };
}

// ---------------------------------------------------------------------------
// model attribution (§7 step 2)
// ---------------------------------------------------------------------------

export type ObservationModel = WatchmeObservation["models"][number];

export type ModelAttribution = {
  readonly joinConfidence: "exact" | "ordered";
  readonly models: ReadonlyArray<ObservationModel>;
  /** Per-turn producing model (SPEC string) — EXACT confidence only; ordered
   *  sessions aggregate at session level and never expose a per-turn map. */
  readonly perTurnModel?: ReadonlyMap<number, string>;
  readonly perTurnLatencyMs?: ReadonlyMap<number, number>;
  readonly perTurnCostUsdMicros?: ReadonlyMap<number, number>;
  /** wire model id → spec model string, for route-decision mapping. */
  readonly wireToSpec: ReadonlyMap<string, string>;
};

type ModelFold = {
  wire: string;
  spec?: string;
  provider: string;
  turnNumbers: Set<number>;
  calls: number;
  usage: { in: number; out: number; cacheRead: number; cacheCreate: number };
  costUsdMicros: number;
  costKnown: boolean;
};

function foldFor(
  map: Map<string, ModelFold>,
  wire: string,
  provider: string,
  spec?: string,
): ModelFold {
  const key = `${provider}|${wire}|${spec ?? ""}`;
  let fold = map.get(key);
  if (fold === undefined) {
    fold = {
      wire,
      ...(spec !== undefined ? { spec } : {}),
      provider,
      turnNumbers: new Set<number>(),
      calls: 0,
      usage: { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 },
      costUsdMicros: 0,
      costKnown: false,
    };
    map.set(key, fold);
  }
  return fold;
}

function foldsToModels(folds: Map<string, ModelFold>, pricing: PricingTable): ObservationModel[] {
  return [...folds.values()]
    .map((f): ObservationModel => {
      const parsed = providerOfSpecString(f.spec ?? f.wire);
      const provider = f.provider !== "unknown" ? f.provider : (parsed?.provider ?? "unknown");
      const priced =
        parsed !== undefined
          ? resolvePricing(pricing, parsed.provider, parsed.modelId) !== undefined
          : provider !== "unknown" &&
            resolvePricing(pricing, provider as CandidateProvider, f.wire) !== undefined;
      const turns = f.turnNumbers.size > 0 ? f.turnNumbers.size : f.calls;
      return {
        wire: f.wire,
        ...(f.spec !== undefined ? { spec: f.spec } : {}),
        provider,
        turns,
        usage: { ...f.usage },
        ...(f.costKnown ? { costUsdMicros: f.costUsdMicros } : {}),
        ...(priced ? {} : { unpriced: true }),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.wire.localeCompare(b.wire));
}

/**
 * Per-session model attribution. EXACT when the `.events.jsonl` sibling
 * carries `model_response` lines (envelope turnNumber is the join key);
 * ORDERED otherwise — insertion-order over the durable `cost_accrual` /
 * `model_meta` mirrors, aggregated at session level ONLY (the design's
 * mustSteal constraint: no per-turn claims at ordered confidence).
 */
export function attributeModels(
  events: ReadonlyArray<LoggedEvent>,
  siblingEvents: ReadonlyArray<LoggedEvent>,
  pricing: PricingTable,
): ModelAttribution {
  const wireToSpec = new Map<string, string>();
  const responses: Payload[] = [];
  for (const ev of siblingEvents) {
    const p = ev as unknown as Payload;
    if (
      p["kind"] === "model_response" &&
      typeof p["model"] === "string" &&
      typeof p["turnNumber"] === "number"
    ) {
      responses.push(p);
    }
  }

  if (responses.length > 0) {
    const folds = new Map<string, ModelFold>();
    const perTurnModel = new Map<number, string>();
    const perTurnLatencyMs = new Map<number, number>();
    const perTurnCostUsdMicros = new Map<number, number>();
    for (const r of responses) {
      const wire = r["model"] as string;
      const spec = typeof r["specModel"] === "string" ? (r["specModel"] as string) : undefined;
      const provider =
        typeof r["provider"] === "string"
          ? (r["provider"] as string)
          : (providerOfSpecString(spec ?? wire)?.provider ?? "unknown");
      const turnNumber = r["turnNumber"] as number;
      const usage =
        typeof r["usage"] === "object" && r["usage"] !== null ? (r["usage"] as Payload) : {};
      const fold = foldFor(folds, wire, provider, spec);
      fold.calls += 1;
      fold.turnNumbers.add(turnNumber);
      const inTok = typeof usage["input"] === "number" ? (usage["input"] as number) : 0;
      const outTok = typeof usage["output"] === "number" ? (usage["output"] as number) : 0;
      const cacheRead = typeof usage["cacheRead"] === "number" ? (usage["cacheRead"] as number) : 0;
      const cacheCreate =
        typeof usage["cacheCreate"] === "number" ? (usage["cacheCreate"] as number) : 0;
      fold.usage.in += inTok;
      fold.usage.out += outTok;
      fold.usage.cacheRead += cacheRead;
      fold.usage.cacheCreate += cacheCreate;
      const specString = spec ?? wire;
      wireToSpec.set(wire, specString);
      perTurnModel.set(turnNumber, specString);
      const duration = typeof r["durationMs"] === "number" ? (r["durationMs"] as number) : 0;
      perTurnLatencyMs.set(turnNumber, (perTurnLatencyMs.get(turnNumber) ?? 0) + duration);
      const parsed = providerOfSpecString(specString);
      const row =
        parsed !== undefined ? resolvePricing(pricing, parsed.provider, parsed.modelId) : undefined;
      if (row !== undefined) {
        const micros = computeCostMicros(row, inTok, outTok, cacheRead, cacheCreate);
        fold.costUsdMicros += micros;
        fold.costKnown = true;
        perTurnCostUsdMicros.set(turnNumber, (perTurnCostUsdMicros.get(turnNumber) ?? 0) + micros);
      }
    }
    return {
      joinConfidence: "exact",
      models: foldsToModels(folds, pricing),
      perTurnModel,
      perTurnLatencyMs,
      perTurnCostUsdMicros,
      wireToSpec,
    };
  }

  const folds = new Map<string, ModelFold>();
  const accruals = events.filter((e) => e.kind === "cost_accrual");
  if (accruals.length > 0) {
    for (const ev of accruals) {
      const p = payloadOf(ev);
      if (typeof p["modelId"] !== "string" || typeof p["provider"] !== "string") continue;
      const wire = p["modelId"];
      const spec = typeof p["specModel"] === "string" ? p["specModel"] : undefined;
      const fold = foldFor(folds, wire, p["provider"], spec);
      fold.calls += 1;
      fold.usage.in += typeof p["inputTokens"] === "number" ? p["inputTokens"] : 0;
      fold.usage.out += typeof p["outputTokens"] === "number" ? p["outputTokens"] : 0;
      fold.usage.cacheRead += typeof p["cachedReadTokens"] === "number" ? p["cachedReadTokens"] : 0;
      fold.usage.cacheCreate +=
        typeof p["cacheCreationTokens"] === "number" ? p["cacheCreationTokens"] : 0;
      if (typeof p["costUsdMicros"] === "number") {
        fold.costUsdMicros += p["costUsdMicros"];
        fold.costKnown = true;
      }
      wireToSpec.set(wire, spec ?? wire);
    }
  } else {
    for (const ev of events) {
      if (ev.kind !== "model_meta") continue;
      const p = payloadOf(ev);
      if (typeof p["model"] !== "string") continue;
      const wire = p["model"];
      const fold = foldFor(folds, wire, providerOfSpecString(wire)?.provider ?? "unknown");
      fold.calls += 1;
      wireToSpec.set(wire, wire);
    }
  }
  return { joinConfidence: "ordered", models: foldsToModels(folds, pricing), wireToSpec };
}

// ---------------------------------------------------------------------------
// continuity + factuality roll-ups (§7 steps 3–4)
// ---------------------------------------------------------------------------

export type ContinuityRollupRow = {
  readonly name: string;
  readonly count: number;
  readonly mean: number;
  readonly threshold: number;
  readonly higherIsBetter: boolean;
  /** Direction-respecting: lower-is-better metrics breach ABOVE threshold. */
  readonly breach: boolean;
};

/** Fold per-session continuity maps into the report roll-up, direction
 *  respected (the summarizeContinuityMetrics semantics). */
export function rollupContinuity(
  observations: ReadonlyArray<WatchmeObservation>,
): ContinuityRollupRow[] {
  return WATCHME_CONTINUITY_SPECS.map((spec) => {
    const scores: number[] = [];
    for (const obs of observations) {
      const entry = obs.continuity?.[spec.name];
      if (entry !== undefined) scores.push(entry.score);
    }
    const count = scores.length;
    const mean = count === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / count;
    const breach =
      count > 0 && (spec.higherIsBetter ? mean < spec.threshold : mean > spec.threshold);
    return {
      name: spec.name,
      count,
      mean,
      threshold: spec.threshold,
      higherIsBetter: spec.higherIsBetter,
      breach,
    };
  });
}

/** Grounded/claim counts parsed from the pinned faithfulness rationale
 *  grammar ("N/M claim(s) grounded…" / "vacuous"); grader-12-metric-rubric is
 *  not an apps/cli dependency, so the counts ride the rationale contract its
 *  own tests pin. */
function parseFaithfulnessCounts(result: GradeResult): {
  claims: number;
  grounded: number;
  vacuous: boolean;
} {
  const m = result.rationale.match(/^(\d+)\/(\d+) claim\(s\) grounded/);
  if (m !== null) {
    return { grounded: Number(m[1]), claims: Number(m[2]), vacuous: false };
  }
  return { grounded: 0, claims: 0, vacuous: result.rationale.includes("vacuous") };
}

/** Ungrounded claim excerpts from the pinned rationale grammar (JSON-quoted,
 *  `; `-joined) — redacted by the caller before render. */
function parseUngroundedExamples(rationale: string): string[] {
  const idx = rationale.indexOf("— ungrounded: ");
  if (idx < 0) return [];
  const tail = rationale.slice(idx + "— ungrounded: ".length);
  const out: string[] = [];
  for (const piece of tail.split("; ")) {
    try {
      const parsed = JSON.parse(piece) as unknown;
      if (typeof parsed === "string") out.push(parsed);
    } catch {
      // Not a JSON-quoted claim — stop at the first non-conforming piece.
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// counterfactual analysis (§7 step 5)
// ---------------------------------------------------------------------------

export type CounterfactualEvidence = {
  readonly tier: "arms" | "watchme" | "unverified";
  readonly n?: number;
  readonly mean?: number;
};

export type CounterfactualRow = {
  /** SPEC string of the model actually observed. */
  readonly currentModel: string;
  /** SPEC string of the cheaper candidate. */
  readonly candidate: string;
  readonly provider: CandidateProvider;
  /** Replaying the observed token traffic on the candidate's pricing row. */
  readonly projectedCostUsdMicros: number;
  /** Observed-traffic saving vs the current model. UNDEFINED when the current
   *  model is unpriced — unknown is never rendered as free. */
  readonly deltaUsdMicros?: number;
  /** Representative per-turn cost INCLUDING the cache-re-warm penalty. */
  readonly effectiveTurnCostMicros: number;
  readonly cacheRewarmPenaltyMicros: number;
  readonly sameProvider: boolean;
  readonly evidence: CounterfactualEvidence;
  readonly verify: { readonly argv: ReadonlyArray<string> };
};

/**
 * Pure cheaper-model replay over the observed per-model traffic. Candidates
 * come from the pricing table filtered to the capabilities the sessions
 * actually exercised (+ `excludeSunsets`); projected cost replays the SAME
 * token counts through `computeCostMicros`; `rankCandidates` +
 * `cacheProfileFromTotals` price the cache-re-warm honesty in. Quality-hold
 * evidence tiers: scoreboard arms > watchme's own judged/rated turns >
 * unverified — always with the machine-consumable `verify.argv` handoff.
 */
export function buildCounterfactuals(input: {
  readonly models: ReadonlyArray<ObservationModel>;
  readonly require: CapabilityRequirement;
  readonly pricing: PricingTable;
  readonly capabilities?: CapabilityTable;
  readonly arms: ReadonlyArray<ArmStats>;
  /** Turn-quality scores attributed to a SPEC model string (judgments +
   *  ratings joined per (sessionId, turnNumber, model)). */
  readonly turnQuality: ReadonlyArray<{ readonly model: string; readonly score: number }>;
  readonly maxCandidatesPerModel?: number;
}): CounterfactualRow[] {
  const maxPer = input.maxCandidatesPerModel ?? 3;
  const rows: CounterfactualRow[] = [];
  for (const model of input.models) {
    const specString = model.spec ?? model.wire;
    const current = providerOfSpecString(specString);
    if (current === undefined) continue; // not table-backed — nothing to replay
    const candidates = enumerateCandidates(current, {
      pricing: input.pricing,
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      ...(Object.keys(input.require).length > 0 ? { require: input.require } : {}),
      excludeCurrent: true,
      excludeSunsets: true,
    }).slice(0, maxPer);
    if (candidates.length === 0) continue;
    const profile = cacheProfileFromTotals({
      currentProvider: current.provider,
      inputTokens: model.usage.in,
      cacheReadTokens: model.usage.cacheRead,
      outputTokens: model.usage.out,
      modelCalls: Math.max(1, model.turns),
    });
    const ranked = rankCandidates(
      candidates.map((c) => ({
        modelString: c.modelString,
        provider: c.provider,
        modelId: c.familyPrefix,
      })),
      profile,
      { pricing: input.pricing },
    );
    const rankedByModel = new Map(ranked.map((r) => [r.candidate.modelString, r]));
    const currentPriced = model.unpriced !== true && model.costUsdMicros !== undefined;
    for (const candidate of candidates) {
      const projected = computeCostMicros(
        candidate.pricing,
        model.usage.in,
        model.usage.out,
        model.usage.cacheRead,
        model.usage.cacheCreate,
      );
      const rank = rankedByModel.get(candidate.modelString);
      const armMatches = input.arms.filter(
        (a) => a.model === candidate.modelString || a.model === candidate.familyPrefix,
      );
      const armN = armMatches.reduce((acc, a) => acc + a.n, 0);
      const qualityMatches = input.turnQuality.filter((q) => q.model === candidate.modelString);
      let evidence: CounterfactualEvidence;
      if (armN > 0) {
        evidence = {
          tier: "arms",
          n: armN,
          mean: armMatches.reduce((acc, a) => acc + a.n * a.meanReward, 0) / armN,
        };
      } else if (qualityMatches.length > 0) {
        evidence = {
          tier: "watchme",
          n: qualityMatches.length,
          mean: qualityMatches.reduce((acc, q) => acc + q.score, 0) / qualityMatches.length,
        };
      } else {
        evidence = { tier: "unverified" };
      }
      rows.push({
        currentModel: specString,
        candidate: candidate.modelString,
        provider: candidate.provider,
        projectedCostUsdMicros: projected,
        ...(currentPriced ? { deltaUsdMicros: (model.costUsdMicros as number) - projected } : {}),
        effectiveTurnCostMicros: rank?.effectiveCostMicros ?? 0,
        cacheRewarmPenaltyMicros: rank?.cacheLossPenaltyMicros ?? 0,
        sameProvider: candidate.provider === current.provider,
        evidence,
        verify: { argv: [...WATCHME_VERIFY_ARGV] },
      });
    }
  }
  return rows.sort(
    (a, b) =>
      (b.deltaUsdMicros ?? Number.NEGATIVE_INFINITY) -
      (a.deltaUsdMicros ?? Number.NEGATIVE_INFINITY),
  );
}

// ---------------------------------------------------------------------------
// §9 — the explicit machine→human feedback bridge
// ---------------------------------------------------------------------------

/**
 * Convert phase-2 judgments to BARE FeedbackRecords with source `"watchme"` —
 * written ONLY under the explicit `--emit-feedback` opt-in (human-signal
 * purity; distill/fewshot/optimize see nothing by default). Deterministic ids
 * (`watchme_<session>_t<turn>`) keep re-emission idempotent under
 * `mergeFeedback`. Rationales are redacted before they enter the record.
 */
export function judgmentsToFeedback(
  judgments: ReadonlyArray<WatchmeJudgment>,
  redact: (s: string) => string,
): FeedbackRecord[] {
  const byId = new Map<string, FeedbackRecord>();
  for (const j of [...judgments].sort((a, b) => a.ts - b.ts)) {
    const id = `watchme_${j.sessionId}_t${j.turnNumber}`;
    byId.set(
      id,
      buildFeedbackRecord({
        id,
        sessionId: j.sessionId,
        turnNumber: j.turnNumber,
        ts: new Date(j.ts).toISOString(),
        source: "watchme",
        score: clamp01(j.score),
        comment: redact(j.rationale),
        rater: `watchme:${j.judgeModel}`,
      }),
    );
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// report shapes
// ---------------------------------------------------------------------------

export type WatchmeReportJson = {
  readonly v: 1;
  readonly generatedAt: string;
  readonly specName: string;
  readonly target: string;
  readonly scope: "harness";
  readonly window: {
    readonly sessionsAnalyzed: number;
    readonly sessionIds: ReadonlyArray<string>;
    readonly exactSessions: number;
    readonly orderedSessions: number;
  };
  readonly totals: { readonly observations: number; readonly aggregatedSessions: number };
  readonly quality: {
    readonly ratings: number;
    readonly meanRating?: number;
    readonly judged: number;
    readonly meanJudge?: number;
    readonly feedback: { readonly up: number; readonly down: number };
  };
  readonly continuity: ReadonlyArray<ContinuityRollupRow>;
  readonly factuality: {
    readonly sessions: number;
    readonly claims: number;
    readonly grounded: number;
    readonly meanFaithfulness?: number;
    readonly meanRelevance?: number;
    readonly meanHallucinationRate?: number;
    readonly vacuousSessions: number;
    readonly exampleUngrounded: ReadonlyArray<string>;
  };
  readonly models: ReadonlyArray<ObservationModel>;
  readonly counterfactuals: ReadonlyArray<CounterfactualRow>;
  readonly intents: IntentDigest;
  readonly findings: ReadonlyArray<AdviceFinding>;
  readonly judge?: {
    readonly model: string;
    readonly windowKey: string;
    readonly outcome: "ok" | "refused" | "failed" | "window-consumed" | "skipped";
    readonly reason?: string;
    readonly sampled: number;
    readonly judged: number;
    readonly spentUsd: number;
    readonly evidence?: {
      readonly sessionId: string;
      readonly modelCalls: number;
      readonly costUsdMicros: number;
    };
  };
  readonly feedRouting?: { readonly recorded: number; readonly deduped: number };
  readonly emitFeedback?: { readonly written: number; readonly path: string };
  readonly warnings: ReadonlyArray<string>;
};

export type WatchmeReportResult = {
  readonly outcome: "written" | "locked" | "no-sessions";
  readonly outDir?: string;
  readonly files: ReadonlyArray<string>;
  readonly report?: WatchmeReportJson;
};

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
const pct = (x: number | undefined): string =>
  x === undefined ? "n/a" : `${Math.round(x * 100)}%`;

/** report.md — the five sections, in REPORT_SECTION_TITLES order. */
export function renderWatchmeReportMd(report: WatchmeReportJson): string {
  const lines: string[] = [];
  lines.push(`# watchme report — ${report.specName} (${report.target})`);
  lines.push("");
  lines.push(
    `Generated ${report.generatedAt} · ${report.window.sessionsAnalyzed} session(s) analyzed this window (${report.window.exactSessions} exact / ${report.window.orderedSessions} ordered attribution) · ${report.totals.observations} raw + ${report.totals.aggregatedSessions} aggregated observation(s) on record.`,
  );
  lines.push("");
  lines.push("All conclusions are advisory — never auto-applied.");

  lines.push("");
  lines.push(`## ${REPORT_SECTION_TITLES[0]}`);
  const q = report.quality;
  lines.push(
    `- Human ratings: ${q.ratings} (mean ${pct(q.meanRating)}) · thumbs ${q.feedback.up}↑ / ${q.feedback.down}↓`,
  );
  lines.push(`- Judged turns (machine, phase 2): ${q.judged} (mean ${pct(q.meanJudge)})`);
  if (report.judge !== undefined) {
    const j = report.judge;
    lines.push(
      `- Judge: ${j.model} — ${j.outcome}${j.reason !== undefined ? ` (${j.reason})` : ""}; sampled ${j.sampled}, judged ${j.judged}, spent $${j.spentUsd.toFixed(4)}`,
    );
    if (j.evidence !== undefined) {
      lines.push(
        `- Judge evidence (from its own session ${j.evidence.sessionId}): ${j.evidence.modelCalls} model call(s), ${usd(j.evidence.costUsdMicros)}`,
      );
    }
  }

  lines.push("");
  lines.push(`## ${REPORT_SECTION_TITLES[1]}`);
  for (const m of report.continuity) {
    const bound = m.higherIsBetter ? `≥${m.threshold}` : `≤${m.threshold}`;
    lines.push(
      `- ${m.name}: mean ${m.mean.toFixed(3)} over ${m.count} session(s) · ${bound}${m.breach ? " **BREACH**" : ""}`,
    );
  }

  lines.push("");
  lines.push(`## ${REPORT_SECTION_TITLES[2]}`);
  const f = report.factuality;
  lines.push(
    `- ${f.grounded}/${f.claims} claim(s) grounded across ${f.sessions} session(s) · faithfulness ${pct(f.meanFaithfulness)} · relevance ${pct(f.meanRelevance)} · hallucination rate ${pct(f.meanHallucinationRate)} · ${f.vacuousSessions} vacuous pass(es)`,
  );
  if (f.exampleUngrounded.length > 0) {
    lines.push("- Example ungrounded claims (redacted):");
    for (const claim of f.exampleUngrounded) lines.push(`  - ${claim}`);
  }

  lines.push("");
  lines.push(`## ${REPORT_SECTION_TITLES[3]}`);
  for (const m of report.models) {
    const cost = m.unpriced === true ? "UNKNOWN (unpriced)" : usd(m.costUsdMicros ?? 0);
    lines.push(
      `- ${m.spec ?? m.wire} (${m.provider}): ${m.turns} turn(s), ${m.usage.in} in / ${m.usage.out} out / ${m.usage.cacheRead} cache-read tokens, cost ${cost}`,
    );
  }
  if (report.counterfactuals.length > 0) {
    lines.push("");
    lines.push(
      "| current | candidate | projected | delta | per-turn (incl. cache re-warm) | evidence | verify |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of report.counterfactuals) {
      const delta = row.deltaUsdMicros === undefined ? "UNKNOWN" : usd(row.deltaUsdMicros);
      const evidence =
        row.evidence.tier === "unverified"
          ? "unverified"
          : `${row.evidence.tier} (n=${row.evidence.n}, mean ${row.evidence.mean?.toFixed(2)})`;
      lines.push(
        `| ${row.currentModel} | ${row.candidate} | ${usd(row.projectedCostUsdMicros)} | ${delta} | ${usd(row.effectiveTurnCostMicros)} (+${usd(row.cacheRewarmPenaltyMicros)}) | ${evidence} | \`${row.verify.argv.join(" ")}\` |`,
      );
    }
    lines.push("");
    lines.push(
      "Counterfactuals are pricing-table replays of observed traffic — verify with the attached `crewhaus model right-size` argv before acting.",
    );
  }
  if (report.feedRouting !== undefined) {
    lines.push("");
    lines.push(
      `Shadow routing arms: ${report.feedRouting.recorded} \`q:*\` observation(s) recorded (${report.feedRouting.deduped} deduped). \`q:\`-prefixed routeKeys are watchme's SHADOW namespace — visible in \`route status\`, never minted or read by the runtime router.`,
    );
  }

  lines.push("");
  lines.push(`## ${REPORT_SECTION_TITLES[4]}`);
  const digest = report.intents;
  lines.push(
    `${digest.totalTurns} user turn(s) across ${digest.totalSessions} session(s), ${digest.intents.length} intent cluster(s).`,
  );
  const section = (
    title: string,
    list: IntentDigest["topIntents"],
    detail: (i: IntentDigest["topIntents"][number]) => string,
  ): void => {
    lines.push("");
    lines.push(`### ${title}`);
    if (list.length === 0) {
      lines.push("- (none)");
      return;
    }
    for (const i of list) lines.push(`- ${i.representative} — ${detail(i)}`);
  };
  section("Top", digest.topIntents, (i) => `${i.occurrences}× in ${i.sessionCount} session(s)`);
  section("Rising", digest.risingIntents, (i) => `${i.earlyCount} → ${i.recentCount}`);
  section(
    "Low satisfaction",
    digest.lowSatisfactionIntents,
    (i) => `rating ${pct(i.meanRating)} over ${i.occurrences} turn(s)`,
  );
  section(
    "Unmet",
    digest.unmetIntents,
    (i) => `${Math.round(i.failureRate * 100)}% failed (${i.failedTurns}/${i.occurrences})`,
  );

  return `${lines.join("\n")}\n`;
}

/** Advice findings for suggestions.json (text-only by design — every
 *  `watchme.*` path is excluded from OPTIMIZABLE_PATHS). */
function buildFindings(report: {
  intents: IntentDigest;
  counterfactuals: ReadonlyArray<CounterfactualRow>;
}): AdviceFinding[] {
  const findings: AdviceFinding[] = [];
  for (const intent of report.intents.lowSatisfactionIntents) {
    findings.push({
      id: "watchme-report-low-satisfaction",
      severity: "warn",
      summary: `low-satisfaction intent: ${intent.representative}`,
      evidence: [
        `mean rating ${pct(intent.meanRating)} over ${intent.occurrences} turn(s) in ${intent.sessionCount} session(s)`,
      ],
      counts: { occurrences: intent.occurrences },
      suggestion: {
        kind: "advice",
        text: `Users keep asking "${intent.representative}" and rate the answers poorly. Consider a few-shot example (fewshot-candidates.json), an instructions tweak via \`crewhaus optimize\`, or a dedicated tool for this intent.`,
      },
    });
  }
  for (const intent of report.intents.unmetIntents) {
    findings.push({
      id: "watchme-report-unmet-intent",
      severity: "warn",
      summary: `unmet intent: ${intent.representative}`,
      evidence: [
        `${Math.round(intent.failureRate * 100)}% of ${intent.occurrences} turn(s) hit errors/loops/retries`,
      ],
      counts: { failedTurns: intent.failedTurns },
      suggestion: {
        kind: "advice",
        text: `The agent struggles with "${intent.representative}" (errors/loops/retries). Check tool coverage and permissions for this flow.`,
      },
    });
  }
  const best = report.counterfactuals.find((c) => (c.deltaUsdMicros ?? 0) > 0);
  if (best !== undefined) {
    findings.push({
      id: "watchme-report-model-downshift",
      severity: "info",
      summary: `${best.candidate} could serve observed traffic for ${usd(best.projectedCostUsdMicros)} (saving ${usd(best.deltaUsdMicros ?? 0)})`,
      evidence: [`evidence tier: ${best.evidence.tier}`, `verify: ${best.verify.argv.join(" ")}`],
      counts: { savingUsdMicros: best.deltaUsdMicros ?? 0 },
      suggestion: {
        kind: "advice",
        text: `A cheaper model may hold quality on this harness's observed traffic. Verify with \`${best.verify.argv.join(" ")}\` — the roster is never patched automatically.`,
      },
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// per-session analysis
// ---------------------------------------------------------------------------

type SessionAnalysis = {
  readonly sessionId: string;
  readonly events: ReadonlyArray<LoggedEvent>;
  readonly turns: ReadonlyArray<SessionTurn>;
  readonly attribution: ModelAttribution;
  readonly observation: WatchmeObservation;
  readonly factualityExamples: ReadonlyArray<string>;
  /** twelve.answerRelevance score (report-only; not in the observation schema). */
  readonly relevance?: number;
  readonly mtimeMs: number;
};

async function analyzeSession(input: {
  sessionId: string;
  events: ReadonlyArray<LoggedEvent>;
  siblingEvents: ReadonlyArray<LoggedEvent>;
  mtimeMs: number;
  feedback: ReadonlyArray<FeedbackRecord>;
  registry: WatchmeGraderRegistry;
  deps: WatchmeReportDeps;
  opts: WatchmeReportOptions;
}): Promise<SessionAnalysis> {
  const { sessionId, events, deps, opts } = input;
  const derived = deps.deriveTurns(events);
  const turns: SessionTurn[] = derived.map((t) => ({ ...t, sessionId }));
  const attribution = attributeModels(events, input.siblingEvents, deps.pricing);

  const lastTurn = turns[turns.length - 1];
  const toolCalls: ToolCall[] = [];
  const nameByUseId = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind === "tool_use") {
      const p = payloadOf(ev);
      if (typeof p["id"] === "string" && typeof p["name"] === "string") {
        nameByUseId.set(p["id"], p["name"]);
      }
    } else if (ev.kind === "tool_result") {
      const p = payloadOf(ev);
      const id = typeof p["toolUseId"] === "string" ? p["toolUseId"] : "";
      toolCalls.push({
        toolName: nameByUseId.get(id) ?? "unknown",
        toolUseId: id,
        isError: p["isError"] === true,
      });
    }
  }
  const run: RunResult = {
    agentOutput: lastTurn?.output ?? "",
    events: [],
    transcript: events as RunResult["transcript"],
    toolCalls,
    turns: turns.length,
    latencyMs: 0,
    artifacts: {
      // A per-session pseudo sample dir (never created): loadSessions then
      // degrades to `transcript` as the single session while `stateRootDir`
      // still exposes the harness's real continuity state (lock-free reads
      // are safe per grader-continuity).
      sampleDir: join(opts.crewhausDir, "sessions", sessionId),
      sessionId,
      transcriptPath: join(opts.crewhausDir, "sessions", `${sessionId}.jsonl`),
      stateRootDir: opts.crewhausDir,
      specName: opts.specName,
    },
  };
  const sample: Sample = { id: sessionId, input: turns[0]?.input ?? "" };

  const continuity: Record<string, { score: number; passed: boolean; higherIsBetter: boolean }> =
    {};
  for (const spec of WATCHME_CONTINUITY_SPECS) {
    if (!input.registry.has(spec.name)) continue;
    try {
      const result = await input.registry.lookup(spec.name)(sample, run);
      continuity[spec.name] = {
        score: result.score,
        passed: result.passed,
        higherIsBetter: spec.higherIsBetter,
      };
    } catch (err) {
      deps.warn?.(`watchme: ${spec.name} failed on ${sessionId}: ${(err as Error).message}`);
    }
  }

  let factuality: WatchmeObservation["factuality"];
  let relevance: number | undefined;
  const factualityExamples: string[] = [];
  try {
    const faithfulness = input.registry.has(FACTUALITY_GRADERS[0])
      ? await input.registry.lookup(FACTUALITY_GRADERS[0])(sample, run)
      : undefined;
    const relevanceResult = input.registry.has(FACTUALITY_GRADERS[1])
      ? await input.registry.lookup(FACTUALITY_GRADERS[1])(sample, run)
      : undefined;
    relevance = relevanceResult?.score;
    const hallucination = input.registry.has(FACTUALITY_GRADERS[2])
      ? await input.registry.lookup(FACTUALITY_GRADERS[2])(sample, run)
      : undefined;
    if (faithfulness !== undefined) {
      const counts = parseFaithfulnessCounts(faithfulness);
      factuality = {
        claims: counts.claims,
        grounded: counts.grounded,
        faithfulness: faithfulness.score,
        ...(hallucination !== undefined ? { hallucinationRate: hallucination.score } : {}),
        ...(counts.claims === 0 ? { vacuous: true } : {}),
      };
      factualityExamples.push(...parseUngroundedExamples(faithfulness.rationale));
    }
  } catch (err) {
    deps.warn?.(`watchme: factuality graders failed on ${sessionId}: ${(err as Error).message}`);
  }

  const merged = mergeFeedback(input.feedback.filter((f) => f.sessionId === sessionId));
  let up = 0;
  let down = 0;
  const ratingScores: number[] = [];
  for (const fb of merged) {
    if (fb.rating.thumbs === "up") up += 1;
    else if (fb.rating.thumbs === "down") down += 1;
    const score = normalizeRating(fb);
    if (score !== undefined) ratingScores.push(score);
  }

  const observation: WatchmeObservation = {
    v: 1,
    sessionId,
    specName: opts.specName,
    target: opts.target,
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ts: deps.now(),
    turnCount: turns.length,
    joinConfidence: attribution.joinConfidence,
    models: attribution.models,
    toolStats: toolStatsOf(events),
    ...(Object.keys(continuity).length > 0 ? { continuity } : {}),
    ...(factuality !== undefined ? { factuality } : {}),
    quality: {
      ratings: ratingScores.length,
      ...(ratingScores.length > 0
        ? { meanRating: ratingScores.reduce((a, b) => a + b, 0) / ratingScores.length }
        : {}),
      judged: 0,
    },
    intentKeys: [], // filled after window-level clustering
    ...(up + down > 0 ? { feedback: { up, down } } : {}),
  };

  return {
    sessionId,
    events,
    turns,
    attribution,
    observation,
    factualityExamples,
    ...(relevance !== undefined ? { relevance } : {}),
    mtimeMs: input.mtimeMs,
  };
}

/** Token-overlap assignment of window intent clusters back to sessions —
 *  observation.intentKeys carries redacted cluster keys only. */
function intentKeysBySession(
  digest: IntentDigest,
  turnsBySession: ReadonlyMap<string, ReadonlyArray<SessionTurn>>,
  redact: (s: string) => string,
): Map<string, string[]> {
  const tokensOf = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length >= 3) out.add(raw);
    }
    return out;
  };
  const clusters = digest.intents.map((i) => ({
    key: redact(i.representative),
    tokens: tokensOf(i.representative),
  }));
  const out = new Map<string, string[]>();
  for (const [sessionId, turns] of turnsBySession) {
    const keys: string[] = [];
    for (const cluster of clusters) {
      if (cluster.tokens.size === 0) continue;
      const matched = turns.some((t) => {
        const turnTokens = tokensOf(t.input);
        let hit = 0;
        for (const tok of cluster.tokens) if (turnTokens.has(tok)) hit += 1;
        const union = cluster.tokens.size + turnTokens.size - hit;
        return union > 0 && hit / union >= 0.5;
      });
      if (matched && !keys.includes(cluster.key)) keys.push(cluster.key);
    }
    out.set(sessionId, keys);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the report driver
// ---------------------------------------------------------------------------

function readFeedbackRecords(
  fs: WatchmeReportFs,
  crewhausDir: string,
  sessionEvents: ReadonlyMap<string, ReadonlyArray<LoggedEvent>>,
): FeedbackRecord[] {
  const objects: unknown[] = [];
  for (const events of sessionEvents.values()) objects.push(...events);
  const feedbackDir = join(crewhausDir, "feedback");
  for (const file of fs.listDir(feedbackDir).sort()) {
    if (!file.endsWith(".jsonl")) continue;
    const text = fs.readFile(join(feedbackDir, file));
    if (text === undefined) continue;
    objects.push(...parseSessionLog(text));
  }
  return extractFeedbackRecords(objects);
}

function isoDirStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}

/**
 * `crewhaus watchme report` — phase 1 (+ phase 2 when budgeted) for ONE
 * harness. Runs under the store's advisory lock with dream-style window
 * idempotency on the judge pass; writes `report.json` / `report.md` /
 * `suggestions.json` / `fewshot-candidates.json` under the report directory
 * and returns the assembled report.
 */
export async function runWatchmeReport(
  opts: WatchmeReportOptions,
  deps: WatchmeReportDeps,
): Promise<WatchmeReportResult> {
  const release = deps.store.acquireLock();
  if (release === undefined) return { outcome: "locked", files: [] };
  try {
    return await runLocked(opts, deps);
  } finally {
    release();
  }
}

async function runLocked(
  opts: WatchmeReportOptions,
  deps: WatchmeReportDeps,
): Promise<WatchmeReportResult> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    deps.warn?.(message);
  };
  const nowMs = deps.now();
  const sessionsDir = join(opts.crewhausDir, "sessions");
  const state = deps.store.state();
  const priorRaw = deps.store.readObservations();
  const aggregates = deps.store.readAggregates();
  // The durable per-session cursor (survives compaction) is the authority for
  // the skip/growth decision; the scalar watermark is only a fast pre-filter
  // for sessions the cursor has never tracked.
  const observedCursor = state.observed ?? {};

  // -- step 1: enumerate sessions past the durable cursor --
  const candidates: Array<{ sessionId: string; path: string; mtimeMs: number }> = [];
  const dirEntries = deps.fs.listDir(sessionsDir);
  for (const file of [...dirEntries].sort()) {
    const match = file.match(SESSION_FILE_REGEX);
    if (match === null) continue;
    const sessionId = match[1] as string;
    if (opts.sessionId !== undefined && sessionId !== opts.sessionId) continue;
    const path = join(sessionsDir, file);
    const mtimeMs = deps.fs.statMtimeMs(path) ?? 0;
    if (opts.sessionId === undefined) {
      const cursor = observedCursor[sessionId];
      if (cursor !== undefined) {
        // Seen before: skip only while UNCHANGED. A grown session (its file
        // rewritten/appended, so mtime advanced past the digested mtime) is
        // re-analyzed — the last-writer-wins observation log makes the
        // re-digest idempotent (n still counts distinct sessions).
        if (mtimeMs <= cursor.mtimeMs) continue;
      } else if (mtimeMs <= state.watermark.lastMtimeMs) {
        // Never cursor-tracked (a pre-cursor digest, or an entry the cursor
        // cap evicted): the scalar watermark stands in as a cheap pre-filter.
        // This is only consulted when the cursor has no entry, so a grown,
        // cursor-tracked session is never permanently excluded by it.
        continue;
      }
    }
    candidates.push({ sessionId, path, mtimeMs });
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.sessionId.localeCompare(b.sessionId));

  const anySessionFiles = dirEntries.some((f) => SESSION_FILE_REGEX.test(f));
  if (!anySessionFiles && priorRaw.length === 0 && aggregates.length === 0) {
    return { outcome: "no-sessions", files: [] };
  }

  // -- parse events + siblings --
  const sessionEvents = new Map<string, ReadonlyArray<LoggedEvent>>();
  const siblingEvents = new Map<string, ReadonlyArray<LoggedEvent>>();
  for (const c of candidates) {
    const text = deps.fs.readFile(c.path);
    if (text === undefined) continue;
    sessionEvents.set(c.sessionId, parseSessionLog(text));
    const siblingText = deps.fs.readFile(join(sessionsDir, `${c.sessionId}.events.jsonl`));
    siblingEvents.set(c.sessionId, siblingText === undefined ? [] : parseSessionLog(siblingText));
  }

  const feedback = readFeedbackRecords(deps.fs, opts.crewhausDir, sessionEvents);
  const registry = await deps.graderRegistry();

  // -- steps 2–4, 7: per-session analysis --
  const analyses: SessionAnalysis[] = [];
  for (const c of candidates) {
    const events = sessionEvents.get(c.sessionId);
    if (events === undefined || events.length === 0) continue;
    analyses.push(
      await analyzeSession({
        sessionId: c.sessionId,
        events,
        siblingEvents: siblingEvents.get(c.sessionId) ?? [],
        mtimeMs: c.mtimeMs,
        feedback,
        registry,
        deps,
        opts,
      }),
    );
  }

  // -- step 6: intents over the window's sessions --
  const perSession = analyses.map((a) => ({ sessionId: a.sessionId, events: a.events }));
  const orderedTurns = deps.orderedTurnsFromSessions(perSession, deps.deriveTurns);
  const failedKeys = analyses.flatMap((a) => failedTurnSignals(a.sessionId, a.events));
  const rawDigest = deps.clusterIntents(orderedTurns, feedback, failedKeys);
  const digest = deps.redactDigest(rawDigest, deps.redact);
  const turnsBySession = new Map(analyses.map((a) => [a.sessionId, a.turns]));
  const keysBySession = intentKeysBySession(digest, turnsBySession, deps.redact);

  // -- step 8: append redacted observations (last-writer-wins) --
  // The durable cursor + scalar watermark are committed AFTER phase 2, so a
  // transient judge failure can leave this window's sessions eligible for
  // re-analysis + re-judging (the observation append is idempotent under the
  // store's last-writer-wins dedup).
  const newObservations: WatchmeObservation[] = [];
  for (const a of analyses) {
    const observation: WatchmeObservation = {
      ...a.observation,
      intentKeys: keysBySession.get(a.sessionId) ?? [],
    };
    newObservations.push(observation);
    deps.store.appendObservation(observation);
  }

  // -- phase 2: the ONE budgeted judge pass --
  const windowMs = opts.windowMs ?? WATCHME_JUDGE_WINDOW_MS;
  const windowKey = deps.store.windowKey(nowMs, windowMs);
  const judgeSessionsDir = join(opts.crewhausDir, "watchme", "judge-sessions");
  let judgeReport: WatchmeReportJson["judge"];
  if (opts.judge !== undefined && opts.judge.budgetUsd > 0 && opts.noModel !== true) {
    judgeReport = await runJudgePhase({
      opts,
      deps,
      analyses,
      feedback,
      windowKey,
      judgeSessionsDir,
    });
  } else if (opts.judge !== undefined) {
    judgeReport = {
      model: opts.judge.model,
      windowKey,
      outcome: "skipped",
      reason:
        opts.noModel === true ? "--no-model" : "judge.budget_usd is 0 — deterministic-only report",
      sampled: 0,
      judged: 0,
      spentUsd: 0,
    };
  }

  // -- commit the durable cursor + scalar watermark (deferred until here) --
  // A transient judge failure (`model_failed`) does NOT advance the cursor for
  // this window's sessions: they stay eligible for re-enumeration so the next
  // report re-analyzes AND re-judges them. A successful, refused, or
  // deterministic-only window commits the cursor normally.
  const judgeFailed = judgeReport?.outcome === "failed";
  if (opts.sessionId === undefined && analyses.length > 0 && !judgeFailed) {
    const maxMtime = Math.max(state.watermark.lastMtimeMs, ...analyses.map((a) => a.mtimeMs));
    const last = analyses[analyses.length - 1] as SessionAnalysis;
    const observed = boundObserved({
      ...observedCursor,
      ...Object.fromEntries(
        analyses.map((a) => [a.sessionId, { mtimeMs: a.mtimeMs, turnCount: a.turns.length }]),
      ),
    });
    deps.store.setState({
      watermark: { lastMtimeMs: maxMtime, lastSessionId: last.sessionId },
      observed,
      lastReportAt: nowMs,
    });
  } else {
    deps.store.setState({ lastReportAt: nowMs });
  }
  if (deps.store.readObservations().length >= WATCHME_COMPACT_THRESHOLD) deps.store.compact();

  const judgments = deps.store.readJudgments();

  // -- quality roll-up (ratings + judgments) --
  const allObservations = [
    ...priorRaw.filter((o) => !newObservations.some((n) => n.sessionId === o.sessionId)),
    ...newObservations,
  ];
  const mergedFeedback = mergeFeedback(feedback);
  const ratingScores = mergedFeedback
    .map((fb) => normalizeRating(fb))
    .filter((s): s is number => s !== undefined);
  let up = 0;
  let down = 0;
  for (const fb of mergedFeedback) {
    if (fb.rating.thumbs === "up") up += 1;
    else if (fb.rating.thumbs === "down") down += 1;
  }
  const judgeScores = judgments.map((j) => clamp01(j.score));

  // -- step 5: counterfactuals over the observed model traffic --
  const modelFolds = new Map<string, ModelFold>();
  for (const obs of allObservations) {
    for (const m of obs.models) {
      const fold = foldFor(modelFolds, m.wire, m.provider, m.spec);
      fold.calls += m.turns;
      fold.usage.in += m.usage.in;
      fold.usage.out += m.usage.out;
      fold.usage.cacheRead += m.usage.cacheRead;
      fold.usage.cacheCreate += m.usage.cacheCreate;
      if (m.costUsdMicros !== undefined) {
        fold.costUsdMicros += m.costUsdMicros;
        fold.costKnown = true;
      }
    }
  }
  const models = foldsToModels(modelFolds, deps.pricing);
  const require = exercisedCapabilities(analyses.flatMap((a) => [...a.events]));
  const scoreboard = deps.openScoreboard(opts.crewhausDir);
  const perTurnQuality: Array<{ model: string; score: number }> = [];
  const turnModelByKey = new Map<string, string>();
  for (const a of analyses) {
    if (a.attribution.perTurnModel === undefined) continue; // ordered: session-level only
    for (const [turnNumber, model] of a.attribution.perTurnModel) {
      turnModelByKey.set(`${a.sessionId}#${turnNumber}`, model);
    }
  }
  // Per-turn quality → model attribution goes through the ordered-safe
  // `turnModelByKey` (exact-confidence sessions only), symmetric for judgments
  // and ratings: an ordered-confidence turn contributes NO per-turn model to
  // the counterfactual evidence join, so a cheaper-model claim is never
  // credited to a model the ordered attribution cannot pin per turn.
  for (const j of judgments) {
    const model = turnModelByKey.get(`${j.sessionId}#${j.turnNumber}`);
    if (model !== undefined) perTurnQuality.push({ model, score: clamp01(j.score) });
  }
  for (const fb of mergedFeedback) {
    const score = normalizeRating(fb);
    const model = turnModelByKey.get(`${fb.sessionId}#${fb.turnNumber}`);
    if (score !== undefined && model !== undefined) perTurnQuality.push({ model, score });
  }
  const counterfactuals = buildCounterfactuals({
    models,
    require,
    pricing: deps.pricing,
    ...(deps.capabilities !== undefined ? { capabilities: deps.capabilities } : {}),
    arms: scoreboard.snapshot(),
    turnQuality: perTurnQuality,
  });

  // -- §8: opt-in shadow routing feed --
  let feedRouting: WatchmeReportJson["feedRouting"];
  if (opts.feedRouting === true) {
    feedRouting = feedRoutingArms({
      analyses,
      judgments,
      mergedFeedback,
      deps,
      scoreboard,
      sessionsDir,
    });
  }

  // -- §9: opt-in machine→human feedback bridge --
  let emitFeedback: WatchmeReportJson["emitFeedback"];
  if (opts.emitFeedback === true) {
    const records = judgmentsToFeedback(judgments, deps.redact);
    const path = join(opts.crewhausDir, "feedback", "watchme.jsonl");
    deps.fs.mkdirp(join(opts.crewhausDir, "feedback"));
    deps.fs.writeFile(
      path,
      records.length > 0 ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "",
    );
    emitFeedback = { written: records.length, path };
  }

  // -- factuality + continuity roll-ups --
  const continuity = rollupContinuity(allObservations);
  let claims = 0;
  let grounded = 0;
  let vacuousSessions = 0;
  const faithfulnessScores: number[] = [];
  const hallucinationScores: number[] = [];
  let factualitySessions = 0;
  for (const obs of allObservations) {
    const f = obs.factuality;
    if (f === undefined) continue;
    factualitySessions += 1;
    claims += f.claims;
    grounded += f.grounded;
    if (f.vacuous === true) vacuousSessions += 1;
    if (f.faithfulness !== undefined) faithfulnessScores.push(f.faithfulness);
    if (f.hallucinationRate !== undefined) hallucinationScores.push(f.hallucinationRate);
  }
  const exampleUngrounded = analyses
    .flatMap((a) => a.factualityExamples)
    .slice(0, 5)
    .map((claim) => deps.redact(claim));

  const mean = (xs: ReadonlyArray<number>): number | undefined =>
    xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;

  const meanRating = mean(ratingScores);
  const meanJudge = mean(judgeScores);
  const meanFaithfulness = mean(faithfulnessScores);
  const meanRelevance = mean(
    analyses.map((a) => a.relevance).filter((s): s is number => s !== undefined),
  );
  const meanHallucinationRate = mean(hallucinationScores);

  const report: WatchmeReportJson = {
    v: 1,
    generatedAt: new Date(nowMs).toISOString(),
    specName: opts.specName,
    target: opts.target,
    scope: "harness",
    window: {
      sessionsAnalyzed: analyses.length,
      sessionIds: analyses.map((a) => a.sessionId),
      exactSessions: analyses.filter((a) => a.attribution.joinConfidence === "exact").length,
      orderedSessions: analyses.filter((a) => a.attribution.joinConfidence === "ordered").length,
    },
    totals: {
      observations: allObservations.length,
      aggregatedSessions: aggregates.reduce((acc, a) => acc + a.n, 0),
    },
    quality: {
      ratings: ratingScores.length,
      ...(meanRating !== undefined ? { meanRating } : {}),
      judged: judgeScores.length,
      ...(meanJudge !== undefined ? { meanJudge } : {}),
      feedback: { up, down },
    },
    continuity,
    factuality: {
      sessions: factualitySessions,
      claims,
      grounded,
      ...(meanFaithfulness !== undefined ? { meanFaithfulness } : {}),
      ...(meanRelevance !== undefined ? { meanRelevance } : {}),
      ...(meanHallucinationRate !== undefined ? { meanHallucinationRate } : {}),
      vacuousSessions,
      exampleUngrounded,
    },
    models,
    counterfactuals,
    intents: digest,
    findings: buildFindings({ intents: digest, counterfactuals }),
    ...(judgeReport !== undefined ? { judge: judgeReport } : {}),
    ...(feedRouting !== undefined ? { feedRouting } : {}),
    ...(emitFeedback !== undefined ? { emitFeedback } : {}),
    warnings,
  };

  // -- write artifacts --
  const outDir = opts.outDir ?? join(opts.crewhausDir, "watchme", "reports", isoDirStamp(nowMs));
  deps.fs.mkdirp(outDir);
  const files: string[] = [];
  const write = (name: string, text: string): void => {
    const path = join(outDir, name);
    deps.fs.writeFile(path, text);
    files.push(path);
  };
  write("report.json", `${JSON.stringify(report, null, 2)}\n`);
  write("report.md", renderWatchmeReportMd(report));
  write(
    "suggestions.json",
    `${JSON.stringify(
      buildSuggestionsFile(report.findings, report.window.sessionIds, report.generatedAt),
      null,
      2,
    )}\n`,
  );
  const harvest = await harvestFewShot(
    analyses.flatMap((a) => [...a.turns]),
    feedback,
    { redact: async (text) => deps.redact(text) },
  );
  write("fewshot-candidates.json", `${JSON.stringify(harvest, null, 2)}\n`);

  return { outcome: "written", outDir, files, report };
}

// ---------------------------------------------------------------------------
// phase 2 — the budgeted judge pass
// ---------------------------------------------------------------------------

async function runJudgePhase(input: {
  opts: WatchmeReportOptions;
  deps: WatchmeReportDeps;
  analyses: ReadonlyArray<SessionAnalysis>;
  feedback: ReadonlyArray<FeedbackRecord>;
  windowKey: string;
  /** The judge phase's ISOLATED session root (never enumerated as harness
   *  traffic) — the driver scans its JSONL for evidence, never model claims. */
  judgeSessionsDir: string;
}): Promise<NonNullable<WatchmeReportJson["judge"]>> {
  const { opts, deps, windowKey } = input;
  const judge = opts.judge as NonNullable<WatchmeReportOptions["judge"]>;
  const base = { model: judge.model, windowKey, sampled: 0, judged: 0, spentUsd: 0 };

  const state = deps.store.state();
  const prior = state.windows[windowKey];
  if (prior === "ok" || prior === "model_refused_unpriced") {
    return { ...base, outcome: "window-consumed", reason: `window ${windowKey} already ${prior}` };
  }

  // A refusal consumes the window (dream semantics): re-running before the
  // next window cannot turn an unpriced judge into spend.
  const refusal = watchmeUnpricedModelReason(judge.model, deps.pricing);
  if (refusal !== null) {
    deps.store.setState({ windows: { ...state.windows, [windowKey]: "model_refused_unpriced" } });
    return { ...base, outcome: "refused", reason: refusal };
  }
  if (deps.judgePhase === undefined) {
    return { ...base, outcome: "skipped", reason: "no judge phase wired" };
  }

  // Sample: ungraded turns of the window, deterministic order. Skip both
  // human-rated turns AND already-judged turns — the latter makes judging
  // idempotent per (sessionId, turnNumber) across windows/re-runs, so a
  // re-run never appends a duplicate judgment or double-spends the budget.
  const ratedKeys = new Set(
    mergeFeedback(input.feedback)
      .filter((fb) => normalizeRating(fb) !== undefined)
      .map((fb) => `${fb.sessionId}#${fb.turnNumber}`),
  );
  const judgedKeys = new Set(
    deps.store.readJudgments().map((j) => `${j.sessionId}#${j.turnNumber}`),
  );
  const candidates: Array<{ turn: SessionTurn; model: string }> = [];
  for (const a of input.analyses) {
    for (const turn of a.turns) {
      if (turn.input.trim() === "" || turn.output.trim() === "") continue;
      const key = `${turn.sessionId}#${turn.turnNumber}`;
      if (ratedKeys.has(key)) continue;
      if (judgedKeys.has(key)) continue;
      candidates.push({ turn, model: modelForTurn(a, turn.turnNumber) });
    }
  }
  candidates.sort(
    (x, y) =>
      x.turn.sessionId.localeCompare(y.turn.sessionId) || x.turn.turnNumber - y.turn.turnNumber,
  );
  const sampled = candidates.slice(
    0,
    Math.min(candidates.length, Math.ceil(clamp01(judge.sampleRate) * candidates.length)),
  );

  let spentUsd = 0;
  let judged = 0;
  let failure: string | undefined;
  for (const { turn, model } of sampled) {
    if (spentUsd >= judge.budgetUsd) break; // the hard budget stop
    try {
      const verdict = await deps.judgePhase.judgeTurn({
        sessionId: turn.sessionId,
        turnNumber: turn.turnNumber,
        input: turn.input,
        output: turn.output,
        budgetRemainingUsd: judge.budgetUsd - spentUsd,
      });
      spentUsd += Math.max(0, verdict.spentUsd);
      judged += 1;
      deps.store.appendJudgment({
        v: 1,
        sessionId: turn.sessionId,
        turnNumber: turn.turnNumber,
        model,
        judgeModel: judge.model,
        score: clamp01(verdict.score),
        rationale: deps.redact(verdict.rationale),
        ts: deps.now(),
      });
    } catch (err) {
      failure = (err as Error).message;
      break;
    }
  }

  // A transient model failure does NOT consume the window — the next report
  // retries; a completed pass does.
  const next = deps.store.state();
  deps.store.setState({
    windows: { ...next.windows, [windowKey]: failure === undefined ? "ok" : "model_failed" },
  });

  // Evidence from the judge phase's OWN session JSONL — never model claims.
  let evidence: NonNullable<NonNullable<WatchmeReportJson["judge"]>["evidence"]> | undefined;
  const judgeSessionId = deps.judgePhase.sessionId?.();
  if (judgeSessionId !== undefined) {
    const text = deps.fs.readFile(join(input.judgeSessionsDir, `${judgeSessionId}.jsonl`));
    if (text !== undefined) {
      const events = parseSessionLog(text);
      const modelCalls = events.filter((e) => e.kind === "model_meta").length;
      const costUsdMicros = events
        .filter((e) => e.kind === "cost_accrual")
        .reduce((acc, e) => {
          const v = payloadOf(e)["costUsdMicros"];
          return acc + (typeof v === "number" ? v : 0);
        }, 0);
      evidence = { sessionId: judgeSessionId, modelCalls, costUsdMicros };
    }
  }

  return {
    ...base,
    outcome: failure === undefined ? "ok" : "failed",
    ...(failure !== undefined ? { reason: failure } : {}),
    sampled: sampled.length,
    judged,
    spentUsd,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

/** The turn's producing model (spec string): exact per-turn attribution when
 *  the sibling exists, else the durable per-turn `model_route` line (both are
 *  turn-numbered, so legitimate per-turn claims). At ordered confidence with
 *  no turn-numbered durable line the model is left UNATTRIBUTED (`"unknown"`)
 *  rather than guessing the session's dominant model — the ordered⇒session-
 *  level-only rule forbids inventing a per-turn model claim, which would
 *  otherwise credit the wrong model in judgments and counterfactuals. */
function modelForTurn(analysis: SessionAnalysis, turnNumber: number): string {
  const exact = analysis.attribution.perTurnModel?.get(turnNumber);
  if (exact !== undefined) return exact;
  for (const ev of analysis.events) {
    if (ev.kind !== "model_route") continue;
    const p = payloadOf(ev);
    if (p["turnNumber"] === turnNumber && typeof p["model"] === "string") {
      return analysis.attribution.wireToSpec.get(p["model"]) ?? p["model"];
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// §8 — opt-in shadow routing feed
// ---------------------------------------------------------------------------

function feedRoutingArms(input: {
  analyses: ReadonlyArray<SessionAnalysis>;
  judgments: ReadonlyArray<WatchmeJudgment>;
  mergedFeedback: ReadonlyArray<FeedbackRecord>;
  deps: WatchmeReportDeps;
  scoreboard: Scoreboard;
  /** The harness `sessions` directory — durable `model_route` recovery for
   *  scored sessions that have already fallen past the analysis watermark. */
  sessionsDir: string;
}): NonNullable<WatchmeReportJson["feedRouting"]> {
  const { deps, sessionsDir } = input;
  // Durable dedup set: `sessionId#turnNumber` keys already recorded as arms.
  const fed = new Set<string>(deps.store.state().fedRoutingKeys ?? []);

  // Delayed quality signal, sourced DURABLY (judgments + merged feedback), so
  // a `--feed-routing` pass after a plain report still sees the scores of
  // sessions already past the watermark.
  const quality: TurnQuality[] = [];
  for (const j of input.judgments) {
    quality.push({ sessionId: j.sessionId, turnNumber: j.turnNumber, score: clamp01(j.score) });
  }
  for (const fb of input.mergedFeedback) {
    const score = normalizeRating(fb);
    if (score !== undefined) {
      quality.push({ sessionId: fb.sessionId, turnNumber: fb.turnNumber, score });
    }
  }
  const scoredKeys = new Set(quality.map((q) => `${q.sessionId}#${q.turnNumber}`));

  // Route decisions per (sessionId#turnNumber). Current-window analyses carry
  // full per-turn attribution (latency/cost); scored sessions NOT re-analyzed
  // this window are recovered from their durable session log.
  const routeByKey = new Map<string, RouteDecision>();
  const analyzed = new Set(input.analyses.map((a) => a.sessionId));
  const addRoutes = (
    sessionId: string,
    events: ReadonlyArray<LoggedEvent>,
    attribution?: ModelAttribution,
  ): void => {
    const failed = events.some((e) => e.kind === "run_failed");
    for (const ev of events) {
      if (ev.kind !== "model_route") continue;
      const p = payloadOf(ev);
      if (typeof p["turnNumber"] !== "number") continue;
      if (typeof p["routeKey"] !== "string" || typeof p["model"] !== "string") continue;
      const turnNumber = p["turnNumber"];
      const key = `${sessionId}#${turnNumber}`;
      if (routeByKey.has(key)) continue;
      const latencyMs = attribution?.perTurnLatencyMs?.get(turnNumber);
      const costMicros = attribution?.perTurnCostUsdMicros?.get(turnNumber);
      routeByKey.set(key, {
        sessionId,
        turnNumber,
        routeKey: p["routeKey"],
        model: attribution?.wireToSpec.get(p["model"]) ?? p["model"],
        success: !failed,
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(costMicros !== undefined ? { costUsd: costMicros / 1_000_000 } : {}),
      });
    }
  };
  for (const a of input.analyses) addRoutes(a.sessionId, a.events, a.attribution);
  const durableSessions = new Set<string>();
  for (const key of scoredKeys) {
    const sid = key.slice(0, key.indexOf("#"));
    if (!analyzed.has(sid)) durableSessions.add(sid);
  }
  for (const sid of durableSessions) {
    const text = deps.fs.readFile(join(sessionsDir, `${sid}.jsonl`));
    if (text === undefined) continue;
    addRoutes(sid, parseSessionLog(text) as ReadonlyArray<LoggedEvent>);
  }

  // Record shadow arms for scored, unfed keys that carry a route decision.
  const decisions: RouteDecision[] = [];
  let deduped = 0;
  for (const key of [...scoredKeys].sort()) {
    const decision = routeByKey.get(key);
    if (decision === undefined) continue; // scored turn with no route line
    if (fed.has(key)) {
      deduped += 1;
      continue;
    }
    decisions.push(decision);
    fed.add(key);
  }

  const rows = deps.joinQualityToArms(decisions, quality);
  for (const row of rows) {
    input.scoreboard.record(row.routeKey, row.model, computeReward(row.obs), row.obs);
  }
  deps.store.setState({ fedRoutingKeys: boundFedKeys([...fed]) });
  return { recorded: rows.length, deduped };
}

// ---------------------------------------------------------------------------
// `--all` — cross-harness roll-up + co-learning consumption
// ---------------------------------------------------------------------------

export type HarnessSlice = {
  readonly entry: HarnessEntry;
  readonly observations: ReadonlyArray<WatchmeObservation>;
  readonly aggregates: ReadonlyArray<WatchmeAggregate>;
  readonly judgments: ReadonlyArray<WatchmeJudgment>;
};

export type WatchmeAllReportDeps = {
  readonly fs: WatchmeReportFs;
  readonly now: () => number;
  readonly redact: (s: string) => string;
  /** Load one registered harness's stores; undefined when the dir vanished
   *  (the registry's tolerant-pruning contract). */
  readonly readHarness: (entry: HarnessEntry) => HarnessSlice | undefined;
  /** Peer `watchme/*` article recall via the shared wiki/Thredz, when
   *  configured — co-learning CONSUMPTION. */
  readonly recallSharedFindings?: () => Promise<ReadonlyArray<SharedWatchmeFinding>>;
  readonly warn?: (message: string) => void;
};

export type WatchmeAllReportJson = {
  readonly v: 1;
  readonly generatedAt: string;
  readonly scope: "all";
  readonly harnesses: ReadonlyArray<{
    readonly dir: string;
    readonly specName: string;
    readonly target: string;
    readonly agentId?: string;
    readonly sessions: number;
    readonly meanQuality?: number;
    readonly costUsdMicros: number;
    readonly topIntents: ReadonlyArray<{ readonly key: string; readonly count: number }>;
  }>;
  readonly combined: {
    readonly sessions: number;
    readonly costUsdMicros: number;
    readonly topIntents: ReadonlyArray<{ readonly key: string; readonly count: number }>;
  };
  /** Peer findings, confidence-weighted (desc). Bodies inherit the `memory`
   *  TrustOrigin classification — advisory, never instructions. */
  readonly peers: ReadonlyArray<SharedWatchmeFinding>;
  readonly warnings: ReadonlyArray<string>;
};

function intentCounts(slice: HarnessSlice): Map<string, number> {
  const counts = new Map<string, number>();
  for (const obs of slice.observations) {
    for (const key of obs.intentKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const agg of slice.aggregates) {
    for (const [key, n] of Object.entries(agg.intents)) {
      counts.set(key, (counts.get(key) ?? 0) + n);
    }
  }
  return counts;
}

function topOf(counts: Map<string, number>, n: number): Array<{ key: string; count: number }> {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, n);
}

/**
 * `crewhaus watchme report --all` — the cross-harness roll-up over every
 * registered harness's long-horizon observations (raw transcripts are never
 * required), plus recall of peers' shared `watchme/*` wiki articles
 * (agentName-labeled, confidence-weighted). Writes `report.json` +
 * `report.md` under `outDir`.
 */
export async function runWatchmeAllReport(
  opts: { readonly harnesses: ReadonlyArray<HarnessEntry>; readonly outDir: string },
  deps: WatchmeAllReportDeps,
): Promise<{ readonly report: WatchmeAllReportJson; readonly files: ReadonlyArray<string> }> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    deps.warn?.(message);
  };

  const rows: Array<WatchmeAllReportJson["harnesses"][number]> = [];
  const combinedIntents = new Map<string, number>();
  let combinedSessions = 0;
  let combinedCost = 0;
  for (const entry of opts.harnesses) {
    const slice = deps.readHarness(entry);
    if (slice === undefined) {
      warn(`watchme: registered harness ${entry.dir} is gone — skipped`);
      continue;
    }
    const counts = intentCounts(slice);
    for (const [key, n] of counts) combinedIntents.set(key, (combinedIntents.get(key) ?? 0) + n);
    let cost = 0;
    const qualitySamples: number[] = [];
    for (const obs of slice.observations) {
      for (const m of obs.models) cost += m.costUsdMicros ?? 0;
      const q = obs.quality;
      if (q?.meanRating !== undefined) qualitySamples.push(q.meanRating);
      if (q?.meanJudge !== undefined) qualitySamples.push(q.meanJudge);
    }
    for (const agg of slice.aggregates) {
      cost += agg.costUsdMicros;
      if (agg.qualityN > 0) qualitySamples.push(agg.meanQuality);
    }
    const sessions = slice.observations.length + slice.aggregates.reduce((acc, a) => acc + a.n, 0);
    combinedSessions += sessions;
    combinedCost += cost;
    rows.push({
      dir: entry.dir,
      specName: entry.specName,
      target: entry.target,
      ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
      sessions,
      ...(qualitySamples.length > 0
        ? { meanQuality: qualitySamples.reduce((a, b) => a + b, 0) / qualitySamples.length }
        : {}),
      costUsdMicros: cost,
      topIntents: topOf(counts, 3),
    });
  }

  let peers: SharedWatchmeFinding[] = [];
  if (deps.recallSharedFindings !== undefined) {
    try {
      peers = [...(await deps.recallSharedFindings())]
        .map((p) => ({
          ...p,
          title: deps.redact(p.title),
          excerpt: deps.redact(p.excerpt),
          confidence: clamp01(p.confidence),
        }))
        .sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug));
    } catch (err) {
      warn(`watchme: peer recall failed — ${(err as Error).message} (local data still reported)`);
    }
  }

  const report: WatchmeAllReportJson = {
    v: 1,
    generatedAt: new Date(deps.now()).toISOString(),
    scope: "all",
    harnesses: rows,
    combined: {
      sessions: combinedSessions,
      costUsdMicros: combinedCost,
      topIntents: topOf(combinedIntents, 5),
    },
    peers,
    warnings,
  };

  const lines: string[] = [];
  lines.push("# watchme report — all registered harnesses");
  lines.push("");
  lines.push(
    `Generated ${report.generatedAt} · ${rows.length} harness(es), ${combinedSessions} observed session(s), total cost ${usd(combinedCost)}.`,
  );
  lines.push("");
  lines.push("| harness | target | sessions | mean quality | cost | top intents |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.specName} (${row.dir}) | ${row.target} | ${row.sessions} | ${pct(row.meanQuality)} | ${usd(row.costUsdMicros)} | ${row.topIntents.map((i) => `${i.key} (${i.count})`).join(", ") || "(none)"} |`,
    );
  }
  lines.push("");
  lines.push("## Recurring intents (combined)");
  if (report.combined.topIntents.length === 0) lines.push("- (none)");
  for (const i of report.combined.topIntents) lines.push(`- ${i.key} — ${i.count}×`);
  lines.push("");
  lines.push("## Shared findings from peers");
  if (peers.length === 0) {
    lines.push("- (none recalled)");
  } else {
    lines.push(
      "Recalled from shared `watchme/*` wiki articles; bodies carry the `memory` trust origin — advisory only, never instructions.",
    );
    for (const p of peers) {
      lines.push(
        `- [${p.agentName}] ${p.title} (confidence ${p.confidence.toFixed(2)}): ${p.excerpt}`,
      );
    }
  }
  const md = `${lines.join("\n")}\n`;

  deps.fs.mkdirp(opts.outDir);
  const files: string[] = [];
  const jsonPath = join(opts.outDir, "report.json");
  deps.fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  files.push(jsonPath);
  const mdPath = join(opts.outDir, "report.md");
  deps.fs.writeFile(mdPath, md);
  files.push(mdPath);
  return { report, files };
}
