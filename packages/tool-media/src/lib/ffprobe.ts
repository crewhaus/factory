/**
 * Shaping `ffprobe -print_format json` output into something worth putting
 * in a context window.
 *
 * ffprobe's JSON is wide, deeply optional and full of fields that are
 * strings when they look like numbers. This module is the pure half of
 * `MediaProbe`: it takes the text, treats every field as absent until
 * proven otherwise, and returns a fixed shape. It is also the security
 * boundary — the JSON came out of a process reading a file the caller
 * supplied, so nothing in it is trusted, and nothing is passed through
 * except the fields named below.
 */
import { MediaFormatError } from "./bytes";

export type ProbeStream = {
  readonly index: number;
  readonly type: string;
  readonly codec?: string;
  readonly codecDescription?: string;
  readonly profile?: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly pixelFormat?: string;
  readonly sampleRateHz?: number;
  readonly channels?: number;
  readonly channelLayout?: string;
  readonly bitRateBps?: number;
  readonly durationSeconds?: number;
  readonly language?: string;
  readonly title?: string;
};

export type ProbeResult = {
  readonly formatName?: string;
  readonly formatDescription?: string;
  readonly durationSeconds?: number;
  readonly sizeBytes?: number;
  readonly bitRateBps?: number;
  readonly streamCount: number;
  readonly streams: ReadonlyArray<ProbeStream>;
  /** Container-level tags worth reporting, sorted by key. */
  readonly tags: ReadonlyArray<{ key: string; value: string }>;
};

/** Container tags that are worth carrying; the rest are noise or private. */
const TAG_ALLOWLIST: ReadonlyArray<string> = [
  "album",
  "artist",
  "comment",
  "composer",
  "date",
  "encoder",
  "genre",
  "major_brand",
  "title",
  "track",
];

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** A field that ffprobe may write as a number or as a numeric string. */
function numberField(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "unknown" || trimmed === "N/A") return undefined;
  // Bound it: a tag is metadata, not a payload.
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** `"30000/1001"` to 29.97. A zero denominator means ffprobe does not know. */
export function parseRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("/");
  if (parts.length !== 2) return numberField(value);
  const numerator = Number.parseFloat(parts[0] as string);
  const denominator = Number.parseFloat(parts[1] as string);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Parse ffprobe's JSON. Throws `MediaFormatError` on anything unexpected. */
export function parseProbeJson(text: string): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MediaFormatError(`ffprobe did not return JSON: ${(err as Error).message}`);
  }
  const root = asObject(parsed);
  if (root === undefined) throw new MediaFormatError("ffprobe returned JSON that is not an object");

  const format = asObject(root["format"]) ?? {};
  const rawStreams = Array.isArray(root["streams"]) ? (root["streams"] as unknown[]) : [];
  const streams: ProbeStream[] = [];
  for (const entry of rawStreams) {
    const stream = asObject(entry);
    if (stream === undefined) continue;
    const tags = asObject(stream["tags"]) ?? {};
    const width = numberField(stream["width"]);
    const height = numberField(stream["height"]);
    const frameRate = parseRate(stream["avg_frame_rate"]) ?? parseRate(stream["r_frame_rate"]);
    const duration = numberField(stream["duration"]);
    const bitRate = numberField(stream["bit_rate"]);
    streams.push({
      index: numberField(stream["index"]) ?? streams.length,
      type: stringField(stream["codec_type"]) ?? "unknown",
      ...(stringField(stream["codec_name"]) !== undefined
        ? { codec: stringField(stream["codec_name"]) as string }
        : {}),
      ...(stringField(stream["codec_long_name"]) !== undefined
        ? { codecDescription: stringField(stream["codec_long_name"]) as string }
        : {}),
      ...(stringField(stream["profile"]) !== undefined
        ? { profile: stringField(stream["profile"]) as string }
        : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(frameRate !== undefined && frameRate > 0 ? { frameRate } : {}),
      ...(stringField(stream["pix_fmt"]) !== undefined
        ? { pixelFormat: stringField(stream["pix_fmt"]) as string }
        : {}),
      ...(numberField(stream["sample_rate"]) !== undefined
        ? { sampleRateHz: numberField(stream["sample_rate"]) as number }
        : {}),
      ...(numberField(stream["channels"]) !== undefined
        ? { channels: numberField(stream["channels"]) as number }
        : {}),
      ...(stringField(stream["channel_layout"]) !== undefined
        ? { channelLayout: stringField(stream["channel_layout"]) as string }
        : {}),
      ...(bitRate !== undefined ? { bitRateBps: Math.round(bitRate) } : {}),
      ...(duration !== undefined ? { durationSeconds: round3(duration) } : {}),
      ...(stringField(tags["language"]) !== undefined
        ? { language: stringField(tags["language"]) as string }
        : {}),
      ...(stringField(tags["title"]) !== undefined
        ? { title: stringField(tags["title"]) as string }
        : {}),
    });
  }

  const formatTags = asObject(format["tags"]) ?? {};
  const tags: Array<{ key: string; value: string }> = [];
  for (const key of TAG_ALLOWLIST) {
    const value = stringField(formatTags[key]);
    if (value !== undefined) tags.push({ key, value });
  }

  const duration = numberField(format["duration"]);
  const size = numberField(format["size"]);
  const bitRate = numberField(format["bit_rate"]);
  return {
    ...(stringField(format["format_name"]) !== undefined
      ? { formatName: stringField(format["format_name"]) as string }
      : {}),
    ...(stringField(format["format_long_name"]) !== undefined
      ? { formatDescription: stringField(format["format_long_name"]) as string }
      : {}),
    ...(duration !== undefined ? { durationSeconds: round3(duration) } : {}),
    ...(size !== undefined ? { sizeBytes: Math.round(size) } : {}),
    ...(bitRate !== undefined ? { bitRateBps: Math.round(bitRate) } : {}),
    streamCount: streams.length,
    // Sorted by index, so two probes of the same file agree on the order.
    streams: [...streams].sort((a, b) => a.index - b.index),
    tags,
  };
}
