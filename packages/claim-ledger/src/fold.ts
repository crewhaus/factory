/**
 * The characters every comparison here reads: one fold, one character for
 * one character.
 *
 * A claim, a fetched body, a tool result and a proof's recorded claim are
 * compared as words and as values, and a comparison over the characters as
 * written lets a spelling the reader cannot see decide it (design §1: the
 * model can be wrong about everything and the gate still holds; §6.2, §6.4).
 * "The refund window is ３０ days", "٣٠ days" and "𝟑𝟎 days" state 30 to
 * anyone reading them, and a number layer that read only ASCII digits read
 * no figure there at all, so a wrong one grounded under the 0.8 bar and was
 * contained in any result at `checked`. "n\u200Bot", "ｎｏｔ" and a "nоt"
 * spelled with a Cyrillic о read as "not", and a polarity check that matched
 * the token as written saw no negation. So before anything is tokenized or
 * read as a number, this folds:
 *
 * - curly quotes to straight ones, as the locate kernel always has;
 * - every decimal digit, in any script (`\p{Nd}`: Arabic-Indic, Devanagari,
 *   fullwidth, mathematical), to its ASCII digit, and the Arabic decimal and
 *   thousands separators to `.` and `,`;
 * - a run of superscript or subscript digits that stands where a number
 *   would — at the start or after whitespace, with a word after it ("³⁰
 *   days") — to its digits. Any other is an exponent or a footnote mark
 *   ("10⁶", "rose¹", "purchase.¹", "purchase ¹") and is left as written:
 *   read as digits it would make "10⁶" the number 106, and a footnote a
 *   figure the source must hold;
 * - fullwidth ASCII (`ｎｏｔ`, `＄`) and the mathematical letters (`𝗻𝗼𝘁`) to
 *   the ASCII they are styled from;
 * - inside a word that mixes Latin letters with Cyrillic or Greek ones, the
 *   Cyrillic and Greek letters that look Latin to the Latin letters they look
 *   like, and inside one that mixes digits with them, a letter drawn as a
 *   digit (`З`, `О`) before a digit to that digit: no word is written so,
 *   and "nоt" or "З0" is that or a disguise. A word wholly in one script is
 *   never touched, so a lookalike word ("ЗО" in Cyrillic letters) is the
 *   Cyrillic word it is — the one disguise this keeps;
 * - a character Unicode marks default-ignorable (a zero-width space or joiner,
 *   a soft hyphen, a word joiner, a variation selector) is moved to the end
 *   of the word it sits in, so "n\u200Bot" is the word "not".
 *
 * Nothing is guessed: a numeral that needs a locale to read stays what the
 * number layer makes of it (`numbers.ts`), and a circled or fractional
 * numeral (`㉚`, `½`) has no one-character digits and is left as written —
 * the figure rule compares it as written (`figureKey`).
 *
 * One for one is load-bearing: every offset the locate kernel and the
 * number layer report is an offset into the folded text, and a line number
 * or an excerpt is cut from it, so the fold keeps every UTF-16 length. An
 * astral character folded to ASCII (`𝟑` is two code units) keeps its second
 * unit as a zero-width space, which the last step moves to the end of the
 * word. Folding twice is folding once.
 *
 * Linear in the text, and a text with nothing outside ASCII is returned as
 * it came after one scan: a fetched page and a tool result reach this on
 * every gated turn (design §10).
 */

/** Anything outside ASCII: without one there is nothing to fold. */
const NON_ASCII = /[^\p{ASCII}]/u;

/** What the per-character step maps: curly quotes, the Arabic separators,
 *  fullwidth ASCII, every decimal digit outside ASCII and the mathematical
 *  alphanumerics. */
const MAPPED =
  /[\u2018\u2019\u201b\u201c\u201d\u201e\u201f\u066b\u066c\uff01-\uff5e]|(?![0-9])\p{Nd}|[\u{1d400}-\u{1d7ff}]/gu;

const DECIMAL_DIGIT = /^\p{Nd}$/u;

/** A run of superscript digits, or of subscript ones. */
const SCRIPT_DIGITS = /[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+|[\u2080-\u2089]+/g;
const SCRIPT_DIGIT: Readonly<Record<string, string>> = {
  "\u2070": "0",
  "\u00b9": "1",
  "\u00b2": "2",
  "\u00b3": "3",
  "\u2074": "4",
  "\u2075": "5",
  "\u2076": "6",
  "\u2077": "7",
  "\u2078": "8",
  "\u2079": "9",
};
/** What may stand after a superscript run that is a number: whitespace and
 *  then a word, or a line's end and the next line. */
const NUMBER_FOLLOWS = /^[ \t ]+[\p{L}\p{N}]|^\r?\n/u;

/**
 * Does the superscript or subscript run at `at` stand where a number would:
 * at the text's start or after whitespace, with a word or a new line after
 * it ("³⁰ days")? One glued to a word or a numeral is an exponent or a
 * footnote mark ("10⁶", "rose¹"), and so is one after punctuation or a
 * closing bracket, or with nothing or punctuation after it: "…of
 * purchase.¹", "…of purchase ¹", "(see ¹)" mark a footnote, and read as
 * digits they would put a 1 the source must then hold into the claim.
 */
function standsAsNumber(text: string, at: number, length: number): boolean {
  if (at > 0 && !/\s/.test(text[at - 1] as string)) return false;
  return NUMBER_FOLLOWS.test(text.slice(at + length, at + length + 3));
}

/** The second code unit an astral character folded to ASCII leaves behind. */
const FILLER = "\u200b";

/** A word, with whatever ignorable characters sit in it. */
const WORD = /[\p{L}\p{N}\p{M}\p{Default_Ignorable_Code_Point}]+/gu;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const IGNORABLES = /\p{Default_Ignorable_Code_Point}/gu;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC_OR_GREEK = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}]/gu;

