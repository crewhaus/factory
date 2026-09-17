/**
 * RFC 5322 messages: headers, addresses, MIME parts and mbox files.
 *
 * ## Supported
 *
 * - Header UNFOLDING per RFC 5322 section 2.2.3 (a line beginning with space
 *   or tab continues the previous one), with both CRLF and bare-LF line
 *   endings, because real mail files have both.
 * - Repeated headers are kept in order; `Received:` chains stay readable.
 * - RFC 2047 encoded-words in headers, `B` and `Q` forms, with the
 *   whitespace between two adjacent encoded-words removed as the RFC
 *   requires. The charset is honoured through `TextDecoder`; an unknown one
 *   falls back to Latin-1 and SAYS it did.
 * - Address lists: `Name <local@domain>`, bare addresses, quoted display
 *   names containing commas, and group syntax (`Group: a@b, c@d;`) flattened
 *   to its members.
 * - `Date:` parsed to ISO-8601 by hand — no reliance on the host's lenient
 *   `Date` parsing — including obsolete zone names (UT, GMT, EST…) and
 *   two-digit years.
 * - MIME: `multipart/*` split on the boundary (including nested multiparts),
 *   `base64`, `quoted-printable`, `7bit`, `8bit` and `binary` transfer
 *   encodings, and per-part charsets.
 * - Attachment METADATA: filename (including RFC 2231 continuations),
 *   content type, decoded size, content id and disposition. The bytes are
 *   NOT returned: an attachment belongs in a file, not in a context window.
 *
 * ## Not supported — stated rather than faked
 *
 * - S/MIME and PGP: an encrypted or signed part is reported as what it is,
 *   with its content left alone. Nothing here verifies a signature.
 * - `message/external-body`, which points at content that is not in the file.
 * - Unicode (SMTPUTF8) local parts are passed through verbatim rather than
 *   normalised.
 */
import { Buffer } from "node:buffer";

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}

export type MailHeader = { readonly name: string; readonly value: string };
export type MailAddress = { readonly name?: string; readonly address: string };

export type MailPart = {
  readonly contentType: string;
  readonly charset?: string;
  readonly encoding: string;
  readonly disposition?: string;
  readonly filename?: string;
  readonly contentId?: string;
  /** Decoded size in bytes. */
  readonly size: number;
  /** Present for text parts only, and only when the caller asked for bodies. */
  readonly text?: string;
  readonly isAttachment: boolean;
};

export type ParsedMessage = {
  readonly headers: ReadonlyArray<MailHeader>;
  readonly subject?: string;
  readonly date?: string;
  readonly from: ReadonlyArray<MailAddress>;
  readonly to: ReadonlyArray<MailAddress>;
  readonly cc: ReadonlyArray<MailAddress>;
  readonly bcc: ReadonlyArray<MailAddress>;
  readonly messageId?: string;
  readonly parts: ReadonlyArray<MailPart>;
  readonly notes: ReadonlyArray<string>;
};

/**
 * `TextDecoder`'s label parameter is typed as a closed union here, while a
 * mail charset is whatever the sender wrote. The cast hands the runtime the
 * string it accepts; an unsupported label throws and is caught below.
 */
type DecoderLabel = ConstructorParameters<typeof TextDecoder>[0];

const LATIN1 = new TextDecoder("latin1" as DecoderLabel);

function decodeCharset(bytes: Uint8Array, charset: string | undefined, notes: Set<string>): string {
  const label = (charset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(label as DecoderLabel, { fatal: false }).decode(bytes);
  } catch {
    notes.add(`charset "${label}" is not supported here; that part was decoded as Latin-1`);
    return LATIN1.decode(bytes);
  }
}

/** Split a message into its header block and its body, handling CRLF and LF. */
function splitHeadersAndBody(raw: string): { headerText: string; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  let at = -1;
  let skip = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    at = crlf;
    skip = 4;
  } else if (lf >= 0) {
    at = lf;
    skip = 2;
  }
  if (at < 0) return { headerText: raw, body: "" };
  return { headerText: raw.slice(0, at), body: raw.slice(at + skip) };
}

