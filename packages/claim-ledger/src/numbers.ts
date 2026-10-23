/**
 * Values a claim states, and whether a tool's result states them too.
 *
 * The `checked` rung (design §6.3) asks one question of an execution
 * binding: does the result the claim cites contain the claim's values? "The
 * total is 1,284.50" citing a `MoneyAdd` whose result reads `1284.5` does;
 * one whose result reads `1284.05` does not, however close the words are.
 * Numbers are compared as numbers here, quotations as runs of words
 * (`quotes.ts`).
 *
 * A number is compared as a normalized decimal string — exact, never a
 * float: `1,284.50`, `1284.50` and `1284.5` are one value, and `0.1 + 0.2`
 * never enters into it. What is a number is decided from the characters
 * alone, and every shape that would need a guess is left out:
 *
 * - Grouping commas only in the one unambiguous shape, `1,284` or
 *   `12,345,678.9` (one to three digits, then groups of exactly three). `1,5`
 *   is a list or a European decimal and `1.284,50` is either locale's figure;
 *   both are left out rather than read as the wrong one, the rule
 *   tool-verify's tokenizer already follows. A space never groups: `1 284` is
 *   two numbers.
 * - A dot is a decimal point. A run with two dots — `1.2.3`, `10.0.0.1` — is
 *   a version or an address, an identifier rather than a quantity, and is not
 *   a number at all. Neither is a run glued to a letter in front (`v1.2.3`,
 *   `A1`, `sha256`) or to letters-then-digits behind (`0x1F`, `4K60`). A
 *   hyphen is not a letter, so `COVID-19` states 19; a unit behind is fine,
 *   so `5km` states 5. A leading point (`.5`) is not read: write `0.5`.
 * - A sign is a sign only where a word cannot end: `-3`, `(−3)` and `-$4`
 *   are negative, while `2024-01-15` is three numbers and none of them is.
 * - A percent sign and a currency symbol are dropped: `12%` is `12`, `$4.20`
 *   is `4.2`. A claim of "12%" against a result of `12` is a claim about that
 *   value; the locate kernel, which compares wording, keeps the sign instead.
 * - An exponent is applied exactly: `1.5e3` is `1500` (a JSON tool result
 *   writes `1e-7` for 0.0000001). A value whose decimal form would run past
 *   40 characters is written `d.ddde±n` instead, the same way on both sides
 *   of a comparison, so `1e300` costs what it is written in.
 * - Years are numbers like any other: `2024` is `2024`. Only ASCII digits
 *   are read.
 * - An ISO date and a time of day are values of their own besides their
 *   parts (`compoundValues`): `2025-04-03` states 2025, 4 and 3, and the date
 *   `2025-04-03`, so a claim of `2025-03-04` is not contained in a result
 *   that says `2025-04-03`, though every part is. Only the shapes that need
 *   no guess: `YYYY-MM-DD`, and `H:MM` or `HH:MM` with optional seconds. A
 *   slash date is either locale's, `3:1` is a ratio or a score, and `10-20`
 *   a range; their parts are read, and nothing whole.
 */
/** A character a number may not be glued to in front: then it is part of a word. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * A digit run with the separators inside it, never ending on one: the
 * sentence's own full stop after `12.` is not a decimal point.
 */
const NUMERIC_RUN = /\d(?:[\d.,]*\d)?/g;

const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const PLAIN = /^\d+(?:\.\d+)?$/;
const EXPONENT = /^[eE]([+-]?)(\d{1,4})(?![\p{L}\p{N}_])/u;

/** `-` and the Unicode minus sign, U+2212. */
const MINUS = /^[-−]$/;
/** What may sit between a sign and its digits: a currency symbol. */
const CURRENCY = /^\p{Sc}$/u;

/** Past this many characters a decimal form is written in scientific notation. */
const MAX_DECIMAL_CHARS = 40;

/**
 * Digits, a fractional part and an exponent as one exact canonical string:
 * no leading zeros, no trailing fractional zeros, no trailing point, and
 * `-0` read as `0`. Built from the significant digits and where the point
 * falls, never by padding first, so the cost is the length written.
 *
 * The zeros are counted off each end by hand. `replace(/0+$/, "")` retried
 * from every zero of a run that a non-zero digit follows ("1" + 80,000 zeros
 * + "1" took seconds), and a fetched page or a tool result reaches this on
 * every gated turn (design §10: no super-linear work on untrusted text).
 */
