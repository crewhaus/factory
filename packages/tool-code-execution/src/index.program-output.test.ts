import { afterEach, describe, expect, test } from "bun:test";
import { createRunContext } from "@crewhaus/run-context";
import type { Sandbox, SandboxExecOptions, SandboxExecResult } from "@crewhaus/sandbox";
import type { ProgramOutputEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { _resetCodeExecutionConfig, python, registerCodeExecutionConfig, shell } from "./index";

/**
 * Loop contract 0.4 (Batch C, G59) — the sandboxed program tools publish one
 * `program_output` summary at process exit onto the run's TraceEventBus. The
 * event carries only byte counts + exit code + duration (never raw output),
 * so it is inherently size-capped.
 */

class StubSandbox implements Sandbox {
  readonly backend = "noop" as const;
  result: Partial<SandboxExecResult> = {};
  constructor(opts: Partial<SandboxExecResult> = {}) {
    this.result = opts;
  }
  async exec(o: SandboxExecOptions): Promise<SandboxExecResult> {
    void o;
    return {
      stdout: this.result.stdout ?? "",
      stderr: this.result.stderr ?? "",
      exitCode: this.result.exitCode ?? 0,
      timedOut: this.result.timedOut ?? false,
      durationMs: this.result.durationMs ?? 1.0,
    };
  }
  async close(): Promise<void> {}
}

afterEach(() => {
  _resetCodeExecutionConfig();
});

function captureBus(): { runContext: ReturnType<typeof createRunContext>; events: TraceEvent[] } {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    events.push(e);
  });
  return { runContext, events };
}

describe("program_output publication", () => {
  test("publishes one program_output summary via ctx.runContext at exit", async () => {
    registerCodeExecutionConfig({
      sandbox: new StubSandbox({
        stdout: "hello\n",
        stderr: "oops",
        exitCode: 3,
        durationMs: 42.7,
      }),
    });
    const { runContext, events } = captureBus();
    await python.execute({ code: "print('hi')" }, { runContext });

    const outs = events.filter((e): e is ProgramOutputEvent => e.kind === "program_output");
    expect(outs).toHaveLength(1);
    const ev = outs[0];
    expect(ev?.exitCode).toBe(3);
    // "hello\n" is 6 bytes, "oops" is 4 bytes.
    expect(ev?.stdoutBytes).toBe(6);
    expect(ev?.stderrBytes).toBe(4);
    expect(ev?.durationMs).toBe(43);
    expect(typeof ev?.programId).toBe("string");
    expect(ev?.programId).toMatch(/^prog_/);
  });

  test("reaches the bus through ctx.bridge.runContext (production wiring)", async () => {
    registerCodeExecutionConfig({
      sandbox: new StubSandbox({ stdout: "x", stderr: "", exitCode: 0, durationMs: 5 }),
    });
    const { runContext, events } = captureBus();
    // Production threads the RunContext via the opaque bridge, not ctx.runContext.
    await shell.execute({ code: "echo x" }, { bridge: { runContext } });

    const outs = events.filter((e) => e.kind === "program_output");
    expect(outs).toHaveLength(1);
  });

  test("no run context ⇒ no publish, no throw", async () => {
    registerCodeExecutionConfig({
      sandbox: new StubSandbox({ stdout: "x", exitCode: 0 }),
    });
    const result = await python.execute({ code: "print(1)" });
    expect(typeof result).toBe("string");
  });

  test("byte counts are UTF-8, not char length (size-capped summary)", async () => {
    // "é" is 2 UTF-8 bytes; a naive .length would report 1.
    registerCodeExecutionConfig({
      sandbox: new StubSandbox({ stdout: "é", stderr: "", exitCode: 0, durationMs: 1 }),
    });
    const { runContext, events } = captureBus();
    await python.execute({ code: "print('é')" }, { runContext });
    const ev = events.find((e): e is ProgramOutputEvent => e.kind === "program_output");
    expect(ev?.stdoutBytes).toBe(2);
  });
});
