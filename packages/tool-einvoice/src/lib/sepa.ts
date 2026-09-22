/**
 * SEPA credit transfer initiation — ISO 20022 pain.001.
 *
 * XML rather than columns, and no less unforgiving about totals: `NbOfTxs` and
 * `CtrlSum` appear twice, once in the group header and once per payment
 * information block, and a bank that finds either disagreeing with the
 * transactions rejects the message. Both are computed from the rows here.
 *
 * ## The restricted character set
 *
 * The EPC rulebook admits `a-z A-Z 0-9 / - ? : ( ) . , ' +` and space, and
 * nothing else. A creditor named "Müller" has to be TRANSLITERATED, not
 * encoded: the field is not UTF-8 at the far end of the chain however the XML
 * is encoded, and an accented byte comes out as whatever the receiving system
 * makes of it.
 *
 * So: combining marks are stripped after NFD decomposition (ü to u, é to e),
 * the ligatures and crossed letters that have no decomposition are mapped by
 * hand (ß to ss, ø to o, ł to l), and `&` — which almost every company name
 * has and which is not in the set — becomes `+`. Every substitution is
 * REPORTED, because each one is a change to a name somebody will read.
 *
 * Anything still outside the set is a refusal naming the character. Silently
 * mangling a creditor name is how a payment bounces back a week later, and
 * guessing at a romanization of a name this package cannot spell is worse than
 * asking the operator for one.
 *
 * ## What this does NOT do
 *
 * It builds bytes. Nothing here transmits an instruction to a bank, signs one,
 * or holds a credential that could.
 */
import { formatMinor } from "./amounts";
import { type Calendar, closureReason, formatIsoDate, nextOpenDay, parseIsoDate } from "./calendar";
import { type Payment, PaymentFileError, type Truncation, fitName, requireFits } from "./payments";
import { type El, serialize } from "./xml";

export const PAIN_VERSIONS = ["pain.001.001.03", "pain.001.001.09"] as const;
export type PainVersion = (typeof PAIN_VERSIONS)[number];

export const SEPA_CALENDAR: Calendar = "target2";

export type SepaOptions = {
  readonly messageId: string;
  /** ISO-8601 with an offset. Required: nothing in this package reads a clock. */
  readonly creationDateTime: string;
  readonly paymentInformationId: string;
  readonly requestedExecutionDate: string;
  readonly debtorName: string;
  readonly debtorIban: string;
  readonly debtorBic?: string;
  readonly initiatingPartyName?: string;
  readonly batchBooking?: boolean;
  readonly version?: PainVersion;
  readonly currency?: string;
};

export type SepaResult = {
  readonly text: string;
  readonly version: PainVersion;
  readonly transactionCount: number;
  readonly controlSum: string;
  readonly requestedExecutionDate: string;
  readonly truncations: ReadonlyArray<Truncation>;
  readonly transliterations: ReadonlyArray<{
    readonly paymentId: string;
    readonly field: string;
    readonly from: string;
    readonly to: string;
  }>;
};

