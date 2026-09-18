/**
 * Decide whether a loop is still making progress.
 *
 * A fix-test-fail loop that has stopped moving looks, from inside one turn,
 * exactly like a loop that is about to succeed. The difference is only
 * visible across turns, in whether the signals change — the failing-test
 * fingerprint, the workspace diff hash, the last error, the tool call being
 * made. This takes that history and answers the question.
 *
 * The history is an input. Nothing here persists anything, so the same
 * history always gives the same verdict.
 */

export const STALL_REASONS = ["progressing", "unchanged", "oscillating", "insufficient"] as const;
export type StallReason = (typeof STALL_REASONS)[number];

/** One turn's observation: named signals, each an opaque fingerprint. */
export type Snapshot = Readonly<Record<string, string>>;

export type StallOptions = {
  /** Identical snapshots needed in a row before calling it stalled. */
  readonly window?: number;
  /**
   * Longest repeating cycle to look for. A loop that alternates between two
   * states is not "unchanged", but it is just as stuck.
   */
  readonly maxCycle?: number;
  /** Only these signals are considered, when given. */
  readonly signals?: ReadonlyArray<string>;
};

export type StallReport = {
  readonly stalled: boolean;
  readonly reason: StallReason;
  /** Consecutive identical snapshots at the end of the history. */
  readonly repeats: number;
  /** Length of the detected cycle; 1 means "unchanged". Null when progressing. */
  readonly cycleLength: number | null;
  /** Signals that changed between the last two snapshots. */
  readonly changed: ReadonlyArray<string>;
  /** Signals that have not changed anywhere in the history. */
  readonly frozen: ReadonlyArray<string>;
  readonly observed: number;
};

const DEFAULT_WINDOW = 3;
const DEFAULT_MAX_CYCLE = 3;

/**
 * A snapshot reduced to a comparable string.
 *
 * Keys are sorted so that two snapshots with the same content compare equal
 * whatever order they were built in, and the pairs are JSON rather than
 * joined with a separator: a fingerprint is opaque caller-supplied text, and
 * any separator could occur inside one, making two different snapshots
 * collide.
 */
function fingerprint(snapshot: Snapshot, only: ReadonlyArray<string> | undefined): string {
  const keys = (only ?? Object.keys(snapshot)).slice().sort();
  return JSON.stringify(keys.map((k) => [k, snapshot[k] ?? ""]));
}

export function detectStall(
  history: ReadonlyArray<Snapshot>,
  options: StallOptions = {},
): StallReport {
  const window = options.window ?? DEFAULT_WINDOW;
  const maxCycle = options.maxCycle ?? DEFAULT_MAX_CYCLE;
  if (window < 2) throw new Error("window must be at least 2 — one snapshot cannot show a trend");
  if (maxCycle < 1) throw new Error("maxCycle must be at least 1");

  const prints = history.map((s) => fingerprint(s, options.signals));
  const observed = prints.length;

  const changed: string[] = [];
  if (observed >= 2) {
    const a = history[observed - 2] as Snapshot;
    const b = history[observed - 1] as Snapshot;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      if (options.signals && !options.signals.includes(key)) continue;
      if (a[key] !== b[key]) changed.push(key);
    }
  }

  const frozen: string[] = [];
  if (observed >= 2) {
    const keys = new Set(history.flatMap((s) => Object.keys(s)));
    for (const key of [...keys].sort()) {
      if (options.signals && !options.signals.includes(key)) continue;
      const first = history[0]?.[key];
      if (history.every((s) => s[key] === first)) frozen.push(key);
    }
  }

  // Not enough history to say anything. Reporting "progressing" here would be
  // a claim the data does not support, so it gets its own reason.
  if (observed < window) {
    return {
      stalled: false,
      reason: "insufficient",
      repeats: 0,
      cycleLength: null,
      changed,
      frozen,
      observed,
    };
  }

  let repeats = 1;
  for (let i = observed - 1; i > 0; i--) {
    if (prints[i] === prints[i - 1]) repeats += 1;
    else break;
  }
  if (repeats >= window) {
    return {
      stalled: true,
      reason: "unchanged",
      repeats,
      cycleLength: 1,
      changed,
      frozen,
      observed,
    };
  }

  // Oscillation: the tail repeats a cycle of length k, at least twice, and
  // the cycle itself is not constant (that is "unchanged", already handled).
  for (let k = 2; k <= maxCycle; k++) {
    const needed = k * 2;
    if (observed < needed || needed < window) continue;
    const tail = prints.slice(observed - needed);
    const first = tail.slice(0, k);
    const second = tail.slice(k);
    const cycles = first.every((p, i) => p === second[i]);
    const varied = new Set(first).size > 1;
    if (cycles && varied) {
      return {
        stalled: true,
        reason: "oscillating",
        repeats,
        cycleLength: k,
        changed,
        frozen,
        observed,
      };
    }
  }

  return {
    stalled: false,
    reason: "progressing",
    repeats,
    cycleLength: null,
    changed,
    frozen,
    observed,
  };
}
