/**
 * Isolated coverage for the stream **drain-fallback** path in the Bash tool.
 *
 * On Linux, when the spawned `sh` forks a long-running grandchild and is
 * SIGKILLed, the orphan keeps the pipe's write-end open, so
 * `new Response(proc.stdout).text()` never EOFs. The tool guards against this
 * by racing each stream read against a fixed `DRAIN_GRACE_MS` fallback that
 * resolves to `""`. That fallback closure (`() => resolve("")`) cannot be
 * reached with a real, well-behaved subprocess — both pipes EOF immediately —
 * so we exercise it here with a fully mocked `Bun.spawn` whose streams never
 * close, plus a synchronous `setTimeout` so there is zero wall-clock delay and
 * no leaked timer handle.
 *
 * Everything (spawn + timers) is mocked and restored in `afterEach`, and this
 * lives in its own file so the stubs never leak into the real-subprocess
 * suites in `index.test.ts` / `integration.test.ts`.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { bash } from "./index";

/** A ReadableStream that emits one chunk and then NEVER closes — modelling the
 * orphaned-grandchild pipe that keeps the write-end alive. `Response.text()`
 * on this stream never resolves, forcing the drain fallback to win the race. */
function neverClosingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial-output-no-eof"));
      // Deliberately no controller.close() → the stream hangs open forever.
    },
  });
}

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("Bash tool — stream drain fallback (orphaned-pipe guard)", () => {
  test("falls back to empty streams when neither pipe EOFs before the grace window", async () => {
    const killMock = mock((_sig?: unknown) => {});
    // Fake proc: exits cleanly, but its stdout/stderr never close.
    spies.push(
      spyOn(Bun, "spawn").mockImplementation(
        ((): ReturnType<typeof Bun.spawn> =>
          ({
            stdout: neverClosingStream(),
            stderr: neverClosingStream(),
            exited: Promise.resolve(0),
            kill: killMock,
          }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn,
      ),
    );
    // Fire ONLY the short DRAIN_GRACE (500ms) fallback timers synchronously —
    // their `() => resolve("")` bodies are the target of this test. The long
    // command-timeout timer (30s default) must NOT fire, or the run would be
    // wrongly marked timed-out; for it we return an inert handle.
    spies.push(
      spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: (...a: unknown[]) => void,
        ms?: number,
      ) => {
        if (ms !== undefined && ms <= 500) fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout),
    );
    spies.push(
      spyOn(globalThis, "clearTimeout").mockImplementation(
        (() => {}) as unknown as typeof clearTimeout,
      ),
    );

    const out = await bash.execute({ command: "sleep 999" });

    // Both streams drained to "" via the fallback, so the formatted result is
    // just the exit line (no stdout/stderr sections) and the run is not marked
    // as timed out (the process `exited` resolved on its own).
    expect(out).toBe("[exit] 0");
    expect(out).not.toContain("partial-output-no-eof");
    expect(out).not.toContain("[stderr]");
    expect(out).not.toContain("timed out");
  });

  test("drain fallback still reports a non-zero exit code from a hung-pipe process", async () => {
    const killMock = mock((_sig?: unknown) => {});
    spies.push(
      spyOn(Bun, "spawn").mockImplementation(
        ((): ReturnType<typeof Bun.spawn> =>
          ({
            stdout: neverClosingStream(),
            stderr: neverClosingStream(),
            exited: Promise.resolve(42),
            kill: killMock,
          }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn,
      ),
    );
    // Same selective firing as the first test: only the short DRAIN_GRACE
    // (≤500ms) fallback timers run synchronously; the 30s command-timeout timer
    // must stay inert, otherwise the run would be wrongly flagged as timed out
    // and the exit line would read "[exit] 42 (timed out after 30000ms)".
    spies.push(
      spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: (...a: unknown[]) => void,
        ms?: number,
      ) => {
        if (ms !== undefined && ms <= 500) fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout),
    );
    spies.push(
      spyOn(globalThis, "clearTimeout").mockImplementation(
        (() => {}) as unknown as typeof clearTimeout,
      ),
    );

    const out = await bash.execute({ command: "exit 42" });
    expect(out).toBe("[exit] 42");
  });
});