function canonical(negative: boolean, whole: string, fraction: string, exponent: number): string {
  let digits = `${whole}${fraction}`;
  // The value is 0.<digits> × 10^point.
  let point = whole.length + exponent;
  let lead = 0;
  while (lead < digits.length && digits.charCodeAt(lead) === 48) lead++;
  let tail = digits.length;
  while (tail > lead && digits.charCodeAt(tail - 1) === 48) tail--;
  digits = digits.slice(lead, tail);
  point -= lead;
  if (digits === "") return "0";
  const size =
    point <= 0 ? 2 - point + digits.length : point >= digits.length ? point : digits.length + 1;
  let magnitude: string;
  if (size > MAX_DECIMAL_CHARS) {
    const rest = digits.slice(1);
    magnitude = `${digits[0]}${rest === "" ? "" : `.${rest}`}e${point - 1}`;
  } else if (point <= 0) {
    magnitude = `0.${"0".repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    magnitude = digits + "0".repeat(point - digits.length);
  } else {
    magnitude = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  return negative ? `-${magnitude}` : magnitude;
}

/**
 * Is the number whose first digit is at `at` negative? A `-` or `−` before
 * it, optionally across a currency symbol (`-3`, `−3`, `-$4`, `$-5`), and
 * only when the sign could not end a word: `2024-01-15` and `COVID-19` are
 * not negative. The locate kernel's figure rule reads a source's and a
 * claim's signs with this too, so `grounded` and `checked` agree that 500
 * is not -500.
 */
export function signedAt(text: string, at: number): boolean {
  let i = at - 1;
  if (i >= 0 && CURRENCY.test(text[i] as string)) i--;
  if (i < 0 || !MINUS.test(text[i] as string)) return false;
  return i === 0 || !WORD_CHAR.test(text[i - 1] as string);
}

/** Every number `text` states, normalized, in the order stated. */
function* scanNumbers(text: string): Generator<string> {
  // An exponent's digits are part of the number before them, not one of their own.
  let consumed = 0;
  for (const m of text.matchAll(NUMERIC_RUN)) {
    const at = m.index as number;
    const run = m[0];
    if (at < consumed) continue;
    if (at > 0) {
      const before = text[at - 1] as string;
      // `v1.2`, `A1`, `h264`: the digits belong to a word. `.5`: not read.
      if (before === "." || WORD_CHAR.test(before)) continue;
    }
    let whole: string;
    let fraction: string;
    if (PLAIN.test(run)) [whole = "", fraction = ""] = run.split(".");
    else if (GROUPED.test(run)) [whole = "", fraction = ""] = run.replace(/,/g, "").split(".");
    // `1.2.3`, `1,5`, `1.284,50`: a version, a list, or a locale's figure.
    else continue;
    const after = text.slice(at + run.length, at + run.length + 8);
    let exponent = 0;
    const exp = EXPONENT.exec(after);
    if (exp !== null) {
      exponent = (exp[1] === "-" ? -1 : 1) * Number(exp[2]);
      consumed = at + run.length + exp[0].length;
    }
    // `0x1F`, `4K60`: letters and then digits again — an identifier.
    else if (/^[\p{L}_]+\d/u.test(after)) continue;
    yield canonical(signedAt(text, at), whole, fraction, exponent);
  }
}

/** An ISO date: four digits, two, two, not running on into more digits. */
const ISO_DATE = /(\d{4})-(\d{2})-(\d{2})(?!\d|[-:./]\d)/g;
/** A time of day, `H:MM` or `HH:MM`, seconds optional, not running on. */
const TIME_OF_DAY = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d|:\d)/g;
/** What a date or a time may not follow: then it is inside a word, a
 *  version, a path or a longer run (read here, not by a lookbehind, so the
 *  patterns stay ones tool-verify's regex-work model reads). */
const COMPOUND_JOINER = /^[.:/-]$/;

/** May a date or a time start at `at`? Not glued to a word or a joiner —
 *  except a time right after an ISO date's `T` (`2025-04-03T10:30`). */
function opensCompound(text: string, at: number, time: boolean): boolean {
  if (at === 0) return true;
  const before = text[at - 1] as string;
  if (time && before === "T" && at >= 2 && /\d/.test(text[at - 2] as string)) return true;
  return !WORD_CHAR.test(before) && !COMPOUND_JOINER.test(before);
}

/** A value stated whole: where it is written in the text, and its key. */
export type CompoundValue = {
  readonly at: number;
  readonly end: number;
  /** `2025-04-03`; a time as `10:30`, the hour without a leading zero and
   *  seconds only when they are not `00` (`9:05`, `10:30:15`). */
  readonly key: string;
  /** Its parts as numbers (`2025`, `4`, `3`): stated by it, even where the
   *  scanner reads no number (the day of `2025-04-03T10:30`, glued to `T`). */
  readonly parts: ReadonlyArray<string>;
};

/**
 * Every ISO date and time of day `text` states, in order, each as one value
 * (design §6.3: the result contains the claim's VALUES). The parts are
 * numbers too, and `extractNumbers` reads them as such: what a compound adds
 * is their order, so a day and a month swapped, or a time put together from
 * the hour of one and the minutes of another ("10:30" from "10:00 … 18:30"),
 * is a value the text does not state. Out-of-range parts (`2025-13-40`,
 * `25:61`) are not a date or a time, and are left as their numbers.
 */
export function compoundValues(text: string): CompoundValue[] {
  const out: CompoundValue[] = [];
  for (const m of text.matchAll(ISO_DATE)) {
    const at = m.index as number;
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!opensCompound(text, at, false) || month < 1 || month > 12 || day < 1 || day > 31) continue;
    out.push({
      at,
      end: at + m[0].length,
      key: m[0],
      parts: [String(Number(m[1])), `${month}`, `${day}`],
    });
  }
  for (const m of text.matchAll(TIME_OF_DAY)) {
    const at = m.index as number;
    const hour = Number(m[1]);
    const seconds = m[3];
    if (!opensCompound(text, at, true)) continue;
    if (hour > 23 || Number(m[2]) > 59 || (seconds !== undefined && Number(seconds) > 59)) continue;
    const key = `${hour}:${m[2]}${seconds === undefined || seconds === "00" ? "" : `:${seconds}`}`;
    const parts = [
      `${hour}`,
      `${Number(m[2])}`,
      ...(seconds === undefined ? [] : [`${Number(seconds)}`]),
    ];
    out.push({ at, end: at + m[0].length, key, parts });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The values `text` states, distinct: its numbers as normalized decimal
 * strings, in the order first stated, then each ISO date and time of day
 * with its parts and whole (`compoundValues`): `"The total is $1,284.50, up
 * 12%"` → `["1284.5", "12"]`, `"due 2025-04-03"` → `["2025", "4", "3",
 * "2025-04-03"]`. Pass a claim's `text` (markers stripped), not its `raw`:
 * `[1]` is a citation, not a figure.
 */
export function extractNumbers(text: string): string[] {
  const compounds = compoundValues(text).flatMap(({ key, parts }) => [...parts, key]);
  return [...new Set([...scanNumbers(text), ...compounds])];
}

/**
 * One written value, normalized the way `extractNumbers` normalizes it, or
 * `null` when the string is not exactly one value (`"v1.2.3"`, `"1 284"`,
 * `"twelve"`). A date or a time written alone is its key (`"09:05:00"` →
 * `"9:05"`).
 */
export function normalizeNumber(written: string): string | null {
  const trimmed = written.trim();
  if (trimmed.includes("-") || trimmed.includes(":")) {
    const [whole] = compoundValues(trimmed);
    if (whole !== undefined && whole.at === 0 && whole.end === trimmed.length) return whole.key;
  }
  const found = [...scanNumbers(trimmed)];
  return found.length === 1 ? (found[0] as string) : null;
}

/**
 * Does `haystack` state `value`? Compared as normalized decimals, so
 * `containsValue("total: 1284.50", "1,284.5")` is true and
 * `containsValue("total: 1284.05", "1284.5")` is false; a date or a time
 * is compared whole, so `containsValue("2025-04-03", "2025-03-04")` is false.
 * `value` may be one `extractNumbers` returned or a written value; anything
 * that is not exactly one value is contained nowhere. Pass a `Set` of
 * `extractNumbers` as the haystack to test many values against one result.
 */
export function containsValue(haystack: string | ReadonlySet<string>, value: string): boolean {
  const wanted = normalizeNumber(value);
  if (wanted === null) return false;
  if (typeof haystack !== "string") return haystack.has(wanted);
  for (const found of scanNumbers(haystack)) if (found === wanted) return true;
  return compoundValues(haystack).some(
    ({ key, parts }) => key === wanted || parts.includes(wanted),
  );
}

/**
 * Cardinal number words and the value each names.
 *
 * Only for the locate kernel's figure rule (`locate.ts`), where a claim's
 * figures must sit in the span that carries its words: without these,
 * "thirty days" against a source saying 14 lost only one ordinary word and
 * cleared a 0.8 bar. A word names its value there, so "thirty" and "30" are
 * the same figure. Nothing composes: "thirty-five" is two tokens, 30 and 5,
 * and a source saying 35 carries neither — a figure missed, never a wrong
 * one matched. `extractNumbers` reads none of these: a tool result prints
 * digits, and the `checked` rung compares digits.
 */
const CARDINAL_WORDS: ReadonlyMap<string, string> = new Map([
  ["zero", "0"],
  ["one", "1"],
  ["two", "2"],
  ["three", "3"],
  ["four", "4"],
  ["five", "5"],
  ["six", "6"],
  ["seven", "7"],
  ["eight", "8"],
  ["nine", "9"],
  ["ten", "10"],
  ["eleven", "11"],
  ["twelve", "12"],
  ["thirteen", "13"],
  ["fourteen", "14"],
  ["fifteen", "15"],
  ["sixteen", "16"],
  ["seventeen", "17"],
  ["eighteen", "18"],
  ["nineteen", "19"],
  ["twenty", "20"],
  ["thirty", "30"],
  ["forty", "40"],
  ["fifty", "50"],
  ["sixty", "60"],
  ["seventy", "70"],
  ["eighty", "80"],
  ["ninety", "90"],
  ["hundred", "100"],
  ["thousand", "1000"],
  ["million", "1000000"],
  ["billion", "1000000000"],
  ["trillion", "1000000000000"],
  ["dozen", "12"],
]);

/**
 * Words that state a figure without naming one value: the ordinals and
 * "half". Compared as spelled — "third" is a rank and a fraction, and
 * neither is the number 3.
 *
 * "second" is left out on purpose: it is a unit of time as often as a rank
 * ("within seconds" folds to it), and a unit the source does not repeat is
 * not a figure the claim got wrong. "Ranked second" against a source saying
 * fifth is therefore one ordinary word short, the one gap this list keeps.
 */
const ORDINAL_WORDS: ReadonlySet<string> = new Set([
  "first",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth",
  "hundredth",
  "thousandth",
  "millionth",
  "billionth",
]);

/**
 * Magnitude suffixes and the value each names: the same values as the
 * cardinal words "thousand", "million", "billion" and "trillion", so "$5M"
 * and "$5 million" state one figure.
 *
 * Only for the locate kernel's figure rule, and only glued to a numeral:
 * "5M" is "5" and "m" to its tokenizer, and an "m" the 0.8 bar may let go
 * grounded "$5M" in a source saying "$5B" (design §6.2, acceptance A). Read
 * without case, so "5m" of metres or minutes is a million too: a claim that
 * spells its unit unlike the source ("5m" against "5 metres") is a figure
 * missed, never a wrong one matched. `extractNumbers` reads none of these
 * ("5km states 5"); a tool result prints its digits.
 */
const MAGNITUDE_SUFFIXES: ReadonlyMap<string, string> = new Map([
  ["k", "1000"],
  ["m", "1000000"],
  ["mn", "1000000"],
  ["b", "1000000000"],
  ["bn", "1000000000"],
  ["t", "1000000000000"],
]);

/**
 * The value a lowercase magnitude suffix names (`k` → `1000`, `bn` →
 * `1000000000`), or null. The caller decides it is glued to a numeral: on
 * its own, "Plan B" names no billion.
 */
export function magnitudeSuffix(word: string): string | null {
  return MAGNITUDE_SUFFIXES.get(word) ?? null;
}

/** A word that states a figure, and how it is compared. */
export type FigureWord = {
  /** What it is compared as: a cardinal's value (`thirty` → `30`), else its spelling. */
  readonly key: string;
  /** An ordinal, which can also count the points of a list ("First, …"). */
  readonly ordinal: boolean;
};

/**
 * The figure a single lowercase word states — a cardinal (`thirty`, `dozen`,
 * `million`), an ordinal (`third`, `first`) or `half` — or null. Takes the
 * word as the locate kernel's `normalizeToken` leaves it, so a folded plural
 * (`millions` → `million`, `thirds` → `third`) is read too.
 */
export function figureWord(word: string): FigureWord | null {
  const value = CARDINAL_WORDS.get(word);
  if (value !== undefined) return { key: value, ordinal: false };
  if (ORDINAL_WORDS.has(word)) return { key: word, ordinal: true };
  if (word === "half") return { key: word, ordinal: false };
  return null;
}
