/**
 * Percent-encoding, SigV4's way — which is not `encodeURIComponent`'s way.
 *
 * This is the module that decides whether a signature verifies, and it is the
 * one place in the package where being nearly right is worse than being
 * obviously wrong: a mis-encoded byte produces a well-formed URL that 403s
 * with `SignatureDoesNotMatch` and no indication of which character
 * disagreed, at whatever hour the URL is eventually used.
 *
 * `encodeURIComponent` is the trap. It leaves `!`, `'`, `(`, `)` and `*`
 * unencoded; AWS's canonical form encodes all five. So a key like
 * `q&a (2026)/notes!.txt` signs one way and is requested another. It also
 * lowercases nothing and uppercases nothing — it happens to emit uppercase
 * hex, which is right — but the unreserved set is the part that differs, and
 * that difference is silent.
 *
 * The rule, from RFC 3986 §2.3 as SigV4 cites it: `A-Z a-z 0-9 - _ . ~` pass
 * through unchanged; every other byte of the UTF-8 encoding becomes `%XX`
 * with UPPERCASE hex digits. No exceptions, no locale, no normalization.
 */

const UTF8 = new TextEncoder();

/**
 * The unreserved set as a byte table. A table rather than a regex because the
 * question is asked per BYTE of the UTF-8 encoding, not per character — `é`
 * is two bytes and neither of them is unreserved, and a regex over characters
 * invites exactly the reasoning error that lets a non-ASCII key through
 * half-encoded.
 */
const UNRESERVED: ReadonlyArray<boolean> = (() => {
  const table = new Array<boolean>(128).fill(false);
  const mark = (from: string, to: string) => {
    for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) table[c] = true;
  };
  mark("A", "Z");
  mark("a", "z");
  mark("0", "9");
  for (const ch of "-_.~") table[ch.charCodeAt(0)] = true;
  return table;
})();

const HEX = "0123456789ABCDEF";

/**
 * Percent-encode one component the way SigV4 requires.
 *
 * Every byte outside the unreserved set is encoded, `/` included — this is
 * the function for query names, query values and single path SEGMENTS. Use
 * {@link encodePath} for a whole object key, which keeps `/` as a separator.
 */
export function encodeRfc3986(value: string): string {
  let out = "";
  for (const byte of UTF8.encode(value)) {
    if (byte < 0x80 && UNRESERVED[byte] === true) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${HEX[byte >> 4]}${HEX[byte & 0x0f]}`;
    }
  }
  return out;
}

/**
 * Percent-encode an object key as a canonical URI path: each segment encoded,
 * the `/` separators left alone.
 *
 * S3 encodes the path ONCE. Every other AWS service encodes the canonical URI
 * twice (the literal `%` of an already-encoded byte is itself encoded), which
 * is why `doubleEncode` exists here rather than being assumed away: this
 * module is the shared SigV4 primitive for the monorepo, and the next caller
 * will not be S3. Getting it backwards for S3 turns `a b.txt` into
 * `a%2520b.txt` — a signature over a path nobody will ever request.
 */
export function encodePath(path: string, options?: { doubleEncode?: boolean }): string {
  const once = path.split("/").map(encodeRfc3986).join("/");
  return options?.doubleEncode === true ? once.split("/").map(encodeRfc3986).join("/") : once;
}

/** One query parameter, before encoding: `[name, value]`. */
export type QueryParam = readonly [string, string];

/**
 * Build the canonical query string: encode first, then sort by byte order.
 *
 * The order matters and the order of the two OPERATIONS matters more. Sorting
 * raw names and then encoding them gives a different sequence than encoding
 * and then sorting, because encoding moves characters around the ASCII table
 * (`~` is 0x7E raw, `%7E`-shaped forms sort near `%`). AWS specifies
 * encode-then-sort, so that is what happens here.
 *
 * After encoding every byte is ASCII, so JavaScript's `<` on the encoded
 * strings IS a byte comparison; that equivalence is why this can use plain
 * string comparison rather than comparing `Uint8Array`s.
 *
 * Duplicate names are ordered by their encoded value, as the spec says.
 */
export function canonicalQuery(params: ReadonlyArray<QueryParam>): string {
  const encoded = params.map(
    ([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const,
  );
  encoded.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  return encoded.map(([name, value]) => `${name}=${value}`).join("&");
}

/** UTF-8 byte length — S3's key limit is 1024 BYTES, not 1024 characters. */
export function utf8Length(value: string): number {
  return UTF8.encode(value).length;
}
