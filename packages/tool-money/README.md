# @crewhaus/tool-money

Money arithmetic and the controls around it.

Everything here has a right answer that a model can get wrong in a way nobody
notices until an audit: a cent lost allocating a discount, tax charged on the
wrong base, a date read month-first, a refund that returns list price for a
discounted item.

| Tool | Answers |
|---|---|
| `PaymentIdentifierValidate` | is this IBAN, BIC, routing number, card or sort code well-formed |
| `TaxCalculate` | what tax is due, per line and per invoice |
| `RefundAmountCompute` | what to refund for a partial return |
| `PurchaseOrderMatch` | does this invoice agree with the order and the receipt |
| `CostBasisCompute` | what gain did this disposal realize, and from which lots |
| `SpendLimitCheck` | may this payment go out |
| `RefundAbuseCheck` | what do this customer's refund patterns look like |
| `WebhookSignatureVerify` | did this event really come from the provider |
| `StatementParse` | what transactions does this export actually contain |
| `GlCodeSuggest` | which lines code themselves, and which need a person |

## Money is integer minor units

Cents, pence, yen. Floating point produces totals that do not add up, and
"off by a cent" on an invoice is not a rounding detail — it is a document
that fails reconciliation. Every amount in and out of these tools is an
integer, and the schemas reject anything else.

Splitting is largest-remainder, so the parts always sum to the whole. 100
cents three ways is 34, 33, 33 — never 33, 33, 33 with a cent unaccounted
for. A full return refunds exactly what was charged, and a lot's partial
disposals always sum to exactly what the lot cost.

## What has no safe default is asked, not assumed

Three choices change the answer and nothing in the data settles them, so the
tools require them rather than picking:

- **Tax-inclusive or exclusive pricing**, and whether rounding happens per
  line or once per invoice. Jurisdictions differ and the totals differ.
- **Date order.** `03/04/2026` is 3 April in most of the world and 4 March in
  the United States. `StatementParse` REFUSES a file whose dates could be
  read either way unless the caller states the order — a wrong guess moves
  transactions between months, and the reconciliation then balances to
  exactly twice the error.
- **Sign convention.** Some exports use a signed amount, some a debit column
  and a credit column. The sign a debit column implies is applied rather than
  read.

Timestamps must carry a UTC offset. An offset-less one is refused, because
per ECMAScript it means local time — which would put a holding period on the
wrong side of a year boundary depending on the machine.

## Controls, not suggestions

`SpendLimitCheck` is the gate an unattended harness consults before moving
money. A limit a model is asked to respect is a suggestion; a limit computed
from the record of what has already been spent is a limit. It reports every
limit a payment breaks rather than the first, and the headroom that would
pass.

When `knownCounterparties` is declared, that list **is** the allow-list, and
payment history does not extend it. Treating anyone previously paid as known
looks like a convenience and is a hole: one payment that got through by any
means would allowlist its counterparty permanently, so the control would stop
exactly one payment and approve every one after it. With no list declared
there is nothing else to go on, so history is used — a weaker rule, and one
the refusal names.

`WebhookSignatureVerify` exists because anyone who can reach an endpoint can
post "payment succeeded", and a harness that believes it ships goods for
free. The comparison is constant-time, the timestamp is checked against a
replay tolerance, and the body must be the raw bytes — re-serializing parsed
JSON changes what the signature covers. The signing secret is taken as the
NAME of an environment variable, never inline: a key in a spec ends up in a
transcript and in a model's context.

`RefundAbuseCheck` reports signals and never a verdict. A high refund ratio
is also what a customer with one genuinely broken delivery looks like, and a
ratio against zero spend is reported as absent rather than as a large number.

## What it does not do

- **It does not move money.** No payment provider, no transfers, no refunds
  issued, no orders cancelled. These tools compute and check; something else
  acts, and a person authorizes it.
- **It does not reach a network.** A valid IBAN checksum means well-formed,
  not that the account exists — and the result says so rather than letting
  `valid: true` be read as "verified".
- **It does not decide that somebody is committing fraud.**
- **It does not file anything.** No tax returns, no e-invoicing submission,
  no regulatory reporting. `TaxCalculate` computes from rate tables the
  operator supplies; keeping those correct is their job.
- **It reads CSV and OFX**, not CAMT.053, MT940 or QIF.
- **It is not accounting advice.** The methods are implemented as specified;
  which one applies to you is a question for somebody qualified.
