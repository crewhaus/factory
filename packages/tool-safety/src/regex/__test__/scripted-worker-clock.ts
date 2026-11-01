import { REGEX_WORKER_SOURCE } from "../worker-source";

/**
 * The scripted clock goes in after the worker's own settings, so the source
 * still starts as the shipped one does, and a fault-injection preload that
 * patches the worker by its first line patches this one too.
 */
const AFTER = "var progressEveryMs = 10;\n";

/**
 * What {@link scriptWorkerClock} replaced, and how to let its threads go.
 * A const object, not a module `let`.
 */
const installed: {
  worker: typeof Worker | undefined;
  url: string | undefined;
  release: (() => void) | undefined;
} = { worker: undefined, url: undefined, release: undefined };

/**
 * The gate's slots: shared memory, so a terminated thread's counts are still
 * read exactly. `PAUSE` is 1 while holds stop before their wait
 * ({@link ScriptedWorkerOptions.pauseHolds}).
 */
const OPEN = 0;
const EXECS = 1;
const PAUSE = 2;
const HELD_RETURNS = 3;
const SLOTS = 4;

/** How the scripted worker runs its holds. */
export type ScriptedWorkerOptions = {
  /**
   * Stop each thread that announces a hold before its wait begins, until
   * {@link ScriptedWorker.resume}: the window a thread descheduled right
   * after it posted the announcement sits in, held open so that a test can
   * put a `terminate()` there on purpose.
   */
  readonly pauseHolds?: boolean;
};

/** What a test can wait for, count and release on the scripted worker. */
export type ScriptedWorker = {
  /**
   * Resolves with the input once a worker is inside an `exec` over one of
   * the `hangs` or `holds`. A worker's messages arrive in order, so by then
   * every progress report it sent before that exec has been taken in.
   */
  readonly hung: Promise<string>;
  /**
   * How many times the scripted workers have called `exec` (a `test` is one
   * call), over any input, counted as they enter it. Read from memory the
   * workers share with this thread, so it is exact at any moment, also for
   * a thread that was terminated.
   */
  execs(): number;
  /**
   * How many `exec` calls over one of the `holds` have returned, counted as
   * they return, in the memory {@link ScriptedWorker.execs} reads. One whose
   * thread was terminated while it was held never returns: released, the
   * thread stops at the held wait.
   */
  heldReturns(): number;
  /**
   * Let every thread stopped before a hold's wait (`pauseHolds`) go on into
   * the wait, now and from now on; it is still held until
   * {@link ScriptedWorker.release}. Without `pauseHolds` there is nothing to
   * resume.
   */
  resume(): void;
  /**
   * Let every `exec` waiting on a hang or a hold go on, now and from now on:
   * a thread that was not terminated returns the engine's real answer, and
   * one whose `terminate()` a hold put off is terminated first and let go
   * second, so it stops at the held wait, inside that `exec`, and starts no
   * other. Also done by {@link restoreWorkerClock}, so no test leaves a
   * thread held.
   */
  release(): void;
};

