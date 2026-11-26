/**
 * A judge call handed a spend meter reserves its worst case before it is sent,
 * settles on its usage, sends nothing when the meter refuses (a typed
 * refusal), stops waiting when its signal aborts, and is counted at its worst
 * case when it fails after it was sent or its stream ends without its counts.
 * A call that reached no provider is released; one the provider refused
 * outright counts $0. Without a meter it behaves as it always has.
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
import { JudgeBudgetError, JudgeError } from "./errors";
import { meteredJudgeCall } from "./judge";

const MODEL = "claude-sonnet-4-6";

/**
 * A transport that answers one text turn; or throws after the stream started
 * (`break`); or ends with content and no counts, as an abort ends a stream
 * silently (`silent`); or throws `before` with no event.
 */
function adapter(
  mode: "answer" | "break" | "silent",
  before?: unknown,
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic",
    features: { caching: false, tool_use: true, vision: false, thinking: false, web_search: false },
    estimateTokens: () => 0,
    stream(req) {
      requests.push(req);
      return (async function* (): AsyncIterable<StreamEvent> {
        if (before !== undefined) throw before;
        yield { kind: "message_start", usage: { input: 100, output: 0 } };
        if (mode === "break") throw new Error("the stream broke");
        if (mode === "silent") {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: "o" } };
          return;
        }
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
    await expect(period).rejects.toBeInstanceOf(JudgeBudgetError);
    await expect(period).rejects.toMatchObject({ budgetRefused: { scope: "period" } });
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

  test("a refusal says whether the call in progress or unfinished calls fill the budget", async () => {
    const transport = adapter("answer");
    const answering = (answer: SpendAdmission): SpendMeter => ({
      ...createSpendMeter({ pricing: DEFAULT_PRICING }),
      reserve: async () => answer,
    });
    const inFlight = meteredJudgeCall(transport, REQUEST, {
      specModel: MODEL,
      spend: answering({ admit: false, on: "spent", scope: "run", inFlight: true }),
    });
    await expect(inFlight).rejects.toMatchObject({
      budgetRefused: { scope: "run", inFlight: true },
    });
    await expect(inFlight).rejects.toThrow("used up counting the call still in progress");
    const held = meteredJudgeCall(transport, REQUEST, {
      specModel: MODEL,
      spend: answering({ admit: false, on: "spent", scope: "period", held: true }),
    });
    await expect(held).rejects.toMatchObject({ budgetRefused: { scope: "period", held: true } });
    await expect(held).rejects.toThrow("held by calls that never finished");
    expect(transport.requests).toHaveLength(0);
  });

  test("a wait for room ends when the signal aborts, and nothing is sent", async () => {
    const transport = adapter("answer");
    const meter = createSpendMeter({ capMicros: 1_000_000, pricing: DEFAULT_PRICING });
    // Another call holds the whole cap and never settles.
    expect(await meter.reserve("other", 1_000_000)).toEqual({ admit: true });
    const stop = new AbortController();
    const asked: string[] = [];
    const waiting = meteredJudgeCall(transport, REQUEST, {
      specModel: MODEL,
      spend: logged(meter, asked),
      signal: stop.signal,
    });
    // The judge is waiting on the other call: it asked once and was not admitted.
    while (asked.length === 0) await Promise.resolve();
    await Promise.resolve();
    stop.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.requests).toHaveLength(0);
    expect(meter.snapshot()).toMatchObject({ activeReservations: 1, spentMicros: 0 });
    // An already-stopped signal asks the meter nothing.
    const log: string[] = [];
    await expect(
      meteredJudgeCall(transport, REQUEST, {
        specModel: MODEL,
        spend: logged(meter, log),
        signal: stop.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(log).toEqual([]);
  });

  test("a stream that ends without its counts is counted at its worst case", async () => {
    const log: string[] = [];
    const meter = createSpendMeter({ capMicros: 1_000_000, pricing: DEFAULT_PRICING });
    await meteredJudgeCall(adapter("silent"), REQUEST, {
      specModel: MODEL,
      spend: logged(meter, log),
    });
    expect(log.map((l) => l.split(" ")[0])).toEqual(["reserve", "settleUnreported"]);
    expect(meter.snapshot().spentMicros).toBe(Number(log[0]?.split(" ")[1]));
  });

  test("a call that reached no provider is released; an outright refusal counts $0", async () => {
    const refused = Object.assign(new Error("Connection error."), {
      cause: Object.assign(new Error("refused"), { code: "ConnectionRefused" }),
    });
    const rateLimited = Object.assign(new Error("429"), { status: 429 });
    for (const [err, want] of [
      [refused, "release"],
      [rateLimited, "settle 0/0"],
    ] as const) {
      const log: string[] = [];
      const meter = createSpendMeter({ capMicros: 1_000_000, pricing: DEFAULT_PRICING });
      await expect(
        meteredJudgeCall(adapter("answer", err), REQUEST, {
          specModel: MODEL,
          spend: logged(meter, log),
        }),
      ).rejects.toBe(err);
      expect(log.slice(1)).toEqual([want]);
      expect(meter.snapshot()).toMatchObject({ spentMicros: 0, activeReservations: 0 });
    }
  });

  test("without a meter the call is made as before", async () => {
    const transport = adapter("answer");
    const { usage } = await meteredJudgeCall(transport, REQUEST, { specModel: MODEL });
    expect(transport.requests).toHaveLength(1);
    expect(usage.costUsdMicros).toBe(450);
  });
});