/** Cyrillic and Greek letters drawn as a Latin one, and that Latin letter. */
const LATIN_LOOKALIKES: ReadonlyMap<string, string> = new Map(
  [
    // Cyrillic
    "аa",
    "еe",
    "оo",
    "рp",
    "сc",
    "уy",
    "хx",
    "іi",
    "јj",
    "ѕs",
    "ԁd",
    "һh",
    "ԛq",
    "ԝw",
    "ӏl",
    "АA",
    "ВB",
    "ЕE",
    "КK",
    "МM",
    "НH",
    "ОO",
    "РP",
    "СC",
    "ТT",
    "ХX",
    "УY",
    "ІI",
    "ЈJ",
    "ЅS",
    // Greek
    "αa",
    "οo",
    "νv",
    "ιi",
    "κk",
    "ρp",
    "υu",
    "χx",
    "ϲc",
    "ϳj",
    "ΑA",
    "ΒB",
    "ΕE",
    "ΖZ",
    "ΗH",
    "ΙI",
    "ΚK",
    "ΜM",
    "ΝN",
    "ΟO",
    "ΡP",
    "ΤT",
    "ΧX",
    "ΥY",
  ].map((pair) => [pair.slice(0, -1), pair.slice(-1)] as [string, string]),
);

/** Cyrillic and Greek letters drawn as a digit, and that digit. */
const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = {
  "\u0417": "3",
  "\u0437": "3",
  "\u041e": "0",
  "\u043e": "0",
  "\u039f": "0",
  "\u03bf": "0",
};

/**
 * A word with each letter drawn as a digit that a digit follows (across
 * other such letters) read as that digit: "З0" is 30. One a digit only
 * precedes is a suffix, not a digit — the Greek ordinal "1ος" stays first.
 * Read from the end, once.
 */
function digitLookalikes(word: string): string {
  const out: string[] = [];
  let digitAfter = false;
  for (let i = word.length - 1; i >= 0; i--) {
    const ch = word[i] as string;
    const digit = DIGIT_LOOKALIKES[ch];
    if (digit !== undefined && digitAfter) out.push(digit);
    else {
      digitAfter = digit !== undefined ? digitAfter : /[0-9]/.test(ch);
      out.push(ch);
    }
  }
  return out.reverse().join("");
}

/** Each non-ASCII decimal digit's value, worked out once. */
const DIGIT_VALUES = new Map<number, string>();

/**
 * The ASCII digit a decimal digit of another script is. Unicode assigns
 * every script's digits as one run of ten, zero first, so a digit's value is
 * its distance from the start of the run of digits it sits in, modulo ten
 * (runs that touch, as the mathematical ones do, are whole runs).
 */
function digitValue(code: number): string {
  let value = DIGIT_VALUES.get(code);
  if (value === undefined) {
    let start = code;
    while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--;
    value = String((code - start) % 10);
    DIGIT_VALUES.set(code, value);
  }
  return value;
}

/** One character's fold, as many code units long as it is. */
function foldCharacter(ch: string): string {
  switch (ch) {
    case "\u2018":
    case "\u2019":
    case "\u201b":
      return "'";
    case "\u201c":
    case "\u201d":
    case "\u201e":
    case "\u201f":
      return '"';
    case "\u066b":
      return ".";
    case "\u066c":
      return ",";
  }
  const code = ch.codePointAt(0) as number;
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  let folded: string;
  if (DECIMAL_DIGIT.test(ch)) folded = digitValue(code);
  else {
    // A mathematical letter is its letter in a font: NFKC says which.
    folded = ch.normalize("NFKC");
    if (folded.length !== 1) return ch;
  }
  return ch.length === 2 ? `${folded}${FILLER}` : folded;
}

/** A word with its ignorables moved to its end, and its lookalikes read as Latin where it mixes scripts. */
function foldWord(word: string): string {
  let out = word;
  if (CYRILLIC_OR_GREEK.test(out)) {
    // Before a digit, a letter drawn as one is that digit ("З0" is 30).
    if (/[0-9]/.test(out)) out = digitLookalikes(out);
    if (LATIN.test(out)) out = out.replace(LOOKALIKE, (ch) => LATIN_LOOKALIKES.get(ch) ?? ch);
  }
  if (IGNORABLE.test(out)) {
    const moved = out.match(IGNORABLES) ?? [];
    out = `${out.replace(IGNORABLES, "")}${moved.join("")}`;
  }
  return out;
}

/** `text` folded as the module comment says, one character for one character. */
export function foldText(text: string): string {
  if (!NON_ASCII.test(text)) return text;
  let out = text.replace(MAPPED, foldCharacter);
  const scripted = out;
  out = out.replace(SCRIPT_DIGITS, (run, at: number) =>
    standsAsNumber(scripted, at, run.length)
      ? [...run].map((ch) => SCRIPT_DIGIT[ch] ?? String(ch.charCodeAt(0) - 0x2080)).join("")
      : run,
  );
  return out.replace(WORD, foldWord);
}
