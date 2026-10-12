/**
 * WaitForOutput on a process that has finished, or been stopped, while a
 * process it started still holds its pipes.
 *
 * The wait ends on an exited process once the pipe it watches has ended,
 * since a process it started can still print the line there; a process that
 * holds only the OTHER pipe cannot. A STOPPED process is different:
 * ProcessStop signals the process alone, so a process it started (a script
 * running a server without `exec`) keeps the pipes for as long as it runs. A
 * wait on a stopped process ends at its next look once the stopped process's
 * own exit has been seen, and until then it watches a process that is still
 * running.
 *
 * No clock decides these answers. The wait's clock stands still, so only the
 * process can end it; the regex worker's give-up and each match's deadline
 * are held so a slow worker still answers; and the looks are counted. A wait
 * that does not end is stopped by a 10 s valve and fails on the counts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { REGEX_RUN_DEFAULTS } from "@crewhaus/tool-safety/regex";
import {
  __resetRegistryForTest,
  __stopAllForTest,
  processStart,
  processStop,
  waitForOutput,
} from "./index";
import { type BgProc, type WatchedStream, getProc, watchFinished } from "./registry";

/** WaitForOutput's longest match deadline (MATCH_BUDGET_MS in ./index). */
const MATCH_DEADLINE_MS = 2_000;

const state = { tmp: "", cwd: "" };

beforeEach(() => {
  state.cwd = process.cwd();
  state.tmp = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-proc-wait-")));
  process.chdir(state.tmp);
  __resetRegistryForTest();
});

afterEach(async () => {
  await __stopAllForTest();
  process.chdir(state.cwd);
  rmSync(state.tmp, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: RegisteredTool, input: unknown, ctx?: ToolExecuteContext): Promise<any> {
  const out = await tool.execute(input, ctx);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/**
 * Runs one wait with its clocks held (see the header): Date.now and this
 * thread's performance.now stand still, the worker's give-up is a minute,
 * and every timer armed for exactly a match deadline is held. It counts the
 * matches asked of the worker; `beforeMatch(run)` is called as each is sent.
 * After 10 s a valve restores everything and aborts the signal it hands the
 * call, so a wait that does not end comes back "aborted" with
 * `valveFired: true`. Every spy is restored before this returns.
 */
async function withWaitClocksHeld<T>(
  body: (signal: AbortSignal) => Promise<T>,
  beforeMatch?: (run: number) => void,
): Promise<{ result: T; runs: number; held: number; valveFired: boolean }> {
  const counted = { runs: 0, held: 0, valveFired: false };
  const defaults = REGEX_RUN_DEFAULTS as { giveUpMs: number };
  const giveUpMs = defaults.giveUpMs;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const RealWorker = globalThis.Worker;
  const heldTimers = new Map<object, () => void>();
  const valveState = { released: false, restored: false };
  class CountingWorker extends RealWorker {
    override postMessage(
      message: unknown,
      transfer?: Bun.StructuredSerializeOptions | Bun.Transferable[],
    ): void {
      if ((message as { op?: unknown } | null)?.op === "matchAll") {
        counted.runs += 1;
        beforeMatch?.(counted.runs);
      }
      super.postMessage(message, transfer as Bun.StructuredSerializeOptions);
    }
  }
  const frozen = Date.now();
  const still = performance.now();
  const clock = spyOn(Date, "now").mockImplementation(() => frozen);
  const thread = spyOn(performance, "now").mockImplementation(() => still);
  const armed = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (!valveState.released && delay === MATCH_DEADLINE_MS) {
      counted.held += 1;
      const token = {};
      heldTimers.set(token, () => fn(...rest));
      return token as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn, delay, ...rest);
  }) as typeof setTimeout);
  const cleared = spyOn(globalThis, "clearTimeout").mockImplementation(((
    id?: ReturnType<typeof setTimeout>,
  ) => {
    const token = id as unknown as object;
    if (heldTimers.has(token)) heldTimers.delete(token);
    else realClearTimeout(id);
  }) as typeof clearTimeout);
  (globalThis as { Worker: unknown }).Worker = CountingWorker;
  defaults.giveUpMs = 60_000;
  const restore = (): void => {
    if (valveState.restored) return;
    valveState.restored = true;
    defaults.giveUpMs = giveUpMs;
    (globalThis as { Worker: unknown }).Worker = RealWorker;
    cleared.mockRestore();
    armed.mockRestore();
    thread.mockRestore();
    clock.mockRestore();
  };
  const stop = new AbortController();
  const valve = realSetTimeout(() => {
    counted.valveFired = true;
    valveState.released = true;
    restore();
    for (const fire of heldTimers.values()) queueMicrotask(fire);
    heldTimers.clear();
    stop.abort();
  }, 10_000);
  try {
    const result = await body(stop.signal);
    return { result, ...counted };
  } finally {
    realClearTimeout(valve);
    restore();
  }
}

