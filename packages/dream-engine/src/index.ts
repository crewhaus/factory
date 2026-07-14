/**
 * `@crewhaus/dream-engine` — scheduled memory consolidation
 * (v0.3.0 Goal 5, design §6; module brief 296).
 *
 * "Consolidation on a schedule, not every turn": a dream run is two phases —
 *
 *   Phase 1 — DETERMINISTIC (always, idempotent, no model): see `phase1.ts`.
 *   Phase 2 — MODEL SYNTHESIS (`mode: full` AND `budgetUsd > 0` only): ONE
 *     bounded fresh session (`sessionTarget: "dream"`, singleTurn with a
 *     maxToolIterations cap) seeded with the dream playbook + the phase-1
 *     findings. It acts ONLY through the normal registered tools
 *     (`wiki_write`, `wiki_set_signals`, `MemoryForget`, `PlanUpdate` — the
 *     full justification/audit path), so every synthesis action leaves its
 *     own tool_use/tool_result proof. The engine REFUSES to run the model
 *     phase when the model is unpriced: cost-tracker's `pricingMisses`
 *     charges $0 per response for unknown models, which would turn the
 *     item-27 budget cap into a silent no-op — the refusal is loud instead.
 *
 * The model session itself is an INJECTED seam ({@link DreamModelPhase}):
 * the CLI verb and the daemon emitters build it from `runChatLoop` (which
 * enforces the budget via its item-27 `budget` option); this package stays
 * runtime-core-free, exactly like memory-service's inverted-DI seams. The
 * engine derives the evidence trail (actions + toolUseIds) by scanning the
 * dream session's own event log after the run.
 *
 * Scheduling: state at `.crewhaus/dream/<spec>/state.json`, mutual exclusion
 * via `run.lock` + the window idempotency key (see `state.ts`), and a
 * janitor-registrable step ({@link dreamJanitorStep}) with the
 * `CREWHAUS_DREAM=0` / `CREWHAUS_DREAM_INTERVAL_MS` env knobs per
 * convention.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContinuityStore } from "@crewhaus/continuity-store";
import {
  DEFAULT_PRICING,
  type PricingTable,
  providerOfSpecString,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import {
  type IdempotencyStore,
  idempotencyKey,
  withIdempotency,
} from "@crewhaus/durable-execution";
import { CrewhausError } from "@crewhaus/errors";
import { withFileLock } from "@crewhaus/infra-utils";
import type { MemoryStore } from "@crewhaus/memory-store";
import type { WikiStore } from "@crewhaus/wiki-store";
import { type DreamPhase1Report, runDreamPhase1 } from "./phase1";
import {
  DREAM_IDEMPOTENCY_FILENAME,
  type DreamOutcome,
  type DreamState,
  createFileIdempotencyStore,
  dreamWindowKey,
  readDreamState,
  writeDreamState,
} from "./state";

export {
  type DreamPhase1Counts,
  type DreamPhase1Options,
  type DreamPhase1Report,
  STALE_FACT_AFTER_MS,
  STALE_WIKI_UNVERIFIED_AFTER_MS,
  normalizeFactText,
  runDreamPhase1,
} from "./phase1";
export {
  DREAM_IDEMPOTENCY_FILENAME,
  DREAM_STATE_FILENAME,
  type DreamOutcome,
  type DreamState,
  DreamStateError,
  createFileIdempotencyStore,
  dreamWindowIndex,
  dreamWindowKey,
  readDreamState,
  writeDreamState,
} from "./state";
// The 7-day trash undo window lives with the trash layout; re-exported here
// because the dream pass is its scheduled consumer.
export { TRASH_PURGE_AFTER_MS } from "@crewhaus/continuity-store";

export class DreamEngineError extends CrewhausError {
  override readonly name = "DreamEngineError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/** Internal: distinguishes a run.lock deadline from a real run error. */
class DreamLockTimeoutError extends Error {}

/** Internal: carries a model-failed report OUT of `withIdempotency` so the
 *  failed window is never recorded (the next tick retries — see state.ts). */
class DreamModelFailedSignal extends Error {
  readonly report: DreamRunReport;
  constructor(report: DreamRunReport) {
    super("dream model phase failed");
    this.report = report;
  }
}

/** Hard cap on the model phase's tool inner-loop (the "few-turn" bound in
 *  design §6.2 — one seeded turn, at most this many tool cycles). */