/** The EPC-admitted set, as a character class. */
const SEPA_ALLOWED = /^[A-Za-z0-9/\-?:().,'+ ]*$/;
const SEPA_ALLOWED_CHAR = /[A-Za-z0-9/\-?:().,'+ ]/;

/**
 * Letters that survive NFD decomposition intact because they are not a base
 * letter plus a mark — a crossed or ligatured letter is its own code point.
 */
const HAND_MAPPED: Readonly<Record<string, string>> = Object.freeze({
  ß: "ss", // ß
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ł: "l",
  Ł: "L",
  þ: "th",
  Þ: "TH",
  ð: "d",
  Ð: "D",
  ı: "i",
  "&": "+",
  // The quotation marks and dashes a word processor substitutes silently. Each
  // has an admitted equivalent, and refusing a name over a typographic
  // apostrophe would refuse most Irish surnames.
  "‘": "'",
  "’": "'",
  "“": "'",
  "”": "'",
  "–": "-",
  "—": "-",
  "\u00A0": " ", // a non-breaking space, which is not the space the set admits
});

/**
 * Bring `value` into the SEPA character set, or refuse.
 *
 * Returns the converted text; when it differs from the input the caller
 * records it, because a changed name is a fact the operator has to see.
 */
export function toSepaCharset(value: string, field: string): string {
  if (SEPA_ALLOWED.test(value)) return value;
  let out = "";
  for (const character of Array.from(value)) {
    if (SEPA_ALLOWED_CHAR.test(character) && character.length === 1) {
      out += character;
      continue;
    }
    const mapped = HAND_MAPPED[character];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    // NFD splits a precomposed letter into its base and its combining marks;
    // dropping the marks leaves the base letter, which is the transliteration
    // every European bank expects for ü, é, ñ and their relatives.
    const stripped = character.normalize("NFD").replace(/\p{M}/gu, "");
    if (stripped !== "" && SEPA_ALLOWED.test(stripped)) {
      out += stripped;
      continue;
    }
    const point = (character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    throw new PaymentFileError(
      `${field} contains "${character}" (U+${point}), which is outside the SEPA character set and which this package will not guess a romanization for. Supply a transliterated value — a mangled creditor name is how a payment comes back a week later.`,
    );
  }
  return out;
}

const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const BIC_SHAPE = /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;

/** Normalize an IBAN's spelling. The mod-97 check is the tool layer's job. */
export function normalizeIban(value: string, field: string): string {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (!IBAN_SHAPE.test(normalized)) {
    throw new PaymentFileError(
      `${field} ("${value}") does not have the shape of an IBAN (two letters, two check digits, then up to thirty alphanumerics)`,
    );
  }
  return normalized;
}

export function normalizeBic(value: string, field: string): string {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (!BIC_SHAPE.test(normalized)) {
    throw new PaymentFileError(`${field} ("${value}") is not an 8- or 11-character BIC`);
  }
  return normalized;
}

/** The instant a creation timestamp must be: offset-bearing, never local. */
function creationDateTime(value: string): string {
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    throw new PaymentFileError(
      `creationDateTime ("${text}") has no UTC offset — write it as e.g. 2026-03-02T09:00:00Z. An offset-less timestamp means local time, so the same batch would carry a different instant on two machines.`,
    );
  }
  if (Number.isNaN(Date.parse(text))) {
    throw new PaymentFileError(`creationDateTime ("${text}") is not a valid ISO-8601 instant`);
  }
  return text;
}

/** The largest amount an `InstdAmt` of two decimals can carry. */
const MAX_AMOUNT_MINOR = 99_999_999_999n;

export function buildSepa(payments: ReadonlyArray<Payment>, options: SepaOptions): SepaResult {
  const version = options.version ?? "pain.001.001.03";
  const currency = (options.currency ?? "EUR").toUpperCase();
  if (currency !== "EUR") {
    throw new PaymentFileError(
      `a SEPA credit transfer is denominated in EUR; "${currency}" would need a different scheme and a different message`,
    );
  }
  const truncations: Truncation[] = [];
  const transliterations: Array<{
    paymentId: string;
    field: string;
    from: string;
    to: string;
  }> = [];
  const convert = (value: string, field: string, paymentId: string): string => {
    const converted = toSepaCharset(value, field);
    if (converted !== value)
      transliterations.push({ paymentId, field, from: value, to: converted });
    return converted;
  };

  const debtorIban = normalizeIban(options.debtorIban, "debtorIban");
  const debtorBic =
    options.debtorBic === undefined ? undefined : normalizeBic(options.debtorBic, "debtorBic");
  const created = creationDateTime(options.creationDateTime);
  const executionDate = formatIsoDate(
    parseIsoDate(options.requestedExecutionDate, "requestedExecutionDate"),
  );

  let total = 0n;
  /**
   * The identifiers AS WRITTEN, against the row that produced each.
   *
   * `validateRows` already refused duplicate `payment.id`s, but the value
   * that reaches the bank is the TRANSLITERATED one, and the transliteration
   * is many-to-one: `&` becomes `+`, so "ACME&CO-1" and "ACME+CO-1" are two
   * distinct rows that arrive as one reference. A duplicate end-to-end
   * identifier is the case this package exists to refuse, so it is refused
   * against the string that is actually emitted rather than against the one
   * that was supplied.
   */
  const emittedIds = new Map<string, string>();
  const transactions: El[] = payments.map((payment, index) => {
    const where = `payment ${index} ("${payment.id}")`;
    if (payment.iban === undefined) {
      throw new PaymentFileError(
        `${where} has no iban; a SEPA credit transfer names the creditor account by IBAN and by nothing else`,
      );
    }
    const amount = BigInt(payment.amountMinor);
    if (amount > MAX_AMOUNT_MINOR) {
      throw new PaymentFileError(
        `${where} is ${formatMinor(amount, 2)} ${currency}, over what an InstdAmt of two decimals carries`,
      );
    }
    total += amount;
    const creditorIban = normalizeIban(payment.iban, `${where} iban`);
    const creditorBic =
      payment.bic === undefined ? undefined : normalizeBic(payment.bic, `${where} bic`);
    // The end-to-end identifier is a REFERENCE: it is matched by machine at
    // both ends, so it is refused rather than truncated.
    const endToEnd = requireFits(
      convert(payment.id, `${where} endToEndId`, payment.id),
      35,
      `${where} endToEndId`,
    );
    const collidesWith = emittedIds.get(endToEnd);
    if (collidesWith !== undefined) {
      throw new PaymentFileError(
        `payments "${collidesWith}" and "${payment.id}" both become the end-to-end identifier "${endToEnd}" once they are brought into the SEPA character set, so the message would carry the same reference twice. Refusing: a duplicate reference found after the file has gone is a duplicate payment, and getting one back is a phone call and a week.`,
      );
    }
    emittedIds.set(endToEnd, payment.id);
    const creditorName = fitName(
      convert(payment.name, `${where} creditor name`, payment.id),
      70,
      "creditor name",
      payment.id,
      truncations,
    );
    const remittance =
      payment.remittance === undefined || payment.remittance.trim() === ""
        ? undefined
        : requireFits(
            convert(payment.remittance, `${where} remittance`, payment.id),
            140,
            `${where} remittance`,
          );

    const agentTag = version === "pain.001.001.09" ? "BICFI" : "BIC";
    return {
      name: "CdtTrfTxInf",
      children: [
        { name: "PmtId", children: [{ name: "EndToEndId", text: endToEnd }] },
        {
          name: "Amt",
          children: [{ name: "InstdAmt", attrs: { Ccy: currency }, text: formatMinor(amount, 2) }],
        },
        creditorBic === undefined
          ? undefined
          : {
              name: "CdtrAgt",
              children: [{ name: "FinInstnId", children: [{ name: agentTag, text: creditorBic }] }],
            },
        { name: "Cdtr", children: [{ name: "Nm", text: creditorName }] },
        {
          name: "CdtrAcct",
          children: [{ name: "Id", children: [{ name: "IBAN", text: creditorIban }] }],
        },
        remittance === undefined
          ? undefined
          : { name: "RmtInf", children: [{ name: "Ustrd", text: remittance }] },
      ],
    };
  });

  const count = payments.length;
  const controlSum = formatMinor(total, 2);
  const agentTag = version === "pain.001.001.09" ? "BICFI" : "BIC";
  // Through `fitName` like every other name, so a cut one is REPORTED. The
  // bare `.slice(0, 70)` this used to carry made the initiating party the one
  // name in the message that could be shortened without anybody being told.
  const initiatingParty = fitName(
    toSepaCharset(options.initiatingPartyName ?? options.debtorName, "initiatingPartyName"),
    70,
    "initiating party name",
    "(initiating party)",
    truncations,
  );
  const debtorName = fitName(
    toSepaCharset(options.debtorName, "debtorName"),
    70,
    "debtor name",
    "(debtor)",
    truncations,
  );

  // pain.001.001.09 wraps the requested execution date in a date-or-datetime
  // choice; .03 carries the date as the element's own text. Emitting .03's
  // shape under .09's namespace produces a message the bank's schema rejects,
  // and this is the difference between the two that actually bites.
  const executionElement: El =
    version === "pain.001.001.09"
      ? { name: "ReqdExctnDt", children: [{ name: "Dt", text: executionDate }] }
      : { name: "ReqdExctnDt", text: executionDate };

  const document: El = {
    name: "Document",
    attrs: {
      xmlns: `urn:iso:std:iso:20022:tech:xsd:${version}`,
      "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
    },
    children: [
      {
        name: "CstmrCdtTrfInitn",
        children: [
          {
            name: "GrpHdr",
            children: [
              {
                name: "MsgId",
                text: requireFits(toSepaCharset(options.messageId, "messageId"), 35, "messageId"),
              },
              { name: "CreDtTm", text: created },
              { name: "NbOfTxs", text: String(count) },
              { name: "CtrlSum", text: controlSum },
              { name: "InitgPty", children: [{ name: "Nm", text: initiatingParty }] },
            ],
          },
          {
            name: "PmtInf",
            children: [
              {
                name: "PmtInfId",
                text: requireFits(
                  toSepaCharset(options.paymentInformationId, "paymentInformationId"),
                  35,
                  "paymentInformationId",
                ),
              },
              { name: "PmtMtd", text: "TRF" },
              { name: "BtchBookg", text: options.batchBooking === false ? "false" : "true" },
              { name: "NbOfTxs", text: String(count) },
              { name: "CtrlSum", text: controlSum },
              {
                name: "PmtTpInf",
                children: [{ name: "SvcLvl", children: [{ name: "Cd", text: "SEPA" }] }],
              },
              executionElement,
              { name: "Dbtr", children: [{ name: "Nm", text: debtorName }] },
              {
                name: "DbtrAcct",
                children: [{ name: "Id", children: [{ name: "IBAN", text: debtorIban }] }],
              },
              {
                name: "DbtrAgt",
                children: [
                  {
                    name: "FinInstnId",
                    children:
                      debtorBic === undefined
                        ? [{ name: "Othr", children: [{ name: "Id", text: "NOTPROVIDED" }] }]
                        : [{ name: agentTag, text: debtorBic }],
                  },
                ],
              },
              // SLEV — shared, as the SEPA scheme requires. It is not an
              // option here because any other value makes the message
              // non-SEPA, and a caller who wanted that wants a different tool.
              { name: "ChrgBr", text: "SLEV" },
              ...transactions,
            ],
          },
        ],
      },
    ],
  };

  return {
    text: serialize(document),
    version,
    transactionCount: count,
    controlSum,
    requestedExecutionDate: executionDate,
    truncations,
    transliterations,
  };
}

/**
 * Check a settlement date against a calendar.
 *
 * Returns the date to use and what happened. Refusing by default rather than
 * adjusting silently: a file held to the next open day settles when nobody
 * planned for it, and that is a worse surprise than a rejection.
 */
export function resolveSettlementDate(
  calendar: Calendar,
  isoDate: string,
  label: string,
  adjust: boolean,
): { date: string; movedFrom?: string; reason?: string } {
  const ms = parseIsoDate(isoDate, label);
  const reason = closureReason(calendar, ms);
  if (reason === null) return { date: formatIsoDate(ms) };
  if (!adjust) {
    const suggestion = formatIsoDate(nextOpenDay(calendar, ms));
    throw new PaymentFileError(
      `${label} ${formatIsoDate(ms)} is ${reason}, on which ${calendar === "target2" ? "TARGET2" : "the US Federal Reserve"} does not settle. The next settlement day is ${suggestion}; pass adjustSettlementDate to move it there. Refusing by default: a held file settles on a day nobody planned for, which is a worse surprise than a rejection.`,
    );
  }
  return {
    date: formatIsoDate(nextOpenDay(calendar, ms)),
    movedFrom: formatIsoDate(ms),
    reason,
  };
}
