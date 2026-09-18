/**
 * Building an RFC 5322 message, correctly, without a mail library.
 *
 * Four things go wrong when a program assembles an email by string
 * concatenation, and each of them is handled here rather than hoped about:
 *
 *   1. **Header injection.** A subject or display name carrying a newline
 *      splits the header block and lets the caller add `Bcc:` — or a whole
 *      second message. Every header value that is not plain printable ASCII
 *      is RFC 2047 encoded, which turns a CR or LF into `=0D`/`=0A` inside
 *      an encoded word, and addresses containing either are refused
 *      outright. The values that CANNOT be encoded because they are emitted
 *      verbatim — a message id in `In-Reply-To` or `References`, a
 *      `Content-ID` — are validated against their grammar instead, and the
 *      finished header lines are re-checked for a break that is not a fold
 *      before the message is returned. There is no path by which caller text
 *      becomes a header.
 *   2. **Non-ASCII.** A subject in German, a display name in Japanese, a
 *      body with an em dash: headers get encoded words, bodies get UTF-8
 *      with quoted-printable, and the charset is declared rather than
 *      assumed.
 *   3. **Line length.** SMTP allows 998 octets per line and a lot of relays
 *      are stricter. Bodies are quoted-printable with soft breaks at 76,
 *      headers are folded at 78, and base64 is wrapped at 76.
 *   4. **Determinism.** MIME boundaries are usually random. Here they are
 *      derived from a hash of the message's own parts, so composing the same
 *      message twice produces the same bytes — which is what makes the
 *      output testable, diffable, and safe to use as an idempotency input.
 *
 * Nothing here reads the clock: the `Date` header is an argument. Nothing
 * here opens a socket: this builds bytes, and `smtp.ts` is what sends them.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const CRLF = "\r\n";

/** Longest header line before folding, per RFC 5322 §2.1.1 (78 recommended). */
const HEADER_WIDTH = 78;
/** Longest quoted-printable line, including the trailing soft-break `=`. */
const QP_WIDTH = 76;
/** Longest base64 line. */
const B64_WIDTH = 76;
/** Longest line SMTP carries, excluding the CRLF (RFC 5321 §4.5.3.1.6). */
const MAX_LINE_OCTETS = 998;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * An address the message may carry. `name` is optional; when present it is
 * encoded or quoted as the address form requires.
 */
export type Mailbox = {
  readonly address: string;
  readonly name?: string;
};

export type Attachment = {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  /** `inline` for something referenced by the HTML part; `attachment` else. */
  readonly disposition?: "attachment" | "inline";
  /** `cid:` reference for an inline part. */
  readonly contentId?: string;
};

