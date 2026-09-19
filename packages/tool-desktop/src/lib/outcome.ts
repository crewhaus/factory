/**
 * The vocabulary for "there was nothing to ask" and "I could not find out".
 *
 * House rule 6, and the class of bug that has dominated every wave of this
 * project: "could not determine" is not "no". Every tool in this package has
 * an empty-looking answer that a caller will act on, and in every case
 * "nothing" has more than one cause:
 *
 *   - an EMPTY clipboard is not an UNREADABLE one. Recorded on Debian 12:
 *     `xclip -selection primary -o` on an empty selection exits 1 with
 *     "Error: target STRING not available", while with no `$DISPLAY` it exits
 *     1 with "Error: Can't open display: (null)". Same exit code, same empty
 *     stdout, opposite meanings.
 *   - a presence probe that FAILED is not "the user is idle". Returning
 *     `idle: false` there tells a workflow the human is at the keyboard.
 *   - a window list that could not be READ is not "no windows open".
 *     Recorded: without Accessibility, System Events answers every window
 *     query with an error, not with an empty list.
 *   - a printer query that TIMED OUT is not "no printers". Recorded: with no
 *     scheduler, `lpstat -p -d` prints "Scheduler is not running." and lists
 *     nothing - which reads exactly like a host with zero queues.
 *
 * So each tool answers with an `outcome` naming which of those it is, and a
 * field that could not be established is `null` PLUS an entry in `unknown`
 * saying what was tried and why it did not answer. A count is never defaulted
 * to 0, a boolean never to false, a list never to empty.
 */

export type UnknownFact = {
  /** Dotted path of the field in the result, e.g. "idleSeconds". */
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
    // First writer wins: the innermost probe that failed is the specific one,
    // and a later generic "section unavailable" must not overwrite it.
    if (!this.facts.has(field)) this.facts.set(field, { field, probe, reason });
  }

  has(field: string): boolean {
    return this.facts.has(field);
  }

  /**
   * Sorted by field, so two calls against the same machine return the same
   * bytes rather than whatever order the probes happened to fail in.
   */
  list(): ReadonlyArray<UnknownFact> {
    return [...this.facts.values()].sort((a, b) => (a.field < b.field ? -1 : 1));
  }
}

/**
 * Why a tool could not even try.
 *
 * `missing` names the THING that was not there - a program, a display, an OS
 * grant - so a caller (or an operator reading a log) knows what to install or
 * switch on. `unsupported` is separate from `missing` because "this package
 * has no backend for your OS" is a different instruction from "install
 * wmctrl".
 */
export type Unavailable = {
  readonly outcome: "unavailable";
  /** What was absent: `"platform"`, `"program"`, `"session"`, `"permission"`. */
  readonly missing: "platform" | "program" | "session" | "permission";
  readonly reason: string;
  /** The program that would have been run, when there was one. */
  readonly program?: string;
};

export function unavailable(
  missing: Unavailable["missing"],
  reason: string,
  program?: string,
): Unavailable {
  return {
    outcome: "unavailable",
    missing,
    reason,
    ...(program === undefined ? {} : { program }),
  };
}

/** The refusal every tool gives on a platform this package has no backend for. */
export function unsupportedPlatform(platform: string, what: string): Unavailable {
  return unavailable(
    "platform",
    `this package has no ${what} backend for platform "${platform}"`,
  );
}

/** The first non-empty line, capped - a usage message can be twenty lines. */
export function firstLine(text: string, max = 200): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}...`;
}

/**
 * Why a command failed, keeping the cases apart that a caller acts on
 * differently: the program is NOT INSTALLED (install it, or use another
 * backend), it TIMED OUT (the desktop may be wedged - notably an X11
 * clipboard read with no server, which blocks rather than exiting), the seam
 * was not wired (a test author's mistake), or it ran and refused.
 */
export function commandFailure(result: {
  readonly code: number;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly missing: boolean;
  readonly refused?: boolean;
}): { readonly kind: string; readonly reason: string } {
  if (result.refused === true) {
    return { kind: "no-runner", reason: result.stderr };
  }
  if (result.missing) {
    return { kind: "not-installed", reason: "the program is not installed on this host" };
  }
  if (result.timedOut) {
    return {
      kind: "timed-out",
      reason:
        "the program did not finish within its timeout - it was killed, and nothing can be concluded about what it would have said",
    };
  }
  const detail = firstLine(result.stderr);
  return {
    kind: "exit-nonzero",
    reason:
      detail === ""
        ? `the program exited ${result.code} and said nothing`
        : `the program exited ${result.code}: ${detail}`,
  };
}
