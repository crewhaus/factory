/**
 * A judge call handed a spend meter reserves its worst case before it is sent,
 * settles on its usage, sends nothing when the meter refuses, and is counted at
 * its worst case when it fails after it was sent. Without a meter it behaves as
 * it always has.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { DEFAULT_PRICING } from "@crewhaus/cost-tracker";
import {
  type SpendAdmission,
  type SpendMeter,
  type SpendReserveMeta,
  createSpendMeter,
} from "@crewhaus/cost-tracker/spend";
import { JudgeError } from "./errors";
import { meteredJudgeCall } from "./judge";

const MODEL = "claude-sonnet-4-6";

/** A transport that answers one text turn, or throws after the stream started. */
function adapter(mode: "answer" | "break"): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic",
    features: { caching: false, tool_use: true, vision: false, thinking: false, web_search: false },
    estimateTokens: () => 0,
    stream(req) {
      requests.push(req);
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start", usage: { input: 100, output: 0 } };
        if (mode === "break") throw new Error("the stream broke");
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 100, output: 10 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

const REQUEST: ProviderRequest = {
  model: MODEL,
  system: [{ type: "text", text: "judge" }],
  messages: [{ role: "user", content: "grade this" }],
  maxTokens: 1_000,
};

/** A real meter wrapped to log what reaches it, in order. */
function logged(
  meter: SpendMeter,
  log: string[],
): SpendMeter & { metas: (SpendReserveMeta | undefined)[] } {
  const metas: (SpendReserveMeta | undefined)[] = [];
  return {
    ...meter,
    metas,
    reserve: async (id, estimate, meta) => {
      log.push(`reserve ${estimate}`);
      metas.push(meta);
      return meter.reserve(id, estimate, meta);
    },
    settle: async (id, usage, meta) => {
      log.push(`settle ${usage.input}/${usage.output}`);
      return meter.settle(id, usage, meta);
    },
    settleUnreported: async (id, meta) => {
      log.push("settleUnreported");
      return meter.settleUnreported(id, meta);
    },
    release: async (id) => {
      log.push("release");
      return meter.release(id);
    },
  };
}

describe("a judge call on a spend meter", () => {
  test("reserves before the request is sent and settles on its usage", async () => {
    const log: string[] = [];
    const transport = adapter("answer");
    const wrapped = {
      ...transport,
      stream: (req: ProviderRequest) => {
        log.push("sent");
        return transport.stream(req);
      },
    };
    const meter = createSpendMeter({ capMicros: 1_000_000, pricing: DEFAULT_PRICING });
    const spend = logged(meter, log);
    await meteredJudgeCall(wrapped, REQUEST, { specModel: MODEL, spend, role: "judge" });
    expect(log.map((l) => l.split(" ")[0])).toEqual(["reserve", "sent", "settle"]);
    expect(Number(log[0]?.split(" ")[1])).toBeGreaterThan(0);
    expect(log[2]).toBe("settle 100/10");
    expect(spend.metas).toEqual([{ role: "judge", model: MODEL }]);
    // 100 in at $3/M + 10 out at $15/M.
    expect(meter.snapshot()).toMatchObject({ spentMicros: 450, activeReservations: 0 });
  });

  test("a refusal sends nothing and names the budget that is used up", async () => {
    const transport = adapter("answer");
    const refusing = (scope: "period" | "run"): SpendMeter => ({
      ...createSpendMeter({ pricing: DEFAULT_PRICING }),
      reserve: async (): Promise<SpendAdmission> => ({ admit: false, on: "spent", scope }),
    });
    const period = meteredJudgeCall(transport, REQUEST, {
      specModel: MODEL,
      spend: refusing("period"),
    });
    await expect(period).rejects.toBeInstanceOf(JudgeError);
    await expect(period).rejects.toThrow("budget for this period is used up");
    await expect(
      meteredJudgeCall(transport, REQUEST, { specModel: MODEL, spend: refusing("run") }),
    ).rejects.toThrow("the run's budget is used up");
    expect(transport.requests).toHaveLength(0);
  });

  test("a stream that breaks after it started is counted at its worst case, never released", async () => {
    const log: string[] = [];
    const meter = createSpendMeter({ capMicros: 1_000_000, pricing: DEFAULT_PRICING });
    await expect(
      meteredJudgeCall(adapter("break"), REQUEST, { specModel: MODEL, spend: logged(meter, log) }),
    ).rejects.toThrow("the stream broke");
    expect(log.map((l) => l.split(" ")[0])).toEqual(["reserve", "settleUnreported"]);
    const reserved = Number(log[0]?.split(" ")[1]);
    expect(meter.snapshot()).toMatchObject({ spentMicros: reserved, activeReservations: 0 });
  });

  test("without a meter the call is made as before", async () => {
    const transport = adapter("answer");
    const { usage } = await meteredJudgeCall(transport, REQUEST, { specModel: MODEL });
    expect(transport.requests).toHaveLength(1);
    expect(usage.costUsdMicros).toBe(450);
  });
});
