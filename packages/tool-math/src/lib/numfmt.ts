/**
 * Locale-aware number formatting and parsing, on top of `Intl`.
 *
 * Determinism caveat, stated plainly because it is the one place in this
 * package where the answer depends on something other than the input: the
 * exact glyphs come from the ICU data compiled into the runtime. The same
 * runtime always produces the same bytes for the same input, but a different
 * Bun or Node build can ship different CLDR data, and a few locales have
 * changed their grouping or currency symbols between releases. Nothing else
 * in this package has that property.
 *
 * The locale is always REQUIRED and is validated up front. `Intl` silently
 * falls back to the host default for an unknown tag, which would make the
 * output depend on the machine's environment — refused here instead.
 *
 * Parsing is the inverse and is built from the same `Intl` data rather than
 * from a guess: the grouping separator, the decimal separator, the minus sign
 * and the numbering system's digits are read out of
 * `Intl.NumberFormat(locale).formatToParts(...)`, so "1.234,56" parses to
 * 1234.56 under de-DE and is REFUSED under en-US, where it is not a number.
 * That refusal is the point; guessing turns a thousands separator into a
 * decimal point and changes an invoice by three orders of magnitude.
 */

export class NumberFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NumberFormatError";
  }
}

/** Reject a tag `Intl` does not actually support, instead of falling back. */
export function assertSupportedLocale(locale: string): string {
  let canonical: string[];
  try {
    canonical = Intl.NumberFormat.supportedLocalesOf([locale]);
  } catch (err) {
    throw new NumberFormatError(
      `"${locale}" is not a valid BCP 47 locale tag: ${(err as Error).message}`,
    );
  }
  const resolved = canonical[0];
  if (resolved === undefined) {
    throw new NumberFormatError(
      `this runtime has no data for the locale "${locale}", and falling back to the machine's default would make the result depend on where it ran`,
    );
  }
  return resolved;
}

export type FormatOptions = {
  locale: string;
  style: "decimal" | "currency" | "percent";
  currency?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  useGrouping?: boolean;
  notation?: "standard" | "compact" | "scientific" | "engineering";
  currencyDisplay?: "symbol" | "code" | "name" | "narrowSymbol";
  signDisplay?: "auto" | "always" | "never" | "exceptZero";
};

export type FormatResult = {
  formatted: string;
  locale: string;
  resolved: Intl.ResolvedNumberFormatOptions;
  note: string;
};

export function formatNumber(value: number, options: FormatOptions): FormatResult {
  if (!Number.isFinite(value)) {
    throw new NumberFormatError(`value must be a finite number, got ${value}`);
  }
  const locale = assertSupportedLocale(options.locale);
  if (options.style === "currency" && options.currency === undefined) {
    throw new NumberFormatError('style "currency" needs a currency code, e.g. "EUR"');
  }
  const init: Intl.NumberFormatOptions = { style: options.style };
  if (options.currency !== undefined) init.currency = options.currency;
  if (options.currencyDisplay !== undefined) init.currencyDisplay = options.currencyDisplay;
  if (options.minimumFractionDigits !== undefined) {
    init.minimumFractionDigits = options.minimumFractionDigits;
  }
  if (options.maximumFractionDigits !== undefined) {
    init.maximumFractionDigits = options.maximumFractionDigits;
  }
  if (options.useGrouping !== undefined) init.useGrouping = options.useGrouping;
  if (options.notation !== undefined) init.notation = options.notation;
  if (options.signDisplay !== undefined) init.signDisplay = options.signDisplay;
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, init);
  } catch (err) {
    throw new NumberFormatError(`Intl rejected these options: ${(err as Error).message}`);
  }
  return {
    formatted: formatter.format(value),
    locale,
    resolved: formatter.resolvedOptions(),
    note: "glyphs come from the runtime's ICU/CLDR data; identical for a given runtime, not guaranteed identical across runtime versions",
  };
}

type LocaleParts = {
  group: string;
  decimal: string;
  minus: string;
  digits: string[];
  numberingSystem: string;
};

/** Read a locale's separators and digits out of Intl rather than assuming them. */
export function localeNumberParts(locale: string): LocaleParts {
  const formatter = new Intl.NumberFormat(locale, { useGrouping: true });
  const parts = formatter.formatToParts(-12345.6);
  let group = "";
  let decimal = ".";
  let minus = "-";
  for (const part of parts) {
    if (part.type === "group") group = part.value;
    else if (part.type === "decimal") decimal = part.value;
    else if (part.type === "minusSign") minus = part.value;
  }
  const digitFormatter = new Intl.NumberFormat(locale, { useGrouping: false });
  const digits = Array.from({ length: 10 }, (_, i) => digitFormatter.format(i));
  return {
    group,
    decimal,
    minus,
    digits,
    numberingSystem: formatter.resolvedOptions().numberingSystem,
  };
}

export type ParseResult = {
  value: number;
  locale: string;
  /** The plain decimal string the input reduced to, before Number() saw it. */
  normalized: string;
  hadPercentSign: boolean;
  /** value/100 when a percent sign was present, so neither reading is implicit. */
  asFraction: number | null;
  currencySymbolStripped: string | null;
  note: string;
};

/**
 * Parse a number written for `locale`.
 *
 * The steps, in order, each of which can refuse:
 *   1. strip whitespace (including the narrow no-break space many locales use
 *      as a group separator), a percent sign, and a leading/trailing currency
 *      symbol — each is reported back rather than silently dropped;
 *   2. map the locale's digits to ASCII and its minus sign to "-";
 *   3. split on the locale's decimal separator (more than one is an error);
 *   4. validate the GROUPING of the integer part before removing separators:
 *      groups after the first must be 2 or 3 digits (2 covers the Indian
 *      system) and the first 1 to 3. This is what stops "1234.56" from being
 *      read as 123456 under de-DE, where "." is the group separator;
 *   5. require the fractional part to be digits only.
 *
 * Accounting parentheses — (1,234.00) — are read as a negative.
 */