/**
 * Run the real regex worker with its clock scripted.
 *
 * The worker reports a failing `exec` that took `giveUpMs` or longer as the
 * engine giving up, never as "no match". A test that wants a give-up from a
 * real slow input races the machine: one preemption of the worker thread
 * inside a quick no-match turns it into a give-up, and an engine a few times
 * faster turns the slow one into a definite "no". Here the worker's
 * `performance.now()` reads a clock that only `costs` move: every `exec` (and
 * so every `test`) over a string listed there advances it by that many
 * milliseconds, and nothing else moves it, so every other input takes 0 ms.
 * The engine still answers every match; only the time is scripted, so the
 * verdict is the same on any machine and under any stall.
 *
 * An `exec` over a string in `hangs` does not return until
 * {@link ScriptedWorker.release}: it is how a test holds a run past its
 * deadline without a real slow input, which an engine fast enough would
 * finish first. The thread waits rather than spins, and `terminate()` ends
 * it within one 10 ms wait (an untimed `Atomics.wait` outlives `terminate()`
 * in Bun 1.3.14, so the wait is timed and repeated).
 *
 * An `exec` over a string in `holds` waits untimed, and its thread outlives
 * `terminate()` until the test releases it, as one terminated inside a slow
 * real match runs on until the match returns. That holds by construction:
 * the thread marks the hold, in memory it shares with this thread, before it
 * announces it, and from then on its worker's `terminate()` is put off, not
 * passed on. The untimed wait alone did not do it: a `terminate()` that
 * landed after the announcement and before the wait began (the thread
 * descheduled right after it posted) was honoured at the wait loop's header,
 * and the thread exited. Released, the put-off `terminate()` goes first and
 * the gate opens second, so the thread wakes with its termination already
 * pending and meets it at the held wait. Unlike a real slow match, the held
 * `exec` never returns: the thread computes no answer and starts no other
 * `exec`, which `heldReturns()` and `execs()` show. (Opened first, the gate
 * could let the thread return from the held `exec`, and run the next
 * inputs, before the termination landed.) Any other `terminate()` (a
 * hang's, a worker's whose thread is not inside a held exec, or one after
 * the release) is passed on at once. That is how a test keeps an abandoned
 * thread a runaway for exactly as long as it needs, on any engine.
 *
 * All three lists are matched literally, `$` included. The rest of the
 * worker is the shipped source, unchanged. It is installed by replacing
 * `globalThis.Worker` for the workers started until
 * {@link restoreWorkerClock}. The caller's file wires that to `afterEach`,
 * so a test abandoned at its budget never leaves it in place, or a thread
 * held.
 */
