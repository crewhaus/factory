/**
 * One embeddable asset and how its content type is chosen. Every embed
 * module builds its rows with {@link asset}; `../index.ts` re-exports the
 * type and the table, so no embed module imports `../index.ts` back.
 */

/** One embeddable asset: the file's text plus its HTTP content type. */
export type HangarAsset = {
  readonly body: string;
  readonly contentType: string;
};

/** Extension → content type for everything the asset tree may contain. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/** Content type for a serve path by extension (octet-stream fallback). */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** An asset row: the text and the content type its file name implies. */
export function asset(body: string, path: string): HangarAsset {
  return { body, contentType: contentTypeFor(path) };
}
