/**
 * A `.env` file as a list of lines, and the rules for changing one of them.
 *
 * ── Why there is no escaper in this file ───────────────────────────────────
 *
 * This repo has already shipped the bug that a second `.env` codec causes:
 * a writer escaped `\` and `"` whenever it quoted a value, the readers did not
 * unescape, and `K="a\"b"` came back as `a\"b` instead of `a"b` — a secret that
 * changed shape on a round trip. factory#452 fixed it by making
 * `unquoteEnvValue` in `@crewhaus/harness-supervisor` the single canonical
 * READER, which is what this file imports and what every decode below goes
 * through.
 *
 * The matching WRITER (`encodeEnvValue`) exists twice — privately in
 * `@crewhaus/hangar-server` and again in `@crewhaus/service-setup` — and is
 * exported from neither. So this package does not have one, and does not write
 * one: a third copy that disagreed with the reader by one character would
 * reintroduce exactly the shipped bug, in the package whose entire job is to
 * carry secrets without altering them.
 *
 * What it does instead is write only values that need no quoting at all, and
 * prove that claim with the canonical reader rather than with a charset guess:
 * the candidate line is handed to `parseEnvText` and the result must equal the
 * value byte for byte, or nothing is written and the caller is told why. A
 * value that needs quotes — one with a space, a `#`, a leading quote — is
 * REFUSED, by name, with the export that would fix it. That is a real
 * limitation (see the README), and it is the honest one: a refusal an operator
 * can act on beats a value silently rewritten.
 *
 * ── Why the file is a list of lines ────────────────────────────────────────
 *
 * A `.env` is a file a human edits. Parsing it into a map and serializing the
 * map back would discard every comment, every blank line, every deliberate
 * grouping and the operator's key order — a diff nobody asked for on a file
 * that lives in somebody's editor. Every edit here is a splice: one line
 * changes, and the bytes around it are the bytes that were there.
 */
import { parseEnvText, unquoteEnvValue } from "@crewhaus/harness-supervisor";
import { ENV_NAME_RE, type Refusal, type Resolved, refuse } from "./refs";

/** A live assignment, matched on the TRIMMED line exactly as the reader does. */
const ASSIGN_RE = /^(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;
/** A commented-out assignment: the stub `doctor --fix` leaves behind. */
const STUB_RE = /^#[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

export type LineKind = "assign" | "stub" | "comment" | "blank";

export type EnvLine = {
  /** The line without its terminator. */
  readonly raw: string;
  /** This line's own terminator: `\n`, `\r\n`, or `""` on an unterminated last line. */
  readonly eol: string;
  readonly kind: LineKind;
  /** Set on `assign` and `stub`. */
  readonly key?: string;
};

export type EnvDoc = {
  readonly lines: readonly EnvLine[];
  /** What a NEW line gets: whatever the file already uses, else `\n`. */
  readonly eol: string;
};

/**
 * Split on newlines while remembering each line's own terminator.
 *
 * Splitting on `/\r?\n/` and rejoining with `\n` silently converts a
 * Windows-authored `.env` to LF — a whole-file diff produced by a tool asked
 * to change one line. Keeping each terminator means a CRLF file stays CRLF,
 * and a file with mixed endings (they exist, usually after exactly this kind
 * of tooling) keeps its mixture.
 */
function splitLines(text: string): { raw: string; eol: string }[] {
  const out: { raw: string; eol: string }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\n") continue;
    const crlf = i > start && text[i - 1] === "\r";
    out.push({ raw: text.slice(start, crlf ? i - 1 : i), eol: crlf ? "\r\n" : "\n" });
    start = i + 1;
  }
  if (start < text.length) out.push({ raw: text.slice(start), eol: "" });
  return out;
}

function classify(raw: string): { kind: LineKind; key?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "blank" };
  if (trimmed.startsWith("#")) {
    const stub = trimmed.match(STUB_RE);
    return stub === null ? { kind: "comment" } : { kind: "stub", key: stub[1] as string };
  }
  const assign = trimmed.match(ASSIGN_RE);
  // A non-blank, non-comment line that is not an assignment is kept verbatim
  // and treated as a comment would be: the reader ignores it, and so do we.
  return assign === null ? { kind: "comment" } : { kind: "assign", key: assign[2] as string };
}

export function parseEnvDoc(text: string): EnvDoc {
  const lines = splitLines(text).map((line) => ({ ...line, ...classify(line.raw) }));
  const crlf = lines.some((line) => line.eol === "\r\n");
  return { lines, eol: crlf ? "\r\n" : "\n" };
}

