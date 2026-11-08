import { describe, expect, test } from "bun:test";
/**
 * The inbound-content scope: run input a library classified and kept is
 * tagged into the run's FIRST context, and only that one.
 */
import type { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "@crewhaus/logging";
import { type InboundContent, createRunContext, withInboundContent } from "./index";
import { takePendingInbound } from "./scope";

const INPUT = "Summarise the attached quarterly report in three bullet points.";
const OTHER = "Draft a reply to the vendor about the delayed shipment.";

const entry = (content: string, extra: Partial<InboundContent> = {}): InboundContent => ({
  content,
  origin: "api",
  door: "runs.create",
  ...extra,
});

/** The ambient store, found by its registry symbol rather than through this module. */
function sharedStore(): AsyncLocalStorage<object> {
  const store = (globalThis as unknown as Record<symbol, AsyncLocalStorage<object> | undefined>)[
    Symbol.for("@crewhaus/run-context/ambient")
  ];
  if (store === undefined) throw new Error("no ambient store on globalThis");
  return store;
}

/** Yield to the event loop a few times, as the code between a scope and its run does. */
async function hop(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("withInboundContent", () => {
  test("no scope: a context adopts nothing (no lineage, no event)", () => {
    const ctx = createRunContext();
    expect("dataLineage" in ctx).toBe(false);
    expect(ctx.eventBus.recent()).toEqual([]);
    expect(takePendingInbound()).toEqual([]);
  });

  test("the first context in a scope is tagged at the entry's origin; a second one is not", async () => {
    const [first, second] = await withInboundContent([entry(INPUT)], async () => {
      await hop();
      const a = createRunContext();
      await hop();
      return [a, createRunContext()] as const;
    });
    expect(first.dataLineage?.get(INPUT)).toBe("api");
    expect(second.dataLineage).toBeUndefined();
    // A clean entry publishes nothing.
    expect(first.eventBus.recent()).toEqual([]);
  });

  test("nested scopes tag their own first context; the outer one still tags its own", async () => {
    const result = await withInboundContent([entry(INPUT)], async () => {
      const inner = await withInboundContent([entry(OTHER, { door: "queue" })], async () => {
        await hop();
        return createRunContext();
      });
      await hop();
      const outer = createRunContext();
      return { inner, outer };
    });
    expect(result.inner.dataLineage?.get(OTHER)).toBe("api");
    expect(result.inner.dataLineage?.has(INPUT)).toBe(false);
    expect(result.outer.dataLineage?.get(INPUT)).toBe("api");
    expect(result.outer.dataLineage?.has(OTHER)).toBe(false);
  });

  test("two interleaved scopes never tag each other's run", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const a = withInboundContent([entry(INPUT)], async () => {
      await gateA;
      return createRunContext();
    });
    const b = withInboundContent([entry(OTHER)], async () => {
      await hop();
      return createRunContext();
    });
    const ctxB = await b;
    releaseA();
    const ctxA = await a;
    expect(ctxA.dataLineage?.get(INPUT)).toBe("api");
    expect(ctxA.dataLineage?.has(OTHER)).toBe(false);
    expect(ctxB.dataLineage?.get(OTHER)).toBe("api");
    expect(ctxB.dataLineage?.has(INPUT)).toBe(false);
  });

  test("an entry kept with a warning publishes one warned event and logs one line, without the text", async () => {
    const lines: string[] = [];
    const logger = createLogger({ format: "json", sink: (line) => void lines.push(line) });
    const warned = entry(INPUT, {
      door: "runs.continue",
      warning: { rules: ["anthropic-tag-injection"], score: 0.42 },
    });
    const ctx = await withInboundContent([warned], async () => {
      await hop();
      return createRunContext({ logger });
    });
    expect(ctx.dataLineage?.get(INPUT)).toBe("api");
    const events = ctx.eventBus.recent();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "permission_decision",
      toolName: "runs.continue",
      decision: "allow",
      mode: "inbound",
      outcome: "warned",
      rules: ["anthropic-tag-injection"],
      reason: "input from origin api kept with a warning",
      runId: ctx.runId,
    });
    const warnings = lines.map((l) => JSON.parse(l)).filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      msg: "input kept with a warning",
      origin: "api",
      door: "runs.continue",
      rules: ["anthropic-tag-injection"],
      score: 0.42,
    });
    expect(JSON.stringify(events)).not.toContain(INPUT);
    expect(lines.join("\n")).not.toContain(INPUT);
  });

  test("the store lives on globalThis, so a second copy of the package sees the same scope", () => {
    const entries = [entry(INPUT)];
    // Read the way another copy of this module would: by the registry symbol.
    const seen = withInboundContent(entries, () => sharedStore().getStore());
    expect(seen).toEqual({ inbound: { entries, consumed: false } });
  });

  test("a scope keeps the store's other fields and replaces only the inbound slot", () => {
    withInboundContent([], () => undefined); // the store exists once a scope has run
    const shared = sharedStore();
    const entries = [entry(OTHER)];
    const seen = shared.run({ other: "kept" }, () =>
      withInboundContent(entries, () => shared.getStore()),
    );
    expect(seen).toEqual({ other: "kept", inbound: { entries, consumed: false } });
  });

  test("takePendingInbound hands the entries out once", () => {
    const entries = [entry(INPUT)];
    withInboundContent(entries, () => {
      expect(takePendingInbound()).toEqual(entries);
      expect(takePendingInbound()).toEqual([]);
    });
  });
});
