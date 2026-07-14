/**
 * v0.3.0 Goal 6 — the CLI's terminal-failure rendering, factored out of the
 * entry file `index.ts` (which runs a top-level argv switch and so cannot be
 * imported by a test without executing the CLI). `die()` and the `crewhaus
 * run` failure path both route through {@link renderCliFailure} so the CLI
 * prints ONE canonical shape:
 *
 *   - a `RunFailedError` renders its structured report via
 *     `formatRunFailure()` with the `crewhaus:` prefix and exits with the
 *     report's coded status (billing 31, auth 30, …);
 *   - every other CrewhausError (and every plain-string die()) keeps the
 *     pre-0.3.0 one-liner `crewhaus: <message>` + exit 1, byte-for-byte.
 */
import { type CrewhausError, formatRunFailure, isRunFailedError } from "@crewhaus/errors";

/**
 * The resume hint `crewhaus run` appends to a terminal failure when the
 * target is cli and a session was persisted before the run died (design
 * §8.2's exact wording).
 */
export const CONTINUE_NOTE =
  "Your session is saved — `crewhaus run --continue` resumes exactly where it stopped.";

export type RenderedCliFailure = {
  /** Full stderr text (no trailing newline). */
  readonly text: string;
  /** Process exit code: report.exitCode for a RunFailedError, else 1. */
  readonly exitCode: number;
};

/**
 * Render a fatal CLI error. `notes` (e.g. {@link CONTINUE_NOTE}) are only
 * meaningful for a RunFailedError — they land between the Fix/Docs lines
 * and the exit line; they are ignored for the one-liner shape.
 */
export function renderCliFailure(
  err: string | CrewhausError,
  opts?: { notes?: readonly string[] },
): RenderedCliFailure {
  if (typeof err !== "string" && isRunFailedError(err)) {
    return {
      text: formatRunFailure(err.report, {
        prefix: "crewhaus:",
        ...(opts?.notes !== undefined ? { notes: opts.notes } : {}),
      }),
      exitCode: err.report.exitCode,
    };
  }
  const message = typeof err === "string" ? err : err.message;
  return { text: `crewhaus: ${message}`, exitCode: 1 };
}
