/**
 * The vocabulary for "I could not find out" — `@crewhaus/tool-pkgmgr`'s
 * `lib/unknown.ts`, reproduced here because that package exports its tools and
 * not its library, and because the rule it encodes is the one an APPROVALS
 * reader is most dangerous for breaking.
 *
 * Every question these tools answer is a question an operator acts on:
 *
 *   - "is anything parked waiting for me?" — an approvals file that could not
 *     be OPENED must never read back as "nothing is waiting". A run stays
 *     paused forever and nobody is told.
 *   - "how many harnesses are blocked?" — one unreadable mount reported as a
 *     zero blinds the operator to the whole fleet behind it.
 *   - "what did humans approve before?" — a session log that was cut at the
 *     byte cap has FEWER asks in it than the harness really saw, so a
 *     "0/3 denied, safe to grant" verdict may be an artefact of the cut.
 *   - "what rules already exist?" — a `settings.json` that did not parse is
 *     not a settings file with no rules. Proposing a merge against it would
 *     propose DELETING the rules that are in there.
 *
 * So: a fact that could not be established is `null` in the result AND carries
 * an entry here naming the field, what was tried, and why it did not answer.
 * A count is never defaulted to zero, and a list is never reported as complete
 * when the read that produced it was cut short. `every null is explained` in
 * index.test.ts walks each tool's output and fails if any null is missing its
 * entry, so the rule cannot rot.
 */

export type UnknownFact = {
  /** Dotted path of the field in the result, e.g. "totals.pending". */
  readonly field: string;
  /** What was tried: a path read, or the reason no read was attempted. */
  readonly probe: string;
  /** Why it did not answer, in a sentence a caller can act on. */
  readonly reason: string;
};

/** Collects unknowns for one tool call. */
export class Unknowns {
  private readonly facts = new Map<string, UnknownFact>();

  add(field: string, probe: string, reason: string): void {
    // First writer wins: the innermost read that failed is the specific one,
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
   * Sorted by field, so two calls against the same tree return the same bytes
   * rather than whatever order the reads happened to fail in.
   */
  list(): ReadonlyArray<UnknownFact> {
    return [...this.facts.values()].sort((a, b) =>
      a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
    );
  }
}

/**
 * Plain string ordering. `localeCompare` is locale-sensitive, so the same tree
 * sorts differently under a different `LANG` — every listing in this package
 * uses this instead.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The first non-empty line of an error text, capped.
 *
 * A node `ENOENT` message carries the ABSOLUTE path, which is workspace layout
 * the caller did not supply and does not need; callers pass an already-sanitized
 * reason. This only bounds length.
 */
export function firstLine(text: string, max = 200): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
