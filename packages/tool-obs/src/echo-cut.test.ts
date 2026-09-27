/**
 * A read the byte cap cut ends where an echoed token began (net attacker
 * review; tool-http's C050 fix, carried over). The body is scrubbed as it
 * is read, and the redactor matches whole spellings: a cut through the
 * token left a prefix it did not match.
 */
import { describe, expect, test } from "bun:test";
import { readCapped, redactorFor } from "./net";

const TOKEN = "obs-api-token-value-7c1e55";
const BEARER = "Bearer ";

describe("an echoed token cut by the cap", () => {
  test("readCapped trims the start of the token the cut left", async () => {
    let checked = 0;
    for (const keep of [1, 5, 12, TOKEN.length - 1]) {
      const head = `${"p".repeat(1_000)}${BEARER}`;
      const res = new Response(`${head}${TOKEN}${" ".repeat(100)}`);
      const capped = await readCapped(res, head.length + keep, undefined, [TOKEN]);
      expect({ keep, text: capped.text, truncated: capped.truncated }).toEqual({
        keep,
        text: head,
        truncated: true,
      });
      checked++;
    }
    expect(checked).toBe(4);
  });

  test("the redactor catches the JSON-escaped spelling and a cut at a string's end", () => {
    const redact = redactorFor('tok/with"quote-123');
    expect(redact('{"t":"tok\\/with\\"quote-123"}')).toBe('{"t":"<redacted>"}');
    expect(redact(`seen ${TOKEN.slice(0, 10)}`)).toBe(`seen ${TOKEN.slice(0, 10)}`);
    expect(redactorFor(TOKEN)(`seen ${TOKEN.slice(0, 10)}`)).toBe("seen <redacted>");
  });
});
