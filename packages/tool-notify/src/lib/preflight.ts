/**
 * The questions worth asking about a message BEFORE a socket opens.
 *
 * `EmailSend` refuses a message it cannot build, and refuses it one reason
 * at a time, at the moment the caller has already decided to send. That is
 * the right behaviour for a send and the wrong one for a check: what a
 * caller wants before committing is every reason at once, including the ones
 * that are not refusals at all - an empty body, a subject still carrying
 * `{{release}}`, the same mailbox on both To and Bcc.
 *
 * So the rules live here, pure, and the tool composes them. Two properties
 * keep the result honest:
 *
 *   - **The composer stays the authority.** Everything here is a report;
 *     the real `composeMessage` runs afterwards and its verdict is the one
 *     that decides whether the message can be built at all. Where a rule
 *     below and the composer ask the same question - a header name, a
 *     message id - they call the SAME predicate out of `./mime`, because a
 *     preflight that passes against its own copy of a rule and a send that
 *     then refuses is a preflight nobody can act on.
 *   - **A check that could not run says so.** `unknown` is a status, not an
 *     absent `fail`. An attachment that could not be read and an attachment
 *     that is fine are different answers, and only one of them means the
 *     message is ready.
 */
import { isMessageId, isReservedHeaderName, isValidAddress, isValidHeaderName } from "./mime";
import type { Mailbox } from "./mime";
import { templatePlaceholders } from "./template";

/**
 * `pass` - asked and answered well. `warn` - answered, and the answer is
 * worth reading before sending anyway. `fail` - this message does not go
 * out, or goes out wrong. `unknown` - the question could not be answered,
 * and the reason is in `detail`.
 */
export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

export type Check = {
  readonly check: string;
  readonly status: CheckStatus;
  readonly detail: string;
};