/** Unfold and split a header block into ordered name/value pairs. */
export function parseHeaderBlock(headerText: string): MailHeader[] {
  const out: MailHeader[] = [];
  let currentName: string | null = null;
  let currentValue = "";
  const flush = (): void => {
    if (currentName !== null) out.push({ name: currentName, value: currentValue.trim() });
    currentName = null;
    currentValue = "";
  };
  for (const line of headerText.split(/\r?\n/)) {
    if (line === "") continue;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      // A folded continuation: the CRLF goes away, the whitespace stays.
      currentValue += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue; // not a header line; a damaged message
    flush();
    currentName = line.slice(0, colon).trim();
    currentValue = line.slice(colon + 1);
  }
  flush();
  return out;
}

export function headerValue(headers: ReadonlyArray<MailHeader>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const header of headers) if (header.name.toLowerCase() === lower) return header.value;
  return undefined;
}

/** Decode RFC 2047 encoded-words inside a header value. */
export function decodeEncodedWords(value: string, notes: Set<string>): string {
  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let previousWasEncoded = false;
  for (;;) {
    const match = pattern.exec(value);
    if (match === null) break;
    const between = value.slice(last, match.index);
    // Whitespace between two adjacent encoded-words is not data (RFC 2047
    // section 6.2) and is dropped; anything else is kept.
    if (!(previousWasEncoded && between.trim() === "")) out += between;
    const charset = (match[1] as string).split("*")[0] as string;
    const encoding = (match[2] as string).toUpperCase();
    const payload = match[3] as string;
    let bytes: Uint8Array;
    if (encoding === "B") {
      bytes = new Uint8Array(Buffer.from(payload, "base64"));
    } else {
      // In the Q form `_` is a space, which is the part everyone forgets.
      bytes = decodeQuotedPrintable(payload.replace(/_/g, " "));
    }
    out += decodeCharset(bytes, charset, notes);
    last = match.index + match[0].length;
    previousWasEncoded = true;
  }
  out += value.slice(last);
  return out;
}

export function decodeQuotedPrintable(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch !== "=") {
      bytes.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const next = text.slice(i + 1, i + 3);
    if (next === "\r\n" || next.startsWith("\n")) {
      // A soft line break: the "=" and the newline both disappear.
      i += next.startsWith("\r\n") ? 2 : 1;
      continue;
    }
    if (/^[0-9A-Fa-f]{2}$/.test(next)) {
      bytes.push(Number.parseInt(next, 16));
      i += 2;
      continue;
    }
    bytes.push(0x3d); // a lone "=" is passed through
  }
  return Uint8Array.from(bytes);
}

