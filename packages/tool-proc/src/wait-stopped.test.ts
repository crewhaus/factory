/**
 * WaitForOutput on a process that has finished while one it started still
 * holds its pipes.
 *
 * The wait ends on an exited process only once both pipes have ended, since
 * a process it started can still print the line. A STOPPED process is
 * different: ProcessStop signals the process alone, so a process it started
 * (a script running a server without `exec`) keeps the pipes for as long as
 * it runs. A wait on a stopped process ends at its next look, as it did before
 * the pipes counted.
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
import { getProc } from "./registry";

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

/** A shell whose subshell keeps the pipes until `gate` exists (or the workspace is gone). */
function shellWithSubshell(gate: string, after: string): string[] {
  return [
    "sh",
    "-c",
    `( while [ ! -f "${gate}" ] && [ -d "${state.tmp}" ]; do sleep 0.01; done ) & echo started${after}`,
  ];
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
        while (!bg.stdout.includes("started")) await new Promise((r) => setImmediate(r));
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
