/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 2, §5.4) — an
 * answer cannot carry a line that passes for the gate's own verdict.
 *
 * Under `provability:` the gate renders its verdict as one line beside the
 * answer (`── provability · grounded ✓ · 6/6 claims · …`). The model can
 * write the same line into its answer: under `render: none` a failing answer
 * then ends on a ✓ no gate gave, and under `render: footer` the forged ✓ sits
 * directly above the real ✗. Every surface renders the same verdict only if
 * no answer text can pass for that rendering — so a line of the answer that
 * is shaped like the footer is served with a mark in front of it saying who
 * wrote it, on the stream as it prints and in the text the run returns. The
 * transcript keeps the model's own words (the gate grades them as they are:
 * a forged footer is one more uncited sentence).
 *
 * A footer-shaped line is read the way a reader sees it, not as bytes: format
 * characters (zero-width spaces and joiners) dropped, compatibility forms
 * folded (NFKC), case folded, the Cyrillic and Greek letters that look Latin
 * read as the Latin letters they look like ("рrovability" with a Cyrillic р
 * is "provability" to anyone reading it), and whatever opens the line before
 * its first letter or digit skipped — the markdown around it (quote markers,
 * list bullets and numbers, backticks, emphasis), an HTML tag, and any
 * symbol or punctuation (a bullet •, an emoji ✅, an arrow →, a middot, an
 * ellipsis). It is a line whose text then opens with the word `provability`
 * after a rule drawn in any dash (`──`, `——`, `--`, `══`) somewhere in that
 * opening, or opens with the word and carries a verdict mark (✓ ✗ and their
 * look-alikes). Prose that only mentions provability is left alone, and so
 * is a sentence that merely claims to be verified, which no line filter can
 * tell from an honest one.
 */

/** The mark a footer-shaped line of the answer is served with. */
export const FORGED_FOOTER_MARK = "(model-written, not the verdict) ";

const WORD = "provability";
/**
 * What a line can open with before it says anything: every character that
 * is not a letter or a digit (markdown, quoting, a bullet, an emoji, an
 * arrow, a rule), an HTML tag, and a list item's number. Skipped, never part
 * of what it says.
 */
const OPENING = /^(?:<\/?[a-z][^<>]{0,200}>|\d{1,3}[.)](?=\s)|[^\p{L}\p{N}])+/u;
/** A rule character: any dash punctuation, the box-drawing horizontals, the horizontal line extension, `=`. */
const RULE = /[\p{Pd}─━┄┅┈┉╌╍═⎯=]/u;
/**
 * Cyrillic, Greek and other letters drawn as a Latin lowercase letter (after
 * NFKC and lower-casing), and the letter they are read as.
 */
const LOOKALIKES: ReadonlyMap<string, string> = new Map(
  [
    // Cyrillic
    "аa",
    "бb",
    "ьb",
    "еe",
    "ёe",
    "һh",
    "іi",
    "їi",
    "ӏl",
    "јj",
    "кk",
    "оo",
    "рp",
    "ԛq",
    "сc",
    "ѕs",
    "тt",
    "уy",
    "ўy",
    "ѵv",
    "ԝw",
    "хx",
    "ԁd",
    // Greek
    "αa",
    "βb",
    "εe",
    "ιi",
    "ϊi",
    "ίi",
    "κk",
    "νv",
    "οo",
    "όo",
    "ρp",
    "ϲc",
    "τt",
    "υu",
    "ύu",
    "γy",
    "χx",
    "ϳj",
    // Armenian, Latin variants
    "օo",
    "սu",
    "ıi",
    "ɩi",
    "ʟl",
    "ɑa",
    "ɡg",
  ].map((pair) => [pair.slice(0, -1), pair.slice(-1)] as [string, string]),
);
const LOOKALIKE = new RegExp(`[${[...LOOKALIKES.keys()].join("")}]`, "gu");
/** A verdict mark: the ticks and crosses a footer prints, and the emoji and ballot-box look-alikes. */
const VERDICT_MARK = /[✓✔✅☑✗✘❌❎☒]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The line as a reader sees it: no format characters, compatibility forms
 * folded, lower case, look-alike letters read as the Latin ones they look
 * like.
 */
