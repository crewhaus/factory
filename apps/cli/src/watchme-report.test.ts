/**
 * §14 watchme-report row: turnNumber parity property, exact-vs-ordered
 * attribution, counterfactual hand-checks against computeCostMicros,
 * continuity direction handling, redaction (secret shapes built from parts at
 * runtime — factory push-protection blocks literal secret shapes), judge
 * window semantics (refusal consumes, transient failure does not, budget
 * stop), window/watermark idempotency, q:-prefixed shadow arms with rewards
 * in [0,1], emit-feedback gating, and the cross-harness --all merge.
 *
 * Tests run against REAL collaborators wherever resolvable: the real
 * watchme-store (via relative source imports — the `@crewhaus/watchme-store`
 * workspace link does not exist until the integrate phase runs bun install;
 * test files are excluded from `tsc -b`, so the relative import is safe), the
 * real routing-store scoreboard, and the real defaultGraderRegistry.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityTable, PricingTable } from "@crewhaus/cost-tracker";
import { computeCostMicros } from "@crewhaus/cost-tracker";
import { defaultGraderRegistry } from "@crewhaus/eval-runner";
import { openScoreboard } from "@crewhaus/routing-store";
import { joinQualityToArms } from "../../../packages/watchme-store/src/join";
import { openWatchmeStore } from "../../../packages/watchme-store/src/store";
import type { HarnessEntry } from "../../../packages/watchme-store/src/types";
import { deriveTurns, extractFeedbackRecords, isFeedbackRecord } from "./feedback";
import type { LoggedEvent } from "./feedback";
import { clusterIntents, orderedTurnsFromSessions, redactDigest } from "./intents";
import {
  REPORT_SECTION_TITLES,
  WATCHME_COMPACT_THRESHOLD,
  WATCHME_VERIFY_ARGV,
  attributeModels,
  buildCounterfactuals,
  judgmentsToFeedback,
  nodeReportFs,
  rollupContinuity,
  runWatchmeAllReport,
  runWatchmeReport,
} from "./watchme-report";
import type { WatchmeJudgePhase, WatchmeReportDeps, WatchmeReportOptions } from "./watchme-report";

// Secret-shaped strings are BUILT FROM PARTS at runtime — factory's push
// protection blocks real-shaped secret literals in test fixtures.
const SECRET = ["sk-", "ant-", "api03-", "wachtme", "0123456789abcdef"].join("");
const redactSecret = (s: string): string => s.split(SECRET).join("[REDACTED]");

const PRICING: PricingTable = {
  version: "watchme-test",
  providers: {
    anthropic: {
      "claude-big": { inputPer1M: 10, outputPer1M: 20 },
      "claude-small": { inputPer1M: 1, outputPer1M: 2 },
      "claude-judge": { inputPer1M: 1, outputPer1M: 1 },
    },
    openai: {
      "gpt-tiny": { inputPer1M: 0.5, outputPer1M: 1 },
    },
  },
};

const CAP = (tool_use: boolean) =>
  ({ caching: "explicit", tool_use, vision: true, thinking: false, web_search: false }) as const;

const CAPABILITIES: CapabilityTable = {
  version: "watchme-test",
  providers: {
    anthropic: {
      "claude-big": CAP(true),
      "claude-small": CAP(true),
      "claude-judge": CAP(true),
    },
    openai: {
      "gpt-tiny": CAP(false),
    },
  },
};

// -- fixture helpers --------------------------------------------------------

let sessionCounter = 0;
function freshSessionId(): string {
  sessionCounter += 1;
  return `sess_${sessionCounter.toString(16).padStart(16, "0")}`;
}

const jsonl = (events: ReadonlyArray<unknown>): string =>
  `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

const ev = (kind: string, payload: unknown): { ts: number; kind: string; payload: unknown } => ({
  ts: 1_700_000_000_000,
  kind,
  payload,
});

function userMsg(text: string): unknown {
  return ev("user_message", { content: text });
}
function assistantMsg(text: string): unknown {
  return ev("assistant_message", { content: [{ type: "text", text }] });
}
function siblingResponse(
  sessionId: string,
  turnNumber: number,
  model: string,
  usage: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
  durationMs = 1200,
): unknown {
  return {
    runId: "run_1",
    sessionId,
    turnNumber,
    traceId: "t".repeat(32),
    spanId: "s".repeat(16),
    timestamp: new Date(1_700_000_000_000).toISOString(),
    kind: "model_response",
    model,
    provider: "anthropic",
    stopReason: "end_turn",
    usage,
    durationMs,
  };
}

function feedbackLine(sessionId: string, turnNumber: number, thumbs: "up" | "down"): unknown {
  return ev("user_feedback", {
    schemaVersion: 1,
    id: `fb_${sessionId}_${turnNumber}`,
    sessionId,
    turnNumber,
    modality: "binary",
    rating: { thumbs },
    source: "cli",
    ts: new Date(1_700_000_000_500).toISOString(),
  });
}

type Harness = {
  crewhausDir: string;
  sessionsDir: string;
  store: ReturnType<typeof openWatchmeStore>;
};

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "watchme-report-"));
  const crewhausDir = join(root, ".crewhaus");
  const sessionsDir = join(crewhausDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  return { crewhausDir, sessionsDir, store: openWatchmeStore(crewhausDir) };
}

function makeDeps(harness: Harness, overrides: Partial<WatchmeReportDeps> = {}): WatchmeReportDeps {
  return {
    fs: nodeReportFs,
    now: () => 1_700_000_100_000,
    store: harness.store,
    deriveTurns,
    clusterIntents,
    orderedTurnsFromSessions,
    redactDigest,
    redact: redactSecret,
    graderRegistry: () =>
      defaultGraderRegistry({ pluginRoot: join(harness.crewhausDir, "no-plugins") }),
    openScoreboard,
    pricing: PRICING,
    capabilities: CAPABILITIES,
    joinQualityToArms,
    ...overrides,
  };
}

function baseOpts(
  harness: Harness,
  extra: Partial<WatchmeReportOptions> = {},
): WatchmeReportOptions {
  return {
    crewhausDir: harness.crewhausDir,
    specName: "watchme-fixture",
    target: "cli",
    ...extra,
  };
}

/** Seed one 1-turn "exact" session: sibling model_response + model_route +
 *  tool_use/result; input/output/tool_result may carry the secret. */