export const DREAM_MAX_TOOL_ITERATIONS = 30;

/** The registered janitor step name (`janitor_action` events carry it). */
export const DREAM_JANITOR_STEP_NAME = "dream_consolidation";

/** The `memory.dream` fragment slice this engine consumes (`IrMemoryDream`
 *  structurally — this package never imports `@crewhaus/ir`). */
export type DreamConfig = {
  readonly everyMs: number;
  /** Default `"full"` (the lowered IR always carries it resolved; hand-built
   *  configs may omit it). */
  readonly mode?: "deterministic" | "full";
  /** Model-phase spend cap in USD. Absent or 0 = deterministic only. */
  readonly budgetUsd?: number;
  /** Playbook override; wins over {@link DreamEngineOptions.playbook}. */
  readonly instructions?: string;
};

export type ResolvedDreamConfig = {
  readonly everyMs: number;
  readonly mode: "deterministic" | "full";
  readonly budgetUsd: number;
  readonly instructions?: string;
};

/** What the injected model-phase runner receives. */
export type DreamModelPhaseInput = {
  /** The consolidation playbook — the session's system instructions. */
  readonly playbook: string;
  /** The seeded user message: phase-1 findings + kickoff + budget note. */
  readonly prompt: string;
  /** The item-27 cap the runner MUST thread into its budget option. */
  readonly budgetUsd: number;
  /** Tool inner-loop bound the runner MUST apply. */
  readonly maxToolIterations: number;
};

export type DreamModelPhaseResult = {
  /** The fresh dream session's id — the engine scans its event log for the
   *  evidence trail. */
  readonly sessionId?: string;
  /** Observed spend in USD (cost-tracker over the run's trace bus). */
  readonly spentUsd?: number;
  /** The session's terminal assistant text. */
  readonly summary?: string;
};

/**
 * The injected model-session seam. `model` is the spec model string — the
 * engine pricing-checks it BEFORE ever calling `run` (an unpriced model is
 * refused, see the module header). The runner is expected to be built on
 * `runChatLoop` with `sessionTarget: "dream"`, `singleTurn: true`, the
 * input's `maxToolIterations`, and `budget: { usdMicros: budgetUsd * 1e6,
 * onExceed: { kind: "stop" } }` — the CLI's `crewhaus dream` runner is the
 * reference implementation.
 */
export type DreamModelPhase = {
  readonly model: string;
  run(input: DreamModelPhaseInput): Promise<DreamModelPhaseResult>;
};

/** One successful model-phase tool call, derived from the dream session's
 *  event log — the §6.2 evidence trail. */
export type DreamModelAction = {
  readonly toolUseId: string;
  readonly toolName: string;
  /** Short human-readable slice of the tool input (slug/title/id). */
  readonly detail?: string;
};

export type DreamModelReport = {
  readonly model: string;
  readonly budgetUsd: number;
  /** True when the model session actually ran (even if it spent $0). */
  readonly ran: boolean;
  /** The unpriced-model refusal, when the engine declined to run. */
  readonly refusal?: string;
  /** The thrown error, when the runner failed. */
  readonly error?: string;
  /** Why the phase was skipped without a refusal (no runner wired). */
  readonly skipped?: string;
  readonly sessionId?: string;
  readonly spentUsd?: number;
  readonly summary?: string;
  readonly actions: readonly DreamModelAction[];
  /** Successful toolUseIds (persisted as `state.lastEvidence`). */
  readonly evidence: readonly string[];
};

export type DreamTrigger = "cli" | "boot" | "janitor";

export type DreamRunReport = {
  readonly specName: string;
  readonly trigger: DreamTrigger;
  /** What this run attempted: `full` = both phases, `deterministic` = 1 only. */
  readonly phase: "deterministic" | "full";
  readonly outcome: DreamOutcome;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly windowKey: string;
  /** True when this invocation returned an earlier run's cached report
   *  (window idempotency) instead of executing. */
  readonly cached: boolean;
  readonly phase1: DreamPhase1Report;
  readonly model?: DreamModelReport;
  /** When the next window opens for this schedule. */
  readonly nextDueAt: string;
};