export function renderEnvDoc(doc: EnvDoc): string {
  return doc.lines.map((line) => line.raw + line.eol).join("");
}

/**
 * The value an assignment line carries, through the canonical reader.
 *
 * This is the only decode path in the package. `parseEnvText` trims the line,
 * splits at the first `=` and hands the remainder to `unquoteEnvValue`, so
 * decoding here through the same function is what guarantees "unchanged" means
 * what the harness will actually read — not what the raw bytes look like.
 */
export function decodeAssignment(raw: string): string | undefined {
  const match = raw.trim().match(ASSIGN_RE);
  if (match === null) return undefined;
  return unquoteEnvValue((match[3] ?? "").trim());
}

/** Indices of every LIVE assignment of `key`, in file order. */
export function liveAssignments(doc: EnvDoc, key: string): number[] {
  const out: number[] = [];
  doc.lines.forEach((line, index) => {
    if (line.kind === "assign" && line.key === key) out.push(index);
  });
  return out;
}

/** Index of the first commented-out `# KEY=` stub, if any. */
export function stubIndex(doc: EnvDoc, key: string): number | undefined {
  const index = doc.lines.findIndex((line) => line.kind === "stub" && line.key === key);
  return index === -1 ? undefined : index;
}

/**
 * Why a bare `KEY=value` line would not read back as `value` in a shell that
 * sources the file, or in Bun's `.env` autoloader, or undefined when it would.
 *
 * Only characters that really DIVERGE are listed, each proven against sh,
 * dash, bash, zsh and Bun (lib.test.ts runs them). In an assignment a shell
 * does no pathname expansion and no word splitting, so `?`, `*`, `!`, `^`,
 * `[ ]`, `%` and every non-ASCII letter are read literally by all of them —
 * 0.7.0 wrote those, and so does this. What diverges:
 *
 *   - `$` expands (a shell, and Bun, which expands even in single quotes);
 *   - a backtick runs a command; `\` escapes; `;` `|` `&` end the
 *     assignment; `<` `>` redirect (`>` creates a file); `(` `)` are a syntax
 *     error; a quote opens a quoted string;
 *   - `~` at the start or after a `:` expands to a home directory;
 *   - `=` at the start or after a `:` is zsh's `=command` expansion;
 *   - `{` with `}` on an `export` line: bash brace-expands an export argument
 *     (`{a,b}`, `{1..3}`), though not a plain assignment.
 *
 * Whitespace, `#`, newlines and NULs are refused before this, with their own
 * reasons.
 */
export function shellDivergence(value: string, exported: boolean): string | undefined {
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    const shown = JSON.stringify(c);
    switch (c) {
      case "$":
        return `contains ${shown}, which a shell sourcing the file and Bun's .env loader both expand`;
      case "`":
        return `contains ${shown}, which runs a command in a shell sourcing the file`;
      case "\\":
        return `contains ${shown}, which a shell sourcing the file reads as an escape`;
      case ";":
      case "|":
      case "&":
        return `contains ${shown}, which ends the assignment in a shell sourcing the file`;
      case "<":
      case ">":
        return `contains ${shown}, which is a redirection in a shell sourcing the file (">" creates a file)`;
      case "(":
      case ")":
        return `contains ${shown}, which is a syntax error in a shell sourcing the file`;
      case "'":
      case '"':
        return `contains ${shown}, which a shell sourcing the file reads as quoting`;
      case "~":
      case "=":
        if (i === 0 || value[i - 1] === ":") {
          return c === "~"
            ? `has a "~" at the start or after a ":", which a shell sourcing the file expands to a home directory`
            : `has an "=" at the start or after a ":", which zsh sourcing the file expands to a program's path`;
        }
        break;
      default:
        break;
    }
  }
  if (exported && value.includes("{") && value.includes("}")) {
    return 'has "{" and "}" on an export line, where bash sourcing the file reads them as a brace expansion ({a,b} or {1..3})';
  }
  return undefined;
}

/** The first C0 or C1 control character, or DEL, in `value`. */
function firstControl(value: string): string | undefined {
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return ch;
  }
  return undefined;
}
/** Half of a surrogate pair on its own: not text, and not writable as UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type EncodeOptions = {
  /** The line keeps an `export ` prefix, which bash reads differently (braces). */
  readonly exported?: boolean;
};

/**
 * Can this value be written as bare text, and is that provably lossless?
 *
 * The check is the canonical reader itself: the candidate line is parsed with
 * `parseEnvText` and the decoded result must equal the value exactly. The
 * cheap tests before it exist only to name WHICH property fails, so the
 * refusal tells an operator what to change — and each names a real reason:
 * a reader that would read the value differently (`shellDivergence`), a byte
 * a .env cannot hold, or a character an editor showing the file would hide.
 */
