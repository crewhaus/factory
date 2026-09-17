/**
 * Shannon entropy over the symbols a string actually contains.
 *
 * ## What this measures
 *
 * `H = -Σ p(c) · log2 p(c)`, where `p(c)` is the frequency of character `c`
 * in THIS string. Units are bits per character. It is a property of the
 * string's own symbol distribution and nothing else — it has no model of
 * English, of base64, or of what a key looks like.
 *
 * ## What it does not measure
 *
 * Not randomness, and not secrecy. `"abcdefgh"` scores a perfect 3.0 bits
 * per character over its own alphabet while being entirely predictable, and
 * a genuine 128-bit key rendered as 32 hex characters cannot exceed 4.0
 * because hex has only 16 symbols. Short strings score low by construction:
 * a 6-character string cannot exceed log2(6) ≈ 2.58.
 *
 * That is why every entropy threshold in this package is paired with a
 * minimum length and a charset check, and why the threshold is reported
 * alongside the finding rather than hidden inside it.
 */

/** Entropy in bits per character, plus the observed alphabet size. */
export function shannonEntropy(value: string): { bits: number; alphabet: number } {
  if (value.length === 0) return { bits: 0, alphabet: 0 };
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...value].length;
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / n;
    bits -= p * Math.log2(p);
  }
  // Clamp the -0 that a single-symbol string produces.
  return { bits: bits === 0 ? 0 : bits, alphabet: counts.size };
}

/** Round to 4 decimals so the same input serializes to the same bytes. */
export function roundBits(bits: number): number {
  return Math.round(bits * 10_000) / 10_000;
}

export type Charset = "hex" | "base64" | "base64url" | "alphanumeric" | "printable" | "mixed";

/**
 * Classify the alphabet a string is drawn from. The order matters: the
 * narrowest matching class wins, because the narrower the alphabet the lower
 * the entropy ceiling, and thresholds are per-class for exactly that reason.
 */
export function classifyCharset(value: string): Charset {
  if (value.length === 0) return "mixed";
  if (/^[0-9a-fA-F]+$/.test(value)) return "hex";
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return "base64";
  if (/^[A-Za-z0-9_-]+$/.test(value)) return "base64url";
  if (/^[A-Za-z0-9]+$/.test(value)) return "alphanumeric";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to exclude control characters.
  if (/^[\x20-\x7e]+$/.test(value)) return "printable";
  return "mixed";
}

/**
 * The bits-per-character floor above which a string of this charset is worth
 * a look. Derived from each alphabet's ceiling (log2 of its size) with room
 * left for the uneven symbol distribution of a real 32-character sample:
 * hex tops out at 4.0, base64 at 6.0.
 *
 * These are heuristics, stated here so a caller can see and override them.
 */
export const DEFAULT_ENTROPY_THRESHOLDS: Readonly<Record<Charset, number>> = {
  hex: 3.2,
  base64: 4.2,
  base64url: 4.2,
  alphanumeric: 4.0,
  printable: 4.0,
  mixed: 4.0,
};

/** The shortest run that the high-entropy rule will consider at all. */
export const MIN_HIGH_ENTROPY_LENGTH = 20;

/**
 * Is this string a plausible opaque credential? Length, charset and entropy
 * together — any one of the three alone is a false-positive machine.
 */
export function looksHighEntropy(
  value: string,
  override?: number,
): { high: boolean; bits: number; charset: Charset; threshold: number } {
  const charset = classifyCharset(value);
  const threshold = override ?? DEFAULT_ENTROPY_THRESHOLDS[charset];
  const { bits } = shannonEntropy(value);
  const high = value.length >= MIN_HIGH_ENTROPY_LENGTH && bits >= threshold;
  return { high, bits: roundBits(bits), charset, threshold };
}
