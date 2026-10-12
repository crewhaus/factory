/**
 * The real runner (C078), driven with `sh` rather than a scheduler, so it
 * asserts the same thing on every machine. `_setRunner(undefined)` restores
 * it; the suite's other files install their own fakes and restore it too.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAIN_GRACE_MS, MAX_OUTPUT_CHARS, _setRunner, runHost, unreadableReason } from "./run";

afterEach(() => _setRunner(undefined));

/**
 * Runs `body` with the command's deadline held: the first timer armed for
 * exactly `ms` milliseconds is never scheduled, and fires once a whole line
 * of the child's stdout has reached the runner (`Bun.spawn` is spied on to
 * see it). Every other timer runs as usual. So the deadline lands after the
 * child printed, on any runner; a real one raced the shell's start, and a
 * shell that took longer to start than the deadline was killed before its
 * first line. The timer's callback runs in a microtask, as it would from the
 * event loop. tool-proc's RunCommand test holds its deadline the same way.
 */
async function withDeadlineAfterFirstLine<T>(
  ms: number,
  body: () => Promise<T>,
): Promise<{ result: T; fired: boolean; problem?: string }> {
  const HELD = Symbol("held deadline") as unknown as ReturnType<typeof setTimeout>;
  const deadline: { callback?: () => void; cleared: boolean; fired: boolean; problem?: string } = {
    cleared: false,
    fired: false,
  };
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSpawn = Bun.spawn.bind(Bun);
  const held = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== ms || deadline.callback !== undefined) return realSetTimeout(fn, delay, ...rest);
    deadline.callback = () => fn(...rest);
    return HELD;
  }) as typeof setTimeout);
  const cleared = spyOn(globalThis, "clearTimeout").mockImplementation(((
    id?: ReturnType<typeof setTimeout>,
  ) => {
    if (id === HELD) deadline.cleared = true;
    else realClearTimeout(id);
  }) as typeof clearTimeout);
  const fire = (): void => {
    if (deadline.fired) return;
    deadline.fired = true;
    const callback = deadline.callback;
    if (callback === undefined || deadline.cleared) {
      deadline.problem = "the deadline was not armed while the child ran";
      return;
    }
    queueMicrotask(callback);
  };
  const spawned = spyOn(Bun, "spawn").mockImplementation(((
    ...args: Parameters<typeof Bun.spawn>
  ) => {
    const proc = realSpawn(...args);
    const source = proc.stdout;
    if (!(source instanceof ReadableStream)) return proc;
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const watched = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
        text += decoder.decode(next.value, { stream: true });
        if (text.includes("\n")) fire();
      },
      cancel: (reason) => reader.cancel(reason),
    });
    Object.defineProperty(proc, "stdout", { value: watched });
    return proc;
  }) as typeof Bun.spawn);
  try {
    const result = await body();
    return {
      result,
      fired: deadline.fired,
      ...(deadline.problem === undefined ? {} : { problem: deadline.problem }),
    };
  } finally {
    spawned.mockRestore();
    held.mockRestore();
    cleared.mockRestore();
  }
}

describe.skipIf(process.platform === "win32")("the real runner", () => {
  test("output a leftover process holds open is kept, and marked incomplete", async () => {
    _setRunner(undefined);
    // The leftover holds the pipe for a minute and is killed here once the
    // result is in, so it outlives the drain grace on any runner and is never
    // left behind. The deadline only ends a hang: at 5 s it raced the shell's
    // start plus the drain grace, and a slow start was killed at it.
    const dir = mkdtempSync(join(tmpdir(), "tool-cron-run-"));
    const leftover = join(dir, "leftover.pid");
    try {
      const r = await runHost({
        argv: ["sh", "-c", 'echo row; sleep 60 & echo $! > "$0"', leftover],
        timeoutMs: 15_000,
      });
      // 0.7.0: stdout "" and no flag, which every reader took for an empty listing.
      expect(r.stdout).toBe("row\n");
      expect(r.outputIncomplete).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(unreadableReason(r, "sh", 15_000)).toBe(
        `sh exited, but a process it started kept its output open past ${DRAIN_GRACE_MS}ms, so what came back may be incomplete`,
      );
    } finally {
      try {
        process.kill(Number(readFileSync(leftover, "utf8").trim()), "SIGKILL");
      } catch {
        // Never started, or already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a complete listing is complete, and a long one is a flagged prefix", async () => {
    _setRunner(undefined);
    const ok = await runHost({ argv: ["sh", "-c", "echo one; echo two"] });
    expect(ok).toMatchObject({ exitCode: 0, stdout: "one\ntwo\n", timedOut: false });
    expect(ok.outputIncomplete).toBeUndefined();
    expect(unreadableReason(ok, "sh", 5_000)).toBeUndefined();

    const big = await runHost({
      argv: ["sh", "-c", `head -c ${MAX_OUTPUT_CHARS * 4} /dev/zero | tr '\\0' x`],
    });
    expect(big.stdout.length).toBe(MAX_OUTPUT_CHARS);
    expect(big.stdoutTruncated).toBe(true);
    expect(unreadableReason(big, "sh", 5_000)).toContain("PREFIX");
  }, 20_000);

  test("a command killed at its deadline still returns what it printed", async () => {
    _setRunner(undefined);
    // The 1 s deadline fires once the line is out: a real one raced the
    // shell's start, and a runner a second slow to start it lost the line.
    // The shell starts its `sleep` before it prints, so a kill that reached
    // only the shell leaves the pipe held open at the deadline.
    const {
      result: r,
      fired,
      problem,
    } = await withDeadlineAfterFirstLine(1_000, () =>
      runHost({ argv: ["sh", "-c", "sleep 5 & echo partial; wait"], timeoutMs: 1_000 }),
    );
    expect({ fired, problem }).toEqual({ fired: true, problem: undefined });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("partial\n");
    expect(unreadableReason(r, "sh", 1_000)).toContain("did not finish");
  }, 20_000);
});
