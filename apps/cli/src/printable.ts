/**
 * Text as a terminal may show it. What a harness wrote (a tool's name, a message, a node's
 * name) is printed with no control character in it, so it cannot drive the terminal.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** A printed line with no C0 or C1 control character. */
export function printable(line: string): string {
  return line.replace(CONTROL_RE, "");
}

/**
 * JSON output with DEL and the C1 controls escaped as well: `JSON.stringify` escapes C0
 * inside strings itself, and its own line breaks stay.
 */
export function jsonSafe(text: string): string {
  return text.replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
