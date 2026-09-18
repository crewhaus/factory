/**
 * SubRip (.srt) and WebVTT (.vtt) subtitles: parsing to cues, and writing
 * cues back out with optional time shifting and re-wrapping.
 *
 * ## Read
 *
 * Both formats, with or without a BOM, with CRLF or LF line endings, with
 * or without the cue identifier line. WebVTT `NOTE`, `STYLE` and `REGION`
 * blocks are recognised and skipped rather than mistaken for cues, and cue
 * settings (`align:start position:10%`) are preserved as an opaque string
 * so writing a VTT back does not silently drop the positioning.
 *
 * ## Not read
 *
 * WebVTT chapter and metadata tracks, and SRT's unofficial coordinate
 * extension. Inline markup (`<i>`, `<c.classname>`) is left in the cue text
 * verbatim — this does not parse it and does not strip it.
 *
 * ## Times
 *
 * Every cue carries integer milliseconds. Nothing here reads a clock: a
 * shift is an input, never "now minus something".
 */
import { MediaFormatError } from "./bytes";

export type SubtitleFormat = "srt" | "vtt";

export type Cue = {
  /** 1-based position in the file, renumbered on write. */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Cue text, with its own line breaks kept as `\n`. */
  readonly text: string;
  /** The cue identifier, where the file gave one. */
  readonly id?: string;
  /** WebVTT cue settings, verbatim, where the file gave any. */
  readonly settings?: string;
};

export type ParseResult = {
  readonly format: SubtitleFormat;
  readonly cues: ReadonlyArray<Cue>;
  /** Blocks that looked like cues but could not be read, with the reason. */
  readonly skipped: ReadonlyArray<{ block: number; reason: string }>;
};

const TIMING = /^(.*?)-->(.*?)$/;
const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/;

/** `HH:MM:SS,mmm`, `MM:SS.mmm` and the other legal spellings, to millis. */
export function parseTimestamp(text: string): number {
  const match = TIMESTAMP.exec(text.trim());
  if (!match) throw new MediaFormatError(`"${text}" is not a subtitle timestamp`);
  const hours = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2] as string, 10);
  const seconds = Number.parseInt(match[3] as string, 10);
  const fraction = (match[4] as string).padEnd(3, "0");
  if (minutes > 59 || seconds > 59) {
    throw new MediaFormatError(`"${text}" has a minute or second field above 59`);
  }
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + Number.parseInt(fraction, 10);
}

