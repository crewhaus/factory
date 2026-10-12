/**
 * `text` without its trailing dots: what `text.replace(/\.+$/, "")`
 * returned, in one pass from the end. That pattern tries every start inside
 * a run of dots that is not at the end and rescans the rest of the run from
 * each, so it was quadratic in the run's length, and a host or a recipient is
 * whatever the call wrote.
 */
export function withoutTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x2e) end--;
  return end === text.length ? text : text.slice(0, end);
}
