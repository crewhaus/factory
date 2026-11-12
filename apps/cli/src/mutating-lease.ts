/**
 * The mutating lease, from the terminal. `compile`, the `eval` run, `optimize`,
 * `flywheel run` and `dream run` write into a harness's `.crewhaus/` tree, as Home's jobs
 * do, so each takes the harness's one mutating lease first: a contender waits up to ten
 * seconds, then refuses, naming what holds it, and exits 53.
 *
 * Three cases run without taking it:
 *   - the harness has no `.crewhaus/run/` yet: the lease lives there and this never
 *     creates the tree just to take one, so a first compile of a fresh harness runs as
 *     before (and two first runs at once are not serialized);
 *   - `CREWHAUS_LEASE_REF` names the lease that holds the harness now: the verb is a job
 *     Home started under its own lease;
 *   - this process already holds it for the harness (an eval suite's entries).
 *
 * Side-effect free on import, like every `*-cmd.ts` module.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import {
  type HeldLease,
  type LeaseHolder,
  type LeaseOptions,
  acquireMutatingLease,
  readMutatingLease,
} from "@crewhaus/control-records";
import { createProcessOps } from "@crewhaus/harness-supervisor";

/** The env name a job's child reads to run under the lease its parent holds. */
export const LEASE_REF_ENV = "CREWHAUS_LEASE_REF";

/** The exit for a harness another change holds. */
export const LEASE_BUSY_EXIT: number = EXIT_FOR_ERROR.conflict;

export type CliLeaseOptions = LeaseOptions & {
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type CliLeaseAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly exitCode: number; readonly lines: readonly string[] };

/** Leases this process holds, by harness directory. */
const held = new Map<string, HeldLease>();

/**
 * What holds the lease, in words. A CLI holder's kind is the verb it runs; a Home
 * holder's is a job's label, which is not always a command, so it is named as a job.
 */
function whoHolds(holder: LeaseHolder): string {
  const what =
    holder.head === "cli"
      ? `\`crewhaus ${holder.kind}\` from the CLI`
      : `${holder.head === "resident" ? "the Home service's" : "Home's"} ${holder.kind} job`;
  return `${what} (pid ${holder.pid}, since ${holder.since})`;
}

/** Why a verb did not start: another change holds the harness. */
export function leaseBusyLines(holder: LeaseHolder): string[] {
  return [
    `crewhaus: another change is running on this harness: ${whoHolds(holder)}.`,
    "  Try again when it finishes.",
  ];
}

/** Whether the verb may run without taking the lease, and why. */
function runsWithoutLease(
  harnessDir: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (!existsSync(join(harnessDir, ".crewhaus", "run"))) return true;
  if (held.has(harnessDir)) return true;
  const ref = env[LEASE_REF_ENV];
  if (ref === undefined || ref === "") return false;
  const current = readMutatingLease(harnessDir);
  return current.state === "present" && current.lease.leaseRef === ref;
}

async function take(
  harnessDir: string,
  kind: string,
  options: CliLeaseOptions,
): Promise<HeldLease | { readonly lines: readonly string[] }> {
  const lease = await acquireMutatingLease(
    harnessDir,
    { head: "cli", kind },
    { ...options, probe: options.probe ?? createProcessOps() },
  );
  if (lease.ok) return lease;
  return {
    lines: "holder" in lease ? leaseBusyLines(lease.holder) : [`crewhaus: ${lease.reason}`],
  };
}

/**
 * Run `fn` holding the harness's mutating lease, releasing it after, or answer the
 * refusal and its exit without running it.
 */
export async function withCliMutatingLease<T>(
  harnessDir: string,
  kind: string,
  fn: () => Promise<T> | T,
  options: CliLeaseOptions = {},
): Promise<CliLeaseAnswer<T>> {
  if (runsWithoutLease(harnessDir, options.env ?? process.env))
    return { ok: true, value: await fn() };
  const lease = await take(harnessDir, kind, options);
  if (!("ok" in lease)) return { ok: false, exitCode: LEASE_BUSY_EXIT, lines: lease.lines };
  held.set(harnessDir, lease);
  // A verb that dies through process.exit never reaches the finally below.
  const release = (): void => {
    lease.release();
  };
  process.once("exit", release);
  try {
    return { ok: true, value: await fn() };
  } finally {
    process.removeListener("exit", release);
    held.delete(harnessDir);
    lease.release();
  }
}

/**
 * Take the harness's mutating lease for the rest of this process, or print the refusal
 * and exit 53. For a verb that runs to the end of its process, where one line at the
 * point it resolves its spec is the whole change; the lease is released when the
 * process exits, however it exits.
 */
export async function holdCliMutatingLease(
  harnessDir: string,
  kind: string,
  options: CliLeaseOptions & {
    readonly exit?: (code: number) => never;
    readonly writeErr?: (text: string) => void;
  } = {},
): Promise<void> {
  if (runsWithoutLease(harnessDir, options.env ?? process.env)) return;
  const lease = await take(harnessDir, kind, options);
  if ("ok" in lease) {
    held.set(harnessDir, lease);
    process.once("exit", () => {
      held.delete(harnessDir);
      lease.release();
    });
    return;
  }
  const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));
  for (const line of lease.lines) writeErr(`${line}\n`);
  (options.exit ?? ((code: number) => process.exit(code)))(LEASE_BUSY_EXIT);
}

/** Test seam: release and forget every lease this process holds. */
export function _releaseHeldLeasesForTest(): void {
  for (const lease of held.values()) lease.release();
  held.clear();
}
