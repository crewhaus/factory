/**
 * The vocabulary for "I could not find out".
 *
 * This is the whole reason the package is shaped the way it is. A caller
 * asks how many cores the machine has in order to decide something — how
 * many workers to start, whether to run the big test suite, whether to pull
 * eight gigabytes over a metered link. Every one of those decisions is made
 * WRONGLY, and silently, if a probe that could not answer returns a zero:
 *
 *   - `os.cpus()` is empty in some containers        -> "0 cores"
 *   - `os.loadavg()` is [0,0,0] on Windows           -> "idle machine"
 *   - `pmset -g batt` prints no battery line on a
 *     desktop Mac (captured, verbatim, in fixtures)  -> "0% battery"
 *   - an unprivileged `lsof` sees only its own uid   -> "port is free"
 *   - `ip` is absent, so no interfaces are parsed    -> "no network"
 *
 * So the rule across this package: a fact that could not be established is
 * `null` in the result AND carries an entry here naming the field, the probe
 * that was tried, and why it did not answer. A boolean is never defaulted to
 * false and a count is never defaulted to zero. `every null is explained` in
 * index.test.ts walks each tool's output and fails if any null is missing
 * its entry, so the rule cannot rot.
 */

export type UnknownFact = {
  /** Dotted path of the field in the result, e.g. "cpu.physicalCores". */
  readonly field: string;
  /** What was tried: a command, a file, or a runtime call. */
  readonly probe: string;
  /** Why it did not answer, in a sentence a caller can act on. */
  readonly reason: string;
};

/** Collects unknowns for one tool call. */
export class Unknowns {
  private readonly facts = new Map<string, UnknownFact>();

  add(field: string, probe: string, reason: string): void {
    // First writer wins: the innermost probe that failed is the specific
    // one, and a later generic "section unavailable" must not overwrite it.
    if (!this.facts.has(field)) this.facts.set(field, { field, probe, reason });
  }

  has(field: string): boolean {
    return this.facts.has(field);
  }

  /** Sorted by field, so two calls against the same machine return the same
   *  bytes rather than whatever order the probes happened to fail in. */
  list(): ReadonlyArray<UnknownFact> {
    return [...this.facts.values()].sort((a, b) => (a.field < b.field ? -1 : 1));
  }
}

/**
 * Describe a failed command in the words a caller needs, keeping the two
 * cases that matter apart: a probe that is NOT INSTALLED (ask for a
 * different one, or install it) and a probe that ran and refused (a
 * permission problem, usually fixable by privilege rather than by tooling).
 */
export function failureReason(
  failure: string | undefined,
  stderr: string,
): { readonly kind: string; readonly reason: string } {
  const detail = firstLine(stderr);
  switch (failure) {
    case "not-installed":
      return { kind: "not-installed", reason: "the command is not installed on this host" };
    case "timed-out":
      return { kind: "timed-out", reason: "the command did not finish within its timeout" };
    case "spawn-failed":
      return { kind: "spawn-failed", reason: `the command could not be started: ${detail}` };
    default:
      return {
        kind: "exit-nonzero",
        reason: detail === "" ? "the command exited non-zero" : `the command failed: ${detail}`,
      };
  }
}

/** The first non-empty line, capped — a usage message can be twenty lines
 *  long (busybox `ip -j addr` prints the whole grammar) and none of it
 *  belongs in a result a model has to read. */
export function firstLine(text: string, max = 160): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
