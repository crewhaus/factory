/**
 * NACHA — the ACH file format, 94 bytes per record, every field a column
 * range.
 *
 * ## Why this file is written the way it is
 *
 * A field one column off is rejected by the ODFI with no line number and no
 * useful error, so the only defence is arithmetic that cannot be off. Every
 * record is assembled from a list of (width, value) pairs and then checked
 * against 94 before it is kept; a record that does not measure 94 raises with
 * the widths that produced it, rather than being written and discovered by a
 * bank three days later.
 *
 * Four totals have to agree with the entries exactly, and NOT ONE OF THEM IS
 * AN ARGUMENT:
 *
 * - the entry/addenda count, in the batch control and again in the file
 *   control with a wider field;
 * - the entry hash — the sum of the first eight digits of each entry's
 *   receiving routing number, keeping the RIGHTMOST ten digits of the sum
 *   (this is a truncation, not a modulus of the count, and getting it wrong
 *   is the single most common reason a hand-built file bounces);
 * - the debit and credit totals, in cents, unsigned;
 * - the block count, which is the record count rounded UP to a multiple of
 *   ten, the file being padded to that length with records of ninety-four 9s.
 *
 * Trace numbers are the ODFI's first eight digits plus a seven-digit sequence,
 * ascending within the batch, and an addenda record carries the last seven
 * digits of its entry's trace so the two can be paired after the fact.
 *
 * ## What this does NOT do
 *
 * It builds bytes. It does not transmit them, does not hold a credential that
 * could, and does not know what an SFTP server is. The operator decides what
 * happens to the file.
 */
import { digits, sumMinor } from "./amounts";
import { type Calendar, formatIsoDate, parseIsoDate } from "./calendar";
import {
  type Payment,
  PaymentFileError,
  type Truncation,
  fitName,
  requireAscii,
  requireFits,
} from "./payments";

export const SEC_CODES = ["PPD", "CCD"] as const;
export type SecCode = (typeof SEC_CODES)[number];

export const LINE_ENDINGS = ["lf", "crlf", "none"] as const;
export type LineEnding = (typeof LINE_ENDINGS)[number];

export type NachaOptions = {
  /** 9-digit routing number, or the 10 characters the field takes verbatim. */
  readonly immediateDestination: string;
  readonly immediateOrigin: string;
  readonly destinationName: string;
  readonly originName: string;
  readonly companyName: string;
  /** Usually "1" followed by a nine-digit EIN. Ten characters, taken as given. */
  readonly companyId: string;
  readonly companyEntryDescription: string;
  readonly companyDescriptiveDate?: string;
  readonly standardEntryClass: SecCode;
  /** The originating DFI's 9-digit routing number; its first 8 digits seed the traces. */
  readonly odfiRouting: string;
  readonly creationDate: string;
  /** HH:MM, 24-hour. Required: this package never reads a clock. */
  readonly creationTime: string;
  readonly effectiveEntryDate: string;
  readonly fileIdModifier?: string;
  readonly batchNumber?: number;
  readonly traceStart?: number;
  readonly lineEnding?: LineEnding;
  readonly discretionaryData?: string;
};

export type NachaResult = {
  readonly text: string;
  readonly serviceClassCode: string;
  /** Records before padding: header, batch header, entries, addenda, controls. */
  readonly recordCount: number;
  readonly paddingRecords: number;
  readonly blockCount: number;
  /** Entry detail plus addenda records, which is what the control fields count. */
  readonly entryAddendaCount: number;
  readonly entryHash: string;
  readonly totalDebitMinor: string;
  readonly totalCreditMinor: string;
  readonly traceNumbers: ReadonlyArray<string>;
  readonly truncations: ReadonlyArray<Truncation>;
  readonly effectiveEntryDate: string;
};

export const NACHA_CALENDAR: Calendar = "usfed";

const RECORD_LENGTH = 94;

/** A field: fixed width, left-justified text or an already-formatted number. */
type Field = { readonly width: number; readonly value: string; readonly name: string };

