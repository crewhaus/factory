/**
 * `text` without its trailing newlines: what `text.replace(/\n+$/, "")`
 * returned, in one pass from the end. That pattern tries every start inside
 * a run of newlines that is not at the end and rescans the rest of the run
 * from each, so it was quadratic in the run's length, and a command prints
 * whatever the workspace or the model makes it print.
 */
export function withoutTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) end--;
  return end === text.length ? text : text.slice(0, end);
}
