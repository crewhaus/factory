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
 * Can this value be written as bare text, and is that provably lossless?
 *
 * The check is the canonical reader itself: the candidate line is parsed with
 * `parseEnvText` and the decoded result must equal the value exactly. The
 * cheap tests before it exist only to name WHICH property fails, so the
 * refusal tells an operator what to change.
 */
export function encodeBare(key: string, value: string): Resolved<string> {
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
  if (value.includes("#")) return why('contains "#", which a reader may strip as a comment');

  const line = `${key}=${value}`;
  // The proof, not a guess: the bytes about to be written, read back by the
  // single canonical reader. Anything that does not survive is refused rather
  // than written and hoped for.
  const roundTripped = parseEnvText(line)[key];
  if (roundTripped !== value) {
    return why("does not survive a read-back through the canonical .env reader unchanged");
  }
  return { ok: true, value };
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
  const encoded = encodeBare(key, value);
  if (!encoded.ok) return encoded;

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
      return { ok: true, value: { how: "unchanged", doc, previous } };
    }
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