/**
 * A left-justified, space-padded text field.
 *
 * A value that does not fit is a REFUSAL, not a quiet cut. The package's
 * stated policy is that a name is shortened and the shortening is reported,
 * and this function has no sink to report into — so the two file-level names
 * that can genuinely overflow go through `fitName` at the call site and
 * everything else that reaches here is an identifier or a code, where a
 * silent cut is simply wrong. The company name is what the receiver sees on
 * their statement; "ACME INTERNATION" arriving there with nobody told is the
 * defect this replaces.
 */
function alpha(name: string, value: string, width: number): Field {
  const checked = requireAscii(value, name);
  if (checked.length > width) {
    throw new PaymentFileError(
      `${name} is ${checked.length} characters ("${checked}") but the field is ${width} wide. Shorten it deliberately: a value cut here is what the receiving bank prints, and nothing downstream would say it had been cut.`,
    );
  }
  return { name, value: checked.padEnd(width, " "), width };
}

function numeric(name: string, value: bigint, width: number): Field {
  return { name, value: digits(value, width, name), width };
}

function literal(name: string, value: string, width: number): Field {
  if (value.length !== width) {
    throw new PaymentFileError(`${name} must be exactly ${width} characters, got "${value}"`);
  }
  return { name, value, width };
}

/**
 * Join the fields and prove the result is 94 characters.
 *
 * This assertion is the point of the whole module. If it ever fires, a layout
 * above is wrong, and the message says which fields were laid out so the
 * column can be found without counting by hand.
 */
function record(kind: string, fields: ReadonlyArray<Field>): string {
  const text = fields.map((f) => f.value).join("");
  if (text.length !== RECORD_LENGTH) {
    const widths = fields.map((f) => `${f.name}=${f.value.length}/${f.width}`).join(" ");
    throw new PaymentFileError(
      `the ${kind} record came to ${text.length} characters, not ${RECORD_LENGTH}: ${widths}`,
    );
  }
  return text;
}

const ABA_WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7] as const;

/**
 * The ninth digit of a routing number, from the first eight.
 *
 * Recomputed rather than trusted: a transposed pair in a routing number is
 * exactly what the check digit exists to catch, and catching it here costs
 * nothing while catching it at the ODFI costs the whole file.
 */
