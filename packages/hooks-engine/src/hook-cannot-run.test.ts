/**
 * A hook that cannot be started counts as a deny, settles on its own and keeps
 * its slot, so every other hook in the same firing keeps its decision; and the
 * gating/observational classification the runtime fails closed on.
 *
 * The spawn that cannot start is a `Bun.spawn` spy throwing for one marker
 * command and delegating every other call to the real spawn.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  HOOK_EVENTS,
  type HookDef,
  type HookEvent,
  OBSERVATIONAL_HOOK_EVENTS,
  aggregateDecisions,
  isGatingHookEvent,
  runHooks,
} from "./index";

const MARKER = "exit 0 # cannot-start";
const realSpawn = Bun.spawn.bind(Bun);
let spawnSpy: ReturnType<typeof spyOn> | undefined;
let throws = 0;

/** Spawn throws EMFILE for the marker command; every other call is the real spawn. */
function spawnFailsForMarker(): void {
  throws = 0;
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const first = args[0];
    if (Array.isArray(first) && first[2] === MARKER) {
      throws += 1;
      throw Object.assign(new Error("spawn failed"), { code: "EMFILE" });
    }
    return (realSpawn as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof Bun.spawn);
}

afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
});

const printf = (decision: "allow" | "deny", reason?: string) =>
  `printf '${JSON.stringify({ decision, ...(reason !== undefined ? { reason } : {}) })}\\n'`;

/** The `envelope()`/`publish()` surface `runHooks` uses, recording every event. */
function makeBusStub(): { bus: TraceEventBus; published: Array<Record<string, unknown>> } {
  const published: Array<Record<string, unknown>> = [];
  let span = 0;
  const bus = {
    envelope() {
      span += 1;
      return {
        runId: "run_cannot_run",
        sessionId: "sess_cannot_run",
        turnNumber: 1,
        traceId: "0".repeat(32),
        spanId: `${span}`.padStart(16, "0"),
        timestamp: "2026-11-15T00:00:00.000Z",
      };
    },
    publish(event: Record<string, unknown>) {
      published.push(event);
    },
  } as unknown as TraceEventBus;
  return { bus, published };
}

describe("a hook that cannot be started", () => {
  test("settles as a deny with the reason `hook could not run`, carrying its hook", async () => {
    spawnFailsForMarker();
    const results = await runHooks("pre-tool", { name: "Bash" }, [
      { event: "pre-tool", command: MARKER },
    ]);
    expect(throws).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.hook.command).toBe(MARKER);
    expect(results[0]?.decision).toEqual({ decision: "deny", reason: "hook could not run" });
    expect(aggregateDecisions(results)).toEqual({ allowed: false, reason: "hook could not run" });
  });

  test("keeps every other hook's decision in input order", async () => {
    spawnFailsForMarker();
    const hooks: HookDef[] = [
      { event: "pre-tool", command: printf("allow") },
      { event: "pre-tool", command: printf("deny", "policy says no") },
      { event: "pre-tool", command: MARKER },
    ];
    const results = await runHooks("pre-tool", { name: "Bash" }, hooks);
    expect(throws).toBe(1);
    expect(results.map((r) => r.hook.command)).toEqual(hooks.map((h) => h.command));
    expect(results.map((r) => r.decision.decision)).toEqual(["allow", "deny", "deny"]);
    expect(results[1]?.decision.reason).toBe("policy says no");
    expect(results[2]?.decision.reason).toBe("hook could not run");
    expect(aggregateDecisions(results)).toEqual({ allowed: false, reason: "policy says no" });
  });

  test("publishes one hook_fired that is not allowed, with the reason", async () => {
    spawnFailsForMarker();
    const { bus, published } = makeBusStub();
    await runHooks("pre-tool", { name: "Bash" }, [{ event: "pre-tool", command: MARKER }], {
      eventBus: bus,
    });
    expect(throws).toBe(1);
    const fired = published.filter((e) => e["kind"] === "hook_fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.["event"]).toBe("pre-tool");
    expect(fired[0]?.["allowed"]).toBe(false);
    expect(fired[0]?.["reason"]).toBe("hook could not run");
  });

  test("is logged with its command and the error", async () => {
    spawnFailsForMarker();
    const warned: Array<[string, unknown]> = [];
    const logger = {
      warn: (msg: string, data?: unknown) => {
        warned.push([msg, data]);
      },
    } as unknown as NonNullable<Parameters<typeof runHooks>[3]>["logger"];
    await runHooks("pre-tool", { name: "Bash" }, [{ event: "pre-tool", command: MARKER }], {
      ...(logger !== undefined ? { logger } : {}),
    });
    expect(throws).toBe(1);
    expect(warned).toEqual([["hook could not run", { command: MARKER, error: "spawn failed" }]]);
  });
});

describe("a hook that fails after it was started", () => {
  test("is a deny and its child is killed", async () => {
    let kills = 0;
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      ((): ReturnType<typeof Bun.spawn> =>
        ({
          stdin: {
            write: () => {
              throw new Error("stdin closed");
            },
            end: () => {},
          },
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: new Promise<number>(() => {}),
          kill: () => {
            kills += 1;
          },
        }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn,
    );
    const results = await runHooks("pre-tool", { name: "Bash" }, [
      { event: "pre-tool", command: "cat" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toEqual({ decision: "deny", reason: "hook could not run" });
    expect(kills).toBe(1);
  });
});

describe("a hook's verdict is read from everything it wrote before it exited", () => {
  // The backgrounded `sleep` keeps the hook's stdout open past the hook's exit.
  test("a deny stands while the hook's output pipe stays open", async () => {
    const results = await runHooks("pre-tool", { name: "Bash" }, [
      { event: "pre-tool", command: `${printf("deny", "no")}; sleep 2 &` },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toEqual({ decision: "deny", reason: "no" });
    expect(aggregateDecisions(results).allowed).toBe(false);
  });

  test("a hook that wrote nothing still allows while its output pipe stays open", async () => {
    const results = await runHooks("pre-tool", { name: "Bash" }, [
      { event: "pre-tool", command: "sleep 2 &" },
    ]);
    expect(results.map((r) => r.decision)).toEqual([{ decision: "allow" }]);
  });
});

describe("isGatingHookEvent", () => {
  test("gates exactly pre-tool, pre-model and pre-slash among the known events", () => {
    expect(HOOK_EVENTS.filter((e) => isGatingHookEvent(e))).toEqual([
      "pre-tool",
      "pre-model",
      "pre-slash",
    ]);
  });

  test("every known event is gating or observational, never both", () => {
    for (const event of HOOK_EVENTS) {
      expect(isGatingHookEvent(event)).toBe(!OBSERVATIONAL_HOOK_EVENTS.has(event));
    }
    for (const event of OBSERVATIONAL_HOOK_EVENTS) {
      expect(HOOK_EVENTS as ReadonlyArray<string>).toContain(event);
    }
  });

  test("an event not listed as observational is gating", () => {
    expect(isGatingHookEvent("pre-something-new" as HookEvent)).toBe(true);
  });
});