/** Milliseconds to `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (WebVTT). */
export function formatTimestamp(ms: number, format: SubtitleFormat): string {
  if (ms < 0) throw new MediaFormatError(`cannot format a negative timestamp (${ms}ms)`);
  const total = Math.round(ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (v: number, width = 2): string => String(v).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${format === "srt" ? "," : "."}${pad(millis, 3)}`;
}

/** The format a document is in, from its first meaningful line. */
export function detectSubtitleFormat(text: string): SubtitleFormat {
  const head = text.replace(/^﻿/, "").trimStart();
  return head.startsWith("WEBVTT") ? "vtt" : "srt";
}

const VTT_BLOCK_KEYWORDS = ["NOTE", "STYLE", "REGION"];

/** Parse an SRT or WebVTT document. The format is detected when not given. */
export function parseSubtitles(input: string, format?: SubtitleFormat): ParseResult {
  const resolved = format ?? detectSubtitleFormat(input);
  const normalized = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const body = resolved === "vtt" ? normalized.replace(/^WEBVTT[^\n]*\n?/, "") : normalized;
  const blocks = body.split(/\n{2,}/);
  const cues: Cue[] = [];
  const skipped: Array<{ block: number; reason: string }> = [];

  for (let b = 0; b < blocks.length; b++) {
    const block = (blocks[b] as string).trim();
    if (block === "") continue;
    const lines = block.split("\n");
    const first = lines[0] as string;
    if (
      resolved === "vtt" &&
      VTT_BLOCK_KEYWORDS.some((k) => first === k || first.startsWith(`${k} `))
    ) {
      continue;
    }
    let at = 0;
    let id: string | undefined;
    if (!TIMING.test(first)) {
      id = first.trim();
      at = 1;
    }
    const timingLine = lines[at];
    if (timingLine === undefined || !TIMING.test(timingLine)) {
      skipped.push({ block: b, reason: "no timing line" });
      continue;
    }
    const match = TIMING.exec(timingLine) as RegExpExecArray;
    const rightSide = (match[2] as string).trim();
    // Cue settings follow the end timestamp, separated by whitespace.
    const spaceAt = rightSide.search(/\s/);
    const endText = spaceAt === -1 ? rightSide : rightSide.slice(0, spaceAt);
    const settings = spaceAt === -1 ? "" : rightSide.slice(spaceAt).trim();
    let startMs: number;
    let endMs: number;
    try {
      startMs = parseTimestamp(match[1] as string);
      endMs = parseTimestamp(endText);
    } catch (err) {
      skipped.push({ block: b, reason: (err as Error).message });
      continue;
    }
    if (endMs < startMs) {
      skipped.push({ block: b, reason: `end ${endMs}ms is before start ${startMs}ms` });
      continue;
    }
    cues.push({
      index: cues.length + 1,
      startMs,
      endMs,
      text: lines
        .slice(at + 1)
        .join("\n")
        .trim(),
      // An SRT identifier is a sequence number the writer regenerates, so
      // it is not worth carrying; a WebVTT one can be referenced from CSS.
      ...(id !== undefined && resolved === "vtt" ? { id } : {}),
      ...(settings !== "" && resolved === "vtt" ? { settings } : {}),
    });
  }
  return { format: resolved, cues, skipped };
}

/**
 * Greedy word wrap at `columns`, preserving the line breaks already in the
 * text. A word longer than `columns` gets its own line rather than being
 * broken mid-word.
 */
export function wrapCueText(text: string, columns: number): string {
  if (columns <= 0) throw new MediaFormatError(`cannot wrap to ${columns} columns`);
  return text
    .split("\n")
    .map((paragraph) => {
      const words = paragraph.split(/\s+/).filter((w) => w !== "");
      if (words.length === 0) return "";
      const lines: string[] = [];
      let current = words[0] as string;
      for (const word of words.slice(1)) {
        if (current.length + 1 + word.length <= columns) current += ` ${word}`;
        else {
          lines.push(current);
          current = word;
        }
      }
      lines.push(current);
      return lines.join("\n");
    })
    .join("\n");
}

export type WriteOptions = {
  /** Milliseconds to add to every cue; may be negative. */
  readonly shiftMs?: number;
  /** Re-wrap each cue's text to this many columns. */
  readonly wrapColumns?: number;
  /** WebVTT only: text appended to the `WEBVTT` header line. */
  readonly header?: string;
};

/**
 * A cue's text, made safe to put in a block.
 *
 * Both formats separate cues with a BLANK LINE, so a blank line inside a
 * cue's text does not render as a paragraph break — it ENDS the cue, and
 * whatever follows is read back as a new one. Text of
 * `"hello\n\n00:00:09,000 --> 00:00:10,000\nanything"` therefore writes two
 * cues where the caller asked for one, which is structure injection by a
 * value. Runs of blank lines are collapsed, and leading and trailing ones
 * dropped, so the document a caller gets back has exactly the cues they
 * passed in. Line endings are normalised first, because a lone `\r` becomes
 * a line break when the document is read again.
 */
function cueBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * Refuse a single-line field that would not stay on its line. A cue
 * identifier, a cue's settings and the `WEBVTT` header each occupy exactly
 * one line; a break in any of them starts a new block, and a `-->` turns the
 * line into a timing line. Located by cue, so the caller can fix the value.
 */
function requireOneLine(value: string, what: string): void {
  if (/[\n\r]/.test(value)) {
    throw new MediaFormatError(`${what} contains a line break; it has to stay on one line`);
  }
  if (value.includes("-->")) {
    throw new MediaFormatError(`${what} contains "-->", which would read back as a timing line`);
  }
}

export type WriteResult = {
  readonly text: string;
  readonly cueCount: number;
  /** Cues dropped because the shift moved them before zero. */
  readonly dropped: number;
};

/**
 * Cues back to a document. A negative shift that would push a cue before
 * zero drops that cue and says so, rather than clamping it to 00:00:00 and
 * silently stacking several cues on top of one another.
 *
 * Caller values cannot change the document's STRUCTURE: cue text is put
 * through `cueBody` so a blank line in it cannot end the cue early, and the
 * one-line fields (a WebVTT id, its settings, the `WEBVTT` header) are
 * refused outright when they carry a line break or a `-->`. Reading the
 * result back therefore always yields the cues that went in, and only those.
 */
export function writeSubtitles(
  cues: ReadonlyArray<Cue>,
  format: SubtitleFormat,
  options: WriteOptions = {},
): WriteResult {
  const shift = options.shiftMs ?? 0;
  if (options.header !== undefined) requireOneLine(options.header, "the WEBVTT header");
  const blocks: string[] = [];
  let dropped = 0;
  let index = 0;
  for (const cue of cues) {
    const startMs = cue.startMs + shift;
    const endMs = cue.endMs + shift;
    if (startMs < 0 || endMs < 0) {
      dropped++;
      continue;
    }
    index++;
    const body = cueBody(
      options.wrapColumns === undefined ? cue.text : wrapCueText(cue.text, options.wrapColumns),
    );
    const timing = `${formatTimestamp(startMs, format)} --> ${formatTimestamp(endMs, format)}`;
    if (format === "srt") {
      blocks.push(`${index}\n${timing}\n${body}`);
    } else {
      if (cue.id !== undefined) requireOneLine(cue.id, `cue ${cue.index}'s id`);
      if (cue.settings !== undefined) requireOneLine(cue.settings, `cue ${cue.index}'s settings`);
      const head = cue.id === undefined ? "" : `${cue.id}\n`;
      const settings = cue.settings === undefined ? "" : ` ${cue.settings}`;
      blocks.push(`${head}${timing}${settings}\n${body}`);
    }
  }
  const prefix =
    format === "vtt" ? `WEBVTT${options.header === undefined ? "" : ` ${options.header}`}\n\n` : "";
  return { text: `${prefix}${blocks.join("\n\n")}\n`, cueCount: index, dropped };
}
