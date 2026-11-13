import { describe, expect, test } from "bun:test";
/**
 * The inbound-content scope: run input a library classified and kept is
 * tagged into the run's FIRST context, and only that one.
 */
import type { AsyncLocalStorage } from "node:async_hooks";
import { mintId, mintRunId } from "@crewhaus/control-contract";
import { createLogger } from "@crewhaus/logging";
import {
  type InboundContent,
  adoptInbound,
  createRunContext,
  currentSubject,
  lineageOf,
  runWithScope,
  withInboundContent,
} from "./index";
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

describe("runWithScope", () => {
  const WI = mintId("wi");

  test("no scope: a context carries no lineage", () => {
    const ctx = createRunContext();
    for (const field of ["parent", "resumeScope", "continues", "workItem", "trigger"]) {
      expect(field in ctx).toBe(false);
    }
  });

  test("the scope fills every field the options leave unset, and the options win", async () => {
    const scope = {
      resumeScope: "job:job_00000001",
      trigger: { kind: "queue" as const },
      workItem: WI,
    };
    const [filled, overridden] = await runWithScope(scope, async () => {
      await hop();
      const a = createRunContext();
      const b = createRunContext({
        resumeScope: "lane:heartbeat",
        trigger: { kind: "heartbeat", lane: "heartbeat" },
      });
      return [a, b] as const;
    });
    expect(filled.resumeScope).toBe("job:job_00000001");
    expect(filled.trigger).toEqual({ kind: "queue" });
    expect(filled.workItem).toBe(WI);
    expect(overridden.resumeScope).toBe("lane:heartbeat");
    expect(overridden.trigger).toEqual({ kind: "heartbeat", lane: "heartbeat" });
    // A field the options leave unset still comes from the scope.
    expect(overridden.workItem).toBe(WI);
  });

  test("a nested scope inherits the outer fields and overrides only the ones it names", async () => {
    const ctx = await runWithScope({ resumeScope: "lane:schedule", workItem: WI }, () =>
      runWithScope({ trigger: { kind: "schedule", lane: "schedule" } }, async () => {
        await hop();
        return createRunContext();
      }),
    );
    expect(ctx.resumeScope).toBe("lane:schedule");
    expect(ctx.workItem).toBe(WI);
    expect(ctx.trigger).toEqual({ kind: "schedule", lane: "schedule" });
    // Outside the scope again: nothing.
    expect("resumeScope" in createRunContext()).toBe(false);
  });

  test("inside withInboundContent, the first context still adopts the run input", async () => {
    const ctx = await withInboundContent([entry(INPUT)], () =>
      runWithScope({ trigger: { kind: "queue" } }, async () => {
        await hop();
        return createRunContext();
      }),
    );
    expect(ctx.dataLineage?.get(INPUT)).toBe("api");
    expect(ctx.trigger).toEqual({ kind: "queue" });
  });

  test("around withInboundContent, the first context adopts the input and takes the scope", async () => {
    const [first, second] = await runWithScope({ resumeScope: "job:j1" }, () =>
      withInboundContent([entry(INPUT)], async () => {
        await hop();
        const a = createRunContext();
        return [a, createRunContext()] as const;
      }),
    );
    expect(first.dataLineage?.get(INPUT)).toBe("api");
    expect(first.resumeScope).toBe("job:j1");
    // The input went to the first context only; the scope reaches both.
    expect(second.dataLineage).toBeUndefined();
    expect(second.resumeScope).toBe("job:j1");
  });

  test("a nested runWithScope shares the outer inbound slot: the first context anywhere takes it", async () => {
    const [inner, outer] = await withInboundContent([entry(INPUT)], async () => {
      const a = await runWithScope({ trigger: { kind: "eval" } }, async () => {
        await hop();
        return createRunContext();
      });
      return [a, createRunContext()] as const;
    });
    expect(inner.dataLineage?.get(INPUT)).toBe("api");
    expect(outer.dataLineage).toBeUndefined();
  });

  test("continues reaches the first context in the scope and not the second", async () => {
    const PARKED = mintRunId();
    const [first, second, nested] = await runWithScope(
      { continues: PARKED, trigger: { kind: "resume" } },
      async () => {
        await hop();
        const a = createRunContext();
        const b = createRunContext();
        // A nested scope that names no `continues` shares the outer slot, already taken.
        const c = runWithScope({ resumeScope: "session:sess_0123456789abcdef" }, () =>
          createRunContext(),
        );
        return [a, b, c] as const;
      },
    );
    expect(first.continues).toBe(PARKED);
    expect("continues" in second).toBe(false);
    expect("continues" in nested).toBe(false);
    // The rest of the scope reaches every context.
    expect(second.trigger).toEqual({ kind: "resume" });
    expect(nested.trigger).toEqual({ kind: "resume" });
  });

  test("a nested scope that names its own continues gives it to its own first context", async () => {
    const OUTER = mintRunId();
    const INNER = mintRunId();
    const [inner, outer] = await runWithScope({ continues: OUTER }, async () => {
      const a = runWithScope({ continues: INNER }, () => createRunContext());
      return [a, createRunContext()] as const;
    });
    expect(inner.continues).toBe(INNER);
    expect(outer.continues).toBe(OUTER);
  });
});

