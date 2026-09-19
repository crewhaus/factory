# @crewhaus/tool-einvoice

The fixed-format files banks and tax authorities parse byte-exactly.

Two of these tools read and write EN 16931 e-invoices; the third assembles a
NACHA or SEPA payment batch. What they have in common is that the output is
read by a machine that will not tell you what was wrong with it. An ODFI
rejects a 94-byte record whose columns are one off with no line number and no
useful error. A tax authority rejects an invoice whose total disagrees with its
rows without saying which total.

| Tool | Answers |
|---|---|
| `EInvoiceBuild` | what does this invoice look like as UBL or CII, and which rules did we check |
| `EInvoiceParse` | what does this incoming invoice actually say, and where does it disagree with itself |
| `PaymentFileBuild` | what are the exact bytes of this ACH batch or this pain.001 |

## Nothing here sends anything

`PaymentFileBuild` builds a payment file and hands it back. There is no SFTP
client, no bank API, no submission endpoint, and no schema in this package
accepts a credential, a key or a token — a test walks every schema tree and
asserts it, the way `tool-onchain` asserts that nothing there accepts a private
key. `EInvoiceBuild` writes an invoice document; it does not file one.

What happens to the file afterwards is the operator's decision, made somewhere
this package cannot see.

## No total is an argument

Every sum, count, hash and control figure is computed from the rows. There is
nowhere to supply one, because a caller-supplied total that disagrees with the
rows is the defect all of this exists to prevent: the recipient's system reads
the total, the auditor reads the lines, and nobody notices for a year.

On an invoice that means BT-106 through BT-115 and the whole BG-23 VAT
breakdown. On a NACHA file it means the entry hash, the entry and addenda
counts, the debit and credit totals, the block count and the service class
code. On a pain.001 it means `NbOfTxs` and `CtrlSum`, at both levels.

Reading goes the other way: `EInvoiceParse` keeps what a document CLAIMS
separate from what its rows come to, and reports the difference rather than
adopting either.

## Money is never a JS number

Integer minor units end to end — cents, pence, yen — summed as `bigint`,
rounded half-up away from zero, and rendered to a decimal string only at the
moment an amount is written into a document. `0.1 + 0.2` in a ledger is a
defect that reconciles to a penny off a year later, and a NACHA file control
record carries a twelve-digit cent total that is inside `Number.MAX_SAFE_INTEGER`
by not very much.

A unit price with more precision than the currency has is expressed the way
EN 16931 expresses it: `unitPriceMinor` per a `baseQuantity`, so a price of
0.0125 is 125 minor units per 100 units. There are no fractional minor units
anywhere.

## The rule check is narrow, and says so

EN 16931 publishes its business rules as Schematron. There is no XSLT engine in
this repository, so this is not a Schematron run and does not become one by
being thorough.

What it is: a hand-written table of checks, each implemented COMPLETELY or not
at all. A check that corresponds to a published rule reports that rule's
identifier — BR-01 through BR-17, BR-21 through BR-27, the allowance and charge
rules BR-31 to BR-44, the VAT breakdown rules BR-45 to BR-48, BR-61 to BR-63,
and the calculation rules BR-CO-03, BR-CO-04, BR-CO-09, BR-CO-10 to BR-CO-18
and BR-CO-25. A check that covers the EFFECT of a rule family whose individual
identifiers are not transcribed here is prefixed `CH-` and says which family it
covers, because citing `BR-S-08` for something that is nearly BR-S-08 is how a
reader ends up trusting a coverage claim that is not true.

The result never says "valid". It says how many checks ran, how many of them
are named published rules, what failed, what did not apply, what could not be
evaluated, and that the rule set is larger than this.

Four outcomes, not three. A check that RAISED goes to `notEvaluated`, never to
`failures`: it found this table wanting, not the document, and writing it into
`failures` would report a violation of a published rule that nothing here
established either way. `notChecked` lists what is genuinely absent:

- XSD schema validation — structure, cardinality and datatypes are not checked.
- `BR-CL-*`, the code-list rules. ISO 4217, ISO 3166-1 and UN/ECE
  Recommendation 20 would each have to be vendored, and a code-list check
  against a list this package guessed at is worse than none. Two small closed
  lists — the VAT category codes and the invoice type codes — are checked, under
  `CH-` identifiers that say so.
- `BR-UBL-*` and `BR-CII-*`, the syntax-binding rules.
- Peppol BIS Billing 3.0 and XRechnung national rules. Selecting one of those
  as a preset sets the specification identifiers and nothing else; the build
  result says so in its own notes.

A partially transcribed rule set that reports "valid" is worse than no
validation at all, because somebody relies on it.

## An amount that could not be read is not an amount that agreed

`EInvoiceParse` puts the totals a document STATES beside the totals its rows
come to, and `reconciliation.agrees` is the one boolean a caller is likely to
branch on. It is true only when every stated total was READ and matched.

