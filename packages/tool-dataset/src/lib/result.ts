/**
 * The two shapes every read in this package speaks in: a `Loaded<T>` that
 * carries WHY it failed, and a bounded echo for any caller-supplied string.
 *
 * The `code` is a field rather than something sniffed out of the message,
 * because the caller branches on it: `missing` is the only failure a tool may
 * carry on from ("there is no registry here yet" is an answer), and every
 * other code is a refusal that must be returned. A reworded message can never
 * silently turn a refusal into a carry-on. This mirrors `tool-crewhaus`'s
 * `LoadFailure`, deliberately — a harness that learned one package's failure
 * vocabulary should not have to learn a second.
 */

/** Why a read failed. See the module comment for why this is a field. */
export type ReadFailure =
  /** Path containment refused it — never retried, never softened. */
  | "refused"
  /** It is not there. The only code a tool may treat as an answer. */
  | "missing"
  /** It is there and could not be read (permissions, torn file, I/O error). */
  | "unreadable"
  /** It was read and does not parse / does not validate. */
  | "malformed"
  /** It is larger than this tool will read. */
  | "too-large"
  /** The caller's arguments cannot be acted on at all. */
  | "bad-input";

export type Loaded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ReadFailure; readonly message: string };

export function fail<T>(code: ReadFailure, message: string): Loaded<T> {
  return { ok: false, code, message };
}

/**
 * How much of a caller-supplied string is echoed back in a message.
 *
 * The refusal goes into a model's context, so a caller cannot be allowed to
 * spend that context by passing a megabyte of path, and cannot be allowed to
 * smuggle control characters (a NUL, an ANSI escape, a newline that forges a
 * second line of output) through a string a human or a model then reads.
 */
const MAX_ECHOED_CHARS = 200;

/** How much of a rule's own message is echoed. Longer than a path because
 *  the lint rules compose their own (already elided) id lists into it. */
const MAX_ECHOED_MESSAGE_CHARS = 4000;

/** Neutralise control characters and bound the length.
 *
 *  The character class is written with `\u0000`-style escapes rather than raw
 *  control bytes (house rule 12): a literal NUL in a regex source is invisible
 *  in a diff, makes the whole FILE binary to `grep` — which then answers every
 *  other search in it with silence — and the formatter is free to mangle it.
 *  This comment promised the escapes while the line below held the bytes. */
function sanitize(text: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising control characters is the point
  const printable = text.replace(/[\u0000-\u001f\u007f]/g, "\ufffd");
  return printable.length > max ? `${printable.slice(0, max)}…` : printable;
}

/** A caller-supplied string, safe to put in a message: bounded and printable. */
export function renderGiven(given: string): string {
  return sanitize(given, MAX_ECHOED_CHARS);
}

/**
 * A message composed by a rule, safe to put in a result.
 *
 * The rules interpolate SAMPLE IDS, and sample ids come out of a file or an
 * inline call — so a crafted id can carry an ANSI escape or a newline that
 * forges a second line in whatever reads the result. The content is the
 * rule's; the control characters are nobody's.
 */
export function renderMessage(message: string): string {
  return sanitize(message, MAX_ECHOED_MESSAGE_CHARS);
}

/** Compact JSON — the reader is a model, and every byte is context. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Plain string comparison. `localeCompare` is locale-dependent, so a listing
 *  sorted with it is not the same listing on two machines. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The message of a thrown value, without letting a non-Error stringify into
 *  something unbounded. */
export function errorMessage(err: unknown): string {
  return renderGiven(err instanceof Error ? err.message : String(err));
}