/** Shell text that loops until `file` exists (or the workspace is gone). */
function until(file: string): string {
  return `while [ ! -f "${file}" ] && [ -d "${state.tmp}" ]; do sleep 0.01; done`;
}

/**
 * A shell whose subshell keeps the pipes until `gate` exists (or the
 * workspace is gone); `redirect` points one of the subshell's streams
 * elsewhere, so it keeps only the other pipe.
 */
function shellWithSubshell(gate: string, after: string, redirect = ""): string[] {
  return ["sh", "-c", `( ${until(gate)} ) ${redirect} & echo started${after}`];
}

/** Yields to the event loop until `ready()` holds; the test's budget bounds it. */
async function settle(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((r) => setImmediate(r));
}

// `sh` and a subshell holding the pipes: macOS and Linux.
const testPosix = test.skipIf(process.platform === "win32");

describe("WaitForOutput on a finished process whose child holds its pipes", () => {
  testPosix(
    "a stopped process ends the wait at its next look, not at the deadline",
    async () => {
      const gate = join(state.tmp, "let-go");
      const started = await call(processStart, { argv: shellWithSubshell(gate, "; wait") });
      const bg = getProc(started.id);
      if (bg === undefined) throw new Error(`${started.id} is not registered`);
      try {
        // `&` has forked the subshell before `echo started` runs.
        await settle(() => bg.stdout.includes("started"));
        const stopped = await call(processStop, { id: started.id, signal: "SIGKILL" });
        expect({ stopped: stopped.stopped, status: stopped.status }).toEqual({
          stopped: true,
          status: "killed",
        });
        // The shell is gone; the subshell it started still holds both pipes.
        expect(bg.outputEnded).toBe(false);
        const { result, runs, held, valveFired } = await withWaitClocksHeld((signal) =>
          call(
            waitForOutput,
            { id: started.id, pattern: "never printed", timeoutMs: 600_000 },
            { signal },
          ),
        );
        expect({ matched: result.matched, reason: result.reason, status: result.status }).toEqual({
          matched: false,
          reason: "process finished without matching",
          status: "killed",
        });
        // One look, at the stopped process, and no more.
        expect({ runs, held, valveFired }).toEqual({ runs: 1, held: 1, valveFired: false });
        expect(bg.outputEnded).toBe(false);
      } finally {
        writeFileSync(gate, "");
      }
    },
    20_000,
  );

  testPosix(
    "an exited process is watched until its pipes end, then the wait ends without a match",
    async () => {
      const gate = join(state.tmp, "let-go");
      const started = await call(processStart, { argv: shellWithSubshell(gate, "") });
      const bg = getProc(started.id);
      if (bg === undefined) throw new Error(`${started.id} is not registered`);
      try {
        await bg.proc.exited;
        expect({ status: bg.status, outputEnded: bg.outputEnded }).toEqual({
          status: "exited",
          outputEnded: false,
        });
        // The subshell is let go as the second look is sent: that look and the
        // first were taken while it held the pipes, so the wait looks again.
        const { result, runs, valveFired } = await withWaitClocksHeld(
          (signal) =>
            call(
              waitForOutput,
              { id: started.id, pattern: "never printed", timeoutMs: 600_000, intervalMs: 10 },
              { signal },
            ),
          (run) => {
            if (run === 2) writeFileSync(gate, "");
          },
        );
        expect({ matched: result.matched, reason: result.reason, status: result.status }).toEqual({
          matched: false,
          reason: "process finished without matching",
          status: "exited",
        });
        expect(runs).toBeGreaterThanOrEqual(3);
        expect({ valveFired, outputEnded: bg.outputEnded }).toEqual({
          valveFired: false,
          outputEnded: true,
        });
      } finally {
        writeFileSync(gate, "");
      }
    },
    20_000,
  );
});

