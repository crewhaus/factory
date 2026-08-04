/**
 * Exit classification and restart policy.
 *
 * The exit code a harness dies with is a decision, not a number to print:
 *
 * | Exit | Class | Policy |
 * |---|---|---|
 * | 0, or the operator's own SIGTERM | clean | operator stop ⇒ `stopped`; otherwise "exited cleanly (unexpected)" and the policy decides |
 * | 20 spec, 21 config/env | terminal | never auto-restart — restarting cannot fix a spec or a missing key |
 * | 30 auth, 31 billing | terminal | never auto-restart — the recovery engine already marks these halt; billing renders the add-credits remediation verbatim |
 * | 33 crewhaus budget | terminal | never auto-restart — a restart RESETS the in-memory budget ledger and re-arms the spend the cap just stopped |
 * | 36 approval_pending | parked | not a failure: the run is waiting on a human. Daemons re-drive on grant; cli shapes chain a resume |
 * | everything else (32 rate-limit, 40 tool/MCP, signals, unclassified) | crash | exponential backoff 500 ms → 30 s, max 5 restarts per rolling 10-minute window, then `crash-looping` (manual start only) |
 *
 * The window is ROLLING, not a lifetime counter: a daemon that crashed
 * twice yesterday and once today is not crash-looping, and one that dies
 * five times in a minute is — regardless of how long it has been up.
 */
import { EXIT_CODES, type FailureClass } from "@crewhaus/errors";
import { describeFleetExit } from "@crewhaus/harness-inventory";
import type { Clock } from "./types";

/** Exit codes that must never trigger an automatic restart. */
export const TERMINAL_EXIT_CODES: readonly number[] = [
  EXIT_CODES.spec, // 20 — the spec cannot compile; restarting recompiles the same spec
  EXIT_CODES.config, // 21 — a missing key stays missing
  EXIT_CODES.auth, // 30 — the provider rejected the credential
  EXIT_CODES.billing, // 31 — the account is out of funding
  EXIT_CODES.crewhaus_budget, // 33 — a restart re-arms the spend the cap stopped
];

/** The exit that means "waiting for a human", not "broken". */
export const PARKED_EXIT_CODE: number = EXIT_CODES.approval_pending; // 36

export type ExitDisposition = "clean" | "terminal" | "parked" | "crash";

export type ExitClassification = {
  readonly disposition: ExitDisposition;
  /** `@crewhaus/errors` class when the code carries one. */
  readonly failureClass?: FailureClass;
  /** One line an operator can act on. */
  readonly title: string;
  readonly exitCode?: number;
  readonly signal?: string;
  /** True when the policy allows an automatic restart. */
  readonly restartable: boolean;
  /** True for a zero exit the operator did not ask for — a daemon that
   *  "finished" is a bug worth naming, not a success. */
  readonly unexpectedClean: boolean;
};

export type ClassifyExitInput = {
  readonly exitCode: number | null;
  readonly signal?: string | null;
  /** True when this manager sent the stop signal. */
  readonly operatorStop: boolean;
  /** Long-running class (daemon/worker): a clean exit is unexpected and a
   *  crash is restartable. One-shot jobs are never restarted. */
  readonly longRunning: boolean;
  /** Restart a long-running shape that exited 0 without being asked to.
   *  Default true — a channel daemon returning 0 has lost its listener. */
  readonly restartUnexpectedCleanExit?: boolean;
};

