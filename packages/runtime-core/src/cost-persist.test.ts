/**
 * Section 27 — cost_accrual persistence into the session JSONL.
 *
 * When CREWHAUS_COST_TRACKING is on, the runtime mirrors each per-call
 * cost_accrual the trace bus carries into the session event-log so
 * `crewhaus cost-summary --session <id>` can sum spend after the run. These
 * tests drive the real `runChatLoop` (stub adapter) and assert the JSONL
 * envelope shape and the env-gating.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { createRunContext } from "@crewhaus/run-context";
import type { ProviderId } from "@crewhaus/trace-event-bus";
import { runChatLoop } from "./index";

/** Single text-only turn: 100 input tokens, 10 output tokens. */
function makeTextAdapter(providerId: ProviderId): ProviderAdapter {
  return {
    providerId,
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: () =>
      (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: 100, output: 10 },
        } as const;
        yield { kind: "message_stop" } as const;
      })(),
  };
}

let sessionRoot: string;
const savedTracking = process.env["CREWHAUS_COST_TRACKING"];

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "crewhaus-cost-persist-"));
});
afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
  process.env["CREWHAUS_COST_TRACKING"] = savedTracking;
});

async function runOnce(): Promise<void> {
  await runChatLoop({
    model: "claude-sonnet-4-6",
    instructions: "test",
    _adapter: makeTextAdapter("anthropic"),
    runContext: createRunContext(),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "hello" }],
    sessionRootDir: sessionRoot,
  });
}

type AccrualLine = {
  kind: string;
  payload?: { provider?: string; modelId?: string; costUsdMicros?: number };
};

function readCostAccruals(): AccrualLine[] {
  const accruals: AccrualLine[] = [];
  for (const file of readdirSync(sessionRoot).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(sessionRoot, file), "utf-8").split("\n")) {
      if (line === "") continue;
      const ev = JSON.parse(line) as AccrualLine;
      if (ev.kind === "cost_accrual") accruals.push(ev);
    }
  }
  return accruals;
}

describe("cost_accrual persistence into the session JSONL (Section 27)", () => {
  test("persists a per-call cost_accrual (envelope shape) when CREWHAUS_COST_TRACKING=1", async () => {
    process.env["CREWHAUS_COST_TRACKING"] = "1";
    await runOnce();
    const accruals = readCostAccruals();
    expect(accruals.length).toBe(1);
    // event-log wraps the event; cost fields live under `payload`.
    expect(accruals[0]?.payload?.provider).toBe("anthropic");
    expect(accruals[0]?.payload?.modelId).toBe("claude-sonnet-4-6");
    // claude-sonnet-4 row: 100 in × $3/M + 10 out × $15/M = 450 micros.
    expect(accruals[0]?.payload?.costUsdMicros).toBe(450);
  });

  test("writes no cost_accrual line when cost tracking is disabled", async () => {
    process.env["CREWHAUS_COST_TRACKING"] = undefined;
    await runOnce();
    expect(readCostAccruals().length).toBe(0);
  });
});