/** Each pipe's own end flag. */
const ENDED = { stdout: "stdoutEnded", stderr: "stderrEnded" } as const;

// The subshell sends one stream elsewhere and keeps only the other pipe.
for (const [held, ended, redirect] of [
  ["stderr", "stdout", ">/dev/null"],
  ["stdout", "stderr", "2>/dev/null"],
] as const) {
  describe(`WaitForOutput on an exited process whose child holds only ${held}`, () => {
    testPosix(
      `a wait on ${ended}, which has ended, ends at its first look`,
      async () => {
        const gate = join(state.tmp, "let-go");
        const started = await call(processStart, { argv: shellWithSubshell(gate, "", redirect) });
        const bg = getProc(started.id);
        if (bg === undefined) throw new Error(`${started.id} is not registered`);
        try {
          await bg.proc.exited;
          // The shell's end of the pipe closed as it exited; the subshell never
          // had one.
          await settle(() => bg[ENDED[ended]]);
          const { result, runs, valveFired } = await withWaitClocksHeld((signal) =>
            call(
              waitForOutput,
              { id: started.id, pattern: "never printed", stream: ended, timeoutMs: 600_000 },
              { signal },
            ),
          );
          expect({ matched: result.matched, reason: result.reason, status: result.status }).toEqual(
            {
              matched: false,
              reason: "process finished without matching",
              status: "exited",
            },
          );
          expect({ runs, valveFired }).toEqual({ runs: 1, valveFired: false });
          // The subshell still holds the other pipe, so the output as a whole
          // has not ended.
          expect({ held: bg[ENDED[held]], outputEnded: bg.outputEnded }).toEqual({
            held: false,
            outputEnded: false,
          });
        } finally {
          writeFileSync(gate, "");
        }
      },
      20_000,
    );

    testPosix(
      `a wait on ${held}, which the child holds, is watched until it ends`,
      async () => {
        const gate = join(state.tmp, "let-go");
        const started = await call(processStart, { argv: shellWithSubshell(gate, "", redirect) });
        const bg = getProc(started.id);
        if (bg === undefined) throw new Error(`${started.id} is not registered`);
        try {
          await bg.proc.exited;
          await settle(() => bg[ENDED[ended]]);
          // The subshell is let go as the second look is sent: that look and
          // the first were taken while it held the pipe, so the wait looks again.
          const { result, runs, valveFired } = await withWaitClocksHeld(
            (signal) =>
              call(
                waitForOutput,
                {
                  id: started.id,
                  pattern: "never printed",
                  stream: held,
                  timeoutMs: 600_000,
                  intervalMs: 10,
                },
                { signal },
              ),
            (run) => {
              if (run === 2) writeFileSync(gate, "");
            },
          );
          expect({ matched: result.matched, reason: result.reason, status: result.status }).toEqual(
            {
              matched: false,
              reason: "process finished without matching",
              status: "exited",
            },
          );
          expect(runs).toBeGreaterThanOrEqual(3);
          expect({ valveFired, held: bg[ENDED[held]] }).toEqual({ valveFired: false, held: true });
        } finally {
          writeFileSync(gate, "");
        }
      },
      20_000,
    );
  });
}