function seedExactSession(
  harness: Harness,
  opts: { rateTurn1?: "up" | "down"; extraTurns?: number; withSecret?: boolean } = {},
): string {
  const id = freshSessionId();
  const secretPart = opts.withSecret === true ? ` token ${SECRET}` : "";
  const events: unknown[] = [
    userMsg(`How do I export my session data to CSV format?${secretPart}`),
    ev("tool_use", { id: "tu1", name: "Export", input: {} }),
    ev("tool_result", {
      toolUseId: "tu1",
      content: `export command writes session data to CSV files${secretPart}`,
      isError: false,
    }),
    assistantMsg(`The export command writes session data to CSV files.${secretPart}`),
    ev("model_route", {
      turnNumber: 1,
      routeKey: "hard",
      model: "claude-big",
      policy: "learned",
      reason: "test",
    }),
  ];
  const sibling: unknown[] = [
    siblingResponse(id, 1, "claude-big", { input: 1000, output: 200, cacheRead: 500 }),
  ];
  for (let i = 0; i < (opts.extraTurns ?? 0); i += 1) {
    const turn = 2 + i;
    events.push(userMsg(`Tell me more about export option number ${turn} please`));
    events.push(assistantMsg(`Export option ${turn} writes a separate file.`));
    sibling.push(siblingResponse(id, turn, "claude-big", { input: 100, output: 50 }));
  }
  if (opts.rateTurn1 !== undefined) events.push(feedbackLine(id, 1, opts.rateTurn1));
  writeFileSync(join(harness.sessionsDir, `${id}.jsonl`), jsonl(events));
  writeFileSync(join(harness.sessionsDir, `${id}.events.jsonl`), jsonl(sibling));
  return id;
}

/** Seed one 2-turn "ordered" session: durable mirrors only, no sibling. */
function seedOrderedSession(harness: Harness): string {
  const id = freshSessionId();
  const events: unknown[] = [
    userMsg("Summarize the quarterly revenue numbers for the board deck"),
    assistantMsg("Revenue grew nine percent quarter over quarter."),
    ev("cost_accrual", {
      provider: "anthropic",
      modelId: "claude-small",
      inputTokens: 400,
      outputTokens: 100,
      cachedReadTokens: 0,
      costUsdMicros: 600,
    }),
    ev("model_meta", { stopReason: "end_turn", model: "claude-small" }),
    userMsg("Now list the top three cost drivers from the revenue report"),
    assistantMsg("The top cost drivers are compute, storage, and support."),
    ev("cost_accrual", {
      provider: "anthropic",
      modelId: "claude-small",
      inputTokens: 600,
      outputTokens: 150,
      cachedReadTokens: 0,
      costUsdMicros: 900,
    }),
    ev("model_meta", { stopReason: "end_turn", model: "claude-small" }),
  ];
  writeFileSync(join(harness.sessionsDir, `${id}.jsonl`), jsonl(events));
  return id;
}

/** Seed one 2-turn "ordered" session with TWO models (claude-small then
 *  claude-big), durable mirrors only, no sibling and no `model_route` lines —
 *  so per-turn model attribution is impossible and modelForTurn must leave the
 *  turn UNATTRIBUTED (never the dominant model). */
function seedOrderedTwoModelSession(harness: Harness): string {
  const id = freshSessionId();
  const events: unknown[] = [
    userMsg("Draft the opening paragraph for the quarterly board update"),
    assistantMsg("Revenue grew nine percent quarter over quarter."),
    ev("cost_accrual", {
      provider: "anthropic",
      modelId: "claude-small",
      inputTokens: 400,
      outputTokens: 100,
      cachedReadTokens: 0,
      costUsdMicros: 600,
    }),
    ev("model_meta", { stopReason: "end_turn", model: "claude-small" }),
    userMsg("Now expand it into three detailed paragraphs for the appendix"),
    assistantMsg("The top cost drivers are compute, storage, and support."),
    ev("cost_accrual", {
      provider: "anthropic",
      modelId: "claude-big",
      inputTokens: 600,
      outputTokens: 150,
      cachedReadTokens: 0,
      costUsdMicros: 900,
    }),
    ev("model_meta", { stopReason: "end_turn", model: "claude-big" }),
  ];
  writeFileSync(join(harness.sessionsDir, `${id}.jsonl`), jsonl(events));
  return id;
}

/** Overwrite a session's `.jsonl` (+ exact sibling) with `turnCount` turns and
 *  a strictly-later mtime, simulating a live session that grew since its last
 *  digest. */
function growExactSession(harness: Harness, id: string, turnCount: number): void {
  const events: unknown[] = [];
  const sibling: unknown[] = [];
  for (let turn = 1; turn <= turnCount; turn += 1) {
    events.push(userMsg(`Question number ${turn} about exporting session data please`));
    events.push(assistantMsg(`Answer number ${turn} about the export flow.`));
    sibling.push(siblingResponse(id, turn, "claude-big", { input: 100, output: 50 }));
  }
  writeFileSync(join(harness.sessionsDir, `${id}.jsonl`), jsonl(events));
  writeFileSync(join(harness.sessionsDir, `${id}.events.jsonl`), jsonl(sibling));
  const future = Date.now() / 1000 + 120; // strictly after the prior digest
  utimesSync(join(harness.sessionsDir, `${id}.jsonl`), future, future);
}