export type Draft = {
  readonly from: Mailbox;
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly bcc: readonly Mailbox[];
  readonly replyTo: readonly Mailbox[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
  readonly date: string;
  readonly inReplyTo?: string | undefined;
  readonly references?: readonly string[] | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
};

/** Locale-free order, so two runs list the same faults in the same place. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A value a header or a body can hold and still be empty. */
const isBlank = (text: string): boolean => text.trim() === "";

/**
 * The comparison key for "is this the same mailbox twice".
 *
 * Case only, deliberately. Gmail folds `a.b@` and `ab@` to one mailbox and
 * strips `+tags`; most providers do neither, so folding them here would
 * report two genuinely separate recipients as one duplicate on every domain
 * that keeps them apart. Which domains fold is configuration this package
 * does not carry, so the narrow, always-true rule is the one implemented -
 * and it never rewrites an address, only the key two addresses are compared
 * on.
 */
const mailboxKey = (address: string): string => address.trim().toLowerCase();

export type EnvelopeFolding = {
  /**
   * Mailboxes listed more than once with the SAME spelling. `composeMessage`
   * builds its envelope as a Set of exact addresses, so these really do
   * collapse to one `RCPT TO`.
   */
  readonly folded: readonly string[];
  /**
   * Groups of spellings that name one mailbox by this file's key but are
   * different strings. The composer's Set keeps every one of them, so each
   * becomes its own `RCPT TO`.
   */
  readonly variants: readonly (readonly string[])[];
  /**
   * How many `RCPT TO` the composer will actually issue - the size of a Set
   * of the EXACT addresses, which is the line `composeMessage` runs.
   */
  readonly envelopeSize: number;
};

/**
 * How the envelope folds, counted the way the composer counts it.
 *
 * The trap this exists to avoid: comparing on a case-folded key and then
 * reporting a conclusion about a composer that de-duplicates on the exact
 * string. `ops@example.com` on To and `OPS@example.com` on Bcc is ONE
 * mailbox by the key above and TWO entries in `composeMessage`'s envelope
 * Set, so "it will be sent one copy, not two" is false for exactly that
 * case - which is the case a caller runs a preflight to find. Both facts are
 * returned so the caller is told which one applies, and the count reported
 * is the composer's, never the key's.
 */
export function envelopeFolding(lists: ReadonlyArray<readonly Mailbox[]>): EnvelopeFolding {
  const groups = new Map<string, string[]>();
  for (const list of lists) {
    for (const mailbox of list) {
      const key = mailboxKey(mailbox.address);
      const spellings = groups.get(key);
      if (spellings === undefined) groups.set(key, [mailbox.address]);
      else spellings.push(mailbox.address);
    }
  }
  const folded: string[] = [];
  const variants: string[][] = [];
  let envelopeSize = 0;
  for (const [key, spellings] of groups) {
    const distinct = [...new Set(spellings)].sort(byString);
    envelopeSize += distinct.length;
    if (spellings.length > distinct.length) folded.push(key);
    if (distinct.length > 1) variants.push(distinct);
  }
  return {
    folded: folded.sort(byString),
    // Sorted by first spelling, so two runs list the groups in one order.
    variants: variants.sort((a, b) => byString(a[0] as string, b[0] as string)),
    envelopeSize,
  };
}

/** `{{placeholder}}` names still standing in the text a recipient would read. */
export function leftoverPlaceholders(draft: Draft): string[] {
  const names = new Set<string>();
  for (const field of [draft.subject, draft.text, draft.html ?? ""]) {
    for (const name of templatePlaceholders(field)) names.add(name);
  }
  return [...names].sort(byString);
}

function checkSender(draft: Draft): Check {
  if (!isValidAddress(draft.from.address)) {
    return {
      check: "sender",
      status: "fail",
      // The address is echoed with its line breaks escaped: an unparseable
      // From is usually unparseable for a reason worth seeing.
      detail: `From "${draft.from.address.replace(/[\r\n]/g, "\\n")}" is not a deliverable addr-spec, so there is no sender and no domain to build a Message-ID from`,
    };
  }
  return {
    check: "sender",
    status: "pass",
    detail: `From is ${draft.from.address}`,
  };
}

function checkEnvelope(draft: Draft): Check {
  const all = [...draft.to, ...draft.cc, ...draft.bcc];
  if (all.length === 0) {
    return {
      check: "envelope",
      status: "fail",
      detail: "no recipients: to, cc and bcc are all empty, so there is no envelope to send",
    };
  }
  const bad = all
    .map((m) => m.address)
    .filter((address) => !isValidAddress(address))
    .map((address) => address.replace(/[\r\n]/g, "\\n"))
    .sort(byString);
  if (bad.length > 0) {
    return {
      check: "envelope",
      status: "fail",
      detail: `${bad.length} recipient address${bad.length === 1 ? " is" : "es are"} not deliverable: ${bad.join(", ")}`,
    };
  }
  const replyToBad = draft.replyTo
    .map((m) => m.address)
    .filter((address) => !isValidAddress(address))
    .map((address) => address.replace(/[\r\n]/g, "\\n"))
    .sort(byString);
  if (replyToBad.length > 0) {
    return {
      check: "envelope",
      status: "fail",
      detail: `reply-to is not deliverable: ${replyToBad.join(", ")}`,
    };
  }
  const folding = envelopeFolding([draft.to, draft.cc, draft.bcc]);
  const size = folding.envelopeSize;
  const rcpt = `${size} envelope recipient${size === 1 ? "" : "s"}`;
  // Said in the order of how wrong it can go. A spelling variant is the one
  // that costs a real second delivery, so it is reported even when an exact
  // repeat is also present - the caller fixes a different thing for each.
  if (folding.variants.length > 0) {
    const groups = folding.variants.map((group) => group.join(" and ")).join("; ");
    return {
      check: "envelope",
      status: "warn",
      detail: `${rcpt}: ${groups} differ only in case or surrounding space. EmailSend builds its envelope from the exact addresses, so each spelling gets its own RCPT TO and the mailbox is likely to receive one copy per spelling - list it once`,
    };
  }
  if (folding.folded.length > 0) {
    return {
      check: "envelope",
      status: "warn",
      detail: `${rcpt}: ${folding.folded.join(", ")} ${folding.folded.length === 1 ? "is" : "are"} listed more than once across to/cc/bcc; identical spellings fold into one envelope entry, so one copy is sent, not two`,
    };
  }
  return {
    check: "envelope",
    status: "pass",
    detail: `${rcpt} across to, cc and bcc`,
  };
}

function checkDate(draft: Draft): Check {
  const when = new Date(draft.date);
  if (Number.isNaN(when.getTime())) {
    return {
      check: "date",
      status: "fail",
      detail: `"${draft.date}" is not an instant - use ISO-8601 with an offset, e.g. 2026-09-17T09:30:00Z`,
    };
  }
  return {
    check: "date",
    status: "pass",
    detail: `the Date header will read ${when.toISOString()}`,
  };
}

function checkHeaders(draft: Draft): Check {
  const faults: string[] = [];
  for (const name of Object.keys(draft.headers ?? {})) {
    if (!isValidHeaderName(name)) faults.push(`"${name}" is not a valid header name`);
    else if (isReservedHeaderName(name)) {
      faults.push(`"${name}" is built by the composer and cannot be overridden here`);
    }
  }
  if (draft.inReplyTo !== undefined && draft.inReplyTo !== "" && !isMessageId(draft.inReplyTo)) {
    faults.push("inReplyTo is not one message id in angle brackets");
  }
  for (const reference of draft.references ?? []) {
    if (!isMessageId(reference)) {
      faults.push(
        `references entry "${reference.replace(/[\r\n]/g, "\\n")}" is not a message id in angle brackets`,
      );
    }
  }
  if (faults.length > 0) {
    // Every fault at once, sorted: the composer stops at the first, and
    // finding them one send at a time is the experience this tool exists to
    // replace.
    return { check: "headers", status: "fail", detail: faults.sort(byString).join("; ") };
  }
  const extra = Object.keys(draft.headers ?? {}).length;
  return {
    check: "headers",
    status: "pass",
    detail: extra === 0 ? "no extra headers" : `${extra} extra header${extra === 1 ? "" : "s"}`,
  };
}

function checkSubject(draft: Draft): Check {
  if (isBlank(draft.subject)) {
    return {
      check: "subject",
      status: "warn",
      detail:
        "the Subject header is empty; it is legal, and it is also one of the things a spam filter scores",
    };
  }
  return { check: "subject", status: "pass", detail: `${draft.subject.length} characters` };
}

function checkBody(draft: Draft): Check {
  const textBlank = isBlank(draft.text);
  const htmlBlank = draft.html === undefined || isBlank(draft.html);
  if (textBlank && htmlBlank) {
    return {
      check: "body",
      status: "fail",
      detail:
        "the message has no body: text is empty and there is no html alternative. A send would succeed and deliver nothing",
    };
  }
  if (textBlank) {
    return {
      check: "body",
      status: "warn",
      detail:
        "text is empty and only the html part carries anything; a client that shows text/plain shows an empty message",
    };
  }
  return {
    check: "body",
    status: "pass",
    detail: htmlBlank
      ? `${draft.text.length} characters of text`
      : `${draft.text.length} characters of text and ${(draft.html as string).length} of html`,
  };
}

function checkPlaceholders(draft: Draft): Check {
  const left = leftoverPlaceholders(draft);
  if (left.length > 0) {
    return {
      check: "placeholders",
      status: "warn",
      // MessageTemplate treats a missing key as an error for this reason;
      // a message that reads "deploy of  failed" still gets acted on.
      detail: `still unfilled: ${left.map((n) => `{{${n}}}`).join(", ")} - if these came from a template, the render did not happen`,
    };
  }
  return { check: "placeholders", status: "pass", detail: "no unfilled {{placeholders}}" };
}

/** Every rule that needs nothing but the draft itself, in a fixed order. */
export function draftChecks(draft: Draft): Check[] {
  return [
    checkSender(draft),
    checkEnvelope(draft),
    checkDate(draft),
    checkSubject(draft),
    checkBody(draft),
    checkHeaders(draft),
    checkPlaceholders(draft),
  ];
}

/**
 * The one-word answer, from the rows.
 *
 * `incomplete` exists so a check that could not run cannot be mistaken for
 * one that passed: a message whose attachment could not be read is not ready
 * to send, and it is not blocked either - somebody has to look.
 */
export function verdictFrom(checks: readonly Check[]): "blocked" | "incomplete" | "ready" {
  if (checks.some((c) => c.status === "fail")) return "blocked";
  if (checks.some((c) => c.status === "unknown")) return "incomplete";
  return "ready";
}
