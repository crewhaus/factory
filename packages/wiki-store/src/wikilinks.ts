/**
 * The text inside each `[[…]]` of `body`, in order: what
 * `/\[\[([^\]]+)\]\]/g` captured, found with `indexOf`.
 *
 * The pattern rescanned the rest of the body from every `[[` that had no
 * closing `]]` after it, so its cost was quadratic in a run of `[`: 40 000 of
 * them took most of a second, and an article may hold 16 MiB. An article body
 * is model-written, and the index rebuild reads every article's links.
 *
 * Each `[[` reads up to the first `]` after it, and a link is there only when
 * the text between is not empty and a second `]` follows at once. When it is
 * not, every `[[` before that `]` meets the same `]` and fails the same way,
 * so the search resumes after it: each character is read a bounded number of
 * times.
 */
export function wikilinkInners(body: string): string[] {
  const inners: string[] = [];
  let from = 0;
  for (;;) {
    const open = body.indexOf("[[", from);
    if (open === -1) return inners;
    const close = body.indexOf("]", open + 2);
    if (close === -1) return inners;
    if (close > open + 2 && body.charCodeAt(close + 1) === 0x5d /* ] */) {
      inners.push(body.slice(open + 2, close));
      from = close + 2;
    } else {
      from = close + 1;
    }
  }
}