// -- turnNumber PARITY property test ---------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("turnNumber parity (deriveTurns vs envelope)", () => {
  test("property: deriveTurns count === max sibling envelope turnNumber across seeded fixtures", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const rand = mulberry32(seed);
      const sessionId = `sess_${seed.toString(16).padStart(16, "0")}`;
      const turnCount = 1 + Math.floor(rand() * 5);
      const events: Array<{ kind: string; payload: unknown }> = [];
      const sibling: unknown[] = [];
      for (let turn = 1; turn <= turnCount; turn += 1) {
        // Runtime-injected nudges are NOT turns.
        if (rand() < 0.4) {
          events.push({
            kind: "user_message",
            payload: { content: "continue", synthetic: true },
          });
        }
        events.push({ kind: "user_message", payload: { content: `question number ${turn}` } });
        if (rand() < 0.5) {
          // Tool round-trip: the tool_result ECHO user message is not a turn.
          events.push({
            kind: "assistant_message",
            payload: { content: [{ type: "tool_use", id: `t${turn}`, name: "Fetch" }] },
          });
          events.push({
            kind: "user_message",
            payload: { content: [{ type: "tool_result", tool_use_id: `t${turn}` }] },
          });
          sibling.push(siblingResponse(sessionId, turn, "claude-big", { input: 10, output: 5 }));
        }
        events.push({
          kind: "assistant_message",
          payload: { content: [{ type: "text", text: `answer ${turn}` }] },
        });
        sibling.push(siblingResponse(sessionId, turn, "claude-big", { input: 20, output: 10 }));
      }
      const derived = deriveTurns(events as ReadonlyArray<LoggedEvent>);
      const maxEnvelope = Math.max(...sibling.map((s) => (s as { turnNumber: number }).turnNumber));
      expect(derived.length).toBe(turnCount);
      expect(maxEnvelope).toBe(turnCount);
      expect(derived.length).toBe(maxEnvelope);
    }
  });
});

// -- attribution ------------------------------------------------------------

describe("attributeModels", () => {
  const sessionEvents: LoggedEvent[] = [
    {
      kind: "cost_accrual",
      payload: {
        provider: "anthropic",
        modelId: "claude-big",
        inputTokens: 1000,
        outputTokens: 200,
        cachedReadTokens: 500,
        costUsdMicros: 14500,
      },
    },
    { kind: "model_meta", payload: { stopReason: "end_turn", model: "claude-big" } },
  ];

  test("exact: sibling model_response envelopes drive per-turn attribution", () => {
    const sibling = [
      siblingResponse("sess_a", 1, "claude-big", { input: 1000, output: 200, cacheRead: 500 }),
      siblingResponse("sess_a", 2, "claude-big", { input: 100, output: 50 }),
    ] as ReadonlyArray<LoggedEvent>;
    const attribution = attributeModels([], sibling, PRICING);
    expect(attribution.joinConfidence).toBe("exact");
    expect(attribution.perTurnModel).toBeDefined();
    expect(attribution.perTurnModel?.get(1)).toBe("claude-big");
    expect(attribution.perTurnModel?.get(2)).toBe("claude-big");
    expect(attribution.models).toHaveLength(1);
    const model = attribution.models[0];
    expect(model?.turns).toBe(2);
    expect(model?.usage).toEqual({ in: 1100, out: 250, cacheRead: 500, cacheCreate: 0 });
    // Cost hand-check: repriced from the injected table via computeCostMicros.
    const row = PRICING.providers.anthropic?.["claude-big"];
    expect(model?.costUsdMicros).toBe(
      computeCostMicros(row as NonNullable<typeof row>, 1000, 200, 500, 0) +
        computeCostMicros(row as NonNullable<typeof row>, 100, 50, 0, 0),
    );
  });

  test("ordered: durable mirrors aggregate at SESSION level only — no per-turn map", () => {
    const attribution = attributeModels(sessionEvents, [], PRICING);
    expect(attribution.joinConfidence).toBe("ordered");
    expect(attribution.perTurnModel).toBeUndefined();
    expect(attribution.perTurnLatencyMs).toBeUndefined();
    expect(attribution.models).toHaveLength(1);
    expect(attribution.models[0]?.costUsdMicros).toBe(14500);
  });

  test("unpriced model is flagged, never priced as free", () => {
    const events: LoggedEvent[] = [
      {
        kind: "cost_accrual",
        payload: {
          provider: "anthropic",
          modelId: "claude-mystery",
          inputTokens: 10,
          outputTokens: 5,
          cachedReadTokens: 0,
          costUsdMicros: 0,
        },
      },
    ];
    const attribution = attributeModels(events, [], PRICING);
    expect(attribution.models[0]?.unpriced).toBe(true);
  });
});

// -- counterfactuals --------------------------------------------------------

