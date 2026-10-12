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
 * The rest of the worker is the shipped source, unchanged. It is installed by
 * replacing `globalThis.Worker` for the workers started until
 * {@link restoreWorkerClock}. The caller's file wires that to `afterEach`, so
 * a test abandoned at its budget never leaves it in place.
 */
export function scriptWorkerClock(costs: Readonly<Record<string, number>>): void {
  restoreWorkerClock();
  if (!REGEX_WORKER_SOURCE.includes(AFTER)) {
    throw new Error("the regex worker source changed: no place to script its clock");
  }
  const prelude = [
    `var scriptedCosts = new Map(${JSON.stringify(Object.entries(costs))});`,
    "var scriptedNow = 0;",
    "performance.now = function () { return scriptedNow; };",
    "var nativeExec = RegExp.prototype.exec;",
    "RegExp.prototype.exec = function (s) {",
    "  var cost = scriptedCosts.get(s);",
    "  if (cost !== undefined) scriptedNow += cost;",
    "  return nativeExec.call(this, s);",
    "};",
    "",
  ].join("\n");
  const url = URL.createObjectURL(
    new Blob([REGEX_WORKER_SOURCE.replace(AFTER, `${AFTER}${prelude}`)], {
      type: "text/javascript",
    }),
  );
  const RealWorker = globalThis.Worker;
  class ScriptedClockWorker extends RealWorker {
    constructor(_url: string | URL, options?: WorkerOptions) {
      super(url, options);
    }
  }
  installed.worker = RealWorker;
  installed.url = url;
  (globalThis as { Worker: unknown }).Worker = ScriptedClockWorker;
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
