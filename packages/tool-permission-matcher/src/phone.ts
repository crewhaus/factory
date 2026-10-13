/**
 * A phone number as SmsSend reads it: the separators people write (spaces,
 * `-`, `.`, `(` and `)`) taken out wherever they are, before the `+` too, so
 * `+1 (555) 000-1111`, `(+1)5550001111` and `-+15550001111` are all
 * `+15550001111`.
 *
 * This is the one implementation. SmsSend checks its allow-list with it and
 * sends what it returns, and a deny or ask rule reads a recipient with it, so
 * a rule decides on the number the message goes to rather than on how the
 * call spelled it.
 */
export function normalizePhoneNumber(raw: string): string {
  let out = "";
  for (const ch of raw.trim()) {
    if (ch === " " || ch === "-" || ch === "." || ch === "(" || ch === ")") continue;
    out += ch;
  }
  return out;
}

/** An E.164 number: `+`, a non-zero digit, and at most fifteen digits in all. */
const E164 = /^\+[1-9]\d{0,14}$/;

/** Is `number`, already normalised, in E.164 form? The only form SmsSend sends to. */
export function isE164Number(number: string): boolean {
  return E164.test(number);
}