describe("buildCounterfactuals", () => {
  const bigUsage = { in: 1000, out: 200, cacheRead: 500, cacheCreate: 0 };
  const currentBig = {
    wire: "claude-big",
    provider: "anthropic",
    turns: 2,
    usage: bigUsage,
    costUsdMicros: 14500,
  };

  test("projected cost + delta hand-check against computeCostMicros", () => {
    const rows = buildCounterfactuals({
      models: [currentBig],
      require: {},
      pricing: PRICING,
      capabilities: CAPABILITIES,
      arms: [],
      turnQuality: [],
    });
    const small = rows.find((r) => r.candidate === "claude-small");
    expect(small).toBeDefined();
    const smallRow = PRICING.providers.anthropic?.["claude-small"];
    const expected = computeCostMicros(smallRow as NonNullable<typeof smallRow>, 1000, 200, 500, 0);
    expect(small?.projectedCostUsdMicros).toBe(expected);
    expect(small?.deltaUsdMicros).toBe(14500 - expected);
    expect(small?.verify.argv).toEqual([...WATCHME_VERIFY_ARGV]);
  });

  test("capability filter: a candidate lacking an exercised capability is excluded", () => {
    const rows = buildCounterfactuals({
      models: [currentBig],
      require: { tool_use: true },
      pricing: PRICING,
      capabilities: CAPABILITIES,
      arms: [],
      turnQuality: [],
    });
    expect(rows.some((r) => r.candidate === "openai/gpt-tiny")).toBe(false);
    expect(rows.some((r) => r.candidate === "claude-small")).toBe(true);
  });

  test("cache-re-warm penalty present on cross-provider hops off a warm session", () => {
    const rows = buildCounterfactuals({
      models: [currentBig],
      require: {},
      pricing: PRICING,
      capabilities: CAPABILITIES,
      arms: [],
      turnQuality: [],
    });
    const cross = rows.find((r) => r.candidate === "openai/gpt-tiny");
    const same = rows.find((r) => r.candidate === "claude-small");
    expect(cross?.cacheRewarmPenaltyMicros).toBeGreaterThan(0);
    expect(cross?.effectiveTurnCostMicros).toBeGreaterThan(0);
    expect(same?.cacheRewarmPenaltyMicros).toBe(0);
  });

  test("unpriced current model: delta is UNKNOWN (undefined), never free", () => {
    const rows = buildCounterfactuals({
      models: [{ ...currentBig, costUsdMicros: undefined, unpriced: true } as never],
      require: {},
      pricing: PRICING,
      capabilities: CAPABILITIES,
      arms: [],
      turnQuality: [],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.deltaUsdMicros).toBeUndefined();
  });

  test("evidence tiers: arms > watchme quality > unverified", () => {
    const rows = buildCounterfactuals({
      models: [currentBig],
      require: {},
      pricing: PRICING,
      capabilities: CAPABILITIES,
      arms: [
        {
          routeKey: "q:hard",
          model: "claude-small",
          n: 4,
          meanReward: 0.8,
          varReward: 0,
          meanLatencyMs: 0,
          meanCostUsd: 0,
          costCount: 0,
        },
      ],
      turnQuality: [{ model: "openai/gpt-tiny", score: 0.6 }],
    });
    expect(rows.find((r) => r.candidate === "claude-small")?.evidence).toEqual({
      tier: "arms",
      n: 4,
      mean: 0.8,
    });
    expect(rows.find((r) => r.candidate === "openai/gpt-tiny")?.evidence).toEqual({
      tier: "watchme",
      n: 1,
      mean: 0.6,
    });
  });
});

// -- continuity direction ---------------------------------------------------

describe("rollupContinuity", () => {
  const obsWith = (name: string, score: number) =>
    ({
      v: 1,
      sessionId: "sess_0000000000000001",
      specName: "s",
      target: "cli",
      ts: 0,
      turnCount: 1,
      joinConfidence: "ordered",
      models: [],
      toolStats: [],
      continuity: { [name]: { score, passed: true, higherIsBetter: true } },
      intentKeys: [],
    }) as never;

  test("lower-is-better metric breaches ABOVE its threshold", () => {
    const rows = rollupContinuity([obsWith("continuity.reAskRate", 0.5)]);
    const reAsk = rows.find((r) => r.name === "continuity.reAskRate");
    expect(reAsk?.higherIsBetter).toBe(false);
    expect(reAsk?.breach).toBe(true);
    const clean = rollupContinuity([obsWith("continuity.reAskRate", 0)]);
    expect(clean.find((r) => r.name === "continuity.reAskRate")?.breach).toBe(false);
  });

  test("higher-is-better metric breaches BELOW its threshold", () => {
    const rows = rollupContinuity([obsWith("continuity.reqRetention", 0.5)]);
    expect(rows.find((r) => r.name === "continuity.reqRetention")?.breach).toBe(true);
    const good = rollupContinuity([obsWith("continuity.reqRetention", 0.95)]);
    expect(good.find((r) => r.name === "continuity.reqRetention")?.breach).toBe(false);
  });

  test("no samples ⇒ no breach", () => {
    for (const row of rollupContinuity([])) expect(row.breach).toBe(false);
  });
});

// -- full report ------------------------------------------------------------

describe("runWatchmeReport", () => {
  test("no sessions at all → no-sessions outcome", async () => {
    const harness = makeHarness();
    const result = await runWatchmeReport(baseOpts(harness), makeDeps(harness));
    expect(result.outcome).toBe("no-sessions");
  });

  test("lock contention → locked outcome, nothing written", async () => {
    const harness = makeHarness();
    seedExactSession(harness);
    const release = harness.store.acquireLock();
    expect(release).toBeDefined();
    const result = await runWatchmeReport(baseOpts(harness), makeDeps(harness));
    expect(result.outcome).toBe("locked");
    expect(harness.store.readObservations()).toHaveLength(0);
    release?.();
  });

  test("raw observations at/above the threshold are compacted after the report", async () => {
    const harness = makeHarness();
    for (let i = 0; i < WATCHME_COMPACT_THRESHOLD; i += 1) {
      harness.store.appendObservation({
        v: 1,
        sessionId: freshSessionId(),
        specName: "watchme-fixture",
        target: "cli",
        ts: i,
        turnCount: 1,
        joinConfidence: "ordered",
        models: [],
        toolStats: [],
        intentKeys: [],
      });
    }
    const result = await runWatchmeReport(baseOpts(harness), makeDeps(harness));
    expect(result.outcome).toBe("written");
    expect(harness.store.readObservations()).toHaveLength(0);
    const aggregates = harness.store.readAggregates();
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.n).toBe(WATCHME_COMPACT_THRESHOLD);
  });

  test("full offline report: five sections, artifacts, joinConfidence split, watermark idempotency", async () => {
    const harness = makeHarness();
    seedExactSession(harness, { rateTurn1: "up" });
    seedOrderedSession(harness);
    const deps = makeDeps(harness);
    const result = await runWatchmeReport(baseOpts(harness), deps);
    expect(result.outcome).toBe("written");
    const report = result.report;
    expect(report).toBeDefined();
    if (report === undefined) throw new Error("unreachable");
    expect(report.window.sessionsAnalyzed).toBe(2);
    expect(report.window.exactSessions).toBe(1);
    expect(report.window.orderedSessions).toBe(1);
    expect(report.quality.ratings).toBe(1);
    expect(report.quality.feedback).toEqual({ up: 1, down: 0 });
    expect(report.continuity).toHaveLength(5);
    expect(report.models.length).toBeGreaterThanOrEqual(2);
    expect(report.counterfactuals.length).toBeGreaterThan(0);

    // All four artifacts on disk; report.md has the five sections in order.
    const outDir = result.outDir as string;
    for (const name of [
      "report.json",
      "report.md",
      "suggestions.json",
      "fewshot-candidates.json",
    ]) {
      expect(existsSync(join(outDir, name))).toBe(true);
    }
    const md = readFileSync(join(outDir, "report.md"), "utf8");
    let cursor = -1;
    for (const title of REPORT_SECTION_TITLES) {
      const at = md.indexOf(`## ${title}`);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    const suggestions = JSON.parse(readFileSync(join(outDir, "suggestions.json"), "utf8")) as {
      generatedAt: string;
      sessionIds: string[];
      suggestions: unknown[];
    };
    expect(suggestions.sessionIds).toHaveLength(2);
    expect(Array.isArray(suggestions.suggestions)).toBe(true);
    const fewshot = JSON.parse(readFileSync(join(outDir, "fewshot-candidates.json"), "utf8")) as {
      examples: unknown[];
      stats: { qualified: number };
    };
    expect(fewshot.stats.qualified).toBe(1); // the up-rated turn

    // Observations persisted + watermark advanced.
    expect(harness.store.readObservations()).toHaveLength(2);
    expect(harness.store.state().watermark.lastMtimeMs).toBeGreaterThan(0);

    // Idempotent rerun: nothing re-analyzed, nothing re-appended.
    const again = await runWatchmeReport(baseOpts(harness), deps);
    expect(again.outcome).toBe("written");
    expect(again.report?.window.sessionsAnalyzed).toBe(0);
    expect(harness.store.readObservations()).toHaveLength(2);
  });

  test("a grown session is re-analyzed via the durable cursor; the aggregate reflects the new turnCount, not double-counted", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness); // 1 turn
    const deps = makeDeps(harness);

    const first = await runWatchmeReport(baseOpts(harness), deps);
    expect(first.report?.window.sessionsAnalyzed).toBe(1);
    expect(harness.store.readObservations()).toHaveLength(1);
    expect(harness.store.readObservations()[0]?.turnCount).toBe(1);
    expect(harness.store.state().observed?.[id]?.turnCount).toBe(1);

    // The session grows to 5 turns (file rewritten, mtime advanced).
    growExactSession(harness, id, 5);
    const second = await runWatchmeReport(baseOpts(harness), deps);
    expect(second.report?.window.sessionsAnalyzed).toBe(1); // re-analyzed
    // Last-writer-wins: ONE observation, reflecting 5 turns (not two lines).
    const obs = harness.store.readObservations();
    expect(obs).toHaveLength(1);
    expect(obs[0]?.turnCount).toBe(5);
    expect(harness.store.state().observed?.[id]?.turnCount).toBe(5);

    // Compact folds the deduped raw line once, then an unchanged re-run does
    // nothing (the durable cursor survives compaction).
    harness.store.compact();
    expect(harness.store.readAggregates()[0]?.n).toBe(1);
    const third = await runWatchmeReport(baseOpts(harness), deps);
    expect(third.report?.window.sessionsAnalyzed).toBe(0);
    expect(harness.store.readAggregates()[0]?.n).toBe(1); // still one distinct session
  });

  test("REDACTION: runtime-built secret never survives into any persisted artifact", async () => {
    const harness = makeHarness();
    seedExactSession(harness, { rateTurn1: "up", extraTurns: 1, withSecret: true });
    const judgePhase: WatchmeJudgePhase = {
      model: "claude-judge",
      judgeTurn: async () => ({
        score: 0.9,
        rationale: `good answer but leaked ${SECRET} in the reply`,
        spentUsd: 0.01,
      }),
    };
    const deps = makeDeps(harness, { judgePhase });
    const result = await runWatchmeReport(
      baseOpts(harness, {
        judge: { model: "claude-judge", sampleRate: 1, budgetUsd: 1 },
        emitFeedback: true,
      }),
      deps,
    );
    expect(result.outcome).toBe("written");
    expect(harness.store.readJudgments().length).toBeGreaterThan(0);

    const artifacts = [
      join(harness.crewhausDir, "watchme", "observations.jsonl"),
      join(harness.crewhausDir, "watchme", "judgments.jsonl"),
      join(harness.crewhausDir, "feedback", "watchme.jsonl"),
      ...(result.files as string[]),
    ];
    for (const path of artifacts) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).not.toContain(SECRET);
    }
    // The redactor demonstrably fired somewhere (intents/fewshot carry the marker).
    const allText = artifacts.map((p) => readFileSync(p, "utf8")).join("");
    expect(allText).toContain("[REDACTED]");
  });
});

