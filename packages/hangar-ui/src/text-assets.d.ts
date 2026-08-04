/**
 * Ambient declarations for `with { type: "text" }` imports of the static UI
 * assets (see `./index.ts`). Bun resolves these to the file's text at load
 * (interpreter path) or embeds the text into a standalone binary under
 * `bun build --compile`; `tsc` only needs to know each import's type. The
 * `.js` assets are hand-written BROWSER modules — they are never part of this
 * package's TypeScript program (only `src/**` is), so the wildcard cannot
 * shadow an in-package TS import.
 */
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.js" {
  const content: string;
  export default content;
}