/** Classify one child exit. Pure. */
export function classifyExit(input: ClassifyExitInput): ExitClassification {
  const signal = input.signal ?? undefined;
  const code = input.exitCode;

  if (input.operatorStop) {
    // Our own SIGTERM — whatever the child reported, this is a clean stop.
    return {
      disposition: "clean",
      title: "stopped by the operator",
      ...(code !== null ? { exitCode: code } : {}),
      ...(signal !== undefined ? { signal } : {}),
      restartable: false,
      unexpectedClean: false,
    };
  }

  if (code === EXIT_CODES.ok) {
    const unexpected = input.longRunning;
    return {
      disposition: "clean",
      title: unexpected ? "exited cleanly (unexpected)" : "completed",
      exitCode: 0,
      restartable: unexpected && (input.restartUnexpectedCleanExit ?? true),
      unexpectedClean: unexpected,
    };
  }

  if (code !== null && TERMINAL_EXIT_CODES.includes(code)) {
    const described = describeFleetExit(code);
    return {
      disposition: "terminal",
      ...(described !== undefined ? { failureClass: described.class } : {}),
      title: described?.title ?? `terminal failure (exit ${code})`,
      exitCode: code,
      restartable: false,
      unexpectedClean: false,
    };
  }

  if (code === PARKED_EXIT_CODE) {
    const described = describeFleetExit(code);
    return {
      disposition: "parked",
      ...(described !== undefined ? { failureClass: described.class } : {}),
      title: described?.title ?? "parked awaiting approval",
      exitCode: code,
      // Parking is resolved by granting the approval, not by restarting.
      restartable: false,
      unexpectedClean: false,
    };
  }

  const described = code !== null ? describeFleetExit(code) : undefined;
  const title =
    signal !== undefined
      ? `killed by ${signal}`
      : (described?.title ?? `crashed (exit ${code ?? "unknown"})`);
  return {
    disposition: "crash",
    ...(described !== undefined ? { failureClass: described.class } : {}),
    title,
    ...(code !== null ? { exitCode: code } : {}),
    ...(signal !== undefined ? { signal } : {}),
    restartable: input.longRunning,
    unexpectedClean: false,
  };
}

// ---------------------------------------------------------------------------
// Backoff + the rolling restart window
// ---------------------------------------------------------------------------

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
export const RESTART_WINDOW_MS = 10 * 60 * 1000;
export const MAX_RESTARTS_PER_WINDOW = 5;

/** Exponential backoff, `attempt` 1-based: 500, 1000, 2000, 4000, … capped
 *  at 30 s. */
export function backoffDelayMs(
  attempt: number,
  base: number = BACKOFF_BASE_MS,
  cap: number = BACKOFF_CAP_MS,
): number {
  if (attempt <= 1) return base;
  const raw = base * 2 ** (attempt - 1);
  return Math.min(raw, cap);
}

export type RestartWindow = {
  /** Record a restart at `now`. Returns the count inside the window. */
  record(): number;
  /** Restarts inside the window right now. */
  count(): number;
  /** True once the window is full — the next crash means crash-looping. */
  exhausted(): boolean;
  /** When the oldest restart falls out of the window (epoch ms), or
   *  undefined when the window is empty. */
  nextExpiryMs(): number | undefined;
  reset(): void;
};

/** A rolling restart counter. Injecting the clock is what makes the
 *  5-in-10-minutes rule testable without waiting ten minutes. */
export function createRestartWindow(
  clock: Clock,
  max: number = MAX_RESTARTS_PER_WINDOW,
  windowMs: number = RESTART_WINDOW_MS,
): RestartWindow {
  let stamps: number[] = [];
  const prune = (): void => {
    const cutoff = clock.now() - windowMs;
    stamps = stamps.filter((t) => t > cutoff);
  };
  return {
    record: () => {
      prune();
      stamps.push(clock.now());
      return stamps.length;
    },
    count: () => {
      prune();
      return stamps.length;
    },
    exhausted: () => {
      prune();
      return stamps.length >= max;
    },
    nextExpiryMs: () => {
      prune();
      const oldest = stamps[0];
      return oldest === undefined ? undefined : oldest + windowMs;
    },
    reset: () => {
      stamps = [];
    },
  };
}

/** How long a stop waits after SIGTERM before escalating to SIGKILL. */
export const STOP_GRACE_MS = 15_000;
