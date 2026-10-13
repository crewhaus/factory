import { FFIType, dlopen, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";

/**
 * Which of `names` this process ignores (SIG_IGN) right now.
 *
 * Why it matters: adding a `process.on(signal)` listener replaces SIG_IGN,
 * and removing the last listener leaves SIG_DFL, not SIG_IGN (measured on
 * Bun 1.3.14). A host started with a signal ignored — `nohup` for SIGHUP, a
 * shell's background job for SIGINT — therefore died of that signal once
 * spawnBounded had listened for it, and kept dying of it after the listener
 * was gone. So the host-exit cleanup reads this once, before it first
 * listens, and never listens for a signal the process ignores.
 *
 * A child cannot report it for us: Bun resets every signal to its default
 * in a child. So: Linux reads the SigIgn mask in /proc/self/status; macOS
 * asks sigaction(2) through bun:ffi (the handler is the first field of the
 * struct, and SIG_IGN is 1). Anywhere else, or if the read fails, the answer
 * is the empty set — the caller listens, as it did before.
 */
export function readIgnoredSignals(
  names: ReadonlyArray<NodeJS.Signals>,
): ReadonlySet<NodeJS.Signals> {
  const numbers = new Map<NodeJS.Signals, number>();
  for (const name of names) {
    const n = (osConstants.signals as Record<string, number | undefined>)[name];
    if (n !== undefined) numbers.set(name, n);
  }
  try {
    if (process.platform === "linux") return fromProcStatus(numbers);
    if (process.platform === "darwin") return fromSigaction(numbers);
  } catch {
    // Unknown: listen, as before.
  }
  return new Set();
}

function fromProcStatus(numbers: ReadonlyMap<NodeJS.Signals, number>): Set<NodeJS.Signals> {
  const status = readFileSync("/proc/self/status", "utf8");
  const hex = status.match(/^SigIgn:\s*([0-9a-fA-F]+)\s*$/m)?.[1];
  const out = new Set<NodeJS.Signals>();
  if (hex === undefined) return out;
  const mask = BigInt(`0x${hex}`);
  for (const [name, n] of numbers) {
    if (((mask >> BigInt(n - 1)) & 1n) === 1n) out.add(name);
  }
  return out;
}

function fromSigaction(numbers: ReadonlyMap<NodeJS.Signals, number>): Set<NodeJS.Signals> {
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    sigaction: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const out = new Set<NodeJS.Signals>();
  try {
    for (const [name, n] of numbers) {
      // Room for any platform's struct sigaction; only the first word is read.
      const old = new BigUint64Array(32);
      if (lib.symbols.sigaction(n, null, ptr(old)) === 0 && old[0] === 1n) out.add(name);
    }
  } finally {
    lib.close();
  }
  return out;
}