/** Split an address list on commas that are not inside quotes or brackets. */
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  let angle = 0;
  let paren = 0;
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === "<") angle += 1;
    else if (!inQuote && ch === ">") angle = Math.max(0, angle - 1);
    else if (!inQuote && ch === "(") paren += 1;
    else if (!inQuote && ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "," && !inQuote && angle === 0 && paren === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

export function parseAddressList(
  value: string | undefined,
  notes: Set<string>,
): MailAddress[] {
  if (value === undefined || value.trim() === "") return [];
  // Group syntax: `Managers: a@b, c@d;` — flatten to the members.
  const flattened = value.replace(/^[^:;"<]*:(.*);?\s*$/s, "$1");
  const out: MailAddress[] = [];
  for (const raw of splitAddressList(flattened)) {
    const piece = raw.trim().replace(/;$/, "");
    if (piece === "") continue;
    const angle = /^(.*)<([^>]*)>\s*$/s.exec(piece);
    if (angle !== null) {
      let name = (angle[1] ?? "").trim().replace(/^"(.*)"$/s, "$1");
      name = decodeEncodedWords(name, notes).trim();
      const address = (angle[2] ?? "").trim();
      out.push(name === "" ? { address } : { name, address });
      continue;
    }
    // A bare address, possibly with a comment: `a@b (Some One)`.
    const comment = /^([^(]*)\(([^)]*)\)\s*$/s.exec(piece);
    if (comment !== null) {
      const address = (comment[1] ?? "").trim();
      const name = decodeEncodedWords((comment[2] ?? "").trim(), notes);
      out.push(name === "" ? { address } : { name, address });
      continue;
    }
    out.push({ address: piece });
  }
  return out;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Obsolete zone names, per RFC 5322 section 4.3. */
const OBSOLETE_ZONES: Readonly<Record<string, number>> = {
  ut: 0,
  gmt: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
  z: 0,
};

/**
 * Parse an RFC 5322 `Date:` to ISO-8601, by hand. The host's `Date` parser
 * accepts and silently reinterprets all sorts of malformed input; a mail
 * date is data, and data gets a real parser.
 */
export function parseMailDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/\([^)]*\)/g, " ").trim();
  const match =
    /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,3})?/.exec(
      cleaned,
    );
  if (match === null) return undefined;
  const day = Number.parseInt(match[1] as string, 10);
  const month = MONTHS[(match[2] as string).toLowerCase()];
  if (month === undefined) return undefined;
  let year = Number.parseInt(match[3] as string, 10);
  // Two-digit years: 0-49 are 2000s, 50-99 are 1900s (RFC 5322 section 4.3).
  if (year < 50) year += 2000;
  else if (year < 100) year += 1900;
  const hour = Number.parseInt(match[4] as string, 10);
  const minute = Number.parseInt(match[5] as string, 10);
  const second = Number.parseInt(match[6] ?? "0", 10);
  const zone = match[7];
  let offsetMinutes = 0;
  if (zone !== undefined && /^[+-]\d{4}$/.test(zone)) {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes =
      sign * (Number.parseInt(zone.slice(1, 3), 10) * 60 + Number.parseInt(zone.slice(3, 5), 10));
  } else if (zone !== undefined) {
    offsetMinutes = OBSOLETE_ZONES[zone.toLowerCase()] ?? 0;
  }
  const ms = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000;
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** Parse `type/subtype; key=value; key="quoted"` and RFC 2231 continuations. */
export function parseParameterHeader(value: string): {
  value: string;
  params: Record<string, string>;
} {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ";" && !inQuote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const head = (parts.shift() ?? "").trim();
  const params: Record<string, string> = {};
  const continued = new Map<string, string[]>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    let key = part.slice(0, eq).trim().toLowerCase();
    let raw = part.slice(eq + 1).trim();
    if (raw.startsWith('"')) raw = raw.slice(1, raw.endsWith('"') ? -1 : undefined);
    // RFC 2231: `name*0="a"; name*1="b"` and `name*=utf-8''%41`.
    const section = /^([^*]+)\*(\d+)\*?$/.exec(key);
    if (section !== null) {
      const base = section[1] as string;
      const list = continued.get(base) ?? [];
      list[Number.parseInt(section[2] as string, 10)] = raw;
      continued.set(base, list);
      continue;
    }
    if (key.endsWith("*")) {
      key = key.slice(0, -1);
      const extended = /^([^']*)'[^']*'(.*)$/.exec(raw);
      if (extended !== null) {
        const bytes = decodePercent(extended[2] as string);
        raw = decodeCharset(bytes, extended[1] as string, new Set());
      }
    }
    params[key] = raw;
  }
  for (const [base, list] of continued) {
    const joined = list.join("");
    const extended = /^([^']*)'[^']*'(.*)$/.exec(joined);
    params[base] =
      extended === null
        ? joined
        : decodeCharset(decodePercent(extended[2] as string), extended[1] as string, new Set());
  }
  return { value: head, params };
}

function decodePercent(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

export type MailParseOptions = {
  /** Include decoded text for text parts. */
  readonly includeBodies: boolean;
  readonly maxParts: number;
  readonly maxDepth: number;
  readonly maxBodyChars: number;
};

function decodeBody(body: string, encoding: string): Uint8Array {
  switch (encoding) {
    case "base64":
      return new Uint8Array(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"));
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    default: {
      // 7bit / 8bit / binary: the characters ARE the bytes, and the source
      // string was decoded as Latin-1 precisely so this round-trips.
      const bytes = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
      return bytes;
    }
  }
}

function walkPart(
  headers: ReadonlyArray<MailHeader>,
  body: string,
  options: MailParseOptions,
  depth: number,
  out: MailPart[],
  notes: Set<string>,
): void {
  if (out.length >= options.maxParts) {
    notes.add(`stopped after ${options.maxParts} parts`);
    return;
  }
  const contentTypeRaw = headerValue(headers, "content-type") ?? "text/plain";
  const { value: contentType, params } = parseParameterHeader(contentTypeRaw);
  const lowerType = contentType.toLowerCase();
  const encoding = (headerValue(headers, "content-transfer-encoding") ?? "7bit")
    .trim()
    .toLowerCase();

  if (lowerType.startsWith("multipart/")) {
    const boundary = params["boundary"];
    if (boundary === undefined) {
      notes.add(`a ${lowerType} part has no boundary parameter and was left unsplit`);
    } else if (depth >= options.maxDepth) {
      notes.add(`multipart nesting deeper than ${options.maxDepth} levels was not followed`);
    } else {
      const marker = `--${boundary}`;
      const segments = body.split(new RegExp(`(?:^|\\r?\\n)${escapeRegExp(marker)}(--)?[^\\n]*\\r?\\n?`));
      // The first segment is the preamble and is not a part.
      for (const segment of segments.slice(1)) {
        if (segment === undefined || segment === "--" || segment.trim() === "") continue;
        const split = splitHeadersAndBody(segment);
        walkPart(
          parseHeaderBlock(split.headerText),
          split.body,
          options,
          depth + 1,
          out,
          notes,
        );
        if (out.length >= options.maxParts) return;
      }
      return;
    }
  }

  const dispositionRaw = headerValue(headers, "content-disposition");
  const disposition =
    dispositionRaw === undefined ? undefined : parseParameterHeader(dispositionRaw);
  const filenameRaw = disposition?.params["filename"] ?? params["name"];
  const filename =
    filenameRaw === undefined ? undefined : decodeEncodedWords(filenameRaw, notes);
  const decoded = decodeBody(body, encoding);
  const isText = lowerType.startsWith("text/") || lowerType === "message/rfc822";
  const isAttachment =
    disposition?.value.toLowerCase() === "attachment" ||
    (filename !== undefined && !isText) ||
    (!isText && disposition?.value.toLowerCase() !== "inline" && !lowerType.startsWith("multipart/"));

  const part: {
    contentType: string;
    charset?: string;
    encoding: string;
    disposition?: string;
    filename?: string;
    contentId?: string;
    size: number;
    text?: string;
    isAttachment: boolean;
  } = {
    contentType: lowerType,
    encoding,
    size: decoded.length,
    isAttachment,
  };
  const charset = params["charset"];
  if (charset !== undefined) part.charset = charset;
  if (disposition !== undefined) part.disposition = disposition.value.toLowerCase();
  if (filename !== undefined) part.filename = filename;
  const contentId = headerValue(headers, "content-id");
  if (contentId !== undefined) part.contentId = contentId.replace(/^<|>$/g, "");
  if (options.includeBodies && isText && !isAttachment) {
    const text = decodeCharset(decoded, charset, notes);
    part.text = text.length > options.maxBodyChars ? text.slice(0, options.maxBodyChars) : text;
    if (text.length > options.maxBodyChars) notes.add("a body part was truncated");
  }
  out.push(part);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse one RFC 5322 message. `raw` must be Latin-1 decoded bytes. */
export function parseMessage(raw: string, options: MailParseOptions): ParsedMessage {
  const notes = new Set<string>();
  const { headerText, body } = splitHeadersAndBody(raw);
  const headers = parseHeaderBlock(headerText).map((h) => ({
    name: h.name,
    value: decodeEncodedWords(h.value, notes),
  }));
  if (headers.length === 0) notes.add("this message has no headers; it may not be a mail file");
  const parts: MailPart[] = [];
  walkPart(headers, body, options, 0, parts, notes);
  const subject = headerValue(headers, "subject");
  const date = parseMailDate(headerValue(headers, "date"));
  const messageId = headerValue(headers, "message-id");
  const message: {
    headers: MailHeader[];
    subject?: string;
    date?: string;
    from: MailAddress[];
    to: MailAddress[];
    cc: MailAddress[];
    bcc: MailAddress[];
    messageId?: string;
    parts: MailPart[];
    notes: string[];
  } = {
    headers,
    from: parseAddressList(headerValue(headers, "from"), notes),
    to: parseAddressList(headerValue(headers, "to"), notes),
    cc: parseAddressList(headerValue(headers, "cc"), notes),
    bcc: parseAddressList(headerValue(headers, "bcc"), notes),
    parts,
    notes: [...notes].sort(),
  };
  if (subject !== undefined) message.subject = subject;
  if (date !== undefined) message.date = date;
  if (messageId !== undefined) message.messageId = messageId.replace(/^<|>$/g, "");
  return message;
}

/** The text of a message: its text/plain parts, or its text/html stripped. */
export function messagePlainText(message: ParsedMessage): string {
  const plain = message.parts.filter((p) => p.contentType === "text/plain" && p.text !== undefined);
  if (plain.length > 0) return plain.map((p) => p.text ?? "").join("\n").trim();
  const html = message.parts.filter((p) => p.contentType === "text/html" && p.text !== undefined);
  return html
    .map((p) => stripHtml(p.text ?? ""))
    .join("\n")
    .trim();
}

/**
 * A deliberately blunt HTML-to-text pass for mail bodies: block tags become
 * newlines, every other tag disappears, and the five predefined entities plus
 * numeric references are decoded. It is not an HTML renderer and does not
 * pretend to be one.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos|nbsp);/g, (whole, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      const map: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      return map[body] ?? whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// mbox
// ---------------------------------------------------------------------------

export type MboxMessage = {
  readonly index: number;
  /** The `From ` separator line, which carries the envelope sender. */
  readonly separator: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly raw: string;
};

/**
 * Split an mbox into messages.
 *
 * A message begins at a line starting with `From ` that is either the first
 * line of the file or preceded by a blank line — the check every mbox reader
 * uses, because `From ` can legitimately begin a body line. Lines that the
 * writer escaped as `>From ` (mboxo/mboxrd) are unescaped on the way out,
 * which is reversible for mboxrd and lossy in the one case mboxo cannot
 * represent; that limit is inherent to the format, not to this reader.
 */
export function splitMbox(text: string, maxMessages: number): MboxMessage[] {
  const lines = text.split(/(?<=\n)/); // keep the line terminators
  const out: MboxMessage[] = [];
  let current: string[] | null = null;
  let separator = "";
  let offset = 0;
  let startOffset = 0;
  let previousBlank = true;

  const flush = (endOffset: number): void => {
    if (current === null) return;
    const raw = current.join("").replace(/^>(>*From )/gm, "$1");
    out.push({
      index: out.length + 1,
      separator: separator.trimEnd(),
      byteOffset: startOffset,
      byteLength: endOffset - startOffset,
      raw,
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("From ") && previousBlank) {
      flush(offset);
      if (out.length >= maxMessages) return out;
      separator = line;
      startOffset = offset;
      current = [];
    } else if (current !== null) {
      current.push(line);
    }
    previousBlank = line === "\n" || line === "\r\n" || line === "";
    offset += line.length;
  }
  flush(offset);
  return out;
}