export type ComposeInput = {
  readonly from: Mailbox;
  readonly to: readonly Mailbox[];
  readonly cc?: readonly Mailbox[];
  /**
   * Blind recipients. They are envelope-only: an address here reaches the
   * RCPT TO list and NEVER a header, because a `Bcc:` header in a delivered
   * message is how blind copies stop being blind.
   */
  readonly bcc?: readonly Mailbox[];
  readonly replyTo?: readonly Mailbox[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments?: readonly Attachment[];
  /** The instant the message claims to have been written. Never the clock. */
  readonly date: Date;
  /**
   * The left-hand side of `Message-ID`. Omitted ⇒ derived from a hash of the
   * message, so the same message always carries the same id and a duplicate
   * is recognisable as one.
   */
  readonly messageIdLocal?: string;
  /** Domain for `Message-ID`. Omitted ⇒ the sender address's domain. */
  readonly messageIdDomain?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  /** Extra headers. Names are validated; values are encoded like any other. */
  readonly headers?: Readonly<Record<string, string>>;
};

export type ComposeResult =
  | {
      readonly ok: true;
      /** The full message: headers, blank line, body. CRLF line endings. */
      readonly message: string;
      readonly messageId: string;
      readonly bytes: number;
      /** Envelope recipients, deduplicated and in a stable order. */
      readonly envelopeTo: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

/**
 * A deliberately conservative addr-spec.
 *
 * It accepts dot-atom local parts and dotted domain labels, which is what
 * every deliverable address in practice looks like, and refuses quoted local
 * parts, address literals and anything containing whitespace, a comma, angle
 * brackets or a control character. Refusing a legal-but-exotic address is a
 * message that does not go out; accepting one that carries a comma or a
 * newline is a message that goes somewhere else.
 */
const ADDR_SPEC =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const MAX_ADDRESS_LENGTH = 254;

export function isValidAddress(address: string): boolean {
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return false;
  if (/[\r\n\0]/.test(address)) return false;
  return ADDR_SPEC.test(address);
}

/** The domain half of an address, lowercased. `null` when there is none. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// header encoding
// ---------------------------------------------------------------------------

/** True when the text contains anything a raw header may not carry. */
function needsEncoding(text: string): boolean {
  // Everything outside printable ASCII — which includes CR, LF and NUL, the
  // three characters an injection depends on.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return true;
  }
  return false;
}

/**
 * RFC 2047 encoded words, base64, UTF-8.
 *
 * An encoded word may be at most 75 characters. `=?UTF-8?B?` + `?=` costs
 * 12, so the base64 payload is capped at 60 characters — 45 source bytes —
 * and the split is made on whole code points, because half of a UTF-8
 * sequence in one word and half in the next decodes to a replacement
 * character on every client.
 */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = (): void => {
    if (chunk.length === 0) return;
    words.push(`=?UTF-8?B?${Buffer.from(Uint8Array.from(chunk)).toString("base64")}?=`);
    chunk = [];
  };
  for (const char of text) {
    const bytes = [...Buffer.from(char, "utf8")];
    if (chunk.length + bytes.length > 45) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join(" ");
}

/** A header value safe to emit: encoded when it has to be, raw when it can be. */
export function encodeHeaderValue(text: string): string {
  return needsEncoding(text) ? encodeWords(text) : text;
}

/**
 * Fold an unstructured header (Subject, References) at `HEADER_WIDTH`.
 *
 * A fold is `CRLF` followed by whitespace, and unfolding removes only the
 * `CRLF` — so breaking at an existing run of spaces and re-emitting that
 * exact run reproduces the original value byte for byte. A short header is
 * returned untouched, which is the overwhelmingly common case and the one
 * where a rewrite would be most visible.
 */
function foldUnstructured(name: string, value: string): string {
  const single = `${name}: ${value}`;
  if (single.length <= HEADER_WIDTH) return single;
  const tokens = value.match(/\S+|\s+/g) ?? [];
  const lines: string[] = [];
  let line = `${name}:`;
  let whitespace = " ";
  let hasContent = false;
  for (const token of tokens) {
    if (token.trim() === "") {
      whitespace = token;
      continue;
    }
    const candidate = `${line}${whitespace}${token}`;
    if (candidate.length > HEADER_WIDTH && hasContent) {
      lines.push(line);
      line = `${whitespace}${token}`;
    } else {
      line = candidate;
    }
    whitespace = " ";
    hasContent = true;
  }
  lines.push(line);
  return lines.join(CRLF);
}

/**
 * Fold an address list, breaking only between whole addresses.
 *
 * The list arrives as already-formatted entries rather than as one joined
 * string, because a display name may legitimately contain `, ` inside a
 * quoted-string — splitting the joined form would cut `"Smith, Bob"
 * <b@x.test>` into two nonexistent addresses.
 */
function foldList(name: string, pieces: readonly string[]): string {
  const lines: string[] = [];
  let line = `${name}:`;
  let hasContent = false;
  pieces.forEach((piece, index) => {
    const tail = index === pieces.length - 1 ? "" : ",";
    const candidate = `${line} ${piece}${tail}`;
    if (candidate.length > HEADER_WIDTH && hasContent) {
      lines.push(line);
      line = ` ${piece}${tail}`;
    } else {
      line = candidate;
    }
    hasContent = true;
  });
  lines.push(line);
  return lines.join(CRLF);
}

/** `Name <addr>`, with the display name quoted or encoded as needed. */
export function formatMailbox(mailbox: Mailbox): string {
  const name = mailbox.name;
  if (name === undefined || name.trim() === "") return `<${mailbox.address}>`;
  if (needsEncoding(name)) return `${encodeWords(name)} <${mailbox.address}>`;
  // A display name containing a special must be a quoted-string; escaping
  // the two characters a quoted-string cannot carry bare is what keeps a
  // name like `Smith, "Bob"` from ending the field early.
  if (/[()<>@,;:\\".\[\]]/.test(name)) {
    return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${mailbox.address}>`;
  }
  return `${name} <${mailbox.address}>`;
}

/** RFC 5322 date in UTC. Locale-free by construction — no `toLocaleString`. */
export function formatDate(date: Date): string {
  const day = DAYS[date.getUTCDay()] as string;
  const month = MONTHS[date.getUTCMonth()] as string;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** Header names this builder sets itself and will not let a caller override. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-id",
]);

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * A `msg-id`, per RFC 5322 §3.6.4: angle-bracketed, with no whitespace and
 * no control character anywhere inside it.
 *
 * `In-Reply-To` and `References` carry message ids VERBATIM — an encoded
 * word there would break threading on every client that reads it, so the
 * escape hatch that protects `Subject` is not available. The value is
 * therefore validated instead of encoded, and a value that is not a msg-id
 * is refused rather than trimmed into one: `<a@b>\r\nBcc: …` must not become
 * a header, and silently dropping the tail would hide the attempt.
 */
const MSG_ID = /^<[^\s<>\r\n\0]+>$/;

/**
 * A `Content-ID` token: the same shape, without the brackets this builder
 * adds itself. A CR or LF here would open a header inside a MIME part.
 */
const CONTENT_ID = /^[^\s<>\r\n\0]+$/;

/**
 * The backstop: no assembled header line may carry a bare CR or LF.
 *
 * Every value above is validated or encoded at the point it is built, and
 * this re-checks the finished lines anyway. Header injection is the one
 * defect in this file that turns a message into a different message, and a
 * structural check that cannot be reasoned around is worth more than the
 * sum of the individual ones — a header added here later inherits it for
 * free.
 *
 * A fold is legal and is `CRLF` followed by space or tab; anything else is
 * not a fold.
 */
function headerFault(headerLines: readonly string[]): string | null {
  for (const line of headerLines) {
    const name = line.slice(0, Math.max(0, line.indexOf(":")));
    const segments = line.split(CRLF);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      if (/[\r\n]/.test(segment) || (i > 0 && !/^[ \t]/.test(segment))) {
        return `the "${name}" header value carried a line break, which would have added headers of its own`;
      }
      // RFC 5321 §4.5.3.1.6: 998 octets plus the CRLF. A longer line is not
      // a message a relay has to accept, and a value with nowhere to fold —
      // one enormous token — cannot be rescued by folding harder.
      if (Buffer.byteLength(segment, "utf8") > MAX_LINE_OCTETS) {
        return `the "${name}" header is longer than the ${MAX_LINE_OCTETS} octets a line may carry and has no whitespace to fold at`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// body encoding
// ---------------------------------------------------------------------------

/**
 * Quoted-printable, per RFC 2045 §6.7.
 *
 * The parts people get wrong, handled explicitly: trailing whitespace before
 * a hard break is encoded (a relay that strips it would otherwise change the
 * message), a soft break is never inserted inside an `=XX` triplet, hard
 * breaks stay CRLF rather than being encoded, and a line-leading `.` is
 * encoded so no amount of SMTP dot handling can eat it.
 */
export function encodeQuotedPrintable(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const outLines: string[] = [];

  for (const sourceLine of normalized.split("\n")) {
    const bytes = Buffer.from(sourceLine, "utf8");
    // Encode each byte into its own token first; wrapping then works on
    // whole tokens, which is what keeps `=C3` and `=A9` together.
    const tokens: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i] as number;
      const isLast = i === bytes.length - 1;
      const literalSpace = (byte === 0x20 || byte === 0x09) && !isLast;
      const printable = byte >= 0x21 && byte <= 0x7e && byte !== 0x3d;
      if (printable && !(i === 0 && byte === 0x2e)) {
        tokens.push(String.fromCharCode(byte));
      } else if (literalSpace) {
        tokens.push(String.fromCharCode(byte));
      } else {
        tokens.push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`);
      }
    }

    let line = "";
    /** Whitespace may not sit immediately before a soft break either. */
    const closeSoft = (text: string): string => {
      const last = text.charCodeAt(text.length - 1);
      if (last === 0x20 || last === 0x09) {
        return `${text.slice(0, -1)}=${last.toString(16).toUpperCase().padStart(2, "0")}=`;
      }
      return `${text}=`;
    };
    for (const token of tokens) {
      // Three characters of headroom: a line ending in whitespace has that
      // whitespace re-encoded as `=XX` before the `=` soft break is added,
      // which is two characters longer than what it replaced.
      if (line.length + token.length > QP_WIDTH - 3) {
        outLines.push(closeSoft(line));
        line = "";
      }
      line += token;
    }
    outLines.push(line);
  }
  return outLines.join(CRLF);
}

