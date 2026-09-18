import { lineStarts, offsetToLineCol } from "./locate";

/**
 * Regex-only entity extraction. Explicitly NOT named-entity recognition:
 * these find things that have a syntax (a URL, a UUID, a semver), not things
 * that have a meaning (a company, a person). That distinction is exactly
 * what keeps the tool deterministic.
 */
export const ENTITY_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  url: /https?:\/\/[^\s<>"'`)\]]+/g,
  email: /[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  uuid: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  semver: /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g,
  isoDate: /\b\d{4}-\d{2}-\d{2}\b/g,
  time: /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  money:
    /(?:[$£€¥]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|JPY|CAD|AUD)\b)/g,
  percent: /\b\d+(?:\.\d+)?\s?%/g,
  hashtag: /(?:^|\s)(#[A-Za-z][\w-]*)/g,
  mention: /(?:^|\s)(@[A-Za-z][\w.-]*)/g,
  ticket: /\b[A-Z][A-Z0-9]+-\d+\b/g,
  jwt: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  macAddress: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g,
});

/** Every kind `extractEntities` understands, for schema + error messages. */
export const ENTITY_KINDS = Object.freeze(Object.keys(ENTITY_PATTERNS));

export type EntityHit = {
  readonly value: string;
  readonly index: number;
  readonly line: number;
};

export function extractEntities(
  text: string,
  kinds: ReadonlyArray<string>,
  unique: boolean,
): Record<string, EntityHit[]> {
  const starts = lineStarts(text);
  const out: Record<string, EntityHit[]> = {};
  for (const kind of kinds) {
    const source = ENTITY_PATTERNS[kind];
    if (source === undefined) continue;
    const re = new RegExp(source.source, source.flags);
    const hits: EntityHit[] = [];
    const seen = new Set<string>();
    for (;;) {
      const m = re.exec(text);
      if (m === null) break;
      const whole = m[0] as string;
      // Patterns with a leading-boundary group (hashtag, mention) report the
      // capture, so the preceding space is not part of the value.
      const value = (m[1] ?? whole) as string;
      const index = m.index + whole.indexOf(value);
      if (whole.length === 0) re.lastIndex += 1;
      if (unique && seen.has(value)) continue;
      seen.add(value);
      hits.push({ value, index, line: offsetToLineCol(starts, index).line });
    }
    if (hits.length > 0) out[kind] = hits;
  }
  return out;
}