export type DreamStatus = {
  readonly specName: string;
  readonly config: ResolvedDreamConfig;
  readonly state: DreamState | null;
  /** True when a run is due now (never ran, last run failed, or the cadence
   *  elapsed). */
  readonly overdue: boolean;
  /** `lastRunAt + everyMs` after a successful run; null when never ran. */
  readonly nextDueAt: string | null;
};

export type DreamRunOptions = {
  readonly trigger?: DreamTrigger;
  /** Bypass the window idempotency (still locked, still recorded). */
  readonly force?: boolean;
  /** Cadence override (the `CREWHAUS_DREAM_INTERVAL_MS` knob) — affects the
   *  window key and next-due math for this invocation. */
  readonly everyMsOverride?: number;
};

export type DreamStatusOptions = {
  readonly everyMsOverride?: number;
};

export type DreamEngineOptions = {
  readonly specName: string;
  /** The `.crewhaus` root this harness's stores live under. */
  readonly crewhausDir: string;
  readonly dream: DreamConfig;
  /** Where session `.jsonl` logs live. Default `<crewhausDir>/sessions`. */
  readonly sessionRootDir?: string;
  readonly memoryStore?: MemoryStore;
  readonly wikiStore?: WikiStore;
  readonly continuityStore?: ContinuityStore;
  /** The injected model-session runner. Absent → phase 2 is skipped with a
   *  note (the deterministic pass still runs). */
  readonly modelPhase?: DreamModelPhase;
  /** Default playbook (the builtin `dream` skill body — memory-service
   *  passes it). `dream.instructions` wins; a builtin fallback covers both
   *  being absent. */
  readonly playbook?: string;
  /** Pricing table for the unpriced-model check. Default DEFAULT_PRICING. */
  readonly pricing?: PricingTable;
  /** `dream_run` event sink (event-log kind `dream_run`) — the caller
   *  decides which log it lands in. */
  readonly appendEvent?: (event: {
    kind: "dream_run";
    payload: Record<string, unknown>;
  }) => void | Promise<void>;
  /** Injected idempotency store (tests). Default: the file store next to
   *  state.json. */
  readonly idempotencyStore?: IdempotencyStore;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  /** run.lock wait before reporting `skipped_locked` (tests). */
  readonly lockWaitMs?: number;
};

export type DreamEngine = {
  readonly specName: string;
  readonly config: ResolvedDreamConfig;
  /** Where `state.json` / `idempotency.json` / `run.lock` live. */
  stateDir(): string;
  /** Both phases per config (`mode: full` + budget + runner → model phase). */
  run(opts?: DreamRunOptions): Promise<DreamRunReport>;
  /** Phase 1 only — the boot catch-up path (sub-second, zero spend). */
  runDeterministic(opts?: DreamRunOptions): Promise<DreamRunReport>;
  status(opts?: DreamStatusOptions): Promise<DreamStatus>;
};

/** Fallback playbook when neither `dream.instructions` nor a builtin skill
 *  body was supplied — the §6.2 contract in three sentences. */
const FALLBACK_PLAYBOOK = [
  "You are running a scheduled consolidation pass over this harness's memory fabric.",
  "Work only from the phase-1 findings you are given: merge or split overlapping wiki articles (wiki_write), reconcile contradictions, adjust confidence signals with evidence (wiki_set_signals), promote corroborated facts into cited wiki drafts, retire superseded facts (MemoryForget), and refresh the plan's next actions (PlanUpdate).",
  "Every mutation must go through the registered tools; respect the budget and stop cleanly as it nears.",
].join("\n");

function isSuccess(outcome: DreamOutcome): boolean {
  return outcome === "deterministic" || outcome === "full";
}

/** The clear pre-call pricing check (design §6.2). Returns the refusal
 *  message for an unpriced model, or null when the budget cap can bind. */
export function unpricedModelReason(
  model: string,
  pricing: PricingTable = DEFAULT_PRICING,
): string | null {
  const parsed = providerOfSpecString(model);
  if (parsed === undefined) {
    return `dream: model "${model}" has an unrecognized provider prefix, so it cannot be priced — the budget cap would be a silent no-op (cost-tracker records a pricing miss and charges $0 per response). Use a priced model for memory.dream, or set mode: deterministic / budget_usd: 0.`;
  }
  const row = resolvePricing(pricing, parsed.provider, parsed.modelId);
  if (row === undefined) {
    return `dream: model "${model}" has no pricing entry (provider ${parsed.provider}), so the $-budget cap would be a silent no-op (cost-tracker records a pricing miss and charges $0 per response). Use a priced model for memory.dream, or set mode: deterministic / budget_usd: 0.`;
  }
  return null;
}

