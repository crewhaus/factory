/**
 * The directory of the control plane this process serves, when it serves one. A compiled
 * daemon or batch worker registers its harness directory when its control plane starts,
 * and the doors inside the process read it to know whose operator record they honour.
 * It is absent in every CLI process, where the entry point decides instead.
 *
 * One slot, kept on `globalThis` under `Symbol.for("@crewhaus/control-records/intake-root")`,
 * so two copies of this package in one bundle share it.
 */
import { resolve } from "node:path";

const ROOT_KEY = Symbol.for("@crewhaus/control-records/intake-root");

type Holder = Record<symbol, string | undefined>;

function holder(): Holder {
  return globalThis as unknown as Holder;
}

/**
 * Name `harnessDir` as the directory of the control plane this process serves. The
 * last call wins.
 *
 * First consumer: the control plane's `start()`.
 */
export function registerIntakeRoot(harnessDir: string): void {
  holder()[ROOT_KEY] = resolve(harnessDir);
}

/**
 * The directory of the control plane this process serves, or `undefined` in a process
 * that serves none (every CLI process, an eval, a test).
 *
 * First consumer: the runtime's admission at loop start.
 */
export function intakeRoot(): string | undefined {
  const root = holder()[ROOT_KEY];
  return typeof root === "string" ? root : undefined;
}

/**
 * Clear the slot when it names `harnessDir`; a slot another plane registered stays.
 *
 * First consumer: the control plane's `stop()`.
 */
export function unregisterIntakeRoot(harnessDir: string): void {
  if (holder()[ROOT_KEY] === resolve(harnessDir)) Reflect.deleteProperty(holder(), ROOT_KEY);
}
