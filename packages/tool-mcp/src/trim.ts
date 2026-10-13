/**
 * `text` without the `-` and `_` at either end: what
 * `text.replace(/^[-_]+|[-_]+$/g, "")` returned, in one pass from each end.
 * The pattern's second branch tries every start inside a run of them that is
 * not at the end and rescans the rest of the run from each, so it was
 * quadratic in the run's length, and a server name is the spec's.
 */
export function withoutEdgeDashes(text: string): string {
  const edge = (c: number): boolean => c === 0x2d || c === 0x5f;
  let start = 0;
  while (start < text.length && edge(text.charCodeAt(start))) start++;
  let end = text.length;
  while (end > start && edge(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}