function visible(line: string): string {
  return line
    .replace(/\p{Cf}/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(LOOKALIKE, (ch) => LOOKALIKES.get(ch) ?? ch);
}

/** `text` past its opening (see {@link OPENING}): what it says, and whether a rule was drawn in it. */
function opening(text: string): { readonly rest: string; readonly ruled: boolean } {
  const opened = OPENING.exec(text);
  if (opened === null) return { rest: text, ruled: false };
  const skipped = opened[0].replace(/<[^<>]*>/g, "");
  return { rest: text.slice(opened[0].length), ruled: RULE.test(skipped) };
}

/** Is this ONE line (no line break in it) shaped like the provability footer? */
export function isFooterShaped(line: string): boolean {
  const seen = visible(line);
  const { rest, ruled } = opening(seen);
  if (!rest.startsWith(WORD)) return false;
  const next = rest.charAt(WORD.length);
  if (next !== "" && LETTER_OR_DIGIT.test(next)) return false;
  return ruled || VERDICT_MARK.test(rest);
}

/**
 * Where a line's opening stands while it streams: `plain` once nothing that
 * follows can make it footer-shaped, else `open` (the word, or the start of
 * it, is all it says so far).
 */
function prefixState(prefix: string): "plain" | "open" {
  const { rest } = opening(visible(prefix));
  if (rest.length <= WORD.length) return WORD.startsWith(rest) ? "open" : "plain";
  if (!rest.startsWith(WORD)) return "plain";
  return LETTER_OR_DIGIT.test(rest.charAt(WORD.length)) ? "plain" : "open";
}

const LINE_BREAK = /(\r\n|\r|\n|\u2028|\u2029)/;

/** `text` with each footer-shaped line marked as the model's (see the module doc). */
export function neutralizeFooterLines(text: string): string {
  if (!visible(text).includes(WORD)) return text;
  const pieces = text.split(LINE_BREAK);
  for (let i = 0; i < pieces.length; i += 2) {
    const line = pieces[i] as string;
    if (isFooterShaped(line)) pieces[i] = `${FORGED_FOOTER_MARK}${line}`;
  }
  return pieces.join("");
}

/** A streaming filter over the answer's text: see {@link createFooterLineGuard}. */
export type FooterLineGuard = {
  /** One chunk of streamed answer text. */
  push(chunk: string): void;
  /** The message ended: whatever the guard still holds is written, read as a whole line. */
  end(): void;
};

/**
 * The stream's half of {@link neutralizeFooterLines}: text passes straight
 * through to `write`, except the opening of a line that could still turn out
 * footer-shaped, which is held until it cannot (the next character settles
 * it for almost every line) or until the line ends, and then written marked
 * or as it was. Only such a line is ever delayed, and never past its own end.
 */
export function createFooterLineGuard(write: (text: string) => void): FooterLineGuard {
  /** The current line's opening, held back; `undefined` once the line is known plain. */
  let held: string | undefined = "";
  const flushLine = (line: string): void => {
    write(isFooterShaped(line) ? `${FORGED_FOOTER_MARK}${line}` : line);
  };
  return {
    push(chunk) {
      let rest = chunk;
      while (rest.length > 0) {
        const at = rest.search(LINE_BREAK);
        const body = at === -1 ? rest : rest.slice(0, at);
        const breakLength = at === -1 ? 0 : rest.startsWith("\r\n", at) ? 2 : 1;
        const lineBreak = at === -1 ? "" : rest.slice(at, at + breakLength);
        rest = at === -1 ? "" : rest.slice(at + breakLength);
        if (held === undefined) {
          write(body + lineBreak);
        } else if (at !== -1) {
          flushLine(held + body);
          write(lineBreak);
        } else {
          const opened = held + body;
          if (prefixState(opened) === "plain") {
            write(opened);
            held = undefined;
          } else {
            held = opened;
          }
          continue;
        }
        // A line break ends the line: the next one opens held.
        if (at !== -1) held = "";
      }
    },
    end() {
      if (held !== undefined && held !== "") flushLine(held);
      held = "";
    },
  };
}
