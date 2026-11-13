/**
 * How Home answers for one of its static assets: revalidated, never stale.
 *
 * Every asset except the shell carries a strong `ETag` (a SHA-256 of its
 * body, computed once per asset object) and `cache-control: no-cache`, so a
 * browser keeps its copy and asks each time whether it is still current: a
 * matching `If-None-Match` is answered 304 with no body and the same
 * headers. A new release changes the body, so it changes the tag, and the
 * browser fetches the new file — a console that loads its screens lazily
 * never mixes modules from two releases.
 *
 * The shell page keeps `cache-control: no-store` and no tag. It is the asset
 * served for `/`, and any other address that serves that same asset object,
 * or any HTML document, is treated the same way: the decision follows the
 * asset, not a list of paths.
 *
 * Every answer keeps the policy headers of `csp.ts`.
 */
import { createHash } from "node:crypto";
import { SHELL_HEADERS } from "./csp";
import type { StaticAsset } from "./server";

const tags = new WeakMap<StaticAsset, string>();
const shells = new WeakSet<StaticAsset>();

/** The strong tag for an asset's body, memoized per asset object. */
export function assetTag(asset: StaticAsset): string {
  const known = tags.get(asset);
  if (known !== undefined) return known;
  const tag = `"${createHash("sha256").update(asset.body).digest("base64url")}"`;
  tags.set(asset, tag);
  return tag;
}

/**
 * Whether an `If-None-Match` header names this tag. A list matches when any
 * member does, `*` matches anything, and a weak tag (`W/"…"`) is compared by
 * its value, as RFC 9110 has it for this header.
 */
export function noneMatchHits(header: string | null, tag: string): boolean {
  if (header === null) return false;
  const want = tag.replace(/^W\//, "");
  for (const raw of header.split(",")) {
    const candidate = raw.trim();
    if (candidate === "*") return true;
    if (candidate.replace(/^W\//, "") === want) return true;
  }
  return false;
}

function isShell(pathname: string, asset: StaticAsset): boolean {
  if (pathname === "/") shells.add(asset);
  return shells.has(asset) || asset.contentType.startsWith("text/html");
}

/** The response for a GET of a static asset. */
export function assetResponse(req: Request, pathname: string, asset: StaticAsset): Response {
  if (isShell(pathname, asset)) {
    return new Response(asset.body, {
      headers: { ...SHELL_HEADERS, "content-type": asset.contentType },
    });
  }
  const etag = assetTag(asset);
  const headers = {
    ...SHELL_HEADERS,
    "content-type": asset.contentType,
    "cache-control": "no-cache",
    etag,
  };
  if (noneMatchHits(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(asset.body, { headers });
}
