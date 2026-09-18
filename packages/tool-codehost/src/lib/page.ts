/**
 * Pagination, the two ways these hosts do it.
 *
 * GitHub sends an RFC 8288 `Link` header with a `rel="next"` URL. GitLab
 * sends `x-next-page` carrying the next page NUMBER (empty on the last
 * page), alongside `x-total-pages`. Both are parsed here, pure, so the tools
 * can loop under a page cap without either host's spelling leaking into them.
 */

const LINK_PART = /^\s*<([^>]*)>\s*(.*)$/;
const LINK_REL = /(?:^|;)\s*rel\s*=\s*"?([^";]+)"?/;

/** `rel` → URL, from an RFC 8288 `Link` header. Unparseable parts are skipped. */
export function parseLinkHeader(value: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || value === undefined || value.trim() === "") return out;
  for (const part of splitLinks(value)) {
    const match = part.match(LINK_PART);
    if (match === null) continue;
    const url = match[1] as string;
    const params = match[2] as string;
    const rel = params.match(LINK_REL);
    if (rel === null) continue;
    const name = (rel[1] as string).trim();
    if (name !== "" && out[name] === undefined) out[name] = url;
  }
  return out;
}

/**
 * Split on the commas that separate links, not the ones inside `<...>`. A
 * GitHub pagination URL carries `q=repo:a/b+is:open` and can carry a comma,
 * so a plain `split(",")` mangles it.
 */
function splitLinks(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** A page cursor: whatever the host needs in order to be asked for the next page. */
export type NextPage =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "page"; readonly page: number }
  | null;

/**
 * The next page, or `null` at the end of the list.
 *
 * `headers` is a lowercase-keyed map. A GitLab `x-next-page` that is empty or
 * not a number means there is no next page — the header is present on every
 * response, so its presence alone proves nothing.
 */
export function nextPageFrom(headers: Record<string, string>): NextPage {
  const link = parseLinkHeader(headers["link"]);
  const next = link["next"];
  if (next !== undefined && next !== "") return { kind: "url", url: next };

  const raw = headers["x-next-page"];
  if (raw !== undefined && raw.trim() !== "") {
    const page = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(page) && page > 0) return { kind: "page", page };
  }
  return null;
}

/**
 * The rate-limit facts both hosts publish in response headers.
 *
 * GitHub sends `x-ratelimit-*`; GitLab sends `ratelimit-*`. Everything here
 * is a number the host stated, so nothing reads the clock — `resetAt` is the
 * epoch second the host named, echoed rather than interpreted.
 */
export type RateHeaders = {
  readonly limit?: number;
  readonly remaining?: number;
  readonly used?: number;
  readonly resetAt?: number;
  readonly retryAfterSeconds?: number;
};

export function rateHeadersFrom(headers: Record<string, string>): RateHeaders {
  const num = (...names: string[]): number | undefined => {
    for (const name of names) {
      const raw = headers[name];
      if (raw === undefined) continue;
      const value = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  };
  return {
    ...pick("limit", num("x-ratelimit-limit", "ratelimit-limit")),
    ...pick("remaining", num("x-ratelimit-remaining", "ratelimit-remaining")),
    ...pick("used", num("x-ratelimit-used", "ratelimit-observed")),
    ...pick("resetAt", num("x-ratelimit-reset", "ratelimit-reset")),
    ...pick("retryAfterSeconds", num("retry-after")),
  };
}

function pick(key: string, value: number | undefined): Record<string, number> {
  return value === undefined ? {} : { [key]: value };
}