A monetary element that is present and is not a decimal — `1.100,00`, which is
what a European-locale exporter writes for 1,100.00 — is not absent and is
certainly not zero. It is listed in `reconciliation.couldNotCompare` beside the
figure the rows come to, it fails `CH-AMOUNT-UNREADABLE`, and it makes `agrees`
false. The alternative is a document stating ten times its rows reported as
agreement on the grounds that the unreadable figure had already been dropped
and there was nothing left to disagree with.

Decimal places are judged against the CURRENCY's own minor units, not against
two: `100.000` is exact in KWD and `100.50` is not a JPY amount at all.

## Which tax scheme BT-31 comes from

A party routinely declares more than one. XRechnung puts the German
Steuernummer under UBL tax scheme `FC` beside the VAT identifier under `VAT`,
and a ZUGFeRD seller declares CII registrations under `schemeID="FC"` and
`schemeID="VA"` — in whichever order the sender chose, with FC first in the
published samples. Both mappings search for the VAT one by name rather than
taking the first, because taking the first files a tax number as BT-31, which
then fails published rule BR-CO-09 for want of a country prefix: a violation
reported against a correct document. A party that declares exactly one scheme
and does not name it is read as the VAT one.

## Truncation policy, stated once

- **A name is truncated** to the field and the truncation is REPORTED. A name is
  for a human to read and the account identifier is what the money follows.
- **A reference or a remittance is refused**, never truncated. Those are matched
  by machine: a shortened end-to-end identifier matches nothing at either end
  and the payment arrives as a credit somebody has to chase.
- **An amount is refused**, always. A truncated amount is a different payment
  and the bank cannot tell it from the one you meant.

This applies to the file-level names too — a company name cut to the sixteen
columns NACHA gives it is what the receiver reads on their statement, so it is
reported like any other. A file-level IDENTIFIER that does not fit is refused
rather than cut, because a shortened company identifier is a different
originator.

Two more refusals in the same spirit: a duplicate payment identifier is caught
before anything is written, because a duplicate found afterwards is a duplicate
payment; and a name outside the SEPA character set is transliterated where
there is a defined transliteration (ü to u, ß to ss, `&` to `+`, each one
reported) and refused by name and code point where there is not.

The duplicate check runs on the identifier AS WRITTEN. The transliteration is
many-to-one — `&` becomes `+` — so `ACME&CO-1` and `ACME+CO-1` are two distinct
rows that would reach the bank as one reference, and comparing the supplied
identifiers cannot see it.

## No clock is read

Creation dates and timestamps are required inputs, not defaults. A payment file
whose bytes depend on when it was built cannot be diffed against the one you
sent, and the sha256 in the result would mean nothing. Building the same record
twice produces the same bytes, and a test pins that.

## Settlement days are checked, and moving one is opt-in

A requested execution date TARGET2 does not settle on, or an effective entry
date the US Federal Reserve does not settle on, is REFUSED — with the reason
and the next open day — unless `adjustSettlementDate` is passed, in which case
it is moved forward and both dates are reported. A held file settles on a day
nobody planned for, which is a worse surprise than a rejection.

The calendars are exactly two lists. TARGET2: weekends, 1 January, Good Friday,
Easter Monday, 1 May, 25 and 26 December — not the national bank holidays of
the SEPA countries. The Fed: weekends and the eleven federal holidays, with the
Fed's own observance rule (a Sunday holiday moves to the Monday; a Saturday one
does NOT close the Friday). Neither knows about your bank's cut-off times.

## What it does not do

- **It does not transmit anything.** No transport, no credentials, no endpoints.
- **It does not run an XSD or a Schematron.** Element order follows the
  published schema sequence as implemented here; a validator at the recipient
  is still the authority.
- **It does not read a Factur-X or ZUGFeRD PDF.** The XML is an embedded file in
  a `/Names /EmbeddedFiles` tree that can nest through `/Kids` and sit inside an
  object stream. Extract the attachment and pass the XML; `EInvoiceParse`
  refuses a PDF and says this.
- **It does not write a PDF/A-3.** Embedding the XML with the right
  `/AFRelationship` and a matching XMP extension schema, byte-identically across
  runs, is a job for a PDF writer, and a PDF that claims PDF/A-3 conformance
  without it is worse than no PDF.
- **It does not map FatturaPA.** That is a different semantic model, not a
  syntax of EN 16931, and mapping it badly would produce a record whose totals
  look right and whose tax does not.
- **It does not emit Bacs Standard 18 or a positive-pay file.** A guessed
  fixed-width layout is the exact failure this package exists to avoid.
- **It is not tax advice, and it does not decide whether an invoice is correct.**
  It computes, checks what it can check completely, and says what it did not
  check.

## Where the XML parser comes from

`@crewhaus/tool-data` owns the XML reader, and this package reads through it
rather than carrying a second one. Two XML readers in one repository disagree
about entity expansion and about which malformed documents are errors — on the
same file, in different tools, which is the worst way to disagree. The
serializer here is not a parser: it writes a fixed element order with fixed
indentation and no clock, which is what makes the output byte-stable.