export function encodeBare(
  key: string,
  value: string,
  options: EncodeOptions = {},
): Resolved<string> {
  const why = (what: string): Refusal =>
    refuse(
      `the value for ${key} ${what}, so it would have to be quoted on the way into the file. This package deliberately has no .env quoter: the canonical one (encodeEnvValue) is private to @crewhaus/hangar-server and @crewhaus/service-setup, and a second copy that disagreed with the canonical reader by one character is the round-trip bug factory#452 fixed. Export encodeEnvValue and this refusal goes away; until then, write this value by hand or use one without the offending character.`,
    );
  if (/[\n\r]/.test(value)) return why("contains a newline — a .env cannot represent one at all");
  if (value.includes("\0")) return why("contains a NUL byte");
  // Whitespace ANYWHERE, not just at the ends. The canonical reader keeps an
  // internal space happily — but these files carry `export ` lines, which
  // means they get sourced by a shell too, and a shell splits `K=two words`
  // into an assignment and a command. A value whose meaning depends on which
  // reader opens the file is exactly what this package must not write.
  if (/\s/.test(value))
    return why("contains whitespace, which a shell that sources the file would split on");
  if (value.startsWith('"') || value.startsWith("'")) return why("starts with a quote");
  // Bun's loader strips from a `#` even with no space before it.
  if (value.includes("#")) return why('contains "#", which a reader may strip as a comment');
  if (LONE_SURROGATE.test(value)) {
    return refuse(
      `the value for ${key} is not valid Unicode text (it holds half of a surrogate pair), so it cannot be written as UTF-8 without changing.`,
    );
  }
  const control = firstControl(value);
  if (control !== undefined) {
    const code = (control.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0");
    return refuse(
      `the value for ${key} contains a control character (U+${code}), which an editor or a terminal showing the file hides or acts on. Write this value by hand, or use one without control characters.`,
    );
  }
  // C137: a character a shell sourcing the file, or Bun's .env autoloader,
  // reads differently from the canonical reader. No quoting form reads the
  // same in all of them, so such a value is refused — never quoted, never
  // written bare.
  const divergence = shellDivergence(value, options.exported === true);
  if (divergence !== undefined) {
    return refuse(
      `the value for ${key} ${divergence}, while the canonical reader keeps it literally, so its meaning would depend on which reader opens the file. Write this value by hand, or use one without that character (a generated base64, base64url or hex value always qualifies).`,
    );
  }

  const line = `${options.exported === true ? "export " : ""}${key}=${value}`;
  // The proof, not a guess: the bytes about to be written, read back by the
  // single canonical reader. Anything that does not survive is refused rather
  // than written and hoped for.
  const roundTripped = parseEnvText(line)[key];
  if (roundTripped !== value) {
    return why("does not survive a read-back through the canonical .env reader unchanged");
  }
  return { ok: true, value };
}

/** True when `key`'s one live assignment carries an `export ` prefix. */
export function exportedAssignment(doc: EnvDoc, key: string): boolean {
  const live = liveAssignments(doc, key);
  if (live.length !== 1) return false;
  const line = doc.lines[live[0] as number] as EnvLine;
  return (line.raw.trim().match(ASSIGN_RE)?.[1] ?? "") !== "";
}

export type UpsertHow = "replaced" | "uncommented" | "appended" | "unchanged";
export type UnsetHow = "commented" | "already-commented" | "absent";

export type Edit = {
  readonly how: UpsertHow | UnsetHow;
  /** 1-based line number that changed; absent when nothing did. */
  readonly line?: number;
  readonly doc: EnvDoc;
  /** The value that was there before, decoded. Never reported — fingerprinted. */
  readonly previous?: string;
};

/**
 * Plan the one line that changes for `KEY=value`.
 *
 * A live assignment is rewritten where it stands, keeping its `export ` prefix
 * and its indentation. A `# KEY=` stub is PROMOTED in place, so the key stays
 * in the section the operator filed it under — appending a second `KEY=` lower
 * down instead would leave two lines for one key, and which one wins depends
 * on the reader.
 *
 * Returns a refusal when the file assigns the key twice: the later line is
 * what the harness reads, so rewriting either one would be a guess, and the
 * operator would be told a value was set that has no effect.
 */
export function planUpsert(doc: EnvDoc, key: string, value: string): Resolved<Edit> {
  if (!ENV_NAME_RE.test(key)) {
    return refuse(
      `"${key}" is not a .env key (letters, digits and underscore, not starting with a digit).`,
    );
  }
  const live = liveAssignments(doc, key);
  if (live.length > 1) {
    const where = live.map((index) => index + 1).join(" and ");
    return refuse(
      `${key} is assigned on lines ${where}. The last one wins when the file is read, so rewriting either would be a guess and the other would silently shadow it. Remove the duplicate and try again.`,
    );
  }

  const lines = [...doc.lines];
  if (live.length === 1) {
    const index = live[0] as number;
    const current = lines[index] as EnvLine;
    const previous = decodeAssignment(current.raw);
    if (previous === value) {
      // Nothing is written, so there is nothing to encode: a value an
      // operator quoted by hand stays as they wrote it.
      return { ok: true, value: { how: "unchanged", doc, previous } };
    }
  }
  // Every path below WRITES the value, so it must encode losslessly first.
  // Only a replaced line keeps an `export ` prefix; a stub is uncommented,
  // and a new line appended, without one.
  const encoded = encodeBare(key, value, { exported: exportedAssignment(doc, key) });
  if (!encoded.ok) return encoded;

  if (live.length === 1) {
    const index = live[0] as number;
    const current = lines[index] as EnvLine;
    const previous = decodeAssignment(current.raw);
    const match = current.raw.trim().match(ASSIGN_RE);
    const prefix = match?.[1] ?? "";
    const indent = current.raw.slice(0, current.raw.length - current.raw.trimStart().length);
    lines[index] = { ...current, raw: `${indent}${prefix}${key}=${value}` };
    return {
      ok: true,
      value: {
        how: "replaced",
        line: index + 1,
        doc: { ...doc, lines },
        ...(previous !== undefined ? { previous } : {}),
      },
    };
  }

  const stub = stubIndex(doc, key);
  if (stub !== undefined) {
    const current = lines[stub] as EnvLine;
    const indent = current.raw.slice(0, current.raw.length - current.raw.trimStart().length);
    lines[stub] = { ...current, raw: `${indent}${key}=${value}`, kind: "assign", key };
    return { ok: true, value: { how: "uncommented", line: stub + 1, doc: { ...doc, lines } } };
  }

  // Appending: give an unterminated last line its terminator first, so the new
  // assignment does not graft itself onto the end of the previous one.
  if (lines.length > 0) {
    const last = lines[lines.length - 1] as EnvLine;
    if (last.eol === "") lines[lines.length - 1] = { ...last, eol: doc.eol };
  }
  lines.push({ raw: `${key}=${value}`, eol: doc.eol, kind: "assign", key });
  return { ok: true, value: { how: "appended", line: lines.length, doc: { ...doc, lines } } };
}

/**
 * Plan the removal of `key` — as a `# KEY=` stub, never as a deletion.
 *
 * Deleting the line takes the key's NAME with it, and the name is the only
 * record that the harness wants this variable at all; the next doctor run has
 * to rediscover it. A stub keeps the checklist honest, which is the same
 * choice `@crewhaus/hangar-server` made for the same reason.
 */
export function planUnset(doc: EnvDoc, key: string): Resolved<Edit> {
  if (!ENV_NAME_RE.test(key)) {
    return refuse(
      `"${key}" is not a .env key (letters, digits and underscore, not starting with a digit).`,
    );
  }
  const live = liveAssignments(doc, key);
  if (live.length > 1) {
    const where = live.map((index) => index + 1).join(" and ");
    return refuse(
      `${key} is assigned on lines ${where}. Commenting out one would leave the other live, so this refuses rather than half-unset it. Remove the duplicate and try again.`,
    );
  }
  if (live.length === 0) {
    const stub = stubIndex(doc, key);
    return {
      ok: true,
      value:
        stub === undefined
          ? { how: "absent", doc }
          : { how: "already-commented", line: stub + 1, doc },
    };
  }
  const index = live[0] as number;
  const lines = [...doc.lines];
  const current = lines[index] as EnvLine;
  const previous = decodeAssignment(current.raw);
  const indent = current.raw.slice(0, current.raw.length - current.raw.trimStart().length);
  lines[index] = { ...current, raw: `${indent}# ${key}=`, kind: "stub", key };
  return {
    ok: true,
    value: {
      how: "commented",
      line: index + 1,
      doc: { ...doc, lines },
      ...(previous !== undefined ? { previous } : {}),
    },
  };
}

/** Every key the file assigns live, in file order. Names only, no values. */
export function assignedKeys(doc: EnvDoc): string[] {
  const seen: string[] = [];
  for (const line of doc.lines) {
    if (line.kind === "assign" && line.key !== undefined && !seen.includes(line.key)) {
      seen.push(line.key);
    }
  }
  return seen;
}
