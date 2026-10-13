/**
 * The text inside the first ``` fence, after an optional `json` tag and
 * trimmed, or undefined when that fence is never closed: what
 * `/```(?:json)?\s*([\s\S]*?)\s*```/` captured, found with `indexOf`.
 *
 * The pattern was cubic in a run of whitespace after an unclosed fence: its
 * leading `\s*` gave the run back one character at a time, the lazy capture
 * then grew across the rest of it, and the trailing `\s*` rescanned what was
 * left from every one of those positions ("```" and 2 400 spaces: three
 * seconds). The reply is model output. The capture always ended at the first
 * ``` after the opening one, with the whitespace on either side of it in the
 * two `\s*`, so `trim()` of the text between the fences is the same string.
 */
export function fencedJson(text: string): string | undefined {
  const open = text.indexOf("```");
  if (open === -1) return undefined;
  const from = text.startsWith("json", open + 3) ? open + 7 : open + 3;
  const close = text.indexOf("```", from);
  if (close === -1) return undefined;
  return text.slice(from, close).trim();
}