// -- judge window semantics -------------------------------------------------

describe("phase-2 judge windows", () => {
  test("unpriced judge model: refusal consumes the window, phase never called", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness);
    let calls = 0;
    const judgePhase: WatchmeJudgePhase = {
      model: "claude-unpriced-mystery",
      judgeTurn: async () => {
        calls += 1;
        return { score: 1, rationale: "x", spentUsd: 0 };
      },
    };
    const deps = makeDeps(harness, { judgePhase });
    const opts = baseOpts(harness, {
      sessionId: id,
      judge: { model: "claude-unpriced-mystery", sampleRate: 1, budgetUsd: 1 },
    });
    const result = await runWatchmeReport(opts, deps);
    expect(result.report?.judge?.outcome).toBe("refused");
    expect(calls).toBe(0);
    const windows = harness.store.state().windows;
    expect(Object.values(windows)).toContain("model_refused_unpriced");

    // The consumed window blocks any later pass — even with a priced model.
    const retry = await runWatchmeReport(
      { ...opts, judge: { model: "claude-judge", sampleRate: 1, budgetUsd: 1 } },
      makeDeps(harness, { judgePhase }),
    );
    expect(retry.report?.judge?.outcome).toBe("window-consumed");
    expect(calls).toBe(0);
  });

  test("transient failure does NOT consume the window; the retry judges", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness);
    let calls = 0;
    const judgePhase: WatchmeJudgePhase = {
      model: "claude-judge",
      judgeTurn: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return { score: 0.8, rationale: "solid", spentUsd: 0.01 };
      },
    };
    const deps = makeDeps(harness, { judgePhase });
    const opts = baseOpts(harness, {
      sessionId: id,
      judge: { model: "claude-judge", sampleRate: 1, budgetUsd: 1 },
    });
    const first = await runWatchmeReport(opts, deps);
    expect(first.report?.judge?.outcome).toBe("failed");
    expect(Object.values(harness.store.state().windows)).toContain("model_failed");

    const second = await runWatchmeReport(opts, deps);
    expect(second.report?.judge?.outcome).toBe("ok");
    expect(calls).toBe(2);
    expect(harness.store.readJudgments()).toHaveLength(1);
    expect(Object.values(harness.store.state().windows)).toContain("ok");

    const third = await runWatchmeReport(opts, deps);
    expect(third.report?.judge?.outcome).toBe("window-consumed");
    expect(calls).toBe(2);
  });

  test("budget stop: spend crossing the cap halts sampling; evidence from the judge's own JSONL", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness, { extraTurns: 2 }); // 3 judgeable turns
    const judgeSessionId = freshSessionId();
    // Judge sessions live in the ISOLATED judge-sessions root (FIX 1), never
    // the harness sessions dir — that is where the driver scans for evidence.
    const judgeSessionsDir = join(harness.crewhausDir, "watchme", "judge-sessions");
    mkdirSync(judgeSessionsDir, { recursive: true });
    writeFileSync(
      join(judgeSessionsDir, `${judgeSessionId}.jsonl`),
      jsonl([
        ev("model_meta", { stopReason: "end_turn", model: "claude-judge" }),
        ev("model_meta", { stopReason: "end_turn", model: "claude-judge" }),
        ev("cost_accrual", {
          provider: "anthropic",
          modelId: "claude-judge",
          inputTokens: 100,
          outputTokens: 10,
          cachedReadTokens: 0,
          costUsdMicros: 1_200_000,
        }),
      ]),
    );
    let calls = 0;
    const judgePhase: WatchmeJudgePhase = {
      model: "claude-judge",
      judgeTurn: async () => {
        calls += 1;
        return { score: 0.7, rationale: "fine", spentUsd: 0.6 };
      },
      sessionId: () => judgeSessionId,
    };
    const deps = makeDeps(harness, { judgePhase });
    const result = await runWatchmeReport(
      baseOpts(harness, {
        sessionId: id,
        judge: { model: "claude-judge", sampleRate: 1, budgetUsd: 1 },
      }),
      deps,
    );
    const judge = result.report?.judge;
    expect(judge?.outcome).toBe("ok");
    expect(judge?.sampled).toBe(3);
    expect(calls).toBe(2); // 0.6 → 1.2 ≥ 1.0 stops before the third
    expect(judge?.judged).toBe(2);
    expect(judge?.spentUsd).toBeCloseTo(1.2, 10);
    expect(judge?.evidence).toEqual({
      sessionId: judgeSessionId,
      modelCalls: 2,
      costUsdMicros: 1_200_000,
    });
  });
  test("a transient failure leaves the window's sessions eligible — a PLAIN retry re-enumerates AND re-judges (no --session)", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness);
    let calls = 0;
    const judgePhase: WatchmeJudgePhase = {
      model: "claude-judge",
      judgeTurn: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return { score: 0.8, rationale: "solid", spentUsd: 0.01 };
      },
    };
    const deps = makeDeps(harness, { judgePhase });
    // No --session: enumeration is watermark/cursor-driven.
    const opts = baseOpts(harness, {
      judge: { model: "claude-judge", sampleRate: 1, budgetUsd: 1 },
    });

    const first = await runWatchmeReport(opts, deps);
    expect(first.report?.judge?.outcome).toBe("failed");
    expect(Object.values(harness.store.state().windows)).toContain("model_failed");
    // The cursor was NOT advanced for this window's sessions.
    expect(harness.store.state().observed?.[id]).toBeUndefined();
    expect(harness.store.state().watermark.lastMtimeMs).toBe(0);

    // A plain retry re-enumerates the same session and re-judges it.
    const second = await runWatchmeReport(opts, deps);
    expect(second.report?.window.sessionsAnalyzed).toBe(1);
    expect(second.report?.judge?.outcome).toBe("ok");
    expect(calls).toBe(2);
    expect(harness.store.readJudgments()).toHaveLength(1);
    // Now the window succeeded → the cursor is committed.
    expect(harness.store.state().observed?.[id]?.turnCount).toBe(1);
  });

  test("already-judged turns are skipped on a later window — no duplicate judgment, no double-spend", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness);
    let calls = 0;
    const judgePhase: WatchmeJudgePhase = {
      model: "claude-judge",
      judgeTurn: async () => {
        calls += 1;
        return { score: 0.8, rationale: "ok", spentUsd: 0.02 };
      },
    };
    const judge = { model: "claude-judge", sampleRate: 1, budgetUsd: 1 };
    // Pass 1 (window A) judges turn 1.
    const deps1 = makeDeps(harness, { judgePhase, now: () => 1_700_000_100_000 });
    const first = await runWatchmeReport(baseOpts(harness, { sessionId: id, judge }), deps1);
    expect(first.report?.judge?.judged).toBe(1);
    expect(harness.store.readJudgments()).toHaveLength(1);

    // Pass 2 in a LATER window (so window idempotency does not short-circuit)
    // still re-analyzes the session (--session), but the already-judged turn is
    // skipped: nothing sampled, nothing judged, nothing spent.
    const deps2 = makeDeps(harness, {
      judgePhase,
      now: () => 1_700_000_100_000 + 7 * 60 * 60 * 1000,
    });
    const second = await runWatchmeReport(baseOpts(harness, { sessionId: id, judge }), deps2);
    expect(second.report?.judge?.outcome).toBe("ok");
    expect(second.report?.judge?.sampled).toBe(0);
    expect(second.report?.judge?.judged).toBe(0);
    expect(second.report?.judge?.spentUsd).toBe(0);
    expect(harness.store.readJudgments()).toHaveLength(1); // still exactly one
    expect(calls).toBe(1); // judged only once, budget spent once
  });

  test("ordered-confidence session: a per-turn judgment is NOT attributed to the dominant model", async () => {
    const harness = makeHarness();
    const id = seedOrderedTwoModelSession(harness);
    const judgePhase: WatchmeJudgePhase = {
      model: "claude-judge",
      judgeTurn: async () => ({ score: 0.7, rationale: "reasonable", spentUsd: 0.01 }),
    };
    const deps = makeDeps(harness, { judgePhase });
    const result = await runWatchmeReport(
      baseOpts(harness, {
        sessionId: id,
        judge: { model: "claude-judge", sampleRate: 1, budgetUsd: 1 },
      }),
      deps,
    );
    expect(result.report?.window.orderedSessions).toBe(1);
    const judgments = harness.store.readJudgments();
    expect(judgments.length).toBeGreaterThan(0);
    for (const j of judgments) {
      // Unattributed sentinel — never the ordered session's dominant model.
      expect(j.model).toBe("unknown");
      expect(j.model).not.toBe("claude-big");
      expect(j.model).not.toBe("claude-small");
    }
  });
});