export function abaCheckDigit(first8: string): number {
  let sum = 0;
  for (const [index, weight] of ABA_WEIGHTS.entries()) {
    sum += Number(first8[index] ?? Number.NaN) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

export function assertRoutingNumber(value: string, field: string): string {
  const trimmed = value.trim();
  if (!/^\d{9}$/.test(trimmed)) {
    throw new PaymentFileError(`${field} ("${value}") is not nine digits`);
  }
  const expected = abaCheckDigit(trimmed.slice(0, 8));
  if (Number(trimmed[8]) !== expected) {
    throw new PaymentFileError(
      `${field} ("${trimmed}") fails its ABA check digit — the ninth digit should be ${expected}. This is what the check digit is for: a transposed pair here sends the entry to a different bank.`,
    );
  }
  return trimmed;
}

/** A 10-character routing field: a 9-digit number becomes " " + number. */
function routingField(name: string, value: string): Field {
  const trimmed = value.trim();
  if (/^\d{9}$/.test(trimmed)) return literal(name, ` ${trimmed}`, 10);
  if (trimmed.length <= 10) return alpha(name, trimmed, 10);
  throw new PaymentFileError(
    `${name} ("${value}") is neither a nine-digit routing number nor a value that fits the ten-character field`,
  );
}

function yymmdd(iso: string, label: string): string {
  return formatIsoDate(parseIsoDate(iso, label)).replace(/-/g, "").slice(2);
}

function hhmm(value: string, label: string): string {
  const match = value.trim().match(/^(\d{2}):?(\d{2})$/);
  if (match === null) {
    throw new PaymentFileError(`${label} ("${value}") is not a 24-hour time written as HH:MM`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new PaymentFileError(`${label} ("${value}") is not a real time of day`);
  }
  return `${match[1]}${match[2]}`;
}

/** Transaction codes: checking/savings x credit/debit, for PPD and CCD. */
function transactionCode(payment: Payment): string {
  const savings = payment.accountType === "savings";
  const debit = payment.direction === "debit";
  if (savings) return debit ? "37" : "32";
  return debit ? "27" : "22";
}

export function buildNacha(payments: ReadonlyArray<Payment>, options: NachaOptions): NachaResult {
  const truncations: Truncation[] = [];
  const odfi = assertRoutingNumber(options.odfiRouting, "odfiRouting");
  const odfiPrefix = odfi.slice(0, 8);

  const credits: bigint[] = [];
  const debitAmounts: bigint[] = [];
  let entryHash = 0n;
  const entries: string[] = [];
  const traceNumbers: string[] = [];
  let sequence = BigInt(options.traceStart ?? 1);
  let entryAddendaCount = 0;

  for (const [index, payment] of payments.entries()) {
    const where = `payment ${index} ("${payment.id}")`;
    if (payment.routingNumber === undefined) {
      throw new PaymentFileError(
        `${where} has no routingNumber, which a NACHA entry cannot be written without`,
      );
    }
    if (payment.accountNumber === undefined || payment.accountNumber.trim() === "") {
      throw new PaymentFileError(`${where} has no accountNumber`);
    }
    const routing = assertRoutingNumber(payment.routingNumber, `${where} routingNumber`);
    const amount = BigInt(payment.amountMinor);
    if (payment.direction === "debit") debitAmounts.push(amount);
    else credits.push(amount);

    // The hash sums the first EIGHT digits — the routing number without its
    // check digit — and the total keeps its rightmost ten. Summing all nine,
    // or taking a modulus of the entry count, both produce a number the ODFI
    // rejects the file over.
    entryHash += BigInt(routing.slice(0, 8));

    const trace = `${odfiPrefix}${digits(sequence, 7, `${where} trace sequence`)}`;
    traceNumbers.push(trace);
    const addenda = payment.addenda ?? "";
    const hasAddenda = addenda.trim() !== "";

    entries.push(
      record("entry detail", [
        literal("record type", "6", 1),
        literal("transaction code", transactionCode(payment), 2),
        literal("receiving DFI", routing.slice(0, 8), 8),
        literal("check digit", routing.slice(8), 1),
        alpha(
          `${where} accountNumber`,
          fitName(payment.accountNumber.trim(), 17, "accountNumber", payment.id, truncations),
          17,
        ),
        numeric(`${where} amount`, amount, 10),
        alpha(`${where} identification`, requireFits(payment.id, 15, `${where} identifier`), 15),
        alpha(
          `${where} name`,
          fitName(payment.name, 22, "counterparty name", payment.id, truncations),
          22,
        ),
        alpha("discretionary data", "", 2),
        literal("addenda indicator", hasAddenda ? "1" : "0", 1),
        literal("trace number", trace, 15),
      ]),
    );
    entryAddendaCount += 1;

    if (hasAddenda) {
      const text = requireAscii(addenda, `${where} addenda`);
      if (Array.from(text).length > 80) {
        throw new PaymentFileError(
          `${where} addenda is ${text.length} characters but an 05 addenda record holds 80. Refusing rather than truncating: remittance detail is what the receiver reconciles against.`,
        );
      }
      entries.push(
        record("addenda", [
          literal("record type", "7", 1),
          literal("addenda type", "05", 2),
          alpha("payment related information", text, 80),
          numeric("addenda sequence", 1n, 4),
          literal("entry detail sequence", trace.slice(-7), 7),
        ]),
      );
      entryAddendaCount += 1;
    }
    sequence += 1n;
  }

  const totalCredit = sumMinor(credits);
  const totalDebit = sumMinor(debitAmounts);
  // Derived from the entries, never taken as an argument: 220 when every entry
  // is a credit, 225 when every one is a debit, 200 when both appear. A file
  // whose declared class disagrees with its entries is rejected as a whole.
  const serviceClassCode =
    credits.length > 0 && debitAmounts.length > 0 ? "200" : debitAmounts.length > 0 ? "225" : "220";
  // The rightmost ten digits of the sum. `% 10n ** 10n` is that truncation.
  const hashText = digits(entryHash % 10n ** 10n, 10, "entry hash");
  const batchNumber = BigInt(options.batchNumber ?? 1);

  // The three file-level NAMES are the only fields here a bank routinely
  // supplies longer than the column, so they are fitted through `fitName` and
  // land in `truncations` like a counterparty's. They belong to the file
  // rather than to a row, which is what the "(file)" identifier says.
  const fileName = (value: string, width: number, field: string): string =>
    fitName(value, width, field, "(file)", truncations);

  const fileHeader = record("file header", [
    literal("record type", "1", 1),
    literal("priority code", "01", 2),
    routingField("immediateDestination", options.immediateDestination),
    routingField("immediateOrigin", options.immediateOrigin),
    literal("creation date", yymmdd(options.creationDate, "creationDate"), 6),
    literal("creation time", hhmm(options.creationTime, "creationTime"), 4),
    literal("file id modifier", (options.fileIdModifier ?? "A").toUpperCase(), 1),
    literal("record size", "094", 3),
    literal("blocking factor", "10", 2),
    literal("format code", "1", 1),
    alpha("destinationName", fileName(options.destinationName, 23, "destinationName"), 23),
    alpha("originName", fileName(options.originName, 23, "originName"), 23),
    alpha("reference code", "", 8),
  ]);

  const batchHeader = record("batch header", [
    literal("record type", "5", 1),
    literal("service class code", serviceClassCode, 3),
    alpha("companyName", fileName(options.companyName, 16, "companyName"), 16),
    alpha("discretionary data", options.discretionaryData ?? "", 20),
    alpha("companyId", options.companyId, 10),
    literal("standard entry class", options.standardEntryClass, 3),
    alpha("companyEntryDescription", options.companyEntryDescription, 10),
    alpha("companyDescriptiveDate", options.companyDescriptiveDate ?? "", 6),
    literal("effective entry date", yymmdd(options.effectiveEntryDate, "effectiveEntryDate"), 6),
    // Settlement date is filled in by the ACH operator. Writing anything here
    // is one of the ways a hand-built file gets returned.
    alpha("settlement date", "", 3),
    literal("originator status code", "1", 1),
    literal("originating DFI", odfiPrefix, 8),
    numeric("batch number", batchNumber, 7),
  ]);

  const batchControl = record("batch control", [
    literal("record type", "8", 1),
    literal("service class code", serviceClassCode, 3),
    numeric("entry/addenda count", BigInt(entryAddendaCount), 6),
    literal("entry hash", hashText, 10),
    numeric("total debit", totalDebit, 12),
    numeric("total credit", totalCredit, 12),
    alpha("companyId", options.companyId, 10),
    alpha("message authentication code", "", 19),
    alpha("reserved", "", 6),
    literal("originating DFI", odfiPrefix, 8),
    numeric("batch number", batchNumber, 7),
  ]);

  const beforeControl = [fileHeader, batchHeader, ...entries, batchControl];
  const recordCount = beforeControl.length + 1;
  const blockCount = Math.ceil(recordCount / 10);
  const paddingRecords = blockCount * 10 - recordCount;

  const fileControl = record("file control", [
    literal("record type", "9", 1),
    numeric("batch count", 1n, 6),
    numeric("block count", BigInt(blockCount), 6),
    numeric("entry/addenda count", BigInt(entryAddendaCount), 8),
    literal("entry hash", hashText, 10),
    numeric("total debit", totalDebit, 12),
    numeric("total credit", totalCredit, 12),
    alpha("reserved", "", 39),
  ]);

  const padding: string[] = [];
  for (let i = 0; i < paddingRecords; i++) padding.push("9".repeat(RECORD_LENGTH));
  const all = [...beforeControl, fileControl, ...padding];
  const ending = options.lineEnding ?? "lf";
  const separator = ending === "crlf" ? "\r\n" : ending === "none" ? "" : "\n";
  const text = all.join(separator) + (ending === "none" ? "" : separator);

  return {
    text,
    serviceClassCode,
    recordCount,
    paddingRecords,
    blockCount,
    entryAddendaCount,
    entryHash: hashText,
    totalDebitMinor: totalDebit.toString(),
    totalCreditMinor: totalCredit.toString(),
    traceNumbers,
    truncations,
    effectiveEntryDate: options.effectiveEntryDate,
  };
}