describe("WaitForOutput on a stopped process that is still running", () => {
  testPosix(
    "the wait watches it until it prints, rather than ending at the stop",
    async () => {
      // The shell ignores SIGTERM, so ProcessStop's signal leaves it running
      // through a grace period longer than the test. It prints `bye` once let,
      // and exits once let again.
      const printNow = join(state.tmp, "print-now");
      const exitNow = join(state.tmp, "exit-now");
      const started = await call(processStart, {
        argv: [
          "sh",
          "-c",
          `trap '' TERM; echo started; ${until(printNow)}; echo bye; ${until(exitNow)}`,
        ],
      });
      const bg = getProc(started.id);
      if (bg === undefined) throw new Error(`${started.id} is not registered`);
      await settle(() => bg.stdout.includes("started"));
      const stopping = call(processStop, {
        id: started.id,
        signal: "SIGTERM",
        killAfterMs: 60_000,
      });
      try {
        await settle(() => bg.status === "killed");
        expect(bg.exitCode).toBeNull();
        // `bye` is let out as the first look is sent, so that look misses it.
        const { result, runs, valveFired } = await withWaitClocksHeld(
          (signal) =>
            call(
              waitForOutput,
              { id: started.id, pattern: "bye", timeoutMs: 600_000, intervalMs: 10 },
              { signal },
            ),
          (run) => {
            if (run === 1) writeFileSync(printNow, "");
          },
        );
        expect({ matched: result.matched, match: result.match, status: result.status }).toEqual({
          matched: true,
          match: "bye",
          status: "killed",
        });
        expect(runs).toBeGreaterThanOrEqual(2);
        // It printed while still running: its exit has not been seen.
        expect({ valveFired, exitCode: bg.exitCode }).toEqual({
          valveFired: false,
          exitCode: null,
        });
      } finally {
        writeFileSync(printNow, "");
        writeFileSync(exitNow, "");
      }
      const stopped = await stopping;
      expect({
        stopped: stopped.stopped,
        escalated: stopped.escalatedToSigkill,
        status: stopped.status,
        exitCode: stopped.exitCode,
      }).toEqual({ stopped: true, escalated: false, status: "killed", exitCode: 0 });
    },
    20_000,
  );
});

describe("watchFinished against the predicate it replaced", () => {
  // Before: a stopped process had finished at once, an exited one once both
  // pipes had ended, whichever stream was watched.
  const before = (bg: Pick<BgProc, "status" | "outputEnded">): boolean =>
    bg.status === "killed" || (bg.status === "exited" && bg.outputEnded);

  test("they differ only where a one-stream watch's pipe has ended, and where a stopped process has not yet exited", () => {
    const changed: string[] = [];
    let cells = 0;
    for (const status of ["running", "exited", "killed"] as const) {
      // A running process has no exit seen; an exited one has.
      const exits = status === "running" ? [false] : status === "exited" ? [true] : [false, true];
      for (const exitSeen of exits) {
        for (const stdoutEnded of [false, true]) {
          for (const stderrEnded of [false, true]) {
            for (const stream of ["stdout", "stderr", "both"] as const satisfies WatchedStream[]) {
              cells += 1;
              const bg = {
                status,
                exitCode: exitSeen ? 0 : null,
                stdoutEnded,
                stderrEnded,
                outputEnded: stdoutEnded && stderrEnded,
              };
              const was = before(bg);
              const now = watchFinished(bg, stream);
              if (now !== was) {
                changed.push(
                  `${status} exit=${exitSeen} out=${stdoutEnded} err=${stderrEnded} ${stream}: ${was} -> ${now}`,
                );
              }
            }
          }
        }
      }
    }
    expect(cells).toBe(48);
    const unseenStop: string[] = [];
    for (const out of [false, true]) {
      for (const err of [false, true]) {
        for (const stream of ["stdout", "stderr", "both"]) {
          unseenStop.push(`killed exit=false out=${out} err=${err} ${stream}: true -> false`);
        }
      }
    }
    expect(changed).toEqual([
      "exited exit=true out=false err=true stderr: false -> true",
      "exited exit=true out=true err=false stdout: false -> true",
      ...unseenStop,
    ]);
  });
});