// -- §8 feed-routing --------------------------------------------------------

describe("--feed-routing", () => {
  test("records ONLY q:-prefixed shadow arms with rewards in [0,1]; dedupes on rerun", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness, { rateTurn1: "up" });
    const deps = makeDeps(harness);
    const opts = baseOpts(harness, { sessionId: id, feedRouting: true });
    const first = await runWatchmeReport(opts, deps);
    expect(first.report?.feedRouting?.recorded).toBe(1);

    const armsPath = join(harness.crewhausDir, "routing", "arms.jsonl");
    expect(existsSync(armsPath)).toBe(true);
    const lines = readFileSync(armsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { k: string; m: string; r: number });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.k.startsWith("q:")).toBe(true);
      expect(line.r).toBeGreaterThanOrEqual(0);
      expect(line.r).toBeLessThanOrEqual(1);
    }
    expect(lines[0]?.k).toBe("q:hard");
    expect(lines[0]?.m).toBe("claude-big");

    // Rerun: the (session, turn) join key is folded into state — no re-record.
    const second = await runWatchmeReport(opts, deps);
    expect(second.report?.feedRouting?.recorded).toBe(0);
    expect(second.report?.feedRouting?.deduped).toBe(1);
    const after = readFileSync(armsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(after).toHaveLength(lines.length);
  });

  test("durable sourcing: --feed-routing after a plain report records arms for sessions past the watermark; dedupes on rerun", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness); // carries model_route turn 1
    // A durable judgment supplies the quality signal (survives the watermark,
    // unlike an inline rating that is only read when the session is parsed).
    harness.store.appendJudgment({
      v: 1,
      sessionId: id,
      turnNumber: 1,
      model: "claude-big",
      judgeModel: "claude-judge",
      score: 0.9,
      rationale: "grounded",
      ts: 1_700_000_050_000,
    });
    const deps = makeDeps(harness);

    // Plain report advances the watermark past the session; records no arms.
    const plain = await runWatchmeReport(baseOpts(harness), deps);
    expect(plain.report?.feedRouting).toBeUndefined();
    expect(existsSync(join(harness.crewhausDir, "routing", "arms.jsonl"))).toBe(false);

    // --feed-routing with NO new sessions: durable route recovery kicks in.
    const feed = await runWatchmeReport(baseOpts(harness, { feedRouting: true }), deps);
    expect(feed.report?.window.sessionsAnalyzed).toBe(0); // nothing re-analyzed
    expect(feed.report?.feedRouting?.recorded).toBe(1);
    const armsPath = join(harness.crewhausDir, "routing", "arms.jsonl");
    const lines = readFileSync(armsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { k: string; m: string; r: number });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.k).toBe("q:hard");
    expect(lines[0]?.m).toBe("claude-big");
    expect(lines[0]?.r).toBeGreaterThanOrEqual(0);
    expect(lines[0]?.r).toBeLessThanOrEqual(1);

    // A second --feed-routing run: the key is durably fed → no re-record.
    const again = await runWatchmeReport(baseOpts(harness, { feedRouting: true }), deps);
    expect(again.report?.feedRouting?.recorded).toBe(0);
    expect(again.report?.feedRouting?.deduped).toBe(1);
    expect(
      readFileSync(armsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== ""),
    ).toHaveLength(1);
  });

  test("without --feed-routing no arms are written", async () => {
    const harness = makeHarness();
    seedExactSession(harness, { rateTurn1: "up" });
    await runWatchmeReport(baseOpts(harness), makeDeps(harness));
    expect(existsSync(join(harness.crewhausDir, "routing", "arms.jsonl"))).toBe(false);
  });
});

