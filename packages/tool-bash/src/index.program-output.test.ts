import { afterEach, describe, expect, test } from "bun:test";
import { createRunContext } from "@crewhaus/run-context";
import type { ProgramOutputEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { __resetBackgroundProcsForTest, bash } from "./index";

/**
 * Loop contract 0.4 (Batch C, G59) — the foreground Bash tool publishes one
 * `program_output` summary at command exit onto the run's TraceEventBus. The
 * event carries only byte counts + exit code + duration (never raw output),
 * so it is inherently size-capped.
 */

afterEach(() => {
  __resetBackgroundProcsForTest();
});

function captureBus(): { runContext: ReturnType<typeof createRunContext>; events: TraceEvent[] } {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    events.push(e);
  });
  return { runContext, events };
}

describe("bash program_output publication", () => {
  test("publishes one program_output summary via ctx.runContext at exit", async () => {
    const { runContext, events } = captureBus();
    await bash.execute({ command: "printf 'hello'; printf 'oops' 1>&2; exit 7" }, { runContext });

    const outs = events.filter((e): e is ProgramOutputEvent => e.kind === "program_output");
    expect(outs).toHaveLength(1);
    const ev = outs[0];
    expect(ev?.exitCode).toBe(7);
    expect(ev?.stdoutBytes).toBe(5); // "hello"
    expect(ev?.stderrBytes).toBe(4); // "oops"
    expect(typeof ev?.durationMs).toBe("number");
    expect(ev?.programId).toMatch(/^prog_/);
  });

  test("reaches the bus through ctx.bridge.runContext (production wiring)", async () => {
    const { runContext, events } = captureBus();
    await bash.execute({ command: "echo x" }, { bridge: { runContext } });
    expect(events.filter((e) => e.kind === "program_output")).toHaveLength(1);
  });

  test("a background spawn does not publish a program_output at start", async () => {
    const { runContext, events } = captureBus();
    await bash.execute({ command: "sleep 5", background: true }, { runContext });
    expect(events.filter((e) => e.kind === "program_output")).toHaveLength(0);
  });

  test("no run context ⇒ no throw", async () => {
    const result = await bash.execute({ command: "echo hi" });
    expect(typeof result).toBe("string");
  });
});
