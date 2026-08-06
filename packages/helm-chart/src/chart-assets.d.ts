/**
 * Ambient declarations for `with { type: "text" }` imports of the chart's
 * `helm/crewhaus/templates/*` assets (see `./embedded.ts`). Bun resolves these
 * to the file's text at load (interpreter path) or embeds it into the
 * standalone binary (`bun build --compile`); `tsc` only needs to know the
 * import's type.
 *
 * `.yaml` is declared narrowly rather than as a bare `*` glob so an accidental
 * text import of some other asset type still fails to typecheck.
 */
declare module "*.tpl" {
  const content: string;
  export default content;
}

declare module "*.yaml" {
  const content: string;
  export default content;
}