function buildDreamPrompt(phase1: DreamPhase1Report, budgetUsd: number): string {
  const c = phase1.counts;
  const lines = [
    "Begin the consolidation pass now. Work only from these deterministic phase-1 findings — do not re-derive them.",
    "",
    "## Phase-1 counts",
    `- sessions newly indexed: ${c.sessionsIndexed}`,
    `- facts: ${c.factsBefore} → ${c.factsAfter} (${c.factsSuperseded} superseded, ${c.factsSwept} expired)`,
    `- facts flagged stale (>90d): ${c.factsStale}`,
    `- wiki articles unverified >30d: ${c.wikiStale}`,
    `- proofs checked: ${c.proofsChecked} (${c.proofsUnverifiable} survive only as frozen excerpts)`,
    `- open plans: ${c.openPlans}`,
    "",
    "## Flags",
  ];
  const findings = phase1.findings.slice(0, 80);
  if (findings.length === 0) {
    lines.push("(none — verify signals, then stop early rather than inventing work)");
  } else {
    for (const finding of findings) lines.push(`- ${finding}`);
  }
  lines.push(
    "",
    `Budget: this pass is capped at $${budgetUsd.toFixed(2)}. Take the highest-value consolidations first — contradictions, then merges, then promotions — and stop cleanly as the cap nears, logging the remainder as gaps.`,
  );
  return lines.join("\n");
}

/** Parse a session `.jsonl` and derive the successful tool calls — the
 *  evidence trail for the report/state (§6.2: every synthesis action leaves
 *  tool_use/tool_result proof). */
export async function scanDreamSessionEvidence(
  sessionId: string,
  sessionRootDir: string,
): Promise<{ actions: DreamModelAction[]; evidence: string[] }> {
  const path = join(sessionRootDir, `${sessionId}.jsonl`);
  const actions: DreamModelAction[] = [];
  const evidence: string[] = [];
  if (!existsSync(path)) return { actions, evidence };
  const uses = new Map<string, { name: string; input: unknown }>();
  const okResults = new Set<string>();
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (line.trim() === "") continue;
    let parsed: { kind?: string; payload?: unknown };
    try {
      parsed = JSON.parse(line) as { kind?: string; payload?: unknown };
    } catch {
      continue;
    }
    if (parsed.kind === "tool_use") {
      const p = parsed.payload as { id?: unknown; name?: unknown; input?: unknown };
      if (typeof p?.id === "string") {
        uses.set(p.id, { name: typeof p.name === "string" ? p.name : "unknown", input: p.input });
      }
    } else if (parsed.kind === "tool_result") {
      const p = parsed.payload as { toolUseId?: unknown; isError?: unknown };
      if (typeof p?.toolUseId === "string" && p.isError !== true) {
        okResults.add(p.toolUseId);
      }
    }
  }
  for (const [id, use] of uses) {
    if (!okResults.has(id)) continue;
    evidence.push(id);
    const detail = detailOf(use.input);
    actions.push({
      toolUseId: id,
      toolName: use.name,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return { actions, evidence };
}

const DETAIL_KEYS = ["slug", "title", "planId", "goalId", "idOrQuery", "query", "text"] as const;

function detailOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value !== "") {
      const flat = value.replace(/\s+/g, " ").trim();
      return `"${flat.length > 48 ? `${flat.slice(0, 47)}…` : flat}"`;
    }
  }
  return undefined;
}

function assertSafeSpecName(specName: string): void {
  if (
    specName === "" ||
    specName.includes("/") ||
    specName.includes("\\") ||
    specName.includes("..")
  ) {
    throw new DreamEngineError(
      `dream-engine: spec name "${specName}" is not a safe directory segment`,
    );
  }
}

