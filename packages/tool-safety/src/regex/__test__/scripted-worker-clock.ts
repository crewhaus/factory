import { REGEX_WORKER_SOURCE } from "../worker-source";

/**
 * The scripted clock goes in after the worker's own settings, so the source
 * still starts as the shipped one does, and a fault-injection preload that
 * patches the worker by its first line patches this one too.
 */
const AFTER = "var progressEveryMs = 10;\n";

/** What {@link scriptWorkerClock} replaced. A const object, not a module `let`. */
const installed: { worker: typeof Worker | undefined; url: string | undefined } = {
  worker: undefined,
  url: undefined,
};

/** What a test can wait for on the scripted worker. */
export type ScriptedWorker = {
  /**
   * Resolves with the input once a worker is inside an `exec` over one of
   * the `hangs`. A worker's messages arrive in order, so by then every
   * progress report it sent before that exec has been taken in.
   */
  readonly hung: Promise<string>;
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
 * An `exec` over a string in `hangs` never returns: it is how a test holds a
 * run past its deadline without a real slow input, which an engine fast
 * enough would finish first. The thread waits rather than spins, and
 * `terminate()` ends it within one 10 ms wait (an untimed `Atomics.wait`
 * outlives `terminate()` in Bun 1.3.14, so the wait is timed and repeated).
 *
 * Both lists are matched literally, `$` included. The rest of the worker is
 * the shipped source, unchanged. It is installed by replacing
 * `globalThis.Worker` for the workers started until {@link restoreWorkerClock}.
 * The caller's file wires that to `afterEach`, so a test abandoned at its
 * budget never leaves it in place.
 */
export function scriptWorkerClock(
  costs: Readonly<Record<string, number>>,
  hangs: ReadonlyArray<string> = [],
): ScriptedWorker {
  restoreWorkerClock();
  if (!REGEX_WORKER_SOURCE.includes(AFTER)) {
    throw new Error("the regex worker source changed: no place to script its clock");
  }
  const prelude = [
    `var scriptedCosts = new Map(${JSON.stringify(Object.entries(costs))});`,
    `var scriptedHangs = new Set(${JSON.stringify(hangs)});`,
    "var scriptedNow = 0;",
    "var scriptedWait = new Int32Array(new SharedArrayBuffer(4));",
    "performance.now = function () { return scriptedNow; };",
    "var nativeExec = RegExp.prototype.exec;",
    "RegExp.prototype.exec = function (s) {",
    "  if (scriptedHangs.has(s)) {",
    '    postMessage({ kind: "scripted-hang", input: s });',
    "    for (;;) Atomics.wait(scriptedWait, 0, 0, 10);",
    "  }",
    "  var cost = scriptedCosts.get(s);",
    "  if (cost !== undefined) scriptedNow += cost;",
    "  return nativeExec.call(this, s);",
    "};",
    "",
  ].join("\n");
  // A replacer function, so the inputs written into the prelude are taken
  // literally: a replacement STRING would expand $$, $&, $` and $' in them.
  const source = REGEX_WORKER_SOURCE.replace(AFTER, () => AFTER + prelude);
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const hang: { resolve: (input: string) => void } = { resolve: () => {} };
  const hung = new Promise<string>((resolve) => {
    hang.resolve = resolve;
  });
  const RealWorker = globalThis.Worker;
  class ScriptedClockWorker extends RealWorker {
    constructor(_url: string | URL, options?: WorkerOptions) {
      super(url, options);
      // Added before the executor's own listener, so it sees each message first.
      this.addEventListener("message", (event) => {
        const data = event.data as { kind?: unknown; input?: unknown } | null;
        if (data?.kind === "scripted-hang") hang.resolve(String(data.input));
      });
    }
  }
  installed.worker = RealWorker;
  installed.url = url;
  (globalThis as { Worker: unknown }).Worker = ScriptedClockWorker;
  return { hung };
}

/** Put back the real `Worker`, if {@link scriptWorkerClock} replaced it. */
export function restoreWorkerClock(): void {
  if (installed.worker !== undefined) {
    (globalThis as { Worker: unknown }).Worker = installed.worker;
    installed.worker = undefined;
  }
  if (installed.url !== undefined) {
    URL.revokeObjectURL(installed.url);
    installed.url = undefined;
  }
}
