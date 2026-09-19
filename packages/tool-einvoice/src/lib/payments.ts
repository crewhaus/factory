/**
 * What the two payment formats share: the row shape, the field-width policy,
 * and the checks that run before a single byte is written.
 *
 * ## The field-width policy, stated once
 *
 * A NAME is truncated to the field, and the truncation is reported. A name is
 * for a human to read and the account identifier is what the money follows, so
 * a shortened one costs legibility and nothing else — every bank does it.
 *
 * A REFERENCE or a REMITTANCE is refused rather than truncated. Those are
 * matched by machine: a truncated end-to-end identifier matches nothing at
 * either end, and the payment arrives as an unattributable credit somebody has
 * to chase. Better to refuse the file than to send one that will not reconcile.
 *
 * An AMOUNT is refused rather than truncated, always and everywhere. See
 * `digits` in `amounts.ts`.
 *
 * ## Dedupe happens before the write, not after
 *
 * A duplicate end-to-end identifier discovered after the file has gone is a
 * duplicate payment, and getting one back is a phone call and a week. So the
 * identifiers are checked against each other here, and a collision is a
 * refusal that names both rows.
 */

export class PaymentFileError extends Error {
  override readonly name = "PaymentFileError";
}

/** One row. The optional fields are the ones only one format uses. */
export type Payment = {
  readonly id: string;
  readonly amountMinor: number;
  readonly name: string;
  readonly iban?: string;
  readonly bic?: string;
  readonly routingNumber?: string;
  readonly accountNumber?: string;
  readonly accountType?: "checking" | "savings";
  readonly direction?: "credit" | "debit";
  readonly remittance?: string;
  readonly addenda?: string;
};

/** A name that did not fit, reported so nobody discovers it at the other end. */
export type Truncation = {
  readonly paymentId: string;
  readonly field: string;
  readonly from: string;
  readonly to: string;
};

/**
 * Cut a name to `width`, recording what happened.
 *
 * `Array.from` rather than `slice`: a string index cuts a surrogate pair in
 * half and produces a lone surrogate, which is not a character and which the
 * receiving system renders as a replacement glyph or rejects outright.
 */
export function fitName(
  value: string,
  width: number,
  field: string,
  paymentId: string,
  into: Truncation[],
): string {
  const characters = Array.from(value);
  if (characters.length <= width) return value;
  const cut = characters.slice(0, width).join("");
  into.push({ paymentId, field, from: value, to: cut });
  return cut;
}

/** A reference that does not fit is a refusal, with the width it had to fit. */
export function requireFits(value: string, width: number, field: string): string {
  if (Array.from(value).length > width) {
    throw new PaymentFileError(
      `${field} is ${Array.from(value).length} characters but the field holds ${width}: "${value}". Refusing rather than truncating — a shortened reference matches nothing at either end, and the payment arrives as a credit somebody has to chase.`,
    );
  }
  return value;
}

/**
 * Every character a fixed-width banking record can carry without ambiguity.
 *
 * Anything outside printable ASCII is refused rather than encoded: these files
 * have no encoding declaration, the receiving mainframe reads them as ASCII or
 * as EBCDIC, and a byte above 0x7E means something different in each. Naming
 * the character is the whole value of the refusal.
 */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

export function requireAscii(value: string, field: string): string {
  if (PRINTABLE_ASCII.test(value)) return value;
  const bad = Array.from(value).find((c) => !PRINTABLE_ASCII.test(c)) ?? "";
  const point = bad.codePointAt(0)?.toString(16).padStart(4, "0") ?? "????";
  throw new PaymentFileError(
    `${field} contains "${bad}" (U+${point.toUpperCase()}), which a fixed-width banking record has no unambiguous byte for. Supply a transliterated value.`,
  );
}

/**
 * The checks that apply whatever the format is.
 *
 * Every one of these is a refusal rather than a repair. A row this function
 * cannot make sense of is a row somebody has to look at, and guessing would
 * put the guess into a file that moves money.
 */
export function validateRows(payments: ReadonlyArray<Payment>): void {
  if (payments.length === 0) {
    throw new PaymentFileError("there are no payments to write");
  }
  const seen = new Map<string, number>();
  for (const [index, payment] of payments.entries()) {
    const where = `payment ${index} ("${payment.id}")`;
    if (payment.id.trim() === "") {
      throw new PaymentFileError(
        `payment ${index} has no identifier; every row needs one so the file can be reconciled and so duplicates can be found before it is sent`,
      );
    }
    const first = seen.get(payment.id);
    if (first !== undefined) {
      throw new PaymentFileError(
        `payments ${first} and ${index} share the identifier "${payment.id}". Refusing: a duplicate found after the file has gone is a duplicate payment, and getting one back is a phone call and a week.`,
      );
    }
    seen.set(payment.id, index);
    if (!Number.isInteger(payment.amountMinor)) {
      throw new PaymentFileError(
        `${where} has a non-integer amount (${payment.amountMinor}); amounts are minor units, so 12.34 euros is 1234`,
      );
    }
    if (payment.amountMinor <= 0) {
      throw new PaymentFileError(
        `${where} has an amount of ${payment.amountMinor}; a payment file carries positive amounts, and a direction is set per row rather than by a sign`,
      );
    }
    if (payment.name.trim() === "") {
      throw new PaymentFileError(`${where} has no counterparty name`);
    }
  }
}