export function parseLocaleNumber(text: string, locale: string): ParseResult {
  const resolvedLocale = assertSupportedLocale(locale);
  if (text.length > 1_000) {
    throw new NumberFormatError(
      `the input is ${text.length} characters, far longer than any number`,
    );
  }
  const parts = localeNumberParts(resolvedLocale);
  const refuse = (why: string, working: string): never => {
    throw new NumberFormatError(
      `"${text}" is not a number in ${resolvedLocale}: ${why} (normalized: "${working}")`,
    );
  };
  let working = text.trim();
  if (working.length === 0) throw new NumberFormatError("the input is empty");

  // Several Unicode minus signs and spaces render identically to the ASCII ones.
  working = working
    .replace(/[\u2212\u2012\u2013]/g, "-")
    .replace(new RegExp(escapeRegExp(parts.minus), "g"), "-");

  let hadPercent = false;
  if (/[%\u066a\u2030]/.test(working)) {
    hadPercent = true;
    working = working.replace(/[%\u066a\u2030]/g, "");
  }
  let parenthesised = false;
  const parenthesisMatch = working.match(/^\((.*)\)$/);
  if (parenthesisMatch !== null) {
    parenthesised = true;
    working = parenthesisMatch[1] as string;
  }
  // Locale digits to ASCII, before anything counts characters as digits.
  for (let d = 0; d < 10; d++) {
    const glyph = parts.digits[d] as string;
    if (glyph !== String(d)) working = working.split(glyph).join(String(d));
  }
  // Anything that is not a digit, a sign, a separator or an exponent marker is
  // taken to be a currency symbol or unit, stripped and reported.
  const separators = `${escapeRegExp(parts.group)}${escapeRegExp(parts.decimal)}`;
  const strip = new RegExp(`[^0-9+\\-eE${separators}]+`, "g");
  const stripped = working.match(strip);
  const currencySymbol = stripped === null ? null : stripped.join("").trim() || null;
  working = working.replace(strip, "");
  if (working.length === 0) refuse("no digits are left after stripping symbols", working);

  let sign = 1;
  if (working.startsWith("-")) {
    sign = -1;
    working = working.slice(1);
  } else if (working.startsWith("+")) {
    working = working.slice(1);
  }
  let exponent = 0;
  const exponentMatch = working.match(/^(.*?)[eE]([+-]?\d+)$/);
  if (exponentMatch !== null) {
    working = exponentMatch[1] as string;
    exponent = Number(exponentMatch[2] as string);
    if (!Number.isFinite(exponent) || Math.abs(exponent) > 400) {
      refuse(`the exponent ${exponent} is out of range`, working);
    }
  }
  if (/[eE]/.test(working)) refuse('an "e" appears outside an exponent', working);
  if (working.includes("-") || working.includes("+")) {
    refuse("a sign appears in the middle of the number", working);
  }

  let integerText = working;
  let fractionText = "";
  if (parts.decimal.length > 0) {
    const pieces = working.split(parts.decimal);
    if (pieces.length > 2) {
      refuse(
        `the decimal separator "${parts.decimal}" appears ${pieces.length - 1} times`,
        working,
      );
    }
    integerText = pieces[0] as string;
    fractionText = pieces.length === 2 ? (pieces[1] as string) : "";
  }
  if (parts.group.length > 0 && integerText.includes(parts.group)) {
    const groups = integerText.split(parts.group);
    const head = groups[0] as string;
    if (head.length < 1 || head.length > 3) {
      refuse(
        `"${head}" is not a valid first group for the "${parts.group}" separator (1 to 3 digits) — if "${parts.group}" was meant as a decimal point, this is the wrong locale`,
        working,
      );
    }
    for (let i = 1; i < groups.length; i++) {
      const group = groups[i] as string;
      if (group.length !== 3 && group.length !== 2) {
        refuse(`group "${group}" is ${group.length} digits, but groups must be 2 or 3`, working);
      }
    }
    integerText = groups.join("");
  }
  if (!/^\d*$/.test(integerText)) refuse(`"${integerText}" is not a run of digits`, working);
  if (!/^\d*$/.test(fractionText)) {
    refuse(`"${fractionText}" after the decimal separator is not a run of digits`, working);
  }
  if (integerText.length === 0 && fractionText.length === 0) refuse("there are no digits", working);

  const normalized = `${sign < 0 ? "-" : ""}${integerText.length > 0 ? integerText : "0"}${
    fractionText.length > 0 ? `.${fractionText}` : ""
  }${exponent !== 0 ? `e${exponent}` : ""}`;
  const value = Number(normalized) * (parenthesised ? -1 : 1);
  if (!Number.isFinite(value))
    throw new NumberFormatError(`"${text}" does not fit in a finite number`);
  return {
    value,
    locale: resolvedLocale,
    normalized: parenthesised && sign > 0 ? `-${normalized}` : normalized,
    hadPercentSign: hadPercent,
    asFraction: hadPercent ? value / 100 : null,
    currencySymbolStripped: currencySymbol,
    note: hadPercent
      ? "a percent sign was present: value is the number as written and asFraction is it divided by 100 — pick the one you mean"
      : `parsed with the ${resolvedLocale} group separator "${parts.group}" and decimal separator "${parts.decimal}"`,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