export function createDreamEngine(options: DreamEngineOptions): DreamEngine {
  assertSafeSpecName(options.specName);
  if (!Number.isFinite(options.dream.everyMs) || options.dream.everyMs <= 0) {
    throw new DreamEngineError(
      `dream-engine: dream.everyMs must be a positive number (got ${String(options.dream.everyMs)})`,
    );
  }
  const config: ResolvedDreamConfig = {
    everyMs: options.dream.everyMs,
    mode: options.dream.mode ?? "full",
    budgetUsd: options.dream.budgetUsd ?? 0,
    ...(options.dream.instructions !== undefined
      ? { instructions: options.dream.instructions }
      : {}),
  };
  const now = options.now ?? (() => new Date());
  const dreamDir = join(options.crewhausDir, "dream", options.specName);
  const sessionRootDir = options.sessionRootDir ?? join(options.crewhausDir, "sessions");
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const idempotency =
    options.idempotencyStore ??
    createFileIdempotencyStore(join(dreamDir, DREAM_IDEMPOTENCY_FILENAME));

  function overdueOf(state: DreamState | null, everyMs: number, nowMs: number): boolean {
    if (state === null) return true;
    if (!isSuccess(state.lastOutcome)) return true;
    const last = Date.parse(state.lastRunAt);
    return Number.isNaN(last) || nowMs - last >= everyMs;
  }

  async function status(opts: DreamStatusOptions = {}): Promise<DreamStatus> {
    const everyMs = opts.everyMsOverride ?? config.everyMs;
    const state = await readDreamState(dreamDir);
    const nowMs = now().getTime();
    const nextDueAt =
      state !== null && isSuccess(state.lastOutcome) && !Number.isNaN(Date.parse(state.lastRunAt))
        ? new Date(Date.parse(state.lastRunAt) + everyMs).toISOString()
        : null;
    return {
      specName: options.specName,
      config,
      state,
      overdue: overdueOf(state, everyMs, nowMs),
      nextDueAt,
    };
  }

  async function runModelPhase(phase1: DreamPhase1Report): Promise<DreamModelReport> {
    const modelPhase = options.modelPhase;
    const budgetUsd = config.budgetUsd;
    if (modelPhase === undefined) {
      return {
        model: "(none)",
        budgetUsd,
        ran: false,
        skipped:
          "no model-phase runner wired — deterministic pass only (run 'crewhaus dream' for full consolidation)",
        actions: [],
        evidence: [],
      };
    }
    const refusal = unpricedModelReason(modelPhase.model, pricing);
    if (refusal !== null) {
      return { model: modelPhase.model, budgetUsd, ran: false, refusal, actions: [], evidence: [] };
    }
    const playbook = config.instructions ?? options.playbook ?? FALLBACK_PLAYBOOK;
    try {
      const result = await modelPhase.run({
        playbook,
        prompt: buildDreamPrompt(phase1, budgetUsd),
        budgetUsd,
        maxToolIterations: DREAM_MAX_TOOL_ITERATIONS,
      });
      const trail =
        result.sessionId !== undefined
          ? await scanDreamSessionEvidence(result.sessionId, sessionRootDir)
          : { actions: [], evidence: [] };
      return {
        model: modelPhase.model,
        budgetUsd,
        ran: true,
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        ...(result.spentUsd !== undefined ? { spentUsd: result.spentUsd } : {}),
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        actions: trail.actions,
        evidence: trail.evidence,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        model: modelPhase.model,
        budgetUsd,
        ran: false,
        error: message,
        actions: [],
        evidence: [],
      };
    }
  }

  async function execute(
    phase: "deterministic" | "full",
    trigger: DreamTrigger,
    everyMs: number,
    windowKey: string,
  ): Promise<DreamRunReport> {
    const startedAtDate = now();
    const t0 = performance.now();
    const phase1 = await runDreamPhase1({
      specName: options.specName,
      crewhausDir: options.crewhausDir,
      sessionRootDir,
      ...(options.memoryStore !== undefined ? { memoryStore: options.memoryStore } : {}),
      ...(options.wikiStore !== undefined ? { wikiStore: options.wikiStore } : {}),
      ...(options.continuityStore !== undefined
        ? { continuityStore: options.continuityStore }
        : {}),
      now,
    });

    let outcome: DreamOutcome = "deterministic";
    let model: DreamModelReport | undefined;
    if (phase === "full") {
      model = await runModelPhase(phase1);
      outcome = model.ran
        ? "full"
        : model.refusal !== undefined
          ? "model_refused_unpriced"
          : model.error !== undefined
            ? "model_failed"
            : "deterministic";
    }

    const startedAt = startedAtDate.toISOString();
    // A successful run opens the next window at lastRunAt + everyMs; a
    // failed one is due again immediately (see the outcome semantics in
    // state.ts).
    const nextDueAt = isSuccess(outcome)
      ? new Date(startedAtDate.getTime() + everyMs).toISOString()
      : startedAt;

    const report: DreamRunReport = {
      specName: options.specName,
      trigger,
      phase,
      outcome,
      startedAt,
      durationMs: performance.now() - t0,
      windowKey,
      cached: false,
      phase1,
      ...(model !== undefined ? { model } : {}),
      nextDueAt,
    };

    await writeDreamState(dreamDir, {
      schemaVersion: 1,
      lastRunAt: startedAt,
      lastOutcome: outcome,
      phase1Counts: phase1.counts,
      lastEvidence: model?.evidence ?? [],
    });

    // Additive `dream_run` proof record (design §6.2/§9) through the
    // injected sink — the composition root / CLI decide which log it lands
    // in (when the model phase ran, its own session log is the natural one).
    await options.appendEvent?.({
      kind: "dream_run",
      payload: {
        specName: options.specName,
        trigger,
        outcome,
        windowKey,
        phase1Counts: phase1.counts,
        ...(model?.sessionId !== undefined ? { sessionId: model.sessionId } : {}),
        ...(model?.spentUsd !== undefined ? { spentUsd: model.spentUsd } : {}),
        ...(model !== undefined && model.evidence.length > 0 ? { evidence: model.evidence } : {}),
      },
    });

    return report;
  }

  async function runInternal(
    requested: "deterministic" | "full",
    opts: DreamRunOptions,
  ): Promise<DreamRunReport> {
    const trigger = opts.trigger ?? "cli";
    const everyMs = opts.everyMsOverride ?? config.everyMs;
    // The window is fixed at entry — a run straddling a boundary still
    // consumes the window it STARTED in.
    const windowKey = dreamWindowKey(options.specName, now().getTime(), everyMs);

    try {
      return await withFileLock(
        join(dreamDir, "run.lock"),
        async () => {
          const inner = async (): Promise<DreamRunReport> => {
            const report = await execute(requested, trigger, everyMs, windowKey);
            if (report.outcome === "model_failed") {
              // Never record a transiently-failed window — the next tick
              // retries (the deterministic phase is idempotent, so the
              // retry's phase 1 is a cheap no-op).
              throw new DreamModelFailedSignal(report);
            }
            return report;
          };
          if (opts.force === true) {
            try {
              return await inner();
            } catch (err) {
              if (err instanceof DreamModelFailedSignal) return err.report;
              throw err;
            }
          }
          const key = idempotencyKey(windowKey, requested, 0);
          const prior = await idempotency.get(key);
          if (prior !== undefined) {
            const report = prior.result as DreamRunReport;
            return { ...report, cached: true, trigger };
          }
          const wrapped = withIdempotency<DreamRunReport | undefined>(async () => inner(), {
            store: idempotency,
          });
          try {
            const report = await wrapped(windowKey, requested, undefined);
            // inner() always returns a report on the non-cached path.
            return report as DreamRunReport;
          } catch (err) {
            if (err instanceof DreamModelFailedSignal) return err.report;
            throw err;
          }
        },
        {
          label: "dream-engine",
          waitMs: options.lockWaitMs ?? 2_000,
          // A model phase can legitimately run for minutes — a 30s stale
          // steal (the store default) would let a second process wrest the
          // lock mid-run. 15 minutes comfortably exceeds the bounded phase.
          staleMs: 15 * 60_000,
          ...(options.log !== undefined ? { onWarn: options.log } : {}),
          createError: (message) => new DreamLockTimeoutError(message),
        },
      );
    } catch (err) {
      if (err instanceof DreamLockTimeoutError) {
        // Another janitor tick / cron / CLI invocation is consolidating
        // right now. Not double-firing IS the contract — report and move on.
        const state = await readDreamState(dreamDir);
        return {
          specName: options.specName,
          trigger,
          phase: requested,
          outcome: state?.lastOutcome ?? "deterministic",
          startedAt: now().toISOString(),
          durationMs: 0,
          windowKey,
          cached: true,
          phase1: {
            counts: {
              sessionsIndexed: 0,
              factsBefore: 0,
              factsAfter: 0,
              factsSwept: 0,
              factsSuperseded: 0,
              factsStale: 0,
              wikiStale: 0,
              proofsChecked: 0,
              proofsUnverifiable: 0,
              sessionsPinned: 0,
              openPlans: 0,
              trashPurged: 0,
            },
            findings: [`skipped: ${err.message}`],
          },
          nextDueAt: new Date(now().getTime() + everyMs).toISOString(),
        };
      }
      throw err;
    }
  }

  return {
    specName: options.specName,
    config,
    stateDir: () => dreamDir,
    run: (opts = {}) =>
      runInternal(config.mode === "full" && config.budgetUsd > 0 ? "full" : "deterministic", opts),
    runDeterministic: (opts = {}) => runInternal("deterministic", opts),
    status,
  };
}