describe("the subject a scope names", () => {
  const SUBJECT = "app:tenant-a:user-7";

  test("no scope: no subject", () => {
    expect(currentSubject()).toBeUndefined();
  });

  test("every caller in the scope reads it, at any depth of awaits, and reading takes nothing", async () => {
    const seen = await runWithScope({ subject: SUBJECT }, async () => {
      const first = currentSubject();
      await hop();
      return [first, currentSubject()];
    });
    expect(seen).toEqual([SUBJECT, SUBJECT]);
    expect(currentSubject()).toBeUndefined();
  });

  test("a nested scope keeps the outer subject unless it names its own", () => {
    const [kept, replaced] = runWithScope({ subject: SUBJECT }, () => [
      runWithScope({ resumeScope: "session:sess_0123456789abcdef" }, () => currentSubject()),
      runWithScope({ subject: "app:tenant-a:user-8" }, () => currentSubject()),
    ]);
    expect(kept).toBe(SUBJECT);
    expect(replaced).toBe("app:tenant-a:user-8");
  });

  test("no context, lineage or trace envelope carries it", () => {
    const ctx = runWithScope({ subject: SUBJECT, trigger: { kind: "api" } }, () =>
      createRunContext(),
    );
    expect(ctx.trigger).toEqual({ kind: "api" });
    expect(
      JSON.stringify(Object.entries(ctx).filter(([k]) => k !== "logger" && k !== "eventBus")),
    ).not.toContain("user-7");
    expect(JSON.stringify(lineageOf(ctx))).not.toContain("user-7");
    expect(JSON.stringify(ctx.eventBus.envelope())).not.toContain("user-7");
  });
});

describe("the origin chain of a context that adopts run input", () => {
  test("starts with the adopted origins, distinct and in order, after the one its options give", () => {
    const plain = withInboundContent([entry(INPUT), entry(OTHER)], () => createRunContext());
    expect(plain.originStack).toEqual(["api"]);
    const given = withInboundContent([entry(INPUT)], () =>
      createRunContext({ originStack: ["user"] }),
    );
    expect(given.originStack).toEqual(["user", "api"]);
    const mixed = withInboundContent(
      [
        entry(INPUT, { origin: "channel" }),
        entry(OTHER),
        entry("third input text here", { origin: "channel" }),
      ],
      () => createRunContext(),
    );
    expect(mixed.originStack).toEqual(["channel", "api"]);
  });

  test("a context that adopts nothing keeps the chain its options give, or none", () => {
    expect("originStack" in createRunContext()).toBe(false);
    expect(createRunContext({ originStack: ["subagent"] }).originStack).toEqual(["subagent"]);
    const second = withInboundContent([entry(INPUT)], () => {
      createRunContext();
      return createRunContext();
    });
    expect("originStack" in second).toBe(false);
  });

  test("adoptInbound tags a context it is handed and leaves its chain as it was", () => {
    const ctx = createRunContext({ originStack: ["user"] });
    adoptInbound(ctx, [entry(INPUT, { warning: { rules: ["r1"], score: 0.5 } })]);
    expect(ctx.dataLineage?.get(INPUT)).toBe("api");
    expect(ctx.originStack).toEqual(["user"]);
    const warned = ctx.eventBus.recent().filter((e) => e.kind === "permission_decision");
    expect(warned).toHaveLength(1);
  });
});
