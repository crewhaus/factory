/** A code unit `\s` matches: WhiteSpace or LineTerminator. */
function isRegExpSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/**
 * The body of the first fenced block in a reply: what
 * `/```(?:json)?\s*([\s\S]*?)\s*```/.exec(text)?.[1]` captured, found with
 * two searches. The body starts after the first fence, its `json` tag and
 * the whitespace after them, and ends at the next fence, less the
 * whitespace before it; with no fence after it there is none, and no later
 * fence has one either. The pattern tried every end of a lazy body and
 * rescanned the whitespace after each, from every start in a reply that
 * opened a fence and never closed it: cubic in a run of whitespace, in a
 * reply from a model that read an untrusted page.
 */
export function fencedBody(text: string): string | undefined {
  const open = text.indexOf("```");
  if (open === -1) return undefined;
  let from = open + 3;
  if (text.startsWith("json", from)) from += 4;
  while (from < text.length && isRegExpSpace(text.charCodeAt(from))) from++;
  const close = text.indexOf("```", from);
  if (close === -1) return undefined;
  let end = close;
  while (end > from && isRegExpSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(from, end);
}
