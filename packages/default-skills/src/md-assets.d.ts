/**
 * Ambient declaration for `with { type: "text" }` imports of the canonical
 * `.md` skill/command assets (see `./embedded.ts`). Bun resolves these to the
 * file's text at load (interpreter path) or embeds it into the standalone
 * binary (`bun build --compile`); `tsc` only needs to know the import's type.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
