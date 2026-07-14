/**
 * v0.3.0 Goal 1 — the runtime-core continuity seam (§2.3 requirements
 * ledger, §2.5 mutable tail region, §2.8 handoff).
 *
 * Headline: the MOTIVATING-FAILURE REPRODUCTION — the release's acceptance
 * test. A user's clarification answer living in the middle of message
 * history used to be deleted outright by `snip` and replaced by an
 * unverified summary by `autoCompact`; the model then re-asked the question.
 * With the continuity seam on, the answer is externalized verbatim BEFORE
 * eviction and re-injected into every model call's `<requirements_ledger>`
 * tail block — un-reproducible even when the summarizer misbehaves, and a
 * resumed session rebuilds the ledger deterministically from the event log.
 *
 * The other half of the suite is the regression fence: an ABSENT seam is
 * byte-identical to a pre-0.3.0 runtime (no tail blocks, no context_evicted
 * events, an unchanged summarizer prompt), and the volatile tail never
 * strips or moves the frozen prefix's cache marker.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { createRunContext } from "@crewhaus/run-context";
import type { Store } from "@crewhaus/state-store";
import { buildTool } from "@crewhaus/tool-builder";
import { createPlanTools } from "@crewhaus/tool-plan";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import {
  CONTINUITY_LEDGER_MAX_CHARS,
  DEFAULT_CONTINUITY_TAIL_MAX_CHARS,
  type HandoffInput,
  PLAN_DIRTY_STATE_KEY,
  extractEvictedEntries,
  renderContinuityTail,
  runChatLoop,
} from "./index";

// ---------------------------------------------------------------------------
// Scripted adapters that capture the FULL request — system blocks included —
// so the rendered model input (the thing the ledger must survive into) can
// be asserted byte-for-byte.
// ---------------------------------------------------------------------------

type StreamRequest = Parameters<ProviderAdapter["stream"]>[0];
type ScriptBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function makeCapturingAdapter(scripts: ScriptBlock[][]): {
  adapter: ProviderAdapter;
  requests: () => StreamRequest[];
  callCount: () => number;
} {
  const requests: StreamRequest[] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req) => {
      requests.push({
        ...req,
        system: req.system.map((b) => ({ ...b })),
        messages: req.messages.map((m) => ({ ...m })),
      } as StreamRequest);
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      const hasToolUse = content.some((b) => b.type === "tool_use");
      i++;
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (let idx = 0; idx < content.length; idx++) {
          const block = content[idx];
          if (block === undefined) continue;
          if (block.type === "text") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          } else {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          }
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
  return { adapter, requests: () => requests, callCount: () => i };
}

/** Compaction stub: always answers with `summaryText`, capturing requests so
 *  the summarizer PROMPT (ledger anchor vs byte-identical) can be asserted. */
function makeSummarizer(summaryText: string): {
  adapter: ProviderAdapter;
  requests: () => StreamRequest[];
} {
  const { adapter, requests } = makeCapturingAdapter([[{ type: "text", text: summaryText }]]);
  return { adapter, requests };
}

type LoggedLine = { kind: string; payload?: Record<string, unknown> };

function readSessionLines(rootDir: string): LoggedLine[] {
  const out: LoggedLine[] = [];
  for (const file of readdirSync(rootDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(rootDir, file), "utf-8").split("\n")) {
      if (line === "") continue;
      out.push(JSON.parse(line) as LoggedLine);
    }
  }
  return out;
}

const systemTexts = (req: StreamRequest | undefined): string[] =>
  (req?.system ?? []).map((b) => b.text);

const filler = (seed: string): string => `${seed} ${"x".repeat(400)}`;

// The user's clarification answer — the content the motivating failure lost.
const ANSWER =
  "Use a semicolon (;) as the CSV delimiter, and always quote fields that contain one.";
const SUMMARY_OMITTING_ANSWER =
  "Summary: the user wants a CSV exporter; implementation details were discussed.";

/** A history whose middle holds ANSWER: with snipKeepHead:1/snipKeepTail:2
 *  the head keeps m0, the tail keeps the last two, and everything between —
 *  including the clarification answer — is dropped. */