// ---------------------------------------------------------------------------
// janitor step (design §6.3 — daemons)
// ---------------------------------------------------------------------------

/** Structural mirror of runtime-core's `JanitorStep` (this package never
 *  imports runtime-core — assignability is pinned in the emitters' tests). */
export type DreamJanitorStepOutcome = {
  readonly status: "ok" | "skipped" | "error";
  readonly count?: number;
  readonly detail?: string;
};

export type DreamJanitorStep = {
  readonly name: string;
  run(): Promise<DreamJanitorStepOutcome>;
};

export type DreamJanitorStepOptions = {
  /** Env override (tests). Default `process.env`. */
  readonly env?: Record<string, string | undefined>;
};

/**
 * Wrap an engine as a registrable janitor step (design §6.3): due-checked
 * against `state.json` on every boot+hourly tick — restart-safe, catch-up
 * for free — with the conventional env knobs:
 *
 *   - `CREWHAUS_DREAM=0` disables the step entirely;
 *   - `CREWHAUS_DREAM_INTERVAL_MS` overrides the spec cadence (window math
 *     included).
 */
export function dreamJanitorStep(
  engine: DreamEngine,
  opts: DreamJanitorStepOptions = {},
): DreamJanitorStep {
  return {
    name: DREAM_JANITOR_STEP_NAME,
    async run(): Promise<DreamJanitorStepOutcome> {
      const env = opts.env ?? process.env;
      if (env["CREWHAUS_DREAM"] === "0") {
        return { status: "skipped", detail: "CREWHAUS_DREAM=0" };
      }
      const rawOverride = env["CREWHAUS_DREAM_INTERVAL_MS"];
      const parsedOverride = rawOverride !== undefined ? Number(rawOverride) : Number.NaN;
      const everyMsOverride =
        Number.isFinite(parsedOverride) && parsedOverride > 0 ? parsedOverride : undefined;

      const current = await engine.status(everyMsOverride !== undefined ? { everyMsOverride } : {});
      if (!current.overdue) {
        return {
          status: "skipped",
          detail: `not due — next due ${current.nextDueAt ?? "now"}`,
        };
      }
      const report = await engine.run({
        trigger: "janitor",
        ...(everyMsOverride !== undefined ? { everyMsOverride } : {}),
      });
      const c = report.phase1.counts;
      const mutations =
        c.sessionsIndexed + c.factsSwept + c.factsSuperseded + c.sessionsPinned + c.trashPurged;
      if (report.outcome === "model_refused_unpriced") {
        return { status: "error", detail: report.model?.refusal ?? "unpriced model" };
      }
      if (report.outcome === "model_failed") {
        return {
          status: "error",
          detail: `model phase failed: ${report.model?.error ?? "unknown"} (deterministic pass completed; retrying next tick)`,
        };
      }
      if (report.cached) {
        return { status: "skipped", detail: `window ${report.windowKey} already consolidated` };
      }
      const spent = report.model?.spentUsd;
      return {
        status: "ok",
        count: mutations + (report.model?.actions.length ?? 0),
        detail: `${report.outcome} run: ${c.factsBefore} → ${c.factsAfter} facts (${c.factsSuperseded} superseded), ${c.sessionsIndexed} sessions indexed, ${c.trashPurged} trash purged${
          report.model?.ran === true
            ? `, model actions ${report.model.actions.length}${spent !== undefined ? ` ($${spent.toFixed(2)})` : ""}`
            : ""
        }`,
      };
    },
  };
}
