/**
 * The vocabulary for "I could not find out" — `@crewhaus/tool-host`'s
 * `lib/unknown.ts`, reproduced here because that package exports its tools
 * and not its library, and the rule it encodes is the one this package is
 * most likely to break.
 *
 * A caller asks whether `curl` is installed in order to decide something:
 * whether to install it, whether to pick a different strategy, whether to
 * tell an operator the host is not ready. Every one of those decisions is
 * made WRONGLY, and silently, if a probe that could not answer comes back as
 * "no":
 *
 *   - `dpkg-query` is not on the host (this is a Fedora box)  -> "not installed"
 *   - `dnf --cacheonly` has no cached metadata                -> "not available"
 *   - `apt-cache policy` printed German labels                -> "no candidate"
 *   - `winget list` printed a row whose name was truncated    -> wrong version
 *   - the command hit its deadline                            -> "not installed"
 *   - `brew info` exited non-zero for a reason nobody parsed  -> "not installed"
 *
 * So: a fact that could not be established is `null` in the result AND
 * carries an entry here naming the field, the probe that was tried, and why
 * it did not answer. A boolean is never defaulted to false, a version is
 * never defaulted to "latest", and a status is `"unknown"` rather than
 * `"not-installed"` unless the manager gave its own documented not-found
 * signal. `every null is explained` in index.test.ts walks each tool's output
 * and fails if any null is missing its entry, so the rule cannot rot.
 */

export type UnknownFact = {
  /** Dotted path of the field in the result, e.g. "available.version". */
  readonly field: string;
  /** What was tried: a command, or the reason no command was run. */
  readonly probe: string;
  /** Why it did not answer, in a sentence a caller can act on. */
  readonly reason: string;
};

/** Collects unknowns for one tool call. */
export class Unknowns {
  private readonly facts = new Map<string, UnknownFact>();

  add(field: string, probe: string, reason: string): void {
    // First writer wins: the innermost probe that failed is the specific one,
    // and a later generic "this section is unavailable" must not overwrite it.
    if (!this.facts.has(field)) this.facts.set(field, { field, probe, reason });
  }

  has(field: string): boolean {
    return this.facts.has(field);
  }

  get size(): number {
    return this.facts.size;
  }

  /**
   * Sorted by field, so two calls against the same machine return the same
   * bytes rather than whatever order the probes happened to fail in.
   */
  list(): ReadonlyArray<UnknownFact> {
    return [...this.facts.values()].sort((a, b) =>
      a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
    );
  }
}

/**
 * Describe a failed command, keeping apart the cases a caller acts on
 * differently: a manager that is NOT INSTALLED (this is the wrong host, or
 * ask a different manager), one that TIMED OUT (the answer is unknown and
 * retrying may work), and one that RAN AND FAILED (its stderr is the lead).
 */
export function commandFailureReason(result: {
  readonly code: number;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly missing: boolean;
  readonly abandoned?: boolean;
}): string {
  if (result.missing) return "the command is not installed on this host";
  if (result.timedOut) {
    return result.abandoned === true
      ? "the command did not finish within its timeout and could not be reaped"
      : "the command did not finish within its timeout";
  }
  const detail = firstLine(result.stderr);
  return detail === ""
    ? `the command exited ${result.code}`
    : `the command exited ${result.code}: ${detail}`;
}

/**
 * The first non-empty line, capped.
 *
 * A manager's usage message can be forty lines long — `dnf` prints its whole
 * option grammar on a bad flag — and none of it belongs in a result a model
 * has to read.
 */
export function firstLine(text: string, max = 200): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