// -- §9 emit-feedback -------------------------------------------------------

describe("--emit-feedback", () => {
  test("absent by default; with the flag, bare records with source watchme land in feedback/watchme.jsonl", async () => {
    const harness = makeHarness();
    const id = seedExactSession(harness);
    harness.store.appendJudgment({
      v: 1,
      sessionId: id,
      turnNumber: 1,
      model: "claude-big",
      judgeModel: "claude-judge",
      score: 0.85,
      rationale: "grounded and concise",
      ts: 1_700_000_050_000,
    });
    const path = join(harness.crewhausDir, "feedback", "watchme.jsonl");
    const deps = makeDeps(harness);

    await runWatchmeReport(baseOpts(harness, { sessionId: id }), deps);
    expect(existsSync(path)).toBe(false);

    const result = await runWatchmeReport(
      baseOpts(harness, { sessionId: id, emitFeedback: true }),
      deps,
    );
    expect(result.report?.emitFeedback?.written).toBe(1);
    const parsed = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown);
    const records = extractFeedbackRecords(parsed);
    expect(records).toHaveLength(1);
    expect(isFeedbackRecord(records[0])).toBe(true);
    expect(records[0]?.source).toBe("watchme");
    expect(records[0]?.sessionId).toBe(id);
    expect(records[0]?.rating.scale).toEqual({ value: 0.85, min: 0, max: 1 });
  });

  test("judgmentsToFeedback is idempotent by (session, turn) id", () => {
    const judgment = {
      v: 1 as const,
      sessionId: "sess_00000000000000ff",
      turnNumber: 2,
      model: "claude-big",
      judgeModel: "claude-judge",
      score: 1.7, // out of range — clamped
      rationale: "r",
      ts: 1,
    };
    const records = judgmentsToFeedback([judgment, { ...judgment, score: 0.5, ts: 2 }], (s) => s);
    expect(records).toHaveLength(1);
    expect(records[0]?.rating.scale?.value).toBe(0.5); // later ts wins
  });
});