/** Base64, wrapped at 76 columns. */
export function encodeBase64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += B64_WIDTH) {
    lines.push(encoded.slice(i, i + B64_WIDTH));
  }
  return lines.join(CRLF);
}

/**
 * A MIME boundary derived from the content it separates.
 *
 * Random boundaries make the same message compose to different bytes every
 * time, which costs the caller the ability to compare two composes or to use
 * the message as its own idempotency key. Hashing the parts keeps the
 * boundary unique-in-practice while staying reproducible; the `=_` prefix
 * uses characters that cannot appear in base64 or quoted-printable output,
 * so a boundary can never collide with the content it delimits.
 */
export function boundaryFor(kind: string, material: string): string {
  const digest = createHash("sha256").update(`${kind} ${material}`, "utf8").digest("hex");
  return `=_crewhaus_${kind}_${digest.slice(0, 32)}`;
}

/** Quote a MIME parameter value, encoding it when it is not plain ASCII. */
function mimeParameter(name: string, value: string): string {
  if (needsEncoding(value)) {
    // RFC 2231 continuation-free form: one encoded value, charset declared.
    const encoded = [...Buffer.from(value, "utf8")]
      .map((b) =>
        (b >= 0x30 && b <= 0x39) ||
        (b >= 0x41 && b <= 0x5a) ||
        (b >= 0x61 && b <= 0x7a) ||
        b === 0x2d ||
        b === 0x2e ||
        b === 0x5f
          ? String.fromCharCode(b)
          : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
      )
      .join("");
    return `${name}*=UTF-8''${encoded}`;
  }
  return `${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------

function mailboxError(label: string, mailbox: Mailbox): string | null {
  if (!isValidAddress(mailbox.address)) {
    return `${label} address "${mailbox.address.replace(/[\r\n]/g, "\\n")}" is not a deliverable addr-spec (local@domain, no spaces, commas or angle brackets)`;
  }
  return null;
}

/** Build the complete message. Pure: same input, same bytes, every time. */
export function composeMessage(input: ComposeInput): ComposeResult {
  const fromError = mailboxError("from", input.from);
  if (fromError !== null) return { ok: false, error: fromError };

  const groups: Array<[string, readonly Mailbox[]]> = [
    ["to", input.to],
    ["cc", input.cc ?? []],
    ["bcc", input.bcc ?? []],
    ["replyTo", input.replyTo ?? []],
  ];
  for (const [label, list] of groups) {
    for (const mailbox of list) {
      const error = mailboxError(label, mailbox);
      if (error !== null) return { ok: false, error };
    }
  }
  if (input.to.length === 0 && (input.cc ?? []).length === 0 && (input.bcc ?? []).length === 0) {
    return { ok: false, error: "a message needs at least one recipient" };
  }
  if (Number.isNaN(input.date.getTime())) {
    return { ok: false, error: "the date is not a valid instant" };
  }
  for (const name of Object.keys(input.headers ?? {})) {
    if (!HEADER_NAME.test(name)) {
      return { ok: false, error: `"${name}" is not a valid header name` };
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return {
        ok: false,
        error: `header "${name}" is built by this tool and cannot be overridden — set it through the matching argument instead`,
      };
    }
  }
  if (input.inReplyTo !== undefined && input.inReplyTo !== "" && !MSG_ID.test(input.inReplyTo)) {
    return {
      ok: false,
      error:
        'inReplyTo must be one message id in angle brackets, e.g. "<abc@example.com>" — a value carrying a space, a line break or a second id is refused, because it would become a header of its own',
    };
  }
  for (const reference of input.references ?? []) {
    if (!MSG_ID.test(reference)) {
      return {
        ok: false,
        error:
          'each entry in references must be one message id in angle brackets, e.g. "<abc@example.com>" — a value carrying a space or a line break is refused, because it would become a header of its own',
      };
    }
  }
  for (const attachment of input.attachments ?? []) {
    if (attachment.filename.includes("\r") || attachment.filename.includes("\n")) {
      return { ok: false, error: "an attachment filename may not contain a line break" };
    }
    if (attachment.contentId !== undefined && !CONTENT_ID.test(attachment.contentId)) {
      return {
        ok: false,
        error:
          'a contentId must be a plain token with no whitespace, angle brackets or line break, e.g. "logo@crewhaus" — this tool adds the brackets',
      };
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(
        attachment.contentType,
      )
    ) {
      return {
        ok: false,
        error: `"${attachment.contentType}" is not a media type (type/subtype)`,
      };
    }
  }

  const attachments = input.attachments ?? [];
  const hasHtml = input.html !== undefined && input.html !== "";
  const material = JSON.stringify([
    input.from.address,
    input.to.map((m) => m.address),
    input.subject,
    input.text,
    input.html ?? "",
    attachments.map((a) => [a.filename, a.contentType, a.content.byteLength]),
    input.date.toISOString(),
  ]);

  // -- body ---------------------------------------------------------------

  const textPart = [
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.text),
  ].join(CRLF);

  let content: string;
  let contentTypeHeader: string;

  if (hasHtml) {
    const altBoundary = boundaryFor("alt", material);
    const htmlPart = [
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      encodeQuotedPrintable(input.html as string),
    ].join(CRLF);
    // Least-faithful first: a client that shows only one shows the last it
    // understands, which is the rule multipart/alternative is built on.
    content = [
      `--${altBoundary}`,
      textPart,
      `--${altBoundary}`,
      htmlPart,
      `--${altBoundary}--`,
      "",
    ].join(CRLF);
    contentTypeHeader = `multipart/alternative; boundary="${altBoundary}"`;
  } else {
    content = encodeQuotedPrintable(input.text);
    contentTypeHeader = 'text/plain; charset="utf-8"';
  }

  let transferEncoding = hasHtml ? undefined : "quoted-printable";

  if (attachments.length > 0) {
    const mixedBoundary = boundaryFor("mixed", material);
    const bodyPart = hasHtml
      ? [`Content-Type: ${contentTypeHeader}`, "", content].join(CRLF)
      : [
          'Content-Type: text/plain; charset="utf-8"',
          "Content-Transfer-Encoding: quoted-printable",
          "",
          content,
        ].join(CRLF);

    const parts: string[] = [`--${mixedBoundary}`, bodyPart];
    for (const attachment of attachments) {
      const disposition = attachment.disposition ?? "attachment";
      const headers = [
        `Content-Type: ${attachment.contentType}; ${mimeParameter("name", attachment.filename)}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: ${disposition}; ${mimeParameter("filename", attachment.filename)}`,
        ...(attachment.contentId !== undefined ? [`Content-ID: <${attachment.contentId}>`] : []),
      ];
      parts.push(`--${mixedBoundary}`);
      parts.push([...headers, "", encodeBase64Lines(attachment.content)].join(CRLF));
    }
    parts.push(`--${mixedBoundary}--`);
    parts.push("");
    content = parts.join(CRLF);
    contentTypeHeader = `multipart/mixed; boundary="${mixedBoundary}"`;
    transferEncoding = undefined;
  }

  // -- headers ------------------------------------------------------------

  const domain = input.messageIdDomain ?? addressDomain(input.from.address) ?? "localhost";
  const local =
    input.messageIdLocal ??
    createHash("sha256").update(material, "utf8").digest("hex").slice(0, 40);
  const messageId = `<${local}@${domain}>`;

  const headerLines: string[] = [
    "MIME-Version: 1.0",
    `Date: ${formatDate(input.date)}`,
    foldList("From", [formatMailbox(input.from)]),
  ];
  if (input.to.length > 0) {
    headerLines.push(foldList("To", input.to.map(formatMailbox)));
  }
  if ((input.cc ?? []).length > 0) {
    headerLines.push(foldList("Cc", (input.cc as readonly Mailbox[]).map(formatMailbox)));
  }
  if ((input.replyTo ?? []).length > 0) {
    headerLines.push(
      foldList("Reply-To", (input.replyTo as readonly Mailbox[]).map(formatMailbox)),
    );
  }
  headerLines.push(foldUnstructured("Subject", encodeHeaderValue(input.subject)));
  headerLines.push(`Message-ID: ${messageId}`);
  if (input.inReplyTo !== undefined && input.inReplyTo !== "") {
    headerLines.push(`In-Reply-To: ${input.inReplyTo}`);
  }
  if ((input.references ?? []).length > 0) {
    headerLines.push(
      foldUnstructured("References", (input.references as readonly string[]).join(" ")),
    );
  }
  for (const name of Object.keys(input.headers ?? {}).sort()) {
    const value = (input.headers as Record<string, string>)[name] as string;
    headerLines.push(foldUnstructured(name, encodeHeaderValue(value)));
  }
  headerLines.push(`Content-Type: ${contentTypeHeader}`);
  if (transferEncoding !== undefined) {
    headerLines.push(`Content-Transfer-Encoding: ${transferEncoding}`);
  }

  const fault = headerFault(headerLines);
  if (fault !== null) return { ok: false, error: fault };

  const message = `${headerLines.join(CRLF)}${CRLF}${CRLF}${content}`;

  const envelope = new Set<string>();
  for (const mailbox of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
    envelope.add(mailbox.address);
  }

  return {
    ok: true,
    message,
    messageId,
    bytes: Buffer.byteLength(message, "utf8"),
    envelopeTo: [...envelope].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/**
 * Dot-stuff a message for SMTP DATA, per RFC 5321 §4.5.2, and terminate it.
 *
 * A line that begins with `.` would otherwise end the DATA phase early and
 * leave the remainder of the message being parsed as commands.
 */
export function dotStuff(message: string): string {
  const normalized = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const stuffed = normalized
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
  return `${stuffed}${CRLF}.${CRLF}`;
}
