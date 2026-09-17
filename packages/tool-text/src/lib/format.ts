/**
 * Shaping text to fit somewhere: a token budget, a column width, or another
 * language's syntax.
 */

export type TruncateStrategy = "head" | "tail" | "middle";

/**
 * Cut text to at most `maxChars`, keeping the end that matters for the
 * chosen strategy and marking where bytes were dropped. Returns the input
 * untouched when it already fits, so a caller can pipe everything through
 * this without a size check first.
 */
export function truncateToChars(
  text: string,
  maxChars: number,
  strategy: TruncateStrategy,
  marker: string,
): { text: string; truncated: boolean; droppedChars: number } {
  if (text.length <= maxChars) return { text, truncated: false, droppedChars: 0 };
  if (maxChars <= marker.length) {
    return {
      text: marker.slice(0, maxChars),
      truncated: true,
      droppedChars: text.length - maxChars,
    };
  }
  const budget = maxChars - marker.length;
  let out: string;
  if (strategy === "head") {
    out = text.slice(0, budget) + marker;
  } else if (strategy === "tail") {
    out = marker + text.slice(text.length - budget);
  } else {
    const half = Math.floor(budget / 2);
    out = text.slice(0, half) + marker + text.slice(text.length - (budget - half));
  }
  return { text: out, truncated: true, droppedChars: text.length - budget };
}

/**
 * Greedy word wrap at `width`, preserving blank-line paragraph breaks and
 * prefixing every line (for quoting, comment blocks, commit bodies). A word
 * longer than the width is left whole rather than split, because splitting a
 * URL or an identifier makes it wrong, not merely ugly.
 */
export function wrapText(
  text: string,
  width: number,
  prefix: string,
  hangingIndent: string,
): string {
  const usable = Math.max(1, width - prefix.length);
  const out: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const words = paragraph.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) continue;
    let line = "";
    const lines: string[] = [];
    for (const word of words) {
      if (line === "") {
        line = (lines.length === 0 ? "" : hangingIndent) + word;
        continue;
      }
      if (line.length + 1 + word.length <= usable) {
        line += ` ${word}`;
        continue;
      }
      lines.push(line);
      line = hangingIndent + word;
    }
    if (line !== "") lines.push(line);
    out.push(lines.map((l) => prefix + l).join("\n"));
  }
  return out.join("\n\n");
}

export type EscapeTarget =
  | "regex"
  | "shellSingle"
  | "shellDouble"
  | "json"
  | "url"
  | "urlComponent"
  | "html"
  | "markdown"
  | "csv"
  | "sqlLike";

/**
 * Escape text for embedding in another syntax.
 *
 * This is the function that stops a harness building an injection into its
 * own next command: a scraped string going into a regex, a filename going
 * into a shell word, a customer's text going into a CSV cell. It performs no
 * execution of any kind — it only quotes.
 */
export function escapeFor(text: string, target: EscapeTarget): string {
  switch (target) {
    case "regex":
      return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    case "shellSingle":
      // POSIX single-quoting: close the quote, emit an escaped quote, reopen.
      return `'${text.replace(/'/g, `'\\''`)}'`;
    case "shellDouble":
      return `"${text.replace(/(["$`\\])/g, "\\$1")}"`;
    case "json":
      return JSON.stringify(text);
    case "url":
      return encodeURI(text);
    case "urlComponent":
      return encodeURIComponent(text);
    case "html":
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    case "markdown":
      return text.replace(/([\\`*_{}[\]()#+\-.!|>~])/g, "\\$1");
    case "csv":
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    case "sqlLike":
      return text.replace(/([\\%_])/g, "\\$1");
    default:
      return text;
  }
}