// -- --all cross-harness ----------------------------------------------------

describe("runWatchmeAllReport", () => {
  test("merges live harnesses with tags, warns on a dead registry entry, weights peers by confidence", async () => {
    const a = makeHarness();
    const b = makeHarness();
    const entry = (h: Harness, name: string): HarnessEntry => ({
      dir: h.crewhausDir,
      specName: name,
      target: "cli",
      registeredAt: 1,
      lastSeen: 2,
    });
    const observation = (h: Harness, specName: string, intent: string): void => {
      h.store.appendObservation({
        v: 1,
        sessionId: freshSessionId(),
        specName,
        target: "cli",
        ts: 1,
        turnCount: 2,
        joinConfidence: "exact",
        models: [
          {
            wire: "claude-big",
            provider: "anthropic",
            turns: 2,
            usage: { in: 100, out: 20, cacheRead: 0, cacheCreate: 0 },
            costUsdMicros: 1400,
          },
        ],
        toolStats: [],
        quality: { ratings: 1, meanRating: 0.9, judged: 0 },
        intentKeys: [intent],
      });
    };
    observation(a, "alpha", "export data");
    observation(b, "beta", "summarize revenue");
    const dead: HarnessEntry = {
      dir: join(a.crewhausDir, "gone-away"),
      specName: "ghost",
      target: "cli",
      registeredAt: 1,
      lastSeen: 2,
    };

    const outDir = mkdtempSync(join(tmpdir(), "watchme-all-"));
    const { report, files } = await runWatchmeAllReport(
      { harnesses: [entry(a, "alpha"), entry(b, "beta"), dead], outDir },
      {
        fs: nodeReportFs,
        now: () => 1_700_000_100_000,
        redact: redactSecret,
        readHarness: (e) =>
          e.specName === "ghost"
            ? undefined
            : {
                entry: e,
                observations: openWatchmeStore(e.dir).readObservations(),
                aggregates: openWatchmeStore(e.dir).readAggregates(),
                judgments: [],
              },
        recallSharedFindings: async () => [
          {
            agentName: "peer-low",
            slug: "watchme-intents",
            title: "t1",
            excerpt: "e1",
            confidence: 0.3,
          },
          {
            agentName: "peer-high",
            slug: "watchme-model-fit",
            title: "t2",
            excerpt: "e2",
            confidence: 0.9,
          },
        ],
      },
    );

    expect(report.harnesses).toHaveLength(2);
    expect(report.harnesses.map((h) => h.specName).sort()).toEqual(["alpha", "beta"]);
    expect(report.combined.sessions).toBe(2);
    expect(report.warnings.some((w) => w.includes("gone-away"))).toBe(true);
    // Confidence-weighted ordering: high-confidence peer first.
    expect(report.peers[0]?.agentName).toBe("peer-high");
    expect(files).toHaveLength(2);
    const md = readFileSync(join(outDir, "report.md"), "utf8");
    expect(md).toContain("alpha");
    expect(md).toContain("beta");
    expect(md).toContain("[peer-high]");
  });
});