export function scriptWorkerClock(
  costs: Readonly<Record<string, number>>,
  hangs: ReadonlyArray<string> = [],
  holds: ReadonlyArray<string> = [],
  { pauseHolds = false }: ScriptedWorkerOptions = {},
): ScriptedWorker {
  restoreWorkerClock();
  if (!REGEX_WORKER_SOURCE.includes(AFTER)) {
    throw new Error("the regex worker source changed: no place to script its clock");
  }
  const prelude = [
    `var scriptedCosts = new Map(${JSON.stringify(Object.entries(costs))});`,
    `var scriptedHangs = new Set(${JSON.stringify(hangs)});`,
    `var scriptedHolds = new Set(${JSON.stringify(holds)});`,
    "var scriptedNow = 0;",
    // Replaced by the test's gate and this worker's hold mark, which the
    // worker is sent before anything else; the message never reaches the
    // worker's own onmessage.
    `var scriptedGate = new Int32Array(new SharedArrayBuffer(${SLOTS * 4}));`,
    "var scriptedHolding = new Int32Array(new SharedArrayBuffer(4));",
    'addEventListener("message", function (ev) {',
    "  var data = ev.data;",
    '  if (data !== null && typeof data === "object" && data.kind === "scripted-gate") {',
    "    scriptedGate = data.gate;",
    "    scriptedHolding = data.holding;",
    "    ev.stopImmediatePropagation();",
    "  }",
    "});",
    "performance.now = function () { return scriptedNow; };",
    "var nativeExec = RegExp.prototype.exec;",
    "RegExp.prototype.exec = function (s) {",
    `  Atomics.add(scriptedGate, ${EXECS}, 1);`,
    "  var held = scriptedHolds.has(s);",
    "  if (held || scriptedHangs.has(s)) {",
    // Marked before it is announced, so a terminate() asked for by a test
    // that has seen the announcement is always put off.
    "    if (held) Atomics.store(scriptedHolding, 0, 1);",
    '    postMessage({ kind: "scripted-hang", input: s });',
    `    if (held) while (Atomics.load(scriptedGate, ${PAUSE}) === 1) Atomics.wait(scriptedGate, ${PAUSE}, 1);`,
    `    while (Atomics.load(scriptedGate, ${OPEN}) === 0) {`,
    `      if (held) Atomics.wait(scriptedGate, ${OPEN}, 0);`,
    `      else Atomics.wait(scriptedGate, ${OPEN}, 0, 10);`,
    "    }",
    "  }",
    "  var cost = scriptedCosts.get(s);",
    "  if (cost !== undefined) scriptedNow += cost;",
    "  var answer = nativeExec.call(this, s);",
    `  if (held) Atomics.add(scriptedGate, ${HELD_RETURNS}, 1);`,
    "  return answer;",
    "};",
    "",
  ].join("\n");
  // A replacer function, so the inputs written into the prelude are taken
  // literally: a replacement STRING would expand $$, $&, $` and $' in them.
  const source = REGEX_WORKER_SOURCE.replace(AFTER, () => AFTER + prelude);
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const gate = new Int32Array(new SharedArrayBuffer(SLOTS * 4));
  if (pauseHolds) Atomics.store(gate, PAUSE, 1);
  const hang: { resolve: (input: string) => void } = { resolve: () => {} };
  const hung = new Promise<string>((resolve) => {
    hang.resolve = resolve;
  });
  /** The `terminate()` calls holds put off, passed on by `release`. */
  const putOff: Array<() => void> = [];
  const RealWorker = globalThis.Worker;
  class ScriptedClockWorker extends RealWorker {
    /** 1 once this worker's thread is inside a held `exec`; written by that thread. */
    readonly #holding = new Int32Array(new SharedArrayBuffer(4));
    #terminatePutOff = false;
    constructor(_url: string | URL, options?: WorkerOptions) {
      super(url, options);
      // Added before the executor's own listener, so it sees each message first.
      this.addEventListener("message", (event) => {
        const data = event.data as { kind?: unknown; input?: unknown } | null;
        if (data?.kind === "scripted-hang") hang.resolve(String(data.input));
      });
      this.postMessage({ kind: "scripted-gate", gate, holding: this.#holding });
    }
    /** Put off while this worker's thread is inside a held `exec`; passed on otherwise. */
    override terminate(): void {
      if (Atomics.load(this.#holding, 0) === 1 && Atomics.load(gate, OPEN) === 0) {
        if (!this.#terminatePutOff) {
          this.#terminatePutOff = true;
          putOff.push(() => super.terminate());
        }
        return;
      }
      super.terminate();
    }
  }
  const release = (): void => {
    // Terminate first, open second: a thread then wakes with its termination
    // pending and meets it at the held wait, so the held exec never returns
    // and the thread starts no other. Opened first, the gate could let it
    // return from the held exec and run the next inputs before the
    // termination landed.
    for (const terminate of putOff.splice(0)) terminate();
    Atomics.store(gate, OPEN, 1);
    Atomics.store(gate, PAUSE, 0);
    Atomics.notify(gate, OPEN);
    Atomics.notify(gate, PAUSE);
  };
  installed.worker = RealWorker;
  installed.url = url;
  installed.release = release;
  (globalThis as { Worker: unknown }).Worker = ScriptedClockWorker;
  return {
    hung,
    execs: () => Atomics.load(gate, EXECS),
    heldReturns: () => Atomics.load(gate, HELD_RETURNS),
    resume: () => {
      Atomics.store(gate, PAUSE, 0);
      Atomics.notify(gate, PAUSE);
    },
    release,
  };
}

/**
 * Release every thread {@link scriptWorkerClock} holds (passing on the
 * `terminate()` calls it put off first), and put back the real `Worker`,
 * if it replaced it.
 */
export function restoreWorkerClock(): void {
  if (installed.release !== undefined) {
    installed.release();
    installed.release = undefined;
  }
  if (installed.worker !== undefined) {
    (globalThis as { Worker: unknown }).Worker = installed.worker;
    installed.worker = undefined;
  }
  if (installed.url !== undefined) {
    URL.revokeObjectURL(installed.url);
    installed.url = undefined;
  }
}
