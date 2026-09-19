/**
 * What UBL and CII have in common: the presets that name a specification, the
 * money-string conversions both mappings need, and the shape a parse returns.
 *
 * The two syntaxes express the same semantic model with different nesting and
 * different names — a tax breakdown is `cac:TaxSubtotal` in UBL and
 * `ram:ApplicableTradeTax` in CII, a date is an element's text in one and a
 * `format="102"` child in the other. Everything that is genuinely shared lives
 * here so the two mappings cannot drift apart on it.
 */
import { type Decimal, divideHalfUp, minorUnitExponent, parseDecimal, pow10 } from "./amounts";
import type { StatedTotals } from "./en16931";
import type { Invoice } from "./invoice";

export const SYNTAXES = ["ubl", "cii"] as const;
export type Syntax = (typeof SYNTAXES)[number];

export const PRESETS = ["en16931", "peppol", "xrechnung"] as const;
export type Preset = (typeof PRESETS)[number];

/**
 * The specification identifiers each preset writes into BT-24 and BT-23.
 *
 * A preset selects IDENTIFIERS. It does not check that preset's rules: Peppol
 * BIS Billing 3.0 and XRechnung each add their own rule set on top of EN
 * 16931, none of which is implemented here, and a document that claims
 * conformance to a rule set nothing checked is exactly the overstatement this
 * package is built to avoid. Both build results say so.
 */
export const PRESET_IDENTIFIERS: Readonly<
  Record<Preset, { readonly customizationId: string; readonly profileId?: string }>
> = Object.freeze({
  en16931: { customizationId: "urn:cen.eu:en16931:2017" },
  peppol: {
    customizationId: "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
    profileId: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  },
  xrechnung: {
    customizationId: "urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0",
    profileId: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  },
});

/** What a parse produces: the record, what the document CLAIMED, and its labels. */
export type ParsedDocument = {
  readonly syntax: Syntax;
  readonly invoice: Invoice;
  readonly stated: StatedTotals;
  readonly customizationId?: string;
  readonly profileId?: string;
  readonly currencyExponent: number;
};

/** Collects the monetary elements whose source text carried too many decimals. */
export type MoneyReader = {
  readonly exponent: number;
  readonly overPrecise: string[];
  /**
   * Elements that were PRESENT and could not be read as a decimal at all.
   *
   * Kept apart from `overPrecise` and apart from absence, because the three
   * mean different things to a reader and only one of them is benign. A
   * total written "1.100,00" by a mis-configured exporter is not an absent
   * total and it is certainly not a zero one: the document states a figure
   * ten times the rows and nothing here can say what it is.
   */
  readonly unreadable: string[];
};

export function moneyReader(currency: string): MoneyReader {
  return { exponent: minorUnitExponent(currency), overPrecise: [], unreadable: [] };
}

/**
 * Read a monetary element's text into minor units.
 *
 * A value with MORE decimals than the CURRENCY has minor units is recorded
 * and then rounded half-up rather than refused: the document exists, the
 * caller wants to see it, and `CH-DEC-2` is where the finding belongs. The
 * comparison is against the currency's own exponent and not against two —
 * "100.50" is over-precise in JPY and "100.000" is exact in KWD, and a fixed
 * two would round the first silently and libel the second.
 *
 * A value that is not a decimal at all returns `undefined` AND is recorded in
 * `unreadable`. The return alone is not enough: every caller of this function
 * feeds a field that is optional, so `undefined` on its own is
 * indistinguishable from an element that was never there, and an unreadable
 * total that reads as an absent one makes a broken invoice reconcile.
 */
export function readMoney(reader: MoneyReader, text: string, label: string): bigint | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  let value: Decimal;
  try {
    value = parseDecimal(trimmed, label);
  } catch {
    reader.unreadable.push(`${label}="${trimmed}"`);
    return undefined;
  }
  if (value.scale > reader.exponent) reader.overPrecise.push(`${label}="${trimmed}"`);
  if (value.scale === reader.exponent) return value.unscaled;
  if (value.scale < reader.exponent) return value.unscaled * pow10(reader.exponent - value.scale);
  return divideHalfUp(value.unscaled, pow10(value.scale - reader.exponent));
}

/** A CII `format="102"` date — YYYYMMDD — as the ISO date the record carries. */
export function fromBasicDate(text: string): string {
  const trimmed = text.trim();
  if (!/^\d{8}$/.test(trimmed)) return trimmed;
  return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
}

/** The inverse, for building CII. A date that is not ISO is passed through. */
export function toBasicDate(text: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.replace(/-/g, "") : text;
}

/** Drop the keys whose value is undefined, so the record JSON stays readable. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (typeof entry === "string" && entry === "") continue;
    out[key] = entry;
  }
  return out as T;
}

/** `undefined` for an empty string, so `compact` and the rules agree on absence. */
export function orUndefined(value: string): string | undefined {
  return value.trim() === "" ? undefined : value.trim();
}
