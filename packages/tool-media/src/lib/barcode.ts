/**
 * Linear barcode encoders: Code 128 and EAN-13.
 *
 * Both are defined as module patterns — a barcode is a string of bars and
 * spaces one module wide each — so the encoders below produce a module
 * string and leave rendering to the caller. That keeps the symbology logic
 * testable against its own invariants rather than against a picture.
 *
 * ## Code 128
 *
 * One code set for the whole symbol: C when the payload is an even number
 * of digits at least four long, otherwise B. Code set A — the one with the
 * control characters and without lowercase — is never emitted, so the
 * encodable range is ASCII 32 to 126, and anything outside it is refused by
 * character rather than silently dropped. Mid-symbol set switching is not
 * implemented; it would make a mixed alphanumeric-plus-long-digits payload
 * narrower, and nothing else. The check character is the standard weighted
 * modulo-103 sum.
 *
 * ## EAN-13
 *
 * Twelve digits in, a thirteenth check digit computed. The first digit is
 * not encoded directly: it selects the odd/even parity pattern of the six
 * left-hand digits, which is how a scanner recovers it. UPC-A is EAN-13
 * with a leading zero, so passing `0` plus eleven digits produces a
 * scannable UPC-A. EAN-8, EAN-5 and EAN-2 add-ons are not implemented.
 */
import { MediaFormatError } from "./bytes";

// --- Code 128 ------------------------------------------------------------

/**
 * Bar/space run widths for each of the 107 symbol characters, bar first.
 * Each entry totals 11 modules; the stop pattern totals 13. The invariant
 * is asserted in the unit tests, which is the cheapest guard against a
 * transcription slip in a table this shape.
 */
const CODE128_WIDTHS: ReadonlyArray<string> = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
];

export const CODE128_START_B = 104;
export const CODE128_START_C = 105;
export const CODE128_STOP = 106;

/** Every Code 128 pattern, exported so the tests can check the invariant. */
export function code128Widths(): ReadonlyArray<string> {
  return CODE128_WIDTHS;
}

/** A symbol character's widths expanded to modules: `1` bar, `0` space. */
function widthsToModules(widths: string): string {
  let out = "";
  for (let i = 0; i < widths.length; i++) {
    const run = Number.parseInt(widths[i] as string, 10);
    out += (i % 2 === 0 ? "1" : "0").repeat(run);
  }
  return out;
}

/**
 * The symbol-character values for `text`: start character, data, check
 * character, stop. Exported because the value sequence is what the
 * check-character test asserts on.
 *
 * The code set is chosen once, for the whole symbol: C when the payload is
 * an even number of digits and at least four long (two digits per symbol
 * character, so a 13-digit-style payload halves in width), otherwise B.
 * Switching sets mid-symbol would shorten a mixed payload like
 * `AB12345678`; it is not implemented, and the cost is a slightly wider
 * barcode, never an unreadable one.
 */
export function code128Values(text: string): number[] {
  if (text.length === 0) throw new MediaFormatError("Code 128 needs at least one character");
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) {
      throw new MediaFormatError(
        `character ${i} (U+${code.toString(16).toUpperCase().padStart(4, "0")}) is outside the ASCII 32-126 range code sets B and C cover`,
      );
    }
  }

  const useC = text.length >= 4 && text.length % 2 === 0 && /^[0-9]+$/.test(text);
  const values: number[] = [useC ? CODE128_START_C : CODE128_START_B];
  if (useC) {
    for (let i = 0; i < text.length; i += 2) {
      values.push(Number.parseInt(text.slice(i, i + 2), 10));
    }
  } else {
    for (let i = 0; i < text.length; i++) values.push(text.charCodeAt(i) - 32);
  }

  // Weighted modulo-103 check character: the start value plus each
  // subsequent value times its one-based position.
  let sum = values[0] as number;
  for (let i = 1; i < values.length; i++) sum += (values[i] as number) * i;
  values.push(sum % 103);
  values.push(CODE128_STOP);
  return values;
}

/** True when `text` will be encoded in code set C rather than B. */
export function code128UsesSetC(text: string): boolean {
  return text.length >= 4 && text.length % 2 === 0 && /^[0-9]+$/.test(text);
}

/** Code 128 as a module string: `1` is a bar, `0` is a space. */
export function encodeCode128(text: string): { modules: string; values: number[] } {
  const values = code128Values(text);
  let modules = "";
  for (const value of values) {
    const widths = CODE128_WIDTHS[value];
    if (widths === undefined) throw new MediaFormatError(`no Code 128 pattern for value ${value}`);
    modules += widthsToModules(widths);
  }
  return { modules, values };
}

// --- EAN-13 --------------------------------------------------------------

const EAN_L: ReadonlyArray<string> = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];

const EAN_G: ReadonlyArray<string> = [
  "0100111",
  "0110011",
  "0011011",
  "0100001",
  "0011101",
  "0111001",
  "0000101",
  "0010001",
  "0001001",
  "0010111",
];

const EAN_R: ReadonlyArray<string> = [
  "1110010",
  "1100110",
  "1101100",
  "1000010",
  "1011100",
  "1001110",
  "1010000",
  "1000100",
  "1001000",
  "1110100",
];

/** Parity of the six left-hand digits, selected by the first digit. */
const EAN_PARITY: ReadonlyArray<string> = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
];

/** The three EAN digit encodings, exported for the tests' invariants. */
export function eanTables(): {
  L: ReadonlyArray<string>;
  G: ReadonlyArray<string>;
  R: ReadonlyArray<string>;
  parity: ReadonlyArray<string>;
} {
  return { L: EAN_L, G: EAN_G, R: EAN_R, parity: EAN_PARITY };
}

/** The EAN-13 check digit for twelve digits, as a number 0-9. */
export function ean13CheckDigit(twelve: string): number {
  if (!/^[0-9]{12}$/.test(twelve)) {
    throw new MediaFormatError(`"${twelve}" is not twelve digits`);
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number.parseInt(twelve[i] as string, 10) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * EAN-13 as a 95-module string. `digits` is twelve digits (the check digit
 * is computed) or thirteen (the check digit is verified).
 */
export function encodeEan13(digits: string): {
  modules: string;
  digits: string;
  checkDigit: number;
} {
  const cleaned = digits.replace(/[\s-]/g, "");
  if (!/^[0-9]{12,13}$/.test(cleaned)) {
    throw new MediaFormatError(
      `EAN-13 takes twelve digits (check digit computed) or thirteen (check digit verified); got "${digits}"`,
    );
  }
  const body = cleaned.slice(0, 12);
  const checkDigit = ean13CheckDigit(body);
  if (cleaned.length === 13 && Number.parseInt(cleaned[12] as string, 10) !== checkDigit) {
    throw new MediaFormatError(
      `"${cleaned}" has check digit ${cleaned[12]}, but ${body} checks to ${checkDigit}`,
    );
  }
  const full = body + String(checkDigit);
  const parity = EAN_PARITY[Number.parseInt(full[0] as string, 10)] as string;
  let modules = "101"; // left guard
  for (let i = 1; i <= 6; i++) {
    const digit = Number.parseInt(full[i] as string, 10);
    modules += (parity[i - 1] === "L" ? EAN_L : EAN_G)[digit] as string;
  }
  modules += "01010"; // centre guard
  for (let i = 7; i <= 12; i++) {
    modules += EAN_R[Number.parseInt(full[i] as string, 10)] as string;
  }
  modules += "101"; // right guard
  return { modules, digits: full, checkDigit };
}
