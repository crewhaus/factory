/**
 * Streaming markdown → ANSI renderer for CLI target stdout output.
 *
 * Activated when `CREWHAUS_CLI_MARKDOWN=1` is set. Wraps the model's
 * text-delta stream so the user sees rendered markdown (bold, italic,
 * headers, lists, code fences, inline code) instead of raw asterisks.
 *
 * Design notes:
 * - **Line-buffered**: chunks accumulate until a `\n` arrives, then the
 *   full line renders and flushes. Trades per-character streaming feel
 *   for stable rendering — the model can split a `**` marker across
 *   chunks, so per-character pass-through would emit half-tokens.
 * - **Stateful**: tracks code-fence state across lines so multi-line
 *   ```code blocks``` render as a unit (dim color, optional language tag).
 * - **Zero deps**: pure ANSI escape codes; works in any terminal that
 *   supports VT100 (essentially every terminal in active use).
 *
 * Limitations (acceptable for v1; document in demo READMEs):
 * - Per-line buffering means responses appear in line chunks, not
 *   character-by-character. For most chat responses (< 20 lines) this
 *   is imperceptible. Long generations may feel slightly chunked.
 * - Nested markup (e.g. `**bold *italic*?**`) renders the outermost
 *   correctly; nested handling is best-effort.
 * - No table rendering, no image alt rendering, no link highlighting
 *   (links pass through as plain text — terminals already
 *   auto-linkify URLs).
 */

import { bulletParts, fenceParts, headingParts, numberedParts } from "./cli-markdown-lines";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

/** Heading levels 1..6 → color + bold. Level 0 is "no heading". */
const HEADING_COLORS: readonly string[] = [
  "",
  `${BOLD}${CYAN}`, // h1
  `${BOLD}${MAGENTA}`, // h2
  `${BOLD}${YELLOW}`, // h3
  BOLD, // h4
  BOLD, // h5
  BOLD, // h6
];

export interface StreamRenderer {
  /** Push an incoming text chunk. Renders + flushes completed lines. */
  push(chunk: string): void;
  /** Flush any remaining buffered content (no newline appended). */
  end(): void;
}

export interface RendererOptions {
  /** Override the output sink. Defaults to `process.stdout.write`. */
  readonly write?: (s: string) => void;
}

/**
 * Construct a streaming markdown renderer. Returns a `StreamRenderer` with
 * `push(chunk)` and `end()` methods.
 *
 * Usage:
 * ```ts
 * const r = createCliMarkdownRenderer();
 * r.push("hello **world**\n");
 * r.push("`code` ");
 * r.push("done\n");
 * r.end();
 * ```
 */
export function createCliMarkdownRenderer(opts: RendererOptions = {}): StreamRenderer {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  let buf = "";
  let inCodeFence = false;
  let codeFenceLang = "";

  function flushLine(line: string): void {
    write(`${renderLine(line)}\n`);
  }

  function renderLine(line: string): string {
    // Code-fence delimiter — toggles state, dims the fence itself. The line
    // parts are read by cli-markdown-lines.ts, which returns what each
    // pattern noted there captured, in linear time.
    const fence = fenceParts(line);
    if (fence) {
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceLang = fence[1];
        return `${fence[0]}${DIM}${GREEN}\`\`\`${codeFenceLang}${RESET}`;
      }
      inCodeFence = false;
      const langSuffix = codeFenceLang ? ` (${codeFenceLang})` : "";
      codeFenceLang = "";
      return `${fence[0]}${DIM}${GREEN}\`\`\`${langSuffix}${RESET}`;
    }
    if (inCodeFence) {
      // Inside a fenced block — dim everything; preserve indentation.
      return `${DIM}${line}${RESET}`;
    }
    // Headings
    const heading = headingParts(line);
    if (heading) {
      const [indent, hashes, text] = heading;
      const level = hashes.length;
      const color = HEADING_COLORS[level] ?? BOLD;
      return `${indent}${color}${renderInline(text)}${RESET}`;
    }
    // Unordered list bullets — replace marker with a pretty bullet.
    const bullet = bulletParts(line);
    if (bullet) {
      return `${bullet[0]}${CYAN}•${RESET} ${renderInline(bullet[1])}`;
    }
    // Ordered list — keep the number, color it.
    const numbered = numberedParts(line);
    if (numbered) {
      return `${numbered[0]}${CYAN}${numbered[1]}.${RESET} ${renderInline(numbered[2])}`;
    }
    // Blockquote
    const quote = /^(\s*)>\s?(.*)$/.exec(line);
    if (quote) {
      return `${quote[1] ?? ""}${DIM}│${RESET} ${ITALIC}${renderInline(quote[2] ?? "")}${RESET}`;
    }
    // Horizontal rule
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      return `${DIM}${"─".repeat(40)}${RESET}`;
    }
    return renderInline(line);
  }

  function renderInline(text: string): string {
    // Backtick-quoted inline code first (so its content isn't bold/italic-mangled).
    // We do a placeholder-swap pass: extract code spans, then re-insert after styling.
    const codeSpans: string[] = [];
    let working = text.replace(/`([^`]+?)`/g, (_match, content) => {
      codeSpans.push(content as string);
      return ` CODE${codeSpans.length - 1} `;
    });
    // Bold: **text** or __text__ — non-greedy, doesn't span newlines.
    working = working.replace(/\*\*([^*\n]+?)\*\*/g, (_m, t) => `${BOLD}${t}${RESET}`);
    working = working.replace(/__([^_\n]+?)__/g, (_m, t) => `${BOLD}${t}${RESET}`);
    // Italic: *text* or _text_ — guarded by word-boundary lookarounds so
    // list bullets ("- foo") and snake_case identifiers don't false-match.
    working = working.replace(
      /(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g,
      (_m, p, t) => `${p}${ITALIC}${t}${RESET}`,
    );
    working = working.replace(
      /(^|[^_\w])_([^_\n]+?)_(?!\w)/g,
      (_m, p, t) => `${p}${ITALIC}${t}${RESET}`,
    );
    // Restore inline code spans with styling.
    working = working.replace(/ CODE(\d+) /g, (_m, idx) => {
      const content = codeSpans[Number(idx)] ?? "";
      return `${DIM}${CYAN}\`${content}\`${RESET}`;
    });
    return working;
  }

  return {
    push(chunk: string): void {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        flushLine(line);
        nl = buf.indexOf("\n");
      }
    },
    end(): void {
      if (buf.length > 0) {
        // Tail content with no terminating newline — render in place.
        write(renderLine(buf));
        buf = "";
      }
    },
  };
}

/**
 * Decide whether to activate the CLI markdown renderer based on env.
 * Centralized so callers don't repeat the parse.
 */
export function isCliMarkdownEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env["CREWHAUS_CLI_MARKDOWN"];
  return v === "1" || v === "true";
}