function motivatingHistory(): Anthropic.MessageParam[] {
  return [
    { role: "user", content: filler("Build me a CSV exporter.") },
    { role: "assistant", content: filler("Which delimiter should the export use?") },
    { role: "user", content: ANSWER },
    { role: "assistant", content: filler("Understood, continuing implementation.") },
    { role: "user", content: filler("Also add a header row.") },
    { role: "assistant", content: filler("Header row added.") },
    { role: "user", content: "Continue the task." },
  ];
}

const COMPACTION_SIZING = {
  // ~7 messages × ~100 tokens trip the 0.5×400=200-token threshold; the
  // post-snip 4 messages (~220 tokens) STILL trip it, so autocompact fires
  // too — both eviction paths run, exactly like the real failure.
  contextLimit: 400,
  compactionThreshold: 0.5,
  snipKeepHead: 1,
  snipKeepTail: 2,
} as const;

describe("continuity — the motivating-failure reproduction (0.3.0 acceptance test)", () => {
  test("a mid-history user clarification evicted by snip+autocompact reaches the next model call verbatim in <requirements_ledger>, and a resumed session rebuilds it", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-motivating-"));
    try {
      // ---- Session 1: the scripted failure -------------------------------
      const main = makeCapturingAdapter([[{ type: "text", text: "ok" }]]);
      const summarizer = makeSummarizer(SUMMARY_OMITTING_ANSWER);
      const handoffs: HandoffInput[] = [];
      const runContext = createRunContext();

      await runChatLoop({
        model: "test-model",
        instructions: "build the exporter",
        _adapter: main.adapter,
        _compactionAdapter: summarizer.adapter,
        runContext,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: motivatingHistory(),
        permissionMode: "bypass",
        ...COMPACTION_SIZING,
        continuity: {
          loadPlan: async () => null,
          onHandoff: async (input) => {
            handoffs.push(input);
          },
        },
      });

      // The answer was genuinely evicted: the model-call HISTORY no longer
      // carries it (compaction replaced everything with [marker, summary]).
      const req = main.requests()[0];
      expect(req).toBeDefined();
      const historyText = JSON.stringify(req?.messages ?? []);
      expect(historyText).not.toContain(ANSWER);
      // …and the scripted summary deliberately omitted it, modeling the
      // exact "unverified summary dropped the requirement" failure.
      expect(historyText).toContain(SUMMARY_OMITTING_ANSWER);

      // THE FIX: the rendered model input still contains the answer,
      // verbatim, in the <requirements_ledger> tail block.
      const ledgerBlock = systemTexts(req).find((t) => t.includes("<requirements_ledger>"));
      expect(ledgerBlock).toBeDefined();
      expect(ledgerBlock).toContain(ANSWER);
      // The tail is volatile: no cache marker, and it sits after the frozen
      // cache-marked prefix.
      const blocks = req?.system ?? [];
      const tailIndex = blocks.findIndex((b) => b.text.includes("<requirements_ledger>"));
      const lastMarker = blocks.reduce((acc, b, idx) => (b.cache_control != null ? idx : acc), -1);
      expect(blocks[tailIndex]?.cache_control).toBeUndefined();
      expect(lastMarker).toBeGreaterThanOrEqual(0);
      expect(lastMarker).toBeLessThan(tailIndex);

      // Zero model trust: the eviction is durable. The event log carries the
      // answer as a verbatim `context_evicted` user record…
      const lines = readSessionLines(rootDir);
      const evictedUsers = lines.filter(
        (l) => l.kind === "context_evicted" && l.payload?.["role"] === "user",
      );
      expect(evictedUsers.some((l) => l.payload?.["text"] === ANSWER)).toBe(true);
      // …and the compaction record persists the SUMMARY TEXT next to the
      // before/after counts (additive §2.3 provenance).
      const autocompactLine = lines.find(
        (l) => l.kind === "compaction" && l.payload?.["kind"] === "autocompact",
      );
      expect(autocompactLine?.payload?.["summary"]).toBe(SUMMARY_OMITTING_ANSWER);
      expect(typeof autocompactLine?.payload?.["before"]).toBe("number");
      expect(typeof autocompactLine?.payload?.["after"]).toBe("number");

      // The summarizer prompt was ANCHORED with the ledger (discipline layer;
      // correctness never depends on it).
      const summarizerPrompt = summarizer.requests()[0]?.messages.at(-1)?.content;
      expect(typeof summarizerPrompt).toBe("string");
      expect(summarizerPrompt as string).toContain(ANSWER);

      // The deterministic handoff fired exactly once and carries the ledger.
      expect(handoffs.length).toBe(1);
      expect(handoffs[0]?.stopReason).toBe("complete");
      expect(handoffs[0]?.sessionId).toBe(runContext.sessionId);
      expect(handoffs[0]?.ledger.some((e) => e.role === "user" && e.text === ANSWER)).toBe(true);

      // ---- Session 2: --resume rebuilds the ledger deterministically ------
      const resumedMain = makeCapturingAdapter([[{ type: "text", text: "resumed" }]]);
      const resumedSummarizer = makeSummarizer(SUMMARY_OMITTING_ANSWER);
      await runChatLoop({
        model: "test-model",
        instructions: "build the exporter",
        _adapter: resumedMain.adapter,
        _compactionAdapter: resumedSummarizer.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        resume: { sessionId: runContext.sessionId },
        seedMessages: [{ role: "user", content: "Where were we?" }],
        permissionMode: "bypass",
        ...COMPACTION_SIZING,
        continuity: { loadPlan: async () => null },
      });
      const resumedLedger = systemTexts(resumedMain.requests()[0]).find((t) =>
        t.includes("<requirements_ledger>"),
      );
      expect(resumedLedger).toBeDefined();
      expect(resumedLedger).toContain(ANSWER);
      // The dedupe holds: replay re-evicts the same answer, yet the resumed
      // ledger carries it exactly once.
      const occurrences = (resumedLedger as string).split(ANSWER).length - 1;
      expect(occurrences).toBe(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("continuity — absent seam is byte-identical to a pre-0.3.0 runtime", () => {
  test("no tail blocks, no context_evicted events, and a byte-identical summarizer prompt on a seamless compacting run", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-seamless-"));
    try {
      const main = makeCapturingAdapter([[{ type: "text", text: "ok" }]]);
      const summarizer = makeSummarizer(SUMMARY_OMITTING_ANSWER);

      await runChatLoop({
        model: "test-model",
        instructions: "build the exporter",
        _adapter: main.adapter,
        _compactionAdapter: summarizer.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: motivatingHistory(),
        permissionMode: "bypass",
        ...COMPACTION_SIZING,
        // deliberately NO `continuity`
      });

      // No tail region ever renders…
      for (const text of systemTexts(main.requests()[0])) {
        expect(text).not.toContain("<requirements_ledger>");
        expect(text).not.toContain("<current_plan>");
      }
      // …nothing is externalized…
      const lines = readSessionLines(rootDir);
      expect(lines.filter((l) => l.kind === "context_evicted").length).toBe(0);
      // …and the summarizer prompt is the pre-0.3.0 constant, byte-for-byte
      // (no ledger anchor appended).
      expect(summarizer.requests()[0]?.messages.at(-1)?.content).toBe(
        "Summarize the prior conversation as compactly as possible. Keep all key facts, file paths, decisions, and tool results. Output the summary only — no preamble, no apologies.",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("an idle seam (null plan, no evictions) renders the exact same request payload as no seam at all", async () => {
    const run = async (withSeam: boolean): Promise<StreamRequest | undefined> => {
      const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-idle-"));
      try {
        const main = makeCapturingAdapter([[{ type: "text", text: "ok" }]]);
        await runChatLoop({
          model: "test-model",
          instructions: "short run",
          _adapter: main.adapter,
          sessionRootDir: rootDir,
          singleTurn: true,
          seedMessages: [{ role: "user", content: "hello" }],
          permissionMode: "bypass",
          ...(withSeam ? { continuity: { loadPlan: async () => null } } : {}),
        });
        return main.requests()[0];
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    };
    const seamless = await run(false);
    const idleSeam = await run(true);
    expect(JSON.stringify(idleSeam?.system)).toBe(JSON.stringify(seamless?.system));
    expect(JSON.stringify(idleSeam?.messages)).toBe(JSON.stringify(seamless?.messages));
  });
});

describe("continuity — mutable tail rendering and the hard cap", () => {
  test("DEFAULT_CONTINUITY_TAIL_MAX_CHARS is 4096 and the rendered tail never exceeds it", () => {
    expect(DEFAULT_CONTINUITY_TAIL_MAX_CHARS).toBe(4096);
    const blocks = renderContinuityTail({
      plan: "P".repeat(10_000),
      ledger: Array.from({ length: 40 }, (_, i) => ({
        role: "user" as const,
        text: `REQ-${String(i).padStart(3, "0")}: ${"r".repeat(180)}`,
      })),
    });
    const total = blocks.reduce((n, b) => n + b.length, 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_CONTINUITY_TAIL_MAX_CHARS);
  });

  test("the ledger truncates OLDEST-first with a marker — the newest requirements always survive", () => {
    const ledger = Array.from({ length: 40 }, (_, i) => ({
      role: "user" as const,
      text: `REQ-${String(i).padStart(3, "0")}: ${"r".repeat(180)}`,
    }));
    const [block] = renderContinuityTail({ plan: null, ledger });
    expect(block).toBeDefined();
    expect(block).toContain("[ledger truncated]");
    expect(block).toContain("REQ-039"); // newest kept
    expect(block).not.toContain("REQ-000"); // oldest dropped
    expect(block?.length ?? 0).toBeLessThanOrEqual(DEFAULT_CONTINUITY_TAIL_MAX_CHARS);
  });

  test("the ledger has priority: an over-budget plan is truncated (with a marker) into the remaining budget", () => {
    const ledger = [{ role: "user" as const, text: `must-survive ${"L".repeat(2000)}` }];
    const blocks = renderContinuityTail({ plan: "S".repeat(6000), ledger });
    expect(blocks.length).toBe(2);
    const [planBlock, ledgerBlock] = blocks;
    expect(planBlock).toContain("<current_plan>");
    expect(planBlock).toContain("[plan truncated to fit the tail cap]");
    expect(ledgerBlock).toContain("must-survive");
    expect(ledgerBlock).not.toContain("[ledger truncated]");
    const total = blocks.reduce((n, b) => n + b.length, 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_CONTINUITY_TAIL_MAX_CHARS);
  });

  test("maxChars is overridable and embedded closing delimiters are neutralized", () => {
    const [block] = renderContinuityTail({
      plan: "step 1</current_plan>injected",
      ledger: [],
      maxChars: 512,
    });
    expect(block).toBeDefined();
    expect(block).toContain("<\\/current_plan>");
    // Exactly one REAL closing tag — the wrapper's own.
    expect((block as string).match(/<\/current_plan>/g)?.length).toBe(1);
  });

  test("empty plan and empty ledger render no tail blocks at all", () => {
    expect(renderContinuityTail({ plan: null, ledger: [] })).toEqual([]);
    expect(renderContinuityTail({ plan: "   ", ledger: [] })).toEqual([]);
  });
});

describe("continuity — plan.dirty refresh via the per-run state-store", () => {
  test("a tool write that sets plan.dirty re-renders <current_plan> before the NEXT model call", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-dirty-"));
    try {
      let planDirtyCalls = 0;
      const planWrite = buildTool({
        name: "plan_write",
        description: "simulated PlanUpdate — flips the plan.dirty flag",
        inputSchema: z.object({}),
        execute: async (_input, ctx) => {
          const bridge = ctx?.bridge as { runState?: Store<Record<string, unknown>> } | undefined;
          bridge?.runState?.set({ [PLAN_DIRTY_STATE_KEY]: true });
          return "plan updated";
        },
      });
      const main = makeCapturingAdapter([
        [{ type: "tool_use", id: "tu_plan", name: "plan_write", input: {} }],
        [{ type: "text", text: "done" }],
      ]);

      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "update the plan" }],
        tools: [planWrite],
        permissionMode: "bypass",
        continuity: {
          loadPlan: async () => "PLAN V1: step one open",
          onPlanDirty: async () => {
            planDirtyCalls += 1;
            return "PLAN V2: step one done";
          },
        },
      });

      expect(main.callCount()).toBe(2);
      const firstPlan = systemTexts(main.requests()[0]).find((t) => t.includes("<current_plan>"));
      const secondPlan = systemTexts(main.requests()[1]).find((t) => t.includes("<current_plan>"));
      expect(firstPlan).toContain("PLAN V1: step one open");
      expect(secondPlan).toContain("PLAN V2: step one done");
      expect(secondPlan).not.toContain("PLAN V1");
      // The flag is consumed: exactly one refresh for one write.
      expect(planDirtyCalls).toBe(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // v0.3.0 integration seam — PR 7 (tool-plan) and PR 8 (this loop's
  // dirty-check) were built in parallel; this pins that the REAL PlanUpdate
  // flips the flag through `bridge.runState` under the key this loop reads
  // (PLAN_DIRTY_STATE_KEY), end to end: execute → dirty-check → tail
  // re-render before the NEXT model call.
  test("the REAL tool-plan PlanUpdate re-renders <current_plan> before the next model call", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-toolplan-"));
    try {
      const bundle = createPlanTools({
        specName: "seam-spec",
        rootDir: join(rootDir, "state"),
      });
      let planDirtyCalls = 0;
      const renderActive = async (): Promise<string> => {
        const active = await bundle.store.getActivePlan();
        return active === null ? "PLAN: (none yet)" : `PLAN: ${active.title}`;
      };
      const main = makeCapturingAdapter([
        [
          {
            type: "tool_use",
            id: "tu_plan_real",
            name: "PlanUpdate",
            input: {
              action: "create",
              title: "prove the integration seam",
              steps: ["step one"],
            },
          },
        ],
        [{ type: "text", text: "done" }],
      ]);

      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "make a plan" }],
        tools: [...bundle.all],
        permissionMode: "bypass",
        continuity: {
          loadPlan: renderActive,
          onPlanDirty: async () => {
            planDirtyCalls += 1;
            return renderActive();
          },
        },
      });

      expect(main.callCount()).toBe(2);
      const first = systemTexts(main.requests()[0]).find((t) => t.includes("<current_plan>"));
      const second = systemTexts(main.requests()[1]).find((t) => t.includes("<current_plan>"));
      expect(first).toContain("PLAN: (none yet)");
      expect(second).toContain("PLAN: prove the integration seam");
      // Exactly one refresh for one mutation — the flag was set and consumed.
      expect(planDirtyCalls).toBe(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("continuity — handoff fires exactly once with deterministic content", () => {
  test("REPL teardown hands off with stopReason 'exit' and the boot plan snapshot", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-handoff-"));
    try {
      const handoffs: HandoffInput[] = [];
      const main = makeCapturingAdapter([[{ type: "text", text: "hi" }]]);
      const { PassThrough } = await import("node:stream");
      const input = new PassThrough();
      input.write("hello\n");
      input.write("exit\n");
      input.end();

      const runContext = createRunContext();
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        runContext,
        sessionRootDir: rootDir,
        input,
        permissionMode: "bypass",
        continuity: {
          loadPlan: async () => "PLAN: ship it",
          onHandoff: async (handoff) => {
            handoffs.push(handoff);
          },
        },
      });

      expect(handoffs.length).toBe(1);
      expect(handoffs[0]).toEqual({
        plan: "PLAN: ship it",
        ledger: [],
        sessionId: runContext.sessionId,
        stopReason: "exit",
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a handoff failure is swallowed (best-effort) and never breaks the run result", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-handoff-err-"));
    try {
      const main = makeCapturingAdapter([[{ type: "text", text: "fine" }]]);
      const result = await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "bypass",
        continuity: {
          loadPlan: async () => null,
          onHandoff: async () => {
            throw new Error("disk full");
          },
        },
      });
      expect(result).toBe("fine");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("continuity — context_evicted records every role verbatim", () => {
  test("snip-evicted user text, assistant conclusions, and tool findings all persist with their roles", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-roles-"));
    try {
      const main = makeCapturingAdapter([[{ type: "text", text: "ok" }]]);
      const summarizer = makeSummarizer("short summary");
      const userReq = "REQ: exports must open cleanly in Excel";
      const assistantConclusion = `CONCLUSION: the delimiter bug lives in csv.ts ${"a".repeat(380)}`;
      const toolFinding = `TOOL FINDING: 42 rows failed to parse ${"t".repeat(380)}`;
      const history: Anthropic.MessageParam[] = [
        { role: "user", content: filler("head message kept by snip") },
        { role: "assistant", content: assistantConclusion },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_scan", name: "scan", input: { path: "csv.ts" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_scan", content: toolFinding }],
        },
        { role: "user", content: userReq },
        { role: "assistant", content: "noted" },
        { role: "user", content: "continue" },
      ];

      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        _compactionAdapter: summarizer.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: history,
        permissionMode: "bypass",
        // Sized so ONLY snip fires: the light head/tail survive under the
        // threshold once the bulky middle is dropped.
        contextLimit: 400,
        compactionThreshold: 0.5,
        snipKeepHead: 1,
        snipKeepTail: 2,
        continuity: { loadPlan: async () => null },
      });

      const evicted = readSessionLines(rootDir).filter((l) => l.kind === "context_evicted");
      expect(
        evicted.some((l) => l.payload?.["role"] === "user" && l.payload?.["text"] === userReq),
      ).toBe(true);
      expect(
        evicted.some(
          (l) => l.payload?.["role"] === "assistant" && l.payload?.["text"] === assistantConclusion,
        ),
      ).toBe(true);
      expect(
        evicted.some((l) => l.payload?.["role"] === "tool" && l.payload?.["text"] === toolFinding),
      ).toBe(true);
      // Only snip ran (no autocompact) — so the head/tail messages were NOT
      // externalized, and no summary was persisted.
      const compactions = readSessionLines(rootDir).filter((l) => l.kind === "compaction");
      expect(compactions.length).toBe(1);
      expect(compactions[0]?.payload?.["kind"]).toBe("snip");
      expect(evicted.some((l) => l.payload?.["text"] === "continue")).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("continuity.ledger: false disables externalization entirely", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-ledger-off-"));
    try {
      const main = makeCapturingAdapter([[{ type: "text", text: "ok" }]]);
      const summarizer = makeSummarizer("short summary");
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        _compactionAdapter: summarizer.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: motivatingHistory(),
        permissionMode: "bypass",
        ...COMPACTION_SIZING,
        continuity: { loadPlan: async () => "PLAN: still renders", ledger: false },
      });
      expect(readSessionLines(rootDir).filter((l) => l.kind === "context_evicted").length).toBe(0);
      const texts = systemTexts(main.requests()[0]);
      expect(texts.some((t) => t.includes("<requirements_ledger>"))).toBe(false);
      // The plan tail is independent of the ledger switch.
      expect(texts.some((t) => t.includes("PLAN: still renders"))).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("continuity — extractEvictedEntries (unit)", () => {
  test("splits text and tool_result content by role and skips scaffolding", () => {
    expect(extractEvictedEntries({ role: "user", content: "keep me" })).toEqual([
      { role: "user", text: "keep me" },
    ]);
    expect(
      extractEvictedEntries({
        role: "assistant",
        content: "[Context compacted: 12 messages removed]",
      }),
    ).toEqual([]);
    expect(
      extractEvictedEntries({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "finding A" },
          { type: "text", text: "and my requirement" },
        ],
      }),
    ).toEqual([
      { role: "tool", text: "finding A" },
      { role: "user", text: "and my requirement" },
    ]);
    // tool_use inputs are already durable as tool_use event-log lines.
    expect(
      extractEvictedEntries({
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_2", name: "scan", input: { a: 1 } }],
      }),
    ).toEqual([]);
  });

  test("CONTINUITY_LEDGER_MAX_CHARS is 16KB", () => {
    expect(CONTINUITY_LEDGER_MAX_CHARS).toBe(16 * 1024);
  });
});

describe("continuity — cache-marker regression on the live request", () => {
  test("the volatile tail always sits AFTER the cache marker, and a plan edit never strips or moves it", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-marker-"));
    try {
      const planWrite = buildTool({
        name: "plan_write",
        description: "flips plan.dirty",
        inputSchema: z.object({}),
        execute: async (_input, ctx) => {
          const bridge = ctx?.bridge as { runState?: Store<Record<string, unknown>> } | undefined;
          bridge?.runState?.set({ [PLAN_DIRTY_STATE_KEY]: true });
          return "ok";
        },
      });
      const main = makeCapturingAdapter([
        [{ type: "tool_use", id: "tu_p", name: "plan_write", input: {} }],
        [{ type: "text", text: "done" }],
      ]);

      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        tools: [planWrite],
        permissionMode: "bypass",
        continuity: {
          loadPlan: async () => "PLAN V1",
          onPlanDirty: async () => "PLAN V2 — edited between calls",
        },
      });

      expect(main.callCount()).toBe(2);
      const markerIndexes: number[] = [];
      for (const req of main.requests()) {
        const blocks = req.system;
        const tailIndex = blocks.findIndex((b) => b.text.includes("<current_plan>"));
        const lastMarker = blocks.reduce(
          (acc, b, idx) => (b.cache_control != null ? idx : acc),
          -1,
        );
        // A marker exists, the tail exists, and every marked block precedes
        // the volatile tail.
        expect(lastMarker).toBeGreaterThanOrEqual(0);
        expect(tailIndex).toBeGreaterThan(lastMarker);
        for (const [idx, b] of blocks.entries()) {
          if (idx >= tailIndex) expect(b.cache_control == null).toBe(true);
        }
        markerIndexes.push(lastMarker);
        // The frozen prefix itself is untouched by tail edits.
        expect(blocks[lastMarker]?.cache_control).toEqual({ type: "ephemeral" });
      }
      // Editing the tail between calls did not move the marker.
      expect(new Set(markerIndexes).size).toBe(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("continuity — cache rotation bookkeeping (§2.5 dead-wiring fix)", () => {
  test("a boot rotation publishes cache_rotation and invokes onPromptCacheRotated with the timestamp to persist", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-rotation-"));
    try {
      const main = makeCapturingAdapter([[{ type: "text", text: "ok" }]]);
      const runContext = createRunContext();
      const events: TraceEvent[] = [];
      runContext.eventBus.subscribe((ev) => {
        events.push(ev);
      });
      const rotatedAts: number[] = [];

      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        runContext,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "bypass",
        // No promptCacheLastRotatedAt → stale → manage() rotates at boot.
        onPromptCacheRotated: (rotatedAt) => {
          rotatedAts.push(rotatedAt);
        },
      });

      const rotations = events.filter((ev) => ev.kind === "cache_rotation");
      expect(rotations.length).toBe(1);
      const rotation = rotations[0];
      if (rotation?.kind !== "cache_rotation") throw new Error("unreachable");
      expect(rotation.rotatedAt).toBeGreaterThan(0);
      expect(rotatedAts).toEqual([rotation.rotatedAt]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a FRESH promptCacheLastRotatedAt stops the boot-time force-rotation: no event, no callback", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-norotate-"));
    try {
      const main = makeCapturingAdapter([[{ type: "text", text: "ok" }]]);
      const runContext = createRunContext();
      const events: TraceEvent[] = [];
      runContext.eventBus.subscribe((ev) => {
        events.push(ev);
      });
      const rotatedAts: number[] = [];

      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        runContext,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "bypass",
        promptCacheLastRotatedAt: Date.now(),
        onPromptCacheRotated: (rotatedAt) => {
          rotatedAts.push(rotatedAt);
        },
      });

      expect(events.filter((ev) => ev.kind === "cache_rotation").length).toBe(0);
      expect(rotatedAts).toEqual([]);
      // The construction-time markers are untouched (no strip-and-remark).
      const blocks = main.requests()[0]?.system ?? [];
      expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("sub-agent bridge seams (v0.3.0 §7.1) — recall-only memory, read-only continuity", () => {
  test("the bridge projects opts.memory/continuity WITHOUT their write closures, and carries skills + failureTaxonomy", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-bridge-seams-"));
    try {
      const bridges: Array<Record<string, unknown>> = [];
      const probe = buildTool({
        name: "bridge_probe",
        description: "captures the runtime bridge",
        inputSchema: z.object({}),
        execute: async (_input, ctx) => {
          bridges.push({ ...(ctx?.bridge as Record<string, unknown>) });
          return "ok";
        },
      });
      const main = makeCapturingAdapter([
        [{ type: "tool_use", id: "tu_probe", name: "bridge_probe", input: {} }],
        [{ type: "text", text: "done" }],
      ]);
      const taxonomy = [{ class: "custom", pattern: "nope", recovery: "fail" as const }];

      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "probe" }],
        tools: [probe],
        permissionMode: "bypass",
        skills: [{ name: "sk", description: "a skill", filePath: join(rootDir, "SKILL.md") }],
        failureTaxonomy: taxonomy,
        memory: {
          autoRecall: false,
          recallK: 3,
          recall: async () => ["remembered line"],
          // The write half must NOT cross onto the bridge:
          autoCapture: true,
          onCapture: async () => {
            throw new Error("never reached from a child seam");
          },
        },
        continuity: {
          loadPlan: async () => "PLAN: seam test",
          // The write closures must NOT cross onto the bridge:
          onPlanDirty: async () => "PLAN: dirty",
          onHandoff: async () => {
            throw new Error("never reached from a child seam");
          },
        },
      });

      expect(bridges).toHaveLength(1);
      const bridge = bridges[0] as {
        memory?: Record<string, unknown>;
        continuity?: Record<string, unknown>;
        skills?: unknown[];
        failureTaxonomy?: unknown;
      };
      // memory: recall-only projection — capture closures are absent.
      expect(bridge.memory).toBeDefined();
      expect(Object.keys(bridge.memory ?? {}).sort()).toEqual(["autoRecall", "recall", "recallK"]);
      expect(bridge.memory?.["autoRecall"]).toBe(false);
      // continuity: read-only projection — ONLY loadPlan crosses.
      expect(bridge.continuity).toBeDefined();
      expect(Object.keys(bridge.continuity ?? {})).toEqual(["loadPlan"]);
      // skills + failureTaxonomy thread verbatim.
      expect(bridge.skills).toHaveLength(1);
      expect(bridge.failureTaxonomy).toEqual(taxonomy);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a run without the new options builds a bridge WITHOUT the seam fields (pre-0.3.0 shape)", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-bridge-noseams-"));
    try {
      const bridges: Array<Record<string, unknown>> = [];
      const probe = buildTool({
        name: "bridge_probe",
        description: "captures the runtime bridge",
        inputSchema: z.object({}),
        execute: async (_input, ctx) => {
          bridges.push({ ...(ctx?.bridge as Record<string, unknown>) });
          return "ok";
        },
      });
      const main = makeCapturingAdapter([
        [{ type: "tool_use", id: "tu_probe", name: "bridge_probe", input: {} }],
        [{ type: "text", text: "done" }],
      ]);
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: main.adapter,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "probe" }],
        tools: [probe],
        permissionMode: "bypass",
      });
      expect(bridges).toHaveLength(1);
      const bridge = bridges[0] as Record<string, unknown>;
      expect("memory" in bridge).toBe(false);
      expect("continuity" in bridge).toBe(false);
      expect("skills" in bridge).toBe(false);
      expect("failureTaxonomy" in bridge).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
