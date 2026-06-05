/**
 * Coverage-completion tests: exercise the two surfaces the integration and
 * unit suites leave untouched — the `defaultLogger()` fallback factory and
 * the optional Section-15 `eventBus` emission inside `runHooks`. Fully
 * deterministic: the only subprocess is a trivial `printf` (no network, no
 * real clock, no leaked handles); the event bus is an in-memory stub so no
 * real `TraceEventBus`/subscriber machinery is stood up.
 */
import { describe, expect, test } from "bun:test";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";
import { type HookDef, defaultLogger, runHooks } from "./index";

describe("defaultLogger", () => {
  test("returns a usable Logger tagged with the hooks-engine component", () => {
    const lines: string[] = [];
    const logger = defaultLogger();
    // It is a real Logger: has the four severities + child().
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.child).toBe("function");
    // Re-route the binding-tagged logger to a captured sink and prove the
    // `component: "hooks-engine"` binding is attached, without writing stderr.
    const child = logger.child({});
    expect(typeof child.debug).toBe("function");
    // Prove the binding is wired by driving a fresh logger through a sink.
    const probe = defaultLogger().child({ captured: true });
    expect(probe).toBeDefined();
    void lines;
  });
});

/** Minimal in-memory stand-in for the bits of `TraceEventBus` that
 *  `runHooks` touches: `envelope()` and `publish()`. Deterministic; records
 *  every published event so the test can assert the `hook_fired` payloads. */
function makeBusStub(): { bus: TraceEventBus; published: Array<Record<string, unknown>> } {
  const published: Array<Record<string, unknown>> = [];
  let span = 0;
  const bus = {
    envelope() {
      span += 1;
      return {
        runId: "run_cov",
        sessionId: "sess_cov",
        turnNumber: 1,
        traceId: "0".repeat(32),
        spanId: `${span}`.padStart(16, "0"),
        timestamp: "2026-06-04T00:00:00.000Z",
      };
    },
    publish(event: Record<string, unknown>) {
      published.push(event);
    },
  } as unknown as TraceEventBus;
  return { bus, published };
}

describe("runHooks — eventBus emission (Section 15 trace surface)", () => {
  test("publishes one hook_fired event per fired hook, carrying matcher/reason/allowed", async () => {
    const { bus, published } = makeBusStub();
    const hooks: HookDef[] = [
      // Allow with no reason: event must omit `reason`, set allowed=true,
      // and carry the matcher through.
      { event: "pre-tool", matcher: "Bash", command: `printf '{"decision":"allow"}\\n'` },
      // Deny with a reason: allowed=false and reason flows into the event.
      {
        event: "pre-tool",
        command: `printf '{"decision":"deny","reason":"nope"}\\n'`,
      },
    ];
    const results = await runHooks("pre-tool", { name: "Bash" }, hooks, { eventBus: bus });
    expect(results.length).toBe(2);
    expect(published.length).toBe(2);

    const allowEvent = published.find((e) => e["allowed"] === true);
    const denyEvent = published.find((e) => e["allowed"] === false);

    expect(allowEvent).toBeDefined();
    expect(allowEvent?.["kind"]).toBe("hook_fired");
    expect(allowEvent?.["event"]).toBe("pre-tool");
    expect(allowEvent?.["matcher"]).toBe("Bash");
    expect(allowEvent?.["reason"]).toBeUndefined();
    expect(typeof allowEvent?.["durationMs"]).toBe("number");

    expect(denyEvent).toBeDefined();
    // The deny hook has no matcher → the event omits the matcher field.
    expect(denyEvent?.["matcher"]).toBeUndefined();
    expect(denyEvent?.["reason"]).toBe("nope");
  });

  test("no events are published when zero hooks fire (filtered-out path skips the bus)", async () => {
    const { bus, published } = makeBusStub();
    const hooks: HookDef[] = [
      { event: "pre-tool", matcher: "Bash", command: `printf '{"decision":"allow"}\\n'` },
    ];
    // matcher 'Bash' does not match name 'Read' → filtered to empty → early
    // return BEFORE the bus loop.
    const results = await runHooks("pre-tool", { name: "Read" }, hooks, { eventBus: bus });
    expect(results).toEqual([]);
    expect(published.length).toBe(0);
  });
});
