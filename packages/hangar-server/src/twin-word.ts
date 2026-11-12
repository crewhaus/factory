/**
 * One word of a command-line equivalent the server builds.
 *
 * A value is single-quoted with the supervisor's `shellQuote`, so a pasted
 * line runs exactly the command shown. A value holding a control character
 * is never put into a command-line equivalent: the line would not read as it
 * runs, so its placeholder stands in its place instead.
 */
import { shellQuote } from "@crewhaus/harness-supervisor";

/** A C0 or C1 control character, or DEL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** True when `value` can be shown in a command-line equivalent at all. */
export function twinSafe(value: string): boolean {
  return !CONTROL_CHAR_RE.test(value);
}

/** `value`, single-quoted; `placeholder`, unquoted, when it holds a control character. */
export function twinWord(value: string, placeholder: string): string {
  return twinSafe(value) ? shellQuote(value) : placeholder;
}
